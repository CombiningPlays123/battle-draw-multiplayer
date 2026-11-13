/* util.js - shared helpers. All client files are concatenated into one IIFE by tools/build.mjs;
   modules share the private namespace `M`. */
const M = {};
M.VERSION = '1.0.0';
M.BASE_ITEMS = ['water', 'fire', 'wind', 'earth'];

M.norm = t => String(t == null ? '' : t).trim().replace(/\s+/g, ' ').toLowerCase();

/** Tiny DOM builder. Strings are ALWAYS inserted as text (never HTML), so chat/usernames can't inject markup. */
M.h = function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = c => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
};

M.emitter = function () {
  const map = {};
  return {
    on(ev, fn) { (map[ev] = map[ev] || []).push(fn); return () => { map[ev] = (map[ev] || []).filter(f => f !== fn); }; },
    emit(ev, ...a) { (map[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.error('[BDMP]', e); } }); },
  };
};

M.sleep = ms => new Promise(r => setTimeout(r, ms));

M.fmtTime = ms => {
  if (ms == null) return '∞';
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

M.store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Human-readable messages for the server's error codes. */
M.ERRORS = {
  room_not_found: 'No room with that code. Check the code and try again.',
  room_full: 'That room is full (max 4 players).',
  game_in_progress: 'That room is mid-game. Ask the host to wait for the round to end.',
  kicked: 'You were removed from this room by the host.',
  not_in_room: 'You are no longer in this room.',
  superseded: 'Multiplayer was opened in another tab, so this tab was disconnected.',
  not_host: 'Only the host can do that.',
  need_players: 'At least 2 connected players are needed to start.',
  invalid_name: 'Pick a name (1-16 characters).',
  invalid_element: 'That is not a valid element name.',
  base_element: 'Pick something that must be crafted (not Water, Fire, Wind or Earth).',
  already_submitted: 'You already submitted an element.',
  already_voted: 'You already voted - votes are final.',
  cannot_vote_self: 'You cannot vote for your own submission.',
  invalid_candidate: 'Pick one of the submissions.',
  not_submit_phase: 'Submissions are closed.',
  not_vote_phase: 'Voting is not open.',
  round_not_active: 'The round is over.',
  round_not_started: 'Wait for the countdown to finish.',
  too_fast: 'Slow down a little.',
  rate_limited: 'Slow down - you are sending messages too quickly.',
  empty_message: 'Type a message first.',
  recipe_conflict: 'A teammate already combined that pair and got a different result - your game and theirs disagree.',
  network: 'Cannot reach the multiplayer server. Retrying…',
  anon_disabled: 'The backend refused anonymous sign-in. In Supabase: Authentication → Sign In / Providers → enable "Allow anonymous sign-ins".',
  not_configured: 'This build has no Supabase URL/key configured. See docs/SUPABASE_SETUP.md.',
};
M.errText = e => {
  const code = e && e.code;
  if (code === 'ingredient_not_owned') return `"${e.arg || 'That element'}" is not part of this round's inventory. Use a fresh save slot (see the yellow notice).`;
  return M.ERRORS[code] || (e && e.message) || 'Something went wrong.';
};

Object.assign(M.ERRORS, {
  need_both_teams: 'Team battle needs at least one player on each team.',
  team_full: 'A team can have at most 3 players.',
  invalid_team: 'Invalid team.',
  not_all_ready: 'Everyone has to press Ready first.',
  players_offline: 'A player in the room is disconnected. Wait for them or kick them first.',
  not_prep_phase: 'Preparation is over.',
  prep_over: 'Preparation time is over - your last changes were not saved.',
  not_in_match: 'You are not part of this match.',
  invalid_army: 'Your army could not be saved (invalid data).',
  invalid_unit: 'That unit type is not allowed in multiplayer.',
  too_many_units: 'Too many units (limit: 300 per player).',
  outside_zone: 'Something was placed outside your zone.',
  not_battle_phase: 'The battle is not running.',
  battle_not_started: 'The battle has not started yet.',
  invalid_report: 'The simulation result was rejected by the server.',
  nothing_to_confirm: 'There is nothing to confirm.',
  game_in_progress: 'A match is in progress. Wait for it to finish.',
});

Object.assign(M.ERRORS, {
  over_unit_limit: 'Over the troop limit for this match.',
  category_not_allowed: 'That category is not allowed in this match.',
  unit_banned: 'That troop is banned in this match.',
  invalid_rules: 'Those rules are not valid (keep at least one troop placeable).',
  invalid_vote: 'You can vote to ban at most 2 troops, from the allowed categories.',
  voting_off: 'Troop voting is not enabled.',
});
