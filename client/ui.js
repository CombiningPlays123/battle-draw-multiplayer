/* ui.js - the overlay (Shadow DOM, docked, collapsible) plus the field layer drawn over the pinned battlefield. */
class UI {
  constructor(app) {
    const { h } = M;
    this.app = app; this.draft = {}; this.sig = ''; this.refs = {}; this.collapsed = M.store.get('bdmp.collapsed', false);
    this.dock = M.store.get('bdmp.dock', 'right');
    this.host = h('div', { id: 'bdmp-root', style: { all: 'initial', position: 'fixed', zIndex: '2147483000', top: '0', left: '0', width: '0', height: '0' } });
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.appendChild(h('style', { text: M.STYLES }));
    this.toasts = h('div', { class: 'toasts' });
    this.banner = h('div', { class: 'banner-wrap' });
    this.status = h('span', { class: 'status', title: 'connection' });
    this.codeChip = h('button', { class: 'code-chip', style: { display: 'none' }, title: 'Copy room code', onclick: () => this.copyCode() });
    this.head = h('div', { class: 'head' },
      h('span', { class: 'logo' }, '⚔'), h('span', { class: 'title' }, 'Battle Draw MP'), this.status, this.codeChip, h('span', { class: 'spacer' }),
      h('button', { class: 'icon', title: 'Move to other side', onclick: () => this.setDock(this.dock === 'left' ? 'right' : 'left') }, '⇆'),
      h('button', { class: 'icon', title: 'Minimise', onclick: () => this.setCollapsed(true) }, '–'),
      h('button', { class: 'icon', title: 'Disconnect and close', onclick: () => this.app.disconnect(true) }, '✕'));
    this.body = h('div', { class: 'body' });
    this.chat = new M.Chat(app);
    this.chatSlot = h('div', { class: 'chat-slot' });
    this.panel = h('div', { class: 'panel' }, this.head, this.banner, this.body, this.chatSlot);
    this.pill = h('button', { class: 'pill', onclick: () => this.setCollapsed(false) }, h('span', { class: 'logo' }, '⚔'), this.pillText = h('span', {}, 'Battle Draw MP'));
    this.wrap = h('div', { class: 'wrap' }, this.panel, this.pill, this.toasts);
    this.fieldLayer = h('div', { class: 'field-layer' });
    this.root.appendChild(this.fieldLayer); this.root.appendChild(this.wrap);
    // the overlay must never leak key presses / clicks into the game (typing in chat would otherwise trigger shortcuts)
    ['keydown', 'keyup', 'keypress'].forEach(ev => this.wrap.addEventListener(ev, e => e.stopPropagation()));
    ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'wheel', 'click', 'dblclick', 'contextmenu'].forEach(ev => this.wrap.addEventListener(ev, e => e.stopPropagation()));
    document.documentElement.appendChild(this.host);
    this.applyLayout();
    this.ticker = setInterval(() => this.tick(), 150);
  }
  destroy() { clearInterval(this.ticker); this.host.remove(); }
  applyLayout() {
    this.wrap.classList.toggle('left', this.dock === 'left'); this.wrap.classList.toggle('right', this.dock === 'right');
    this.panel.style.display = this.collapsed ? 'none' : ''; this.pill.style.display = this.collapsed ? '' : 'none';
  }
  setDock(d) { this.dock = d; M.store.set('bdmp.dock', d); this.applyLayout(); }
  setCollapsed(v) { this.collapsed = v; M.store.set('bdmp.collapsed', v); this.applyLayout(); if (!v) this.chat.scroll(); }

  toast(msg, kind = 'info') {
    const t = M.h('div', { class: 'toast ' + kind }, msg);
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'bad' ? 6500 : 4000);
  }
  setBanner(b) {
    const key = b ? b.title + b.text : ''; if (key === this.bannerKey) return; this.bannerKey = key; this.banner.replaceChildren();
    if (b) this.banner.appendChild(M.h('div', { class: 'banner' }, M.h('b', {}, '⚠ ' + b.title), M.h('p', {}, b.text)));
  }
  setStatus(st, detail) {
    const map = { idle: ['', ''], connecting: ['connecting', 'Connecting…'], online: ['online', 'Connected'], reconnecting: ['reconnecting', 'Reconnecting…'], error: ['error', 'Error'] };
    const [cls, label] = map[st] || map.idle; this.status.className = 'status ' + cls; this.status.textContent = label; this.status.title = detail || label;
  }
  async run(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { this.toast(M.errText(e), 'bad'); } finally { if (btn && btn.isConnected) btn.disabled = false; }
  }
  async copyCode() {
    const code = this.app.rm.code; if (!code) return;
    try { await navigator.clipboard.writeText(code); this.toast('Room code copied: ' + code, 'good'); }
    catch { const ta = M.h('textarea', { text: code }); this.root.appendChild(ta); ta.select(); try { document.execCommand('copy'); this.toast('Room code copied: ' + code, 'good'); } catch { this.toast('Room code: ' + code, 'info'); } ta.remove(); }
  }

  /* ---------------------------------------------------------------- field layer (zones over the original canvas) */
  showZones(s) {
    this.hideZones(); const m = s.match, ad = this.app.adapter, sim = ad.sim, ct = ad.viewScale(), W = sim.width * ct, H = sim.height * ct;
    this.fieldLayer.style.width = Math.round(W) + 'px'; this.fieldLayer.style.height = Math.round(H) + 'px'; this.fieldLayer.classList.add('on'); this.fieldLayer.classList.add('plain');
    const seen = new Map();
    for (const z of m.zones) { const k = [z.x, z.y, z.w, z.h].join(','); const e = seen.get(k) || { z, mine: false, names: [] }; e.mine = e.mine || z.user === s.me; e.names.push(z.name); seen.set(k, e); }
    this.zonesEl = M.h('div', { class: 'zones' }, [...seen.values()].map(({ z, mine, names }) => {
      const sd = M.sideOf(z.faction, m.mode, m.zones);
      return M.h('div', { class: 'zone' + (mine ? ' mine' : ''), style: { left: z.x * W + 'px', top: z.y * H + 'px', width: z.w * W + 'px', height: z.h * H + 'px', '--tc': sd.color } },
        M.h('span', { class: 'zlabel' }, mine ? (m.mode === 'teams' ? 'YOUR SIDE - draw here' : 'YOUR SECTOR - draw here') : (m.mode === 'teams' ? sd.name + ' side' : names.join(' + ') + ' sector') + ' (hidden)'));
    }));
    this.fieldLayer.appendChild(this.zonesEl);
  }
  hideZones() { if (this.zonesEl) this.zonesEl.remove(); this.zonesEl = null; }
  hideField() { this.hideZones(); this.fieldLayer.classList.remove('on'); this.fieldLayer.classList.remove('plain'); [...this.fieldLayer.querySelectorAll('.bigcount, .markers')].forEach(e => e.remove()); }
  setArmyInfo(a) { const st = this.app.rm.state, r = st && st.match && st.match.rules; if (this.refs.armyInfo) this.refs.armyInfo.textContent = `${a.units.length}` + (r && r.balanced ? ' / ' + r.maxUnits : '') + ' units' + (a.walls.length ? ` · ${a.walls.length} wall pieces` : '') + (a.mines.length ? ` · ${a.mines.length} mines` : ''); }
  setSaved(ok) { if (this.refs.saved) { this.refs.saved.textContent = ok ? '✓ saved to the room' : 'not saved yet…'; this.refs.saved.className = 'saved ' + (ok ? 'ok' : ''); } }

  /* ---------------------------------------------------------------- rendering */
  stateSig(s) {
    const m = s.match;
    return JSON.stringify([s.phase, s.room.mode, s.room.prepSeconds, s.room.hostId, s.room.rules,
      s.players.map(p => [p.id, p.name, p.online, p.ready, p.team, p.host, p.units, p.reported]),
      m && [m.id, m.phase, m.paused, m.outcome, m.result, m.zones.length, m.reports, m.rules], s.history && s.history.length, (s.armies || []).length, this.app.rm.startsInMs() > 0]);
  }
  render(s) {
    this.codeChip.style.display = s ? '' : 'none'; if (s) this.codeChip.textContent = s.room.code + ' ⧉';
    this.chatSlot.replaceChildren(s ? this.chat.el : ''); if (s) this.chat.update(s);
    const sig = s ? this.stateSig(s) : 'landing'; if (sig === this.sig) return; this.sig = sig;
    const active = this.root.activeElement, focusId = active && active.id, caret = active && active.selectionStart;
    this.refs = {}; this.countdownEl = null;
    this.body.replaceChildren(s ? this.roomView(s) : this.landing());
    if (focusId) { const el = this.root.getElementById(focusId); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* n/a */ } } }
    this.tick();
  }
  roomView(s) {
    switch (s.phase) {
      case 'lobby': return M.views.lobby(this, s);
      case 'prep': return M.views.prep(this, s);
      case 'battle': return M.views.battle(this, s);
      case 'results': return M.views.results(this, s);
    }
    return M.h('div', {}, 'Unknown phase ' + s.phase);
  }
  leaveBtn() { return M.h('div', { class: 'footer-row' }, M.h('button', { class: 'btn ghost small', onclick: e => this.confirmLeave(e.currentTarget) }, 'Leave room')); }
  confirmLeave(btn) {
    if (btn.dataset.sure) { this.run(btn, () => this.app.leaveRoom()); return; }
    btn.dataset.sure = '1'; btn.textContent = 'Really leave?'; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.sure; btn.textContent = 'Leave room'; } }, 3000);
  }
  resultBanner(kind, title, sub) { return M.h('div', { class: 'result ' + kind }, M.h('div', { class: 'big' }, title), M.h('p', {}, sub)); }

  landing() {
    const { h } = M, cfgOk = this.app.api.configured;
    const name = h('input', { id: 'name-input', class: 'input', maxlength: '16', placeholder: 'Your name', value: this.draft.name || M.store.get('bdmp.name', ''), autocomplete: 'off' });
    const code = h('input', { id: 'code-input', class: 'input code', maxlength: '8', placeholder: 'ROOM CODE', value: this.draft.code || '', autocomplete: 'off' });
    name.addEventListener('input', () => { this.draft.name = name.value; });
    code.addEventListener('input', () => { code.value = code.value.toUpperCase(); this.draft.code = code.value; });
    const nm = () => { const v = name.value.trim(); if (!v) { this.toast('Enter a name first.', 'warn'); name.focus(); return null; } M.store.set('bdmp.name', v); return v; };
    const create = h('button', { class: 'btn primary big', onclick: () => { const n = nm(); if (n) this.run(create, () => this.app.rm.create(n)); } }, 'Create room');
    const join = h('button', { class: 'btn', onclick: () => { const n = nm(); if (!n) return; if (!code.value.trim()) { this.toast('Enter a room code.', 'warn'); code.focus(); return; } this.run(join, () => this.app.rm.join(code.value, n)); } }, 'Join');
    code.addEventListener('keydown', e => { if (e.key === 'Enter') join.click(); });
    return h('div', { class: 'landing' },
      h('h2', {}, 'Battle Draw, with friends'),
      h('p', { class: 'hint' }, 'Up to 4 players. Everyone draws their own army, then all armies fight in ONE battle using the real Battle Draw simulation.'),
      !cfgOk ? h('div', { class: 'banner' }, h('b', {}, '⚠ Not configured'), h('p', {}, M.ERRORS.not_configured)) : null,
      name, create, h('div', { class: 'or' }, h('span', {}, 'or join a friend')), h('div', { class: 'row' }, code, join),
      h('details', { class: 'tally' }, h('summary', {}, 'How to play'),
        h('ol', { class: 'how' }, h('li', {}, 'The host picks Team battle (Red vs Blue: 1v1, 2v2, 3v1…) or Free-for-all, and the preparation time.'),
          h('li', {}, 'Everyone presses Ready, the host starts. You draw YOUR army with the normal tools, inside your zone.'),
          h('li', {}, 'When time is up (or everyone is ready) the armies lock and all fight in one battle that everyone watches.'),
          h('li', {}, 'The result is confirmed by all players\' copies of the simulation, then you can rematch.'))),
      h('details', { class: 'tally' }, h('summary', {}, 'Installation / troubleshooting'),
        h('p', { class: 'hint' }, 'No extension needed. This panel is loaded by the console snippet from your install page. After a refresh, run the snippet again (press ↑ then Enter in the console) - you rejoin your room automatically.')));
  }

  /* ------------------------------------------------ 150 ms tick: timers/countdown/status only (no re-render) */
  tick() {
    const rm = this.app.rm, s = rm.state;
    if (!s) { this.pillText.textContent = 'Battle Draw MP'; return; }
    let pill = s.room.code;
    if (s.phase === 'prep') {
      const rem = rm.prepRemainingMs();
      if (this.refs.prepTimer) { this.refs.prepTimer.textContent = rem == null ? '∞ unlimited' : M.fmtTime(rem); this.refs.prepTimer.classList.toggle('low', rem != null && rem < 15000); }
      pill += ' · ' + (rem == null ? 'prep' : M.fmtTime(rem));
      if (rem === 0 && performance.now() - (this.lastNudge || 0) > 1000) { this.lastNudge = performance.now(); rm.refresh(); }
    } else if (s.phase === 'battle') {
      const si = rm.startsInMs(), m = s.match;
      if (this.countdownEl) { if (si > 0) { this.countdownEl.textContent = Math.ceil(si / 1000); this.countdownEl.classList.add('show'); } else this.countdownEl.classList.remove('show'); }
      this.bigCount(si);
      if (this.refs.status) this.refs.status.textContent = si > 0 ? 'Starting…' : m.paused ? '⏸ Paused by the host' : (this.app.adapter.finished ? 'Finished - confirming the result…' : 'Fighting');
      pill += si > 0 ? ' · ' + Math.ceil(si / 1000) : ' · ⚔';
    }
    this.pillText.textContent = pill;
  }
  bigCount(si) {
    const layer = this.fieldLayer; let el = layer.querySelector('.bigcount');
    if (si > 0) { if (!el) { el = M.h('div', { class: 'bigcount' }); layer.appendChild(el); } el.textContent = Math.ceil(si / 1000); this.wentAt = null; }
    else if (el) { if (!this.wentAt) { this.wentAt = performance.now(); el.textContent = 'FIGHT!'; } else if (performance.now() - this.wentAt > 900) el.remove(); }
  }
}
M.UI = UI;
