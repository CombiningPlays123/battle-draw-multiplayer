// Local development/test backend. NOT used in production.
//
// It runs the real SQL migrations in PGlite (WASM PostgreSQL) and exposes the
// same two HTTP surfaces the client uses on Supabase:
//   POST /auth/v1/signup                 (anonymous sign-in)
//   POST /auth/v1/token?grant_type=refresh_token
//   POST /rest/v1/rpc/<function>         (PostgREST-style RPC, runs as role "authenticated")
// plus test-only helpers under /dev/*.  Realtime is not emulated (the client
// falls back to polling, which is also its safety net on real Supabase).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 54321);

export async function createBackend() {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    -- mimic Supabase default privileges so the migration's REVOKEs are meaningful
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  const dir = path.join(root, 'backend', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql') && !f.includes('optional')).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));
  async function rpc(fn, args, uid) {
    if (!/^[a-z_]+$/.test(fn) || fn.startsWith('_')) { const e = new Error('Not found'); e.status = 404; throw e; }
    return serial(() => db.transaction(async tx => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
      await tx.exec('set local role authenticated');
      const keys = Object.keys(args || {});
      const call = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
      const r = await tx.query(`select public.${fn}(${call}) as r`, keys.map(k => args[k]));
      return r.rows[0].r;
    }));
  }
  const admin = sql => serial(async () => (await db.query(sql)).rows);
  return { db, rpc, admin };
}

const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown' };

export async function startServer(port = PORT) {
  const be = await createBackend();
  const users = new Map(); // refresh token -> uid
  const mkUser = () => {
    const id = crypto.randomUUID();
    const refresh = 'r.' + crypto.randomUUID();
    users.set(refresh, id);
    const tok = id2tok(id);
    return { access_token: tok, token_type: 'bearer', expires_in: 3600, refresh_token: refresh, user: { id, is_anonymous: true } };
  };
  const id2tok = id => 'dev.' + Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const tok2id = t => { try { return JSON.parse(Buffer.from(String(t).replace(/^Bearer /, '').split('.')[1], 'base64url').toString()).sub; } catch { return null; } };

  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const json = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (url.pathname === '/auth/v1/signup') return json(200, mkUser());
      if (url.pathname === '/auth/v1/token') {
        const b = body ? JSON.parse(body) : {};
        const id = users.get(b.refresh_token);
        if (!id) return json(400, { error: 'invalid_grant', message: 'Invalid refresh token' });
        return json(200, { access_token: id2tok(id), token_type: 'bearer', expires_in: 3600, refresh_token: b.refresh_token, user: { id } });
      }
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const uid = tok2id(req.headers.authorization);
        if (!uid) return json(401, { message: 'JWT required' });
        try {
          const r = await be.rpc(url.pathname.split('/').pop(), body ? JSON.parse(body) : {}, uid);
          return json(200, r);
        } catch (e) {
          if (e.status === 404) return json(404, { message: 'Not found' });
          return json(400, { code: e.code || 'P0001', message: e.message, details: null, hint: null });
        }
      }
      if (url.pathname === '/dev/sql' && req.method === 'POST') return json(200, await be.admin(JSON.parse(body).sql));
      if (url.pathname === '/dev/health') return json(200, { ok: true });
      // static: /dist/*, /website/*
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'website/index.html';
      const file = path.resolve(root, rel);
      if (file.startsWith(root) && !file.includes('node_modules') && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { ...cors, 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(file));
      }
      res.writeHead(404, cors); res.end('not found');
    } catch (e) { json(500, { message: String(e.message || e) }); }
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  return { server, be, port, close: () => new Promise(r => server.close(r)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startServer();
  console.log(`Dev backend (PGlite) listening on http://127.0.0.1:${s.port}`);
}
