// Channel totals for goal bars (#132): Twitch followers/subs and YouTube subscribers show the
// total the platform reports plus a persistent manual correction, never reset by a session cut.
// Polled at startup, on reconnect and periodically; live events add to the last polled total
// until the next poll replaces it. The last known total and the corrections live in
// data/channel-totals.json, so a restart or an unreachable platform keeps the last value.
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';

export const TOTAL_FILE = 'channel-totals.json';
export const TOTAL_KEYS = ['follows@twitch', 'subs@twitch', 'subscribers@youtube'];
const DEFAULT_POLL_MS = 5 * 60_000;

/** True when a bar's metric shows the channel total instead of the session's events. */
export function isTotalMetric(metric, platform) {
  return TOTAL_KEYS.includes(`${metric}@${platform}`);
}

/** How much a live alert adds to a total between polls. */
function liveDelta(key, alert) {
  const type = alert?.type;
  if (key === 'follows@twitch') return type === 'follow' ? 1 : 0;
  if (key === 'subs@twitch') {
    if (type === 'sub') return 1;
    if (type === 'giftsub') return Number(alert.vars?.amount) || 1;
  }
  return 0;   // resub does not change the total; YouTube sends no subscription event
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
const conflict = message => Object.assign(new Error(message), { status: 409 });

export class ChannelTotals extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir data directory
   * @param {object} [o.twitch] client from src/twitch.mjs (helix, userId, token)
   * @param {object} [o.youtube] client from src/youtube.mjs (api, cfg, token)
   * @param {Record<string, () => Promise<number|null>>} [o.readers] injectable readers (tests); null = no credentials
   */
  constructor({ dir, twitch, youtube, log = () => {}, now = Date.now, readers, pollMs = DEFAULT_POLL_MS, initialDelayMs = 3000 } = {}) {
    super();
    this.file = path.join(dir, TOTAL_FILE);
    this.twitch = twitch; this.youtube = youtube; this.log = log; this.now = now;
    this.readers = readers || {
      'follows@twitch': () => this.readTwitch('/channels/followers'),
      'subs@twitch': () => this.readTwitch('/subscriptions'),
      'subscribers@youtube': () => this.readYouTube(),
    };
    this.pollMs = pollMs; this.initialDelayMs = initialDelayMs;
    this.totals = {};    // key -> { value, at, live }
    this.offsets = {};   // key -> number (persistent correction)
    this.errors = {};    // key -> message (memory only)
    this.handle = null; this.initialHandle = null; this.busy = null; this.halted = false;
    this.writing = Promise.resolve();
  }

  async load() {
    let raw = null;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); } catch { /* first run or unreadable: start empty */ }
    for (const key of TOTAL_KEYS) {
      const t = raw?.totals?.[key];
      if (t && finite(t.value)) this.totals[key] = { value: t.value, at: t.at || null, live: finite(t.live) ? t.live : 0 };
      if (finite(raw?.offsets?.[key])) this.offsets[key] = raw.offsets[key];
    }
    return this;
  }

  // ---------- readers ----------
  async readTwitch(endpoint) {
    const t = this.twitch;
    if (!t?.userId || !t.token) return null;
    const r = await t.helix('GET', `${endpoint}?broadcaster_id=${encodeURIComponent(t.userId)}&first=1`);
    if (!r.ok) throw new Error(`Twitch respondió ${r.status} al leer ${endpoint === '/subscriptions' ? 'las suscripciones' : 'los seguidores'}`);
    const total = Number(r.data?.total);
    if (!Number.isFinite(total)) throw new Error('Twitch no devolvió el total');
    return total;
  }

  async readYouTube() {
    const y = this.youtube;
    const channelId = y?.cfg?.channelId;
    let d;
    if (channelId) d = await y.api('/channels', { part: 'statistics', id: channelId });
    else if (y?.token?.access) d = await y.api('/channels', { part: 'statistics', mine: 'true' }, { auth: true });
    else return null;
    const st = d?.items?.[0]?.statistics;
    if (!st) throw new Error('YouTube no encontró el canal');
    if (st.hiddenSubscriberCount) throw new Error('El canal tiene oculto el número de suscriptores');
    const total = Number(st.subscriberCount);
    if (!Number.isFinite(total)) throw new Error('YouTube no devolvió el número de suscriptores');
    return total;
  }

  // ---------- values ----------
  /** Total + live events since the last poll + correction; null while the total was never known. */
  value(key) {
    const t = this.totals[key];
    if (!t) return null;
    return t.value + t.live + (this.offsets[key] || 0);
  }

  adjust(key, delta) {
    this.offsets[key] = (this.offsets[key] || 0) + (Number(delta) || 0);
    this.changed();
  }

  set(key, value) {
    const t = this.totals[key];
    if (!t) throw conflict('Aún no se conoce el total de la plataforma: conecta la cuenta y espera a la primera lectura antes de fijar el valor.');
    this.offsets[key] = (Number(value) || 0) - t.value - t.live;
    this.changed();
  }

  onEvent(alert) {
    let touched = false;
    for (const key of TOTAL_KEYS) {
      const d = liveDelta(key, alert);
      if (d && this.totals[key]) { this.totals[key].live += d; touched = true; }
    }
    if (touched) this.changed();
  }

  snapshot() {
    return Object.fromEntries(TOTAL_KEYS.map(key => [key, {
      value: this.value(key), at: this.totals[key]?.at || null, error: this.errors[key] || null,
    }]));
  }

  // ---------- polling ----------
  /** Reads the given keys (default all). Returns once every read settled. */
  poll(keys = TOTAL_KEYS) {
    if (this.halted) return Promise.resolve();
    const run = async () => {
      let dirty = false;
      await Promise.all(keys.map(async key => {
        const reader = this.readers[key];
        if (!reader) return;
        let total, error = null;
        try { total = await reader(); } catch (err) { error = err?.message || String(err); }
        if (this.halted) return;
        if (error) {
          if (this.errors[key] !== error) { this.errors[key] = error; dirty = true; this.log(`[totales] ${key}: ${error}`); }
          return;
        }
        if (this.errors[key]) { delete this.errors[key]; dirty = true; }
        if (total === null || total === undefined) return;   // no credentials: keep the last value
        const prev = this.totals[key];
        if (!prev || prev.value !== total || prev.live !== 0) dirty = true;
        this.totals[key] = { value: total, at: new Date(this.now()).toISOString(), live: 0 };
      }));
      if (dirty) this.changed();
    };
    // one poll at a time; a request during a poll runs right after it
    const next = (this.busy || Promise.resolve()).then(run, run);
    this.busy = next.finally(() => { if (this.busy === tracked) this.busy = null; });
    const tracked = this.busy;
    return next;
  }

  refresh(platform) {
    return this.poll(TOTAL_KEYS.filter(k => k.endsWith(`@${platform}`)));
  }

  start() {
    this.stop();
    this.handle = setInterval(() => { this.poll().catch(() => {}); }, this.pollMs);
    this.handle.unref?.();
    this.initialHandle = setTimeout(() => { this.poll().catch(() => {}); }, this.initialDelayMs);
    this.initialHandle.unref?.();
  }

  stop() {
    if (this.handle) clearInterval(this.handle);
    if (this.initialHandle) clearTimeout(this.initialHandle);
    this.handle = null; this.initialHandle = null;
  }

  halt() { this.stop(); this.halted = true; }

  // ---------- persistence ----------
  changed() {
    const data = { version: 1, totals: this.totals, offsets: this.offsets };
    this.writing = this.writing.then(() => writeJson(this.file, data)).catch(err => this.log(`[totales] no se pudo guardar: ${err.message}`));
    this.emit('change', this.snapshot());
  }

  /** Waits for pending writes (tests and shutdown). */
  flush() { return this.writing; }
}
