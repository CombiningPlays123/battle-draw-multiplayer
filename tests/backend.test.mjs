// Backend tests: the real SQL (PGlite) through the same RPC surface the client uses.   node --test tests/backend.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../tools/dev-server.mjs';

const be = await createBackend();
const U = Array.from({ length: 6 }, () => crypto.randomUUID());
const rpc = (i, fn, args = {}) => be.rpc(fn, args, U[i]);
const fails = async (p, msg) => assert.rejects(p, e => (assert.match(e.message, new RegExp(msg)), true));
const admin = sql => be.admin(sql);
const NAMES = ['Ann', 'Ben', 'Cy', 'Di', 'Ed', 'Flo'];
const st = (i, code) => rpc(i, 'get_state', { p_code: code, p_client: 'c' + i });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function room(n, mode = 'teams', prep = 180) {
  const { code } = await rpc(0, 'create_room', { p_name: NAMES[0], p_client: 'c0' });
  for (let i = 1; i < n; i++) await rpc(i, 'join_room', { p_code: code, p_name: NAMES[i], p_client: 'c' + i });
  await rpc(0, 'update_settings', { p_code: code, p_mode: mode, p_prep: prep });
  return code;
}
const readyAll = async (code, n) => { for (let i = 1; i < n; i++) await rpc(i, 'set_ready', { p_code: code, p_ready: true }); };
async function startedMatch(n, mode, teams, prep = 180) {
  const code = await room(n, mode, prep);
  if (teams) for (let i = 0; i < n; i++) await rpc(0, 'set_team', { p_code: code, p_target: U[i], p_team: teams[i] });
  await readyAll(code, n);
  await rpc(0, 'start_match', { p_code: code });
  return { code, s: await st(0, code) };
}
const zoneOf = (s, i) => s.match.zones.find(z => z.user === U[i]);
const army = (z, k = 3) => ({ units: Array.from({ length: k }, (_, j) => [0, z.x + 20 + j * 10, z.y + 20, 0, 0]), groups: [0] });

test('rooms: create/join/full/invalid code/duplicate session/names', async () => {
  const code = await room(4);
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
  let s = await st(0, code);
  assert.equal(s.players.length, 4);
  await fails(rpc(4, 'join_room', { p_code: code, p_name: 'Ed', p_client: 'x' }), 'room_full');
  await fails(rpc(4, 'join_room', { p_code: 'ZZZZZ', p_name: 'Ed', p_client: 'x' }), 'room_not_found');
  await rpc(1, 'join_room', { p_code: code.toLowerCase(), p_name: 'Ben', p_client: 'c1-new' });
  assert.equal((await rpc(1, 'get_state', { p_code: code, p_client: 'c1' })).superseded, true);
  await rpc(3, 'leave_room', { p_code: code });
  await rpc(4, 'join_room', { p_code: code, p_name: 'Ann', p_client: 'z' });
  s = await st(0, code);
  assert.equal(new Set(s.players.map(p => p.name)).size, 4);
});

test('teams: host assigns any arrangement (1v1, 2v2, 3v1), limits enforced', async () => {
  const code = await room(4);
  const t = async (arr) => { for (let i = 0; i < 4; i++) await rpc(0, 'set_team', { p_code: code, p_target: U[i], p_team: arr[i] }); return (await st(0, code)).players.map(p => p.team); };
  assert.deepEqual(await t([0, 0, 1, 1]), [0, 0, 1, 1]);
  assert.deepEqual(await t([0, 1, 1, 1]), [0, 1, 1, 1]);
  await fails(rpc(0, 'set_team', { p_code: code, p_target: U[0], p_team: 1 }), 'team_full');
  await fails(rpc(1, 'set_team', { p_code: code, p_target: U[1], p_team: 0 }), 'not_host');
  await fails(rpc(0, 'set_team', { p_code: code, p_target: U[1], p_team: 2 }), 'invalid_team');
});

test('start validation: needs 2 players, both teams, everyone ready, host only', async () => {
  const { code } = await rpc(0, 'create_room', { p_name: 'Solo', p_client: 'c0' });
  await fails(rpc(0, 'start_match', { p_code: code }), 'need_players');
  await rpc(1, 'join_room', { p_code: code, p_name: 'Two', p_client: 'c1' });
  await rpc(0, 'update_settings', { p_code: code, p_mode: 'teams', p_prep: 60 });
  await rpc(0, 'set_team', { p_code: code, p_target: U[1], p_team: 0 });
  await fails(rpc(0, 'start_match', { p_code: code }), 'need_both_teams');
  await rpc(0, 'set_team', { p_code: code, p_target: U[1], p_team: 1 });
  await fails(rpc(0, 'start_match', { p_code: code }), 'not_all_ready');
  await rpc(1, 'set_ready', { p_code: code, p_ready: true });
  await fails(rpc(1, 'start_match', { p_code: code }), 'not_host');
  await fails(rpc(0, 'update_settings', { p_code: code, p_mode: 'x', p_prep: 60 }), 'invalid_mode');
  await fails(rpc(0, 'update_settings', { p_code: code, p_mode: 'ffa', p_prep: 7 }), 'invalid_timer');
  await rpc(0, 'start_match', { p_code: code });
  assert.equal((await st(0, code)).phase, 'prep');
});

test('zones: 1v1, 2v2, 3v1 and free-for-all layouts', async () => {
  let { s } = await startedMatch(2, 'teams', [0, 1]);
  assert.deepEqual(s.match.zones.map(z => [z.x, z.w, z.faction]), [[0, 400, 20], [400, 400, 21]]);
  ({ s } = await startedMatch(4, 'teams', [0, 0, 1, 1]));
  assert.deepEqual(s.match.zones.map(z => [z.x, z.y, z.h, z.faction]), [[0, 0, 270, 20], [0, 270, 270, 20], [400, 0, 270, 21], [400, 270, 270, 21]]);
  ({ s } = await startedMatch(4, 'teams', [0, 1, 1, 1]));
  assert.deepEqual(s.match.zones.map(z => [z.x, Math.round(z.h), z.faction]), [[0, 540, 20], [400, 180, 21], [400, 180, 21], [400, 180, 21]]);
  ({ s } = await startedMatch(4, 'ffa'));
  assert.deepEqual(s.match.zones.map(z => [z.x, z.y, z.faction]), [[0, 0, 20], [400, 0, 21], [0, 270, 22], [400, 270, 23]]);
  ({ s } = await startedMatch(3, 'ffa'));
  assert.deepEqual(s.match.zones.map(z => z.faction), [20, 21, 22]);
});

test('army: own zone only, validated, hidden from others until the battle', async () => {
  const { code, s } = await startedMatch(2, 'teams', [0, 1]);
  const z0 = zoneOf(s, 0), z1 = zoneOf(s, 1);
  await rpc(0, 'save_army', { p_code: code, p_army: army(z0, 5) });
  await fails(rpc(0, 'save_army', { p_code: code, p_army: army(z1, 2) }), 'outside_zone');
  await fails(rpc(0, 'save_army', { p_code: code, p_army: { units: [[99, z0.x + 5, 5, 0, 0]], groups: [0] } }), 'invalid_unit');
  await fails(rpc(0, 'save_army', { p_code: code, p_army: { units: Array.from({ length: 301 }, () => [0, 5, 5, 0, 0]), groups: [0] } }), 'too_many_units');
  await fails(rpc(0, 'save_army', { p_code: code, p_army: { units: [[0, 5, 5, 0]], groups: [0] } }), 'invalid_army');
  await fails(rpc(0, 'save_army', { p_code: code, p_army: { units: [[0, 5, 5, 0, 7]], groups: [0] } }), 'invalid_army');
  await fails(rpc(0, 'save_army', { p_code: code, p_army: { units: [], groups: [], walls: [[z1.x + 5, 5, 1, 1]] } }), 'outside_zone');
  const mine = await st(0, code), theirs = await st(1, code);
  assert.equal(mine.myArmy.units.length, 5);
  assert.deepEqual(theirs.armies, [], 'other armies are not exposed during preparation');
  assert.equal(theirs.myArmy, null);
  assert.equal(theirs.players.find(p => p.id === U[0]).units, 5, 'only the unit COUNT is visible');
  assert.equal(JSON.stringify(theirs).includes('"units":[['), false);
});

test('prep lock: all ready locks early; end_prep (host); timer expiry; armies become visible', async () => {
  let { code, s } = await startedMatch(2, 'teams', [0, 1]);
  await rpc(0, 'save_army', { p_code: code, p_army: army(zoneOf(s, 0)) });
  await rpc(1, 'save_army', { p_code: code, p_army: army(zoneOf(s, 1)) });
  await rpc(0, 'set_ready', { p_code: code, p_ready: true });
  assert.equal((await st(1, code)).phase, 'prep');
  await rpc(1, 'set_ready', { p_code: code, p_ready: true });
  s = await st(0, code);
  assert.equal(s.phase, 'battle');
  assert.ok(s.match.startsInMs > 6000 && s.match.startsInMs <= 8000);
  assert.equal(s.armies.length, 2);
  assert.equal(s.match.seed > 0, true);
  await fails(rpc(0, 'save_army', { p_code: code, p_army: army(zoneOf(s, 0)) }), 'not_prep_phase');

  ({ code, s } = await startedMatch(2, 'teams', [0, 1]));
  await rpc(0, 'save_army', { p_code: code, p_army: army(zoneOf(s, 0)) });
  await rpc(1, 'save_army', { p_code: code, p_army: army(zoneOf(s, 1)) });
  await fails(rpc(1, 'end_prep', { p_code: code }), 'not_host');
  await rpc(0, 'end_prep', { p_code: code });
  assert.equal((await st(1, code)).phase, 'battle');

  ({ code, s } = await startedMatch(2, 'teams', [0, 1], 60));
  await rpc(0, 'save_army', { p_code: code, p_army: army(zoneOf(s, 0)) });
  await rpc(1, 'save_army', { p_code: code, p_army: army(zoneOf(s, 1)) });
  assert.ok(s.match.prepRemainingMs > 55000 && s.match.prepRemainingMs <= 60000);
  const rem = (await Promise.all([0, 1].map(i => st(i, code)))).map(x => x.match.prepRemainingMs);
  assert.ok(Math.abs(rem[0] - rem[1]) < 1500, 'same server countdown for everyone');
  await admin(`update matches set prep_ends_at = now() - interval '5 seconds' where phase='prep'`);
  assert.equal((await st(0, code)).phase, 'battle');

  ({ code, s } = await startedMatch(2, 'teams', [0, 1], 0));
  await admin(`update matches set prep_started_at = now() - interval '5 hours' where phase='prep'`);
  assert.equal((await st(0, code)).match.prepRemainingMs, null, 'unlimited has no timer');
  assert.equal((await st(0, code)).phase, 'prep');
});

test('nothing to fight: fewer than two armies -> match ends, no fake battle', async () => {
  const { code, s } = await startedMatch(2, 'teams', [0, 1]);
  await rpc(0, 'save_army', { p_code: code, p_army: army(zoneOf(s, 0)) });
  await rpc(0, 'end_prep', { p_code: code });
  const r = await st(0, code);
  assert.equal(r.phase, 'results');
  assert.equal(r.match.outcome, 'abandoned');
});

async function toBattle(n, mode, teams) {
  const { code, s } = await startedMatch(n, mode, teams);
  for (let i = 0; i < n; i++) await rpc(i, 'save_army', { p_code: code, p_army: army(zoneOf(s, i)) });
  await rpc(0, 'end_prep', { p_code: code });
  await admin(`update matches set battle_start_at = now() - interval '2 seconds' where phase='battle'`);
  return { code, s: await st(0, code) };
}

test('battle clock + host pause/resume', async () => {
  const { code } = await toBattle(2, 'teams', [0, 1]);
  let s = await st(0, code);
  assert.ok(s.match.elapsedMs >= 1900 && s.match.elapsedMs < 4000);
  await fails(rpc(1, 'battle_control', { p_code: code, p_action: 'pause' }), 'not_host');
  await rpc(0, 'battle_control', { p_code: code, p_action: 'pause' });
  const a = (await st(1, code)).match;
  assert.equal(a.paused, true);
  await sleep(400);
  const b = (await st(1, code)).match;
  assert.equal(b.elapsedMs, a.elapsedMs, 'clock frozen while paused');
  await rpc(0, 'battle_control', { p_code: code, p_action: 'resume' });
  await sleep(300);
  const c = (await st(1, code)).match;
  assert.equal(c.paused, false);
  assert.ok(c.elapsedMs > b.elapsedMs && c.elapsedMs < b.elapsedMs + 1500, 'paused time is not counted');
  await fails(rpc(0, 'battle_control', { p_code: code, p_action: 'nope' }), 'invalid_action');
});

test('results are only accepted when a majority agrees (2v2): win, and no single-client result', async () => {
  const { code } = await toBattle(4, 'teams', [0, 0, 1, 1]);
  const rep = (i, w, tick = 600, hash = 'abcd1234') => rpc(i, 'report_result', { p_code: code, p_winner: w, p_tick: tick, p_hash: hash, p_stats: { left: 3 } });
  await rep(0, 20);
  await rep(1, 20);
  assert.equal((await st(2, code)).phase, 'battle', '2 of 4 is not a majority');
  await rep(2, 20);
  const s = await st(3, code);
  assert.equal(s.phase, 'results');
  assert.equal(s.match.outcome, 'win');
  assert.equal(s.match.result.winner, 20);
  assert.equal(s.history[0].winner, 'Ann, Ben');
  await fails(rep(3, 20), 'not_battle_phase');
});

test('1v1: a lone (possibly dishonest) report cannot decide the match; disagreement is reported as disputed', async () => {
  const { code } = await toBattle(2, 'teams', [0, 1]);
  await rpc(0, 'report_result', { p_code: code, p_winner: 20, p_tick: 500, p_hash: 'aaaa1111', p_stats: null });
  assert.equal((await st(1, code)).phase, 'battle');
  await rpc(1, 'report_result', { p_code: code, p_winner: 21, p_tick: 500, p_hash: 'bbbb2222', p_stats: null });
  let s = await st(0, code);
  assert.equal(s.phase, 'results');
  assert.equal(s.match.outcome, 'disputed');
  await fails(rpc(1, 'confirm_result', { p_code: code, p_winner: 21 }), 'not_host');
  await rpc(0, 'confirm_result', { p_code: code, p_winner: 20 });
  s = await st(1, code);
  assert.equal(s.match.outcome, 'win');
  assert.equal(s.match.result.confirmedByHost, true);
});

test('report validation: winner must be a participant, tick plausible, outsiders rejected', async () => {
  const { code } = await toBattle(2, 'teams', [0, 1]);
  const rep = (i, w, tick, hash = 'abcd1234') => rpc(i, 'report_result', { p_code: code, p_winner: w, p_tick: tick, p_hash: hash, p_stats: null });
  await fails(rep(0, 22, 500), 'invalid_report');
  await fails(rep(0, 20, 99999999), 'invalid_report');
  await fails(rep(0, 20, 500, 'x'), 'invalid_report');
  await fails(rep(5, 20, 500), 'not_in_room');
  await rep(0, -1, 500);   // draw is allowed
});

test('free-for-all 4 players + draw outcome', async () => {
  const { code } = await toBattle(4, 'ffa');
  for (const i of [0, 1, 2]) await rpc(i, 'report_result', { p_code: code, p_winner: -1, p_tick: 900, p_hash: 'dddd0000', p_stats: null });
  const s = await st(3, code);
  assert.equal(s.match.outcome, 'draw');
});

test('rematch / back to lobby / host transfer / kick / leave mid-prep', async () => {
  let { code } = await toBattle(2, 'teams', [0, 1]);
  for (const i of [0, 1]) await rpc(i, 'report_result', { p_code: code, p_winner: 21, p_tick: 700, p_hash: 'eeee1111', p_stats: null });
  assert.equal((await st(0, code)).phase, 'results');
  await rpc(1, 'set_ready', { p_code: code, p_ready: true });
  await fails(rpc(1, 'start_match', { p_code: code }), 'not_host');
  await rpc(0, 'start_match', { p_code: code });
  const s = await st(0, code);
  assert.equal(s.phase, 'prep');
  assert.equal(s.match.number, 2);
  await rpc(0, 'back_to_lobby', { p_code: code });
  assert.equal((await st(1, code)).phase, 'lobby');

  code = await room(3);
  await admin(`update players set last_seen = now() - interval '40 seconds' where user_id = '${U[0]}'`);
  assert.equal((await st(1, code)).room.hostId, U[1], 'host offline -> transferred');
  await rpc(1, 'kick_player', { p_code: code, p_target: U[2] });
  await fails(st(2, code), 'kicked');

  const started = await startedMatch(2, 'teams', [0, 1]);
  await rpc(1, 'leave_room', { p_code: started.code });
  const r = await st(0, started.code);
  assert.equal(r.phase, 'results');
  assert.equal(r.match.outcome, 'abandoned');
});

test('chat: sanitised, limited, members only', async () => {
  const code = await room(2);
  await rpc(0, 'send_chat', { p_code: code, p_text: '<img src=x onerror=alert(1)>hello' });
  await rpc(0, 'send_chat', { p_code: code, p_text: 'x'.repeat(500) });
  const s = await st(1, code);
  assert.equal(s.chat[0].text.includes('<'), false);
  assert.equal(s.chat[1].text.length, 200);
  await fails(rpc(0, 'send_chat', { p_code: code, p_text: '  ' }), 'empty_message');
  for (let i = 0; i < 3; i++) await rpc(0, 'send_chat', { p_code: code, p_text: 'm' + i });
  await fails(rpc(0, 'send_chat', { p_code: code, p_text: 'spam' }), 'rate_limited');
  await fails(rpc(4, 'send_chat', { p_code: code, p_text: 'outsider' }), 'not_in_room');
});

test('security: no table access, no internal functions, outsiders blocked, pulse only for members', async () => {
  const code = await room(2);
  for (const t of ['rooms', 'players', 'matches', 'match_players', 'armies', 'reports', 'chat_messages']) {
    await assert.rejects(be.db.transaction(async tx => { await tx.exec('set local role authenticated'); await tx.query(`select * from public.${t}`); }), /permission denied/, t);
    await assert.rejects(be.db.transaction(async tx => { await tx.exec('set local role authenticated'); await tx.query(`delete from public.${t}`); }), /permission denied/, t);
  }
  await assert.rejects(be.db.transaction(async tx => { await tx.exec('set local role anon'); await tx.query(`select public.get_state('${code}')`); }), /permission denied/);
  await fails(rpc(0, '_tick', { p_room: crypto.randomUUID() }), 'Not found');
  await assert.rejects(be.db.transaction(async tx => { await tx.exec('set local role authenticated'); await tx.query(`select public._lock_prep('${crypto.randomUUID()}')`); }), /permission denied/);
  await fails(rpc(3, 'set_ready', { p_code: code, p_ready: true }), 'not_in_room');
  await fails(rpc(3, 'save_army', { p_code: code, p_army: { units: [], groups: [] } }), 'not_in_room');
  const none = await be.db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [crypto.randomUUID()]);
    await tx.exec('set local role authenticated');
    return (await tx.query(`select * from public.room_pulse`)).rows.length;
  });
  assert.equal(none, 0);
});

test('get_state can skip the (large, immutable) armies payload', async () => {
  const { code, s } = await startedMatch(2, 'teams', [0, 1]);
  await rpc(0, 'save_army', { p_code: code, p_army: army(zoneOf(s, 0)) });
  await rpc(1, 'save_army', { p_code: code, p_army: army(zoneOf(s, 1)) });
  await rpc(0, 'end_prep', { p_code: code });
  const full = await rpc(1, 'get_state', { p_code: code, p_client: 'c1' });
  const lean = await rpc(1, 'get_state', { p_code: code, p_client: 'c1', p_armies: false });
  assert.equal(full.armies.length, 2);
  assert.deepEqual(lean.armies, []);
  assert.ok(JSON.stringify(lean).length < JSON.stringify(full).length);
});
