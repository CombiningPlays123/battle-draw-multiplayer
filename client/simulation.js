/* simulation.js - the battle. Every client builds the SAME simulation inside its own copy of the original game
 * (identical armies in identical order + the server's seed + a fixed field size), starts it at the server-synchronised
 * moment, and keeps it at the tick implied by the server clock (host pause/resume included). The original engine is
 * deterministic, so every viewer sees the same battle. Each client reports (winner, end tick, state hash); the server
 * only accepts a result a majority of players agree on - nobody can simply declare a winner. */
class BattleRunner {
  constructor(app) { this.app = app; this.begun = false; this.reported = false; this.timer = null; this.raf = null; this.result = null; }
  start(s) {
    const { adapter, ui } = this.app, m = s.match; this.s = s; this.matchId = m.id;
    const armies = s.armies.map(a => ({ faction: a.faction, slot: (m.zones.find(z => z.user === a.user) || {}).slot, data: a.data }))
      .filter(a => a.slot != null).sort((a, b) => a.slot - b.slot);
    adapter.pinField(m.field.w, m.field.h);
    try { this.info = adapter.buildBattle(armies, m.seed); }
    catch (e) { console.error('[BDMP]', e); ui.toast('Could not set up the battle in the original game: ' + e.message, 'bad'); this.failed = e.message; return; }
    this.markers = this._makeMarkers();
    this.timer = setInterval(() => this.tick(), 120);
    this.loop();
  }
  stop() { clearInterval(this.timer); cancelAnimationFrame(this.raf); this.timer = null; if (this.markers) this.markers.remove(); }
  update(s) { this.s = s; }

  tick() {
    const { adapter, rm } = this.app, s = this.s; if (!s || this.failed) return;
    if (!this.begun) {
      this.refreshHud();
      if (rm.startsInMs() !== 0) return;
      this.begun = true;
      adapter.startBattle(r => this.onEnd(r));
    }
    const el = rm.elapsedMs();
    if (el != null && !adapter.finished) adapter.drive(Math.floor(Math.max(0, el) * 60 / 1000), s.match.paused);
    this.refreshHud();
  }
  refreshHud() {
    const { adapter, ui } = this.app, c = adapter.countByFaction(), refs = ui.refs;
    if (refs.counts) for (const [f, el] of Object.entries(refs.counts)) el.textContent = String(c[f] || 0);
    if (refs.simInfo) refs.simInfo.textContent = adapter.finished ? `ended at ${adapter.finished.seconds}s` : `${(adapter.sim.tick / 60).toFixed(1)}s`;
  }
  async onEnd(r) {
    this.result = r; this.app.ui.toast('Battle finished - confirming the result with the other players…', 'info');
    for (let i = 0; i < 8 && !this.reported; i++) {
      try {
        await this.app.api.rpc('report_result', { p_code: this.app.rm.code, p_winner: r.winner, p_tick: r.tick, p_hash: r.hash,
          p_stats: { survivors: r.survivors, placed: r.placed, counts: r.counts, why: r.why } });
        this.reported = true; this.app.rm.refresh();
      } catch (e) {
        if (['not_battle_phase', 'not_in_room'].includes(e.code)) { this.reported = true; break; }
        if (e.code === 'invalid_report') { this.app.ui.toast('The server rejected this client\'s result.', 'bad'); break; }
        await M.sleep(1500 * (i + 1));
      }
    }
  }
  /** colour rings under units of sides 22/23, which the original game only colours for the two built-in teams */
  _makeMarkers() {
    const { adapter, ui } = this.app, m = this.s.match, cv = M.h('canvas', { class: 'markers' });
    cv.width = Math.round(m.field.w * adapter.ct); cv.height = Math.round(m.field.h * adapter.ct);
    cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px';
    ui.fieldLayer.appendChild(cv); this.cv = cv; this.ctx = cv.getContext('2d');
    return cv;
  }
  loop() {
    const { adapter } = this.app, ctx = this.ctx, cv = this.cv; if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const u = adapter.sim.units, ct = adapter.ct, mode = this.s.match.mode, zones = this.s.match.zones;
    for (let i = 0; i < u.highWater; i++) {
      const f = u.faction[i]; if (f < 22 || f > 23 || !u.alive[i] || !(u.hp[i] > 0)) continue;
      const col = M.sideOf(f, mode, zones).color, r = (u.radius[i] || 8) * ct;
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.globalAlpha = .9;
      ctx.beginPath(); ctx.ellipse(u.x[i] * ct, (u.y[i] - (u.z ? u.z[i] : 0)) * ct + r * .55, r * .9, r * .45, 0, 0, Math.PI * 2); ctx.stroke();
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }
}
M.BattleRunner = BattleRunner;

M.views = M.views || {};
M.views.battle = (ui, s) => {
  const { h } = M, m = s.match, mode = m.mode, isHost = s.room.hostId === s.me;
  const factions = [...new Set(m.zones.map(z => z.faction))].sort();
  ui.refs.counts = {}; ui.refs.status = h('div', { class: 'bstatus' }); ui.refs.simInfo = h('span', {}, '0.0s');
  const sides = factions.map(f => { const sd = M.sideOf(f, mode, m.zones), members = m.zones.filter(z => z.faction === f);
    const cnt = h('b', { class: 'cnt' }, '0'); ui.refs.counts[f] = cnt;
    return h('div', { class: 'side', style: { '--tc': sd.color } }, h('div', { class: 'sidehead' }, h('span', { class: 'swatch', style: { background: sd.color } }), h('b', {}, sd.name), cnt, h('small', {}, 'alive')),
      h('small', {}, members.map(z => z.name).join(' + '))); });
  const pauseBtn = isHost ? h('button', { class: 'btn small', onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('battle_control', { p_action: m.paused ? 'resume' : 'pause' })) }, m.paused ? '▶ Resume' : '⏸ Pause') : null;
  return h('div', {},
    h('div', { class: 'target battle' }, ui.countdownEl = h('div', { class: 'countdown' }), h('small', {}, 'Battle in progress'), h('div', { class: 'tname' }, mode === 'teams' ? 'Team battle' : 'Free-for-all'), ui.refs.status),
    h('div', { class: 'sides' }, sides),
    h('div', { class: 'row between' }, h('small', { class: 'hint' }, 'Original simulation · '), ui.refs.simInfo, pauseBtn),
    h('p', { class: 'hint' }, 'Everyone is watching the same battle: each copy of the game runs the identical simulation from the same armies and seed, started at the same moment.'),
    ui.leaveBtn());
};
