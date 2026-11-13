/* preparation.js - preparation phase. Every player draws their OWN army in their OWN original game, inside their
   zone. Nothing about the canvas is synchronised while drawing; only the finished army data (units, groups, walls,
   mines) is uploaded to the server (debounced), where it stays hidden from other players until the battle begins. */
class Preparation {
  constructor(app) {
    this.app = app; this.lastKey = ''; this.saving = false; this.dirty = true; this.timer = null; this.matchId = null; this.warned = false;
  }
  start(s) {
    const { adapter, ui } = this.app, m = s.match, z = m.zones.find(z => z.user === s.me);
    this.matchId = m.id; this.zone = z; this.s = s;
    if (!z) { ui.toast('You are not part of this match (spectating).', 'info'); return; }
    adapter.pinField(m.field.w, m.field.h);
    adapter.enterPrep({ x: z.x, y: z.y, w: z.w, h: z.h });
    if (s.myArmy && s.myArmy.units) { adapter.restoreArmy(s.myArmy); this.lastKey = adapter.armyKey(adapter.exportArmy()); }
    else adapter.clearField();
    ui.showZones(s);
    this.timer = setInterval(() => this.tick(), 400);
  }
  stop() { clearInterval(this.timer); this.timer = null; this.app.ui.hideZones(); }
  update(s) { this.s = s; }

  async tick() {
    const { adapter, rm, ui } = this.app, s = this.s; if (!s || adapter.mode !== 'prep') return;
    const army = adapter.exportArmy(), key = adapter.armyKey(army);
    ui.setArmyInfo(army);
    if (key !== this.lastKey) await this.upload(army, key);
    this.checkUnsupported();
  }
  /** Water, ice and banana peels exist in the original game but are not carried into multiplayer battles. */
  checkUnsupported() {
    const sim = this.app.adapter.sim; let n = 0;
    try { n = (sim.water.cells || 0) + (sim.ice.cells || 0) + (sim.peels.count || 0); } catch { /* ignore */ }
    if (n > 0 && !this.warned) { this.warned = true; this.app.ui.toast('Water, ice and banana peels are not carried into the shared battle (walls, mines and all units are).', 'warn'); }
  }
  async upload(army, key) {
    if (this.saving) return; this.saving = true;
    const { rm, api, ui } = this.app;
    try { await api.rpc('save_army', { p_code: rm.code, p_army: army }); this.lastKey = key; ui.setSaved(true); }
    catch (e) {
      if (e.code === 'not_prep_phase' || e.code === 'prep_over') { rm.refresh(); }
      else if (e.code !== 'network') ui.toast(M.errText(e), 'bad');
      ui.setSaved(false);
    } finally { this.saving = false; }
  }
  /** called right before "I'm done" so the server really has the final army */
  async flush() {
    const { adapter } = this.app, army = adapter.exportArmy(), key = adapter.armyKey(army);
    for (let i = 0; i < 20 && this.saving; i++) await M.sleep(100);
    if (key !== this.lastKey) await this.upload(army, key);
  }
}
M.Preparation = Preparation;

M.views = M.views || {};
M.views.prep = (ui, s) => {
  const { h } = M, m = s.match, mode = m.mode, mePl = s.players.find(p => p.id === s.me), mz = m.zones.find(z => z.user === s.me);
  const side = mz ? M.sideOf(mz.faction, mode, m.zones) : null;
  ui.refs.prepTimer = h('span', { class: 'timer' }, '--:--');
  ui.refs.armyInfo = h('span', { class: 'armyinfo' }, '0 units');
  ui.refs.saved = h('span', { class: 'saved' }, '');
  const iAmReady = mz && (s.players.find(p => p.id === s.me) || {}).ready;
  const doneBtn = h('button', { class: 'btn big ' + (iAmReady ? '' : 'primary'), disabled: !mz, onclick: async e => {
    const b = e.currentTarget; await ui.run(b, async () => { if (!iAmReady && ui.app.prep) await ui.app.prep.flush(); await ui.app.rm.act('set_ready', { p_ready: !iAmReady }); }); } },
    iAmReady ? '✓ Army locked in - click to keep editing' : '✔ My army is ready');
  const rowOf = z => { const p = s.players.find(p => p.id === z.user) || { online: false }; const sd = M.sideOf(z.faction, mode, m.zones);
    return h('div', { class: 'player' + (z.user === s.me ? ' me' : '') + (p.online ? '' : ' off') },
      h('span', { class: 'dot ' + (p.online ? 'on' : 'off') }), h('span', { class: 'swatch', style: { background: sd.color } }),
      h('span', { class: 'pname' }, z.name, z.user === s.me ? h('span', { class: 'you' }, ' (you)') : null),
      h('span', { class: 'tag' }, (p.units || 0) + ' units'), h('span', { class: 'tag ' + (p.ready ? 'ok' : '') }, !p.id ? 'left' : p.ready ? '✓ ready' : 'drawing…')); };
  return h('div', {},
    h('div', { class: 'target prep' },
      h('small', {}, 'Preparation - draw your own army'),
      h('div', { class: 'trow' }, ui.refs.prepTimer),
      side ? h('div', { class: 'youare', style: { color: side.color } }, 'You: ' + side.name + (mode === 'teams' ? ' · your zone is highlighted' : '')) : null),
    h('p', { class: 'hint' }, 'Use the normal Battle Draw tools inside your highlighted zone. Nobody sees your army until the battle starts, and nobody can touch it.'),
    h('div', { class: 'row between' }, ui.refs.armyInfo, ui.refs.saved),
    doneBtn,
    h('div', { class: 'section-title' }, 'Players'), h('div', { class: 'players' }, m.zones.map(rowOf)),
    mePl && mePl.host ? h('button', { class: 'btn small', onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('end_prep')) }, 'End preparation now') : null,
    ui.leaveBtn());
};
