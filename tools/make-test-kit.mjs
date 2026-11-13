// Builds dist/test-kit.js: an in-browser test backend (PGlite running the REAL migrations) + fetch shim,
// so several real Battle Draw tabs can be tested together WITHOUT any network access to localhost
// (public pages are not allowed to call localhost in modern Chrome/Electron).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { transformSync } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readdirSync(path.join(root, 'backend/migrations')).filter(f => f.endsWith('.sql') && !f.includes('optional')).sort().map(f => fs.readFileSync(path.join(root, 'backend/migrations', f), 'utf8')).join('\n').split('\n').filter(l => !/^\s*--/.test(l) && l.trim()).join('\n');
const kit = `
(()=>{
const BASE='https://bdmp.test', SQL=${JSON.stringify(sql)};
const bc=new BroadcastChannel('bdmp-kit'), pending=new Map(); let db=null, q=Promise.resolve(); const users=new Map();
const tok=id=>'k.'+btoa(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1e3)+3600}));
const uidOf=t=>{try{return JSON.parse(atob(String(t).replace('Bearer ','').split('.')[1])).sub}catch{return null}};
const ser=f=>q=q.then(f,f);
async function serve(req){
  const u=new URL(req.url), body=req.body?JSON.parse(req.body):{}; const j=(s,o)=>({status:s,body:JSON.stringify(o)});
  if(u.pathname==='/auth/v1/signup'){const id=crypto.randomUUID(),r='r.'+id;users.set(r,id);return j(200,{access_token:tok(id),refresh_token:r,expires_in:3600,user:{id}});}
  if(u.pathname==='/auth/v1/token'){const id=users.get(body.refresh_token);return id?j(200,{access_token:tok(id),refresh_token:body.refresh_token,expires_in:3600,user:{id}}):j(400,{message:'bad refresh'});}
  if(u.pathname.startsWith('/rest/v1/rpc/')){
    const fn=u.pathname.split('/').pop(), uid=uidOf(req.headers.Authorization||req.headers.authorization); if(!uid||!/^[a-z_]+$/.test(fn)||fn[0]==='_')return j(401,{message:'JWT'});
    try{const r=await ser(()=>db.transaction(async tx=>{await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);await tx.exec('set local role authenticated');
      const ks=Object.keys(body);return (await tx.query('select public.'+fn+'('+ks.map((k,i)=>k+' => $'+(i+1)).join(',')+') as r',ks.map(k=>body[k]))).rows[0].r;}));return j(200,r);}
    catch(e){return j(400,{code:e.code||'P0001',message:e.message});}
  }
  return j(404,{message:'nf'});
}
const kit=window.__kit={
  async startLeader(){
    const m=await import('https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.16/dist/index.js'); db=new m.PGlite();
    await db.exec("create role anon nologin; create role authenticated nologin; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$; grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated; grant usage on schema public to anon, authenticated; alter default privileges in schema public grant all on tables to anon, authenticated; alter default privileges in schema public grant all on functions to anon, authenticated;");
    await db.exec(SQL);
    bc.onmessage=async e=>{const m=e.data; if(m.t==='req'){bc.postMessage({t:'res',id:m.id,r:await serve(m.req)});} else if(m.t==='sql'){let r;try{r=(await ser(async()=>(await db.query(m.sql)).rows));}catch(x){r='ERR '+x.message} bc.postMessage({t:'sqlres',id:m.id,r});} else if(m.t==='client'){bc.postMessage({t:'clientres',id:m.id,r:kit.clientCode||null});}};
    kit.leader=true; return 'leader ready';
  },
  _ask(msg,resT,ms=20000){const id=crypto.randomUUID();return new Promise((res,rej)=>{pending.set(id,res);setTimeout(()=>{if(pending.delete(id))rej(new TypeError('Failed to fetch'))},ms);bc.postMessage(Object.assign({id},msg));});},
  async sql(s){ if(kit.leader) return (await ser(async()=>(await db.query(s)).rows)); return kit._ask({t:'sql',sql:s}); },
  installShim(){ if(window.__shim)return; window.__shim=1; const rf=window.fetch.bind(window);
    window.fetch=async(url,o={})=>{ if(!String(url).startsWith(BASE)) return rf(url,o); const h={}; new Headers(o.headers||{}).forEach((v,k)=>h[k]=v);
      const r=kit.leader?await serve({url:String(url),headers:h,body:o.body}):await kit._ask({t:'req',req:{url:String(url),headers:h,body:o.body}}); return new Response(r.body,{status:r.status,headers:{'content-type':'application/json'}}); };
    bc.addEventListener('message',e=>{const m=e.data; if(pending.has(m.id)&&(m.t==='res'||m.t==='sqlres'||m.t==='clientres')){const f=pending.get(m.id);pending.delete(m.id);f(m.r);}}); },
  async runClient(profile){ window.BDMP_CONFIG={url:BASE,key:'k',profile:profile||'default',pollMs:700}; let code=kit.clientCode; if(!code) code=await kit._ask({t:'client'}); (0,eval)(code); }
};
})();`;
fs.writeFileSync(path.join(root, 'dist/test-kit.js'), transformSync(kit, { minify: true }).code);
const c = fs.readFileSync(path.join(root, 'dist/multiplayer.js'), 'utf8');
fs.writeFileSync(path.join(root, 'dist/client.min.js'), transformSync(c, { minify: true }).code);
for (const f of ['test-kit.js', 'client.min.js']) console.log(f, fs.statSync(path.join(root, 'dist', f)).size);
