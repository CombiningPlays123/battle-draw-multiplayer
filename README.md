# Battle Draw Multiplayer

Up to four friends, **one real battle**: everybody draws their OWN army in the original [Battle Draw](https://neal.fun/battle-draw/),
then all armies fight together in the game's own simulation - as **teams (1v1, 2v2, 3v1)** or **free-for-all (up to 4)**.
No browser extension, no userscript manager, no install: you paste one snippet into the page's console.
Unofficial fan project, not affiliated with neal.fun; a separate project from Infinite Craft Multiplayer.

```
battle-draw-multiplayer/
├── client/    battle-draw-adapter.js (the ONLY file that knows the game's internals) · room-manager.js · team-manager.js ·
│              preparation.js · simulation.js · results.js · chat.js · ui.js · styles.css · multiplayer.js · injector.js
├── backend/   migrations/0001_schema.sql (tables, RLS, all server logic) · migrations/0002_optional_cron.sql · config/
├── website/   install page (GitHub Pages)      tools/  build, dev backend (PGlite), packaging
├── tests/     backend tests + in-browser bridge  docs/   INSTALLATION · SUPABASE_SETUP · DEPLOYMENT · TESTING · ARCHITECTURE
└── .github/workflows/pages.yml   one-click deploy of the website + client script
```

## Your remaining setup (≈10 minutes, all account/authorisation steps)
1. **Supabase** (free): create a project, enable *anonymous sign-ins*, run `backend/migrations/0001_schema.sql`, copy the project URL +
   publishable key → [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md)
2. **GitHub Pages** (free): push the folder to a repo (keep `.github/workflows/pages.yml` in place), set 2 repository variables, Pages →
   source "GitHub Actions" → [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
3. Open your Pages URL, copy the snippet, paste it into the console on neal.fun/battle-draw.
Nothing has been published or deployed on your behalf; no secret/service-role key is ever needed.

## How it works (short)
* **Individual armies:** nothing about the canvases is synchronised. Each player draws in their own copy, inside their own zone; only the
  *finished army data* is uploaded (hidden from others until the lock).
* **One real simulation:** the original engine is deterministic (seeded, fixed timestep). After the lock every copy of the game builds the
  *same* battle from all armies + a server seed and starts it at the same server-timed moment; the host can pause/resume for everybody.
* **Honest results:** each copy reports (winner, end tick, state hash); the server only accepts a result a majority agree on, otherwise the
  match is "disputed" and the host confirms. Nothing is randomised or invented.
Details and the findings about the original game: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What was verified / what wasn't
See [docs/TESTING.md](docs/TESTING.md): 16 automated backend tests; four independent real-game tabs ran 2v2, 3v1 and a 4-player free-for-all
with identical results, pause/resume, refresh mid-battle, rematch and host transfer. **Not yet exercised** against a real Supabase project,
on separate machines, or across different browser engines.

## Limitations
* Water, ice and banana peels aren't carried into shared battles (units, walls, mines are).
* Same browser family for everyone is recommended (floating-point determinism across engines is untested; a mismatch shows up as a *disputed* result, never a wrong winner).
* Fixed 800×540 battlefield in the window's top-left (needs ≈ 900×620 px).
* Refreshing removes the snippet; re-run it (↑ + Enter) and the client rejoins, even mid-battle.
* If neal.fun changes its internals, only `client/battle-draw-adapter.js` needs updating.
* School-managed browsers may block DevTools, console pasting or the network hosts - see docs/INSTALLATION.md.
