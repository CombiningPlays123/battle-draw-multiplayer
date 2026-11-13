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

M.views = M.views || {};
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

  const teamBlock = teams ? h('div', { class: 'teams' }, M.TEAMS.map((t, i) => h('div', { class: 'team', style: { '--tc': t.color } },
    h('b', {}, t.name), h('small', {}, s.players.filter(p => p.team === i).map(p => p.name).join(', ') || 'empty')))) : null;
  const setting = (mode, prep) => ui.run(null, () => ui.app.rm.act('update_settings', { p_mode: mode, p_prep: prep }));
  const prepNow = s.room.prepSeconds || 0;
  const modeCard = (id, icon, title, desc) => h('button', { class: 'mode ' + (s.room.mode === id ? ' sel' : ''), disabled: !isHost, onclick: () => setting(id, prepNow) },
    h('span', { class: 'micon' }, icon), h('b', {}, title), h('small', {}, desc));

  return h('div', {},
    h('div', { class: 'invite' }, h('small', {}, 'Share this code'), h('button', { class: 'bigcode', onclick: () => ui.copyCode() }, s.room.code), h('small', {}, 'click to copy · ' + s.players.length + '/4 players')),
    h('div', { class: 'section-title' }, 'Players'),
    h('div', { class: 'players' }, s.players.map(row)),
    teamBlock,
    h('div', { class: 'section-title' }, 'Mode', !isHost ? h('small', {}, 'host chooses') : null),
    h('div', { class: 'modes' },
      modeCard('teams', '🛡', 'Team battle', 'Red vs Blue. Your armies fight together. 1v1, 2v2, 3v1…'),
      modeCard('ffa', '⚔', 'Free-for-all', 'Every player for themselves in one battle.')),
    h('div', { class: 'section-title' }, 'Preparation time', !isHost ? h('small', {}, 'host chooses') : null),
    h('div', { class: 'chips' }, M.PREP_OPTIONS.map(([sec, label]) => h('button', { class: 'chip' + (prepNow === sec ? ' sel' : ''), disabled: !isHost, onclick: () => setting(s.room.mode, sec) }, label))),
    isHost ? start : h('button', { class: 'btn big ' + (me && me.ready ? '' : 'primary'), onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('set_ready', { p_ready: !(me && me.ready) })) }, me && me.ready ? '✓ Ready - click to cancel' : 'I\'m ready'),
    ui.leaveBtn());
};
