/* team-manager.js - teams, colours and the lobby view (host assigns sides; any arrangement up to 3 per side). */
M.TEAMS = [{ name: 'Red team', color: '#f74444' }, { name: 'Blue team', color: '#4580f7' }];
M.SLOT_COLORS = ['#f74444', '#4580f7', '#2fbf71', '#f5a623'];        // free-for-all: player 1..4 (factions 20..23)
M.PREP_OPTIONS = [[60, '1 min'], [180, '3 min'], [300, '5 min'], [600, '10 min'], [0, 'Unlimited']];

/** colour + label for a faction id (20..23) in the given mode */
M.sideOf = (faction, mode, zones) => {
  if (mode === 'teams') { const t = M.TEAMS[faction - 20] || M.TEAMS[0]; return { color: t.color, name: t.name }; }
  const z = (zones || []).find(z => z.faction === faction);
  return { color: M.SLOT_COLORS[faction - 20] || '#888', name: z ? z.name : 'Player ' + (faction - 19) };
};

/* the original game's unit tools (names as shown in its toolbar) and its toolbar categories */
M.CATEGORIES = [['army', 'Army'], ['creatures', 'Animals'], ['mythical', 'Mythical'], ['terrain', 'Terrain']];
M.UNITS = [[0, 'Soldier', 'army'], [3, 'Flamethrower', 'army'], [4, 'Sniper', 'army'], [5, 'Roman', 'army'], [6, 'Grenadier', 'army'], [7, 'Archer', 'army'], [18, 'Cavalry', 'army'], [50, 'Ninja', 'army'],
  [1, 'Boar', 'creatures'], [29, 'Rat', 'creatures'], [32, 'Ant', 'creatures'], [37, 'Ape', 'creatures'], [41, 'Alligator', 'creatures'], [43, 'Piranha', 'creatures'], [47, 'Snake', 'creatures'], [52, 'Cheetah', 'creatures'],
  [2, 'Zombie', 'mythical'], [8, 'Slime', 'mythical'], [23, 'Mage', 'mythical'], [27, 'Giant', 'mythical'], [44, 'Dragon', 'mythical'], [48, 'Necromancer', 'mythical'],
  [17, 'Barrel', 'terrain'], [31, 'Tree', 'terrain']];
M.unitName = t => (M.UNITS.find(u => u[0] === t) || [t, 'Unit ' + t])[1];
M.TROOP_CAPS = [10, 20, 30, 50, 75, 100, 150];
M.UNLIMITED = 1000;                               // technical maximum per player
M.BAN_MODES = [['none', 'No bans'], ['host', 'Host picks'], ['vote', 'Players vote']];

/** full settings payload for update_settings (the server replaces all settings at once), with overrides */
M.settingsArgs = (s, o) => {
  const r = s.room, rules = r.rules || {};
  return Object.assign({ p_mode: r.mode, p_prep: r.prepSeconds || 0, p_balanced: !!rules.balanced, p_max_units: rules.balanced ? rules.maxUnits : 50,
    p_categories: rules.categories, p_ban_mode: rules.banMode || 'none', p_banned: rules.hostBanned || [] }, o || {});
};
M.rulesText = rules => !rules || !rules.balanced ? 'Standard rules' : 'Balanced · ' + (rules.maxUnits >= M.UNLIMITED ? 'unlimited troops' : 'max ' + rules.maxUnits + ' troops') + ' · ' +
  M.CATEGORIES.filter(c => rules.categories.includes(c[0])).map(c => c[1]).join(', ') + ((rules.banned || []).length ? ' · banned: ' + rules.banned.map(M.unitName).join(', ') : '');

M.views = M.views || {};
M.views.rulesBlock = (ui, s) => {
  const { h } = M, isHost = s.room.hostId === s.me, rules = s.room.rules || {}, set = o => ui.run(null, () => ui.app.rm.act('update_settings', M.settingsArgs(s, o)));
  const ALL = M.CATEGORIES.map(c => c[0]);
  const toggle = h('button', { class: 'balance-toggle' + (rules.balanced ? ' on' : ''), disabled: !isHost,
    onclick: () => set(rules.balanced ? { p_balanced: false } : { p_balanced: true, p_max_units: 50, p_categories: ALL, p_ban_mode: 'none', p_banned: [] }) },
    h('span', { class: 'micon' }, '⚖'), h('span', { class: 'bt' }, h('b', {}, 'Balanced competition'), h('small', {}, rules.balanced ? 'On - limits below apply to everyone' : 'Off - standard rules, no limits')), h('span', { class: 'sw' }));
  const head = h('div', { class: 'section-title' }, 'Rules', !isHost ? h('small', {}, 'host chooses') : null);
  if (!rules.balanced) return h('div', {}, head, toggle);
  const isPreset = M.TROOP_CAPS.includes(rules.maxUnits), isUnl = rules.maxUnits >= M.UNLIMITED;
  const custom = h('input', { class: 'input capinput', type: 'number', min: '1', max: String(M.UNLIMITED - 1), placeholder: 'custom', value: !isPreset && !isUnl ? String(rules.maxUnits) : '', disabled: !isHost });
  const applyCustom = () => { const n = Math.floor(Number(custom.value)); if (!(n >= 1 && n < M.UNLIMITED)) { ui.toast('Type a troop limit from 1 to ' + (M.UNLIMITED - 1) + ', or press Unlimited.', 'warn'); return; } set({ p_max_units: n }); };
  custom.addEventListener('keydown', e => { if (e.key === 'Enter') applyCustom(); });
  const caps = h('div', {}, h('div', { class: 'chips' }, M.TROOP_CAPS.map(n => h('button', { class: 'chip' + (rules.maxUnits === n ? ' sel' : ''), disabled: !isHost, onclick: () => set({ p_max_units: n }) }, n + '')),
      h('button', { class: 'chip' + (isUnl ? ' sel' : ''), disabled: !isHost, title: 'No limit (technical maximum ' + M.UNLIMITED + ' per player)', onclick: () => set({ p_max_units: M.UNLIMITED }) }, '∞ Unlimited')),
    h('div', { class: 'row capcustom' }, custom, h('button', { class: 'btn small' + (!isPreset && !isUnl ? ' primary' : ''), disabled: !isHost, onclick: applyCustom }, 'Set custom limit')));
  const cats = h('div', { class: 'chips' }, M.CATEGORIES.map(([id, label]) => { const on = rules.categories.includes(id);
    return h('button', { class: 'chip' + (on ? ' sel' : ''), disabled: !isHost, title: on ? 'allowed' : 'not allowed', onclick: () => { const next = on ? rules.categories.filter(c => c !== id) : rules.categories.concat(id); if (next.length) set({ p_categories: next }); } }, (on ? '✓ ' : '✗ ') + label); }));
  const modes = h('div', { class: 'chips' }, M.BAN_MODES.map(([id, label]) => h('button', { class: 'chip' + (rules.banMode === id ? ' sel' : ''), disabled: !isHost, onclick: () => set({ p_ban_mode: id, p_banned: id === 'host' ? (rules.hostBanned || []) : [] }) }, label)));
  const mine = rules.myVotes || [], votes = rules.votes || {}, banned = rules.banned || [];
  const unit = ([t, name, cat]) => {
    const isBanned = banned.includes(t), voted = mine.includes(t), n = votes[String(t)] || 0;
    let click = null, off = true;
    if (rules.banMode === 'host' && isHost) { off = false; click = () => { const cur = rules.hostBanned || []; set({ p_banned: cur.includes(t) ? cur.filter(x => x !== t) : cur.concat(t) }); }; }
    if (rules.banMode === 'vote') { off = false; click = () => { const next = voted ? mine.filter(x => x !== t) : mine.concat(t).slice(-2); ui.run(null, () => ui.app.rm.act('vote_ban', { p_units: next })); }; }
    return h('button', { class: 'uchip' + (isBanned ? ' banned' : '') + (voted ? ' voted' : ''), disabled: off, title: isBanned ? name + ' is banned' : name, onclick: click },
      name, rules.banMode === 'vote' && n ? h('i', {}, String(n)) : null);
  };
  const grid = rules.banMode === 'none' ? null : h('div', {},
    h('p', { class: 'hint' }, rules.banMode === 'host' ? (isHost ? 'Tap a troop to ban it for everyone.' : 'The host picks which troops are banned.') : 'Vote to ban up to 2 troops - a troop is banned when more than half of the players vote for it. Tap to vote / unvote.'),
    h('div', { class: 'uchips' }, M.UNITS.filter(u => rules.categories.includes(u[2])).map(unit)));
  return h('div', {}, head, toggle,
    h('div', { class: 'rulelabel' }, 'Troop limit per player'), caps,
    h('div', { class: 'rulelabel' }, 'Allowed categories'), cats,
    h('div', { class: 'rulelabel' }, 'Banned troops (optional)'), modes, grid,
    h('p', { class: 'hint' }, M.rulesText(rules)));
};

/** mode + preparation time + balanced rules (+ the red/blue team summary): shared by the lobby and the rematch screen */
M.views.settings = (ui, s) => {
  const { h } = M, isHost = s.room.hostId === s.me, teams = s.room.mode === 'teams';
  const setting = (mode, prep) => ui.run(null, () => ui.app.rm.act('update_settings', M.settingsArgs(s, { p_mode: mode, p_prep: prep })));
  const prepNow = s.room.prepSeconds || 0;
  const modeCard = (id, icon, title, desc) => h('button', { class: 'mode ' + (s.room.mode === id ? ' sel' : ''), disabled: !isHost, onclick: () => setting(id, prepNow) },
    h('span', { class: 'micon' }, icon), h('b', {}, title), h('small', {}, desc));
  const teamBlock = teams ? h('div', { class: 'teams' }, M.TEAMS.map((t, i) => h('div', { class: 'team', style: { '--tc': t.color } },
    h('b', {}, t.name), h('small', {}, s.players.filter(p => p.team === i).map(p => p.name).join(', ') || 'empty')))) : null;
  return h('div', {},
    teamBlock,
    h('div', { class: 'section-title' }, 'Mode', !isHost ? h('small', {}, 'host chooses') : null),
    h('div', { class: 'modes' },
      modeCard('teams', '🛡', 'Team battle', 'Red vs Blue. Your armies fight together. 1v1, 2v2, 3v1…'),
      modeCard('ffa', '⚔', 'Free-for-all', 'Every player for themselves in one battle.')),
    h('div', { class: 'section-title' }, 'Preparation time', !isHost ? h('small', {}, 'host chooses') : null),
    h('div', { class: 'chips' }, M.PREP_OPTIONS.map(([sec, label]) => h('button', { class: 'chip' + (prepNow === sec ? ' sel' : ''), disabled: !isHost, onclick: () => setting(s.room.mode, sec) }, label))),
    M.views.rulesBlock(ui, s));
};

/** host: move players between Red and Blue (team battle) */
M.views.teamAssign = (ui, s) => {
  const { h } = M;
  if (s.room.mode !== 'teams' || s.room.hostId !== s.me) return null;
  return h('div', {}, h('div', { class: 'section-title' }, 'Teams'), h('div', { class: 'players' }, s.players.map(p => h('div', { class: 'player' + (p.online ? '' : ' off') },
    h('span', { class: 'swatch', style: { background: M.TEAMS[p.team].color } }), h('span', { class: 'pname' }, p.name),
    h('span', { class: 'teambtns' }, M.TEAMS.map((t, i) => h('button', { class: 'tb' + (p.team === i ? ' sel' : ''), style: { '--tc': t.color },
      onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('set_team', { p_target: p.id, p_team: i })) }, i === 0 ? 'Red' : 'Blue')))))));
};

M.views.lobby = (ui, s) => {
  const { h } = M, isHost = s.room.hostId === s.me, teams = s.room.mode === 'teams';
  const online = s.players.filter(p => p.online);
  const act = (fn, args) => ui.run(null, () => ui.app.rm.act(fn, args));
  const me = s.players.find(p => p.id === s.me);
  const sizes = [0, 1].map(t => s.players.filter(p => p.team === t).length);
  const issue = online.length < 2 ? 'Need 2+ players to start'
    : s.players.length > online.length ? 'Waiting for a disconnected player'
    : teams && (sizes[0] < 1 || sizes[1] < 1) ? 'Each team needs a player'
    : s.players.some(p => !p.host && !p.ready) ? 'Waiting for everyone to be ready' : null;
  const start = h('button', { class: 'btn primary big', disabled: !!issue, onclick: () => ui.run(start, () => ui.app.rm.act('start_match')) }, issue || 'Start match');

  const teamBtns = p => !isHost || !teams ? null : h('span', { class: 'teambtns' }, M.TEAMS.map((t, i) =>
    h('button', { class: 'tb' + (p.team === i ? ' sel' : ''), style: { '--tc': t.color }, title: 'Move to ' + t.name, onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('set_team', { p_target: p.id, p_team: i })) }, i === 0 ? 'Red' : 'Blue')));
  const row = (p, idx) => h('div', { class: 'player' + (p.id === s.me ? ' me' : '') + (p.online ? '' : ' off') },
    h('span', { class: 'dot ' + (p.online ? 'on' : 'off'), title: p.online ? 'connected' : 'disconnected' }),
    h('span', { class: 'swatch', style: { background: teams ? M.TEAMS[p.team].color : M.SLOT_COLORS[idx] } }),
    h('span', { class: 'pname' }, p.name, p.host ? h('span', { class: 'crown', title: 'Host' }, ' 👑') : null, p.id === s.me ? h('span', { class: 'you' }, ' (you)') : null),
    teamBtns(p),
    h('span', { class: 'tag ' + (p.ready || p.host ? 'ok' : '') }, !p.online ? 'reconnecting…' : p.host ? 'host' : p.ready ? '✓ ready' : 'not ready'),
    isHost && p.id !== s.me ? h('button', { class: 'icon kick', title: 'Kick ' + p.name, onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('kick_player', { p_target: p.id })) }, '⛔') : null);

  return h('div', {},
    h('div', { class: 'invite' }, h('small', {}, 'Share this code'), h('button', { class: 'bigcode', onclick: () => ui.copyCode() }, s.room.code), h('small', {}, 'click to copy · ' + s.players.length + '/4 players')),
    h('div', { class: 'section-title' }, 'Players'),
    h('div', { class: 'players' }, s.players.map(row)),
    M.views.settings(ui, s),
    isHost ? start : h('button', { class: 'btn big ' + (me && me.ready ? '' : 'primary'), onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('set_ready', { p_ready: !(me && me.ready) })) }, me && me.ready ? '✓ Ready - click to cancel' : 'I\'m ready'),
    ui.leaveBtn());
};
