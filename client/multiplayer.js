/* multiplayer.js - boot + wiring. */
(async function boot() {
  const app = { alive: true };
  window.__BDMP__ = { alive: true, version: M.VERSION, show() { app.ui && app.ui.setCollapsed(false); }, disconnect: () => app.disconnect && app.disconnect(true) };

  app.api = new M.Api(M.CONFIG);
  app.adapter = new M.BDAdapter();
  app.rm = new M.RoomManager(app.api);
  app.ui = new M.UI(app);
  app.prep = null; app.battle = null; app.matchId = null;

  const stopRunners = () => {
    if (app.prep) { app.prep.stop(); app.prep = null; }
    if (app.battle) { app.battle.stop(); app.battle = null; }
  };
  app.toLobbyView = () => { stopRunners(); app.ui.hideField(); try { app.adapter.release(); } catch (e) { console.warn(e); } app.matchId = null; };
  app.disconnect = async () => {
    if (!app.alive) return; app.alive = false;
    try { await app.rm.leave(); } catch { /* ignore */ }
    stopRunners(); try { app.adapter.release(); } catch { /* ignore */ }
    app.ui.destroy(); delete window.__BDMP__; console.info('[BDMP] disconnected');
  };
  app.leaveRoom = async () => { app.toLobbyView(); await app.rm.leave(); app.ui.render(null); };

  app.rm.on('status', (st, detail) => app.ui.setStatus(st, detail));
  app.rm.on('error', e => app.ui.toast(M.errText(e), 'bad'));
  app.rm.on('ejected', reason => { app.toLobbyView(); app.ui.sig = ''; app.ui.render(null); app.ui.toast(M.errText({ code: reason }), reason === 'kicked' ? 'bad' : 'warn'); });

  app.rm.on('state', (s, prev) => {
    const m = s.match;
    if (s.phase === 'lobby') { if (app.matchId || app.prep || app.battle) app.toLobbyView(); }
    else if (m && m.id !== app.matchId && (s.phase === 'prep' || s.phase === 'battle')) {
      stopRunners(); app.matchId = m.id;
      if (s.phase === 'prep') { app.prep = new M.Preparation(app); app.prep.start(s); }
      else { app.battle = new M.BattleRunner(app); app.battle.start(s); }
    } else if (m && m.id === app.matchId) {
      if (s.phase === 'prep' && app.prep) app.prep.update(s);
      if (s.phase === 'battle' && !app.battle) { if (app.prep) { app.prep.stop(); app.prep = null; } app.battle = new M.BattleRunner(app); app.battle.start(s); }
      else if (s.phase === 'battle') app.battle.update(s);
      if (s.phase === 'results') { if (app.prep) { app.prep.stop(); app.prep = null; } if (app.battle) { app.battle.update(s); app.battle.stop(); } }
    } else if (m && s.phase === 'results' && m.id !== app.matchId) { app.matchId = m.id; }   // joined/reconnected after the match ended
    if (prev && prev.phase !== s.phase) app.onPhase(s, prev);
    app.ui.render(s);
  });
  app.onPhase = (s, prev) => {
    if (s.phase === 'prep') app.ui.toast('Preparation started - draw your army!', 'good');
    if (s.phase === 'battle') app.ui.toast('Armies locked. Battle starting…', 'good');
    if (s.phase === 'results') app.ui.toast('Battle over', 'info');
    if (s.phase === 'lobby' && prev.phase === 'results') app.ui.toast('Back in the lobby', 'info');
  };

  app.ui.render(null); app.ui.setStatus('idle');
  if (!M.BDAdapter.onGame()) {
    app.ui.toast('Open https://neal.fun/battle-draw/ first, then run the snippet there.', 'bad');
    app.ui.body.replaceChildren(M.h('div', { class: 'landing' }, M.h('h2', {}, 'Wrong page'),
      M.h('p', { class: 'hint' }, 'Multiplayer works on the original Battle Draw. Open it, then paste the snippet into that tab\'s console.'),
      M.h('a', { class: 'btn primary', href: 'https://neal.fun/battle-draw/', target: '_blank', rel: 'noopener' }, 'Open Battle Draw')));
    return;
  }
  try { await app.adapter.ready(); }
  catch (e) {
    app.ui.setStatus('error', e.message); app.ui.toast(e.message, 'bad');
    app.ui.body.replaceChildren(M.h('div', { class: 'landing' }, M.h('h2', {}, 'Couldn\'t attach to the game'), M.h('p', { class: 'hint' }, e.message + ' Try reloading the page and running the snippet again.')));
    return;
  }
  if (await app.rm.resume()) app.ui.toast('Reconnected to your room', 'good');
  console.info('[BDMP] Battle Draw Multiplayer ' + M.VERSION + ' ready');
})();
