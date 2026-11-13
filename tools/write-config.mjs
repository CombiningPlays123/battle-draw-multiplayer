// Used by the GitHub workflow: writes backend/config/config.json from repository variables (public values only).
import fs from 'node:fs';
const e = process.env;
if (!e.SUPABASE_URL || !e.SUPABASE_PUBLISHABLE_KEY) { console.error('Set the SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY repository variables (see docs/DEPLOYMENT.md).'); process.exit(1); }
const clientUrl = e.CLIENT_URL || `https://${String(e.OWNER).toLowerCase()}.github.io/${e.REPO}/multiplayer.js`;
fs.mkdirSync('backend/config', { recursive: true });
fs.writeFileSync('backend/config/config.json', JSON.stringify({ supabaseUrl: e.SUPABASE_URL, supabasePublishableKey: e.SUPABASE_PUBLISHABLE_KEY, clientUrl }, null, 2));
console.log('config written; client script URL: ' + clientUrl);
