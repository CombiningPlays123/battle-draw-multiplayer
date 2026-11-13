// Assembles ./pages (website + multiplayer.js) ready to upload to GitHub Pages. Run `npm run build` first.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const out = path.join(root, 'pages');
if (!fs.existsSync(path.join(root, 'dist/multiplayer.js')) || !fs.existsSync(path.join(root, 'website/snippet.json'))) { console.error('Run "npm run build" first.'); process.exit(1); }
if (/127\.0\.0\.1|localhost/.test(fs.readFileSync(path.join(root, 'website/snippet.json'), 'utf8'))) { console.error('Refusing: the last build was a --dev build. Run "npm run build" with your real config.'); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'website'))) fs.copyFileSync(path.join(root, 'website', f), path.join(out, f));
fs.copyFileSync(path.join(root, 'dist/multiplayer.js'), path.join(out, 'multiplayer.js'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('pages/ ready: ' + fs.readdirSync(out).join(', '));
