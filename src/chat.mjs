// Chat de Twitch por IRC sobre WebSocket (solo lectura, anónimo) y envío por la API Helix.
import { EventEmitter } from 'node:events';

const IRC = 'wss://irc-ws.chat.twitch.tv:443';

export function parseIrc(line) {
  // @tags :prefix COMMAND params :trailing
  let rest = line, tags = {}, prefix = '';
  if (rest.startsWith('@')) {
    const i = rest.indexOf(' ');
    for (const kv of rest.slice(1, i).split(';')) {
      const [k, v = ''] = kv.split('=');
      tags[k] = v.replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\').replace(/\\r/g, '\r').replace(/\\n/g, '\n');
    }
    rest = rest.slice(i + 1);
  }
  if (rest.startsWith(':')) { const i = rest.indexOf(' '); prefix = rest.slice(1, i); rest = rest.slice(i + 1); }
  const ti = rest.indexOf(' :');
  const trailing = ti >= 0 ? rest.slice(ti + 2) : '';
  const parts = (ti >= 0 ? rest.slice(0, ti) : rest).split(' ').filter(Boolean);
  return { tags, prefix, command: parts[0], params: parts.slice(1), trailing };
}

/** Emotes de Twitch («25:0-4,12-16/1902:6-10») → trozos de texto e imágenes. */
export function splitEmotes(text, emotesTag = '') {
  if (!emotesTag) return [{ t: text }];
  const ranges = [];
  for (const part of emotesTag.split('/')) {
    const [id, pos] = part.split(':');
    for (const r of (pos || '').split(',')) { const [a, b] = r.split('-').map(Number); if (!Number.isNaN(a)) ranges.push({ id, a, b }); }
  }
  ranges.sort((x, y) => x.a - y.a);
  const chars = [...text]; // los índices de Twitch son por punto de código
  const out = []; let i = 0;
  for (const r of ranges) {
    if (r.a > i) out.push({ t: chars.slice(i, r.a).join('') });
    out.push({ e: `https://static-cdn.jtvnw.net/emoticons/v2/${r.id}/default/dark/2.0`, alt: chars.slice(r.a, r.b + 1).join('') });
    i = r.b + 1;
  }
  if (i < chars.length) out.push({ t: chars.slice(i).join('') });
  return out;
}

export function twitchChatMessage(msg) {
  const t = msg.tags;
  const badges = t.badges || '';
  return {
    id: 'tw:' + (t.id || Date.now() + Math.random()),
    platform: 'twitch',
    ...(t['user-id'] ? { authorId: t['user-id'] } : {}),
    ...(t['room-id'] ? { roomId: t['room-id'] } : {}),
    user: t['display-name'] || msg.prefix.split('!')[0],
    login: msg.prefix.split('!')[0],
    color: t.color || '',
    text: msg.trailing,
    parts: splitEmotes(msg.trailing, t.emotes),
    mod: t.mod === '1' || badges.includes('moderator'),
    owner: badges.includes('broadcaster'),
    member: t.subscriber === '1' || badges.includes('subscriber'),
    vip: badges.includes('vip'),
    // «Destacar mi mensaje» (puntos del canal)
    highlighted: t['msg-id'] === 'highlighted-message',
    at: t['tmi-sent-ts'] ? new Date(Number(t['tmi-sent-ts'])).toISOString() : new Date().toISOString(),
  };
}

export class TwitchChat extends EventEmitter {
  constructor(log = console.log) {
    super();
    this.log = log;
    this.ws = null;
    this.channel = null;
    this.stopped = true;
    this.terminal = false;
    this.sockets = new Set();
    this.reconnectTimer = null;
    this.quiescence = null;
    this.status = { state: 'parado', channel: null };
  }
  setStatus(p) { this.status = { ...this.status, ...p }; this.emit('status', this.status); }

  join(channel) {
    if (this.terminal) return;
    channel = String(channel || '').toLowerCase().replace(/^#/, '').trim();
    if (!channel) return;
    if (channel === this.channel && this.ws) return;
    this.stop();
    this.channel = channel;
    this.stopped = false;
    this.connect();
  }

  connect() {
    if (this.terminal || this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = new WebSocket(IRC);
    this.sockets.add(ws);
    ws.addEventListener('close', () => this.sockets.delete(ws), { once: true });
    this.ws = ws;
    this.setStatus({ state: 'conectando', channel: this.channel });
    ws.onopen = () => {
      if (this.terminal || this.stopped || ws !== this.ws) return;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      ws.send(`JOIN #${this.channel}`);
    };
    ws.onmessage = ev => {
      for (const line of String(ev.data).split('\r\n')) {
        if (this.terminal || this.stopped || ws !== this.ws) return;
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const msg = parseIrc(line);
        if (msg.command === 'JOIN') this.setStatus({ state: 'conectado' });
        if (msg.command === 'PRIVMSG') this.emit('message', twitchChatMessage(msg));
        if (msg.command === 'CLEARMSG') this.emit('delete', { id: 'tw:' + msg.tags['target-msg-id'] });
        if (msg.command === 'CLEARCHAT') this.emit('clearUser', { login: msg.trailing });
      }
    };
    ws.onclose = () => {
      if (ws !== this.ws || this.stopped || this.terminal) return;
      this.setStatus({ state: 'reconectando' });
      if (this.terminal || this.stopped || ws !== this.ws) return;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.terminal && !this.stopped && ws === this.ws) this.connect();
      }, 3000);
    };
    ws.onerror = () => {};
  }

  /** Corte terminal: espera close físico, no solo la solicitud de cierre. */
  quiesceChat() {
    if (this.quiescence) return this.quiescence;
    this.terminal = true;
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    let resolve, reject;
    this.quiescence = new Promise((yes, no) => { resolve = yes; reject = no; });
    const closing = [...this.sockets].map(ws => new Promise((yes, no) => {
      if (ws.readyState === 3) { this.sockets.delete(ws); yes(); return; }
      const closed = () => { ws.removeEventListener('close', closed); yes(); };
      ws.addEventListener('close', closed, { once: true });
      try { if (ws.readyState !== 2) ws.close(); }
      catch (err) { ws.removeEventListener('close', closed); no(err); }
    }));
    this.ws = null;
    this.channel = null;
    try { this.setStatus({ state: 'parado', channel: null }); }
    catch (err) { closing.push(Promise.reject(err)); }
    Promise.allSettled(closing).then(results => {
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
      if (errors.length) reject(new AggregateError(errors, 'No se pudo cerrar el chat de Twitch.'));
      else resolve();
    });
    return this.quiescence;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.channel = null;
    this.setStatus({ state: 'parado', channel: null });
  }
}
