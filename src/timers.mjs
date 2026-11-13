// Mensajes programados: textos que se publican en el chat cada X minutos (y, si se quiere, también salen en pantalla).
import { randomUUID } from 'node:crypto';
import { DEFAULT_COMMAND, render } from './alerts.mjs';

export const ANNOUNCE_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'];

export const DEFAULT_TIMER = {
  // los campos de alerta (title, text, sub, layout, media, sound…) se usan si showAlert está activo
  ...DEFAULT_COMMAND,
  name: 'Mensaje',
  enabled: true,
  message: '¿Ya sigues el canal? Directos cada miércoles a las 19:00 · egdev.es',
  intervalMin: 15,          // cada cuántos minutos
  minChatLines: 5,          // mensajes en el chat desde la última vez (0 = da igual)
  announce: false,          // publicarlo como anuncio destacado de Twitch
  announceColor: 'primary',
  onlyWhenLive: true,       // solo mientras emites (según Meld; si Meld no está conectado, se bloquea)
  showAlert: false,         // además, sacar una alerta en pantalla
  title: 'Recordatorio', text: 'egdev.es', sub: 'directos cada miércoles a las 19:00',
  durationMs: 6000,
  ttsTemplate: '',
};
delete DEFAULT_TIMER.trigger; delete DEFAULT_TIMER.permission; delete DEFAULT_TIMER.cooldownSec; delete DEFAULT_TIMER.userCooldownSec; delete DEFAULT_TIMER.platforms;

export const TIMER_KEYS = ['name', 'enabled', 'message', 'intervalMin', 'minChatLines', 'announce', 'announceColor', 'onlyWhenLive', 'showAlert', 'destination'];

// Destino del mensaje: sin destino (configuraciones anteriores) sigue saliendo solo por Twitch.
export const TIMER_DESTINATIONS = ['twitch', 'youtube', 'both'];
export const CHAT_LIMITS = { twitch: 500, youtube: 200 };
export const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube' };

/** Plataformas de un timer o de una acción de chat: sin destino, solo Twitch. */
export function timerPlatforms(t) {
  return t.destination === 'both' ? ['twitch', 'youtube'] : t.destination === 'youtube' ? ['youtube'] : ['twitch'];
}

/**
 * Un intento en una plataforma. El texto final que no cabe no se envía (nunca se corta) y un
 * proveedor ausente es un fallo. El error real del proveedor se guarda en `errors`.
 */
export async function sendToPlatform(p, provider, text, { announce = false, color } = {}, errors = []) {
  const kind = p === 'twitch' && announce ? 'announcement' : 'message';
  const length = text.trim().length;
  if (length > CHAT_LIMITS[p]) return { ok: false, kind, error: `el texto no cabe (${length}/${CHAT_LIMITS[p]} caracteres), no se envía ahí` };
  try {
    if (!provider) throw new Error(`${PLATFORM_NAMES[p]} no está disponible`);
    const result = kind === 'announcement' ? await provider.sendAnnouncement(text, color) : await provider.sendChat(text);
    return { ok: true, kind, result };
  } catch (e) {
    errors.push(e); // conservar el fallo real aunque su mensaje esté vacío
    return { ok: false, kind, error: e.message };
  }
}

/** Avisos al guardar: la plantilla ya no cabe en alguna plataforma elegida (nunca se corta al enviar). */
export function limitWarnings(t) {
  const length = String(t.message || '').trim().length;
  return timerPlatforms(t).filter(p => length > CHAT_LIMITS[p])
    .map(p => ({ platform: p, limit: CHAT_LIMITS[p], length, message: `La plantilla supera el límite de ${PLATFORM_NAMES[p]} (${length}/${CHAT_LIMITS[p]}): no se enviará ahí.` }));
}

/** Campos de alerta de un mensaje programado (sin los suyos propios). */
export function alertFields(t) {
  const { message, intervalMin, minChatLines, announce, announceColor, onlyWhenLive, showAlert, destination, name, id, ...fields } = t;
  return { ...fields, enabled: true, platform: 'egdev', icon: 'spark' };
}

export function newTimer(fields = {}) {
  return { ...structuredClone(DEFAULT_TIMER), ...fields, id: fields.id || randomUUID().slice(0, 8) };
}

function uptime(startedAt) {
  const s = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

export class Timers {
  constructor({ store, engine, twitch, youtube, meld, session, log = console.log, tickMs = 15_000 }) {
    Object.assign(this, { store, engine, twitch, youtube, meld, session, log, tickMs });
    this.state = new Map();   // id → { lastAt, lines, lastError, runs, platforms }
    this.handle = null;
    this._closing = false;
    this._quiesce = null;
    this._work = new Set();
    this._pauseSeen = false;  // se vio la pausa activa y aún no se ha aplicado la reanudación
    this._liveSeen = this.isLive();
    // El cambio de Meld fija el instante real, incluso entre dos repasos del planificador.
    meld?.on?.('status', () => this._syncLive());
    // La pausa y los cambios de configuración se observan también al guardarse.
    store.on?.('change', () => { this._syncPause(); this._syncLive(); });
  }

  get list() { return this.store.config.timers || []; }

  st(id) {
    if (!this.state.has(id)) this.state.set(id, { lastAt: Date.now(), lines: 0, lastError: null, runs: 0, lastRunAt: null, platforms: null });
    return this.state.get(id);
  }

  start() {
    if (this._closing) return;
    clearInterval(this.handle);
    this.handle = setInterval(() => this.tick().catch(e => this.log('[timers]', e.message)), this.tickMs);
    this.handle.unref?.();
  }
  stop() { clearInterval(this.handle); }

  _own(fn) {
    if (this._closing) return Promise.reject(Object.assign(new Error('Los mensajes programados se están cerrando.'), { code: 'TIMERS_CLOSING', status: 503 }));
    const p = Promise.resolve().then(fn); // registrar antes de ejecutar la raíz admitida
    this._work.add(p);
    const done = () => this._work.delete(p);
    p.then(done, done);
    return p;
  }

  // Solo intervalo y raíces tick/fire: las acciones delegadas a Engine siguen fuera.
  quiesceFires() {
    if (this._quiesce) return this._quiesce;
    this._closing = true;
    this.stop();
    this._quiesce = this._drainFires();
    return this._quiesce;
  }

  async _drainFires() {
    const results = await Promise.allSettled([...this._work]);
    const errors = results.flatMap(r => r.status === 'rejected' ? [r.reason] : r.value.errors);
    if (errors.length) throw new AggregateError(errors, 'No se pudieron cerrar los mensajes programados.');
  }

  /** Cada mensaje del chat (que no sea tuyo) cuenta para «minChatLines». */
  onChat(msg) {
    if (msg.owner) return;
    for (const t of this.list) this.st(t.id).lines++;
  }

  isLive() {
    return !!(this.meld?.connected && this.meld.status.streaming); // sin Meld no se sabe: se bloquea
  }

  /** Motivo por el que no puede salir nada de este mensaje, ni automático ni manual. */
  blocked(t) {
    if (this._syncPause()) return 'pausa activa';
    if (t.onlyWhenLive && !this.meld?.connected) return 'Meld no está conectado: no se sabe si estás emitiendo';
    if (t.onlyWhenLive && !this.isLive()) return 'no estás emitiendo';
    return null;
  }

  /** ¿Toca publicar este mensaje ahora? Devuelve el motivo si no. */
  due(t, now = Date.now()) {
    if (t.enabled === false) return 'desactivado';
    this._syncPause(now); // una reanudación pendiente reinicia los intervalos antes de mirar si toca
    const s = this.st(t.id);
    if (now - s.lastAt < this.intervalMs(t)) return 'aún no toca';
    if (s.lines < (Number(t.minChatLines) || 0)) return 'poco movimiento en el chat';
    return this.blocked(t);
  }

  intervalMs(t) { return Math.max(1, Number(t.intervalMin) || 15) * 60_000; }

  /** Reinicia solo el intervalo, sin alterar líneas, envíos ni errores anteriores. */
  resetIntervals(now, include = () => true) {
    for (const t of this.list) if (include(t)) this.st(t.id).lastAt = now;
  }

  /** Al reanudar, lo que venció en pausa no se recupera: cada timer vuelve a contar su intervalo desde ahora. */
  onResume(now = Date.now()) {
    this._pauseSeen = false;
    this.resetIntervals(now);
  }

  /** Congela el valor visible fuera de directo y reinicia el intervalo cuando Meld confirma emisión. */
  _syncLive(now = Date.now()) {
    const live = this.isLive();
    if (live !== this._liveSeen) {
      this._liveSeen = live;
      if (live) this.resetIntervals(now, t => t.onlyWhenLive);
    }
    for (const t of this.list) {
      if (t.onlyWhenLive && !live) {
        const s = this.st(t.id);
        if (s.offlineAt == null) s.offlineAt = now;
      } else {
        const s = this.state.get(t.id);
        if (s) s.offlineAt = null;
      }
    }
  }

  /**
   * Reanudación sin depender del orden de escritura: si la pausa estaba activa y ya no lo está,
   * se aplica onResume antes de que ningún timer pueda salir. Devuelve si sigue en pausa.
   */
  _syncPause(now = Date.now()) {
    const paused = !!this.store.config.paused;
    if (paused) this._pauseSeen = true;
    else if (this._pauseSeen) this.onResume(now);
    return paused;
  }

  tick(now = Date.now()) {
    return this._own(() => this._tick(now)).then(r => r.result);
  }

  async _tick(now) {
    this._syncLive(now);
    const fired = [], errors = [];
    for (const t of this.list) {
      if (this.due(t, now)) continue;
      // Continuación del ciclo admitido, no un fire público nuevo tras el corte.
      try { const run = await this._fire(t.id); errors.push(...run.errors); }
      catch (e) { errors.push(e); }
      fired.push(t.id);
    }
    return { result: fired, errors };
  }

  vars() {
    return {
      channel: this.twitch.status.user || '', title: this.session.data.title || '',
      uptime: uptime(this.session.data.startedAt),
      follows: this.session.totals().follows,
    };
  }

  /** Publica ya un mensaje (desde el temporizador, el panel o el MCP). */
  fire(id) {
    return this._own(() => this._fire(id)).then(r => r.result);
  }

  async _fire(id) {
    const t = this.list.find(x => x.id === id);
    if (!t) throw Object.assign(new Error(`No existe el mensaje programado «${id}»`), { status: 404 });
    const reason = this.blocked(t);
    if (reason) throw Object.assign(new Error(`No se envía «${t.name}»: ${reason}.`), { status: 409, code: 'TIMER_BLOCKED' });
    // Lo ya enviado al proveedor no se cancela al pausar: se registra según su resultado.
    const s = this.st(t.id);
    s.lastAt = Date.now(); s.lines = 0; s.lastRunAt = new Date().toISOString(); s.runs++;
    const vars = this.vars();
    const text = render(t.message, vars);
    const out = { id: t.id, chat: null, alert: null, error: null, platforms: {} };
    const errors = [];
    if (text) {
      // Un intento por plataforma y ejecución: el fallo de una nunca reenvía lo que la otra ya recibió.
      for (const [i, p] of timerPlatforms(t).entries()) {
        // La pausa (o Meld) puede llegar con la plataforma anterior en vuelo: esa termina, la siguiente no sale.
        const late = i > 0 && this.blocked(t);
        const r = out.platforms[p] = late
          ? { ok: false, kind: p === 'twitch' && t.announce ? 'announcement' : 'message', error: late }
          : await this._send(p, t, text, errors);
        if (r.ok && out.chat === null) out.chat = r.result;
      }
      const failed = Object.entries(out.platforms).filter(([, r]) => !r.ok);
      // Con un solo destino, el error es el del proveedor tal cual (como hasta ahora).
      const label = ([p, r]) => Object.keys(out.platforms).length > 1 ? `${PLATFORM_NAMES[p]}: ${r.error}` : r.error;
      out.error = failed.length ? failed.map(label).join(' · ') : null;
      s.lastError = out.error; s.platforms = out.platforms;
    }
    if (t.showAlert) out.alert = this.engine.custom(alertFields(t), vars)?.id || null;
    this.engine.bus.send('timers', this.snapshot(), ['panel']);
    return { result: out, errors };
  }

  /** Envía a una plataforma; el anuncio solo existe en Twitch, YouTube recibe el mismo texto normal. */
  async _send(p, t, text, errors) {
    const provider = p === 'twitch' ? this.twitch : this.youtube;
    const r = await sendToPlatform(p, provider, text, { announce: t.announce, color: t.announceColor }, errors);
    if (!r.ok) this.log('[timers]', t.name, PLATFORM_NAMES[p], r.error);
    return r;
  }

  /** Para el panel y el MCP: config + estado de cada mensaje. */
  snapshot() {
    const now = Date.now();
    this._syncLive(now);
    return this.list.map(t => {
      const s = this.st(t.id);
      const pausedOffStream = !!t.onlyWhenLive && !this.isLive();
      const countAt = pausedOffStream ? Math.max(s.lastAt, s.offlineAt) : now;
      const nextInMs = Math.max(0, s.lastAt + this.intervalMs(t) - countAt);
      return { ...t, runtime: { lastRunAt: s.lastRunAt, runs: s.runs, lines: s.lines, lastError: s.lastError, platforms: s.platforms, warnings: limitWarnings(t), nextInSec: Math.round(nextInMs / 1000), blockedBy: nextInMs ? null : this.due(t, now), pausedOffStream } };
    });
  }

  reset(id) { this.state.delete(id); }
}
