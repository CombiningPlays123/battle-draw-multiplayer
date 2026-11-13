/* config.js - the build step (tools/build.mjs) replaces the two placeholders with the values from
   backend/config/config.json. Only the PUBLIC project URL and the publishable/anon key belong here.
   Never put a service_role / secret key in client code. */
M.CONFIG = Object.assign({
  url: '__SUPABASE_URL__',
  key: '__SUPABASE_KEY__',
  profile: 'default',      // separate identity slot; only useful for testing several players in one browser
  pollMs: 1500,            // polling interval when Realtime is not connected
  pollMsRealtime: 5000,    // safety-net polling interval while Realtime is connected
}, (typeof window !== 'undefined' && window.BDMP_CONFIG) || {});
