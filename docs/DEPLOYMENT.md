# Deployment (GitHub Pages, free)

Hosts two things from one place: the **install website** and the **client script** (`multiplayer.js`) that the
console snippet loads. Nothing is deployed until *you* do the steps below.

## Option A - automatic (recommended)
1. Create a **public** GitHub repository and push this folder to its `main` branch.
2. Repo → **Settings → Secrets and variables → Actions → Variables** → add:
   * `SUPABASE_URL` = your Project URL
   * `SUPABASE_PUBLISHABLE_KEY` = your publishable/anon key (public by design - it is not a secret)
   * *(only if you use a custom domain)* `CLIENT_URL` = the full URL of `multiplayer.js`
3. Repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Push (or run **Actions → Deploy Pages → Run workflow**). The workflow builds, then publishes
   `https://<user>.github.io/<repo>/` (website) and `…/multiplayer.js` (client).
5. Open the site, click **Copy**, paste into the console on neal.fun/battle-draw.

## Option B - manual
```bash
cp backend/config/config.example.json backend/config/config.json   # fill in the 3 values
npm run build            # -> dist/multiplayer.js, dist/snippet.txt, website/snippet.json
npm run package:pages    # -> pages/  (upload these files to any static host / the gh-pages branch)
```
`config.json` is git-ignored. The build aborts if a placeholder or a service-role key is detected.

## The final console snippet
Printed by `npm run build` and shown (with a Copy button) on your site; it is also saved in `dist/snippet.txt`.
Its shape (with your real URL substituted):
```js
(function(){var URL_='https://<user>.github.io/<repo>/multiplayer.js'; /* …guards… */ var s=document.createElement('script'); s.src=URL_+'?t='+Date.now(); … document.head.appendChild(s);})();
```
It refuses to run on other sites, does nothing if already installed, falls back to fetch+eval if script tags are
blocked, and alerts with a clear message if the host is unreachable.

## Updating
Change code → `git push`; the workflow republishes. Players just re-run the snippet (cache-busted with `?t=`).
After editing `0001_schema.sql`, re-run it in the Supabase SQL editor (it is idempotent).

## Alternative script hosts
Any static HTTPS host works (Cloudflare Pages, Netlify, jsDelivr from a GitHub repo:
`https://cdn.jsdelivr.net/gh/<user>/<repo>@main/dist/multiplayer.js` after committing `dist/`). Set `clientUrl` accordingly.
