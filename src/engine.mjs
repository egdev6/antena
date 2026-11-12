// Motor: decide qué alerta sale, la filtra, la pausa si toca, la registra, ejecuta sus acciones y alimenta los widgets.
import { isTotalMetric } from './channel-totals.mjs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { buildAlert, buildCommandAlert, buildCustomAlert, render, cutWords, ALERT_TYPES } from './alerts.mjs';
import { cleanVars, cleanText, isBlockedUser } from './filters.mjs';
import { CommandRunner } from './commands.mjs';
import { timerPlatforms, sendToPlatform, PLATFORM_NAMES } from './timers.mjs';

/** Ventana de agrupación de snapshots (history/widgets/interactive), como la cronología. */
export const SNAPSHOT_COALESCE_MS = 120;

/** Techo de espera de una ráfaga sostenida: evita que un flujo sin pausa inanice el envío. */
export const SNAPSHOT_MAX_WAIT_MS = 500;

/** Campos de una alerta que pueden ver los clientes «widget» y los overlays propios (S6).
 *  Fuera quedan las acciones de Meld, el aspecto (media, sonido, css) y el tts: son
 *  decisiones del overlay de alertas y no datos públicos del directo. */
const PUBLIC_ALERT_FIELDS = ['type', 'title', 'text', 'sub', 'platform', 'icon', 'durationMs', 'at'];

/** Alerta reducida a sus datos públicos: la que reciben los widgets y el SDK de los overlays. */
export function publicAlert(a) {
  const out = {};
  for (const f of PUBLIC_ALERT_FIELDS) out[f] = a?.[f];
  out.vars = { ...(a?.vars || {}) };
  return out;
}

/** #94: tipos que nunca se descartan ni se fusionan en la cola del overlay (decisión del mantenedor). */
export const PROTECTED_QUEUE_TYPES = new Set(['raid', 'superchat', 'supersticker']);

/**
 * Agrupa una ráfaga de envíos en uno solo: la última llamada dentro de la ventana manda
 * y `fn` solo se ejecuta al vencer el temporizador (con `flush` se vacía al instante).
 * Con `maxWaitMs > 0`, si el flujo no cesa, `fn` sale igualmente al vencer ese techo contado
 * desde la primera llamada pendiente (como Session con debounceMs + maxWaitMs).
 * Los temporizadores quedan unref: un cierre de proceso no se queda colgado por un envío.
 */
export function burstCoalesce(ms = SNAPSHOT_COALESCE_MS, fn = () => {}, maxWaitMs = SNAPSHOT_MAX_WAIT_MS) {
  let t = null, wait = null;
  const run = () => { clearTimeout(t); t = null; clearTimeout(wait); wait = null; fn(); };
  const push = () => {
    clearTimeout(t);
    t = setTimeout(run, ms);
    t.unref?.();
    if (!wait && maxWaitMs > 0) {
      wait = setTimeout(() => { clearTimeout(t); run(); }, maxWaitMs);
      wait.unref?.();
    }
    return push;
  };
  push.flush = () => { if (t || wait) { clearTimeout(t); clearTimeout(wait); t = wait = null; fn(); } return push; };
  push.cancel = () => { clearTimeout(t); clearTimeout(wait); t = wait = null; return push; };
  return push;
}

export class Engine extends EventEmitter {
  #actionRoots = new Set();
  #sentActionRoots = new Set();
  #pendingActionRoots = new Map();
  #wasPaused;
  #queueNote;
  #queueNotePush;

  constructor({ store, bus, session, meld, twitch, youtube, log = console.log }) {
    super();
    Object.assign(this, { store, bus, session, meld, twitch, youtube, log });
    this.held = [];
    this.chat = [];
    this.commands = new CommandRunner();
    this.pendingActions = new Map();
    this.fallbackTimers = new Map(); // id -> Set de asas físicas del fallback de 120 s
    this.queuedAlerts = new Map();   // #66: id -> alerta enviada al overlay y aún sin ACK de «shown» (orden de cola)
    this.#queueNote = { dropped: 0, merged: 0, overflow: 0, types: new Set() };
    // #66: la nota de ráfaga se agrupa para no inundar la cronología; sale 2 s después del último
    // suceso o, como tope, 5 s desde el primero (y con flushQueueNotes al terminar de comprobar).
    this.#queueNotePush = burstCoalesce(2000, () => this.#flushQueueNote(), 5000);
    this.sceneTimers = [];
    // Ráfagas: history y widgets se agrupan (el último valor manda, como la cronología).
    this.#pushHistoryNow = burstCoalesce(SNAPSHOT_COALESCE_MS, () => this.bus.send('history', this.bus.history.slice(0, 50), ['panel']));
    this.#pushWidgetsNow = burstCoalesce(SNAPSHOT_COALESCE_MS, () => this.bus.send('widgets', this.widgetState(), ['widget', 'panel']));
    this.#wasPaused = this.paused;
  }

  #pushHistoryNow;
  #pushWidgetsNow;

  get config() { return this.store.config; }
  get paused() { return !!this.config.paused; }

  // ---------- eventos de plataforma ----------
  handleEvent({ externalId, type, vars }) {
    if (this.bus.isDuplicate(externalId)) return null;
    if (isBlockedUser(vars.user, this.config.filters)) { this.log(`[filtro] alerta de ${vars.user} bloqueada`); return null; }
    const clean = cleanVars(vars, this.config.filters);
    const a = buildAlert(type, clean, this.config);
    if (!a) return null;
    this.session.record(a);
    this.log(`[alerta] ${type}${a.variation ? ' (' + a.variation.name + ')' : ''} · ${a.text}`);
    return this.deliver(a);
  }

  handleChat(msg, context) {
    if (isBlockedUser(msg.user, this.config.filters) || isBlockedUser(msg.login, this.config.filters)) return;
    // Solo los productores reales pasan este contexto separado del mensaje público.
    if (['twitch', 'youtube'].includes(context?.source)) {
      try { this.emit('chatMetric', msg, context); }
      catch { try { this.log('[chat] No se pudieron registrar las métricas del mensaje.'); } catch {} }
    }
    // tus propios mensajes (y los programados) no pasan por el filtro de enlaces y palabras
    const text = msg.owner ? String(msg.text ?? '') : cleanText(msg.text, this.config.filters);
    const m = { ...msg, text, parts: text === msg.text ? msg.parts : [{ t: text }], user: cleanText(msg.user, { ...this.config.filters, blockLinks: false, maxMessageLength: 60 }) };
    // Identidad para contabilidad interna: nunca se publica en chat, widgets ni SSE.
    delete m.authorId;
    delete m.roomId;
    m.command = /^[!¡]/.test(text.trim());
    if (m.highlighted) this.session.addNote({ kind: 'highlight', text: m.text, user: m.user, platform: m.platform, msgId: m.id });
    this.timers?.onChat(m);
    // preguntas, votos de la tier list y sorteo: el mensaje se marca como «usado» (el prompter lo oculta)
    m.used = !!this.interactive?.onChat(m);
    this.chat.push(m);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    this.bus.send('chat', m, ['widget', 'panel']);
    if (m.used) return;
    const hit = this.commands.match(this.config.commands || [], m);
    if (hit) {
      const vars = cleanVars(hit.vars, this.config.filters);
      this.log(`[comando] ${hit.cmd.trigger} · ${m.user}`);
      if (hit.cmd.outputMode === 'chat') {
        if (!['twitch', 'youtube'].includes(m.platform) || !hit.cmd.chatReply?.trim()) return;
        this.deliver({ id: randomUUID(), type: 'command', commandId: hit.cmd.id, chatOnly: true, vars,
          actions: [{ kind: 'chat', text: hit.cmd.chatReply, destination: m.platform }] });
      } else this.deliver(buildCommandAlert(hit.cmd, vars, this.config));
    }
  }
  deleteChat(id) { this.chat = this.chat.filter(c => c.id !== id); this.bus.send('chatDelete', { id }, ['widget', 'panel']); }
  clearChatUser(login) {
    this.chat = this.chat.filter(c => login && c.login !== login);
    this.bus.send('chatClear', { login: login || null }, ['widget', 'panel']);
  }

  // ---------- entrega ----------
  /** target: 'live' | 'preview'. Las pruebas no se registran ni se pausan. */
  deliver(a, { target = 'live' } = {}) {
    if (!a) return null;
    if (target === 'preview') {
      this.bus.send('control', { action: 'clear' }, ['preview']);
      this.bus.send('alert', a, ['preview']);
      return a;
    }
    if (!a.test && !a.chatOnly) {
      this.bus.history.unshift(a);
      this.bus.history.length = Math.min(this.bus.history.length, this.bus.historySize);
      this.pushHistory();
    }
    if (this.paused && !a.test) {
      this.held.push(a);
      this.pushPause();
      return a;
    }
    this.send(a);
    return a;
  }

  send(a) {
    if (a.chatOnly) {
      this.runActions(a.actions, a.vars, undefined, this.#origin(a)).catch(e => this.log('[acciones]', e.message));
      return;
    }
    // #66: política de ráfagas. Primero se intenta agrupar con otra alerta igual ya en cola;
    // si se agrupa, esta no se envía ni registra acciones propias (las suyas pasan al lote).
    if (this.#mergeQueued(a)) return;
    // Se apunta en la cola ANTES de aceptar: si no hay overlay, #accept hace el ACK inmediato
    // vía alertShown y la retirada deja la cola limpia; el orden del Map es el orden del overlay.
    this.queuedAlerts.set(a.id, a);
    let cycle, created = false, handles, handle;
    try {
      this.#accept(a, (c, isNew) => { cycle = c; created = isNew; }, (h, hs) => { handle = h; handles = hs; });
      if (cycle) cycle.accepted = true;
    }
    catch (e) {
      // La aceptación falló: se deshace solo lo que creó esta llamada si el ciclo sigue esperando ACK,
      // para que ni el drenaje ni el proceso esperen una alerta que nunca salió.
      if (cycle && this.#pendingActionRoots.get(a.id) === cycle) {
        if (handle !== undefined) {
          clearTimeout(handle);
          cycle.root.timers.delete(handle);
          handles.delete(handle);
          if (!handles.size) this.fallbackTimers.delete(a.id);
        }
        // Una aceptación reentrante exitosa puede compartir el ciclo creado aquí.
        if (created && !cycle.accepted) {
          this.pendingActions.delete(a.id);
          this.#pendingActionRoots.delete(a.id);
          cycle.release();
        }
      }
      throw e;
    }
    // #66: tras el envío, el tope puede obligar a descartar las más antiguas sin mostrar.
    this.#enforceQueueCap();
  }

  // ---------- #66: tope de la cola del overlay y política de ráfagas ----------

  /** Tope configurado de la cola del overlay; 0 (o inválido) = sin tope, como hasta ahora. */
  #queueMax() {
    const n = Number(this.config.overlay?.queueMax);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  /** Agrupa un regalo con otro igual (tipo, donante, tier/level) ya en cola y sin mostrar.
   *  Devuelve true si la alerta quedó absorbida: no se envía ni deja ciclo propio. */
  #mergeQueued(a) {
    if (!this.#queueMax()) return false;
    // #94: los tipos protegidos nunca se fusionan (ni se descartan).
    if (PROTECTED_QUEUE_TYPES.has(a.type)) return false;
    if (a.type !== 'giftsub' && a.type !== 'giftmember') return false;
    const amount = Number(a.vars?.amount);
    if (!Number.isFinite(amount)) return false;
    for (const q of this.queuedAlerts.values()) {
      if (q.type !== a.type) continue;
      if (q.vars?.user !== a.vars?.user) continue;
      if (String(q.vars?.tier ?? '') !== String(a.vars?.tier ?? '')) continue;
      if (String(q.vars?.level ?? '') !== String(a.vars?.level ?? '')) continue;
      // Las acciones se registran al enviarse: si la agrupada no tiene registro propio,
      // añadirle acciones ahora no serviría; se entrega como alerta aparte.
      if (a.actions?.length && !q.actions?.length) return false;
      q.vars = { ...q.vars, amount: Number(q.vars?.amount || 0) + amount };
      const cfg = this.config.alerts?.[a.type];
      if (cfg?.text) q.text = render(cfg.text, q.vars) || q.text;
      if (cfg?.sub) q.sub = render(cfg.sub, q.vars);
      if (a.actions?.length && q.actions) {
        // El lote ejecuta cada acción una sola vez: las idénticas no se duplican.
        const seen = new Set(q.actions.map(x => JSON.stringify(x)));
        for (const act of a.actions) {
          const k = JSON.stringify(act);
          if (!seen.has(k)) { seen.add(k); q.actions.push(act); }
        }
      }
      // El overlay actualiza la alerta ya en cola en vez de encolar otra.
      this.bus.send('alert', { ...q, merged: true }, ['overlay']);
      // La alerta pública no se reemite al agrupar: el widget ya recibió este lote al encolarse.
      this.#notePolicy({ merged: 1, types: [a.type] });
      return true;
    }
    return false;
  }

  /** Aplica el tope: descarta las más antiguas sin mostrar, les cancela acciones y fallback
   *  y avisa al overlay (control drop) y a la cronología/panel. */
  #enforceQueueCap() {
    const max = this.#queueMax();
    if (!max || this.queuedAlerts.size <= max) return;
    const ids = [];
    const types = new Set();
    for (const [id, a] of this.queuedAlerts) {
      if (this.queuedAlerts.size <= max) break;
      // #94: raid, superchat y supersticker no se descartan nunca; el recorte recae en el resto.
      if (PROTECTED_QUEUE_TYPES.has(a.type)) continue;
      const dropped = this.#discardQueued(id);
      if (dropped) { ids.push(id); types.add(dropped.type); }
    }
    // Si solo quedan protegidas por encima del tope, se muestran todas y el panel lo indica.
    const overflow = Math.max(0, this.queuedAlerts.size - max);
    if (ids.length) this.bus.send('control', { action: 'drop', ids }, ['overlay']);
    if (ids.length || overflow) this.#notePolicy({ dropped: ids.length, overflow, types: [...types] });
  }

  /** Saca una alerta de la cola sin mostrarla y cancela su ciclo de acciones y fallback. */
  #discardQueued(id) {
    const a = this.queuedAlerts.get(id);
    if (!a) return null;
    this.queuedAlerts.delete(id);
    const cycle = this.#pendingActionRoots.get(id);
    const handles = this.fallbackTimers.get(id);
    if (handles) {
      this.fallbackTimers.delete(id);
      for (const handle of handles) {
        clearTimeout(handle); // nunca se descarta un asa 0 por ser falsy
        cycle?.root.timers.delete(handle);
      }
    }
    if (cycle) {
      this.pendingActions.delete(id);
      this.#pendingActionRoots.delete(id);
      cycle.release(); // la acción del lote no saldrá: se libera la raíz pendiente
    }
    return a;
  }

  /** Acumula el recuento de la ráfaga y agenda la nota de cronología (agrupada). */
  #notePolicy({ dropped = 0, merged = 0, overflow = 0, types = [] }) {
    this.#queueNote.dropped += dropped;
    this.#queueNote.merged += merged;
    this.#queueNote.overflow = Math.max(this.#queueNote.overflow, overflow); // exceso real de la ventana, no suma
    for (const t of types) this.#queueNote.types.add(t);
    this.#queueNotePush();
  }

  #flushQueueNote() {
    const n = this.#queueNote;
    if (!n.dropped && !n.merged && !n.overflow) return;
    const parts = [];
    if (n.dropped) parts.push(`${n.dropped} descartadas`);
    if (n.merged) parts.push(`${n.merged} agrupadas`);
    if (n.overflow) parts.push(`tope superado en ${n.overflow} alertas protegidas (raid, Super Chat o Super Sticker): se muestran todas`);
    const types = [...n.types].join(', ');
    try {
      this.session.addNote({
        kind: 'queue',
        text: `Ráfaga en la cola del overlay: ${parts.join(' y ')}${types ? ` (${types})` : ''}`,
        dropped: n.dropped,
        merged: n.merged,
        overflow: n.overflow,
      });
    } catch (e) { this.log('[cola]', e.message); }
    n.dropped = 0; n.merged = 0; n.overflow = 0; n.types.clear();
  }

  /** Fuerza la nota de política pendiente (para comprobaciones y cierre ordenado). */
  async flushQueueNotes() { this.#queueNotePush?.flush(); }

  #accept(a, onCycle, onHandle) {
    if (a.actions?.length) {
      this.pendingActions.set(a.id, a);
      // Un `send` duplicado antes del ACK reutiliza su ciclo pendiente; tras el ACK la id es una generación nueva.
      let cycle = this.#pendingActionRoots.get(a.id);
      if (!cycle) {
        const root = this.#newRoot();
        cycle = { root, release: this.#hold(root), accepted: false };
        this.#pendingActionRoots.set(a.id, cycle);
        this.#sentActionRoots.add(root);
        onCycle(cycle, true);
      } else onCycle(cycle, false);
      // si no hay overlay que avise de cuándo sale, se ejecutan ya
      if (!this.bus.overlayCount()) this.alertShown(a.id);
      else {
        // El fallback no sustituye al anterior: se conserva el vencimiento original y se
        // retienen todas las asas del mismo id para poder limpiarlas todas.
        let handles = this.fallbackTimers.get(a.id);
        if (!handles) { handles = new Set(); this.fallbackTimers.set(a.id, handles); }
        // El callback sólo es válido mientras su propia asa siga siendo propiedad vigente del id:
        // un ACK anterior que limpió su generación lo invalida, pero un `send` duplicado sin ACK
        // conserva el vencimiento más antiguo y el payload vigente del mismo id.
        const handle = setTimeout(() => {
          const owner = this.fallbackTimers.get(a.id);
          if (!owner || !owner.has(handle)) return;
          this.alertShown(a.id);
        }, 120_000); // por si el overlay se cierra
        handles.add(handle); // se guarda el asa original ANTES de unref, no su retorno
        onHandle(handle, handles);
        cycle.root.timers.add(handle); // el ciclo pendiente posee cada asa física mientras espera
        if (cycle.root.refCount > 0) handle.ref?.(); else handle.unref?.();
      }
    }
    this.bus.send('alert', a, ['overlay']);
    // La misma alerta, ya saneada, para los widgets y los overlays propios (S6). El overlay de
    // alertas sigue siendo el único que ve el payload completo y el único que mueve su cola.
    this.bus.send('publicAlert', publicAlert(a), ['widget']);
  }

  /** El overlay avisa de que la alerta ha empezado a verse. */
  alertShown(id) {
    // La propiedad se limpia antes de ejecutar acciones para sobrevivir a errores y reentradas.
    this.queuedAlerts?.delete(id); // #66: deja de contar como pendiente en la cola del overlay
    const cycle = this.#pendingActionRoots.get(id);
    const handles = this.fallbackTimers.get(id);
    if (handles) {
      this.fallbackTimers.delete(id);
      for (const handle of handles) {
        clearTimeout(handle); // nunca se descarta un asa 0 por ser falsy
        cycle?.root.timers.delete(handle); // el drenaje no refiere asas físicas ya destruidas
      }
    }
    const a = this.pendingActions.get(id);
    if (!a) {
      // Mutación externa del mapa: no se deja el ticket colgado ni se despacha en falso.
      if (cycle) { this.#pendingActionRoots.delete(id); cycle.release(); }
      return;
    }
    this.pendingActions.delete(id);
    this.#pendingActionRoots.delete(id);
    const origin = this.#origin(a);
    if (!cycle) { this.runActions(a.actions, a.vars, undefined, origin).catch(e => this.log('[acciones]', e.message)); return; }
    let ret;
    try { ret = this.runActions(a.actions, a.vars, cycle, origin); }
    catch (e) {
      cycle.root.errors.add(e);
      cycle.release();
      throw e;
    }
    // La propiedad inicial se libera con la promesa pública real, no con la promesa interna de la raíz.
    Promise.resolve(ret).then(
      () => cycle.release(),
      e => {
        cycle.root.errors.add(e);
        try { this.log('[acciones]', e.message); } catch (logErr) { cycle.root.errors.add(logErr); }
        cycle.release();
      },
    );
  }

  // ---------- raíces de acciones en vuelo ----------
  #newRoot() {
    const root = { pending: 0, refCount: 0, timers: new Set(), errors: new Set(), resolve: null, settled: false };
    root.promise = new Promise(resolve => { root.resolve = resolve; });
    return root;
  }

  #beginRoot() {
    const root = this.#newRoot();
    this.#actionRoots.add(root);
    return root;
  }

  #hold(root) {
    root.pending++;
    return () => {
      root.pending--;
      if (root.pending === 0 && !root.settled) {
        root.settled = true;
        this.#actionRoots.delete(root);
        this.#sentActionRoots.delete(root);
        root.resolve();
      }
    };
  }

  #recordError(root, error) { root.errors.add(error); }

  // Temporizador propio de la raíz: unref ordinario, referido mientras un drenaje lo espera.
  #schedule(root, fn, ms) {
    const release = this.#hold(root);
    const handle = setTimeout(() => {
      root.timers.delete(handle);
      void (async () => {
        try { await fn(); } catch (e) { this.#recordError(root, e); } finally { release(); }
      })();
    }, ms);
    root.timers.add(handle);
    if (root.refCount > 0) handle.ref?.(); else handle.unref?.();
    return handle;
  }

  // Qué alerta o comando disparó las acciones, para que el panel diga qué falló.
  #origin(a) {
    if (a.type !== 'command') return { kind: 'alert', type: a.type, id: a.id };
    const trigger = (this.config.commands || []).find(c => c.id === a.commandId)?.trigger;
    return { kind: 'command', type: a.type, id: a.id, commandId: a.commandId, ...(trigger && { trigger }) };
  }

  async runActions(actions = [], vars = {}, cycle, origin) {
    const root = cycle?.root ?? this.#beginRoot();
    if (cycle?.root) this.#actionRoots.add(root); // la raíz aceptada se vuelve raíz pública al despachar
    const release = this.#hold(root);
    const ctx = { root, origin };
    try {
      for (const act of actions) {
        const run = async () => {
          try { await this.runAction(act, vars, ctx); } catch (e) { this.#recordError(root, e); this.log('[acción]', act.kind, e.message); this.emit('actionError', { action: act, error: e.message, ...(e.platforms && { platforms: e.platforms }), ...(origin && { origin }) }); }
        };
        const d = Number(act.delaySec) || 0;
        if (d > 0) {
          const releaseDelay = this.#hold(root);
          const handle = setTimeout(() => {
            root.timers.delete(handle);
            run().then(releaseDelay, e => { this.#recordError(root, e); releaseDelay(); });
          }, d * 1000);
          root.timers.add(handle);
        } else await run();
      }
    } catch (e) {
      this.#recordError(root, e); // causa externa real (log/emit/for-of) mientras la raíz sigue en vuelo
      throw e;
    } finally { release(); }
  }

  // Drena las raíces ya iniciadas al entrar; no es terminal ni corta admisión futura.
  async drainActions() {
    return this.#drainRoots([...this.#actionRoots]);
  }

  // Drena los ciclos aceptados por `send` que sigan sin terminar su vida causal al entrar.
  async drainSentActions() {
    return this.#drainRoots([...this.#sentActionRoots]);
  }

  // Consulta de SOLO LECTURA: ¿hay un ACK realmente pendiente para este id? Exige pertenencia
  // simultánea al mapa público de pendientes y al ticket privado de la generación aceptada.
  hasPendingAck(id) {
    return this.pendingActions.has(id) && this.#pendingActionRoots.has(id);
  }

  // Instantánea inmutable de la identidad privada pendiente en ESTE instante. Solo expone un
  // predicado booleano: un id es actual si sigue en el mapa público y su raíz privada es la MISMA
  // identidad capturada. No basta el id, el payload mutable ni el refCount de otros drenajes.
  capturePendingAcks() {
    const generation = new Map();
    for (const [id, cycle] of this.#pendingActionRoots) generation.set(id, cycle.root);
    return Object.freeze({
      isCurrent: id => {
        const root = generation.get(id);
        return !!root && this.pendingActions.has(id) && this.#pendingActionRoots.get(id)?.root === root;
      },
    });
  }

  async #drainRoots(roots) {
    const errors = [];
    await Promise.all(roots.map(async root => {
      root.refCount++;
      for (const handle of root.timers) handle.ref?.();
      try { await root.promise; }
      finally {
        root.refCount--;
        if (root.refCount === 0) for (const handle of root.timers) handle.unref?.();
        for (const error of root.errors) errors.push(error);
      }
    }));
    if (errors.length) throw new AggregateError(errors, 'No se pudieron drenar las acciones de Engine.');
  }

  async runAction(act, vars, ctx) {
    if (ctx) return this.#execAction(act, vars, ctx.root, ctx.origin);
    const root = this.#beginRoot();
    const release = this.#hold(root);
    try { return await this.#execAction(act, vars, root); }
    catch (e) { this.#recordError(root, e); throw e; } finally { release(); }
  }

  async #execAction(act, vars, root, origin) {
    switch (act.kind) {
      case 'scene': {
        const before = this.meld.session().scenes.find(s => s.current);
        await this.meld.showScene(act.scene);
        const back = Number(act.returnAfterSec) || 0;
        if (back > 0 && before) this.sceneTimers.push(this.#schedule(root, () => this.meld.showScene(before.id), back * 1000));
        return;
      }
      case 'layer': {
        await this.meld.setLayer(act.scene, act.layer, true);
        const secs = Number(act.seconds) || 0;
        if (secs > 0) this.#schedule(root, () => this.meld.setLayer(act.scene, act.layer, false), secs * 1000);
        return;
      }
      case 'hideLayer': return this.meld.setLayer(act.scene, act.layer, false);
      case 'toggleLayer': return this.meld.setLayer(act.scene, act.layer);
      case 'effect': return this.meld.toggleEffect(act.scene, act.layer, act.effect);
      case 'command': return this.meld.command(act.command);
      case 'streamEvent': return this.meld.streamEvent(act.event, act.amount ? { amount: Number(act.amount) } : undefined);
      case 'chat': return this.#chat(act, render(act.text, vars), origin);
      case 'say': return this.say(render(act.text, vars));
      default: throw new Error(`Acción desconocida: ${act.kind}`);
    }
  }

  /**
   * Acción de chat: un intento y un resultado por plataforma (`chatResult`). El fallo de una nunca
   * reenvía lo que la otra ya recibió, y un fallo parcial se lanza para registrarse como fallo.
   */
  async #chat(act, text, origin) {
    const platforms = {}, errors = [];
    for (const p of timerPlatforms(act)) {
      platforms[p] = await sendToPlatform(p, p === 'twitch' ? this.twitch : this.youtube, text, {}, errors);
    }
    const failed = Object.entries(platforms).filter(([, r]) => !r.ok);
    this.emit('chatResult', { action: act, ok: !failed.length, platforms, ...(origin && { origin }) });
    if (!failed.length) return platforms.twitch?.result ?? platforms.youtube.result;
    const many = Object.keys(platforms).length > 1;
    // Con un solo destino se lanza el error del proveedor tal cual (como hasta ahora).
    const error = !many && errors[0] instanceof Error ? errors[0] : new Error(failed.map(([p, r]) => many ? `${PLATFORM_NAMES[p]}: ${r.error}` : r.error).join(' · '));
    error.platforms = platforms;
    throw error;
  }

  // ---------- pausa ----------
  async pause() { await this.store.patchConfig({ paused: true }); this.pushPause(); }
  async resume({ discard = false } = {}) {
    await this.store.patchConfig({ paused: false });
    const held = this.held.splice(0);
    if (!discard) for (const a of held) this.send(a);
    this.pushPause();
    return { released: discard ? 0 : held.length, discarded: discard ? held.length : 0 };
  }
  // Todo cambio de pausa (panel, /sd/pausa, MCP, PUT /api/config) pasa por aquí: punto único de reanudación.
  pushPause() {
    if (this.#wasPaused && !this.paused) this.timers?.onResume();
    this.#wasPaused = this.paused;
    this.bus.send('pause', this.pauseState(), ['panel', 'overlay']);
  }
  pauseState() { return { paused: this.paused, held: this.held.length }; }

  // ---------- otros ----------
  custom(fields = {}, vars = {}) {
    const a = buildCustomAlert(fields, cleanVars(vars, this.config.filters), this.config);
    return this.deliver(a);
  }
  say(text, opts = {}) {
    const t = this.config.tts || {};
    const msg = { id: randomUUID(), text: cutWords(cleanText(text, { ...this.config.filters, blockLinks: true }), Number(t.maxChars) || 300), voice: opts.voice ?? t.voice ?? '', rate: Number(opts.rate ?? t.rate ?? 1), pitch: Number(opts.pitch ?? t.pitch ?? 1), volume: Number(opts.volume ?? t.volume ?? 1) };
    this.bus.send('say', msg, ['overlay']);
    return msg;
  }

  /** Lo que necesitan los widgets: totales, últimos, objetivos, eventos recientes y créditos. */
  widgetState() {
    const s = this.session;
    const goals = (this.config.widgets?.goals || []).map(g => ({
      ...g,
      // source «channel»: total real del canal (#132), puede ser null si nunca se leyó
      bars: (g.bars || []).map(b => ({ ...b, value: s.goalValue(b.metric, b.platform), source: isTotalMetric(b.metric, b.platform) ? 'channel' : 'session' })),
    }));
    return {
      totals: s.totals(), latest: s.latest(), goals,
      recent: s.data.events.filter(e => !ALERT_TYPES[e.type]?.system).slice(-30).reverse().map(e => ({ type: e.type, label: ALERT_TYPES[e.type]?.label || e.type, user: e.user, sub: e.sub, at: e.at })),
      credits: s.credits(), session: { id: s.data.id, title: s.data.title, startedAt: s.data.startedAt },
      widgets: this.config.widgets, chat: this.chat.slice(-50),
    };
  }
  /** El historial se agrupa en ráfaga: una alerta añade al estado síncrono y el envío sale junto. */
  pushHistory() { this.#pushHistoryNow(); }
  pushWidgets() { this.#pushWidgetsNow(); }
  /** Vacía al instante los envíos agrupados pendientes (útil en pruebas y cierres ordenados). */
  flushScheduledSends() { this.#pushHistoryNow.flush(); this.#pushWidgetsNow.flush(); }
}
