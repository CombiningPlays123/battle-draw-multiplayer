/* room-manager.js - talks to Supabase (auth + RPC + optional Realtime) and keeps the room state fresh.
   The server is the source of truth for everything (phase, timer, votes, inventory, winner). */

class ApiError extends Error {
  constructor(code, message, arg) { super(message || code); this.code = code; this.arg = arg; }
}
M.ApiError = ApiError;

class Api {
  constructor(cfg) {
    this.cfg = cfg;
    this.key = 'bdmp.session.' + cfg.profile;
    this.sess = M.store.get(this.key, null);
  }
  get configured() { return !!this.cfg.url && !!this.cfg.key && !/__SUPABASE/.test(this.cfg.url + this.cfg.key); }
  _headers(token) { const h = { apikey: this.cfg.key, 'Content-Type': 'application/json' }; if (token) h.Authorization = 'Bearer ' + token; return h; }
  async _post(path, body, token) {
    let res;
    try { res = await fetch(this.cfg.url.replace(/\/$/, '') + path, { method: 'POST', headers: this._headers(token), body: JSON.stringify(body || {}) }); }
    catch (e) { throw new ApiError('network', M.ERRORS.network); }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { res, data };
  }
  _save(d) {
    this.sess = { access_token: d.access_token, refresh_token: d.refresh_token, uid: d.user && d.user.id,
                  expires_at: Date.now() + (d.expires_in || 3600) * 1000 };
    M.store.set(this.key, this.sess);
  }
  async token(force) {
    if (!this.configured) throw new ApiError('not_configured', M.ERRORS.not_configured);
    if (this.sess && !force && this.sess.expires_at - Date.now() > 60000) return this.sess.access_token;
    if (this.sess && this.sess.refresh_token) {
      const { res, data } = await this._post('/auth/v1/token?grant_type=refresh_token', { refresh_token: this.sess.refresh_token });
      if (res.ok && data && data.access_token) { this._save(data); return this.sess.access_token; }
      this.sess = null; M.store.del(this.key);   // refresh token dead -> new anonymous identity
    }
    const { res, data } = await this._post('/auth/v1/signup', { data: {} });
    if (!res.ok || !data || !data.access_token) {
      const msg = JSON.stringify(data || {});
      throw new ApiError(/anonymous/i.test(msg) ? 'anon_disabled' : 'auth', (data && (data.msg || data.message)) || 'Sign-in failed');
    }
    this._save(data);
    return this.sess.access_token;
  }
  get uid() { return this.sess && this.sess.uid; }

  async rpc(fn, args, _retried) {
    const token = await this.token();
    const { res, data } = await this._post('/rest/v1/rpc/' + fn, args || {}, token);
    if (res.ok) return data;
    if ((res.status === 401 || (data && /JWT/i.test(data.message || ''))) && !_retried) { await this.token(true); return this.rpc(fn, args, true); }
    const msg = (data && data.message) || 'Request failed (' + res.status + ')';
    const [code, arg] = String(msg).split(':');
    throw new ApiError(/^[a-z_]+$/.test(code) ? code : 'server', /^[a-z_]+$/.test(code) ? M.ERRORS[code] || msg : msg, arg);
  }
}
M.Api = Api;

/** Minimal Supabase Realtime (Phoenix channel) client. Purely an accelerator: it just tells us "the
    room changed, re-fetch now". If it fails, polling keeps everything correct. */
class Realtime {
  constructor(api, onPulse, onStatus) { this.api = api; this.onPulse = onPulse; this.onStatus = onStatus; this.ws = null; this.ok = false; this.stopped = true; this.tries = 0; }
  async start(roomId) {
    this.stop(); this.stopped = false; this.roomId = roomId;
    let token; try { token = await this.api.token(); } catch { return; }
    if (this.stopped) return;
    const base = this.api.cfg.url.replace(/^http/, 'ws').replace(/\/$/, '');
    let ws;
    try { ws = new WebSocket(`${base}/realtime/v1/websocket?apikey=${encodeURIComponent(this.api.cfg.key)}&vsn=1.0.0`); } catch { return; }
    this.ws = ws; let ref = 0;
    const send = (topic, event, payload) => { try { ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref), join_ref: '1' })); } catch { /* closed */ } };
    const topic = 'realtime:bdmp-' + roomId;
    ws.onopen = () => {
      send(topic, 'phx_join', { config: { broadcast: { ack: false, self: false }, presence: { key: '' }, private: false,
        postgres_changes: [{ event: '*', schema: 'public', table: 'room_pulse', filter: 'room_id=eq.' + roomId }] }, access_token: token });
      this.hb = setInterval(() => send('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.event === 'phx_reply' && m.topic === topic) {
        this.ok = m.payload && m.payload.status === 'ok'; this.tries = 0; this.onStatus(this.ok);
      } else if (m.event === 'postgres_changes') this.onPulse();
      else if (m.event === 'phx_error' || m.event === 'phx_close') { this.ok = false; this.onStatus(false); }
    };
    const down = () => {
      clearInterval(this.hb); this.ok = false; this.onStatus(false);
      if (!this.stopped) { this.tries++; setTimeout(() => !this.stopped && this.start(roomId), Math.min(30000, 1000 * 2 ** this.tries)); }
    };
    ws.onclose = down; ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  stop() { this.stopped = true; clearInterval(this.hb); if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch { /* ignore */ } } this.ws = null; this.ok = false; }
}

/** Owns the current room: join/create/leave, polling loop, state events, reconnect after outages. */
class RoomManager {
  constructor(api) {
    this.api = api; Object.assign(this, M.emitter());
    this.client = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)) + '';
    this.code = null; this.state = null; this.status = 'idle'; // idle | connecting | online | reconnecting | error
    this.rt = new Realtime(api, () => this.refresh(), ok => { this.rtOk = ok; });
    this.lastOk = 0; this.fails = 0; this.timer = null; this.busy = false; this.stopped = false;
    this.roomKey = 'bdmp.room.' + api.cfg.profile;
  }
  _status(s, detail) { if (this.status !== s || detail) { this.status = s; this.emit('status', s, detail); } }

  async create(name) {
    this._status('connecting');
    const r = await this.api.rpc('create_room', { p_name: name, p_client: this.client });
    return this._enter(r.code, name);
  }
  async join(code, name) {
    this._status('connecting');
    const r = await this.api.rpc('join_room', { p_code: code, p_name: name, p_client: this.client });
    return this._enter(r.code, name);
  }
  async _enter(code, name) {
    this.code = code; M.store.set(this.roomKey, { code, name });
    await this.refresh(true);
    this._schedule();
    return code;
  }
  /** Re-attach after the snippet is re-run (e.g. browser refresh). Quietly returns false if the seat is gone. */
  async resume() {
    const saved = M.store.get(this.roomKey, null);
    if (!saved) return false;
    try { await this.join(saved.code, saved.name); return true; }
    catch (e) { if (e.code !== 'network') M.store.del(this.roomKey); this._status('idle'); return false; }
  }
  _schedule() {
    clearTimeout(this.timer);
    if (this.stopped || !this.code) return;
    const base = this.state && this.state.phase === 'battle' ? Math.min(600, this.api.cfg.pollMs) : this.rtOk ? this.api.cfg.pollMsRealtime : this.api.cfg.pollMs;   // battle: faster, so pause/resume reach everyone quickly
    const wait = this.fails ? Math.min(10000, 1000 * 2 ** Math.min(this.fails, 4)) : base;
    this.timer = setTimeout(() => this.refresh().finally(() => this._schedule()), wait);
  }
  async refresh(first) {
    if (!this.code || this.busy) return;
    this.busy = true;
    try {
      const prevS = this.state, have = prevS && prevS.match && this.armyCache && this.armyCache.id === prevS.match.id && ['battle', 'results'].includes(prevS.phase);
      const s = await this.api.rpc('get_state', { p_code: this.code, p_client: this.client, p_armies: !have });
      if (s && s.match && !s.superseded) {                    // armies are large and never change after the lock: download once per match
        if ((s.armies || []).length) this.armyCache = { id: s.match.id, armies: s.armies };
        else if (this.armyCache && this.armyCache.id === s.match.id && ['battle', 'results'].includes(s.phase)) s.armies = this.armyCache.armies;
      }
      if (s && s.superseded) { this._drop('superseded'); return; }
      this.fails = 0; this.lastOk = Date.now(); this.recvAt = performance.now();
      const prev = this.state; this.state = s; this._status('online');
      if (!prev || prev.room.id !== s.room.id) this.rt.start(s.room.id);
      this.emit('state', s, prev);
    } catch (e) {
      if (e.code === 'network' || e.code === 'server' || e.code === 'auth') {
        this.fails++; this._status('reconnecting', e.message);
        if (first) throw e;
      } else if (['room_not_found', 'not_in_room', 'kicked'].includes(e.code)) this._drop(e.code);
      else { this.emit('error', e); if (first) throw e; }
    } finally { this.busy = false; }
  }
  _drop(reason) {
    this.stop(); M.store.del(this.roomKey); this.state = null; this.code = null;
    this._status('idle'); this.emit('ejected', reason);
  }
  stop() { clearTimeout(this.timer); this.rt.stop(); }
  async leave() {
    const code = this.code; this.stop(); this.code = null; this.state = null; M.store.del(this.roomKey);
    this._status('idle');
    if (code) { try { await this.api.rpc('leave_room', { p_code: code }); } catch { /* server cleans up stale seats */ } }
  }
  /** Run an action RPC then re-fetch immediately so the UI reflects it. */
  async act(fn, args) {
    const r = await this.api.rpc(fn, Object.assign({ p_code: this.code }, args || {}));
    this.refresh();
    return r;
  }
  // ---- server-synchronised clocks: server value at receipt, advanced by the local monotonic clock
  _adv(v) { return v == null ? null : v + (performance.now() - this.recvAt); }
  prepRemainingMs() { const m = this.state && this.state.match; return m && m.prepRemainingMs != null ? Math.max(0, m.prepRemainingMs - (performance.now() - this.recvAt)) : null; }
  startsInMs() { const m = this.state && this.state.match; return m && m.startsInMs != null ? Math.max(0, m.startsInMs - (performance.now() - this.recvAt)) : null; }
  /** battle time in ms since the synchronized start: negative during the countdown, frozen while the host has paused */
  elapsedMs() {
    const m = this.state && this.state.match; if (!m || m.elapsedMs == null) return null;
    return m.paused ? m.elapsedMs : (m.elapsedMs - (m.startsInMs || 0)) + (performance.now() - this.recvAt);
  }
}
M.RoomManager = RoomManager;
