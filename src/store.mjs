// Configuración (data/config.json) y secretos (data/secrets.json). Nada sale del PC.
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './json-file.mjs';
import { sanitizeConfig, schemaAt, PROTO_KEYS } from './config-schema.mjs';
import { convertLegacyGoals } from './goals.mjs';
import { DEFAULT_ALERTS } from './alerts.mjs';
import { DEFAULT_FILTERS } from './filters.mjs';
import { DEFAULT_VIEWERS } from './viewers.mjs';
import { DEFAULT_INTERACTIVE_CONFIG } from './interactive.mjs';
import { DEFAULT_TELEPROMPTER } from './teleprompter.mjs';
import { DEFAULT_THEME } from './theme.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.ANTENA_DATA || path.join(ROOT, 'data');

export const DEFAULT_CONFIG = {
  port: 4500,
  paused: false,
  twitch: { clientId: '' },
  youtube: { apiKey: '', channelId: '', video: '', pollSeconds: 8, clientId: '', clientSecret: '' },  // clientId/Secret: app OAuth «de escritorio» para escribir en el chat
  chat: { twitchChannel: '', sendTo: 'twitch' },   // sendTo: twitch | youtube | both (desde dónde escribes por defecto)        // vacío = tu propio canal al conectar Twitch
  overlay: { volume: 0.6, gapMs: 700, css: '', queueMax: 20 },   // css: común a todas las alertas; queueMax (#66): tope de la cola del overlay, 0 = sin tope
  tts: { enabled: true, voice: '', rate: 1, pitch: 1, volume: 1, maxChars: 200 },
  filters: DEFAULT_FILTERS,
  meld: { enabled: false, url: 'ws://127.0.0.1:13376', autoSession: true },
  panel: { onboardingDone: false },   // bienvenida del panel con tarjetas; true = ya la vio (se relanza desde General)
  access: { lan: false, key: '' },   // acceso desde el móvil en la red local
  sessions: { retention: 0 },        // #68: sesiones archivadas a conservar; 0 = sin límite (desactivado)
  alerts: DEFAULT_ALERTS,
  commands: [],
  timers: [],
  interactive: DEFAULT_INTERACTIVE_CONFIG,
  // vista del prompter (Elgato Prompter, 1024×600)
  // atajos propios: cada uno lanza una lista de pasos (Stream Deck: /sd/custom/<id>, dock, panel y MCP)
  shortcuts: [],
  viewers: DEFAULT_VIEWERS,           // récord de espectadores a la vez y su anti-spam (src/viewers.mjs)
  teleprompter: DEFAULT_TELEPROMPTER, // guiones y ajustes de lectura (src/teleprompter.mjs)
  customOverlays: [],                // overlays propios HTML/CSS/JS (src/custom-overlays.mjs)
  theme: DEFAULT_THEME,               // Apariencia: tema de overlay y widgets (src/theme.mjs)
  prompter: { fontSize: 22, mirror: false, hideCommands: true, autoSwitch: true, chatLines: 60, micTrack: '', css: '' },  // micTrack: pista de Meld del micro (vacío = la primera que se llame «mic…»)
  widgets: {
    chat: { platforms: ['twitch', 'youtube'], maxMessages: 12, fadeAfterSec: 0, fontSize: 26, hideCommands: true, hideOwner: true, showPlatform: true, reverse: false, animIn: 'slide', animOut: 'slide', css: '' },  // hideOwner: tus mensajes no salen en pantalla; animIn/animOut #130
    goals: [{ id: 'principal', title: 'Objetivo de seguidores', visible: true, showMetric: true, css: '', bars: [{ id: 'principal-1', platform: 'twitch', metric: 'follows', target: 20, visible: true }] }],
    latest: { items: ['follow', 'sub', 'cheer', 'superchat'], css: '' },
    ticker: { label: 'Gracias a', count: 15, speed: 70, css: '' },
    viewers: { platforms: ['twitch', 'youtube'], showTotal: true, showPeak: false, css: '' },  // espectadores a la vez por plataforma
    credits: { title: 'Gracias por estar', subtitle: 'egdev.es · directos los miércoles a las 19:00', speed: 60, css: '' },
  },
};

export function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    // Claves de prototipo: nunca se copian (#62) ni siquiera como propiedad propia.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// Etiquetas seguras: el error nunca expone la ruta, el código crudo (ENOTDIR…) ni el valor guardado.
const PERSIST_LABEL = { config: 'la configuración', secrets: 'los secretos' };
function persistenceError(err, kind) {
  const e = new Error(`No se pudo guardar ${PERSIST_LABEL[kind]}; los cambios permanecen en memoria pendientes de guardado`);
  e.code = 'PERSISTENCE_FAILED';
  e.status = 500;
  e.cause = err;
  return e;
}

// Dos vistas del mismo estado acotado: la exacta (HTTP) y la visible (decide si hay evento SSE).
function samePersistenceView(a, b) {
  if (!a || !b) return false;
  for (const kind of ['config', 'secrets']) {
    if (a.dirty[kind] !== b.dirty[kind]) return false;
    if (a.message[kind] !== b.message[kind]) return false;
    if (a.pending[kind] !== b.pending[kind]) return false;
  }
  return true;
}

export class Store extends EventEmitter {
  constructor(dir = DATA) {
    super();
    this.dir = dir;
    this.chain = Promise.resolve();
    this.cfgFile = path.join(dir, 'config.json');
    this.secFile = path.join(dir, 'secrets.json');
    this.config = structuredClone(DEFAULT_CONFIG);
    this.secrets = {};
    // estado de persistencia por fichero: un fallo deja el cambio en memoria marcado como pendiente
    this.dirty = { config: false, secrets: false };
    this.dirtyMessage = { config: null, secrets: null };
    // trabajos en cola por fichero (encolados + en vuelo); la UI solo usa >0, HTTP el contador exacto
    this.pending = { config: 0, secrets: 0 };
    this.lastPersistenceView = this.#persistenceView();
  }
  #kindOf(file) {
    return file === this.cfgFile ? 'config' : file === this.secFile ? 'secrets' : null;
  }
  #markDirty(kind, message) {
    this.dirty[kind] = true;
    this.dirtyMessage[kind] = message;
  }
  #markClean(kind) {
    this.dirty[kind] = false;
    this.dirtyMessage[kind] = null;
  }
  /** Proyección booleana de pending: un contador 1→2 no es una transición visible. */
  #persistenceView() {
    return {
      dirty: { config: this.dirty.config, secrets: this.dirty.secrets },
      message: { config: this.dirtyMessage.config, secrets: this.dirtyMessage.secrets },
      pending: { config: this.pending.config > 0, secrets: this.pending.secrets > 0 },
    };
  }
  /** Emite 'persistence' solo en transiciones visibles (dirty/message o pending 0↔>0). */
  #publishPersistence() {
    const view = this.#persistenceView();
    if (samePersistenceView(view, this.lastPersistenceView)) return;
    this.lastPersistenceView = view;
    try {
      this.emit('persistence', this.persistenceState());
    } catch (err) {
      // Un oyente roto se reporta aparte: ni convierte un guardado correcto en fallo
      // ni tapa el error real de IO cuando la escritura ya falló.
      try { this.emit('persistenceListenerError', err); } catch { /* el aviso es lo mejor posible */ }
    }
  }
  /** Copia acotada del estado de persistencia (dirty, message y pending por fichero). */
  persistenceState() {
    return structuredClone({ dirty: { ...this.dirty }, message: { ...this.dirtyMessage }, pending: { ...this.pending } });
  }
  async load() {
    // copia profunda: cada alerta tiene sus propias listas (variaciones, acciones)
    this.config = deepMerge(structuredClone(DEFAULT_CONFIG), await readJson(this.cfgFile, {}));
    // #128: los objetivos legacy (barra única) se convierten en cajas con barras ANTES de
    // sanear (el esquema nuevo valida cajas). La conversión es idempotente; si cambió algo,
    // se persiste aquí mismo: un fallo de escritura rechaza la carga (no se silencia).
    const goals = this.config.widgets.goals;
    const converted = convertLegacyGoals(goals);
    if (converted.some((g, i) => g !== goals[i])) {
      this.config.widgets.goals = converted;
      await this.write(this.cfgFile, this.config);
    }
    // #106: cada hoja inválida de config.json vuelve a su default con un aviso; el arranque sigue
    const warnings = sanitizeConfig(this.config, DEFAULT_CONFIG);
    this.configWarnings = warnings.map(w => w.path);
    for (const w of warnings) console.warn(`config.json: ${w.message}`);
    this.secrets = await readJson(this.secFile, {});
    return this;
  }
  // las escrituras van en fila para que dos cambios seguidos no se pisen.
  // La promesa del productor propaga el fallo; la cola interna se recupera para el siguiente trabajo.
  write(file, data) {
    const kind = this.#kindOf(file);
    // el contador sube de forma síncrona al entrar: la UI ve el pendiente aunque el trabajo espere en la cola
    if (kind) { this.pending[kind]++; this.#publishPersistence(); }
    const run = writeJson(file, data, { after: this.chain }).then(
      () => { if (kind) { this.pending[kind]--; this.#markClean(kind); this.#publishPersistence(); } },
      err => {
        const e = kind ? persistenceError(err, kind) : err;
        if (kind) { this.pending[kind]--; this.#markDirty(kind, e.message); this.#publishPersistence(); }
        throw e;
      }
    );
    this.chain = run.catch(() => {});
    return run;
  }
  async patchConfig(patch) {
    this.config = deepMerge(this.config, patch);
    await this.write(this.cfgFile, this.config);
    this.emit('change', patch);
    return this.config;
  }
  /** Cambia un valor por ruta con puntos («alerts.follow.title», «widgets.goals.0.target»). */
  async setPath(dotted, value) {
    const keys = String(dotted).split('.').filter(Boolean);
    if (!keys.length) throw new Error('Ruta vacía');
    // defensa en profundidad (validatePath ya lo rechaza): nunca se escribe en el prototipo
    if (keys.some(k => PROTO_KEYS.has(k))) throw new Error(`Ruta no válida: ${dotted}`);
    // validar TODOS los índices de lista antes de tocar nada: un índice mayor que la longitud
    // (en el último tramo o en uno intermedio) dejaría agujeros null (#158); solo valen índices
    // existentes o el primero libre (igual a la longitud, para añadir al final).
    let prueba = this.config;
    for (const k of keys) {
      if (Array.isArray(prueba) && /^\d+$/.test(k) && Number(k) > prueba.length) {
        throw Object.assign(new Error(`${dotted}: el índice ${k} se sale de la lista (${prueba.length} elemento${prueba.length === 1 ? '' : 's'}); usa un índice entre 0 y ${prueba.length}`), { status: 400 });
      }
      prueba = prueba == null ? undefined : prueba[k];
    }
    let obj = this.config;
    for (const k of keys.slice(0, -1)) {
      // tramo intermedio numérico: mismo límite que el final, antes de crear o mutar nada (#158)
      if (Array.isArray(obj) && /^\d+$/.test(k) && Number(k) > obj.length) {
        throw Object.assign(new Error(`${dotted}: el índice ${k} se sale de la lista (${obj.length} elemento${obj.length === 1 ? '' : 's'}); usa un índice entre 0 y ${obj.length}`), { status: 400 });
      }
      if (obj[k] === undefined || obj[k] === null || typeof obj[k] !== 'object') obj[k] = /^\d+$/.test(k) ? [] : {};
      obj = obj[k];
    }
    const last = keys.at(-1);
    if (value === undefined) {
      if (Array.isArray(obj)) {
        if (/^\d+$/.test(last) && Number(last) >= obj.length) {
          throw Object.assign(new Error(`${dotted}: el índice ${last} se sale de la lista (${obj.length} elemento${obj.length === 1 ? '' : 's'}); usa un índice entre 0 y ${obj.length - 1}`), { status: 400 });
        }
        obj.splice(Number(last), 1);
      }
      else {
        delete obj[last];
        // Borrar una hoja o sección del esquema deja su default al momento, igual que al cargar:
        // sin esto se quedaba undefined hasta el reinicio (#158). Las rutas sin esquema se borran de verdad.
        if (schemaAt(dotted) !== undefined) {
          const def = this.getPath(dotted, DEFAULT_CONFIG);
          if (def !== undefined) obj[last] = structuredClone(def);
        }
      }
    }
    // el valor tampoco trae claves del prototipo (JSON.parse las crea como propias); igual que deepMerge
    else {
      let fuera = 0;
      obj[last] = typeof value === 'object' && value !== null
        ? JSON.parse(JSON.stringify(value), (k, v) => (PROTO_KEYS.has(k) ? (fuera++, undefined) : v))
        : value;
      if (fuera) console.warn(`${dotted}: se ignoran ${fuera} clave(s) del prototipo (__proto__, constructor, prototype)`);
    }
    await this.write(this.cfgFile, this.config);
    this.emit('change', { [keys[0]]: true });
    return this.config;
  }
  // La raíz opcional permite leer una proyección; el acceso interno sigue siendo crudo por defecto.
  getPath(dotted, root = this.config) {
    // solo claves propias: «constructor» o «__proto__» no devuelven el prototipo
    return String(dotted || '').split('.').filter(Boolean).reduce((o, k) => (o == null || !Object.hasOwn(Object(o), k) ? undefined : o[k]), root);
  }
  /** Guarda tal cual (para listas como comandos o variaciones). */
  async save(section) {
    await this.write(this.cfgFile, this.config);
    this.emit('change', { [section || 'all']: true });
  }
  async setSecret(key, value) {
    if (value === undefined) delete this.secrets[key]; else this.secrets[key] = value;
    await this.write(this.secFile, this.secrets);
  }
  /** Config apta para el panel: oculta la API key de YouTube. */
  publicConfig() {
    const c = structuredClone(this.config);
    c.youtube.apiKeySet = !!c.youtube.apiKey;
    c.youtube.apiKey = c.youtube.apiKey ? '••••' + c.youtube.apiKey.slice(-4) : '';
    c.youtube.clientSecretSet = !!c.youtube.clientSecret;
    c.youtube.clientSecret = c.youtube.clientSecret ? '••••' + c.youtube.clientSecret.slice(-4) : '';
    // La clave de acceso LAN no sale en claro por la API pública (issue #59):
    // solo se ve donde se genera el enlace del móvil (GET /api/access).
    c.access = { ...c.access, key: c.access?.key ? '••••' + c.access.key.slice(-4) : '' };
    return c;
  }
}
