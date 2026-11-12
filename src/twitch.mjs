// Twitch: login con Device Code Flow (cliente público, sin secreto) + EventSub por WebSocket.
import { EventEmitter } from 'node:events';
import { normalizeTwitch } from './alerts.mjs';

const ID = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';

export const SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'user:write:chat',
  'moderator:manage:announcements',
  'channel:manage:broadcast',
];

export class Twitch extends EventEmitter {
  constructor(store, log = console.log) {
    super();
    this.store = store;
    this.log = log;
    this.ws = null;
    this.status = { state: 'desconectado', user: null, subscriptions: [], errors: [], device: null };
    this.keepaliveTimer = null;
    this.keepaliveMs = 40_000;
    this.stopped = true;
    this.rawLog = null; // RawEventLog opcional (src/raw-events.mjs)
    this.pending = null;
    this.reconnectTimer = null;
    this._terminal = false;
    this._epoch = 0;
    this._quiesce = null;
    this._tracked = new Set();
    this._sockets = new Set(); // Incluye sustituidos hasta su close físico.
    this._socketCloseRequested = new WeakSet();
    this._deviceClosing = false;
    this._deviceQuiesce = null;
    this._deviceWork = new Set();
    this._deviceWaits = new Set();
    this._authWork = new Set();
    this.retryDelayMs = 5_000;
    this.retryMaxAttempts = 3;
  }

  // Registra trabajo propio antes de ceder el control: el corte terminal lo espera antes de resolver.
  _track(p) { this._tracked.add(p); const done = () => this._tracked.delete(p); p.then(done, done); return p; }

  get clientId() { return this.store.config.twitch.clientId?.trim(); }
  get token() { return this.store.secrets.twitch; }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }

  // ---------- Auth ----------
  _deviceTask(fn) {
    if (this._deviceClosing) return Promise.reject(Object.assign(new Error('La autorización de Twitch se está cerrando.'), { code: 'TWITCH_DEVICE_CLOSING', status: 503 }));
    const p = Promise.resolve().then(fn); // dueño antes de ejecutar o ceder el control
    this._deviceWork.add(p);
    const done = () => this._deviceWork.delete(p);
    p.then(done, done);
    return p;
  }

  _deviceDelay(ms) {
    if (this._deviceClosing) return Promise.resolve(false);
    return new Promise(resolve => {
      const wait = { timer: null, done: ready => {
        clearTimeout(wait.timer);
        this._deviceWaits.delete(wait);
        resolve(ready);
      } };
      this._deviceWaits.add(wait);
      wait.timer = setTimeout(() => wait.done(true), ms);
    });
  }

  // Solo Device Flow: no corta refresh/HELIX ni acciones salientes (08b.2b.2a).
  quiesceDeviceFlow() {
    if (this._deviceQuiesce) return this._deviceQuiesce;
    this._deviceClosing = true;
    for (const wait of this._deviceWaits) wait.done(false);
    this._deviceQuiesce = this._drainDeviceFlow();
    return this._deviceQuiesce;
  }

  async _drainDeviceFlow() {
    const results = await Promise.allSettled([...this._deviceWork]);
    this.setStatus({ device: null });
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'No se pudo cerrar la autorización de Twitch.');
  }

  startDeviceLogin() { return this._deviceTask(() => this._startDeviceLogin()); }

  async _startDeviceLogin() {
    if (!this.clientId) throw new Error('Falta el Client ID de tu app de Twitch (dev.twitch.tv).');
    const r = await post(`${ID}/device`, { client_id: this.clientId, scopes: SCOPES.join(' ') });
    if (!r.ok) throw new Error(`Twitch rechazó el inicio de sesión: ${r.data.message || r.status}`);
    const d = r.data;
    const info = { code: d.user_code, url: d.verification_uri, expiresAt: Date.now() + d.expires_in * 1000 };
    if (this._deviceClosing) return info;
    this.setStatus({ state: 'esperando autorización', device: info });
    this.pollDevice(d).catch(err => { if (!this._deviceClosing) this.fail(err); });
    return info;
  }

  pollDevice(d) { return this._deviceTask(() => this._pollDevice(d)); }

  async _pollDevice(d) {
    const until = Date.now() + d.expires_in * 1000;
    let interval = (d.interval || 5) * 1000;
    while (Date.now() < until) {
      const ready = await this._deviceDelay(interval);
      if (!ready || this._deviceClosing) return;
      const r = await post(`${ID}/token`, {
        client_id: this.clientId,
        scopes: SCOPES.join(' '),
        device_code: d.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (r.ok) {
        await this.saveToken(r.data); // solicitud ya admitida: no descartar el token al cortar
        if (this._deviceClosing) return;
        this.setStatus({ device: null });
        return this.start();
      }
      const msg = r.data.message || '';
      if (this._deviceClosing && (msg === 'authorization_pending' || msg === 'slow_down')) return;
      if (msg === 'authorization_pending') continue;
      if (msg === 'slow_down') { interval += 5000; continue; }
      throw new Error(`No se completó la autorización: ${msg || r.status}`);
    }
    throw new Error('El código de Twitch ha caducado. Vuelve a pulsar «Conectar».');
  }

  // Registrar antes de ejecutar, sin diferir los efectos síncronos de la operación.
  _authTask(fn) {
    let resolve, reject;
    const p = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    this._authWork.add(p);
    const done = () => this._authWork.delete(p);
    p.then(done, done);
    try { resolve(fn()); } catch (err) { reject(err); }
    return p;
  }

  // Snapshot no terminal: incluye continuaciones esperadas, no productores tardíos.
  // Sin deadline ni historial; el caller debe controlar admisión y tiempo de espera.
  async drainAuth() {
    const results = await Promise.allSettled([...this._authWork]);
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'No se pudo drenar la autenticación de Twitch.');
  }

  saveToken(t) {
    try { return this._authTask(() => this._saveToken(t)); }
    catch (err) { return Promise.reject(err); }
  }

  async _saveToken(t) {
    await this.store.setSecret('twitch', {
      access: t.access_token,
      refresh: t.refresh_token,
      expiresAt: Date.now() + (t.expires_in || 0) * 1000,
    });
  }

  refresh() {
    try { return this._authTask(() => this._refresh()); }
    catch (err) { return Promise.reject(err); }
  }

  async _refresh() {
    const tok = this.token;
    if (!tok?.refresh) throw new Error('No hay sesión de Twitch. Pulsa «Conectar».');
    const r = await post(`${ID}/token`, { client_id: this.clientId, grant_type: 'refresh_token', refresh_token: tok.refresh });
    if (!r.ok) {
      await this.store.setSecret('twitch', undefined);
      throw new Error('La sesión de Twitch ha caducado. Vuelve a conectar.');
    }
    await this.saveToken(r.data);
  }

  validate() {
    try { return this._authTask(() => this._validate()); }
    catch (err) { return Promise.reject(err); }
  }

  async _validate() {
    const res = await fetch(`${ID}/validate`, { headers: { Authorization: `OAuth ${this.token.access}` } });
    if (res.status === 401) { await this.refresh(); return this.validate(); }
    if (!res.ok) throw new Error(`No se pudo validar el token (${res.status})`);
    return res.json();
  }

  helix(method, pathname, body) {
    try { return this._authTask(() => this._helix(method, pathname, body)); }
    catch (err) { return Promise.reject(err); }
  }

  async _helix(method, pathname, body) {
    const doit = () => fetch(HELIX + pathname, {
      method,
      headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${this.token.access}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let res = await doit();
    if (res.status === 401) { await this.refresh(); res = await doit(); }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // ---------- EventSub ----------
  start() {
    // Un WS conectando o vivo conserva su epoch y la admisión de notificaciones.
    if (this._terminal || (!this.stopped && this.ws?.readyState < 2)) return Promise.resolve();
    return this._track(this._start());
  }

  async _start() {
    if (!this.clientId || !this.token) { this.setStatus({ state: 'desconectado' }); return; }
    this.stopped = false;
    const epoch = ++this._epoch;
    try {
      const v = await this.validate();
      if (this._terminal || this.stopped || epoch !== this._epoch) return;
      this.userId = v.user_id;
      this.setStatus({ user: v.login, userId: v.user_id, scopes: v.scopes || [], state: 'conectando', errors: [] });
      this.connect(EVENTSUB_WS);
    } catch (err) { if (!this._terminal && !this.stopped && epoch === this._epoch) this.fail(err); }
  }

  stop(options) {
    try { return this._authTask(() => this._stop(options)); }
    catch (err) { return Promise.reject(err); }
  }

  async _stop({ forget = false } = {}) {
    this.stopped = true;
    this._epoch += 1;
    clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    for (const wait of this._retryWaits ?? []) { clearTimeout(wait.timer); wait.resolve(false); }
    this._retryWaits?.clear();
    for (const ws of new Set([...this._sockets, this.ws, this.pending])) {
      try { this._requestSocketClose(ws); } catch {}
    }
    this.ws = null; this.pending = null;
    if (forget) await this.store.setSecret('twitch', undefined);
    this.setStatus({ state: 'desconectado', user: forget ? null : this.status.user, subscriptions: [], device: null });
  }

  // Corte terminal solo de EventSub (08b.2b.1): caché idempotente, gana a start/connect/welcome/onclose.
  // No cubre auth de dispositivo, IO de secretos ni acciones salientes: eso sigue siendo 08b.2b/08c.
  quiesceEventSub() {
    if (this._quiesce) return this._quiesce;
    this._terminal = true; this.stopped = true; this._epoch += 1;
    this._quiesce = this._runQuiesce();
    return this._quiesce;
  }

  // Compartido por stop, handoff, keepalive y corte terminal; no repite el handshake.
  _requestSocketClose(ws) {
    if (!ws || ws.readyState >= 2 || this._socketCloseRequested.has(ws)) return;
    this._socketCloseRequested.add(ws);
    try { ws.close(); }
    catch (err) { this._socketCloseRequested.delete(ws); throw err; }
  }

  // close() inicia el handshake: registrar close antes de llamarlo y conservar la espera
  // también si el socket ya estaba CLOSING. El deadline del caller limita un cierre bloqueado.
  _closeSocket(ws) {
    if (!ws || ws.readyState === 3) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const closed = () => { ws.removeEventListener('close', closed); resolve(); };
      try {
        ws.addEventListener('close', closed, { once: true });
        this._requestSocketClose(ws);
      } catch (err) { ws.removeEventListener('close', closed); reject(err); }
    });
  }

  async _runQuiesce() {
    clearTimeout(this.keepaliveTimer); this.keepaliveTimer = null;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    for (const wait of this._retryWaits ?? []) { clearTimeout(wait.timer); wait.resolve(false); }
    this._retryWaits?.clear();
    const work = [...this._tracked];
    const closing = [...new Set([...this._sockets, this.ws, this.pending])].map(ws => this._closeSocket(ws));
    this.ws = null; this.pending = null;
    const results = await Promise.allSettled([...work, ...closing]);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), 'No se pudo cerrar EventSub.');
    this.setStatus({ state: 'desconectado', subscriptions: [], device: null });
  }

  connect(url, { isReconnect = false } = {}) {
    if (this._terminal || this.stopped) return;
    const epoch = this._epoch;
    const ws = new WebSocket(url);
    this._sockets.add(ws);
    ws.addEventListener('close', () => this._sockets.delete(ws), { once: true });
    ws._egEpoch = epoch;
    const old = this.ws;
    ws.onmessage = ev => {
      try { return this.onMessage(ws, JSON.parse(ev.data), { isReconnect, old }); }
      catch { this.log('[twitch] mensaje de Twitch no válido'); }
    };
    ws.onclose = () => {
      if (ws !== this.ws || this.stopped || this._terminal || epoch !== this._epoch) return;
      this.setStatus({ state: 'reconectando' });
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => { if (!this.stopped && !this._terminal && epoch === this._epoch) this.connect(EVENTSUB_WS); }, 3000);
    };
    ws.onerror = () => {};
    if (!isReconnect) this.ws = ws;
    else this.pending = ws;
  }

  armKeepalive() {
    if (this._terminal || this.stopped) return;
    clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.log('[twitch] sin keepalive, reconectando');
      try { this._requestSocketClose(this.ws); } catch {}
    }, this.keepaliveMs);
  }

  onMessage(ws, msg, ctx) { return this._track(this._handleMessage(ws, msg, ctx)); }

  async _handleMessage(ws, msg, { isReconnect, old } = {}) {
    const epoch = ws?._egEpoch ?? this._epoch;
    if (this._terminal || this.stopped || epoch !== this._epoch) return;
    const type = msg.metadata?.message_type;
    if (type === 'session_welcome') {
      const s = msg.payload.session;
      this.keepaliveMs = ((s.keepalive_timeout_seconds || 30) + 10) * 1000;
      if (isReconnect) {
        if (ws !== this.pending) return;
        // Twitch mantiene las suscripciones; cerramos la conexión vieja.
        this.ws = ws; this.pending = null;
        try { this._requestSocketClose(old); } catch {}
        this.setStatus({ state: 'conectado' });
      } else {
        if (ws !== this.ws) return;
        await this.subscribeAll(s.id, epoch);
      }
      if (this._terminal || this.stopped || epoch !== this._epoch) return;
      this.armKeepalive();
      return;
    }
    if (ws !== this.ws) return;
    this.armKeepalive();
    if (type === 'session_reconnect') {
      this.connect(msg.payload.session.reconnect_url, { isReconnect: true });
    } else if (type === 'notification') {
      this.emitEvent(msg.metadata.message_id, msg.payload.subscription.type, msg.payload.event);
    } else if (type === 'revocation') {
      this.pushError(`Twitch revocó ${msg.payload.subscription.type} (${msg.payload.subscription.status})`);
    }
  }

  emitEvent(messageId, subType, event) {
    const n = normalizeTwitch(subType, event);
    try { this.rawLog?.record('twitch', subType, !!n, event); } catch {}
    if (n) this.emit('event', { externalId: 'tw:' + messageId, ...n });
  }

  async subscribeAll(sessionId, epoch = this._epoch) {
    const me = this.userId;
    const subs = [
      ['channel.follow', '2', { broadcaster_user_id: me, moderator_user_id: me }],
      ['channel.subscribe', '1', { broadcaster_user_id: me }],
      ['channel.subscription.message', '1', { broadcaster_user_id: me }],
      ['channel.subscription.gift', '1', { broadcaster_user_id: me }],
      ['channel.cheer', '1', { broadcaster_user_id: me }],
      ['channel.bits.use', '1', { broadcaster_user_id: me }],   // #130: Power-ups (bits without channel.cheer)
      ['channel.raid', '1', { to_broadcaster_user_id: me }],
      ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: me }],
    ];
    const ok = [];
    const errors = [];
    for (const [type, version, condition] of subs) {
      const r = await this._subscribeWithRetry(type, version, condition, sessionId, epoch);
      if (this._terminal || this.stopped || epoch !== this._epoch) return;
      if (r.ok || r.status === 409) ok.push(type);
      else errors.push(`${type}: ${r.data.message || r.status}`);
    }
    if (this._terminal || this.stopped || epoch !== this._epoch) return;
    this.setStatus({ state: 'conectado', subscriptions: ok, errors });
    if (errors.length) this.log('[twitch] suscripciones con error:', errors.join(' | '));
  }

  // Reintento acotado de una suscripción fallida (issue #64): hasta retryMaxAttempts
  // intentos con espera entre ellos, sin reconectar. Solo se reintenta si el fallo es
  // transitorio (429, 5xx o red); un 4xx permanente no se reintenta. Un stop o corte
  // cancela la espera y abandona el reintento.
  async _subscribeWithRetry(type, version, condition, sessionId, epoch) {
    let r = null;
    for (let attempt = 1; attempt <= this.retryMaxAttempts; attempt += 1) {
      if (this._terminal || this.stopped || epoch !== this._epoch) return r;
      if (attempt > 1) this.log(`[twitch] reintentando ${type} (${attempt}/${this.retryMaxAttempts})`);
      try {
        r = await this.helix('POST', '/eventsub/subscriptions', { type, version, condition, transport: { method: 'websocket', session_id: sessionId } });
      } catch (err) {
        if (this._terminal || this.stopped || epoch !== this._epoch) throw err;
        // Fallo de red: transitorio, se reintenta con la misma espera.
        r = { ok: false, status: 0, data: { message: `red: ${err.message}` } };
      }
      if (this._terminal || this.stopped || epoch !== this._epoch) return r;
      if (r.ok || r.status === 409) return r;
      if (r.status !== 429 && (r.status >= 400 && r.status < 500)) return r; // 4xx permanente
      if (attempt === this.retryMaxAttempts) return r;
      const wait = await this._retryDelay(this.retryDelayMs);
      if (!wait || this._terminal || this.stopped || epoch !== this._epoch) return r;
    }
    return r;
  }

  // Espera entre reintentos, cancelable: false si hay que abandonar el reintento.
  // stop/quiesce resuelven las esperas pendientes con false; nunca quedan colgadas.
  _retryDelay(ms) {
    return new Promise(resolve => {
      const wait = { timer: null, resolve: null };
      wait.resolve = ok => { clearTimeout(wait.timer); (this._retryWaits ??= new Set()).delete(wait); resolve(ok); };
      wait.timer = setTimeout(() => wait.resolve(true), ms);
      (this._retryWaits ??= new Set()).add(wait);
    });
  }

  /** Escribe en tu chat de Twitch como tu cuenta (permiso user:write:chat). */
  async sendChat(message) {
    if (!this.token || !this.userId) throw new Error('Conecta Twitch para poder escribir en el chat.');
    const text = String(message || '').trim().slice(0, 500);
    if (!text) return null;
    const r = await this.helix('POST', '/chat/messages', { broadcaster_id: this.userId, sender_id: this.userId, message: text });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Falta el permiso para escribir en el chat: vuelve a conectar Twitch.' : `Twitch no envió el mensaje: ${r.data.message || r.status}`);
    const d = r.data.data?.[0];
    if (d && !d.is_sent) throw new Error(`Twitch no envió el mensaje: ${d.drop_reason?.message || 'rechazado'}`);
    return d;
  }

  /** Anuncio destacado en tu chat (permiso moderator:manage:announcements). color: primary|blue|green|orange|purple */
  async sendAnnouncement(message, color = 'primary') {
    if (!this.token || !this.userId) throw new Error('Conecta Twitch para poder escribir en el chat.');
    const text = String(message || '').trim().slice(0, 500);
    if (!text) return null;
    const c = ['primary', 'blue', 'green', 'orange', 'purple'].includes(color) ? color : 'primary';
    const r = await this.helix('POST', `/chat/announcements?broadcaster_id=${this.userId}&moderator_id=${this.userId}`, { message: text, color: c });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Falta el permiso de anuncios: vuelve a conectar Twitch.' : `Twitch no publicó el anuncio: ${r.data.message || r.status}`);
    return { announced: true, color: c };
  }

  /** Marcador del directo en Twitch (permiso channel:manage:broadcast). Solo funciona emitiendo. */
  async createMarker(description = '') {
    if (!this.token || !this.userId) throw new Error('Twitch no está conectado.');
    const r = await this.helix('POST', '/streams/markers', { user_id: this.userId, description: String(description || '').slice(0, 140) });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Falta el permiso de marcadores: vuelve a conectar Twitch.' : r.status === 404 ? 'Twitch solo crea marcadores mientras emites.' : `Twitch no creó el marcador: ${r.data.message || r.status}`);
    return r.data.data?.[0] || null;
  }

  pushError(e) { this.setStatus({ errors: [...this.status.errors, e].slice(-10) }); }

  fail(err) {
    this.log('[twitch]', err.message);
    this.setStatus({ state: 'error', device: null, errors: [...this.status.errors, err.message].slice(-10) });
  }
}

async function post(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
