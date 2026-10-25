// Teleprompter: guiones por bloques que avanzan solos a X palabras por minuto.
// Solo lo ves tú (monitor junto a la cámara o escena de Meld que no se emite): /widget/teleprompter.
//
// El servidor es la fuente de verdad del avance para que la ventana, el panel, el Stream Deck
// y el MCP vayan a la vez. No se emite un tick por frame: se manda un «ancla» y cada pantalla
// calcula la posición con su reloj (corrigiendo el desfase con serverNow):
//     palabra = anchorWord + max(0, ahora − anchorAt) / 60000 × wpm
// anchorAt puede estar en el futuro: es la cuenta atrás al empezar.
// Lo que va entre [corchetes] son notas: se ven en amarillo, no se leen y no gastan tiempo.
// Con «Pausar en los [corchetes]» el avance se para justo antes de cada nota.
import { EventEmitter } from 'node:events';

export const DEFAULT_TELEPROMPTER = {
  activeId: 'ejemplo',
  wpm: 140,
  size: 30,
  mirror: false,
  line: true,
  pauseAtNotes: false,
  countdownSec: 3,
  scripts: [{
    id: 'ejemplo', title: 'Guion de ejemplo',
    blocks: [
      { id: 'b1', title: 'Saludo', text: '¡Muy buenas a todos y bienvenidos al directo! Hoy seguimos construyendo criterio.\n[Saluda al chat por su nombre]' },
      { id: 'b2', title: 'Tema del día', text: 'Lo que vamos a ver hoy es cómo organizar el proyecto para que crezca sin dolor.\n\nEmpezamos por la estructura de carpetas y luego pasamos a los tests.\n[PAUSA · enseñar el repositorio en pantalla]' },
      { id: 'b3', title: 'Cierre', text: 'Y hasta aquí el directo de hoy. Nos vemos el miércoles que viene a las siete. ¡Os esperamos!' },
    ],
  }],
};

export const TP_LIMITS = { wpm: [60, 300], size: [14, 72], countdownSec: [0, 10] };
// Tope de tamaño total de los guiones, en bytes de JSON. Declarado también en el esquema de
// configuración (src/config-schema.mjs) y por debajo del límite de cuerpo de 2e6 de readBody
// (src/server.mjs): así un PUT de guiones nunca llega a truncarse por el cuerpo.
export const TELEPROMPTER_SCRIPTS_MAX_BYTES = 1_000_000;
const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const httpErr = (status, message) => Object.assign(new Error(message), { status });

/**
 * Trocea el texto de un bloque. Tokens:
 *   { w: 'palabra', i: n }   palabra que se lee (i = índice global)
 *   { note: 'texto', at: n } nota entre corchetes (at = índice de la palabra que la sigue)
 *   { br: 1 } salto de línea · { br: 2 } párrafo nuevo
 */
export function tokenize(text = '', start = 0) {
  const out = [];
  let i = start;
  const src = String(text).replace(/\r\n?/g, '\n');
  const re = /\[([^\]]*)\]|(\n\s*\n)|(\n)|([^\s[]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) { const t = m[1].trim(); if (t) out.push({ note: t, at: i }); }
    else if (m[2]) out.push({ br: 2 });
    else if (m[3]) out.push({ br: 1 });
    else out.push({ w: m[4], i: i++ });
  }
  return { tokens: out, end: i };
}

/** Guion listo para pintar: bloques troceados con su índice de inicio y total de palabras. */
export function compile(script) {
  let at = 0;
  const blocks = (script?.blocks || []).map(b => {
    const { tokens, end } = tokenize(b.text, at);
    const block = { id: b.id, title: b.title || '', text: b.text ?? '', start: at, words: end - at, tokens };
    at = end;
    return block;
  });
  const notes = blocks.flatMap(b => b.tokens.filter(t => t.note).map(t => t.at));
  return { id: script?.id || null, title: script?.title || '', blocks, total: at, notes };
}

function cleanScript(s = {}, prev = {}) {
  const blocks = Array.isArray(s.blocks) ? s.blocks : prev.blocks || [];
  return {
    id: prev.id || String(s.id || uid('g')).slice(0, 40),
    title: String(s.title ?? prev.title ?? 'Guion sin título').slice(0, 120) || 'Guion sin título',
    blocks: blocks.slice(0, 100).map((b, i) => ({
      id: String(b?.id || uid('b')).slice(0, 40),
      title: String(b?.title ?? `Bloque ${i + 1}`).slice(0, 120),
      text: String(b?.text ?? '').slice(0, 20000),
    })),
  };
}

export class Teleprompter extends EventEmitter {
  constructor({ store, log = () => {}, now = Date.now } = {}) {
    super();
    this.store = store; this.log = log; this.now = now;
    this.play = { playing: false, anchorWord: 0, anchorAt: 0 };
    this.timer = null;
    this.compiled = null;
    this.revision = 0;   // sube al cambiar guiones o el activo: invalida el guion compilado sin comparar JSON
  }

  get cfg() {
    const c = this.store.config.teleprompter || {};
    return { ...DEFAULT_TELEPROMPTER, ...c, scripts: Array.isArray(c.scripts) ? c.scripts : DEFAULT_TELEPROMPTER.scripts };
  }
  #ensure() {
    const c = this.store.config;
    c.teleprompter = { ...DEFAULT_TELEPROMPTER, ...(c.teleprompter || {}) };
    if (!Array.isArray(c.teleprompter.scripts)) c.teleprompter.scripts = structuredClone(DEFAULT_TELEPROMPTER.scripts);
    return c.teleprompter;
  }
  #save() {
    this.compiled = null;
    return Promise.resolve().then(() => this.store.save('teleprompter')).catch(err => this.log('[teleprompter] no se pudo guardar:', err?.message || err));
  }

  #checkSize(scripts) {
    if (JSON.stringify(scripts).length > TELEPROMPTER_SCRIPTS_MAX_BYTES) {
      throw httpErr(400, `Los guiones ocupan demasiado: el tope total es ${TELEPROMPTER_SCRIPTS_MAX_BYTES} bytes`);
    }
  }

  active() {
    const c = this.cfg;
    return c.scripts.find(s => s.id === c.activeId) || c.scripts[0] || null;
  }
  script() {
    const a = this.active();
    if (!this.compiled || this.compiled.rev !== this.revision) this.compiled = { rev: this.revision, value: compile(a) };
    return this.compiled.value;
  }

  /** Palabra actual (con decimales). */
  position(now = this.now()) {
    const p = this.play;
    if (!p.playing) return p.anchorWord;
    const pos = p.anchorWord + Math.max(0, now - p.anchorAt) / 60000 * this.cfg.wpm;
    return Math.min(pos, this.script().total);
  }
  blockIndex(pos = this.position()) {
    const blocks = this.script().blocks;
    let k = 0;
    for (let i = 0; i < blocks.length; i++) if (blocks[i].start <= pos + 1e-6) k = i;
    return k;
  }

  // ---------- control ----------
  #anchor(word, playing, delayMs = 0) {
    const total = this.script().total;
    this.play = { playing: !!playing && total > 0, anchorWord: Math.max(0, Math.min(total, word)), anchorAt: this.now() + delayMs };
    this.#schedule();
    this.#changed();
  }
  #schedule() {
    clearTimeout(this.timer); this.timer = null;
    const p = this.play;
    if (!p.playing) return;
    const sc = this.script();
    const from = this.position();
    // siguiente parada: el final, o la próxima nota si «Pausar en los [corchetes]»
    let stop = sc.total;
    if (this.cfg.pauseAtNotes) { const n = sc.notes.find(at => at > from + 1e-6 && at < sc.total); if (n !== undefined) stop = n; }
    const startAt = Math.max(this.now(), p.anchorAt);
    const ms = Math.max(0, startAt - this.now()) + (stop - from) / this.cfg.wpm * 60000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.play = { playing: false, anchorWord: stop, anchorAt: this.now() };
      this.#changed();
    }, Math.max(0, Math.ceil(ms)));
    this.timer.unref?.();
  }
  #changed() { this.emit('change', this.snapshot()); }

  control(action, arg) {
    const pos = this.position();
    const sc = this.script();
    const c = this.cfg;
    switch (action) {
      case 'play': {
        if (this.play.playing) return this.snapshot();
        const at = pos >= sc.total ? 0 : pos;   // terminado: vuelve a empezar
        this.#anchor(at, true, (Number(c.countdownSec) || 0) * 1000);
        break;
      }
      case 'pause': this.#anchor(pos, false); break;
      case 'toggle': return this.control(this.play.playing ? 'pause' : 'play');
      case 'reset': this.#anchor(0, false); break;
      case 'next': {
        const b = sc.blocks[this.blockIndex(pos) + 1];
        this.#anchor(b ? b.start : sc.total, this.play.playing); break;
      }
      case 'prev': {
        const i = this.blockIndex(pos);
        const cur = sc.blocks[i];
        // a mitad de bloque, primero vuelve a su principio
        const target = cur && pos - cur.start > 2 ? cur.start : (sc.blocks[i - 1]?.start ?? 0);
        this.#anchor(target, this.play.playing); break;
      }
      case 'block': {
        const b = sc.blocks.find(x => x.id === arg) || sc.blocks[Number(arg)];
        if (!b) throw httpErr(404, `No existe el bloque «${arg}»`);
        this.#anchor(b.start, this.play.playing); break;
      }
      case 'seek': this.#anchor(Number(arg) || 0, this.play.playing); break;
      case 'faster': case 'slower': {
        const step = action === 'faster' ? 10 : -10;
        this.settings({ wpm: c.wpm + step });
        break;
      }
      default: throw httpErr(400, `Acción desconocida: ${action}. Acciones: play, pause, toggle, reset, next, prev, block, seek, faster, slower`);
    }
    return this.snapshot();
  }

  // ---------- ajustes y guiones ----------
  settings(patch = {}) {
    const pos = this.position();
    const t = this.#ensure();
    const num = (k) => { if (patch[k] !== undefined) { const v = Number(patch[k]); if (!Number.isFinite(v)) throw httpErr(400, `${k} tiene que ser un número`); t[k] = Math.round(clamp(v, TP_LIMITS[k])); } };
    num('wpm'); num('size'); num('countdownSec');
    for (const k of ['mirror', 'line', 'pauseAtNotes']) if (patch[k] !== undefined) t[k] = !!patch[k];
    if (patch.monitor !== undefined) t.monitor = String(patch.monitor || '').slice(0, 200);   // app de escritorio: pantalla donde abrirlo
    this.#save();
    // re-ancla para que el cambio de velocidad no salte de sitio
    if (this.play.playing) this.play = { ...this.play, anchorWord: pos, anchorAt: Math.max(this.now(), this.play.anchorAt) };
    this.#schedule();
    this.#changed();
    return this.snapshot();
  }

  select(id) {
    const t = this.#ensure();
    if (!t.scripts.some(s => s.id === id)) throw httpErr(404, `No existe el guion «${id}»`);
    t.activeId = id;
    this.revision++;
    this.#save();
    this.#anchor(0, false);
    return this.snapshot();
  }

  createScript(data = {}) {
    const t = this.#ensure();
    if (t.scripts.length >= 50) throw httpErr(400, 'Como mucho 50 guiones');
    const s = cleanScript({ title: 'Nuevo guion', blocks: [{ title: 'Bloque 1', text: '' }], ...data, id: undefined });
    this.#checkSize(t.scripts.concat(s));   // valida sobre una copia: si truena, la configuración queda intacta
    t.scripts.push(s);
    if (data.select !== false) t.activeId = s.id;
    this.revision++;
    this.#save();
    this.#anchor(0, false);
    return { script: s, ...this.snapshot() };
  }

  /** Un guion con sus bloques, para editarlo sin tener que activarlo. */
  getScript(id) {
    const s = this.cfg.scripts.find(x => x.id === id);
    if (!s) throw httpErr(404, `No existe el guion «${id}»`);
    return { id: s.id, title: s.title, blocks: (s.blocks || []).map(b => ({ id: b.id, title: b.title, text: b.text })) };
  }

  updateScript(id, data = {}) {
    const t = this.#ensure();
    const i = t.scripts.findIndex(s => s.id === id);
    if (i < 0) throw httpErr(404, `No existe el guion «${id}»`);
    const pos = this.position();
    const siguiente = t.scripts.slice(); siguiente[i] = cleanScript(data, t.scripts[i]);
    this.#checkSize(siguiente);
    t.scripts[i] = siguiente[i];
    this.revision++;
    this.#save();
    if (t.activeId === id) this.#anchor(Math.min(pos, this.script().total), this.play.playing);
    else this.#changed();
    return this.snapshot();
  }

  deleteScript(id) {
    const t = this.#ensure();
    const i = t.scripts.findIndex(s => s.id === id);
    if (i < 0) throw httpErr(404, `No existe el guion «${id}»`);
    t.scripts.splice(i, 1);
    this.revision++;
    if (t.activeId === id) { t.activeId = t.scripts[0]?.id || null; this.#save(); this.#anchor(0, false); }
    else { this.#save(); this.#changed(); }
    return this.snapshot();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  snapshot() {
    const c = this.cfg;
    const sc = this.script();
    const pos = this.position();
    return {
      settings: { wpm: c.wpm, size: c.size, mirror: !!c.mirror, line: c.line !== false, pauseAtNotes: !!c.pauseAtNotes, countdownSec: c.countdownSec, monitor: c.monitor || '' },
      activeId: sc.id,
      scripts: c.scripts.map(s => ({ id: s.id, title: s.title })),
      script: sc,
      playback: { playing: this.play.playing, anchorWord: this.play.anchorWord, anchorAt: this.play.anchorAt, position: pos, block: this.blockIndex(pos), serverNow: this.now() },
    };
  }
}
