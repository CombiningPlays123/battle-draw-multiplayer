# Architecture

## What was found in Battle Draw (inspected 2026-11, nothing copied from the game)
neal.fun/battle-draw is a Nuxt 2 / Vue 2 page around a WebGL canvas (`#game`). There is no public API. The page component owns
`vm.game` (the game's own `Game` object); `client/battle-draw-adapter.js` finds it by walking the Vue tree and only calls methods
that instance already has. Findings, all verified in the live page:

| Question | Answer |
|---|---|
| How is the battlefield stored? | `game.sim` - a typed-array ECS (`sim.units`: type, x, y, heading, group, faction, hp… up to 32 768 units) plus grids for walls, mines, water, ice, peels. |
| How do drawing operations create units? | The brush calls `sim.createGroup(type)` then `sim.spawnUnit(type, x, y, group, heading, team)` per unit. Terrain tools call `sim.paintWall/paintMines/paintWater/paintIce/paintPeels`. |
| How does a battle run? | `game.loop` steps `sim.step()` at a fixed 1/60 s with a seeded PRNG (`sim.rng.state`). Original "Team battle": `sim.teams`, `sim.holding` (placement), `game.startRound()`. |
| How is the result determined? | `game.watchRound()` (per frame): when one of the two team factions (20 = left/red, 21 = right/blue) has no units for 1.2 s → `'left' / 'right' / 'draw'`, `game.record.summary()` gives stats. |
| Can it accept outside state? | Yes, by spawning units into it through its own methods. |
| Is it deterministic? | **Yes (tested):** same units in the same order + same `rng.state` + same field size ⇒ identical ticks, survivors and state hash, run after run, and across different browser tabs. A different seed gives a different battle. |
| Can independently drawn armies share ONE simulation? | **Yes (tested):** import each army, tagged with a faction. Factions 20/21 are the built-in teams; factions 22/23 behave as two more hostile sides, so a genuine 3-4 way free-for-all runs in the same engine. |
| Problems found | (1) field size = window size, and pointer input is hard-wired to the window → we **pin** the field to 800×540 simulation units on every client (wrapping `sim.resize`/`renderer.resize`); (2) the original result logic only knows two sides → for 3-4 sided battles we detect the winner from the simulation state ourselves, deterministically, one check per tick; (3) factions 22/23 have no colour ring → we draw our own overlay rings; (4) water/ice/banana peels are grid/stroke based and are **not** carried over. |

## Multiplayer design
```
 each player's browser                         Supabase (Postgres + RLS)                     all browsers
 ┌─────────────────────┐   save_army (own     ┌────────────────────────────┐
 │ original game       │   zone only, prep)   │ rooms players matches       │  get_state (poll / Realtime wake-up)
 │  + adapter: zone,   │ ───────────────────► │ match_players armies(hidden)│ ─────────────────────────────────────►
 │  frozen sim         │                      │ reports chat room_pulse     │  phase, timers, zones, (after lock) armies
 └─────────────────────┘                      └────────────────────────────┘
        ▲  lock                                      ▲  report_result (winner, end tick, state hash)
        │                                            │  accepted only if a majority agree
 build the SAME simulation from all armies + seed  ──┘
 start at the server's battle_start_at, keep tick = server clock (catch up / hold), host pause/resume
```
* **No canvases are synchronised.** During preparation nothing but match info, readiness and the *finished army data* ever leaves a
  player's browser, and only that player's own army, only inside their zone (server-validated), and it stays hidden from everyone
  else until the lock.
* **Zones** (`start_match`): 1v1 → left/right halves; teams → team 0 left half, team 1 right half, members stacked; free-for-all 3 →
  thirds, 4 → quadrants. Field 800×540. The client rejects spawns outside the zone; the server rejects any army that has them.
* **Lock**: when the (server) preparation timer ends, everyone is ready, or the host ends it. Fewer than two sides with units → the
  match is cancelled instead of "simulating" nothing.
* **Battle sync**: `battle_start_at` (server clock, +8 s countdown), pause accounting on the server. Each client runs the original
  loop and every 120 ms compares its tick with `elapsed × 60`: behind → steps extra ticks; ahead → holds; host-paused → freezes.
  Because the engine is deterministic, the *sequence* of steps decides the outcome, not the timing - slight timing differences between
  viewers never change the result.
* **Results**: each client detects the end at a **deterministic tick** (≥ 72 ticks with ≤ 1 side alive, or 10 simulated minutes) and
  reports `(winner, end tick, FNV-1a state hash)`. The server accepts the result when a **majority** (> half of the players) report the
  same triple; if everyone reported and nobody agrees (or 60 s pass without agreement) the match is marked **disputed** and the host
  must confirm by hand. No random winner is ever picked, nothing is declared by a single client.
* **Authoritative simulation?** Not needed in the normal case because the engine is deterministic; the state hash proves agreement.
  If two browsers ever disagreed (e.g. different JS engines producing different `Math.sin`), the dispute path above reports it
  honestly. Mixed-engine determinism is **untested** (see TESTING.md).

## Security model
RLS on every table, no client policies (except the members-only `room_pulse`), all writes through `SECURITY DEFINER` functions using
`auth.uid()`. Host-only: settings, teams, kick, start, end prep, pause/resume, confirm a disputed result. Not trusted: any client's
claim about the result (majority + hash), any army outside its zone/limits, any timer.

## Known limits
* Terrain: walls and mines are carried over; **water, ice and banana peels are not**. A warning appears if you use them.
* A modified client can upload any *valid* army inside its own zone (that is simply drawing) and could report a false result, which
  is outvoted by honest clients (it cannot decide a match alone; with 2 players a false report causes a dispute).
* The field is a fixed 800×540 area at the top-left of the window (needs ≈ 860×580 px).
* Spectators joining mid-match are not supported (rooms are closed during a match).
