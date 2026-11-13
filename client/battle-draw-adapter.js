/* battle-draw-adapter.js - the ONLY file that knows about neal.fun/battle-draw internals.
 *
 * What was found by inspecting the live game (Nuxt 2 / Vue 2, WebGL canvas #game):
 *   - The page component (the one with `ready, kit, tools, teams, result, report`) owns `vm.game`, an instance of
 *     the game's own Game class. No public API is documented; this adapter reads the instance the page already built.
 *   - `game.sim` is the ORIGINAL simulation: a fixed-timestep (1/60 s), seeded (`sim.rng.state`) engine whose units
 *     live in typed arrays (`sim.units`: type, x, y, heading, group, faction, hp, ...). Drawing with the brush calls
 *     `sim.createGroup()` + `sim.spawnUnit(type, x, y, group, heading, team)`; terrain tools paint `sim.walls`,
 *     `sim.mines`, ... .  Same armies + same seed => bit-identical battle (verified, see docs/TESTING.md).
 *   - The game's own "Team battle" mode puts two sides (factions 20 = left/red, 21 = right/blue) in one simulation,
 *     starts with `game.startRound()` and detects the winner in `game.watchRound()`. Factions 22/23 behave as two more
 *     hostile sides, which is how a real 3-4 way free-for-all runs in the same simulation.
 *   - The field size comes from the window (`sim.resize(window / 1.075)`) and pointer input is hard-wired to that scale,
 *     so we PIN the field to a fixed size (same on every client) by wrapping sim.resize / renderer.resize.
 *
 * Nothing is copied from the game; we only call the instance's own methods. If neal.fun changes, only this file changes.
 */
class BDAdapter {
  constructor() {
    this.vm = null; this.game = null; this.sim = null; this.pinned = null; this.mode = 'idle';
    this.zone = null; this.saved = {}; this.hook = null; this.ct = 1.075; this.running = false;
  }
  static onGame() { return /(^|\.)neal\.fun$/.test(location.hostname) && /^\/battle-draw\/?/.test(location.pathname); }

  async ready(timeoutMs = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      this.vm = this._find();
      if (this.vm && this.vm.game && this.vm.game.sim && this.vm.game.renderer) break;
      await M.sleep(300);
    }
    if (!(this.vm && this.vm.game && this.vm.game.sim)) throw new Error('Battle Draw has not finished loading, or its internal structure changed (could not find the game object).');
    this.game = this.vm.game; this.sim = this.game.sim;
    const need = ['spawnUnit', 'createGroup', 'clear', 'step', 'resize'];
    const missing = need.filter(k => typeof this.sim[k] !== 'function');
    if (missing.length || !this.sim.units || !this.sim.rng) throw new Error('Battle Draw changed: the simulation no longer exposes ' + (missing.join(', ') || 'units/rng') + '. The adapter (client/battle-draw-adapter.js) needs updating.');
    this.ct = this.game.canvasSize()[0] / this.sim.width || 1.075;
    return true;
  }
  _find() {
    try {
      const walk = vm => { if (vm.game && vm.game.sim) return vm; for (const c of vm.$children || []) { const r = walk(c); if (r) return r; } return null; };
      return walk(window.$nuxt.$root);
    } catch { return null; }
  }
  _wrap(obj, name, fn) { const k = obj === this.sim ? 's.' + name : obj === this.game ? 'g.' + name : 'r.' + name; if (!this.saved[k]) this.saved[k] = [obj, name, obj[name]]; obj[name] = fn; }
  _unwrapAll() { for (const k of Object.keys(this.saved)) { const [o, n, f] = this.saved[k]; o[n] = f; } this.saved = {}; }
  orig(obj, name) { const k = obj === this.sim ? 's.' + name : obj === this.game ? 'g.' + name : 'r.' + name; return this.saved[k] ? this.saved[k][2] : obj[name]; }

  /* ------------------------------------------------------------ field pinning (identical field on every client) */
  pinField(W, H) {
    if (this.pinned) return;
    const s = this.sim, r = this.game.renderer, pin = this.pinned = { W, H, s0: s.resize, r0: r.resize };
    s.resize = function () { return pin.s0.call(s, W, H); };
    r.resize = function (e, n, dpr, sc) { return pin.r0.call(r, W * sc, H * sc, dpr, sc); };
    this.game.resize();
  }
  /* ------------------------------------------------------------ preparation: each player draws their OWN army */
  enterPrep(zone) {
    const s = this.sim, g = this.game, self = this;
    this._unwrapAll();                                              // e.g. coming back from a previous battle (rematch)
    g.setTeams(false);                                              // original: leave team mode (sim.teams off, holding off)
    this.running = false; this.finished = null;
    this.mode = 'prep'; this.zone = zone;
    this._wrap(s, 'step', function () { /* frozen: the army is only being drawn, nothing fights during preparation */ });
    this._wrap(g, 'setTeams', function () { /* the original Team-battle toggle is managed by multiplayer */ });
    this._wrap(g, 'startRound', function () { });
    const clampX = x => Math.min(zone.x + zone.w - 10, Math.max(zone.x + 10, x));
    const clampY = y => Math.min(zone.y + zone.h - 10, Math.max(zone.y + 10, y));
    // strokes that leave the player's zone simply place nothing there (instead of piling units on the border)
    this._wrap(s, 'spawnUnit', function (t, x, y, ...rest) {
      if (x < zone.x + 8 || x > zone.x + zone.w - 8 || y < zone.y + 8 || y > zone.y + zone.h - 8) return -1;
      return self.orig(s, 'spawnUnit').call(s, t, x, y, ...rest);
    });
    for (const n of ['paintWall', 'paintMines', 'paintWater', 'paintIce', 'paintPeels']) {
      if (typeof s[n] !== 'function') continue;
      this._wrap(s, n, function (x0, y0, x1, y1, ...rest) { return self.orig(s, n).call(s, clampX(x0), clampY(y0), clampX(x1), clampY(y1), ...rest); });
    }
    s.teams = false; s.holding = false; g.setPaused(false);
  }
  clearField() { this.orig(this.sim, 'clear').call(this.sim); this.sim.gridDirty = true; }

  /** Snapshot of the player's own drawing: units (with their drawn groups), walls (as rectangles), mines. */
  exportArmy() {
    const s = this.sim, u = s.units, z = this.zone || { x: 0, y: 0, w: this.pinned.W, h: this.pinned.H };
    const r2 = v => Math.round(v * 100) / 100, gmap = new Map(), groups = [], units = [];
    const cx = x => Math.min(z.x + z.w, Math.max(z.x, x)), cy = y => Math.min(z.y + z.h, Math.max(z.y, y));
    for (let i = 0; i < u.highWater; i++) {
      if (!u.alive[i] || !(u.hp[i] > 0)) continue;
      const gid = u.group[i]; let gi = -1;
      if (gid >= 0) { if (!gmap.has(gid)) { gmap.set(gid, groups.length); groups.push(s.groups.type[gid]); } gi = gmap.get(gid); }
      units.push([u.type[i], r2(cx(u.x[i])), r2(cy(u.y[i])), Math.round(u.heading[i] * 1000) / 1000, gi]);
    }
    const walls = [], w = s.walls, tile = w.tile;
    for (let row = 0; row < w.rows; row++) {
      let c = 0;
      while (c < w.cols) {
        if (!w.solid[row * w.cols + c]) { c++; continue; }
        let e = c; while (e < w.cols && w.solid[row * w.cols + e]) e++;
        const x0 = Math.max(c * tile, z.x), x1 = Math.min(e * tile, z.x + z.w), y0 = row * tile;
        if (x1 > x0 && y0 >= z.y - 1 && y0 <= z.y + z.h) walls.push([r2(x0), r2(y0), r2(x1 - x0), tile]);
        c = e;
      }
    }
    const mines = [], m = s.mines;
    for (let i = 0; i < m.high; i++) if (m.alive[i] === 1) mines.push([r2(cx(m.x[i])), r2(cy(m.y[i]))]);
    return { v: 1, units, groups, walls, mines };
  }
  /** Put a stored army back on the player's own canvas (after a page refresh during preparation). */
  restoreArmy(army) {
    const s = this.sim, spawn = this.orig(s, 'spawnUnit');
    this.clearField();
    const gm = (army.groups || []).map(t => s.createGroup(t));
    for (const [t, x, y, h, gi] of army.units || []) spawn.call(s, t, x, y, gi >= 0 ? gm[gi] : -1, h);
    this._paintTerrain(army);
  }
  _paintTerrain(army) {
    const s = this.sim;
    for (const [x, y, w, h] of army.walls || []) s.paintWall(x + h / 2, y + h / 2, x + w - h / 2, y + h / 2, h / 2);
    for (const [x, y] of army.mines || []) s.mines.add(x, y);
    s.gridDirty = true;
  }
  armyKey(a) { return a.units.length + ':' + a.walls.length + ':' + a.mines.length + ':' + a.units.reduce((h, u) => (h * 31 + u[1] * 7 + u[2] * 13 + u[0]) % 1000003, 7); }

  /* ------------------------------------------------------------ battle: every client builds the SAME simulation */
  /** armies: [{faction, data}] in slot order; seed: server-chosen. Leaves the sim frozen at tick 0 (holding). */
  buildBattle(armies, seed) {
    const s = this.sim, g = this.game;
    this._unwrapAll();
    this.mode = 'battle-ready';
    const stepFn = s.step;                                           // original step
    this.stepFn = stepFn;
    this.orig_teams = g.setTeams;
    g.setTeams(true);                                                // original team mode: sim.teams, clear, holding
    this._wrap(g, 'setTeams', function () { });                      // nobody may toggle it mid-match
    this._wrap(g, 'clear', function () { });                         // nor wipe the battlefield
    this._wrap(g, 'startRound', function () { });                    // the page's own Start button must not start it early
    this._wrap(s, 'step', function () { });                          // frozen until the synchronized start
    s.clear();
    s.tick = 0; s.time = 0; s.rng.state = seed >>> 0; s.lastBlow = -Infinity;
    const u = s.units, spawn = this.orig(s, 'spawnUnit');
    const factions = []; this.owner = new Int8Array(u.capacity || 32768).fill(-1); this.placed = {};
    for (const { faction, slot, data } of armies) {
      if (!factions.includes(faction)) factions.push(faction);
      const spawnTeam = faction === 20 || faction === 21 ? faction : 20;      // only 20/21 are valid explicit teams
      const gm = (data.groups || []).map(t => { const id = s.createGroup(t, spawnTeam); if (id >= 0 && spawnTeam !== faction) s.groups.faction[id] = faction; return id; });
      for (const [t, x, y, h, gi] of data.units || []) {
        const id = spawn.call(s, t, x, y, gi >= 0 ? gm[gi] : -1, h, spawnTeam);
        if (id >= 0) { this.owner[id] = slot; this.placed[slot] = (this.placed[slot] || 0) + 1; }
        if (id >= 0 && spawnTeam !== faction && u.faction[id] === spawnTeam) { u.faction[id] = faction; u.team[id] = faction; }   // teamable units join side 22/23
      }
      this._paintTerrain(data);
    }
    s.gridDirty = true;
    this.factions = factions; this.finished = null; this.overSince = -1;
    // the original result logic only knows two sides; with 3+ sides we decide from the simulation state ourselves
    if (factions.some(f => f > 21)) this._wrap(g, 'watchRound', function () { });
    return { factions, units: this.countByFaction() };
  }
  countByFaction() {
    const u = this.sim.units, c = {};
    for (let i = 0; i < u.highWater; i++) { if (!u.alive[i] || !(u.hp[i] > 0)) continue; const f = u.faction[i]; if (f >= 20 && f <= 23) c[f] = (c[f] || 0) + 1; }
    return c;
  }
  /** survivors per player slot (units are tagged with their owner when the battle is built) */
  survivorsBySlot() {
    const u = this.sim.units, c = {};
    for (let i = 0; i < u.highWater; i++) { if (!u.alive[i] || !(u.hp[i] > 0)) continue; const o = this.owner[i]; if (o >= 0 && u.faction[i] >= 20 && u.faction[i] <= 23) c[o] = (c[o] || 0) + 1; }
    return c;
  }
  /** FNV-1a over the state that decides a battle; identical on every client iff their simulations are identical. */
  stateHash() {
    const u = this.sim.units, buf = new Float32Array(4), ints = new Uint32Array(buf.buffer); let h = 0x811c9dc5;
    const mix = v => { h ^= v; h = Math.imul(h, 0x01000193) >>> 0; };
    for (let i = 0; i < u.highWater; i++) {
      if (!u.alive[i]) continue;
      buf[0] = u.x[i]; buf[1] = u.y[i]; buf[2] = u.hp[i]; buf[3] = u.heading[i];
      mix(u.type[i]); mix(u.faction[i]); mix(ints[0]); mix(ints[1]); mix(ints[2]); mix(ints[3]);
    }
    mix(this.sim.tick);
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  /** Start the battle now (call at the server-synchronized moment). `onEnd(result)` fires once, at a deterministic tick. */
  startBattle(onEnd) {
    const s = this.sim, g = this.game, self = this, stepFn = this.stepFn;
    this.mode = 'battle'; this.onEnd = onEnd; this.running = true;
    const LIMIT = 36000;                                                 // 10 simulated minutes
    this._wrap(s, 'step', function () {
      stepFn.call(s);
      if (self.finished) return;
      const counts = self.countByFaction(), alive = Object.keys(counts).map(Number);
      if (alive.length <= 1) { if (self.overSince < 0) self.overSince = s.tick; } else self.overSince = -1;
      if (self.overSince >= 0 && s.tick - self.overSince >= 72) self._finish(alive.length ? alive[0] : -1, 'sim');
      else if (s.tick >= LIMIT) self._finish(-1, 'timelimit');
    });
    this.saved['g.startRound'][2].call(g);                              // original startRound: holding off, record.begin, unpause
  }
  _finish(winner, why) {
    this.finished = { winner, tick: this.sim.tick, hash: this.stateHash(), why, counts: this.countByFaction(), survivors: this.survivorsBySlot(), placed: this.placed, seconds: Math.round(this.sim.tick / 60 * 10) / 10 };
    this.running = false;
    this._wrap(this.sim, 'step', function () { });                     // stop at the decided tick
    try { this.onEnd && this.onEnd(this.finished); } catch (e) { console.error('[BDMP]', e); }
  }
  /** Keep this client's simulation at the tick implied by the server clock: catch up if behind, hold back if ahead. */
  drive(targetTick, hostPaused) {
    if (!this.running) return;
    const s = this.sim, L = this.game.loop, diff = targetTick - s.tick;
    if (diff > 5) { for (let k = 0, n = Math.min(diff, 900); k < n && this.running; k++) s.step(); }   // catch up (also while paused, so everyone freezes on the same tick)
    if (hostPaused) { if (!L.paused) this.game.setPaused(true); return; }
    const hold = diff < -6;
    if (L.paused !== hold) this.game.setPaused(hold);
  }
  /** Back to the normal game (used on disconnect / return to lobby). */
  release() {
    this.running = false; this._unwrapAll(); this.mode = 'idle'; this.zone = null;
    try { this.game.setPaused(false); } catch { /* ignore */ }
    this.unpin();
  }
  unpin() {
    const pin = this.pinned; if (!pin) return;
    this.sim.resize = pin.s0; this.game.renderer.resize = pin.r0; this.pinned = null;
    try { this.game.resize(); } catch { /* ignore */ }
  }
}
M.BDAdapter = BDAdapter;
