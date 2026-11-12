// Registro del directo: eventos con su minuto, totales, últimos, objetivo y créditos.
import { readFile, readdir, rename, unlink, lstat, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { writeJson, serialize } from './json-file.mjs';
import { ALERT_TYPES, isSystemType } from './alerts.mjs';
import { splitEventsOffsets, platformValue } from './goals.mjs';
import { isTotalMetric } from './channel-totals.mjs';

// El resumen conserva su zona histórica; solo se fija el formato visible (#126).
const summaryDateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Madrid', calendar: 'gregory', numberingSystem: 'latn',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
function summaryStamp(at) {
  if (at === undefined || at === null || at === '') return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(summaryDateFormat.formatToParts(d).map(({ type, value }) => [type, value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

export const METRICS = {
  follows:    { label: 'Seguidores',       types: ['follow', 'ytsub'],             sum: false },
  subs:       { label: 'Suscripciones',    types: ['sub', 'resub', 'giftsub'],     sum: 'subs' },
  bits:       { label: 'Bits',             types: ['cheer'],                       sum: 'amount' },
  raids:      { label: 'Raids',            types: ['raid'],                        sum: false },
  superchats: { label: 'Super Chats (€)',  types: ['superchat', 'supersticker'],   sum: 'amount' },
  members:    { label: 'Miembros',         types: ['member', 'giftmember'],        sum: 'members' },
  events:     { label: 'Eventos',          types: Object.keys(ALERT_TYPES).filter(t => !isSystemType(t)), sum: false },
};

// cuánto aporta un evento a una métrica
function valueFor(metric, ev) {
  const m = METRICS[metric];
  if (!m || !m.types.includes(ev.type)) return 0;
  const amount = Number(ev.vars?.amount) || 0;
  if (m.sum === 'amount') return amount;
  if (m.sum === 'subs') return ev.type === 'giftsub' ? (amount || 1) : 1;
  if (m.sum === 'members') return ev.type === 'giftmember' ? (amount || 1) : 1;
  return 1;
}

export const NOTE_KINDS = ['marker', 'highlight', 'saved', 'question', 'winner', 'queue'];
export const NOTE_LABELS = { marker: 'Marca de short', highlight: 'Mensaje destacado', saved: 'Guardado', question: 'Pregunta', winner: 'Ganador del sorteo', queue: 'Cola del overlay' };

// Etiqueta segura: el error público nunca expone ruta, errno ni valores; el crudo queda en `cause`.
const SESSION_SAVE_MESSAGE = 'No se pudo guardar la sesión; los cambios permanecen en memoria pendientes de guardado';
function sessionPersistenceError(err) {
  const e = new Error(SESSION_SAVE_MESSAGE);
  e.code = 'SESSION_PERSISTENCE_FAILED';
  e.status = 500;
  e.cause = err;
  return e;
}

// Recuperación al cargar. Mensajes públicos constantes y acotados (sin ruta,
// errno ni crudo) y clasificación de fichero reutilizable por primary y backup.
const SESSION_RECOVERY_BLOCKED = 'No se pudo leer o recuperar la sesión; el arranque está bloqueado para evitar un historial vacío. Los ficheros existentes se conservan para su revisión.';
const SESSION_RECOVERY_RESTORED = 'La sesión se ha recuperado desde la copia de seguridad; revise el estado de recuperación antes de continuar.';
const SAFE_ROOT_ID = /^[\w-]+$/;
const QUARANTINE_NAME = /^session-current\.corrupt-[\w-]+\.json$/;

// Error público de bloqueo: sin `cause`, para no transportar el crudo ni el SyntaxError.
function recoveryBlockedError() {
  const e = new Error(SESSION_RECOVERY_BLOCKED);
  e.code = 'SESSION_RECOVERY_FAILED';
  e.status = 500;
  return e;
}
// #68: marca temporal del id de sesión (`<fechaZ>-<uuid>`); para ids legacy, el propio id.
const idTimestamp = id => {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)-/.exec(id);
  return m ? m[1] : id;
};
const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isValidDate = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const VIEWER_SERIES_PLATFORMS = ['twitch', 'youtube'];
const VIEWER_GAP_REASONS = ['error', 'offline', 'disconnected', 'restart'];
// La serie nueva se valida antes de mutar un checkpoint, igual que la raíz legacy.
function isValidViewerSeries(series) {
  if (!isPlainObject(series) || !Array.isArray(series.samples) || !Array.isArray(series.gaps)) return false;
  const ordered = (rows, key) => rows.every((row, i) => isPlainObject(row) && isValidDate(row[key])
    && (!i || Date.parse(rows[i - 1][key]) <= Date.parse(row[key])));
  return ordered(series.samples, 'at') && series.samples.every(s => Number.isFinite(s.value) && s.value >= 0)
    && ordered(series.gaps, 'from') && series.gaps.every((g, i) => isValidDate(g.to)
      && Date.parse(g.to) >= Date.parse(g.from) && VIEWER_GAP_REASONS.includes(g.reason)
      && (!i || Date.parse(series.gaps[i - 1].to) <= Date.parse(g.from)))
    && (series.intervals === undefined || (Array.isArray(series.intervals) && ordered(series.intervals, 'from')
      && series.intervals.every(v => Number.isFinite(v.seconds) && v.seconds > 0)))
    && (series.openGap === undefined || (typeof series.openGap === 'boolean' && (!series.openGap || series.gaps.length > 0)));
}

/** Métricas independientes: cada lectura dura como máximo su intervalo, sin cruzar huecos. */
export function viewerMetrics(data, now = Date.now()) {
  if (!data.viewers) return undefined;
  const start = Date.parse(data.startedAt), end = Math.max(start, data.endedAt ? Date.parse(data.endedAt) : Number(now));
  const liveSeconds = Math.max(0, (end - start) / 1000);
  const result = {};
  for (const platform of VIEWER_SERIES_PLATFORMS) {
    const series = data.viewers[platform];
    if (!series) continue;
    const samples = series.samples || [], gaps = series.gaps || [], intervals = series.intervals || [];
    let weighted = 0, covered = 0, peak = null, gapIndex = 0, intervalIndex = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i], at = Date.parse(sample.at);
      peak = peak === null ? sample.value : Math.max(peak, sample.value);
      while (intervalIndex + 1 < intervals.length && Date.parse(intervals[intervalIndex + 1].from) <= at) intervalIndex++;
      const seconds = intervals[intervalIndex]?.seconds ?? 60;
      let cursor = Math.max(start, at);
      const limit = Math.min(end, Date.parse(samples[i + 1]?.at) || Infinity, at + seconds * 1000);
      while (gapIndex < gaps.length && Date.parse(gaps[gapIndex].to) <= cursor && !(series.openGap && gapIndex === gaps.length - 1)) gapIndex++;
      let j = gapIndex;
      while (j < gaps.length && cursor < limit) {
        const gap = gaps[j], from = Date.parse(gap.from);
        const to = series.openGap && j === gaps.length - 1 ? end : Date.parse(gap.to);
        if (from >= limit) break;
        const duration = Math.max(0, Math.min(from, limit) - cursor);
        covered += duration; weighted += duration * sample.value;
        cursor = Math.max(cursor, to); j++;
      }
      const duration = Math.max(0, limit - cursor);
      covered += duration; weighted += duration * sample.value;
    }
    const coveredSeconds = covered / 1000;
    result[platform] = { average: covered ? weighted / covered : null, peak,
      coverage: { liveSeconds, coveredSeconds, ratio: liveSeconds ? coveredSeconds / liveSeconds : 0 } };
  }
  return result;
}
const CHAT_PLATFORMS = ['twitch', 'youtube'];

/** Recuentos observados; los minutos sin mensajes no necesitan una fila almacenada. */
export function chatMetrics(data, now = Date.now(), includeSeries = true) {
  if (data.chatStats === undefined) return undefined;
  const start = Date.parse(data.startedAt);
  const elapsed = Math.max(0, (data.endedAt ? Date.parse(data.endedAt) : Number(now)) - start) / 60000;
  const out = {};
  for (const platform of CHAT_PLATFORMS) {
    const stats = data.chatStats[platform];
    if (!stats) continue;
    const messages = stats.minutes.reduce((sum, minute) => sum + minute.messages, 0);
    out[platform] = { uniqueChatters: stats.authorIds.length, messages, messagesPerMinute: elapsed > 0 ? messages / elapsed : null,
      ...(includeSeries ? { minutes: stats.minutes.map(({ at, messages }) => ({ at, messages })) } : {}) };
  }
  return out;
}

/** La raíz persistida conserva identidades privadas; las respuestas solo llevan agregados. */
export function publicSession(data) {
  const { chatStats, chatListeners, ...out } = data;
  return chatStats === undefined ? out : { ...out, chatMetrics: chatMetrics(data) };
}

function isValidChatStats(stats) {
  return isPlainObject(stats) && Object.keys(stats).every(platform => {
    const s = stats[platform];
    if (!CHAT_PLATFORMS.includes(platform) || !isPlainObject(s) || !Array.isArray(s.authorIds) || !Array.isArray(s.minutes)) return false;
    if (!s.authorIds.every(id => typeof id === 'string' && id.length > 0) || new Set(s.authorIds).size !== s.authorIds.length) return false;
    if (!s.minutes.every((m, i) => isPlainObject(m) && isValidDate(m.at) && Number.isSafeInteger(m.messages) && m.messages > 0
      && (!i || Date.parse(s.minutes[i - 1].at) < Date.parse(m.at)))) return false;
    return s.authorIds.length <= s.minutes.reduce((sum, m) => sum + m.messages, 0);
  });
}

// Validación estructural mínima de la raíz (sin framework): id/startedAt legacy y arrays.
// events null/entradas null son inválidos; notes/goalOffsets null caen a sus defaults.
export function isValidRoot(d) {
  if (!isPlainObject(d)) return false;
  if (d.id !== undefined && (typeof d.id !== 'string' || !SAFE_ROOT_ID.test(d.id))) return false;
  if (d.startedAt !== undefined && !isValidDate(d.startedAt)) return false;
  if (d.events !== undefined && (!Array.isArray(d.events) || d.events.some(e => !isPlainObject(e)))) return false;
  if (d.notes !== undefined && d.notes !== null && (!Array.isArray(d.notes) || d.notes.some(nd => !isPlainObject(nd)))) return false;
  if (d.goalOffsets !== undefined && d.goalOffsets !== null && !isPlainObject(d.goalOffsets)) return false;
  if (d.viewers !== undefined && (!isPlainObject(d.viewers)
    || VIEWER_SERIES_PLATFORMS.some(p => d.viewers[p] !== undefined && !isValidViewerSeries(d.viewers[p])))) return false;
  if (d.chatStats !== undefined && !isValidChatStats(d.chatStats)) return false;
  if (d.chatListeners !== undefined && (!isPlainObject(d.chatListeners)
    || Object.keys(d.chatListeners).some(p => !CHAT_PLATFORMS.includes(p) || d.chatListeners[p] !== true))) return false;
  return true;
}
// Rellena solo los defaults legacy ausentes; conserva íntegro todo lo demás (campos desconocidos incluidos).
function normalizeRoot(d) {
  const base = Session.fresh();
  return {
    ...base, ...d,
    id: d.id ?? base.id, startedAt: d.startedAt ?? base.startedAt,
    events: d.events ?? [], notes: d.notes ?? [], goalOffsets: d.goalOffsets ?? {},
  };
}
// Clasifica el fichero: ok | missing | corrupt | ioerror. Un fallo de IO distinto de ENOENT
// no es corrupción y se trata aparte (bloqueo sin cuarentena ni fallback).
async function readClassified(io, file) {
  let text;
  try { text = await io.readFile(file, 'utf8'); }
  catch (err) { return err?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'ioerror' }; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { kind: 'corrupt' }; }
  return isValidRoot(parsed) ? { kind: 'ok', data: parsed } : { kind: 'corrupt' };
}

const CREDIT_GROUPS = [
  ['Raids', ['raid']], ['Suscripciones', ['sub', 'resub', 'giftsub']], ['Bits', ['cheer']],
  ['Super Chats', ['superchat', 'supersticker']], ['Miembros', ['member', 'milestone', 'giftmember']],
  ['Recompensas', ['redemption']], ['Nuevos seguidores', ['follow', 'ytsub']],
];

export class Session extends EventEmitter {
  constructor(dir, { writer = writeJson, report = () => {}, debounceMs = 300, maxWaitMs = 2000, maxArchived = 0, io } = {}) {
    super();
    this.dir = path.join(dir, 'sessions');
    this.file = path.join(dir, 'session-current.json');
    // Copia de respaldo fija de la instancia, hermana del primary.
    this.backupFile = path.join(dir, 'session-current.backup.json');
    this.data = Session.fresh();
    this.writer = writer;
    this.report = report;
    // IO de carga inyectable; los métodos ausentes caen a los defaults reales.
    // `lstat`/`access` son el seam opcional para comprobar el destino del archivo.
    this.io = { readFile, rename, readdir, lstat, access, unlink, ...io };
    this.recovery = { source: 'fresh', preservedFiles: 0, message: null };
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    // #68: retención de sesiones archivadas. Número máximo que se conserva (0 = sin
    // límite, valor por defecto). Puede ser una función (la configuración es leída
    // en vivo por el servidor) o un número directo.
    this.retentionLimit = typeof maxArchived === 'function'
      ? () => Math.max(0, Math.floor(Number(maxArchived()) || 0))
      : () => Math.max(0, Math.floor(Number(maxArchived) || 0));
    this.saveT = null;                 // debounce: cada mutación reinicia la cuenta
    this.maxT = null;                  // checkpoint por primer cambio sucio: no se reinicia
    this.chain = Promise.resolve();    // cola por instancia; la cola interna se recupera para el siguiente trabajo
    this.lastSaveError = null;
    // Transición serializada + un único archivo pendiente (sin diarios ni colas ocultas).
    this.transitionChain = Promise.resolve();
    this.pendingArchive = null;
    this.replacedIdentity = null; // solo memoria: identidad del directo inmediatamente anterior
    this.identityStartedAt = process.hrtime.bigint(); // monotónico, independiente del reloj de pared
    this.viewerRestarts = new Set(); // solo memoria: primer sondeo tras cargar un directo abierto
    this.chatAuthors = new WeakMap(); // índices de deduplicación; el array validado es la copia durable
  }
  static fresh(title = '') {
    return { id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`, title, startedAt: new Date().toISOString(), events: [], notes: [], goalOffsets: {} };
  }
  // Carga estricta: valida el primary; si es inválido o falta, recupera del backup o bloquea.
  // Nunca escribe el primary/backup (el primary puede faltar hasta el primer flush explícito).
  async #loadBase() {
    const dir = path.dirname(this.file);
    const primary = await readClassified(this.io, this.file);
    if (primary.kind === 'ioerror') throw this._blockRecovery(0);   // permiso/IO: no es corrupción
    if (primary.kind === 'ok') {
      this.data = normalizeRoot(primary.data);
      this.recovery = { source: 'primary', preservedFiles: 0, message: null };
      return this;
    }

    // Primary ausente: una sola lectura del directorio decide si existe backup y si hay
    // cuarentenas previas, evitando un readFile garantizado a ENOENT sobre el backup.
    if (primary.kind === 'missing') {
      let names = [];
      try { names = await this.io.readdir(dir); }
      catch (err) { if (err?.code !== 'ENOENT') throw this._blockRecovery(0); }
      if (!names.includes(path.basename(this.backupFile))) {
        const prior = names.filter(n => QUARANTINE_NAME.test(n)).length;
        if (!prior) {   // primer arranque normal
          this.data = Session.fresh();
          this.recovery = { source: 'fresh', preservedFiles: 0, message: null };
          return this;
        }
        throw this._blockRecovery(Math.min(2, prior));   // historial dañado conocido: no finge un fresco
      }
      const backup = await readClassified(this.io, this.backupFile);
      if (backup.kind === 'ioerror') throw this._blockRecovery(0);
      if (backup.kind !== 'ok') throw this._blockRecovery(1);   // backup inválido: se deja IN PLACE
      this.data = normalizeRoot(backup.data);
      this.recovery = { source: 'backup', preservedFiles: 0, message: SESSION_RECOVERY_RESTORED };
      this._warnRecovery(SESSION_RECOVERY_RESTORED);
      return this;
    }

    // Primary corrupto: cuarentena si el backup es válido; si no, bloqueo con el original IN PLACE.
    const backup = await readClassified(this.io, this.backupFile);
    if (backup.kind === 'ioerror') throw this._blockRecovery(0);
    if (backup.kind === 'ok') {
      try { await this.io.rename(this.file, path.join(dir, `session-current.corrupt-${randomUUID()}.json`)); }
      catch { throw this._blockRecovery(1); }   // si el rename falla, el corrupto queda IN PLACE
      this.data = normalizeRoot(backup.data);
      this.recovery = { source: 'backup', preservedFiles: 1, message: SESSION_RECOVERY_RESTORED };
      this._warnRecovery(SESSION_RECOVERY_RESTORED);
      return this;
    }
    // Sin copia válida: se dejan los originales malos IN PLACE para que el reinicio siga bloqueando.
    throw this._blockRecovery(1 + (backup.kind === 'corrupt' ? 1 : 0));
  }
  /** Metadatos de recuperación del arranque (copia defensiva). */
  recoveryState() { return { ...this.recovery }; }
  /** Estado plano y copiado del archivo pendiente (nunca rutas ni crudo). */
  archiveState() {
    const entry = this.pendingArchive;
    return { pendingCount: entry ? 1 : 0, sessionId: entry ? entry.data.id : null, error: this.lastSaveError || null };
  }
  /** Copia defensiva del directo anterior retenido mientras su archivo no está durable. */
  getPending() { return this.pendingArchive ? structuredClone(this.pendingArchive.data) : null; }
  _blockRecovery(preservedFiles) {
    this.recovery = { source: 'blocked', preservedFiles, message: SESSION_RECOVERY_BLOCKED };
    this._warnRecovery(SESSION_RECOVERY_BLOCKED);
    return recoveryBlockedError();
  }
  _warnRecovery(message) {
    try { this.report(message); } catch { /* un report roto no cambia la restauración ni el bloqueo */ }
  }
  /** Carga (#128): tras leer (o recuperar) la sesión, reparte el offset legacy de «events»
   *  en claves por plataforma UNA sola vez (marcador). Marker + claves nuevas viven en el
   *  mismo objeto y se persisten JUNTOS en un checkpoint; un fallo de escritura rechaza
   *  aquí y arriba: las rutas de ajustes no se sirven sobre un estado sin inicializar. */
  async load() {
    await this.#loadBase();
    let resumed = false;
    if (this.data.meldAutoSession && !this.data.endedAt && this.data.viewers) {
      this.viewerRestarts = new Set(Object.keys(this.data.viewers));
      const at = new Date().toISOString();
      for (const platform of VIEWER_SERIES_PLATFORMS) {
        const series = this.data.viewers[platform];
        if (series && this._viewerResume(platform, series, at, true)) resumed = true;
      }
    }
    const r = splitEventsOffsets(this.data);
    if (r.changed) await this.flush();
    else if (resumed) this.save();
    return this;
  }

  // Programa el guardado: 300 ms de reposo o, como tope, 2000 ms desde el primer cambio sucio.
  save() {
    const run = () => { this.flush().catch(() => {}); };   // el fallo ya lo reporta flush; aquí no se duplica
    if (this.saveT) clearTimeout(this.saveT);
    this.saveT = setTimeout(run, this.debounceMs);
    if (!this.maxT) {
      this.maxT = setTimeout(run, this.maxWaitMs);
    }
  }
  // El archivo de destino existe (se rechaza antes del corte, sin sobrescribir).
  async _targetExists(file) {
    try { await this.io.lstat(file); return true; }
    catch (err) { if (err?.code === 'ENOENT') return false; throw err; }
  }
  // Pipeline OLD (backup -> primary -> archivo) encolado UNA vez por intento. Mientras
  // haya `inFlight`, todos los flush comparten la MISMA promesa y NO vuelven a encolar
  // el checkpoint OLD: re-escribirlo tras un NEW ya guardado revertiría el canonical.
  _oldPipeline() {
    const entry = this.pendingArchive;
    const prior = this.chain;
    if (entry.inFlight) return Promise.all([prior, entry.inFlight]);
    let backupRun, primaryRun, archiveRun, metaRun, syncErr;
    try {
      // #67: una sola serialización por intento OLD (backup + primary + archivo comparten texto).
      const text = serialize(entry.data);
      backupRun = this.writer(this.backupFile, entry.data, { after: prior, text });
      primaryRun = this.writer(this.file, entry.data, { after: backupRun, text });
      archiveRun = this.writer(entry.file, entry.data, { after: primaryRun, text });
      // #68: metadatos ligeros junto al archivo, para listar sin leerlo completo.
      // #164: best-effort, pero el corte SÍ espera a que se asienten: un writer lento
      // no puede dejar el meta pendiente cuando el archivado ya se da por resuelto.
      // Un fallo aquí nunca falla el corte; el listado cae a la lectura completa.
      try { metaRun = Promise.resolve(this.writer(this._metaFile(entry.file), this._metaOf(entry.data), { after: archiveRun })); }
      catch { metaRun = Promise.resolve(); }   // writer síncrono roto: se ignora, como un rechazo
      metaRun.catch(() => {});
    } catch (err) {
      syncErr = err;
      if (backupRun) Promise.resolve(backupRun).catch(() => {});
      if (primaryRun) Promise.resolve(primaryRun).catch(() => {});
    }
    const started = syncErr ? Promise.reject(syncErr) : Promise.resolve(archiveRun);
    // El meta comparte la puerta del archivado; se asienta (sin propagar su fallo, ya
    // consumido arriba) antes de retirar el pendiente y aplicar retención.
    const metaSettled = metaRun ? metaRun.then(() => {}, () => {}) : Promise.resolve();
    const raw = started.then(
      () => metaSettled.then(() => {
        if (this.pendingArchive === entry) this.pendingArchive = null;
        return this._applyRetention().catch(() => {});
      }),
      err => { if (this.pendingArchive === entry) entry.inFlight = null; throw err; }
    );
    raw.catch(() => {});                 // el productor ve el fallo por la puerta `after`
    entry.inFlight = raw;
    return Promise.all([prior, raw]);
  }
  // Escribe SIEMPRE el estado actual, aunque nadie haya llamado a save(): las mutaciones
  // directas de `data` siguen persistiendo con el flush explícito (sin fingerprint ni skip).
  // La instantánea se toma aquí, de forma síncrona, antes de esperar la cola o la puerta.
  // Con archivo pendiente, el OLD durable (backup+primary+archivo) precede a todo I/O NEW.
  flush() {
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; }
    if (this.maxT) { clearTimeout(this.maxT); this.maxT = null; }
    const oldGate = this.pendingArchive ? this._oldPipeline() : this.chain;
    // Un writer síncrono puede fallar antes de consumir after; el productor conserva la puerta original.
    oldGate.catch(() => {});
    // Dos escrituras por checkpoint, sin await intermedio. La instantánea se toma de
    // forma síncrona en cada llamada antes de cualquier I/O. El backup
    // se encola tras la puerta OLD y el primary tras el backup: si el backup falla, la
    // puerta impide el I/O del primary aunque su petición ya esté encolada.
    let backupRun, primaryRun;
    try {
      // #67: una sola serialización por checkpoint; el texto compacto compartido va al
      // backup y al primary sin volver a pasar por JSON.stringify dentro del writer.
      const text = serialize(this.data);
      backupRun = this.writer(this.backupFile, this.data, { after: oldGate, text });
      primaryRun = this.writer(this.file, this.data, { after: backupRun, text });
      // los rechazos individuales ya viajan por la cadena `next` de abajo; sin esto, un
      // writer que falla siempre (p. ej. inyectado en pruebas) dispararía unhandledRejection
      backupRun.catch(() => {});
      primaryRun.catch(() => {});
    } catch (err) {
      // Un writer inyectado puede lanzar de forma síncrona tras crear la promesa del
      // backup; se consume ese rechazo huérfano para no disparar un unhandledRejection.
      if (backupRun) Promise.resolve(backupRun).catch(() => {});
      primaryRun = Promise.reject(err);
    }
    const next = Promise.resolve(backupRun)
      .then(() => primaryRun)   // el resultado real lo da la cadena backup→primary: un fallo del
                                // backup no queda huérfano ni se silencia el del primary
      .then(
      () => { this.lastSaveError = null; },
      err => {
        const e = sessionPersistenceError(err);
        if (!this.lastSaveError) {
          this.lastSaveError = e.message;
          try { this.report(e.message); } catch { /* un report roto no cambia el resultado del IO */ }
        }
        throw e;
      }
    );
    this.chain = next.catch(() => {});   // la cola nunca se envenena
    return next;
  }

  /** Registra una alerta real (no pruebas). */
  record(alert) {
    const ev = { id: alert.id, type: alert.type, at: alert.at, user: alert.vars?.user || alert.text, vars: alert.vars || {}, text: alert.text, sub: alert.sub, variation: alert.variation?.name || null };
    if (isSystemType(alert.type)) ev.thanked = true;   // un récord no se agradece a nadie
    this.data.events.push(ev);
    this.save();
    this.emit('change', { event: ev });
    return ev;
  }

  // ---------- cronología: notas que no son alertas (marcas de short, mensajes destacados, guardados, ganadores…) ----------
  /** kind: marker | highlight | saved | question | winner */
  addNote({ kind = 'saved', text = '', user = '', platform = '', label = '', at, ...extra } = {}) {
    if (!NOTE_KINDS.includes(kind)) throw Object.assign(new Error(`Tipo de nota desconocido: ${kind}. Tipos: ${NOTE_KINDS.join(', ')}`), { status: 400 });
    const n = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, at: at || new Date().toISOString(),
      text: String(text || '').slice(0, 500), user: String(user || '').slice(0, 60), platform, label: String(label || '').slice(0, 120), ...extra };
    n.offset = this.offset(n.at);
    (this.data.notes ||= []).push(n);
    this.save();
    this.emit('change', { note: n });
    return n;
  }
  note(id) {
    const n = (this.data.notes || []).find(x => x.id === id);
    if (!n) throw Object.assign(new Error(`No existe la nota «${id}» en la cronología`), { status: 404 });
    return n;
  }
  updateNote(id, patch = {}) {
    const n = this.note(id);
    for (const k of ['label', 'text', 'done']) if (patch[k] !== undefined) n[k] = k === 'done' ? !!patch[k] : String(patch[k]).slice(0, k === 'label' ? 120 : 500);
    this.save(); this.emit('change', { note: n });
    return n;
  }
  removeNote(id) {
    this.note(id);
    this.data.notes = this.data.notes.filter(x => x.id !== id);
    this.save(); this.emit('change', { removed: id });
  }
  /** Marca un evento (alerta) o una nota como agradecido / hecho. */
  setThanked(id, value = true) {
    const ev = this.data.events.find(e => e.id === id);
    if (ev) { ev.thanked = !!value; this.save(); this.emit('change', { thanked: id }); return ev; }
    return this.updateNote(id, { done: value });
  }
  /** Segundos desde que empezó el directo. */
  offset(at = new Date().toISOString(), data = this.data) {
    return Math.max(0, Math.round((new Date(at) - new Date(data.startedAt)) / 1000));
  }
  /** Eventos y notas juntos, en orden. */
  timeline(data = this.data) {
    const events = data.events.map(e => ({ id: e.id, kind: 'event', type: e.type, at: e.at, offset: this.offset(e.at, data), user: e.user, text: e.text, sub: e.sub, amount: e.vars?.amount, message: e.vars?.message, done: !!e.thanked }));
    const notes = (data.notes || []).map(n => ({ ...n, offset: this.offset(n.at, data), done: !!n.done }));
    return [...events, ...notes].sort((a, b) => new Date(a.at) - new Date(b.at));
  }
  pendingThanks(data = this.data) { return data.events.filter(e => !e.thanked).length; }

  _identityOf(data) {
    return { id: data.id, youtube: data.platforms?.youtube?.videoId, twitch: data.platforms?.twitch?.streamId };
  }
  // La foto de reconexión se toma en la cola, después de identidades ya aceptadas.
  captureIdentity() {
    const run = this.transitionChain.then(() => this._identityOf(this.data));
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  // Las observaciones y los cortes comparten la misma cola: una identidad llegada
  // durante un inicio pertenece al directo nuevo y no se pierde al cerrar enseguida.
  recordPlatform(platform, value, after, { reconnect, expectedId, requestedAt, discovery = true, onRollover = () => {}, enabled = () => true } = {}) {
    const seenAt = new Date().toISOString();
    const keys = platform === 'youtube' ? ['videoId', 'liveChatId', 'title'] : platform === 'twitch' ? ['streamId', 'startedAt'] : [];
    const fields = Object.fromEntries(keys.filter(k => typeof value?.[k] === 'string' && (k === 'title' || value[k])).map(k => [k, value[k]]));
    const idKey = keys[0];
    if (!idKey || !fields[idKey]) return Promise.resolve();
    const run = this.transitionChain.then(async () => {
      const requestedId = after ? (await after)?.id : expectedId;
      if (!requestedId || !enabled() || this.data.endedAt) return;
      let old = this.data.platforms?.[platform];
      const replaced = this.replacedIdentity?.currentId === this.data.id ? this.replacedIdentity : null;
      const priorId = replaced?.[platform];
      const requestedHere = requestedId === this.data.id;
      // De la sesión anterior solo cruza un id que se sabe distinto; el mismo
      // necesita una búsqueda nueva. Sin id previo no se inventa la relación.
      if (!requestedHere && (!priorId || priorId === fields[idKey])) return;
      const confirmed = requestedHere && discovery && (requestedAt === undefined || requestedAt >= this.identityStartedAt);
      if (priorId && priorId === fields[idKey] && !confirmed && old?.[idKey] !== fields[idKey]) return;
      const previous = reconnect ? await reconnect : null;
      if (previous?.id === this.data.id && previous[platform] && previous[platform] !== fields[idKey]) {
        // El corte usa el mismo pipeline OLD/NEW que un inicio manual.
        onRollover();
        await this._cutover('', true);
        if (!enabled()) return;
        old = this.data.platforms?.[platform];
      }
      if (old && old[idKey] !== fields[idKey]) return; // otro broadcast sin reconexión: conservar el primero
      const next = old ? { ...old } : { ...fields, seenAt };
      if (old) for (const [key, val] of Object.entries(fields)) if (next[key] === undefined) next[key] = val;
      if (!old || !isDeepStrictEqual(old, next)) {
        (this.data.platforms ||= {})[platform] = next;
        this.save();
        this.emit('change', { platform });
      }
      return this.data;
    });
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  // Huecos contiguos del mismo motivo se fusionan; no se inventa una lectura.
  _viewerGap(series, from, to, reason, open = false) {
    const last = series.gaps.at(-1);
    if (last && last.reason === reason && last.to === from) last.to = to;
    else series.gaps.push({ from, to, reason });
    series.openGap = open;
  }
  _viewerResume(platform, series, at, open = false) {
    if (!this.viewerRestarts.has(platform)) return false;
    const lastSample = series.samples.at(-1)?.at, lastGap = series.gaps.at(-1)?.to;
    const from = [lastSample, lastGap].filter(Boolean).sort().at(-1);
    if (from && from > at) return false; // el reloj puede haber retrocedido
    this.viewerRestarts.delete(platform);
    if (!from) return false;
    series.openGap = false;
    this._viewerGap(series, from, at, 'restart', open);
    return true;
  }
  _closeViewerGaps(at) {
    for (const platform of VIEWER_SERIES_PLATFORMS) {
      const series = this.data.viewers?.[platform];
      if (!series) continue;
      this._viewerResume(platform, series, at);
      if (series.openGap) {
        const gap = series.gaps.at(-1);
        if (gap && at > gap.to) gap.to = at;
        series.openGap = false;
      }
    }
  }
  // Una observación comparte la cola de identidad y cortes: no puede escribir en
  // otra sesión ni aceptar una lectura de un broadcast no admitido por #100.
  recordViewer(platform, observation, target, admission, enabled = () => true) {
    const run = this.transitionChain.then(async () => {
      const requested = typeof target === 'string' ? target : (await target)?.id;
      const admitted = admission ? (await admission)?.id : null;
      if (!enabled() || this.data.endedAt || !this.data.meldAutoSession || !VIEWER_SERIES_PLATFORMS.includes(platform)) return;
      const isSample = observation.reason === undefined;
      if (isSample && platform === 'twitch') {
        if (admitted !== this.data.id || this.data.platforms?.twitch?.streamId !== observation.streamId) return;
      } else if (requested !== this.data.id) return;
      if (isSample && platform === 'youtube' && (!observation.videoId || this.data.platforms?.youtube?.videoId !== observation.videoId)) return;
      // El corte puede esperar I/O: la identidad admitida conserva también las
      // lecturas capturadas durante esa espera, con su hora real de captura.
      if (!isValidDate(observation.at)) return;
      const viewers = this.data.viewers ||= {};
      const series = viewers[platform] ||= { samples: [], gaps: [], intervals: [] };
      const lastAt = [series.samples.at(-1)?.at, series.gaps.at(-1)?.to].filter(Boolean).sort().at(-1);
      if (lastAt && observation.at < lastAt) return;
      this._viewerResume(platform, series, observation.at);
      if (series.openGap) {
        const last = series.gaps.at(-1);
        last.to = observation.at;
        if (observation.reason === last.reason) { this.save(); return; }
        series.openGap = false;
      }
      if (!isSample) {
        this._viewerGap(series, observation.at, observation.at, observation.reason, true);
      } else {
        const intervals = series.intervals ||= [];
        if (intervals.at(-1)?.seconds !== observation.intervalSec) intervals.push({ from: observation.at, seconds: observation.intervalSec });
        series.samples.push({ at: observation.at, value: observation.value });
      }
      this.save();
    });
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  // Mensajes y listeners comparten exactamente la misma barrera de propiedad.
  _ownsChat(platform, observation, captured, enabled) {
    if (!enabled() || !this.data.meldAutoSession || this.data.endedAt || captured?.id !== this.data.id || !CHAT_PLATFORMS.includes(platform)) return false;
    if (platform === 'youtube' && (!observation.videoId || this.data.platforms?.youtube?.videoId !== observation.videoId
      || !observation.liveChatId || this.data.platforms?.youtube?.liveChatId !== observation.liveChatId)) return false;
    const streamId = captured.twitch || captured.platforms?.twitch?.streamId;
    return !(platform === 'twitch' && streamId && this.data.platforms?.twitch?.streamId && streamId !== this.data.platforms.twitch.streamId);
  }
  _markChatListener(platform) {
    if (this.data.chatListeners?.[platform] === true) return false;
    (this.data.chatListeners ||= {})[platform] = true;
    return true;
  }
  recordChatListener(platform, observation, target, enabled = () => true) {
    const run = this.transitionChain.then(async () => {
      const captured = typeof target === 'string' ? { id: target } : await target;
      if (this._ownsChat(platform, observation, captured, enabled) && this._markChatListener(platform)) this.save();
    });
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  // El contexto se captura al recibir el mensaje, no al terminar una transición.
  recordChat(platform, observation, target, enabled = () => true) {
    const run = this.transitionChain.then(async () => {
      const captured = typeof target === 'string' ? { id: target } : await target;
      if (!this._ownsChat(platform, observation, captured, enabled) || !isValidDate(observation.at)) return;
      this._markChatListener(platform);
      const start = Date.parse(this.data.startedAt);
      const at = new Date(start + Math.max(0, Math.floor((Date.parse(observation.at) - start) / 60000)) * 60000).toISOString();
      const stats = (this.data.chatStats ||= {})[platform] ||= { authorIds: [], minutes: [] };
      let authors = this.chatAuthors.get(stats);
      if (!authors) { authors = new Set(stats.authorIds); this.chatAuthors.set(stats, authors); }
      if (typeof observation.authorId === 'string' && observation.authorId && !authors.has(observation.authorId)) {
        authors.add(observation.authorId); stats.authorIds.push(observation.authorId);
      }
      const last = stats.minutes.at(-1);
      let minute = last?.at === at ? last : stats.minutes.find(m => m.at === at);
      if (!minute) {
        minute = { at, messages: 0 }; stats.minutes.push(minute);
        stats.minutes.sort((a, b) => a.at.localeCompare(b.at));
      }
      minute.messages++;
      this.save();
    });
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  // Marcar el actual cerrado mantiene su resumen accesible; el siguiente startNew
  // lo archivará por el pipeline habitual sin cambiar la hora real de cierre.
  endCurrent(at = new Date().toISOString(), { expectedId } = {}) {
    const run = this.transitionChain.then(async () => {
      // The HTTP request may have waited behind another start or identity rollover.
      if (expectedId !== undefined && this.data.id !== expectedId)
        throw Object.assign(new Error('La sesión actual ha cambiado. Actualiza antes de terminar el directo.'), { status: 409 });
      if (this.data.endedAt) return expectedId !== undefined ? structuredClone(this.data) : undefined;
      await this.flush();
      const endedAt = Date.parse(at) < Date.parse(this.data.startedAt) ? this.data.startedAt : at;
      this._closeViewerGaps(endedAt);
      this.data.endedAt = endedAt;
      this.emit('change', { ended: true });
      await this.flush();
      // Capture before any later transition can replace the targeted session.
      if (expectedId !== undefined) return structuredClone(this.data);
    });
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  // Corte serializado. Cada transición drena el pending previo y el
  // checkpoint actual antes de tocar el corte; cualquier fallo previo rechaza sin
  // añadir `endedAt` al directo actual ni sobrescribir un archivo existente.
  startNew(title = '', { meldAuto = false } = {}) {
    const run = this.transitionChain.then(() => this._cutover(title, meldAuto));
    this.transitionChain = run.then(() => {}, () => {});
    return run;
  }
  async _cutover(title, meldAuto) {
    await this.flush();
    let target, alreadyArchived = false;
    try {
      if (!SAFE_ROOT_ID.test(String(this.data.id))) throw new Error('id de sesión no seguro');
      target = path.join(this.dir, this.data.id + '.json');
      if (await this._targetExists(target)) {
        const archived = await readClassified(this.io, target);
        // Reinicio tras guardar OLD y fallar NEW: sólo reutilizar el cierre exacto.
        alreadyArchived = archived.kind === 'ok' && isValidDate(this.data.endedAt)
          && isDeepStrictEqual(archived.data, this.data);
        if (!alreadyArchived) throw new Error('el archivo de destino ya existe');
      }
    } catch (err) { throw sessionPersistenceError(err); }
    if (!alreadyArchived) {
      const endedAt = this.data.endedAt || new Date().toISOString();
      this._closeViewerGaps(endedAt);
      const oldSnapshot = { ...structuredClone(this.data), endedAt };
      this.pendingArchive = { data: oldSnapshot, file: target, inFlight: null };
    }
    const newData = Session.fresh(title);
    if (meldAuto) newData.meldAutoSession = true;
    this.replacedIdentity = { ...this._identityOf(this.data), currentId: newData.id };
    this.identityStartedAt = process.hrtime.bigint();
    this.viewerRestarts.clear();
    this.data = newData;
    const saved = this.flush();
    saved.catch(() => {});               // la persistencia arranca ya; el productor la espera abajo
    this.emit('change', { reset: true });
    await saved;
    return newData;
  }

  // #68: metadatos ligeros de un archivado, para listar sin parsear el archivo completo.
  _metaOf(data) {
    return { id: data.id, title: data.title, startedAt: data.startedAt, endedAt: data.endedAt, events: (data.events || []).length,
      ...(data.platforms !== undefined ? { platforms: data.platforms } : {}),
      ...(data.viewers !== undefined ? { viewerMetrics: viewerMetrics(data) } : {}),
      ...(data.chatStats !== undefined ? { chatMetrics: chatMetrics(data, Date.now(), false) } : {}) };
  }
  _metaFile(archiveFile) { return archiveFile.replace(/\.json$/, '.meta.json'); }
  // Retención (#68): tras archivar, deja como máximo las N sesiones más recientes
  // (0 = sin límite). Los fallos de borrado no rompen el corte ni el guardado.
  async _applyRetention() {
    const max = this.retentionLimit();
    if (!max) return;
    let names;
    try { names = await this.io.readdir(this.dir); } catch { return; }
    const files = names.filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'))
      .sort((a, b) => idTimestamp(b.slice(0, -5)).localeCompare(idTimestamp(a.slice(0, -5))) || b.localeCompare(a));
    for (const f of files.slice(max)) {
      if (this.pendingArchive?.data.id === f.slice(0, -5)) continue;
      try { await this.io.unlink(path.join(this.dir, f)); } catch { /* queda para la próxima vez */ }
      try { await this.io.unlink(path.join(this.dir, this._metaFile(f))); } catch { /* sin meta que borrar */ }
    }
  }
  /** Archive metadata, newest id first. `limit` defaults to the history view's 50 entries;
   *  pass Infinity to scan every archive (e.g. the thanks widget's last-stream cutoff). */
  async list({ limit = 50 } = {}) {
    const out = [];
    try {
      const files = (await this.io.readdir(this.dir)).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'))
        .sort((a, b) => idTimestamp(b.slice(0, -5)).localeCompare(idTimestamp(a.slice(0, -5))) || b.localeCompare(a));
      for (const f of files.slice(0, limit)) {
        // #68: primero el fichero de metadatos ligeros; el archivo completo solo se lee
        // una vez (compatibilidad) cuando no existe o está roto.
        let m = null;
        try { m = JSON.parse(await this.io.readFile(this._metaFile(path.join(this.dir, f)), 'utf8')); } catch { m = null; }
        if (!m || !m.id) {
          try { m = this._metaOf(JSON.parse(await this.io.readFile(path.join(this.dir, f), 'utf8'))); } catch { continue; }
        }
        out.push({ id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, events: m.events ?? 0,
          ...(m.platforms !== undefined ? { platforms: m.platforms } : {}), ...(m.viewerMetrics !== undefined ? { viewerMetrics: m.viewerMetrics } : {}),
          ...(m.chatMetrics !== undefined ? { chatMetrics: m.chatMetrics } : {}),
          ...(this.pendingArchive?.data.id === m.id ? { pending: true } : {}) });
      }
    } catch { /* un fallo de lectura no oculta el pendiente propio */ }
    const entry = this.pendingArchive;
    if (entry && !out.some(r => r.id === entry.data.id)) {
      out.unshift({ ...this._metaOf(entry.data), pending: true });
    }
    return out.slice(0, limit);
  }
  async get(id) {
    if (id && this.pendingArchive?.data.id === id) return this.getPending();
    if (!id || id === this.data.id) return this.data;
    const safe = String(id).replace(/[^\w-]/g, '');
    try { return JSON.parse(await readFile(path.join(this.dir, safe + '.json'), 'utf8')); }
    catch (err) {
      const e = new Error('No se pudo leer el directo archivado.');
      e.code = 'SESSION_ARCHIVE_READ_FAILED';
      e.status = err?.code === 'ENOENT' ? 404 : 500;
      e.cause = err;
      throw e;
    }
  }

  totals(data = this.data) {
    const t = {};
    for (const k of Object.keys(METRICS)) t[k] = data.events.reduce((s, ev) => s + valueFor(k, ev), 0);
    t.superchats = Math.round(t.superchats * 100) / 100;
    return t;
  }
  latest(data = this.data) {
    const last = types => [...data.events].reverse().find(e => types.includes(e.type)) || null;
    return {
      follow: last(['follow', 'ytsub']), sub: last(['sub', 'resub', 'giftsub']), cheer: last(['cheer']), raid: last(['raid']),
      superchat: last(['superchat', 'supersticker']), member: last(['member', 'milestone', 'giftmember']), any: [...data.events].reverse().find(e => !isSystemType(e.type)) || null,
    };
  }
  goalValue(metric, platform) {
    // Barras con total del canal (#132): el valor lo da src/channel-totals.mjs (total de la
    // plataforma + corrección persistente); los goalOffsets de sesión ya no se aplican a ellas.
    if (platform && this.channelTotals && isTotalMetric(metric, platform)) return this.channelTotals.value(`${metric}@${platform}`);
    if (!platform) return (this.totals()[metric] || 0) + (Number(this.data.goalOffsets?.[metric]) || 0);
    // Barra por plataforma (#128): los eventos se filtran por la plataforma declarada de su
    // tipo (src/alerts.mjs). events SOLO lee claves «events@<p>» (nunca la legacy, que quedó
    // inerte); el resto de métricas acepta la clave legacy como fallback de solo lectura.
    const base = platformValue(metric, platform, this.data.events);
    const off = this.data.goalOffsets || {};
    const key = `${metric}@${platform}`;
    const ajuste = off[key] !== undefined ? Number(off[key]) : (metric === 'events' ? 0 : (Number(off[metric]) || 0));
    return base + ajuste;
  }
  addToGoal(metric, delta, platform) {
    if (platform && this.channelTotals && isTotalMetric(metric, platform)) { this.channelTotals.adjust(`${metric}@${platform}`, delta); this.emit('change', { goal: true }); return; }
    const key = platform ? `${metric}@${platform}` : metric;
    const base = platform ? platformValue(metric, platform, this.data.events) : (this.totals()[metric] || 0);
    const effectiveOffset = this.goalValue(metric, platform) - base;
    this.data.goalOffsets[key] = effectiveOffset + Number(delta || 0);
    this.save(); this.emit('change', { goal: true });
  }
  setGoalValue(metric, value, platform) {
    if (platform && this.channelTotals && isTotalMetric(metric, platform)) { this.channelTotals.set(`${metric}@${platform}`, value); this.emit('change', { goal: true }); return; }
    const key = platform ? `${metric}@${platform}` : metric;
    const actual = platform ? platformValue(metric, platform, this.data.events) : (this.totals()[metric] || 0);
    this.data.goalOffsets[key] = Number(value || 0) - actual;
    this.save(); this.emit('change', { goal: true });
  }

  /** Nombres agrupados para los créditos. */
  credits(data = this.data) {
    return CREDIT_GROUPS.map(([title, types]) => ({
      title,
      names: [...new Set(data.events.filter(e => types.includes(e.type)).map(e => e.user).filter(Boolean))],
    })).filter(g => g.names.length);
  }

  summaryMarkdown(data = this.data) {
    const t0 = new Date(data.startedAt).getTime();
    const mmss = at => { const s = Math.max(0, Math.round((new Date(at) - t0) / 1000)); const h = Math.floor(s / 3600); const m = Math.floor(s % 3600 / 60); return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
    const t = this.totals(data);
    const day = summaryStamp(data.startedAt);
    const lines = [`# Resumen del directo${data.title ? ' · ' + data.title : ''}`, '', `${day}${data.endedAt ? ' · duración ' + mmss(data.endedAt) : ''}`, '', '## Totales', ''];
    for (const [k, m] of Object.entries(METRICS)) if (k !== 'events' && t[k]) lines.push(`- ${m.label}: ${t[k]}`);
    if (!data.events.length) lines.push('- Sin eventos todavía.');
    const credits = this.credits(data);
    if (credits.length) { lines.push('', '## Gracias a', ''); for (const g of credits) lines.push(`- **${g.title}:** ${g.names.join(', ')}`); }
    const markers = (data.notes || []).filter(n => n.kind === 'marker');
    if (markers.length) { lines.push('', '## Marcas para shorts', ''); for (const n of markers) lines.push(`- \`${mmss(n.at)}\` ${n.label || 'Sin nombre'}`); }
    lines.push('', '## Cronología', '');
    for (const e of this.timeline(data)) {
      if (e.kind === 'event') { const ev = data.events.find(x => x.id === e.id); lines.push(`- \`${mmss(e.at)}\` ${ALERT_TYPES[e.type]?.label || e.type}: **${e.user || ''}**${e.sub ? ' · ' + e.sub : ''}${ev?.variation ? ` _(variación: ${ev.variation})_` : ''}`); }
      else lines.push(`- \`${mmss(e.at)}\` ${NOTE_LABELS[e.kind]}${e.user ? ': **' + e.user + '**' : ''}${e.label ? ' · ' + e.label : ''}${e.text ? ' — «' + e.text + '»' : ''}`);
    }
    return lines.join('\n') + '\n';
  }
}
