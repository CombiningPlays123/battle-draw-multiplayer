/* battle-draw-adapter.js - the ONLY file that knows about neal.fun/battle-draw internals.
 *
 * What was found by inspecting the live game (Nuxt 2 / Vue 2, WebGL canvas #game):
 *   - The page component (the one with `ready, kit, tools, teams, result, report`) owns `vm.game`, an instance of the game's
 *     own Game class. No public API is documented; this adapter reads the instance the page already built.
 *   - `game.sim` is the ORIGINAL simulation: a fixed-timestep (1/60 s), seeded (`sim.rng.state`) engine whose units live in
 *     typed arrays (`sim.units`: type, x, y, heading, group, faction, hp, ...). Drawing with the brush calls `sim.createGroup()` +
 *     `sim.spawnUnit(type, x, y, group, heading, team)`; terrain tools paint `sim.walls`, `sim.mines`, ... .
 *     Same armies + same seed + same field size => bit-identical battle (verified, see docs/TESTING.md).
 *   - The game's own "Team battle" mode (`game.setTeams(true)`) splits the map: left half = red (faction 20), right half = blue
 *     (faction 21); `sim.holding` is the placement phase, `game.startRound()` begins, `game.watchRound()` decides the winner.
 *     Factions 22/23 behave as two more hostile sides, which is how a real 3-4 way free-for-all runs in the same simulation.
 *   - The map size comes from the window (`sim.resize(window / 1.075)`), and pointer input is tied to that scale.
 *
 * Preparation therefore uses the player's WHOLE window map in the game's own Team-battle mode (their side = their team's half),
 * and armies are exported in NORMALISED map coordinates (0..1). The battle runs on a fixed canonical field that is scaled to
 * fit every window, so all copies of the simulation are identical. Nothing is copied from the game; we only call the instance's
 * own methods. If neal.fun changes, only this file changes.
 */
class BDAdapter {
  constructor() {
    this.vm = null; this.game = null; this.sim = null; this.pinned = null; this.mode = 'idle';
    this.zone = null; this.saved = {}; this.ct = 1.075; this.running = false; this.onBlocked = null;
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
    const missing = ['spawnUnit', 'createGroup', 'clear', 'step', 'resize'].filter(k => typeof this.sim[k] !== 'function');
    if (missing.length || !this.sim.units || !this.sim.rng || typeof this.game.setTeams !== 'function') throw new Error('Battle Draw changed: the game no longer exposes ' + (missing.join(', ') || 'units/rng/setTeams') + '. The adapter (client/battle-draw-adapter.js) needs updating.');
    this.ct = this.game.canvasSize()[0] / this.sim.width || 1.075;
    return true;
  }
  _find() {
    try { const walk = vm => { if (vm.game && vm.game.sim) return vm; for (const c of vm.$children || []) { const r = walk(c); if (r) return r; } return null; }; return walk(window.$nuxt.$root); }
    catch { return null; }
  }
  _key(obj, name) { return (obj === this.sim ? 's.' : obj === this.game ? 'g.' : 'r.') + name; }
  _wrap(obj, name, fn) { const k = this._key(obj, name); if (!this.saved[k]) this.saved[k] = [obj, name, obj[name]]; obj[name] = fn; }
  _unwrapAll() { for (const k of Object.keys(this.saved)) { const [o, n, f] = this.saved[k]; o[n] = f; } this.saved = {}; }
  orig(obj, name) { const k = this._key(obj, name); return this.saved[k] ? this.saved[k][2] : obj[name]; }
  _uiTeams(v) { try { this.vm.teams = !!v; } catch { /* cosmetic */ } }

  /** pixels per simulation unit of what is currently drawn (the game's own scale, or our fit scale while pinned) */
  viewScale() { return this.pinned ? this.pinned.k : this.ct; }

  /* ------------------------------------------------------------ canonical battle field (identical on every client) */
  pinField(W, H) {
    if (this.pinned) return;
    const s = this.sim, r = this.game.renderer, g = this.game;
    const pin = this.pinned = { W, H, k: 1, s0: s.resize, r0: r.resize };
    const fit = () => { const [cw, ch] = g.canvasSize(); return Math.max(0.2, Math.min(cw / W, ch / H)); };
    s.resize = function () { return pin.s0.call(s, W, H); };
    r.resize = function (e, n, dpr) { pin.k = fit(); return pin.r0.call(r, W * pin.k, H * pin.k, dpr, pin.k); };
    g.resize();
  }
  unpin() {
    const pin = this.pinned; if (!pin) return;
    this.sim.resize = pin.s0; this.game.renderer.resize = pin.r0; this.pinned = null;
    try { this.game.resize(); } catch { /* ignore */ }
  }

  /* ------------------------------------------------------------ preparation: each player draws their OWN army on THEIR whole map */
  /** zone: normalised {x,y,w,h} of the map the player may draw in; teamsMode: use the game's built-in Team battle layout */
  enterPrep(zone, teamsMode, rules) {
    const s = this.sim, g = this.game, self = this;
    this._unwrapAll(); this.unpin(); this.clearToolbarRules();
    this.rules = rules && rules.balanced ? rules : null;                                    // full-window map again (e.g. after a previous battle)
    this.running = false; this.finished = null; this.mode = 'prep'; this.zone = zone;
    g.setTeams(!!teamsMode); this._uiTeams(teamsMode);                  // original: Team battle = red left half / blue right half
    s.holding = !!teamsMode;
    this._wrap(s, 'step', function () { /* frozen: the army is only being drawn */ });
    this._wrap(g, 'setTeams', function () { /* the Team-battle switch is managed by multiplayer */ });
    this._wrap(g, 'startRound', function () { self.onBlocked && self.onBlocked('start'); });
    const px = () => ({ x: zone.x * s.width, y: zone.y * s.height, w: zone.w * s.width, h: zone.h * s.height });
    const clampX = x => { const z = px(); return Math.min(z.x + z.w - 6, Math.max(z.x + 6, x)); };
    const clampY = y => { const z = px(); return Math.min(z.y + z.h - 6, Math.max(z.y + 6, y)); };
    // strokes that leave the player's side place nothing there (instead of piling units on the border)
    this._wrap(s, 'spawnUnit', function (t, x, y, ...rest) {
      const z = px(); if (x < z.x + 6 || x > z.x + z.w - 6 || y < z.y + 6 || y > z.y + z.h - 6) return -1;
      const why = self.ruleViolation(t); if (why) { self.onBlocked && self.onBlocked(why, t); return -1; }
      return self.orig(s, 'spawnUnit').call(s, t, x, y, ...rest);
    });
    for (const n of ['paintWall', 'paintMines', 'paintWater', 'paintIce', 'paintPeels']) {
      if (typeof s[n] !== 'function') continue;
      this._wrap(s, n, function (x0, y0, x1, y1, ...rest) {
        if (self.rules && !self.rules.categories.includes('terrain')) { self.onBlocked && self.onBlocked('category', 'terrain'); return 0; }
        return self.orig(s, n).call(s, clampX(x0), clampY(y0), clampX(x1), clampY(y1), ...rest);
      });
    }
    this.applyToolbarRules();
    g.setPaused(false);
  }
  /** balanced-competition rules: null when placing a unit of this type is fine, else why not ('category' | 'banned' | 'limit') */
  ruleViolation(type) {
    const r = this.rules; if (!r) return null;
    const cat = this.categoryOf(type);
    if (cat && !r.categories.includes(cat)) return 'category';
    if ((r.banned || []).includes(type)) return 'banned';
    if (this.sim.units.count >= r.maxUnits) return 'limit';
    return null;
  }
  /** unit type -> toolbar category and name, read from the game's own tool list */
  _toolInfo() {
    if (this._tools) return this._tools;
    const info = new Map(); try { for (const t of this.game.tools) if (t.tool && t.tool.kind === 'unit') info.set(t.tool.type, { cat: t.category, name: t.name }); } catch { /* ignore */ }
    return (this._tools = info);
  }
  categoryOf(type) { const i = this._toolInfo().get(type); return i && i.cat; }
  nameOf(type) { const i = this._toolInfo().get(type); return i && i.name; }
  /** hide the toolbar tabs / troop buttons the rules do not allow (best effort; the placement itself is enforced above) */
  applyToolbarRules() {
    this.clearToolbarRules();
    const r = this.rules; if (!r) return;
    const label = { army: 'Army', creatures: 'Animals', mythical: 'Mythical', terrain: 'Terrain' };
    const bannedNames = new Set((r.banned || []).map(t => this.nameOf(t)).filter(Boolean));
    const hideIf = () => {
      let root = null; try { root = this.vm.$refs.toolbar && this.vm.$refs.toolbar.$el; } catch { /* ignore */ }
      if (!root) return;
      root.querySelectorAll('.tool-tab').forEach(b => { const cat = Object.keys(label).find(k => label[k] === b.textContent.trim()); b.style.display = cat && !r.categories.includes(cat) ? 'none' : ''; });
      root.querySelectorAll('.tool').forEach(b => { const n = b.getAttribute('aria-label') || b.textContent.trim(); b.style.display = bannedNames.has(n) ? 'none' : ''; });
      try { const tb = this.vm.$refs.toolbar; if (tb && !r.categories.includes(tb.tab) && tb.openTab) tb.openTab(r.categories[0]); } catch { /* ignore */ }
    };
    this._tbObserver = new MutationObserver(hideIf);
    try { this._tbObserver.observe(this.vm.$refs.toolbar.$el, { childList: true, subtree: true }); } catch { /* ignore */ }
    this._tbTimer = setInterval(hideIf, 700); hideIf();
  }
  clearToolbarRules() {
    if (this._tbObserver) { this._tbObserver.disconnect(); this._tbObserver = null; }
    if (this._tbTimer) { clearInterval(this._tbTimer); this._tbTimer = null; }
    try { const root = this.vm.$refs.toolbar.$el; root.querySelectorAll('.tool-tab, .tool').forEach(b => { b.style.display = ''; }); } catch { /* ignore */ }
  }
  clearField() { this.orig(this.sim, 'clear').call(this.sim); this.sim.gridDirty = true; }
  zonePx() { const z = this.zone, s = this.sim; return z ? { x: z.x * s.width, y: z.y * s.height, w: z.w * s.width, h: z.h * s.height } : null; }

  /** Snapshot of the player's own drawing in NORMALISED coordinates: units (with their drawn groups), walls, mines. */
  exportArmy() {
    const s = this.sim, u = s.units, W = s.width, H = s.height, z = this.zone || { x: 0, y: 0, w: 1, h: 1 };
    const n4 = v => Math.round(v * 10000) / 10000, gmap = new Map(), groups = [], units = [];
    const cx = v => Math.min(z.x + z.w, Math.max(z.x, v)), cy = v => Math.min(z.y + z.h, Math.max(z.y, v));
    for (let i = 0; i < u.highWater; i++) {
      if (!u.alive[i] || !(u.hp[i] > 0)) continue;
      const gid = u.group[i]; let gi = -1;
      if (gid >= 0) { if (!gmap.has(gid)) { gmap.set(gid, groups.length); groups.push(s.groups.type[gid]); } gi = gmap.get(gid); }
      units.push([u.type[i], n4(cx(u.x[i] / W)), n4(cy(u.y[i] / H)), Math.round(u.heading[i] * 1000) / 1000, gi]);
    }
    const walls = [], w = s.walls, tile = w.tile;
    for (let row = 0; row < w.rows; row++) {
      let c = 0;
      while (c < w.cols) {
        if (!w.solid[row * w.cols + c]) { c++; continue; }
        let e = c; while (e < w.cols && w.solid[row * w.cols + e]) e++;
        const x0 = Math.max(c * tile / W, z.x), x1 = Math.min(e * tile / W, z.x + z.w), y0 = row * tile / H;
        if (x1 > x0 && y0 >= z.y - 0.002 && y0 <= z.y + z.h) walls.push([n4(x0), n4(y0), n4(x1 - x0), n4(tile / H)]);
        c = e;
      }
    }
    const mines = [], m = s.mines;
    for (let i = 0; i < m.high; i++) if (m.alive[i] === 1) mines.push([n4(cx(m.x[i] / W)), n4(cy(m.y[i] / H))]);
    return { v: 2, units, groups, walls, mines };
  }
  /** Put a stored army back on the player's own map (after a page refresh during preparation). */
  restoreArmy(army) {
    const s = this.sim, spawn = this.orig(s, 'spawnUnit'), W = s.width, H = s.height;
    this.clearField();
    const gm = (army.groups || []).map(t => s.createGroup(t));
    for (const [t, x, y, h, gi] of army.units || []) spawn.call(s, t, x * W, y * H, gi >= 0 ? gm[gi] : -1, h);
    this._paintTerrain(army, W, H);
  }
  _paintTerrain(army, W, H) {
    const s = this.sim;
    for (const [x, y, w, h] of army.walls || []) {
      const px = x * W, py = y * H, ph = Math.max(3, h * H), pw = w * W, r = ph / 2;
      s.paintWall(px + r, py + r, Math.max(px + r, px + pw - r), py + r, r);
    }
    for (const [x, y] of army.mines || []) s.mines.add(x * W, y * H);
    s.gridDirty = true;
  }
  armyKey(a) { return a.units.length + ':' + a.walls.length + ':' + a.mines.length + ':' + a.units.reduce((h, u) => (h * 31 + Math.round(u[1] * 9973) * 7 + Math.round(u[2] * 9973) * 13 + u[0]) % 1000003, 7); }

  /* ------------------------------------------------------------ battle: every client builds the SAME simulation */
  /** armies: [{faction, slot, data}] in slot order; seed: server-chosen; field: canonical {w,h}. Leaves the sim frozen at tick 0. */
  buildBattle(armies, seed, field) {
    const s = this.sim, g = this.game, W = field.w, H = field.h;
    this._unwrapAll(); this.clearToolbarRules(); this.rules = null;
    this.mode = 'battle-ready'; this.zone = null;
    this.pinField(W, H);                                              // identical field on every client, scaled to fit this window
    const stepFn = s.step; this.stepFn = stepFn;                       // original step
    g.setTeams(true); this._uiTeams(true);                            // original team mode: sim.teams, clear, holding
    this._wrap(g, 'setTeams', function () { });                       // nobody may toggle it mid-match
    this._wrap(g, 'clear', function () { });                          // nor wipe the battlefield
    this._wrap(g, 'startRound', function () { });                     // the page's own Start button must not start it early
    this._wrap(s, 'step', function () { });                           // frozen until the synchronized start
    s.clear();
    s.tick = 0; s.time = 0; s.rng.state = seed >>> 0; s.lastBlow = -Infinity;
    const u = s.units, spawn = this.orig(s, 'spawnUnit');
    const factions = []; this.owner = new Int8Array(u.capacity || 32768).fill(-1); this.placed = {};
    for (const { faction, slot, data } of armies) {
      if (!factions.includes(faction)) factions.push(faction);
      const spawnTeam = faction === 20 || faction === 21 ? faction : 20;      // only 20/21 are valid explicit teams
      const gm = (data.groups || []).map(t => { const id = s.createGroup(t, spawnTeam); if (id >= 0 && spawnTeam !== faction) s.groups.faction[id] = faction; return id; });
      for (const [t, x, y, h, gi] of data.units || []) {
        const id = spawn.call(s, t, x * W, y * H, gi >= 0 ? gm[gi] : -1, h, spawnTeam);
        if (id >= 0) { this.owner[id] = slot; this.placed[slot] = (this.placed[slot] || 0) + 1; }
        if (id >= 0 && spawnTeam !== faction && u.faction[id] === spawnTeam) { u.faction[id] = faction; u.team[id] = faction; }   // teamable units join side 22/23
      }
      this._paintTerrain(data, W, H);
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
    this.running = false; this._unwrapAll(); this.clearToolbarRules(); this.rules = null; this.mode = 'idle'; this.zone = null;
    try { this.game.setTeams(false); this._uiTeams(false); this.game.setPaused(false); } catch { /* ignore */ }
    this.unpin();
  }
}
M.BDAdapter = BDAdapter;
