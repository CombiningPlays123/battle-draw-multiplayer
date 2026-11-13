# Installing on a player's computer

No extension, no Tampermonkey, no userscript, no admin rights, no downloads.

## Console snippet (primary)
1. Open <https://neal.fun/battle-draw/>.
2. Open DevTools → **Console**: `F12` / `Ctrl+Shift+J` (Windows/Linux/ChromeOS), `⌥⌘J` (Mac).
3. Paste the snippet from your install website (it has a **Copy** button) → `Enter`. (Chrome/Edge/Firefox may ask you to type
   `allow pasting` once - that is the browser's own protection; do it, then paste again.)
4. A panel appears on the right. Enter a name → **Create room** (share the 5-letter code) or **Join**.

The snippet loads one script from your host, only on neal.fun/battle-draw, only once (running it again re-shows the panel), shows an
alert if the script cannot be loaded, and runs nothing else. **Disconnect** = the ✕ button (leaves the room, removes every hook,
restores the game's normal full-window field).

### After a page refresh
Refreshing removes injected scripts. Open the console, press `↑` then `Enter`. Your room is rejoined automatically, including
**in the middle of a battle** (the client rebuilds the battle from the server's data and catches up).

## Bookmarklet (also extension-free)
Drag the button on the install page to the bookmarks bar; click it on the Battle Draw tab.

## Standalone hosted launcher - investigated, not viable
Battle Draw sends `Content-Security-Policy: frame-ancestors 'self' https://*.neal.fun …`, so no other site can embed it, and a web page
cannot control another origin's page. The game can only be integrated from inside its own page (console / bookmarklet).

## Managed (school/work) browsers - what may block you
| Restriction | Effect | Workaround |
|---|---|---|
| DevTools disabled by policy | no console | try the bookmarklet |
| Pasting / `javascript:` blocked | snippet/bookmarklet won't run | none we provide |
| Web filter blocks `github.io` or `supabase.co` | alert "Could not load…" / "Cannot reach the multiplayer server" | none we provide; use another network |
| Battle Draw blocked | game won't load | - |
We do not suggest bypassing security controls.

## Window size
The battlefield is a fixed 800×540 area (≈ 860×580 px) in the top-left corner, identical for everyone. Use a browser window of at least
≈ 900×620 px (zoom out with `Ctrl` + `−` on small screens). Your own saved Battle Draw data is not touched (the game has none).

## Privacy
The client stores a random anonymous id + your chosen name in `localStorage`, sends room actions, chat and your *finished army* to your
Supabase project, and nothing to anyone else.
