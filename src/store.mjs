// Configuración (data/config.json) y secretos (data/secrets.json). Nada sale del PC.
import { readFile, copyFile, chmod, stat, readdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from './json-file.mjs';
import { cleanUrl } from './http-util.mjs';
import { sanitizeInterviews } from './interviews.mjs';
import { sanitizeConfig, schemaAt, PROTO_KEYS, validateChatVariantsTransition } from './config-schema.mjs';
import { CURRENT_CONFIG_VERSION, migrateConfig } from './config-migrations.mjs';
import { DEFAULT_ALERTS } from './alerts.mjs';
import { DEFAULT_FILTERS } from './filters.mjs';
import { DEFAULT_VIEWERS } from './viewers.mjs';
import { DEFAULT_INTERACTIVE_CONFIG } from './interactive.mjs';
import { DEFAULT_TELEPROMPTER } from './teleprompter.mjs';
import { DEFAULT_THEME } from './theme.mjs';
import { DEFAULT_DOCK } from './dock-layout.mjs';
import { publicThemes } from './theme-looks.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.ANTENA_DATA || path.join(ROOT, 'data');

export const DEFAULT_CONFIG = {
  configVersion: CURRENT_CONFIG_VERSION,
  themes: { activeId: 'normal', saved: [{ id: 'normal', name: 'Normal' }] },
  customOverlayCss: {},              // CSS adicional por id de overlay, del tema activo
  port: 4500,
  paused: false,
  twitch: { clientId: '' },
  discord: { enabled: false },
  scheduleCalendar: { enabled: false, url: 'http://localhost:4400' },
  youtube: { apiKey: '', channelId: '', video: '', pollSeconds: 8, subscriberPollSeconds: 120, subscriberCountAlert: true, streakAlert: true, streakMinSessions: 3, clientId: '', clientSecret: '' },  // clientId/Secret: app OAuth «de escritorio» para escribir en el chat
  chat: { twitchChannel: '', sendTo: 'twitch' },   // sendTo: twitch | youtube | both (desde dónde escribes por defecto)        // vacío = tu propio canal al conectar Twitch
  overlay: { volume: 0.6, gapMs: 700, css: '', queueMax: 20 },   // css: común a todas las alertas; queueMax (#66): tope de la cola del overlay, 0 = sin tope
  tts: { enabled: true, voice: '', rate: 1, pitch: 1, volume: 1, maxChars: 200 },
  filters: DEFAULT_FILTERS,
  program: { kind: 'meld', autoSession: true, recordOnStart: false },
  obs: { url: 'ws://127.0.0.1:4455' },
  meld: { enabled: false, url: 'ws://127.0.0.1:13376' },
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
  dock: DEFAULT_DOCK,
  viewers: DEFAULT_VIEWERS,           // récord de espectadores a la vez y su anti-spam (src/viewers.mjs)
  teleprompter: DEFAULT_TELEPROMPTER, // guiones y ajustes de lectura (src/teleprompter.mjs)
  customOverlays: [],                // overlays propios HTML/CSS/JS (src/custom-overlays.mjs)
  theme: DEFAULT_THEME,               // Apariencia: tema de overlay y widgets (src/theme.mjs)
  prompter: { fontSize: 22, mirror: false, hideCommands: true, hideTimers: false, autoSwitch: true, chatLines: 60, micTrack: '', css: '' },  // micTrack: pista de Meld del micro (vacío = la primera que se llame «mic…»)
  widgets: {
    chat: { platforms: ['twitch', 'youtube'], maxMessages: 12, fadeAfterSec: 0, fontSize: 26, hideCommands: true, hideOwner: true, showPlatform: true, reverse: false, animIn: 'slide', animOut: 'slide', layout: 'vertical', css: '' },  // hideOwner: tus mensajes no salen en pantalla; animIn/animOut #130
    chatVariants: [],
    goals: [{ id: 'principal', title: 'Objetivo de seguidores', visible: true, showMetric: true, css: '', bars: [{ id: 'principal-1', platform: 'twitch', metric: 'follows', target: 20, visible: true }] }],
    latest: { items: ['follow', 'sub', 'cheer', 'superchat'], label: '', css: '' },
    ticker: { label: 'Gracias a', count: 15, speed: 70, css: '' },
    viewers: { platforms: ['twitch', 'youtube'], showTotal: true, showPeak: false, css: '' },  // espectadores a la vez por plataforma
    thanks: { title: 'Gracias por seguir', platforms: ['twitch', 'youtube'], window: 'lastStream', days: 30, maxNames: 20, intervalSec: 5, showAnonymous: true, css: '' },
    rotator: { label: 'Mensaje', messages: [], intervalSec: 240, durationSec: 12, order: 'sequential', css: '' },  // mensajes en pantalla que rotan (independientes de los mensajes programados del chat)
    socials: { label: '', items: [], css: '' },   // barra de redes sociales: icono de plataforma + nick
    credits: { title: 'Gracias por estar', subtitle: 'egdev.es · directos los miércoles a las 19:00', speed: 60, css: '' },
  },
};

// Mismos tramos para escribir una ruta y decidir sus efectos posteriores.
export function configPathKeys(dotted) {
  return String(dotted).split('.').filter(Boolean);
}

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
    // Migrar los datos originales antes de fusionar defaults: así un default nuevo no
    // pisa el valor antiguo. Una versión futura nunca se migra ni se rebaja al cargar.
    // Un fichero inexistente o corrupto no se reemplaza ni tiene copia previa.
    const raw = await readJson(this.cfgFile, null);
    const migration = raw === null ? { config: {}, changed: false, future: false } : migrateConfig(raw);
    if (migration.future) console.warn(`config.json: configVersion ${migration.config.configVersion} es más reciente; no se migra`);
    this.config = deepMerge(structuredClone(DEFAULT_CONFIG), migration.config);
    // Nunca importar una contraseña de config.json a las vistas o a guardados posteriores.
    if (this.config.obs && typeof this.config.obs === 'object') delete this.config.obs.password;
    if (this.config.discord && typeof this.config.discord === 'object') {
      delete this.config.discord.webhookUrl;
      delete this.config.discord.webhookUrlSet;
    }
    if (this.config.scheduleCalendar && typeof this.config.scheduleCalendar === 'object') {
      delete this.config.scheduleCalendar.token;
      delete this.config.scheduleCalendar.tokenSet;
    }
    // El mismo backup transaccional que usa la importación conserva los bytes y el modo.
    // Solo el cambio de datos, no añadir la versión en memoria, exige escribir al cargar.
    if (migration.changed) await this.replaceConfigWithBackup(this.config, this.config, { all: true });
    // #106: cada hoja inválida de config.json vuelve a su default con un aviso; el arranque sigue
    const warnings = sanitizeConfig(this.config, DEFAULT_CONFIG);
    // #276: un paquete incompleto o un ítem activo sin aprobar nunca llega a la API ni al directo.
    if (this.config.interviews !== undefined) {
      const clean = sanitizeInterviews(this.config.interviews);
      this.config.interviews = clean.section;
      for (const message of clean.warnings) warnings.push({ path: 'interviews', message });
    }
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
  // Si vuelve exactamente la URL que dimos al panel, conserva la versión privada actual.
  // Una URL distinta se guarda tal cual: nunca se transfieren credenciales a otro destino.
  #retainProgramUrl(kind, value) {
    const previous = this.config[kind]?.url;
    return typeof value === 'string' && typeof previous === 'string' && value === cleanUrl(previous) ? previous : value;
  }
  async patchConfig(patch, { replace = false, change = patch, onPersist } = {}) {
    // configVersion belongs to the store: client patches cannot skip future migrations.
    if (!replace && patch && typeof patch === 'object' && Object.hasOwn(patch, 'configVersion')) {
      const { configVersion: _ignored, ...rest } = patch;
      patch = rest;
    }
    if (!replace) for (const kind of ['meld', 'obs']) {
      const section = patch?.[kind];
      if (!section || typeof section !== 'object' || Array.isArray(section) || !Object.hasOwn(section, 'url')) continue;
      const url = this.#retainProgramUrl(kind, section.url);
      if (url !== section.url) patch = { ...patch, [kind]: { ...section, url } };
    }
    this.config = replace ? patch : deepMerge(this.config, patch);
    await this.write(this.cfgFile, this.config);
    onPersist?.(); // The atomic write has committed even if a change listener throws.
    // A detached theme transaction publishes only to the panel, not the live consumers.
    if (change !== null) this.emit('change', change);
    return this.config;
  }
  /** Transactional config replacement; imports and activation keep a local restore point. */
  async replaceConfigWithBackup(next, expected, change, onCommit, { backup = true } = {}) {
    // An imported file never sets the stored version; keep the version this store loaded.
    if (next && typeof next === 'object') next = { ...next, configVersion: this.config.configVersion };
    const conflict = () => Object.assign(new Error('La configuración ha cambiado; vuelve a previsualizar'), { status: 409 });
    const barrier = this.chain;
    await barrier;
    if (this.chain !== barrier || this.dirty.config || !isDeepStrictEqual(this.config, expected)) throw conflict();
    let name, target, mode;
    if (backup) {
      mode = (await stat(this.cfgFile)).mode & 0o777;
      const now = this.lastConfigBackup = Math.max(Date.now(), (this.lastConfigBackup || 0) + 1);
      name = `config.backup-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
      target = path.join(this.dir, name);
      await copyFile(this.cfgFile, target, constants.COPYFILE_EXCL);
    }
    let started = false, committed = false, listenerError, importChain;
    try {
      if (backup) await chmod(target, mode);
      if (this.chain !== barrier || !isDeepStrictEqual(this.config, expected)) throw conflict();
      started = true;
      const writing = this.patchConfig(next, { replace: true, change, onPersist: () => { committed = true; onCommit?.(); } });
      importChain = this.chain;
      await writing;
    } catch (error) {
      if (!committed) {
        if (started) this.config = expected;
        if (target) await unlink(target).catch(() => {});
        if (started && error.code === 'PERSISTENCE_FAILED') {
          // Unlike ordinary writes, this transaction restored memory and has no pending changes.
          if (this.chain === importChain) { this.#markClean('config'); this.#publishPersistence(); }
          throw Object.assign(new Error('No se pudo guardar la configuración; no se aplicaron los cambios'), { status: 500, cause: error });
        }
        throw error;
      }
      listenerError = error; // Match PUT: report the listener error, but never roll back a committed write.
    }
    // Only files created by this feature are eligible; the current restore point always stays.
    if (backup) try {
      const others = (await readdir(this.dir)).filter(n => /^config\.backup-\d{4}-\d\d-\d\dT[\dTZ-]+-[0-9a-f-]{36}\.json$/.test(n) && n !== name).sort().reverse();
      for (const old of others.slice(9)) await unlink(path.join(this.dir, old));
    } catch { /* successful import remains successful if old backup cleanup fails */ }
    if (listenerError) throw listenerError;
    return name;
  }
  /** Cambia un valor por ruta con puntos («alerts.follow.title», «widgets.goals.0.target»). */
  async setPath(dotted, value, { programPatch } = {}) {
    const keys = configPathKeys(dotted);
    if (!keys.length) throw new Error('Ruta vacía');
    // defensa en profundidad (validatePath ya lo rechaza): nunca se escribe en el prototipo
    if (keys.some(k => PROTO_KEYS.has(k))) throw new Error(`Ruta no válida: ${dotted}`);
    if (keys[0] === 'configVersion') throw Object.assign(new Error('configVersion lo gestiona antena; no se puede cambiar'), { status: 400 });
    if (keys[0] === 'themes') throw Object.assign(new Error('themes: se gestionan con /api/themes'), { status: 400 });
    if (['meld', 'obs'].includes(keys[0])) {
      if (keys.length === 2 && keys[1] === 'url') value = this.#retainProgramUrl(keys[0], value);
      else if (keys.length === 1 && value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'url')) {
        const url = this.#retainProgramUrl(keys[0], value.url);
        if (url !== value.url) value = { ...value, url };
      }
    }
    // Simular solo las rutas que tocan variantes sobre una copia, usando exactamente la
    // misma lógica de setPath; así se valida el resultado antes de mutar o emitir nada.
    const checkVariants = keys[0] === 'widgets' && (keys[1] === 'chatVariants' ||
      (keys.length === 1 && value && typeof value === 'object' && Object.hasOwn(value, 'chatVariants')));
    const arrayIndex = /^(0|[1-9]\d*)$/;
    if (keys[0] === 'widgets' && keys[1] === 'chatVariants' && keys.length > 2 && !arrayIndex.test(keys[2])) {
      throw Object.assign(new Error(`${dotted}: la lista de variantes solo admite índices numéricos`), { status: 400 });
    }
    const target = checkVariants ? structuredClone(this.config) : this.config;
    // validar TODOS los índices de lista antes de tocar nada: un índice mayor que la longitud
    // (en el último tramo o en uno intermedio) dejaría agujeros null (#158); solo valen índices
    // existentes o el primero libre (igual a la longitud, para añadir al final).
    let prueba = target;
    for (const k of keys) {
      if (checkVariants && Array.isArray(prueba) && !arrayIndex.test(k)) {
        throw Object.assign(new Error(`${dotted}: la lista solo admite índices numéricos`), { status: 400 });
      }
      if (Array.isArray(prueba) && /^\d+$/.test(k) && Number(k) > prueba.length) {
        throw Object.assign(new Error(`${dotted}: el índice ${k} se sale de la lista (${prueba.length} elemento${prueba.length === 1 ? '' : 's'}); usa un índice entre 0 y ${prueba.length}`), { status: 400 });
      }
      prueba = prueba == null ? undefined : prueba[k];
    }
    let obj = target;
    for (const k of keys.slice(0, -1)) {
      // tramo intermedio numérico: mismo límite que el final, antes de crear o mutar nada (#158)
      if (Array.isArray(obj) && /^\d+$/.test(k) && Number(k) > obj.length) {
        throw Object.assign(new Error(`${dotted}: el índice ${k} se sale de la lista (${obj.length} elemento${obj.length === 1 ? '' : 's'}); usa un índice entre 0 y ${obj.length}`), { status: 400 });
      }
      if (obj[k] === undefined || obj[k] === null || typeof obj[k] !== 'object') obj[k] = /^\d+$/.test(k) ? [] : {};
      obj = obj[k];
    }
    const last = keys.at(-1);
    let fuera = 0;
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
      obj[last] = typeof value === 'object' && value !== null
        ? JSON.parse(JSON.stringify(value), (k, v) => (PROTO_KEYS.has(k) ? (fuera++, undefined) : v))
        : value;
    }
    if (checkVariants) {
      const [error] = validateChatVariantsTransition(this.config.widgets?.chatVariants, target.widgets?.chatVariants, this.config.widgets?.chat);
      if (error) throw Object.assign(new Error(error.message), { status: 400 });
      this.config = target;
    }
    if (programPatch) this.config.program = deepMerge(this.config.program, programPatch);
    if (fuera) console.warn(`${dotted}: se ignoran ${fuera} clave(s) del prototipo (__proto__, constructor, prototype)`);
    await this.write(this.cfgFile, this.config);
    this.emit('change', { [keys[0]]: true, ...(programPatch ? { program: true } : {}) });
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
  /** Config apta para el panel: oculta secretos y credenciales en las URL de programa. */
  publicConfig() {
    const c = structuredClone(this.config);
    c.themes = { activeId: c.themes.activeId, saved: publicThemes(c.themes) };
    c.discord = { ...c.discord, webhookUrl: this.secrets.discord?.webhookUrl ? '••••' : '', webhookUrlSet: !!this.secrets.discord?.webhookUrl };
    c.scheduleCalendar = { ...c.scheduleCalendar, token: this.secrets.scheduleCalendar?.token ? '••••' : '', tokenSet: !!this.secrets.scheduleCalendar?.token };
    c.obs = { ...c.obs, url: cleanUrl(c.obs?.url), passwordSet: !!this.secrets.obs?.password };
    delete c.obs.password;
    if (c.meld && typeof c.meld === 'object') c.meld.url = cleanUrl(c.meld.url);
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
