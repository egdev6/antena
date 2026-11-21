// Interview pack (#276): versioned format, strict validation and storage of interviews.
// Contract between whoever prepares the interview (by hand or Criterio) and antena. Format
// documented in docs/entrevista-formato.md; this file is its single source of truth.
//
// The pack content is UNTRUSTED DATA: it is validated here, stored as plain strings and must be
// escaped by whoever renders it (widget, #277). Nothing in it is ever interpreted or executed.
//
// Storage: config.interviews = { version, activeId, activeItemId, items: [interview] }, saved with
// store.save('interviews') like the teleprompter scripts. Every write validates the WHOLE result
// before touching memory, so a rejected change leaves what was stored untouched.
import { mediaKind } from './alerts.mjs';
import { httpError } from './http-util.mjs';

export const INTERVIEW_VERSION = 1;
export const INTERVIEW_ID = /^[a-z0-9-]{1,40}$/;
export const INTERVIEW_LIMITS = {
  interviews: 50,           // stored interviews
  rounds: 20,               // per interview
  items: 50,                // per round
  title: 120, name: 120, bio: 2000,
  question: 500, notes: 2000, postText: 2000, postLines: 20, author: 120,
  url: 2048, file: 200,
  maxStartMinute: 1439,
  interviewBytes: 250_000,  // one interview, as JSON
  totalBytes: 1_000_000,    // all of them, as JSON (below the 2e6 request body limit of readBody)
};
export const INTERVIEWS_MAX_BYTES = INTERVIEW_LIMITS.totalBytes;
export const INTERVIEWS_MAX_ITEMS = INTERVIEW_LIMITS.interviews;

export const DEFAULT_INTERVIEWS = { version: INTERVIEW_VERSION, activeId: '', activeItemId: '', items: [] };

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);
const MEDIA_TYPES = ['image', 'video', 'youtube', 'post'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class PackError extends Error {}
const fail = (path, message) => { throw new PackError(`${path}: ${message}`); };

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(obj, allowed, path) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${path}.${k}`, `clave desconocida (admitidas: ${allowed.join(', ')})`);
}
function object(v, path) {
  if (!isObject(v)) fail(path, 'tiene que ser un objeto');
  return v;
}
function text(v, path, max, { required = true } = {}) {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') fail(path, 'tiene que ser un texto');
  if (CONTROL.test(v)) fail(path, 'contiene caracteres de control');
  if (required && !v.trim()) fail(path, 'no puede estar vacío');
  if (v.length > max) fail(path, `como mucho ${max} caracteres (tiene ${v.length})`);
  return v;
}
function httpsUrl(v, path, { hosts } = {}) {
  text(v, path, INTERVIEW_LIMITS.url);
  let u;
  try { u = new URL(v); } catch { fail(path, 'no es una URL válida'); }
  if (u.protocol !== 'https:') fail(path, 'la URL tiene que ser https');
  if (u.username || u.password) fail(path, 'la URL no puede llevar usuario ni contraseña');
  if (hosts && !hosts.has(u.hostname.toLowerCase())) fail(path, 'tiene que ser un enlace de YouTube (youtube.com, youtu.be)');
  return v;
}
function date(v, path) {
  text(v, path, 40);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(v);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]
    || (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59))) {
    fail(path, 'fecha no válida: usa AAAA-MM-DD o AAAA-MM-DDThh:mm:ssZ');
  }
  return v;
}
function id(v, path) {
  if (typeof v !== 'string' || !INTERVIEW_ID.test(v)) fail(path, 'id no válido: minúsculas, números y guiones, hasta 40 caracteres');
  return v;
}
/** File name inside media/: no folders, no absolute path, no «..», no drive letters. */
function mediaFile(v, path, kind) {
  text(v, path, INTERVIEW_LIMITS.file);
  if (/[\\/:]/.test(v) || v === '.' || v === '..' || v.startsWith('.') || v.includes('..') || v !== v.trim()) {
    fail(path, 'tiene que ser el nombre de un archivo de media/, sin carpetas ni rutas');
  }
  if (mediaKind(v) !== kind) fail(path, `tiene que ser un archivo de tipo ${kind} (por su extensión)`);
  return v;
}

function cleanMedia(m, path) {
  object(m, path);
  if (!MEDIA_TYPES.includes(m.type)) fail(`${path}.type`, `tipo de media no válido (admitidos: ${MEDIA_TYPES.join(', ')})`);
  const out = { type: m.type };
  switch (m.type) {
    case 'image': case 'video':
      onlyKeys(m, ['type', 'file'], path);
      out.file = mediaFile(m.file, `${path}.file`, m.type);
      break;
    case 'youtube':
      onlyKeys(m, ['type', 'url', 'startMinute'], path);
      out.url = httpsUrl(m.url, `${path}.url`, { hosts: YOUTUBE_HOSTS });
      if (m.startMinute !== undefined) {
        if (!Number.isInteger(m.startMinute) || m.startMinute < 0 || m.startMinute > INTERVIEW_LIMITS.maxStartMinute) {
          fail(`${path}.startMinute`, `tiene que ser un entero de minutos entre 0 y ${INTERVIEW_LIMITS.maxStartMinute}`);
        }
        out.startMinute = m.startMinute;
      }
      break;
    case 'post':
      onlyKeys(m, ['type', 'author', 'text', 'date', 'url'], path);
      out.author = text(m.author, `${path}.author`, INTERVIEW_LIMITS.author);
      out.text = text(m.text, `${path}.text`, INTERVIEW_LIMITS.postText);
      // The widget fits up to this many lines on screen without cutting them (#277).
      // Trailing line breaks (common in pasted text) do not count as lines.
      const lines = out.text.replace(/(\r?\n)+$/, '').split('\n').length;
      if (lines > INTERVIEW_LIMITS.postLines) {
        fail(`${path}.text`, `como mucho ${INTERVIEW_LIMITS.postLines} líneas (tiene ${lines})`);
      }
      out.date = date(m.date, `${path}.date`);
      out.url = httpsUrl(m.url, `${path}.url`);
      break;
  }
  return out;
}

function cleanItem(it, path, seen, newId) {
  object(it, path);
  onlyKeys(it, ['id', 'question', 'media', 'source', 'notes', 'aprobado'], path);
  const out = { id: it.id === undefined ? newId('q') : id(it.id, `${path}.id`) };
  if (seen.has(out.id)) fail(`${path}.id`, `el id «${out.id}» está repetido en la entrevista`);
  seen.add(out.id);
  out.question = text(it.question, `${path}.question`, INTERVIEW_LIMITS.question);
  if (it.media !== undefined) out.media = cleanMedia(it.media, `${path}.media`);
  if (it.source !== undefined) {
    object(it.source, `${path}.source`);
    onlyKeys(it.source, ['url', 'date'], `${path}.source`);
    out.source = { url: httpsUrl(it.source.url, `${path}.source.url`), date: date(it.source.date, `${path}.source.date`) };
  }
  if (it.notes !== undefined) out.notes = text(it.notes, `${path}.notes`, INTERVIEW_LIMITS.notes, { required: false });
  if (typeof it.aprobado !== 'boolean') fail(`${path}.aprobado`, 'es obligatorio y tiene que ser true o false');
  out.aprobado = it.aprobado;
  return out;
}

/**
 * Validates a whole interview pack and returns its normalized copy (new object, ids filled in).
 * Throws httpError(400) with a clear Spanish message pointing at the failing field.
 * `newId(prefix)` makes ids for pieces that came without one.
 */
export function validateInterview(pack, { newId = prefix => prefix + Math.random().toString(36).slice(2, 10) } = {}) {
  try {
    object(pack, 'paquete');
    onlyKeys(pack, ['version', 'id', 'title', 'guest', 'rounds'], 'paquete');
    if (pack.version !== INTERVIEW_VERSION) fail('version', `tiene que ser ${INTERVIEW_VERSION} (versión del formato)`);
    const out = { version: INTERVIEW_VERSION, id: pack.id === undefined ? newId('e') : id(pack.id, 'id') };
    out.title = text(pack.title, 'title', INTERVIEW_LIMITS.title);
    object(pack.guest, 'guest');
    onlyKeys(pack.guest, ['name', 'bio'], 'guest');
    out.guest = { name: text(pack.guest.name, 'guest.name', INTERVIEW_LIMITS.name) };
    if (pack.guest.bio !== undefined) out.guest.bio = text(pack.guest.bio, 'guest.bio', INTERVIEW_LIMITS.bio, { required: false });
    if (!Array.isArray(pack.rounds)) fail('rounds', 'tiene que ser una lista de rondas');
    if (pack.rounds.length > INTERVIEW_LIMITS.rounds) fail('rounds', `como mucho ${INTERVIEW_LIMITS.rounds} rondas`);
    const seen = new Set(), seenRounds = new Set();
    out.rounds = pack.rounds.map((r, i) => {
      const p = `rounds[${i}]`;
      object(r, p);
      onlyKeys(r, ['id', 'title', 'items'], p);
      const round = { id: r.id === undefined ? newId('r') : id(r.id, `${p}.id`) };
      if (seenRounds.has(round.id)) fail(`${p}.id`, `el id «${round.id}» está repetido en la entrevista`);
      seenRounds.add(round.id);
      round.title = text(r.title, `${p}.title`, INTERVIEW_LIMITS.title);
      if (!Array.isArray(r.items)) fail(`${p}.items`, 'tiene que ser una lista de ítems');
      if (r.items.length > INTERVIEW_LIMITS.items) fail(`${p}.items`, `como mucho ${INTERVIEW_LIMITS.items} ítems por ronda`);
      round.items = r.items.map((it, j) => cleanItem(it, `${p}.items[${j}]`, seen, newId));
      return round;
    });
    if (JSON.stringify(out).length > INTERVIEW_LIMITS.interviewBytes) fail('paquete', `ocupa demasiado: como mucho ${INTERVIEW_LIMITS.interviewBytes} bytes`);
    return out;
  } catch (e) {
    if (e instanceof PackError) throw httpError(400, `Paquete de entrevista no válido: ${e.message}`);
    throw e;
  }
}

const approvedItem = (iv, itemId) => iv.rounds.some(r => r.items.some(x => x.id === itemId && x.aprobado));

/**
 * Defensive loader for a stored section (hand-edited or old files): drops interviews that fail
 * validateInterview or repeat an id, and clears activeId/activeItemId when they no longer point at
 * an existing interview / approved item. Returns { section, warnings } and never throws.
 */
export function sanitizeInterviews(raw) {
  const cur = isObject(raw) ? raw : {};
  const warnings = [];
  const items = [];
  const list = Array.isArray(cur.items) ? cur.items : [];
  list.forEach((it, i) => {
    try {
      const iv = validateInterview(it);
      if (items.some(x => x.id === iv.id)) throw new Error('id repetido');
      items.push(iv);
    } catch (e) {
      warnings.push(`interviews.items[${i}]: entrevista descartada (${e.message})`);
    }
  });
  let activeId = typeof cur.activeId === 'string' ? cur.activeId : '';
  let activeItemId = typeof cur.activeItemId === 'string' ? cur.activeItemId : '';
  const active = items.find(x => x.id === activeId);
  if (activeId && !active) { warnings.push('interviews.activeId: no existe la entrevista activa; se limpia'); activeId = ''; }
  if (activeItemId && !(active && approvedItem(active, activeItemId))) {
    warnings.push('interviews.activeItemId: el ítem activo no existe o no está aprobado; se limpia'); activeItemId = '';
  }
  return { section: { version: INTERVIEW_VERSION, activeId, activeItemId, items }, warnings };
}

/** Strict check of a whole section coming from outside (config import): throws httpError(400). */
export function checkInterviewsSection(raw) {
  if (!isObject(raw)) throw httpError(400, 'interviews: se esperaba un objeto');
  if (raw.version !== undefined && raw.version !== INTERVIEW_VERSION) throw httpError(400, `interviews.version: tiene que ser ${INTERVIEW_VERSION}`);
  const list = raw.items === undefined ? [] : raw.items;
  if (!Array.isArray(list)) throw httpError(400, 'interviews.items: se esperaba una lista');
  const items = [];
  for (const it of list) {
    const iv = validateInterview(it);
    if (items.some(x => x.id === iv.id)) throw httpError(400, `interviews: la entrevista «${iv.id}» está repetida`);
    items.push(iv);
  }
  const activeId = raw.activeId ?? '', activeItemId = raw.activeItemId ?? '';
  const active = items.find(x => x.id === activeId);
  if (activeId && !active) throw httpError(400, 'interviews.activeId: no existe esa entrevista');
  if (activeItemId && !(active && approvedItem(active, activeItemId))) throw httpError(400, 'interviews.activeItemId: tiene que ser un ítem aprobado de la entrevista activa');
  return { version: INTERVIEW_VERSION, activeId, activeItemId, items };
}

let uidCounter = 0;
const uid = p => p + Date.now().toString(36) + (uidCounter++).toString(36) + Math.random().toString(36).slice(2, 5);

export class Interviews {
  /** `onChange()` runs after every stored change (create, import, edit, delete, select): the server
   *  uses it to push the active item to the widgets. */
  constructor({ store, log = () => {}, onChange = () => {}, onShow = () => {} } = {}) {
    this.store = store; this.log = log; this.onChange = onChange; this.onShow = onShow;
    // Live-control state that is not part of the stored pack: media hidden for the item on screen.
    // It resets whenever the item on screen changes (see #commit) and on restart.
    this.mediaHidden = false;
  }

  /** Stored section, filled with defaults. Nothing is written until a change is saved. */
  #section() {
    const c = this.store.config;
    const cur = isObject(c.interviews) ? c.interviews : {};
    return {
      version: INTERVIEW_VERSION,
      activeId: typeof cur.activeId === 'string' ? cur.activeId : '',
      activeItemId: typeof cur.activeItemId === 'string' ? cur.activeItemId : '',
      items: Array.isArray(cur.items) ? cur.items : [],
    };
  }
  async #commit(next, { errorMessage } = {}) {
    if (next.items.length > INTERVIEW_LIMITS.interviews) throw httpError(400, `Como mucho ${INTERVIEW_LIMITS.interviews} entrevistas`);
    if (JSON.stringify(next.items).length > INTERVIEW_LIMITS.totalBytes) {
      throw httpError(400, errorMessage || `Las entrevistas ocupan demasiado: el tope total es ${INTERVIEW_LIMITS.totalBytes} bytes`);
    }
    const prev = this.#section();
    const changed = prev.activeId !== next.activeId || prev.activeItemId !== next.activeItemId;
    this.store.config.interviews = next;
    if (changed) this.mediaHidden = false;
    await this.store.save('interviews');
    try { this.onChange(); } catch (e) { this.log('[interviews] onChange', e); }
    // A newly shown question (next, previous, go-to, select with item) is reported once, with its private data.
    if (changed && next.activeItemId) {
      const shown = next.items.find(x => x.id === next.activeId)?.rounds.flatMap(r => r.items).find(x => x.id === next.activeItemId);
      if (shown) { try { this.onShow({ id: shown.id, question: shown.question, interviewId: next.activeId }); } catch (e) { this.log('[interviews] onShow', e); } }
    }
  }

  /**
   * What the widget may show: the active approved item as { id, question, media?, source? } or null.
   * Private notes and the approval flag are left out on purpose: this is the only shape that
   * leaves the server for the screen.
   */
  activeItem() {
    const s = this.#section();
    const iv = s.items.find(x => x.id === s.activeId);
    const item = iv && s.activeItemId ? iv.rounds.flatMap(r => r.items).find(x => x.id === s.activeItemId && x.aprobado) : null;
    if (!item) return null;
    const out = { id: item.id, question: item.question };
    // With the media hidden the widget gets the plain question: no media and no source line.
    if (item.media && !this.mediaHidden) out.media = structuredClone(item.media);
    if (item.source && !this.mediaHidden) out.source = { ...item.source };
    return out;
  }

  // ---------- live control (#278) ----------
  // Every action needs an active interview; otherwise it answers 409 with a clear message and
  // changes nothing. Items are walked in round order and only approved ones are ever reachable.
  #live() {
    const s = this.#section();
    const iv = s.items.find(x => x.id === s.activeId);
    if (!iv) throw httpError(409, 'No hay entrevista activa: elige una (elegir_entrevista o POST /api/interviews/select) antes de usar los controles');
    const seq = iv.rounds.flatMap(r => r.items).filter(x => x.aprobado);
    const at = seq.findIndex(x => x.id === s.activeItemId);
    // With nothing on screen (after hide), next/previous continue from the last item shown in
    // this interview; it only applies to the same active interview.
    const last = this.lastShown?.interviewId === iv.id ? seq.findIndex(x => x.id === this.lastShown.itemId) : -1;
    return { s, iv, seq, at, from: at >= 0 ? at : last };
  }
  async #show({ s, iv }, item) {
    await this.#commit({ ...s, activeItemId: item.id });
    this.lastShown = { interviewId: iv.id, itemId: item.id };
    return this.control();
  }
  /** Next approved item; with nothing on screen it continues after the last shown, or starts at the first. */
  async next() {
    const live = this.#live();
    if (!live.seq.length) throw httpError(409, 'La entrevista activa no tiene ítems aprobados');
    if (live.from >= live.seq.length - 1) throw httpError(409, 'Ya estás en el último ítem aprobado');
    return this.#show(live, live.seq[live.from + 1]);
  }
  /** Previous approved item, from the item on screen or the last one shown. */
  async previous() {
    const live = this.#live();
    if (live.from < 0) throw httpError(409, 'No hay ningún ítem en pantalla desde el que retroceder');
    if (live.from === 0) throw httpError(409, 'Ya estás en el primer ítem aprobado');
    return this.#show(live, live.seq[live.from - 1]);
  }
  /** Go to a specific approved item of the active interview. */
  async goto(itemIdRaw) {
    const live = this.#live();
    const itemId = String(itemIdRaw ?? '');
    if (!itemId) throw httpError(400, 'Falta el id del ítem al que ir');
    const item = live.iv.rounds.flatMap(r => r.items).find(x => x.id === itemId);
    if (!item) throw httpError(404, `No existe el ítem «${itemId.slice(0, 60)}» en la entrevista activa`);
    if (!item.aprobado) throw httpError(409, `El ítem «${item.id}» no está aprobado (aprobado: false): no se puede mostrar`);
    return this.#show(live, item);
  }
  /** Shows or hides the media of the item on screen (the question stays). */
  async setMedia(visible) {
    const live = this.#live();
    if (live.at < 0) throw httpError(409, 'No hay ningún ítem en pantalla');
    if (typeof visible !== 'boolean') throw httpError(400, 'visible tiene que ser true o false');
    this.mediaHidden = !visible;
    try { this.onChange(); } catch (e) { this.log('[interviews] onChange', e); }
    return this.control();
  }
  /** Hides the widget (empty state) keeping the interview active. */
  async hide() {
    const live = this.#live();
    if (live.at < 0) throw httpError(409, 'No hay ningún ítem en pantalla');
    await this.#commit({ ...live.s, activeItemId: '' });
    return this.control();
  }

  /**
   * State for whoever drives the interview (panel, dock, prompter, MCP): progress, current and next
   * item WITH their private notes. It never goes to the widget: only to the panel SSE clients and
   * authenticated API callers.
   */
  control() {
    const s = this.#section();
    const iv = s.items.find(x => x.id === s.activeId);
    if (!iv) return { active: false, interviewId: '', title: '', guest: '', progress: { index: 0, total: 0 }, mediaHidden: false, current: null, next: null, items: [] };
    const rounds = iv.rounds.flatMap(r => r.items.filter(x => x.aprobado).map(x => ({ ...x, round: r.title })));
    const at = rounds.findIndex(x => x.id === s.activeItemId);
    const view = x => (x ? { id: x.id, question: x.question, notes: x.notes || '', round: x.round, media: x.media?.type || null } : null);
    return {
      active: true, interviewId: iv.id, title: iv.title, guest: iv.guest.name,
      progress: { index: at + 1, total: rounds.length },
      mediaHidden: at >= 0 && this.mediaHidden,
      current: at >= 0 ? view(rounds[at]) : null,
      next: view(rounds[at + 1]),
      items: rounds.map(x => ({ id: x.id, question: x.question, round: x.round, media: x.media?.type || null, current: x.id === s.activeItemId })),
    };
  }

  snapshot() {
    const s = this.#section();
    return {
      activeId: s.activeId, activeItemId: s.activeItemId,
      interviews: s.items.map(iv => {
        const items = iv.rounds.flatMap(r => r.items);
        return { id: iv.id, title: iv.title, guest: iv.guest.name, rounds: iv.rounds.length, items: items.length, approved: items.filter(x => x.aprobado).length };
      }),
    };
  }

  get(idRaw) {
    const iv = this.#section().items.find(x => x.id === idRaw);
    if (!iv) throw httpError(404, `No existe la entrevista «${String(idRaw).slice(0, 60)}»`);
    return structuredClone(iv);
  }

  /** create() and import() share the strict validation; import() demands `version` in the pack. */
  async create(data) {
    const body = isObject(data) ? data : {};
    return this.#add({ version: INTERVIEW_VERSION, rounds: [], ...body });
  }
  async import(pack) {
    return this.#add(pack);
  }
  async #add(pack) {
    const s = this.#section();
    const iv = validateInterview(pack, { newId: uid });
    if (s.items.some(x => x.id === iv.id)) throw httpError(409, `Ya existe la entrevista «${iv.id}»: edítala o bórrala antes de importarla`);
    await this.#commit({ ...s, items: [...s.items, iv] });
    return { interview: structuredClone(iv) };
  }

  /** Replaces only the top-level fields sent (title, guest, rounds), validating the whole result. */
  async update(idRaw, patch) {
    const s = this.#section();
    const i = s.items.findIndex(x => x.id === idRaw);
    if (i < 0) throw httpError(404, `No existe la entrevista «${String(idRaw).slice(0, 60)}»`);
    const body = isObject(patch) ? patch : {};
    if (body.id !== undefined && body.id !== idRaw) throw httpError(400, 'Paquete de entrevista no válido: id: no se puede cambiar el id de una entrevista');
    const iv = validateInterview({ ...structuredClone(s.items[i]), ...body, id: idRaw }, { newId: uid });
    const items = s.items.slice(); items[i] = iv;
    const next = { ...s, items };
    if (s.activeId === iv.id && s.activeItemId && !iv.rounds.some(r => r.items.some(x => x.id === s.activeItemId && x.aprobado))) next.activeItemId = '';
    await this.#commit(next);
    return { interview: structuredClone(iv) };
  }

  async remove(idRaw) {
    const s = this.#section();
    if (!s.items.some(x => x.id === idRaw)) throw httpError(404, `No existe la entrevista «${String(idRaw).slice(0, 60)}»`);
    const next = { ...s, items: s.items.filter(x => x.id !== idRaw) };
    if (s.activeId === idRaw) { next.activeId = ''; next.activeItemId = ''; }
    await this.#commit(next);
    return this.snapshot();
  }

  /** Stops the live interview without removing its stored data. */
  async stop() {
    const s = this.#section();
    if (s.activeId || s.activeItemId) await this.#commit({ ...s, activeId: '', activeItemId: '' });
    this.lastShown = null;
    return this.snapshot();
  }

  /** Makes an interview the active one; with itemId, also points at one item, which has to be approved. */
  async select(idRaw, itemIdRaw) {
    const s = this.#section();
    const iv = s.items.find(x => x.id === idRaw);
    if (!iv) throw httpError(404, `No existe la entrevista «${String(idRaw).slice(0, 60)}»`);
    let activeItemId = '';
    if (itemIdRaw !== undefined && itemIdRaw !== null && itemIdRaw !== '') {
      const item = iv.rounds.flatMap(r => r.items).find(x => x.id === itemIdRaw);
      if (!item) throw httpError(404, `No existe el ítem «${String(itemIdRaw).slice(0, 60)}» en la entrevista`);
      if (!item.aprobado) throw httpError(409, `El ítem «${item.id}» no está aprobado (aprobado: false): no se puede activar ni mostrar`);
      activeItemId = item.id;
    }
    await this.#commit({ ...s, activeId: iv.id, activeItemId });
    // Choosing an interview starts it over: next/previous no longer resume from an earlier pass.
    this.lastShown = activeItemId ? { interviewId: iv.id, itemId: activeItemId } : null;
    return this.snapshot();
  }
}
