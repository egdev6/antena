// El bus mantiene sus tramas SSE; WebSocket evita el límite HTTP por host en las capas.
const RECONNECT_TIMEOUT_MS = 10_000; // plazo de un reintento cuyo upgrade no abre ni cierra
export class AntenaStream extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.transport = 'websocket';
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    this.retry = 2000;
    this.opened = false;
    this.socket = null;
    this.source = null;
    this.timer = null;
    this.types = new Set(['message']);
    this.connect();
  }

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (type !== 'open' && type !== 'error') {
      this.types.add(type);
      if (this.source) this.forward(type);
    }
  }

  emit(event) {
    this.dispatchEvent(event);
    const handler = this['on' + event.type];
    if (typeof handler === 'function') handler.call(this, event);
  }

  connect() {
    if (this.readyState === 2) return;
    let ws;
    try {
      const url = new URL(this.url, location.href || `${location.protocol}//${location.host}/`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(url.href);
    } catch {
      if (!this.opened) return this.fallback();
      this.emit(new Event('error'));
      if (this.readyState !== 2) this.timer = setTimeout(() => this.connect(), this.retry);
      return;
    }
    this.socket = ws;
    ws.addEventListener('open', () => {
      if (this.readyState === 2 || ws !== this.socket) return;
      clearTimeout(this.timer);
      this.opened = true;
      this.readyState = 1;
      this.emit(new Event('open'));
    });
    ws.addEventListener('message', e => {
      if (this.readyState !== 2 && ws === this.socket && typeof e.data === 'string') this.parse(e.data);
    });
    ws.addEventListener('close', () => {
      if (this.readyState === 2 || ws !== this.socket) return;
      clearTimeout(this.timer);
      this.socket = null;
      this.readyState = 0;
      this.emit(new Event('error'));
      if (this.readyState === 2) return;
      if (!this.opened) this.fallback();
      else this.timer = setTimeout(() => this.connect(), this.retry);
    });
    // Some HTTP-only proxies leave the upgrade pending instead of rejecting it. Before the first
    // open that means falling back to SSE; on a later reconnect WebSocket already worked, so the
    // stalled attempt is retired (its events are ignored) and a fresh one is scheduled.
    const firstAttempt = !this.opened;
    this.timer = setTimeout(() => {
      if (this.readyState === 2 || ws !== this.socket || this.readyState === 1) return;
      this.socket = null;
      try { ws.close(); } catch { /* ya cerrado */ }
      this.emit(new Event('error'));
      if (this.readyState === 2) return;
      if (firstAttempt) this.fallback();
      else this.timer = setTimeout(() => this.connect(), this.retry);
    }, firstAttempt ? this.retry : Math.max(this.retry, RECONNECT_TIMEOUT_MS));
  }

  // Cada mensaje WS contiene una trama SSE completa; una trama sin data no es un evento.
  parse(text) {
    let event = '', data = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!line) {
        if (data.length) this.emit(new MessageEvent(event || 'message', { data: data.join('\n') }));
        event = ''; data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    }
  }

  fallback() {
    this.transport = 'sse';
    const source = this.source = new EventSource(this.url);
    this.forwarded = new Set();
    for (const type of this.types) this.forward(type);
    for (const type of ['open', 'error']) source.addEventListener(type, () => {
      if (this.readyState === 2) return;
      this.readyState = source.readyState;
      this.emit(new Event(type));
    });
  }

  forward(type) {
    if (this.forwarded.has(type)) return;
    this.forwarded.add(type);
    this.source.addEventListener(type, e => {
      if (this.readyState !== 2) this.emit(new MessageEvent(type, { data: e.data, origin: e.origin, lastEventId: e.lastEventId }));
    });
  }

  close() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    clearTimeout(this.timer);
    this.socket?.close();
    this.source?.close();
  }
}
