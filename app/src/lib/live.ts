// Estado en vivo: /api/state + eventos SSE (/api/stream). Un solo almacén para toda la vista.
import { useSyncExternalStore } from 'react';
import { warnUnknownClientEvent } from '../../../src/events.mjs'; // contrato único de eventos SSE (#72)
import { mergeChat } from './chat-merge.mjs';
import { api, withKey } from './api';
import { holding, protectDrafts, registerDraft, type DraftSource } from './draft';
import { ManualDraft } from './manual-draft';
import type { AppState, ChatMessage, Config, LiveEventName, LiveEvents, PrompterState, Timeline } from './types';

type Listener = () => void;
/** Un manejador de evento, con el payload tipado por el mapa LiveEvents. */
type Handler = (data: never) => void;

/** Mezcla superficial y recursiva de parches de configuración. Sin claves de prototipo (#62). */
export function deepMerge<T>(a: T | undefined, b: unknown): T {
  const o = { ...(a || ({} as T)) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(b as Record<string, unknown> | null || {})) {
    // Claves de prototipo: nunca se copian (#62) ni siquiera como propiedad propia.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    o[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(o[k], v) : v;
  }
  return o as T;
}

/** Slices that every update replaces whole (no partial patches, unlike status or widgets):
 *  the local copy received during a load is at least as new as that load's snapshot.
 *  meld is not here: its SSE event only brings the session, so only the session is kept. */
const WHOLE: (keyof AppState)[] = ['teleprompter', 'interactive', 'timers', 'viewers', 'history', 'theme', 'alertPreviews', 'customOverlays'];

class Live {
  state: AppState | null = null;
  timeline: Timeline = { items: [], pending: 0 };
  prompter: PrompterState = { tab: 'cronologia' };
  connected = false;
  /** true tras perder la conexión (no al arrancar): para el aviso de «sin conexión». */
  failed = false;
  version = 0;
  private listeners = new Set<Listener>();
  private handlers = new Map<string, Set<Handler>>();
  private es: EventSource | null = null;
  private openFns = new Set<() => void>();
  private inflightChat = new Set<Set<string>>();
  /** Borrados (ids) y limpiezas (login; null = todo) llegados durante cada carga en curso:
   *  la instantánea pudo generarse antes y no debe devolver lo ya borrado. */
  private inflightRemoved = new Set<{ ids: Set<string>; logins: Set<string | null> }>();
  /** Generación de la última instantánea de estado aplicada (#116): una carga anterior que
   *  resuelve después de una más reciente no debe pisar config, history ni status. */
  private appliedGen = 0;
  private loadSeq = 0;
  /** Cambios optimistas de config aplicados desde update(): una edición local (p. ej.
   *  añadir una barra a un objetivo en el panel) es más nueva que cualquier snapshot de
   *  /api/state pedido antes, así que ese snapshot no debe revertirla al aplicarse. */
  private cfgTouch = 0;
  /** Same epoch for the slices that arrive whole (POST replies and SSE events): a script
   *  picked in the teleprompter while the SSE 'open' snapshot is in flight is newer than
   *  that snapshot, which must not bring the previous script back. */
  private touched: Partial<Record<keyof AppState, number>> = {};
  private cfgTimer: ReturnType<typeof setTimeout> | undefined;
  private configDraft: ManualDraft<Record<string, unknown>, Config>;
  readonly configSource: DraftSource;

  constructor() {
    this.configDraft = new ManualDraft({
      empty: () => ({}), merge: deepMerge,
      take: () => this.state!.config,
      persist: async patch => (await api<{ config: Config }>('PUT', '/api/config', patch)).config,
      publish: (saved, newer) => this.update(() => ({ config: deepMerge(saved, newer) })),
      // Other sources may have saved another config section after this snapshot.
      restore: (saved, discarded) => this.update(s => ({ config: { ...s.config,
        ...Object.fromEntries(Object.entries(saved).filter(([key]) => Object.hasOwn(discarded, key))) } })),
      protect: (state, intent) => ({ ...state, config: deepMerge(state.config, intent) }),
    });
    this.configSource = {
      dirty: this.configDraft.dirty, keys: this.configDraft.keys,
      prepareSave: () => { clearTimeout(this.cfgTimer); return this.configDraft.prepareSave(); },
      discard: () => this.discardConfig(), protect: this.configDraft.protect,
    };
    registerDraft('config', this.configSource);
  }

  subscribe = (fn: Listener) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  emit() { this.version++; for (const fn of this.listeners) fn(); }
  on<E extends LiveEventName>(event: E, fn: (data: LiveEvents[E]) => void) {
    warnUnknownClientEvent(event); // avisa (una vez) si el nombre no está en el contrato
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn as Handler);
    return () => { this.handlers.get(event)?.delete(fn as Handler); };
  }
  private fire(event: string, data: unknown) { for (const fn of this.handlers.get(event) || []) fn(data as never); }

  /** Cambia el estado con una función que recibe el estado y devuelve un parche (merge superficial). */
  update(fn: (s: AppState) => Partial<AppState>) {
    const s = this.state as AppState;
    const patch = fn(s);
    // Un cambio local de config marca época: los snapshots pedidos antes de él quedan obsoletos.
    if (patch.config) this.cfgTouch++;
    for (const k of Object.keys(patch) as (keyof AppState)[]) if (WHOLE.includes(k) || k === 'meld') this.touched[k] = (this.touched[k] ?? 0) + 1;
    this.state = protectDrafts({ ...s, ...patch });
    this.emit();
  }

  async load() {
    // #116: cada carga toma un número de generación; solo aplica su instantánea si sigue
    // siendo la más reciente aplicada. Si dos cargas se solapan (arranque y primer open,
    // o un gap) y la más antigua resuelve la última, la más reciente ya aplicó su estado
    // y la antigua se descarta entera (config, history, status; su fusión de chat no
    // revierte mensajes que llegaron después de ese snapshot).
    const gen = ++this.loadSeq;
    // Época de config al pedir el snapshot: si la config cambia localmente mientras vuela
    // esta carga (ediciones optimistas o un evento 'config' más nuevo), el snapshot llegó
    // a ser viejo y no debe pisarla.
    const cfgAtStart = this.cfgTouch;
    const touchedAtStart = { ...this.touched };
    // ids que llegan por SSE mientras ESTA petición está en curso: cada carga concurrente
    // registra el suyo (la del llamador y la del primer open solapan); solo esos ids se
    // fusionan con el snapshot al aplicarlo (lo local más viejo o borrado no vuelve a entrar).
    const inFlight = new Set<string>();
    this.inflightChat.add(inFlight);
    const removed = { ids: new Set<string>(), logins: new Set<string | null>() };
    this.inflightRemoved.add(removed);
    try {
      const snap = await api<AppState>('GET', '/api/state');
      // Chat del panel (#48): ventana propia de 200 por /api/chat. La que viaja en
      // /api/state (y en los eventos 'widgets') es la del overlay (50) y no manda aquí.
      const chat = (await api<ChatMessage[]>('GET', '/api/chat?limit=200').catch(() => snap.widgets?.chat || []))
        .filter(m => !removed.ids.has(m.id) && !removed.logins.has(null) && !(m.login && removed.logins.has(m.login)));
      if (gen <= this.appliedGen) return; // ya se aplicó una carga más reciente: no pisar
      this.appliedGen = gen;
      // Un cambio optimista de config durante el vuelo de esta carga es más nuevo que su
      // snapshot (lo pedimos antes de la edición): se conserva la config local y solo se
      // aplica el resto del snapshot. Sin esto, un gap/reconexión del SSE que aterrizara
      // entre la edición y su guardado revertía la UI hasta la siguiente carga (fallo
      // intermitente de goals-browser en CI: el bloque Goals volvía a 2 barras).
      const config = this.cfgTouch === cfgAtStart ? snap.config : (this.state?.config ?? snap.config);
      const prev = this.state;
      const kept: Partial<AppState> = prev ? Object.fromEntries(WHOLE.filter(k => this.touched[k] !== touchedAtStart[k]).map(k => [k, prev[k]])) : {};
      // meld: only the session arrives by SSE; the rest (commands, events) comes from the snapshot.
      if (prev && this.touched.meld !== touchedAtStart.meld) kept.meld = { ...snap.meld, session: prev.meld?.session };
      this.state = protectDrafts({ ...snap, ...kept, config, widgets: { ...snap.widgets, chat: mergeChat(this.state?.widgets?.chat, chat, inFlight).slice(-200) } });
    } finally { this.inflightChat.delete(inFlight); this.inflightRemoved.delete(removed); }
    try {
      const tl = await api<Timeline>('GET', '/api/timeline');
      if (gen < this.appliedGen) return; // una carga más reciente ya aplicó su estado
      this.timeline = tl;
    } catch { /* la vista funciona sin cronología */ }
    try {
      const pr = await api<PrompterState>('GET', '/api/prompter');
      if (gen < this.appliedGen) return;
      this.prompter = pr;
    } catch { /* la vista funciona sin prompter */ }
    this.emit();
  }

  /** Registra una función que se ejecuta en cada apertura del SSE (arranque y reconexiones):
   *  para recargar datos propios de la vista que no vienen en load(), como la lista de chat. */
  onOpen(fn: () => void) { this.openFns.add(fn); return () => { this.openFns.delete(fn); }; }

  /** Cambia la configuración al momento y la guarda en el servidor tras 400 ms sin cambios. */
  patchConfig(patch: Record<string, unknown>) {
    this.configDraft.push(patch); // capture baseline before the optimistic mutation
    this.update(s => ({ config: deepMerge(s.config, patch) }));
    clearTimeout(this.cfgTimer);
    if (holding()) return;
    this.cfgTimer = setTimeout(() => this.flushConfig().catch(e => this.fire('error', e)), 400);
  }
  async flushConfig() {
    clearTimeout(this.cfgTimer);
    await this.configDraft.save();
    if (!holding() && this.configDraft.dirty()) {
      this.cfgTimer = setTimeout(() => this.flushConfig().catch(e => this.fire('error', e)), 400);
    }
  }
  /** Guarda al momento, fuera del borrador manual: para marcas del propio panel (p. ej. el tour visto)
   *  que no son una edición del usuario y no deben esperar a «Guardar» ni perderse con «Descartar». */
  async saveConfigNow(patch: Record<string, unknown>) {
    this.update(s => ({ config: deepMerge(s.config, patch) }));
    this.configDraft.updateBaseline(saved => deepMerge(saved, patch));
    await api('PUT', '/api/config', patch);
  }
  /** Descarta el borrador de configuración y vuelve a lo guardado. */
  discardConfig() {
    clearTimeout(this.cfgTimer);
    this.configDraft.discard();
  }

  connect(client = 'panel') {
    if (this.es) return;
    const es = new EventSource(withKey(`/api/stream?client=${client}`));
    this.es = es;
    const on = <E extends LiveEventName>(ev: E, fn: (d: LiveEvents[E]) => void) => {
      warnUnknownClientEvent(ev); // avisa (una vez) si el nombre no está en el contrato
      es.addEventListener(ev, (e: MessageEvent) => { let d: unknown; try { d = JSON.parse(e.data); } catch { return; } fn(d as never); this.fire(ev, d); });
    };
    es.onopen = () => {
      this.connected = true;
      this.failed = false;
      // Al arrancar y al reconectar se recarga tras abrir el SSE: un evento emitido entre
      // load() y connect() (o durante el corte) no se pierde; load() fusiona el chat sin duplicarlo.
      this.load().catch(() => {});
      for (const fn of this.openFns) fn();
      this.emit();
    };
    es.onerror = () => { this.connected = false; this.failed = true; this.emit(); };
    on('gap', () => { this.load().catch(() => {}); });
    on('status', st => this.update(() => ({ status: st })));
    on('persistence', p => this.update(s => ({ status: { ...s.status, persistence: p } })));
    on('pause', p => this.update(s => ({ status: { ...s.status, pause: p } })));
    on('history', h => this.update(() => ({ history: h })));
    on('interactive', i => this.update(() => ({ interactive: i })));
    on('viewers', v => this.update(() => ({ viewers: v })));
    on('teleprompter', t => this.update(() => ({ teleprompter: t })));
    on('theme', ({ alertPreviews, ...theme }) => this.update(() => ({
      theme,
      // Preserve confirmed fingerprints outside protectDrafts' editable theme/config.
      ...(alertPreviews ? { alertPreviews } : {}),
    })));
    on('timers', t => this.update(() => ({ timers: t })));
    // Overlays propios: la lista completa en cada cambio (panel, MCP o API).
    on('customOverlays', list => this.update(() => ({ customOverlays: list })));
    on('meld', m => this.update(s => ({ meld: { ...s.meld, session: m } })));
    // El evento 'widgets' trae la ventana corta del overlay (50): el panel conserva SU
    // lista de chat (tope 200, #48) y del evento solo toma lo demás. Los borrados y las
    // limpiezas llegan por chatDelete/chatClear y el snapshot de load() manda al reconectar.
    on('widgets', w => this.update(s => ({ widgets: { ...w, chat: s.widgets?.chat ?? w.chat } })));
    on('chat', m => {
      for (const ids of this.inflightChat) ids.add(m.id);
      this.update(s => ({ widgets: { ...s.widgets, chat: s.widgets?.chat?.some(x => x.id === m.id) ? s.widgets.chat : [...(s.widgets?.chat || []), m].slice(-200) } }));
    });
    on('chatDelete', ({ id }) => {
      for (const r of this.inflightRemoved) r.ids.add(id);
      this.update(s => ({ widgets: { ...s.widgets, chat: (s.widgets?.chat || []).filter(m => m.id !== id) } }));
    });
    on('chatResult', () => {});   // only partial failures arrive; the panel shows them as a toast
    on('chatClear', ({ login }) => {
      for (const r of this.inflightRemoved) r.logins.add(login || null);
      this.update(s => ({ widgets: { ...s.widgets, chat: (s.widgets?.chat || []).filter(m => login && m.login !== login) } }));
    });
    on('timeline', tl => { this.timeline = tl; this.emit(); });
    on('prompter', p => { this.prompter = { ...this.prompter, ...p }; this.emit(); });
    on('config', c => this.update(s => ({ config: { ...s.config, ...c } })));
  }
}

/** Cargador del chat local (prompter y dock, #116): fusiona el snapshot con los mensajes
 *  que llegan por SSE mientras la carga está en curso (los ids en vuelo se registran por
 *  carga y el componente los usa al fusionar). Una carga más antigua que resuelve al
 *  final no debe pisar al chat ya aplicado. */
export function makeChatLoader(fetch: () => Promise<ChatMessage[]>, apply: (snap: ChatMessage[], ids: Set<string>) => void) {
  let seq = 0;
  // Generación ya aplicada (#116): una carga se descarta solo si otra MÁS RECIENTE ya
  // se aplicó. Si la más nueva aún no terminó (o falla), la antigua sí se aplica y el
  // chat no se queda vacío; y si la antigua resuelve al final, no pisa lo ya aplicado.
  let applied = 0;
  const inflight = new Set<Set<string>>();
  const load = () => {
    const gen = ++seq;
    const ids = new Set<string>();
    inflight.add(ids);
    return fetch().then(snap => {
      if (gen <= applied) return; // ya se aplicó una carga más reciente
      applied = gen;
      apply(snap, ids);
    }).catch(() => { /* la vista funciona sin el chat */ }).finally(() => { inflight.delete(ids); });
  };
  return { load, inflight };
}

export const live = new Live();

/** Re-renderiza cuando cambia el estado en vivo y devuelve lo que pide el selector. */
export function useLive<T>(sel: (s: AppState) => T): T {
  useSyncExternalStore(live.subscribe, () => live.version);
  return sel(live.state as AppState);
}
export function useLiveVersion() { return useSyncExternalStore(live.subscribe, () => live.version); }
