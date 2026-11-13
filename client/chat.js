/* chat.js - room chat. Text is always rendered with textContent (see M.h), the server additionally
   strips tags/control characters, caps length at 200 and rate-limits to 5 messages / 10 s. */
class Chat {
  constructor(app) {
    const { h } = M; this.app = app; this.lastSig = ''; this.unread = 0; this.open = M.store.get('bdmp.chatOpen', true);
    this.list = h('div', { class: 'msgs' });
    this.input = h('input', { class: 'input', maxlength: '200', placeholder: 'Message the room…', autocomplete: 'off' });
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter') this.send(); });
    this.badge = h('span', { class: 'badge' });
    this.toggle = h('button', { class: 'chat-head', onclick: () => this.setOpen(!this.open) }, h('span', {}, '💬 Chat'), this.badge, h('span', { class: 'caret' }, '▾'));
    this.body = h('div', { class: 'chat-body' }, this.list, h('div', { class: 'row' }, this.input, h('button', { class: 'btn small', onclick: () => this.send() }, 'Send')));
    this.el = h('div', { class: 'chat' }, this.toggle, this.body);
    this.setOpen(this.open);
  }
  setOpen(v) { this.open = v; M.store.set('bdmp.chatOpen', v); this.el.classList.toggle('closed', !v); if (v) { this.unread = 0; this.badge.textContent = ''; this.scroll(); } }
  scroll() { this.list.scrollTop = this.list.scrollHeight; }
  async send() {
    const t = this.input.value.trim(); if (!t) return;
    this.input.value = '';
    try { await this.app.rm.act('send_chat', { p_text: t }); } catch (e) { this.input.value = t; this.app.ui.toast(M.errText(e), 'warn'); }
  }
  update(s) {
    const msgs = s.chat || [], last = msgs.length ? msgs[msgs.length - 1].id : 0, sig = msgs.length + ':' + last;
    if (sig === this.lastSig) return;
    const fresh = this.lastSig === '' ? 0 : msgs.filter(m => m.id > this.lastLast && m.userId !== s.me).length;
    this.lastSig = sig; this.lastLast = last;
    const stick = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 30;
    this.list.replaceChildren(...msgs.map(m => {
      const t = new Date(m.at);
      return M.h('div', { class: 'msg' + (m.userId === s.me ? ' mine' : '') },
        M.h('span', { class: 'who' }, m.name), M.h('span', { class: 'when' }, isNaN(t) ? '' : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        M.h('div', { class: 'txt' }, m.text));
    }));
    if (stick || fresh === 0) this.scroll();
    if (!this.open && fresh) { this.unread += fresh; this.badge.textContent = String(this.unread); }
  }
}
M.Chat = Chat;
