// Récord de espectadores a la vez, por plataforma (Twitch y YouTube por separado).
//
// Cada `pollSec` se lee cuánta gente hay viendo:
//   - Twitch: GET /helix/streams?user_id=… → viewer_count (sin directo, no hay fila).
//   - YouTube: videos.list part=liveStreamingDetails (1 unidad de cuota) → concurrentViewers.
// El récord histórico se guarda en config.viewers.records y SIEMPRE sube en silencio. Lo que
// se limita es la ALERTA, para que no se convierta en spam cuando la cifra baila:
//   1. Confirmación: el valor que cuenta es el mínimo de las últimas `confirmPolls` lecturas
//      (un pico de una sola lectura no es récord).
//   2. Salto mínimo: solo se anuncia si supera lo último anunciado (o el récord con el que
//      empezó el directo) en max(minStep, minStepPct %). 41 → 42 no sale; 41 → 46 sí.
//   3. Mínimo absoluto: por debajo de `minViewers` no se anuncia nada.
//   4. Calentamiento: los primeros `warmupMin` minutos del directo no se anuncia (la cifra
//      arranca a saltos); si se bate el récord, queda pendiente y sale al terminar.
//   5. Espera entre alertas: `cooldownMin` por plataforma; lo que se bata mientras tanto queda
//      pendiente y sale UNA vez, con la cifra más alta, al acabar la espera.
//   6. Sin récord previo (primera vez): se toma como punto de partida en silencio, salvo
//      `alertFirst`.
import { EventEmitter } from 'node:events';

export const VIEWER_ALERT = { twitch: 'viewers', youtube: 'ytviewers' };
export const VIEWER_PLATFORMS = Object.keys(VIEWER_ALERT);

export const DEFAULT_VIEWERS = {
  enabled: true,
  pollSec: 60,
  minViewers: 5,
  confirmPolls: 2,
  minStep: 3,
  minStepPct: 10,
  cooldownMin: 15,
  warmupMin: 5,
  alertFirst: false,
  records: { twitch: 0, youtube: 0 },
};

const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// Sin dato no es cero. La identidad de un directo puede ser válida sin su cifra.
function viewerCount(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

/** Cuánto hay que superar `base` para que merezca alerta. */
export function nextAnnounce(base, cfg) {
  const b = Math.max(0, n(base, 0));
  return b + Math.max(1, Math.round(n(cfg.minStep, 3)), Math.ceil(b * n(cfg.minStepPct, 10) / 100));
}

function freshState() {
  return { live: false, current: null, peak: 0, liveSince: null, window: [], base: null, lastAlertAt: 0, lastAlertValue: null, pending: false, alerts: 0, updatedAt: null, error: null };
}

export class ViewerWatch extends EventEmitter {
  /**
   * @param {object} o
   * @param {{config: object, save: Function}} o.store
   * @param {object} [o.twitch]  cliente de src/twitch.mjs (helix, userId)
   * @param {object} [o.youtube] cliente de src/youtube.mjs (api, status.videoId)
   * @param {{handleEvent: Function}} [o.engine]
   * @param {Record<string, () => Promise<{live: boolean, viewers?: number}>>} [o.readers] lectores inyectables (tests)
   */
  constructor({ store, twitch, youtube, engine, log = () => {}, now = Date.now, readers, initialDelayMs = 3000 } = {}) {
    super();
    this.store = store; this.twitch = twitch; this.youtube = youtube; this.engine = engine; this.log = log; this.now = now;
    this.readers = readers || { twitch: () => this.readTwitch(), youtube: () => this.readYouTube() };
    this.initialDelayMs = initialDelayMs;   // primera lectura tras arrancar (inyectable en tests)
    this.state = Object.fromEntries(VIEWER_PLATFORMS.map(p => [p, freshState()]));
    this.handle = null;
    this.busy = null;
  }

  get cfg() {
    const c = this.store.config.viewers || {};
    return { ...DEFAULT_VIEWERS, ...c, records: { ...DEFAULT_VIEWERS.records, ...(c.records || {}) } };
  }

  // ---------- lectura de cada plataforma ----------
  async readTwitch() {
    const t = this.twitch;
    if (!t?.userId || !t.token) return { live: false, off: true };
    const r = await t.helix('GET', `/streams?user_id=${encodeURIComponent(t.userId)}`);
    if (!r.ok) throw new Error(`Twitch respondió ${r.status} al leer los espectadores`);
    const row = r.data?.data?.[0];
    return row ? { live: true, viewers: viewerCount(row.viewer_count),
      ...(row.id ? { streamId: row.id } : {}), ...(row.started_at ? { startedAt: row.started_at } : {}) } : { live: false };
  }

  async readYouTube() {
    const y = this.youtube;
    const id = y?.status?.videoId;
    if (!id || !['escuchando', 'en espera'].includes(y.status.state)) return { live: false, off: true };
    const d = await y.api('/videos', { part: 'liveStreamingDetails', id });
    const det = d.items?.[0]?.liveStreamingDetails;
    // Un directo terminado no es lo mismo que una lectura sin cifra.
    if (!det || det.actualEndTime) return { live: false };
    return { live: true, viewers: viewerCount(det.concurrentViewers) };
  }

  // ---------- ciclo ----------
  start() {
    this.stop();
    this.stopped = false; this.started = true; this.halted = false;
    const every = Math.min(600, Math.max(20, n(this.cfg.pollSec, 60))) * 1000;
    this.handle = setInterval(() => { this.tick().catch(() => {}); }, every);
    this.handle.unref?.();
    this.every = every;
    // Primera lectura poco después de arrancar. Rastreada: stop() la cancela, para que
    // un stop/halt antes de esa lectura no lea plataformas ni guarde config (revisión #142).
    this.initialHandle = setTimeout(() => { this.tick().catch(() => {}); }, this.initialDelayMs);
    this.initialHandle.unref?.();
  }
  stop() {
    if (this.handle) clearInterval(this.handle); this.handle = null;
    if (this.initialHandle) { clearTimeout(this.initialHandle); this.initialHandle = null; }
    this.stopped = true;
  }
  /** Parada definitiva (apagado de la app): refresh ya no la reanimará y no salen más alertas. */
  halt() { this.stop(); this.halted = true; }
  /** Reprograma tras guardar ajustes (revisión #142): reanuda también un watcher iniciado que
   *  estuviera parado; tras halt() (apagado) nunca vuelve a arrancar. */
  refresh() { if (this.started && !this.halted) this.start(); }

  /** Una pasada por las dos plataformas. Devuelve las alertas que ha disparado. */
  tick() {
    if (this.halted) return Promise.resolve([]);   // app cerrándose: nunca se lee ni se guarda
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const fired = [];
      const twitchIdentity = (r, epoch) => this.emit('streamIdentity', r.live && r.streamId ? { streamId: r.streamId, startedAt: r.startedAt } : null, epoch);
      // Aunque el récord esté desactivado, el directo automático necesita la fila
      // de Twitch. Se consulta sin actualizar snapshots, récords ni alertas.
      if (this.cfg.enabled === false) {
        if (!this.identityEnabled?.()) return fired;
        const epoch = this.identityEpoch?.();
        try {
          const r = await this.readTwitch();
          twitchIdentity(r, epoch);
        } catch { /* el siguiente sondeo reintenta sin activar las métricas */ }
        return fired;
      }
      for (const p of VIEWER_PLATFORMS) {
        let r;
        const epoch = this.identityEpoch?.(p); // captura antes de iniciar la petición
        const videoId = p === 'youtube' ? this.youtube?.status?.videoId : undefined;
        const intervalSec = this.handle ? this.every / 1000 : Math.min(600, Math.max(20, n(this.cfg.pollSec, 60)));
        try {
          r = await this.readers[p]();
          if (r.live && viewerCount(r.viewers) === null) {
            // La fila identifica el directo aunque el contador no esté disponible.
            if (p === 'twitch') twitchIdentity(r, epoch);
            throw new Error(`${p === 'twitch' ? 'Twitch' : 'YouTube'} no informa del número de espectadores`);
          }
          this.state[p].error = null;
        } catch (err) {
          this.state[p].error = err.message;
          this.emit('seriesObservation', p, { at: new Date(this.now()).toISOString(), intervalSec, reason: 'error' }, epoch);
          continue;
        }
        const at = new Date(this.now()).toISOString();
        // La fila real también identifica el directo; no se añade al snapshot de espectadores.
        if (p === 'twitch') twitchIdentity(r, epoch);
        const a = this.observe(p, r);
        this.emit('seriesObservation', p, r.live
          ? { at, intervalSec, value: this.state[p].current, streamId: r.streamId, videoId }
          : { at, intervalSec, reason: r.off ? 'disconnected' : 'offline' }, epoch);
        if (a) fired.push(a);
      }
      this.emit('change', this.snapshot());
      return fired;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  /** Aplica una lectura y decide. Público para los tests (sin red). */
  observe(platform, { live, viewers, off } = {}) {
    const s = this.state[platform];
    const cfg = this.cfg;
    const now = this.now();
    s.updatedAt = now; s.off = !!off;   // off: la plataforma no está conectada (sin canal o sin directo que escuchar)
    if (!live) {
      if (s.live) this.log(`[espectadores] ${platform}: fin del directo (pico ${s.peak})`);
      Object.assign(this.state[platform], { ...freshState(), updatedAt: now, off: !!off });
      return null;
    }
    if (!s.live) { Object.assign(s, freshState(), { live: true, liveSince: now, updatedAt: now }); }
    const v = Math.max(0, Math.round(n(viewers, 0)));
    s.current = v;
    s.peak = Math.max(s.peak, v);
    s.window.push(v);
    const need = Math.max(1, Math.round(n(cfg.confirmPolls, 2)));
    if (s.window.length > need) s.window.splice(0, s.window.length - need);
    if (s.window.length < need) return this.#maybePending(platform, now);
    const confirmed = Math.min(...s.window);
    const record = n(cfg.records[platform], 0);
    if (confirmed > record) {
      this.#setRecord(platform, confirmed);
      if (s.base === null) {
        // primer récord de este directo: se compara con el que había al empezar
        if (record <= 0 && !cfg.alertFirst) { s.base = confirmed; this.log(`[espectadores] ${platform}: primer récord (${confirmed}), sin alerta`); return null; }
        s.base = record;
      }
      s.pending = true;
    }
    return this.#maybePending(platform, now);
  }

  #maybePending(platform, now) {
    const s = this.state[platform];
    if (!s.pending) return null;
    const cfg = this.cfg;
    const record = n(cfg.records[platform], 0);
    const base = s.base ?? record;
    if (record < nextAnnounce(base, cfg)) return null;                     // salto pequeño: sigue pendiente
    if (record < n(cfg.minViewers, 5)) return null;                        // demasiado poca gente
    if (now - s.liveSince < n(cfg.warmupMin, 5) * 60000) return null;     // calentando
    if (s.lastAlertAt && now - s.lastAlertAt < n(cfg.cooldownMin, 15) * 60000) return null;   // en espera
    s.pending = false;
    s.lastAlertAt = now; s.lastAlertValue = record; s.base = record; s.alerts++;
    return this.#announce(platform, record, base);
  }

  #announce(platform, amount, previous) {
    const type = VIEWER_ALERT[platform];
    if (this.halted) return null;   // app cerrándose: no más alertas
    this.log(`[espectadores] ${platform}: nuevo récord ${amount} (antes ${previous})`);
    const vars = { amount, previous, platform };
    try { this.engine?.handleEvent({ externalId: `viewers:${platform}:${amount}:${this.now()}`, type, vars }); }
    catch (err) { this.log('[espectadores] no se pudo lanzar la alerta:', err.message); }
    return { type, ...vars };
  }

  #setRecord(platform, value) {
    const c = this.store.config;
    c.viewers = { ...DEFAULT_VIEWERS, ...(c.viewers || {}) };
    c.viewers.records = { ...DEFAULT_VIEWERS.records, ...(c.viewers.records || {}), [platform]: value };
    Promise.resolve().then(() => this.store.save('viewers')).catch(err => this.log('[espectadores] no se pudo guardar el récord:', err?.message || err));
  }

  /** Cambia el récord a mano (0 = empezar de cero). No lanza alerta. */
  setRecord(platform, value) {
    if (!VIEWER_PLATFORMS.includes(platform)) throw Object.assign(new Error(`Plataforma desconocida: ${platform}. Usa twitch o youtube.`), { status: 400 });
    const v = Math.max(0, Math.round(Number(value)));
    if (!Number.isFinite(v)) throw Object.assign(new Error('El récord tiene que ser un número'), { status: 400 });
    this.#setRecord(platform, v);
    const s = this.state[platform];
    s.pending = false; s.base = s.live ? v : null; s.window = [];
    this.emit('change', this.snapshot());
    return this.snapshot();
  }

  snapshot() {
    const cfg = this.cfg;
    const platforms = {};
    for (const p of VIEWER_PLATFORMS) {
      const s = this.state[p];
      const record = n(cfg.records[p], 0);
      platforms[p] = {
        live: s.live, off: !!s.off, current: s.current, peak: s.peak, record, liveSince: s.liveSince ? new Date(s.liveSince).toISOString() : null,
        pending: s.pending, alerts: s.alerts, lastAlertAt: s.lastAlertAt ? new Date(s.lastAlertAt).toISOString() : null, lastAlertValue: s.lastAlertValue,
        nextAt: nextAnnounce(s.base ?? record, cfg), updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null, error: s.error,
      };
    }
    const { records: _records, ...settings } = cfg;
    return { settings, platforms };
  }
}
