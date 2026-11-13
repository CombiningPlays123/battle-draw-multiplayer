# Testing - what was run, what was not

Environment: no Supabase credentials were available, so the **same SQL** ran in PGlite (WASM PostgreSQL) behind an API with the same
shape the client uses on Supabase. Public pages can't call `localhost`, so in-browser tests run that backend **inside one real
neal.fun/battle-draw tab** (the "leader") and the other tabs reach it over `BroadcastChannel` through a `fetch` shim
(`tools/make-test-kit.mjs`, `tests/browser/bridge.html`). Every browser test below used the **real Battle Draw simulation**.

## A. Automated backend tests - `npm test` (16 tests, all passing)
Rooms (create/join/full/invalid/duplicate session/names) · teams (1v1, 2v2, 3v1, limits, host-only) · start rules (≥2 players, both teams,
all ready, host only) · zones for 1v1/2v2/3v1/FFA3/FFA4 · army validation (own zone only, unit whitelist, size caps, shape, walls/mines
zone check) · armies hidden from others until the lock (only unit counts visible) · lock by all-ready / host / timer / unlimited ·
"nothing to fight" cancels the match · battle clock + host pause/resume (paused time not counted) · result majority rules (2v2: 2 of 4 is
not enough, 3 of 4 is; 1v1: a lone report cannot decide; disagreement → disputed → host confirms) · report validation · FFA draw ·
rematch / back to lobby / host transfer / kick / leaving mid-prep · chat sanitising + limits · security (no table access for
`authenticated`/`anon`, internal functions not callable, outsiders blocked, `room_pulse` members only) · lean `get_state`.

## B. Real Battle Draw in the browser
**Engine experiments (investigation):**
* Same armies + same seed ⇒ identical winner, tick and state hash (run 3×, plus again after rebuilding from scratch); different seed ⇒ different battle.
* Units, groups, **walls and mines** exported from one canvas and imported into a combined simulation; both armies fought to a decided
  result; end tick/hash identical between runs.
* Two native sides and a **4-way free-for-all** (factions 20-23, hostile to each other) ran to a single survivor side, deterministically.
* The pinned 800×540 field: input zone clamp works with real pointer drawing; strokes leaving the zone place nothing.

**Four independent browser sessions** (4 tabs, 4 identities, one room, real game in each):
* Lobby: create, 3 joins, auto-balanced teams, host assigns a team through the UI (3v1), ready buttons, mode and preparation time.
* **2v2 (Red vs Blue)**, **3v1** and **free-for-all with 4 players**: preparation with the timer, zone overlays, armies drawn inside zones
  (out-of-zone spawns rejected), uploads of units + walls + mines, lock when everyone was ready, synchronised countdown, battle.
* **Spectator/battle synchronisation:** every client built the same battle and ran the original simulation; the clients that reported
  produced **identical winner, end tick, state hash and per-player survivor counts** (e.g. 2v2: winner Blue, tick 789, hash 147e2b8e;
  FFA: winner player 3, tick 5945, hash 3982885b; 3v1: winner Blue, tick 2342, hash 4cb4cb4f). The server accepted them as the result.
* **Pause / resume** by the host: simulations froze, no ticks advanced while paused, resumed together and finished with identical results.
* **Refresh mid-battle:** a player reloaded their tab during the fight, re-ran the snippet, rejoined, rebuilt the battle from the server's
  data, caught up and reported the **same** result as everyone else.
* Results screen: winner, battle length, agreement count, contributions (units left per player), starting-armies preview, history.
* **Rematch:** players pressed ready, host started match #2: preparation restarted with an empty field and zones.
* **Host leaves:** another player became host (End-preparation button appeared); the leaver's game returned to the normal full-window field.
* Colour rings for sides 22/23 are visible in free-for-all; live per-side unit counts update.

## C. Not tested / limits
* **Real Supabase:** hosted anonymous sign-in, PostgREST error mapping, and the Realtime WebSocket accelerator (polling covers it). Needs your project.
* GitHub Pages deployment / the workflow.
* **Separate machines and different browsers.** All tabs shared one Chromium. Determinism *within one engine* is proven; **different JavaScript engines
  (Chrome vs Firefox/Safari) could in principle produce different floating-point results** - the hash check would then report a *disputed* match instead of a
  wrong winner. Use the same browser family (Chrome/Edge) for all players.
* Background tabs only simulate when the page timer runs (browsers throttle them): all four test tabs finished, but late reporters can miss the majority window;
  the match still resolves from the majority (3 of 4 in our runs).
* Water, ice and banana peels are not carried over (walls, mines and all units are). Not tested: very large armies (300 units/player cap).
* School/managed browser behaviour.

## Re-running
```bash
npm install && npm test
npm run build:dev && node tools/make-test-kit.mjs && npm run dev
# open http://127.0.0.1:54321/tests/browser/bridge.html (redirects to neal.fun/battle-draw with the kit in window.name), then in the console:
#   const f=JSON.parse(window.name.slice(5)); (0,eval)(f['/dist/test-kit.js']); await __kit.startLeader(); __kit.installShim(); __kit.clientCode=f['/dist/client.min.js']; __kit.runClient('A')
# other tabs: same, but skip startLeader() and use a different profile name.
```
