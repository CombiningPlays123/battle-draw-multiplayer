/* results.js - results screen: winner, teams, duration, battlefield preview, contributions, history, rematch. */
M.views = M.views || {};

M.preview = (s) => {
  const m = s.match, f = 0.3, cv = M.h('canvas', { class: 'preview' });
  cv.width = Math.round(m.field.w * f); cv.height = Math.round(m.field.h * f);
  const c = cv.getContext('2d'); c.fillStyle = 'rgba(128,128,128,.12)'; c.fillRect(0, 0, cv.width, cv.height);
  for (const a of s.armies || []) {
    const col = M.sideOf(a.faction, m.mode, m.zones).color; c.fillStyle = col;
    for (const u of (a.data && a.data.units) || []) { c.beginPath(); c.arc(u[1] * cv.width, u[2] * cv.height, 2.2, 0, 7); c.fill(); }
    c.fillStyle = col; c.globalAlpha = .45;
    for (const w of (a.data && a.data.walls) || []) c.fillRect(w[0] * cv.width, w[1] * cv.height, Math.max(1, w[2] * cv.width), Math.max(1.5, w[3] * cv.height));
    c.globalAlpha = 1;
  }
  return cv;
};

M.views.results = (ui, s) => {
  const { h } = M, m = s.match, r = m.result || {}, mode = m.mode, isHost = s.room.hostId === s.me, st = r.stats || {};
  let banner;
  const sideName = f => M.sideOf(f, mode, m.zones).name;
  if (m.outcome === 'win') {
    const mine = m.zones.find(z => z.user === s.me), won = mine && mine.faction === r.winner;
    const members = m.zones.filter(z => z.faction === r.winner).map(z => z.name).join(' + ');
    banner = ui.resultBanner(won ? 'win' : 'lose', won ? '🏆 You win!' : '🏁 ' + sideName(r.winner) + ' wins', members + (r.confirmedByHost ? ' (confirmed by the host)' : ''));
  } else if (m.outcome === 'draw') banner = ui.resultBanner('lose', 'Draw', 'Nobody was left standing' + (st.why === 'timelimit' ? ' (10-minute limit)' : '') + '.');
  else if (m.outcome === 'disputed') banner = ui.resultBanner('lose', 'Result needs confirmation', r.reason || 'The copies of the simulation disagreed.');
  else banner = ui.resultBanner('lose', 'Match cancelled', r.reason || '');

  const stat = h('div', { class: 'stats' },
    r.endTick ? h('span', { class: 'chip' }, 'Battle length ' + (r.endTick / 60).toFixed(1) + ' s') : null,
    r.agreed ? h('span', { class: 'chip' }, r.agreed + '/' + r.players + ' copies of the simulation agree') : null,
    h('span', { class: 'chip' }, (mode === 'teams' ? 'Team battle' : 'Free-for-all') + ' · match #' + m.number),
    m.rules && m.rules.balanced ? h('span', { class: 'chip' }, M.rulesText(m.rules)) : null);

  const sv = st.survivors || {}, pl = st.placed || {};
  const contrib = m.zones.length && (m.outcome === 'win' || m.outcome === 'draw') ? h('div', { class: 'contrib' }, m.zones.map(z => {
    const sd = M.sideOf(z.faction, mode, m.zones), placed = pl[z.slot] || 0, alive = sv[z.slot] || 0;
    return h('div', { class: 'crow' }, h('span', { class: 'swatch', style: { background: sd.color } }), h('span', { class: 'pname' }, z.name),
      h('span', { class: 'bar' }, h('i', { style: { width: (placed ? Math.round(100 * alive / placed) : 0) + '%', background: sd.color } })),
      h('span', { class: 'count' }, alive + '/' + placed + ' left')); })) : null;

  const disputed = m.outcome === 'disputed' ? h('div', {}, h('div', { class: 'section-title' }, 'What each copy reported'),
    (r.reports || []).map(x => h('div', { class: 'trow2' }, h('b', {}, x.name), h('span', {}, x.winner < 0 ? 'draw' : sideName(x.winner)), h('small', {}, 'tick ' + x.endTick + ' · ' + x.hash))),
    isHost ? h('div', { class: 'row' }, [...new Set(m.zones.map(z => z.faction))].sort().map(f => h('button', { class: 'btn small', onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('confirm_result', { p_winner: f })) }, sideName(f) + ' won')),
      h('button', { class: 'btn small', onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('confirm_result', { p_winner: -1 })) }, 'Draw')) : h('p', { class: 'hint' }, 'Waiting for the host to confirm the result.')) : null;

  const hist = (s.history || []).length ? h('details', { class: 'tally' }, h('summary', {}, 'Match history (' + s.history.length + ')'),
    s.history.map(x => h('div', { class: 'trow2' }, h('b', {}, '#' + x.number), h('span', {}, x.outcome === 'win' ? (x.winner || '?') + ' won' : x.outcome), h('small', {}, (x.durationSec ? x.durationSec + 's · ' : '') + (x.players || ''))))) : null;

  const me = s.players.find(p => p.id === s.me) || {};
  const actions = isHost
    ? h('div', { class: 'row actions' }, (() => { const b = h('button', { class: 'btn primary', onclick: () => ui.run(b, () => ui.app.rm.act('start_match')) }, '↻ Rematch'); return b; })(),
        (() => { const b = h('button', { class: 'btn', onclick: () => ui.run(b, () => ui.app.rm.act('back_to_lobby')) }, 'Return to lobby'); return b; })())
    : h('button', { class: 'btn big ' + (me.ready ? '' : 'primary'), onclick: e => ui.run(e.currentTarget, () => ui.app.rm.act('set_ready', { p_ready: !me.ready })) }, me.ready ? '✓ Ready for a rematch' : 'Ready for a rematch');
  const rematchNote = isHost ? h('p', { class: 'hint' }, 'A rematch starts once every other player has pressed "Ready for a rematch".') : null;

  return h('div', {}, banner, stat,
    (s.armies || []).length ? h('div', {}, h('div', { class: 'section-title' }, 'Battlefield (starting armies)'), M.preview(s)) : null,
    contrib ? h('div', {}, h('div', { class: 'section-title' }, 'Contributions (units surviving)'), contrib) : null,
    disputed, hist, actions, rematchNote, ui.leaveBtn());
};
