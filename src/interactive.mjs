// Interactivos del directo: cola de preguntas, tier list con votación del chat y sorteos.
// El estado vivo (preguntas, votos, participantes) se guarda en data/interactive.json;
// la configuración (comandos, textos, estilos) va en config.json como el resto.
import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { writeJson } from './json-file.mjs';
import { canUse, normalizeTrigger } from './commands.mjs';
import { render } from './alerts.mjs';

const id8 = () => randomUUID().slice(0, 8);
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
const err = (status, message) => Object.assign(new Error(message), { status });
// Etiqueta segura: el error público nunca expone ruta, errno ni valores; el crudo queda en `cause`.
const INTERACTIVE_SAVE_MESSAGE = 'No se pudieron guardar los interactivos.';
function interactivePersistenceError(err) {
  const e = new Error(INTERACTIVE_SAVE_MESSAGE);
  e.code = 'INTERACTIVE_PERSISTENCE_FAILED';
  e.status = 500;
  e.cause = err;
  return e;
}

export const DEFAULT_INTERACTIVE_CONFIG = {
  questions: {
    enabled: true, command: '!pregunta', permission: 'everyone',
    maxPerUser: 3, minLength: 8, maxLength: 220,
    confirmInChat: false, confirmText: '@{user} tu pregunta está en la cola ({position})',
    showUser: true, css: '',
  },
  tierlist: {
    acceptBare: true,      // con una votación abierta vale escribir solo «S» o «A»
    command: '!tier',      // y también «!tier S»
    voteSeconds: 0,        // 0 = la cierras tú; si no, se cierra sola
    css: '',
  },
  giveaway: {
    command: '!sorteo', title: 'Sorteo', prize: '', permission: 'everyone',
    memberLuck: 1,         // los subs y miembros cuentan x veces (1 = igual que el resto)
    excludeWinners: true,  // quien ya ha ganado no vuelve a salir en este sorteo
    announceInChat: true,
    openText: '🎁 ¡Sorteo abierto! {prize} · Escribe {command} para entrar',
    closeText: 'Sorteo cerrado con {count} participantes. ¡Mucha suerte!',
    winnerText: '🎉 ¡Enhorabuena @{winner}! Te llevas {prize}',
    meldConfetti: true, rollSeconds: 5, css: '',
  },
};

export const DEFAULT_TIERS = [
  { id: 's', label: 'S', color: '#FF0036' },
  { id: 'a', label: 'A', color: '#FF6A3D' },
  { id: 'b', label: 'B', color: '#FFB547' },
  { id: 'c', label: 'C', color: '#5ED17A' },
  { id: 'd', label: 'D', color: '#4AA8FF' },
];

function freshState() {
  return {
    questions: [],          // { id, user, platform, text, at, status: pending|shown|answered|discarded }
    currentQuestion: null,  // id de la que está en pantalla
    tierlists: [],          // { id, title, tiers, items:[{id,label,image}], placements:{itemId:tierId} }
    shownTierlist: null,    // id de la que se ve en el widget
    vote: null,             // { listId, itemId, votes:{user:tierId}, openedAt, endsAt }
    giveaway: { open: false, entries: [], winners: [], rolling: null, openedAt: null },
    giveawayHistory: [],
  };
}

export class Interactive extends EventEmitter {
  constructor({ store, twitch, meld, log = console.log, writer = writeJson, report = log, debounceMs = 300, maxWaitMs = 2000 }) {
    super();
    Object.assign(this, { store, twitch, meld, log, writer, report, debounceMs, maxWaitMs });
    this.file = path.join(store.dir, 'interactive.json');
    this.s = freshState();
    this.saveT = null;                 // debounce: cada cambio reinicia la cuenta (timer referenciado)
    this.maxT = null;                  // techo por primer cambio sucio: no se reinicia
    this.chain = Promise.resolve();    // cola por instancia; se recupera para el siguiente trabajo
    this.lastSaveError = null;
    this.voteTimer = null;
    this.voteTimerSealed = false;
    this.voteEpoch = 0;
    this.drawWork = new Set();
    this.chatWork = new Set();        // raíces propias de confirmaciones y envíos, separadas de drawWork
  }

  get cfg() { return this.store.config.interactive; }

  async load() {
    this.#clearVoteTimer();
    const epoch = this.voteEpoch;
    let saved;
    try { saved = { ...freshState(), ...JSON.parse(await readFile(this.file, 'utf8')) }; } catch {}
    if (epoch !== this.voteEpoch) return this;  // lectura supersedida o sellada durante IO
    if (saved) this.s = saved;
    this.s.giveaway = { ...freshState().giveaway, ...this.s.giveaway, rolling: null };
    const endsAt = this.s.vote?.endsAt;
    const end = endsAt ? Date.parse(endsAt) : NaN;
    if (!this.voteTimerSealed && Number.isFinite(end)) {
      if (end <= Date.now()) { try { this.closeVote(); } catch { /* igual que auto-cierre ordinario */ } }
      else this.#armVoteTimer(endsAt);
    }
    return this;
  }
  #clearVoteTimer() {
    this.voteEpoch++;
    clearTimeout(this.voteTimer);
    this.voteTimer = null;
  }
  // Sello solo del timer: las continuaciones manuales ya admitidas conservan sus votos.
  quiesceVoteTimer() {
    this.voteTimerSealed = true;
    this.#clearVoteTimer();
  }
  #armVoteTimer(endsAt) {
    if (this.voteTimerSealed) return;
    const end = Date.parse(endsAt);
    if (!Number.isFinite(end)) return;
    const epoch = this.voteEpoch, vote = this.s.vote;
    // Node trunca retrasos mayores de 2^31-1; rearmar por tramos conserva la fecha original.
    const ms = Math.min(2147483647, Math.max(0, end - Date.now()));
    this.voteTimer = setTimeout(() => {
      if (this.voteTimerSealed || epoch !== this.voteEpoch || this.s.vote !== vote) return;
      this.voteTimer = null;
      if (Date.now() < end) this.#armVoteTimer(endsAt);
      else { try { this.closeVote(); } catch {} }
    }, ms);
    this.voteTimer.unref?.();
  }
  // Programa el guardado: `debounceMs` de reposo o, como techo, `maxWaitMs` desde el primer
  // cambio sucio. Timers referenciados: un proceso que solo cambia estado no termina antes de
  // intentar la escritura.
  save() {
    const run = () => { this.flush().catch(() => {}); };   // el fallo ya lo reporta flush; aquí no se duplica
    if (this.saveT) clearTimeout(this.saveT);
    this.saveT = setTimeout(run, this.debounceMs);
    if (!this.maxT) this.maxT = setTimeout(run, this.maxWaitMs);
  }
  // Escribe SIEMPRE el estado actual, aunque nadie haya llamado a save(). La instantánea la toma
  // el writer de forma síncrona al aceptar la llamada (helper de json-file) y espera la cola de la
  // instancia; el rechazo del productor se mapea al error tipado sin envenenar la cola.
  flush() {
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; }
    if (this.maxT) { clearTimeout(this.maxT); this.maxT = null; }
    const prior = this.chain;
    prior.catch(() => {});               // la puerta nunca propaga un rechazo ya consumido
    let run;
    try { run = this.writer(this.file, this.s, { after: prior }); }
    catch (err) { run = Promise.reject(err); }   // un writer síncrono que lanza no deja promesa huérfana
    const next = Promise.resolve(run).then(
      () => { this.lastSaveError = null; },
      err => {
        const e = interactivePersistenceError(err);
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
  changed(part) { this.save(); this.emit('change', part); }

  // ================================================================
  // Chat: comandos y votos
  // ================================================================
  /** Devuelve true si el mensaje lo ha «consumido» un interactivo. */
  onChat(msg) {
    const text = String(msg.text || '').trim();
    if (!text) return false;
    const [word, ...rest] = text.split(/\s+/);
    const w = word.toLowerCase();
    const q = this.cfg.questions, t = this.cfg.tierlist, g = this.cfg.giveaway;

    if (q.enabled && w === normalizeTrigger(q.command) && canUse(q.permission, msg)) {
      try { this.addQuestion({ user: msg.user, platform: msg.platform, text: rest.join(' ') }); } catch {}
      return true;
    }
    if (this.s.vote) {
      if (w === normalizeTrigger(t.command) && rest[0]) return this.castVote(msg, rest[0]);
      if (t.acceptBare && rest.length === 0 && this.tierByLabel(this.s.vote.listId, word)) return this.castVote(msg, word);
    }
    if (this.s.giveaway.open && w === normalizeTrigger(g.command) && canUse(g.permission, msg)) {
      this.join({ user: msg.user, platform: msg.platform, member: !!(msg.member || msg.mod || msg.vip) });
      return true;
    }
    return false;
  }

  // ================================================================
  // Preguntas
  // ================================================================
  addQuestion({ user = 'Anónimo', platform = 'manual', text = '' }) {
    const q = this.cfg.questions;
    const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, Number(q.maxLength) || 220);
    if (clean.length < (Number(q.minLength) || 0)) throw err(400, 'La pregunta es demasiado corta.');
    const pending = this.s.questions.filter(x => x.status === 'pending');
    if (platform !== 'manual' && pending.filter(x => norm(x.user) === norm(user)).length >= (Number(q.maxPerUser) || 99)) throw err(429, `${user} ya tiene ${q.maxPerUser} preguntas en la cola.`);
    if (pending.some(x => norm(x.text) === norm(clean))) throw err(409, 'Esa pregunta ya está en la cola.');
    const item = { id: id8(), user, platform, text: clean, at: new Date().toISOString(), status: 'pending' };
    this.s.questions.push(item);
    // La raíz se registra antes de `change`: una captura reentrante ya espera el mensaje causal.
    let confirm = q.confirmInChat && platform === 'twitch' ? this.#beginChat() : null;
    try { this.changed('questions'); }
    catch (err) { confirm?.reject(err); throw err; }
    if (q.confirmInChat && platform === 'twitch') {
      confirm ??= this.#beginChat();
      const position = this.s.questions.filter(x => x.status === 'pending').length;
      try {
        const sent = this.twitch.sendChat(render(q.confirmText, { user, position }));
        confirm.resolve(sent);   // la raíz observa el resultado real del envío
        sent.catch(() => {});    // catch normal del API, intacto
      } catch (err) { confirm.reject(err); throw err; }
    } else confirm?.resolve();
    return item;
  }
  question(id) {
    const q = this.s.questions.find(x => x.id === id);
    if (!q) throw err(404, `No existe la pregunta «${id}»`);
    return q;
  }
  showQuestion(id) {
    const q = id ? this.question(id) : this.s.questions.find(x => x.status === 'pending');
    if (!q) throw err(404, 'No hay preguntas pendientes.');
    const prev = this.s.questions.find(x => x.id === this.s.currentQuestion);
    if (prev && prev.status === 'shown') prev.status = 'answered';
    q.status = 'shown';
    this.s.currentQuestion = q.id;
    this.changed('questions');
    this.emit('questionShown', q);
    return q;
  }
  hideQuestion() {
    const q = this.s.questions.find(x => x.id === this.s.currentQuestion);
    if (q && q.status === 'shown') q.status = 'answered';
    this.s.currentQuestion = null;
    this.changed('questions');
  }
  setQuestionStatus(id, status) {
    if (!['pending', 'answered', 'discarded'].includes(status)) throw err(400, 'Estado no válido');
    const q = this.question(id);
    q.status = status;
    if (this.s.currentQuestion === id) this.s.currentQuestion = null;
    this.changed('questions');
    return q;
  }
  moveQuestion(id, dir) {
    const list = this.s.questions;
    const i = list.findIndex(x => x.id === id);
    if (i < 0) throw err(404, 'No existe la pregunta');
    // se mueve entre las pendientes
    const pend = list.map((x, k) => [x, k]).filter(([x]) => x.status === 'pending');
    const pi = pend.findIndex(([x]) => x.id === id);
    const other = pend[pi + Math.sign(dir)];
    if (!other) return list[i];
    [list[i], list[other[1]]] = [list[other[1]], list[i]];
    this.changed('questions');
    return list[other[1]];
  }
  clearQuestions({ all = false } = {}) {
    this.s.questions = all ? [] : this.s.questions.filter(x => x.status === 'pending' || x.status === 'shown');
    if (all) this.s.currentQuestion = null;
    this.changed('questions');
  }

  // ================================================================
  // Tier list
  // ================================================================
  list(id) {
    const r = norm(id);
    const l = this.s.tierlists.find(x => x.id === id) || this.s.tierlists.find(x => norm(x.title) === r);
    if (!l) throw err(404, `No existe la tier list «${id}»`);
    return l;
  }
  item(l, ref) {
    const r = norm(ref);
    const it = l.items.find(x => x.id === ref) || l.items.find(x => norm(x.label) === r);
    if (!it) throw err(404, `«${ref}» no está en la tier list`);
    return it;
  }
  tierByLabel(listId, label) {
    const l = this.s.tierlists.find(x => x.id === listId);
    const r = norm(label);
    return l?.tiers.find(t => t.id === label || norm(t.label) === r) || null;
  }
  createTierlist({ title = 'Tier list', tiers, items = [] } = {}) {
    const l = { id: id8(), title, tiers: structuredClone(tiers?.length ? tiers : DEFAULT_TIERS).map(t => ({ id: t.id || id8(), label: t.label, color: t.color || '#888888' })), items: [], placements: {} };
    this.s.tierlists.push(l);
    for (const it of items) this.addItem(l.id, typeof it === 'string' ? { label: it } : it);
    if (!this.s.shownTierlist) this.s.shownTierlist = l.id;
    this.changed('tierlist');
    return l;
  }
  updateTierlist(id, { title, tiers }) {
    const l = this.list(id);
    if (title !== undefined) l.title = String(title);
    if (Array.isArray(tiers)) {
      l.tiers = tiers.map(t => ({ id: t.id || id8(), label: String(t.label ?? '?'), color: t.color || '#888888' }));
      for (const [k, v] of Object.entries(l.placements)) if (!l.tiers.some(t => t.id === v)) delete l.placements[k];
    }
    this.changed('tierlist');
    return l;
  }
  deleteTierlist(id) {
    const l = this.list(id);
    this.s.tierlists = this.s.tierlists.filter(x => x !== l);
    if (this.s.shownTierlist === l.id) this.s.shownTierlist = this.s.tierlists[0]?.id || null;
    if (this.s.vote?.listId === l.id) this.cancelVote();
    this.changed('tierlist');
  }
  addItem(listId, { label, image = '' }) {
    const l = this.list(listId);
    if (!String(label || '').trim()) throw err(400, 'Falta el nombre del elemento');
    const it = { id: id8(), label: String(label).trim(), image };
    l.items.push(it);
    this.changed('tierlist');
    return it;
  }
  updateItem(listId, ref, { label, image }) {
    const l = this.list(listId); const it = this.item(l, ref);
    if (label !== undefined) it.label = String(label);
    if (image !== undefined) it.image = image;
    this.changed('tierlist');
    return it;
  }
  removeItem(listId, ref) {
    const l = this.list(listId); const it = this.item(l, ref);
    l.items = l.items.filter(x => x !== it);
    delete l.placements[it.id];
    if (this.s.vote?.itemId === it.id) this.cancelVote();
    this.changed('tierlist');
  }
  place(listId, ref, tierRef) {
    const l = this.list(listId); const it = this.item(l, ref);
    if (tierRef === null || tierRef === '' || tierRef === undefined) delete l.placements[it.id];
    else {
      const t = this.tierByLabel(l.id, tierRef);
      if (!t) throw err(400, `No existe el tier «${tierRef}»`);
      l.placements[it.id] = t.id;
    }
    this.changed('tierlist');
    return { item: it.label, tier: l.placements[it.id] || null };
  }
  resetPlacements(listId) { const l = this.list(listId); l.placements = {}; this.changed('tierlist'); }
  showTierlist(id) { this.s.shownTierlist = id ? this.list(id).id : null; this.changed('tierlist'); }

  startVote(listId, ref, seconds) {
    const l = this.list(listId); const it = this.item(l, ref);
    this.#clearVoteTimer();
    const secs = Number(seconds ?? this.cfg.tierlist.voteSeconds) || 0;
    this.s.vote = { listId: l.id, itemId: it.id, votes: {}, openedAt: new Date().toISOString(), endsAt: secs ? new Date(Date.now() + secs * 1000).toISOString() : null };
    this.s.shownTierlist = l.id;
    if (secs) this.#armVoteTimer(this.s.vote.endsAt);
    this.changed('tierlist');
    return this.voteSummary();
  }
  castVote(msg, label) {
    const v = this.s.vote; if (!v) return false;
    const t = this.tierByLabel(v.listId, label);
    if (!t) return false;
    v.votes[norm(msg.login || msg.user)] = t.id;
    this.changed('vote');
    return true;
  }
  voteSummary() {
    const v = this.s.vote; if (!v) return null;
    const l = this.s.tierlists.find(x => x.id === v.listId);
    const counts = Object.fromEntries(l.tiers.map(t => [t.id, 0]));
    for (const t of Object.values(v.votes)) if (t in counts) counts[t]++;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    // gana el que más votos tiene; si empatan, el tier más alto
    let winner = null;
    for (const t of l.tiers) if (counts[t.id] > 0 && (!winner || counts[t.id] > counts[winner])) winner = t.id;
    return { listId: l.id, item: l.items.find(x => x.id === v.itemId), counts, total, winner, endsAt: v.endsAt };
  }
  closeVote({ apply = true } = {}) {
    const sum = this.voteSummary();
    if (!sum) throw err(409, 'No hay ninguna votación abierta');
    this.#clearVoteTimer();
    if (apply && sum.winner) this.s.tierlists.find(x => x.id === sum.listId).placements[sum.item.id] = sum.winner;
    this.s.vote = null;
    this.changed('tierlist');
    return sum;
  }
  cancelVote() { this.#clearVoteTimer(); this.s.vote = null; this.changed('tierlist'); }

  // ================================================================
  // Sorteo
  // ================================================================
  get giveaway() { return this.s.giveaway; }
  async openGiveaway({ reset = true } = {}) {
    const g = this.s.giveaway;
    if (reset) { g.entries = []; g.winners = []; }
    g.open = true; g.openedAt = new Date().toISOString(); g.rolling = null;
    this.changed('giveaway');
    await this.say(this.cfg.giveaway.openText);
    return this.giveawayState();
  }
  async closeGiveaway() {
    this.s.giveaway.open = false;
    this.changed('giveaway');
    await this.say(this.cfg.giveaway.closeText);
    return this.giveawayState();
  }
  join({ user, platform = 'manual', member = false }) {
    const g = this.s.giveaway;
    if (!user) throw err(400, 'Falta el nombre');
    if (g.entries.some(e => norm(e.user) === norm(user))) return false;
    g.entries.push({ user, platform, member, at: new Date().toISOString() });
    this.changed('giveaway');
    return true;
  }
  removeEntry(user) {
    const g = this.s.giveaway;
    const before = g.entries.length;
    g.entries = g.entries.filter(e => norm(e.user) !== norm(user));
    if (g.entries.length === before) throw err(404, `${user} no está en el sorteo`);
    this.changed('giveaway');
  }
  // Registra una raíz de chat antes de invocar el envío/callback: una captura reentrante desde
  // `change` ya la incluye. El rechazo de la raíz queda consumido por `done`, sin huérfanos.
  #beginChat() {
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    this.chatWork.add(promise);
    const done = () => this.chatWork.delete(promise);
    promise.then(done, done);
    return { promise, resolve, reject };
  }
  #chatTask(fn) {
    const task = this.#beginChat();
    try { task.resolve(fn()); } catch (err) { task.reject(err); throw err; }
    return task.promise;
  }
  // Snapshot no terminal de chat: espera el resultado real de las raíces pendientes al invocarlo.
  // No sella admisión ni guarda historial; vacío resuelve y un fallo previo ya terminado no envenena.
  async drainChat() {
    const results = await Promise.allSettled([...this.chatWork]);
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'No se pudieron completar los mensajes del chat.');
  }
  // Snapshot no terminal; no adelanta timers ni retiene errores ya terminados.
  async drainDraws() {
    const results = await Promise.allSettled([...this.drawWork]);
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, 'No se pudieron completar los sorteos.');
  }

  async _finishDraw(g, c, w) {
    const errors = [];
    try { await this.say(c.winnerText, { winner: w.user }, { propagate: true }); }
    catch (err) { errors.push(err); }
    try {
      if (c.meldConfetti && this.meld?.connected) await this.meld.streamEvent('CONFETTIPOP_TRIGGER');
    } catch (err) { errors.push(err); }
    try {
      this.s.giveawayHistory.unshift({ title: c.title, prize: c.prize, winner: w.user, at: w.at, entries: g.entries.length });
      this.s.giveawayHistory.length = Math.min(this.s.giveawayHistory.length, 50);
      this.changed('giveaway');
    } catch (err) { errors.push(err); }
    if (errors.length) throw new AggregateError(errors, 'No se pudo completar el sorteo.');
  }

  /** Elige ganador (ponderado si memberLuck > 1) y lanza la animación en el widget. */
  async draw() {
    const g = this.s.giveaway, c = this.cfg.giveaway;
    const pool = g.entries.filter(e => !c.excludeWinners || !g.winners.some(w => norm(w.user) === norm(e.user)));
    if (!pool.length) throw err(409, g.entries.length ? 'Ya han ganado todos los participantes.' : 'No hay participantes en el sorteo.');
    const luck = Math.max(1, Number(c.memberLuck) || 1);
    const weights = pool.map(e => (e.member ? luck : 1));
    let r = randomInt(weights.reduce((a, b) => a + b, 0));
    let winner = pool[0];
    for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r < 0) { winner = pool[i]; break; } }
    const w = { user: winner.user, platform: winner.platform, at: new Date().toISOString() };
    g.winners.push(w);
    g.rolling = { winner: w.user, startedAt: Date.now(), seconds: Math.max(1, Number(c.rollSeconds) || 5), names: pool.map(e => e.user) };
    let resolve, reject;
    const work = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    this.drawWork.add(work); // antes de change/draw: los listeners pueden iniciar un drenaje
    work.then(() => this.drawWork.delete(work), () => {
      this.drawWork.delete(work);
      try { this.log('[sorteo] No se pudo completar el sorteo.'); } catch {}
    });
    try {
      this.changed('giveaway');
      this.emit('draw', g.rolling);
      const t = setTimeout(() => this._finishDraw(g, c, w).then(resolve, reject), g.rolling.seconds * 1000);
      t.unref?.();
    } catch (err) { reject(err); throw err; }
    return { winner: w.user, entries: g.entries.length, pool: pool.length };
  }
  resetGiveaway() { this.s.giveaway = freshState().giveaway; this.changed('giveaway'); }
  giveawayState() {
    const g = this.s.giveaway;
    return { open: g.open, entries: g.entries, winners: g.winners, count: g.entries.length, history: this.s.giveawayHistory };
  }
  async say(template, extra = {}, { propagate = false } = {}) {
    const c = this.cfg.giveaway;
    if (!c.announceInChat || !template) return;
    const text = render(template, { prize: c.prize || 'un premio', command: normalizeTrigger(c.command), title: c.title, count: this.s.giveaway.entries.length, ...extra });
    // El envío real se registra antes de iniciarse; el catch normal (log/propagate) no cambia.
    try { await this.#chatTask(() => this.twitch.sendChat(text)); }
    catch (e) {
      if (propagate) throw e;
      this.log('[sorteo]', e.message);
    }
  }

  // ================================================================
  // Estado para widgets, panel y MCP
  // ================================================================
  snapshot() {
    const pending = this.s.questions.filter(x => x.status === 'pending');
    return {
      questions: { list: this.s.questions, pending: pending.length, current: this.s.questions.find(x => x.id === this.s.currentQuestion) || null },
      tierlists: this.s.tierlists, shownTierlist: this.s.shownTierlist, vote: this.voteSummary(),
      giveaway: { ...this.giveawayState(), rolling: this.s.giveaway.rolling },
      config: this.cfg,
    };
  }
}
