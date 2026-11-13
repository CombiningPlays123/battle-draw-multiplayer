-- =====================================================================
-- Battle Draw Multiplayer - schema, row level security, server logic
-- Run once in the Supabase SQL editor (safe to re-run).
--
-- Model: every player draws their OWN army in their OWN copy of the original game. Nothing about the
-- canvases is synchronised. The server only holds: room/team/ready state, each player's finished army
-- data (hidden from everyone else until preparation is locked), the synchronised battle clock + seed,
-- and the results each client observed from the original simulation.
--
-- Security: RLS is enabled on every table with NO client policies (except room_pulse). All access goes
-- through SECURITY DEFINER functions that derive the caller from auth.uid(). A player can only write
-- their own army, only during preparation, only inside their own zone; host-only actions check the
-- host id; results are never trusted from a single client.
-- =====================================================================

create table if not exists public.rooms (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  host_id          uuid not null,
  mode             text not null default 'teams' check (mode in ('ffa','teams')),
  prep_seconds     int  default 180 check (prep_seconds is null or prep_seconds in (60,180,300,600)),  -- null = unlimited
  current_match_id uuid,
  match_counter    int  not null default 0,
  created_at       timestamptz not null default now(),
  last_activity    timestamptz not null default now()
);

create table if not exists public.players (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null,
  name      text not null,
  client_id text,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  status    text not null default 'active' check (status in ('active','left','kicked')),
  team      int  not null default 0 check (team in (0,1)),
  ready     boolean not null default false,
  primary key (room_id, user_id)
);
create index if not exists players_user_idx on public.players(user_id);

create table if not exists public.matches (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms(id) on delete cascade,
  number          int  not null,
  mode            text not null,
  prep_seconds    int,
  phase           text not null default 'prep' check (phase in ('prep','battle','finished')),
  seed            int  not null,
  prep_started_at timestamptz not null default now(),
  prep_ends_at    timestamptz,
  battle_start_at timestamptz,
  paused          boolean not null default false,
  paused_at       timestamptz,
  paused_total_ms bigint not null default 0,
  first_report_at timestamptz,
  outcome         text check (outcome in ('win','draw','disputed','abandoned')),
  result          jsonb,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists matches_room_idx on public.matches(room_id);

create table if not exists public.match_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id  uuid not null,
  name     text not null,
  team     int  not null,
  slot     int  not null,
  faction  int  not null,                   -- 20 + team (teams mode) or 20 + slot (free-for-all)
  zx real not null, zy real not null, zw real not null, zh real not null,
  ready    boolean not null default false,
  primary key (match_id, user_id)
);

create table if not exists public.armies (
  match_id   uuid not null references public.matches(id) on delete cascade,
  user_id    uuid not null,
  data       jsonb not null,
  units      int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

create table if not exists public.reports (
  match_id   uuid not null references public.matches(id) on delete cascade,
  user_id    uuid not null,
  winner     int  not null,                 -- winning faction (20..23) or -1 for a draw
  end_tick   int  not null,
  hash       text not null,
  stats      jsonb,
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null,
  name       text not null,
  text       text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_room_idx on public.chat_messages(room_id, id);

create table if not exists public.room_pulse (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  v       bigint not null default 0
);

-- balanced-competition rules (chosen by the host): troop cap, allowed categories
alter table public.rooms   add column if not exists balanced   boolean not null default false;
alter table public.rooms   add column if not exists max_units  int     not null default 1000;
alter table public.rooms   add column if not exists categories text[]  not null default array['army','creatures','mythical','terrain'];
alter table public.rooms   add column if not exists ban_mode   text    not null default 'none';
alter table public.rooms   add column if not exists banned     int[]   not null default '{}';
alter table public.players add column if not exists ban_votes  int[]   not null default '{}';
alter table public.matches add column if not exists banned     int[]   not null default '{}';
alter table public.matches add column if not exists balanced   boolean not null default false;
alter table public.matches add column if not exists max_units  int     not null default 1000;
alter table public.matches add column if not exists categories text[]  not null default array['army','creatures','mythical','terrain'];

alter table public.rooms         enable row level security;
alter table public.players       enable row level security;
alter table public.matches       enable row level security;
alter table public.match_players enable row level security;
alter table public.armies        enable row level security;
alter table public.reports       enable row level security;
alter table public.chat_messages enable row level security;
alter table public.room_pulse    enable row level security;

-- ---------------------------------------------------------- helpers
create or replace function public._uid() returns uuid language plpgsql stable as $$
declare v uuid := auth.uid();
begin if v is null then raise exception 'not_authenticated'; end if; return v; end $$;

create or replace function public._clean(t text, maxlen int) returns text language sql immutable as $$
  select left(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(t,''), '<[^>]*>', '', 'g'), '[[:cntrl:]<>]', '', 'g'), '\s+', ' ', 'g')), maxlen)
$$;

-- Armies are stored in NORMALISED map coordinates (0..1 of each player's own full-window map), so every player draws on
-- their whole map whatever their screen size. The battle itself runs on this fixed canonical field (simulation units),
-- scaled to fit each window, so all copies of the simulation are identical.
create or replace function public._field_w() returns real language sql immutable as $$ select 1280::real $$;
create or replace function public._field_h() returns real language sql immutable as $$ select 720::real $$;

create or replace function public._bump(p_room uuid) returns void language sql as $$
  insert into public.room_pulse(room_id, v) select id, 1 from public.rooms where id = p_room
  on conflict (room_id) do update set v = public.room_pulse.v + 1;
  update public.rooms set last_activity = now() where id = p_room;
$$;

create or replace function public._is_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.players p where p.room_id = p_room and p.user_id = auth.uid() and p.status = 'active')
$$;
drop policy if exists room_pulse_member_read on public.room_pulse;
create policy room_pulse_member_read on public.room_pulse for select to authenticated using (public._is_member(room_id));

-- allowed unit types = the unit tools of the original game (soldier, flamethrower, sniper, roman, grenadier,
-- archer, cavalry, ninja, boar, rat, ant, ape, alligator, piranha, snake, cheetah, zombie, slime, mage,
-- giant, dragon, necromancer, barrel, tree)
create or replace function public._unit_types() returns int[] language sql immutable as $$
  select array[0,3,4,5,6,7,18,50,1,29,32,37,41,43,47,52,2,8,23,27,44,48,17,31]
$$;

-- the original game's toolbar categories: army / creatures (shown as "Animals") / mythical / terrain
create or replace function public._unit_category(t int) returns text language sql immutable as $$
  select case when t = any(array[0,3,4,5,6,7,18,50]) then 'army'
              when t = any(array[1,29,32,37,41,43,47,52]) then 'creatures'
              when t = any(array[2,8,23,27,44,48]) then 'mythical'
              when t = any(array[17,31]) then 'terrain' end
$$;

-- troops banned in a balanced room: picked by the host ('host') or by a strict majority of the players' votes ('vote')
create or replace function public._effective_banned(p_room uuid) returns int[]
language plpgsql stable security definer set search_path = public as $$
declare r public.rooms%rowtype; n int; res int[];
begin
  select * into r from public.rooms where id = p_room;
  if not found or not r.balanced then return '{}'; end if;
  if r.ban_mode = 'host' then return r.banned; end if;
  if r.ban_mode = 'vote' then
    select count(*) into n from public.players where room_id = p_room and status = 'active';
    select coalesce(array_agg(t.u order by t.u), '{}') into res from (
      select x.u from (select unnest(p.ban_votes) u from public.players p where p.room_id = p_room and p.status = 'active') x
       group by x.u having count(*) > n / 2.0) t;
    return res;
  end if;
  return '{}';
end $$;

-- ------------------------------------------------------------ maintenance
create or replace function public._lock_prep(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.matches%rowtype; n_fac int;
begin
  select * into m from public.matches where id = p_match for update;
  if not found or m.phase <> 'prep' then return; end if;
  select count(distinct mp.faction) into n_fac from public.match_players mp join public.armies a using (match_id, user_id)
   where mp.match_id = p_match and a.units > 0;
  if n_fac < 2 then
    update public.matches set phase = 'finished', outcome = 'abandoned', finished_at = now(),
      result = jsonb_build_object('reason', 'Fewer than two sides had any units, so there was nothing to fight.') where id = p_match;
  else
    update public.matches set phase = 'battle', battle_start_at = now() + interval '8 seconds' where id = p_match;
  end if;
end $$;

create or replace function public._resolve(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.matches%rowtype; n_players int; n_reports int; need int; top record; tot int;
begin
  select * into m from public.matches where id = p_match for update;
  if not found or m.phase <> 'battle' then return; end if;
  select count(*) into n_players from public.match_players where match_id = p_match;
  select count(*) into n_reports from public.reports where match_id = p_match;
  if n_reports = 0 then return; end if;
  need := n_players / 2 + 1;
  select winner, end_tick, hash, count(*) c, (array_agg(stats))[1] st into top
    from public.reports where match_id = p_match group by winner, end_tick, hash order by count(*) desc limit 1;
  tot := n_reports;
  if top.c >= need or (n_reports = n_players and top.c = n_reports) then
    update public.matches set phase = 'finished', finished_at = now(),
      outcome = case when top.winner < 0 then 'draw' else 'win' end,
      result = jsonb_build_object('winner', top.winner, 'endTick', top.end_tick, 'hash', top.hash, 'stats', top.st,
                                  'agreed', top.c, 'players', n_players)
     where id = p_match;
  elsif n_reports = n_players
        or (m.first_report_at is not null and now() > m.first_report_at + interval '60 seconds') then
    update public.matches set phase = 'finished', finished_at = now(), outcome = 'disputed',
      result = jsonb_build_object('reports', (select coalesce(jsonb_agg(jsonb_build_object('name', mp.name, 'winner', r.winner,
                 'endTick', r.end_tick, 'hash', r.hash)), '[]'::jsonb) from public.reports r join public.match_players mp
                 on mp.match_id = r.match_id and mp.user_id = r.user_id where r.match_id = p_match),
               'reason', 'The players'' copies of the simulation reported different outcomes - the host must confirm the result.')
     where id = p_match;
  end if;
end $$;

create or replace function public._tick(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r public.rooms%rowtype; m public.matches%rowtype; v_new uuid; n_active int; n_online int; n_ready int; n_req int;
  v_changed boolean := false; busy boolean;
begin
  select * into r from public.rooms where id = p_room;
  if not found then return; end if;
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; end if;
  busy := m.id is not null and m.phase <> 'finished';

  update public.players set status = 'left'
   where room_id = p_room and status = 'active'
     and last_seen < now() - (case when busy then interval '10 minutes' else interval '2 minutes' end);
  if found then v_changed := true; end if;

  select count(*) into n_active from public.players where room_id = p_room and status = 'active';
  if n_active = 0 then delete from public.rooms where id = p_room; return; end if;

  if not exists (select 1 from public.players where room_id = p_room and user_id = r.host_id and status = 'active'
                   and last_seen >= now() - interval '30 seconds') then
    select user_id into v_new from public.players
     where room_id = p_room and status = 'active' and user_id <> r.host_id and last_seen >= now() - interval '25 seconds'
     order by joined_at limit 1;
    if v_new is null and not exists (select 1 from public.players where room_id = p_room and user_id = r.host_id and status = 'active') then
      select user_id into v_new from public.players where room_id = p_room and status = 'active' order by last_seen desc limit 1;
    end if;
    if v_new is not null then update public.rooms set host_id = v_new where id = p_room; v_changed := true; end if;
  end if;

  if m.id is not null and m.phase = 'prep' then
    select count(*) into n_online from public.match_players mp join public.players p on p.room_id = p_room and p.user_id = mp.user_id
     where mp.match_id = m.id and p.status = 'active' and p.last_seen >= now() - interval '25 seconds';
    if n_online < 2 then
      update public.matches set phase = 'finished', outcome = 'abandoned', finished_at = now(),
        result = jsonb_build_object('reason', 'Too few players stayed connected during preparation.') where id = m.id;
      v_changed := true;
    else
      select count(*) into n_ready from public.match_players mp join public.players p on p.room_id = p_room and p.user_id = mp.user_id
       where mp.match_id = m.id and mp.ready and p.status = 'active' and p.last_seen >= now() - interval '25 seconds';
      if (m.prep_ends_at is not null and now() >= m.prep_ends_at) or n_ready >= n_online then
        perform public._lock_prep(m.id); v_changed := true;
      end if;
    end if;
  elsif m.id is not null and m.phase = 'battle' then
    perform public._resolve(m.id);
    if (select phase from public.matches where id = m.id) <> 'battle' then v_changed := true; end if;
  end if;

  if v_changed then perform public._bump(p_room); end if;
end $$;

create or replace function public._cleanup_rooms() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.rooms r where r.last_activity < now() - interval '6 hours'
     or not exists (select 1 from public.players p where p.room_id = r.id and p.status = 'active' and p.last_seen > now() - interval '30 minutes');
  get diagnostics n = row_count; return n;
end $$;

create or replace function public._lock_room(p_code text) returns public.rooms
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype;
begin
  select * into r from public.rooms where code = upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g')) for update;
  if not found then raise exception 'room_not_found'; end if;
  return r;
end $$;

create or replace function public._enter(p_code text, p_client text default null) returns public.rooms
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; me public.players%rowtype; v uuid := public._uid();
begin
  r := public._lock_room(p_code);
  select * into me from public.players where room_id = r.id and user_id = v;
  if not found then raise exception 'not_in_room'; end if;
  if me.status = 'kicked' then raise exception 'kicked'; end if;
  if me.status <> 'active' then raise exception 'not_in_room'; end if;
  if p_client is not null and me.client_id is distinct from p_client then raise exception 'superseded'; end if;
  update public.players set last_seen = now() where room_id = r.id and user_id = v;
  perform public._tick(r.id);
  select * into r from public.rooms where id = r.id;
  if not found then raise exception 'room_not_found'; end if;
  return r;
end $$;

-- ------------------------------------------------------------ rooms & teams
create or replace function public.create_room(p_name text, p_client text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v uuid := public._uid(); v_name text := public._clean(p_name, 16); v_code text; v_room uuid;
        alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; tries int := 0; old record;
begin
  if length(v_name) < 1 then raise exception 'invalid_name'; end if;
  perform public._cleanup_rooms();
  loop
    v_code := '';
    for i in 1..5 loop v_code := v_code || substr(alphabet, 1 + floor(random()*length(alphabet))::int, 1); end loop;
    exit when not exists (select 1 from public.rooms where code = v_code);
    tries := tries + 1; if tries > 50 then raise exception 'try_again'; end if;
  end loop;
  insert into public.rooms(code, host_id) values (v_code, v) returning id into v_room;
  insert into public.players(room_id, user_id, name, client_id, team) values (v_room, v, v_name, p_client, 0);
  for old in select room_id from public.players where user_id = v and status = 'active' and room_id <> v_room loop
    update public.players set status = 'left' where room_id = old.room_id and user_id = v;
    perform public._tick(old.room_id);
  end loop;
  perform public._bump(v_room);
  return jsonb_build_object('code', v_code);
end $$;

create or replace function public.join_room(p_code text, p_name text, p_client text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v uuid := public._uid(); v_name text := public._clean(p_name, 16); r public.rooms%rowtype; me public.players%rowtype;
        m public.matches%rowtype; n int; v_try text; k int := 1; old record; t0 int; t1 int;
begin
  if length(v_name) < 1 then raise exception 'invalid_name'; end if;
  r := public._lock_room(p_code);
  perform public._tick(r.id);
  select * into r from public.rooms where id = r.id;
  if not found then raise exception 'room_not_found'; end if;
  select * into me from public.players where room_id = r.id and user_id = v;
  if found and me.status = 'kicked' then raise exception 'kicked'; end if;
  if found and me.status = 'active' then
    update public.players set client_id = p_client, last_seen = now() where room_id = r.id and user_id = v;
  else
    select count(*) into n from public.players where room_id = r.id and status = 'active';
    if n >= 4 then raise exception 'room_full'; end if;
    if r.current_match_id is not null then
      select * into m from public.matches where id = r.current_match_id;
      if m.phase <> 'finished' then raise exception 'game_in_progress'; end if;
    end if;
    v_try := v_name;
    while exists (select 1 from public.players where room_id = r.id and status = 'active' and lower(name) = lower(v_try)) loop
      k := k + 1; v_try := left(v_name, 14) || k::text;
    end loop;
    select count(*) filter (where team = 0), count(*) filter (where team = 1) into t0, t1
      from public.players where room_id = r.id and status = 'active';
    insert into public.players(room_id, user_id, name, client_id, team, ready) values (r.id, v, v_try, p_client, case when t0 <= t1 then 0 else 1 end, false)
      on conflict (room_id, user_id) do update set name = excluded.name, client_id = excluded.client_id, status = 'active',
        joined_at = now(), last_seen = now(), team = excluded.team, ready = false;
    for old in select room_id from public.players where user_id = v and status = 'active' and room_id <> r.id loop
      update public.players set status = 'left' where room_id = old.room_id and user_id = v;
      perform public._tick(old.room_id);
    end loop;
  end if;
  perform public._bump(r.id);
  return jsonb_build_object('code', r.code);
end $$;

create or replace function public.leave_room(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid();
begin
  r := public._lock_room(p_code);
  update public.players set status = 'left' where room_id = r.id and user_id = v and status = 'active';
  perform public._tick(r.id); perform public._bump(r.id);
  return jsonb_build_object('ok', true);
exception when others then
  if sqlerrm = 'room_not_found' then return jsonb_build_object('ok', true); end if;
  raise;
end $$;

create or replace function public.kick_player(p_code text, p_target uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid();
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  if p_target = v then raise exception 'cannot_kick_self'; end if;
  update public.players set status = 'kicked' where room_id = r.id and user_id = p_target and status = 'active';
  if not found then raise exception 'player_not_found'; end if;
  perform public._tick(r.id); perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

drop function if exists public.update_settings(text, text, int);
drop function if exists public.update_settings(text, text, int, boolean, int, text[]);
-- p_prep: 60,180,300,600 seconds or 0 = unlimited.  Balanced competition: p_balanced + troop cap + allowed categories
-- + optional troop bans (p_ban_mode 'none' | 'host' (host picks p_banned) | 'vote' (players vote in the lobby)).
create or replace function public.update_settings(p_code text, p_mode text, p_prep int, p_balanced boolean default false, p_max_units int default 1000,
                                                  p_categories text[] default null, p_ban_mode text default 'none', p_banned int[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype; cats text[]; bn int[] := '{}'; ok boolean := false; t int; bal boolean := coalesce(p_balanced, false);
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; if m.phase <> 'finished' then raise exception 'game_in_progress'; end if; end if;
  if p_mode not in ('ffa','teams') then raise exception 'invalid_mode'; end if;
  if p_prep not in (0,60,180,300,600) then raise exception 'invalid_timer'; end if;
  if p_max_units is null or p_max_units < 1 or p_max_units > 1000 then raise exception 'invalid_rules'; end if;   -- 1000 = unlimited (technical maximum)
  if coalesce(p_ban_mode, 'none') not in ('none','host','vote') then raise exception 'invalid_rules'; end if;
  cats := coalesce(p_categories, array['army','creatures','mythical','terrain']);
  if coalesce(array_length(cats, 1), 0) = 0 or not (cats <@ array['army','creatures','mythical','terrain']) then raise exception 'invalid_rules'; end if;
  if bal and coalesce(p_ban_mode, 'none') = 'host' then
    bn := coalesce(p_banned, '{}');
    if array_length(bn, 1) > 20 or not (bn <@ public._unit_types()) then raise exception 'invalid_rules'; end if;
  end if;
  if bal then   -- at least one troop must remain placeable
    foreach t in array public._unit_types() loop
      if public._unit_category(t) = any(cats) and not (t = any(bn)) then ok := true; end if;
    end loop;
    if not ok then raise exception 'invalid_rules'; end if;
  end if;
  update public.rooms set mode = p_mode, prep_seconds = nullif(p_prep, 0), balanced = bal,
         max_units = case when bal then p_max_units else 1000 end,
         categories = case when bal then cats else array['army','creatures','mythical','terrain'] end,
         ban_mode = case when bal then coalesce(p_ban_mode, 'none') else 'none' end,
         banned = case when bal and coalesce(p_ban_mode, 'none') = 'host' then (select coalesce(array_agg(distinct x order by x), '{}') from unnest(bn) x) else '{}' end
   where id = r.id;
  if not (bal and coalesce(p_ban_mode, 'none') = 'vote') then update public.players set ban_votes = '{}' where room_id = r.id; end if;
  update public.players set ready = false where room_id = r.id and user_id <> r.host_id;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- each player may vote to ban up to 2 troops; a troop is banned when a strict majority of the players voted for it
create or replace function public.vote_ban(p_code text, p_units int[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype; u int[] := coalesce(p_units, '{}'); t int;
begin
  r := public._enter(p_code);
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; if m.phase <> 'finished' then raise exception 'game_in_progress'; end if; end if;
  if not r.balanced or r.ban_mode <> 'vote' then raise exception 'voting_off'; end if;
  if array_length(u, 1) > 2 or not (u <@ public._unit_types()) then raise exception 'invalid_vote'; end if;
  foreach t in array u loop if not (public._unit_category(t) = any(r.categories)) then raise exception 'invalid_vote'; end if; end loop;
  update public.players set ban_votes = (select coalesce(array_agg(distinct x), '{}') from unnest(u) x) where room_id = r.id and user_id = v;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- host assigns a player to team 0 (Red) or 1 (Blue). Any arrangement with 1..3 per side is allowed.
create or replace function public.set_team(p_code text, p_target uuid, p_team int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype; n_side int;
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  if p_team not in (0,1) then raise exception 'invalid_team'; end if;
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; if m.phase <> 'finished' then raise exception 'game_in_progress'; end if; end if;
  select count(*) into n_side from public.players where room_id = r.id and status = 'active' and team = p_team and user_id <> p_target;
  if n_side >= 3 then raise exception 'team_full'; end if;
  update public.players set team = p_team, ready = false where room_id = r.id and user_id = p_target and status = 'active';
  if not found then raise exception 'player_not_found'; end if;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- lobby: confirm readiness. preparation: "my army is finished".
create or replace function public.set_ready(p_code text, p_ready boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype;
begin
  r := public._enter(p_code);
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; end if;
  if m.id is not null and m.phase = 'prep' then
    update public.match_players set ready = p_ready where match_id = m.id and user_id = v;
    if not found then raise exception 'not_in_match'; end if;
    perform public._tick(r.id);
  elsif m.id is not null and m.phase = 'battle' then raise exception 'game_in_progress';
  else
    update public.players set ready = p_ready where room_id = r.id and user_id = v;
  end if;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------ match flow
create or replace function public.start_match(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype; v_id uuid; n int; n0 int; n1 int;
  pl record; i int := 0; sz int; idx int; fw real := public._field_w(); fh real := public._field_h();
  zx real; zy real; zw real; zh real; fac int;
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; if m.phase <> 'finished' then raise exception 'game_in_progress'; end if; end if;
  select count(*), count(*) filter (where team = 0), count(*) filter (where team = 1) into n, n0, n1
    from public.players where room_id = r.id and status = 'active' and last_seen >= now() - interval '25 seconds';
  if n < 2 then raise exception 'need_players'; end if;
  if (select count(*) from public.players where room_id = r.id and status = 'active') > n then raise exception 'players_offline'; end if;
  if r.mode = 'teams' and (n0 < 1 or n1 < 1) then raise exception 'need_both_teams'; end if;
  if exists (select 1 from public.players where room_id = r.id and status = 'active' and not ready and user_id <> r.host_id) then raise exception 'not_all_ready'; end if;

  insert into public.matches(room_id, number, mode, prep_seconds, balanced, max_units, categories, banned, seed, prep_ends_at)
    values (r.id, r.match_counter + 1, r.mode, r.prep_seconds, r.balanced, r.max_units, r.categories, public._effective_banned(r.id), (floor(random() * 2147483000))::int + 1,
            case when r.prep_seconds is null then null else now() + make_interval(secs => r.prep_seconds) end)
    returning id into v_id;

  for pl in select user_id, name, team from public.players where room_id = r.id and status = 'active' order by joined_at, user_id loop
    if r.mode = 'ffa' then
      fac := 20 + i;
      if n = 2 then zx := i * 0.5; zy := 0; zw := 0.5; zh := 1;
      elsif n = 3 then zx := i / 3.0; zy := 0; zw := 1 / 3.0; zh := 1;
      else zx := (i % 2) * 0.5; zy := (i / 2) * 0.5; zw := 0.5; zh := 0.5; end if;
    else
      -- the original Team battle layout: red = left half, blue = right half of the WHOLE map (teammates share their half)
      fac := 20 + pl.team;
      zx := pl.team * 0.5; zy := 0; zw := 0.5; zh := 1;
    end if;
    insert into public.match_players(match_id, user_id, name, team, slot, faction, zx, zy, zw, zh)
      values (v_id, pl.user_id, pl.name, pl.team, i, fac, zx, zy, zw, zh);
    i := i + 1;
  end loop;
  update public.rooms set current_match_id = v_id, match_counter = match_counter + 1 where id = r.id;
  update public.players set ready = false where room_id = r.id;
  perform public._bump(r.id);
  return jsonb_build_object('match', v_id);
end $$;

create or replace function public.back_to_lobby(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype;
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  if r.current_match_id is not null then
    select * into m from public.matches where id = r.current_match_id;
    if m.phase <> 'finished' then
      update public.matches set phase = 'finished', outcome = 'abandoned', finished_at = now(),
        result = jsonb_build_object('reason', 'The host ended the match.') where id = m.id;
    end if;
  end if;
  update public.rooms set current_match_id = null where id = r.id;
  update public.players set ready = false where room_id = r.id;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- A player's finished army (their own drawing, exported by the client from the original game).
-- Shape (x,y,w,h are fractions 0..1 of the whole map): {"units": [[type,x,y,heading,group], ...], "groups": [type, ...], "walls": [[x,y,w,h],...], "mines": [[x,y],...]}
create or replace function public.save_army(p_code text, p_army jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype; mp public.match_players%rowtype;
  u jsonb; n int := 0; ng int; t int; x real; y real; el jsonb; cnt int;
begin
  r := public._enter(p_code);
  select * into m from public.matches where id = r.current_match_id;
  if not found or m.phase <> 'prep' then raise exception 'not_prep_phase'; end if;
  if m.prep_ends_at is not null and now() > m.prep_ends_at + interval '3 seconds' then raise exception 'prep_over'; end if;
  select * into mp from public.match_players where match_id = m.id and user_id = v;
  if not found then raise exception 'not_in_match'; end if;
  if jsonb_typeof(p_army) <> 'object' or length(p_army::text) > 400000 then raise exception 'invalid_army'; end if;
  if jsonb_typeof(coalesce(p_army->'units', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_army->'groups', '[]'::jsonb)) <> 'array' then raise exception 'invalid_army'; end if;
  cnt := jsonb_array_length(coalesce(p_army->'units', '[]'::jsonb));
  if cnt > 1000 then raise exception 'too_many_units'; end if;
  if cnt > m.max_units then raise exception 'over_unit_limit'; end if;
  if m.balanced and not ('terrain' = any(m.categories)) and (jsonb_array_length(coalesce(p_army->'walls', '[]'::jsonb)) > 0 or jsonb_array_length(coalesce(p_army->'mines', '[]'::jsonb)) > 0) then raise exception 'category_not_allowed'; end if;
  if m.balanced and (jsonb_array_length(coalesce(p_army->'walls', '[]'::jsonb)) > 600 or jsonb_array_length(coalesce(p_army->'mines', '[]'::jsonb)) > 30) then raise exception 'over_unit_limit'; end if;
  ng := jsonb_array_length(coalesce(p_army->'groups', '[]'::jsonb));
  if ng > 1000 then raise exception 'too_many_units'; end if;
  for u in select * from jsonb_array_elements(coalesce(p_army->'units', '[]'::jsonb)) loop
    if jsonb_typeof(u) <> 'array' or jsonb_array_length(u) <> 5 then raise exception 'invalid_army'; end if;
    if jsonb_typeof(u->0) <> 'number' or jsonb_typeof(u->1) <> 'number' or jsonb_typeof(u->2) <> 'number'
       or jsonb_typeof(u->3) <> 'number' or jsonb_typeof(u->4) <> 'number' then raise exception 'invalid_army'; end if;
    t := (u->>0)::int; x := (u->>1)::real; y := (u->>2)::real;
    if not (t = any(public._unit_types())) then raise exception 'invalid_unit'; end if;
    if not (public._unit_category(t) = any(m.categories)) then raise exception 'category_not_allowed'; end if;
    if t = any(m.banned) then raise exception 'unit_banned'; end if;
    if x < mp.zx - 0.003 or x > mp.zx + mp.zw + 0.003 or y < mp.zy - 0.003 or y > mp.zy + mp.zh + 0.003 then raise exception 'outside_zone'; end if;
    if (u->>4)::int < -1 or (u->>4)::int >= greatest(ng, 1) then raise exception 'invalid_army'; end if;
  end loop;
  for el in select * from jsonb_array_elements(coalesce(p_army->'groups', '[]'::jsonb)) loop
    if jsonb_typeof(el) <> 'number' or not ((el#>>'{}')::int = any(public._unit_types())) then raise exception 'invalid_unit'; end if;
  end loop;
  for el in select * from jsonb_array_elements(coalesce(p_army->'walls', '[]'::jsonb)) loop
    if jsonb_typeof(el) <> 'array' or jsonb_array_length(el) <> 4 then raise exception 'invalid_army'; end if;
    if (el->>0)::real < mp.zx - 0.003 or (el->>0)::real > mp.zx + mp.zw + 0.003 or (el->>1)::real < mp.zy - 0.003 or (el->>1)::real > mp.zy + mp.zh + 0.003 then raise exception 'outside_zone'; end if;
  end loop;
  for el in select * from jsonb_array_elements(coalesce(p_army->'mines', '[]'::jsonb)) loop
    if jsonb_typeof(el) <> 'array' or jsonb_array_length(el) <> 2 then raise exception 'invalid_army'; end if;
    if (el->>0)::real < mp.zx - 0.003 or (el->>0)::real > mp.zx + mp.zw + 0.003 or (el->>1)::real < mp.zy - 0.003 or (el->>1)::real > mp.zy + mp.zh + 0.003 then raise exception 'outside_zone'; end if;
  end loop;
  insert into public.armies(match_id, user_id, data, units) values (m.id, v, p_army, cnt)
    on conflict (match_id, user_id) do update set data = excluded.data, units = excluded.units, updated_at = now();
  perform public._bump(r.id);
  return jsonb_build_object('units', cnt);
end $$;

create or replace function public.end_prep(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype;
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  select * into m from public.matches where id = r.current_match_id;
  if not found or m.phase <> 'prep' then raise exception 'not_prep_phase'; end if;
  perform public._lock_prep(m.id);
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.battle_control(p_code text, p_action text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype;
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  select * into m from public.matches where id = r.current_match_id for update;
  if not found or m.phase <> 'battle' then raise exception 'not_battle_phase'; end if;
  if now() < m.battle_start_at then raise exception 'battle_not_started'; end if;
  if p_action = 'pause' and not m.paused then
    update public.matches set paused = true, paused_at = now() where id = m.id;
  elsif p_action = 'resume' and m.paused then
    update public.matches set paused = false, paused_total_ms = paused_total_ms + floor(extract(epoch from (now() - paused_at)) * 1000)::bigint, paused_at = null where id = m.id;
  elsif p_action not in ('pause','resume') then raise exception 'invalid_action';
  end if;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- Each client runs the original simulation locally from the identical armies + seed and reports what it saw.
-- The result is only accepted when a majority of players report the same winner, end tick and state hash.
create or replace function public.report_result(p_code text, p_winner int, p_tick int, p_hash text, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype; elapsed_ms bigint;
begin
  r := public._enter(p_code);
  select * into m from public.matches where id = r.current_match_id;
  if not found or m.phase <> 'battle' then raise exception 'not_battle_phase'; end if;
  if not exists (select 1 from public.match_players where match_id = m.id and user_id = v) then raise exception 'not_in_match'; end if;
  if now() < m.battle_start_at then raise exception 'battle_not_started'; end if;
  if p_winner <> -1 and not exists (select 1 from public.match_players where match_id = m.id and faction = p_winner) then raise exception 'invalid_report'; end if;
  elapsed_ms := floor(extract(epoch from ((case when m.paused then m.paused_at else now() end) - m.battle_start_at)) * 1000)::bigint - m.paused_total_ms;
  if p_tick < 1 or p_tick > (elapsed_ms * 60 / 1000) + 900 then raise exception 'invalid_report'; end if;
  if length(coalesce(p_hash,'')) < 4 or length(p_hash) > 64 then raise exception 'invalid_report'; end if;
  if p_stats is not null and length(p_stats::text) > 4000 then raise exception 'invalid_report'; end if;
  insert into public.reports(match_id, user_id, winner, end_tick, hash, stats) values (m.id, v, p_winner, p_tick, p_hash, p_stats)
    on conflict (match_id, user_id) do update set winner = excluded.winner, end_tick = excluded.end_tick, hash = excluded.hash, stats = excluded.stats, created_at = now();
  update public.matches set first_report_at = coalesce(first_report_at, now()) where id = m.id;
  perform public._resolve(m.id);
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- Host settles a disputed result by hand.
create or replace function public.confirm_result(p_code text, p_winner int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); m public.matches%rowtype;
begin
  r := public._enter(p_code);
  if r.host_id <> v then raise exception 'not_host'; end if;
  select * into m from public.matches where id = r.current_match_id;
  if not found or m.phase <> 'finished' or m.outcome <> 'disputed' then raise exception 'nothing_to_confirm'; end if;
  if p_winner <> -1 and not exists (select 1 from public.match_players where match_id = m.id and faction = p_winner) then raise exception 'invalid_report'; end if;
  update public.matches set outcome = case when p_winner < 0 then 'draw' else 'win' end,
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object('winner', p_winner, 'confirmedByHost', true) where id = m.id;
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.send_chat(p_code text, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.rooms%rowtype; v uuid := public._uid(); t text := public._clean(p_text, 200); nm text;
begin
  r := public._enter(p_code);
  if length(t) = 0 then raise exception 'empty_message'; end if;
  if (select count(*) from public.chat_messages where room_id = r.id and user_id = v and created_at > now() - interval '10 seconds') >= 5 then raise exception 'rate_limited'; end if;
  select name into nm from public.players where room_id = r.id and user_id = v;
  insert into public.chat_messages(room_id, user_id, name, text) values (r.id, v, nm, t);
  delete from public.chat_messages where room_id = r.id and id <= (select max(id) - 200 from public.chat_messages where room_id = r.id);
  perform public._bump(r.id);
  return jsonb_build_object('ok', true);
end $$;

-- Single read endpoint (also the heartbeat). Other players' armies stay hidden until the battle starts.
drop function if exists public.get_state(text, text);
create or replace function public.get_state(p_code text, p_client text default null, p_armies boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v uuid := public._uid(); r public.rooms%rowtype; me public.players%rowtype; m public.matches%rowtype;
  v_phase text; v_players jsonb; v_chat jsonb; v_match jsonb; v_armies jsonb := '[]'::jsonb; v_my jsonb; v_hist jsonb;
  v_prep_rem int; v_starts int; v_elapsed bigint;
begin
  select * into r from public.rooms where code = upper(regexp_replace(coalesce(p_code,''), '[^A-Za-z0-9]', '', 'g'));
  if not found then raise exception 'room_not_found'; end if;
  select * into me from public.players where room_id = r.id and user_id = v;
  if not found or me.status = 'left' then raise exception 'not_in_room'; end if;
  if me.status = 'kicked' then raise exception 'kicked'; end if;
  if p_client is not null and me.client_id is distinct from p_client then return jsonb_build_object('superseded', true); end if;
  update public.players set last_seen = now() where room_id = r.id and user_id = v;
  perform 1 from public.rooms where id = r.id for update skip locked;
  if found then perform public._tick(r.id); end if;
  select * into r from public.rooms where id = r.id;
  if not found then raise exception 'room_not_found'; end if;
  if r.current_match_id is not null then select * into m from public.matches where id = r.current_match_id; end if;
  v_phase := case when m.id is null then 'lobby' when m.phase = 'finished' then 'results' else m.phase end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.user_id, 'name', p.name, 'host', p.user_id = r.host_id, 'team', p.team, 'ready', case when v_phase in ('prep') then coalesce((select mp.ready from public.match_players mp where mp.match_id = m.id and mp.user_id = p.user_id), false) else p.ready end,
      'online', p.last_seen >= now() - interval '25 seconds',
      'units', coalesce((select a.units from public.armies a where a.match_id = m.id and a.user_id = p.user_id), 0),
      'inMatch', exists (select 1 from public.match_players mp where mp.match_id = m.id and mp.user_id = p.user_id),
      'reported', exists (select 1 from public.reports rp where rp.match_id = m.id and rp.user_id = p.user_id)
    ) order by p.joined_at, p.user_id), '[]'::jsonb) into v_players from public.players p where p.room_id = r.id and p.status = 'active';

  if m.id is not null then
    if m.phase = 'prep' then v_prep_rem := case when m.prep_ends_at is null then null else greatest(0, floor(extract(epoch from (m.prep_ends_at - clock_timestamp())) * 1000))::int end; end if;
    if m.phase = 'battle' then
      v_starts := greatest(0, floor(extract(epoch from (m.battle_start_at - clock_timestamp())) * 1000))::int;
      v_elapsed := greatest(0, floor(extract(epoch from ((case when m.paused then m.paused_at else clock_timestamp() end) - m.battle_start_at)) * 1000)::bigint - m.paused_total_ms);
    end if;
    if p_armies and m.phase in ('battle','finished') then
      select coalesce(jsonb_agg(jsonb_build_object('user', a.user_id, 'faction', mp.faction, 'data', a.data) order by mp.slot), '[]'::jsonb) into v_armies
        from public.armies a join public.match_players mp on mp.match_id = a.match_id and mp.user_id = a.user_id where a.match_id = m.id;
    end if;
    select data into v_my from public.armies where match_id = m.id and user_id = v;
    v_match := jsonb_build_object(
      'id', m.id, 'number', m.number, 'phase', m.phase, 'mode', m.mode, 'prepSeconds', m.prep_seconds, 'seed', m.seed,
      'rules', jsonb_build_object('balanced', m.balanced, 'maxUnits', m.max_units, 'categories', m.categories, 'banned', m.banned),
      'prepRemainingMs', v_prep_rem, 'startsInMs', v_starts, 'elapsedMs', v_elapsed, 'paused', m.paused,
      'outcome', m.outcome, 'result', m.result,
      'field', jsonb_build_object('w', public._field_w(), 'h', public._field_h()),
      'zones', (select coalesce(jsonb_agg(jsonb_build_object('user', mp.user_id, 'name', mp.name, 'team', mp.team, 'slot', mp.slot, 'faction', mp.faction,
                 'x', mp.zx, 'y', mp.zy, 'w', mp.zw, 'h', mp.zh) order by mp.slot), '[]'::jsonb) from public.match_players mp where mp.match_id = m.id),
      'reports', (select count(*) from public.reports where match_id = m.id));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('number', h.number, 'mode', h.mode, 'outcome', h.outcome, 'durationSec', round(coalesce((h.result->>'endTick')::numeric, 0) / 60, 1),
           'winner', (select string_agg(mp.name, ', ' order by mp.slot) from public.match_players mp where mp.match_id = h.id and mp.faction = (h.result->>'winner')::int),
           'players', (select string_agg(mp.name, ', ' order by mp.slot) from public.match_players mp where mp.match_id = h.id)) order by h.number desc), '[]'::jsonb)
    into v_hist from (select * from public.matches where room_id = r.id and phase = 'finished' order by number desc limit 8) h;

  select coalesce(jsonb_agg(c order by c.id), '[]'::jsonb) into v_chat from (
    select cm.id, cm.user_id as "userId", cm.name, cm.text, cm.created_at as "at" from public.chat_messages cm where cm.room_id = r.id order by cm.id desc limit 60) c;

  return jsonb_build_object('serverNow', now(), 'me', v,
    'room', jsonb_build_object('id', r.id, 'code', r.code, 'hostId', r.host_id, 'mode', r.mode, 'prepSeconds', r.prep_seconds,
                               'rules', jsonb_build_object('balanced', r.balanced, 'maxUnits', r.max_units, 'categories', r.categories, 'banMode', r.ban_mode,
                                          'banned', public._effective_banned(r.id), 'hostBanned', r.banned,
                                          'votes', (select coalesce(jsonb_object_agg(x.u::text, x.c), '{}'::jsonb) from (select u, count(*) c from (select unnest(p.ban_votes) u from public.players p where p.room_id = r.id and p.status = 'active') y group by u) x),
                                          'myVotes', me.ban_votes)),
    'phase', v_phase, 'match', v_match, 'players', v_players, 'armies', v_armies, 'myArmy', v_my, 'history', v_hist, 'chat', v_chat);
end $$;

-- ------------------------------------------------------------ privileges
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant select on public.room_pulse to authenticated;
grant execute on function public._is_member(uuid) to authenticated;
grant execute on function
  public.create_room(text,text), public.join_room(text,text,text), public.leave_room(text), public.kick_player(text,uuid),
  public.update_settings(text,text,int,boolean,int,text[],text,int[]), public.vote_ban(text,int[]), public.set_team(text,uuid,int), public.set_ready(text,boolean), public.start_match(text),
  public.back_to_lobby(text), public.save_army(text,jsonb), public.end_prep(text), public.battle_control(text,text),
  public.report_result(text,int,int,text,jsonb), public.confirm_result(text,int), public.send_chat(text,text), public.get_state(text,text,boolean)
  to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.room_pulse; exception when duplicate_object then null; end;
  end if;
end $$;
