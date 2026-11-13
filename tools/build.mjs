// Build: concatenates client/*.js into ONE file (dist/multiplayer.js), injects the PUBLIC Supabase URL +
// publishable key, and generates the console snippet.
//   node tools/build.mjs            -> uses backend/config/config.json
//   node tools/build.mjs --dev      -> uses the local dev backend (http://127.0.0.1:54321)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = f => fs.readFileSync(path.join(root, f), 'utf8');
const dev = process.argv.includes('--dev');

let cfg;
if (dev) {
  cfg = { supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'dev-key', clientUrl: 'http://127.0.0.1:54321/dist/multiplayer.js' };
} else {
  const p = path.join(root, 'backend/config/config.json');
  if (!fs.existsSync(p)) {
    console.error('Missing backend/config/config.json.\nCopy backend/config/config.example.json to config.json and fill in the three values (see docs/SUPABASE_SETUP.md).');
    process.exit(1);
  }
  cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['supabaseUrl', 'supabasePublishableKey', 'clientUrl']) {
    if (!cfg[k] || /YOUR|xxxx|example/i.test(cfg[k])) { console.error(`config.json: "${k}" still has the placeholder value.`); process.exit(1); }
  }
  if (/service_role|sb_secret_/i.test(cfg.supabasePublishableKey) || (cfg.supabasePublishableKey.split('.').length === 3 &&
      JSON.parse(Buffer.from(cfg.supabasePublishableKey.split('.')[1], 'base64url').toString()).role === 'service_role')) {
    console.error('REFUSING TO BUILD: that looks like a SECRET (service_role) key. Only the publishable/anon key may go in client code.'); process.exit(1);
  }
}

const order = ['util', 'config', 'room-manager', 'battle-draw-adapter', 'chat', 'team-manager', 'preparation', 'simulation', 'results', 'ui', 'multiplayer'];
let code = '';
for (const f of order) {
  let src = rd(`client/${f}.js`);
  if (f === 'config') src = src.replace('__SUPABASE_URL__', cfg.supabaseUrl).replace('__SUPABASE_KEY__', cfg.supabasePublishableKey);
  if (f === 'ui') code += `M.STYLES = ${JSON.stringify(rd('client/styles.css'))};\n`;
  code += `\n/* ===== ${f}.js ===== */\n${src}\n`;
}
const out = `/* Battle Draw Multiplayer v1.0.0 - unofficial, not affiliated with neal.fun. Source: client/ in the project repo. */\n;(function(){\n'use strict';\nif (window.__BDMP__) { try { window.__BDMP__.show(); } catch (e) {} return; }\n${code}\n})();\n`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
new Function(out); // syntax check: abort the build on a syntax error
fs.writeFileSync(path.join(root, 'dist/multiplayer.js'), out);

// console snippet derived from the readable client/injector.js
let inj = rd('client/injector.js').replace(/\/\*[\s\S]*?\*\//g, '');
inj = inj.split('\n').filter(l => !/^\s*\/\//.test(l)).map(l => l.trim()).filter(Boolean).join(' ');
const snippet = inj.replace('__CLIENT_URL__', cfg.clientUrl);
fs.writeFileSync(path.join(root, 'dist/snippet.txt'), snippet + '\n');
fs.writeFileSync(path.join(root, 'website/snippet.json'), JSON.stringify({ snippet, clientUrl: cfg.clientUrl, version: '1.0.0' }));
console.log(`built dist/multiplayer.js (${(out.length / 1024).toFixed(1)} KB) for ${cfg.supabaseUrl}${dev ? ' [dev]' : ''}`);
console.log('snippet:\n' + snippet);
