// YouTube: busca el chat del directo y lo sondea con la Data API v3 (API key o tu cuenta).
// Para escribir en el chat hace falta tu cuenta: OAuth de Google con una app «de escritorio» (vuelta a 127.0.0.1).
// Cuota: cada lectura del chat cuesta ~5 unidades; con 10.000/día y 8 s entre lecturas da para ~4 h.
import { EventEmitter } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { normalizeYouTube, youtubeChatMessage } from './alerts.mjs';

const API = 'https://www.googleapis.com/youtube/v3';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

export function parseVideoId(input = '') {
  const s = String(input).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/|\/embed\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export class YouTube extends EventEmitter {
  constructor(store, log = console.log) {
    super();
    this.store = store;
    this.log = log;
    this.timer = null;
    this.running = false;
    this.pollClosed = false;
    this.pollWork = new Set();
    this.pollClosePromise = null;
    this.status = { state: 'parado', videoId: null, liveChatId: null, title: null, errors: [], polls: 0, account: store.secrets?.youtube?.channel || null };
    this.pending = new Map(); // state → { verifier, redirect }
    this.rawLog = null; // RawEventLog opcional (src/raw-events.mjs)
  }

  get token() { return this.store.secrets.youtube; }

  // ---------- cuenta (OAuth) ----------
  /** URL de Google para dar permiso. redirect = http://127.0.0.1:<puerto>/oauth/youtube */
  authUrl(redirect) {
    if (!this.cfg.clientId || !this.cfg.clientSecret) throw new Error('Falta el Client ID y el Client secret de tu app de Google (Conexiones › YouTube).');
    const state = randomBytes(12).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { verifier, redirect, at: Date.now() });
    const u = new URL(AUTH);
    for (const [k, v] of Object.entries({ client_id: this.cfg.clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) u.searchParams.set(k, v);
    return u.toString();
  }
  async finishAuth(code, state) {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > 15 * 60_000) throw new Error('El permiso ha caducado: vuelve a pulsar «Conectar cuenta».');
    const t = await this.tokenCall({ code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: p.redirect, grant_type: 'authorization_code', code_verifier: p.verifier });
    await this.store.setSecret('youtube', { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000 });
    let channel = null;
    try { const d = await this.api('/channels', { part: 'snippet', mine: 'true' }, { auth: true }); channel = d.items?.[0]?.snippet?.title || null; } catch {}
    await this.store.setSecret('youtube', { ...this.token, channel });
    this.setStatus({ account: channel || 'tu cuenta' });
    this.log(`[youtube] cuenta conectada: ${channel || '(sin nombre)'}`);
    return channel;
  }
  async logout() {
    const t = this.token;
    if (t?.refresh) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t.refresh), { method: 'POST' }).catch(() => {});
    await this.store.setSecret('youtube', undefined);
    this.setStatus({ account: null });
  }
  async tokenCall(params) {
    const res = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google no dio el permiso: ${d.error_description || d.error || res.status}`);
    return d;
  }
  async accessToken() {
    const t = this.token;
    if (!t?.access) throw new Error('Conecta tu cuenta de YouTube (Conexiones › YouTube) para escribir en el chat.');
    if (Date.now() < (t.expiresAt || 0)) return t.access;
    const r = await this.tokenCall({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: t.refresh, grant_type: 'refresh_token' });
    await this.store.setSecret('youtube', { ...t, access: r.access_token, expiresAt: Date.now() + (r.expires_in - 60) * 1000 });
    return r.access_token;
  }

  /** Escribe en el chat del directo que se está escuchando (cuesta ~50 unidades de cuota). */
  async sendChat(message) {
    const text = String(message || '').trim().slice(0, 200);
    if (!text) return null;
    if (!this.status.liveChatId) throw new Error('Primero pon a escuchar el chat de YouTube (Conexiones › YouTube).');
    const d = await this.api('/liveChat/messages', { part: 'snippet' }, { auth: true, method: 'POST',
      body: { snippet: { liveChatId: this.status.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } } });
    return { id: d.id, sent: true };
  }

  get cfg() { return this.store.config.youtube; }

  setStatus(patch, identityEpoch = this.identityEpoch?.()) {
    this.status = { ...this.status, ...patch };
    // Solo el hallazgo del vídeo confirma su identidad; un poll del chat no la renueva.
    const discovery = typeof patch.videoId === 'string' && !!patch.videoId;
    this.emit('status', this.status, identityEpoch, discovery);
  }

  async api(pathname, params, { auth = false, method = 'GET', body } = {}) {
    const url = new URL(API + pathname);
    // con API key se lee sin cuenta; si no hay key pero sí cuenta, se usa la cuenta
    const useAuth = auth || (!this.cfg.apiKey && this.token?.access);
    for (const [k, v] of Object.entries({ ...params, key: useAuth ? undefined : this.cfg.apiKey })) if (v !== undefined) url.searchParams.set(k, v);
    const headers = {};
    if (useAuth) headers.Authorization = 'Bearer ' + await this.accessToken();
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error?.errors?.[0]?.reason || data.error?.status || res.status;
      const err = new Error(explain(reason, data.error?.message));
      err.reason = reason;
      throw err;
    }
    return data;
  }

  async findLiveVideo() {
    const fromCfg = parseVideoId(this.cfg.video);
    if (fromCfg) return fromCfg;
    if (!this.cfg.channelId) throw new Error('Indica el vídeo del directo o el ID de tu canal (UC…).');
    // search.list cuesta 100 unidades: solo una vez por directo.
    const d = await this.api('/search', { part: 'id', channelId: this.cfg.channelId, eventType: 'live', type: 'video', maxResults: 1 });
    const id = d.items?.[0]?.id?.videoId;
    if (!id) throw Object.assign(new Error('No hay ningún directo en marcha en el canal.'), { reason: 'noLive' });
    return id;
  }

  // Register before invoking work: synchronous listeners may request shutdown.
  trackPollWork(operation) {
    if (this.pollClosed) return Promise.resolve();
    const work = Promise.resolve().then(operation);
    this.pollWork.add(work);
    work.then(() => this.pollWork.delete(work), () => this.pollWork.delete(work));
    return work;
  }

  quiescePoll() {
    if (this.pollClosePromise) return this.pollClosePromise;
    this.pollClosed = true;
    this.running = false;
    clearTimeout(this.timer);
    const pending = [...this.pollWork];
    // Defer status emission until the cached promise exists for reentrant listeners.
    this.pollClosePromise = Promise.resolve().then(async () => {
      const status = Promise.resolve().then(() => {
        if (this.status.state !== 'error') this.setStatus({ state: 'parado' });
      });
      const results = await Promise.allSettled([...pending, status]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'No se pudo cerrar el productor YouTube');
    });
    return this.pollClosePromise;
  }

  start(video) {
    const identityEpoch = this.identityEpoch?.();
    return this.trackPollWork(() => this.startPoll(video, identityEpoch));
  }

  async startPoll(video, identityEpoch = this.identityEpoch?.()) {
    if (this.pollClosed) return;
    if (!this.cfg.apiKey && !this.token?.access) throw new Error('Falta la API key de YouTube (o conecta tu cuenta).');
    await this.stop();
    if (this.pollClosed) return;
    this.running = true;
    this.setStatus({ state: 'buscando directo', errors: [], polls: 0, notice: null, retryAt: null });
    if (this.pollClosed) return;
    try {
      const videoId = video ? parseVideoId(video) : await this.findLiveVideo();
      if (this.pollClosed) return;
      if (!videoId) throw new Error('No reconozco ese enlace de vídeo.');
      const d = await this.api('/videos', { part: 'liveStreamingDetails,snippet', id: videoId });
      if (this.pollClosed) return;
      const item = d.items?.[0];
      const liveChatId = item?.liveStreamingDetails?.activeLiveChatId;
      if (!liveChatId) throw Object.assign(new Error('Ese vídeo no tiene un chat en directo activo.'), { reason: 'noLiveChat' });
      this.setStatus({ state: 'escuchando', videoId, liveChatId, title: item.snippet?.title }, identityEpoch);
      this.pageToken = null;
      this.primed = false;
      this.poll();
    } catch (err) { this.fail(err); }
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.status.state !== 'error') this.setStatus({ state: 'parado', notice: null });
  }

  poll() { return this.trackPollWork(() => this.pollOnce()); }

  // Errores definitivos: detienen el sondeo. Cuota y permisos son temporales: se reintentan.
  static FATAL = ['liveChatEnded', 'liveChatNotFound', 'liveChatDisabled'];

  // Programa el reintento tras un error temporal: espera creciente (cuota desde 1 min hasta
  // 10 min; resto desde 20 s hasta 5 min) y aviso en el estado. El pageToken se conserva.
  retry(err, base, cap) {
    this.retries = (this.retries || 0) + 1;
    const wait = Math.min(base * 2 ** (this.retries - 1), cap);
    this.log('[youtube]', `${err.message} Reintento en ${Math.round(wait / 1000)} s.`);
    // En un corte ordenado (quiescePoll) el estado ya es «parado»: no lo sobreescribimos.
    if (this.running) this.setStatus({
      state: 'en espera',
      notice: `${err.message} Reintento automático programado.`,
      retryAt: new Date(Date.now() + wait).toISOString(),
    });
    return wait;
  }

  async pollOnce() {
    if (this.pollClosed || !this.running) return;
    const identityEpoch = this.identityEpoch?.(); // la petición puede terminar en otro directo
    let wait = Math.max(5, Number(this.cfg.pollSeconds) || 8) * 1000;
    try {
      const d = await this.api('/liveChat/messages', {
        liveChatId: this.status.liveChatId,
        part: 'snippet,authorDetails',
        maxResults: 200,
        pageToken: this.pageToken || undefined,
      });
      this.pageToken = d.nextPageToken;
      wait = Math.max(wait, d.pollingIntervalMillis || 0);
      // La primera lectura trae mensajes antiguos: no se alertan, pero sí se registran
      // en bruto (handled=false) para poder diagnosticar qué envía YouTube.
      for (const item of d.items || []) {
        let handled = false;
        if (this.primed) {
          const n = normalizeYouTube(item);
          if (n) this.emit('event', { externalId: 'yt:' + item.id, ...n });
          const c = youtubeChatMessage(item);
          if (c) this.emit('chat', c);
          handled = !!(n || c);
        }
        try { this.rawLog?.record('youtube', item?.snippet?.type, handled, item); } catch {}
      }
      this.primed = true;
      // El aviso de espera se retira en cuanto la lectura vuelve a funcionar.
      this.retries = 0;
      const recovered = this.status.state === 'en espera';
      this.setStatus({ polls: this.status.polls + 1, lastPoll: new Date().toISOString(),
        ...(recovered ? { state: 'escuchando', notice: null, retryAt: null } : {}) }, identityEpoch);
    } catch (err) {
      // El pageToken se conserva (como en main): descartarlo haría que el reintento vuelva
      // a traer los últimos mensajes ya procesados y los reemitiera como alertas y chat.
      if (YouTube.FATAL.includes(err.reason)) return this.fail(err);
      // Cuota agotada y permisos denegados son temporales: espera creciente, sin parar el sondeo.
      if (['quotaExceeded', 'forbidden'].includes(err.reason)) {
        wait = err.reason === 'quotaExceeded' ? this.retry(err, 60_000, 600_000) : this.retry(err, 20_000, 300_000);
      } else {
        this.log('[youtube]', err.message);
        wait = 20_000;
      }
    }
    if (this.running) this.timer = setTimeout(() => this.poll(), wait);
  }

  fail(err) {
    this.lastError = err; // #73: la conexión automática decide si reintentar según el motivo
    this.running = false;
    clearTimeout(this.timer);
    this.log('[youtube]', err.message);
    this.setStatus({ state: 'error', errors: [...this.status.errors, err.message].slice(-10) });
  }
}

function explain(reason, msg) {
  return ({
    quotaExceeded: 'Se ha agotado la cuota diaria de la API de YouTube (se renueva a las 9:00 en España).',
    liveChatEnded: 'El chat del directo ha terminado.',
    liveChatNotFound: 'No se encuentra el chat del directo.',
    liveChatDisabled: 'El chat de ese directo está desactivado.',
    keyInvalid: 'La API key de YouTube no es válida.',
    forbidden: 'YouTube no deja leer o escribir en ese chat con estos permisos.',
    insufficientPermissions: 'Falta el permiso para escribir: vuelve a conectar tu cuenta de YouTube.',
    rateLimitExceeded: 'YouTube: estás escribiendo demasiado rápido, espera un poco.',
  })[reason] || `YouTube: ${msg || reason}`;
}
