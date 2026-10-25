// Guardado manual (v2): mientras una pantalla de edición está abierta, los cambios se quedan en
// borrador hasta pulsar «Guardar». Cada pieza que guarda algo se registra como una fuente:
// la configuración general (live.patchConfig), los widgets, los interactivos, el editor de
// alertas, el tema… SaveBar suma todas y Guardar / Descartar actúan sobre todas a la vez.
import { useEffect, useSyncExternalStore } from 'react';
import type { AppState } from './types';

export type PreparedSave = {
  run: () => Promise<unknown>;
  /** Restore an intent that has not been sent; this never cancels HTTP. */
  rollback: () => void;
};

export type DraftSource = {
  /** ¿Hay cambios sin guardar? */
  dirty: () => boolean;
  /** Pestañas (o claves) con cambios, para el punto de cada pestaña. */
  keys?: () => string[];
  prepareSave: () => PreparedSave | undefined;
  discard: () => void;
  protect?: (state: AppState) => AppState;
};

const sources = new Map<string, DraftSource>();
const subs = new Set<() => void>();
let version = 0;
let holds = 0;
const holdSubs = new Set<(on: boolean) => void>();

/** Avisa a SaveBar (y a las pestañas) de que algo ha cambiado. */
export function draftChanged() { version++; subs.forEach(f => f()); }
export function registerDraft(id: string, s: DraftSource) {
  sources.set(id, s); draftChanged();
  return () => { if (sources.get(id) === s) sources.delete(id); draftChanged(); };
}

export const isDirty = () => [...sources.values()].some(s => s.dirty());
export const dirtyKeys = () => [...new Set([...sources.values()].flatMap(s => (s.dirty() ? (s.keys?.() || ['*']) : [])))];
let busy = false;
let operation: Promise<unknown> | undefined;
export const isSaving = () => busy;
export function protectDrafts(state: AppState) {
  for (const source of sources.values()) state = source.protect?.(state) ?? state;
  return state;
}
export function saveSources(selected: DraftSource[]): Promise<unknown> {
  if (busy) return operation ?? Promise.resolve();
  busy = true; // synchronous lock, including rapid clicks before React re-renders
  const jobs: PreparedSave[] = [];
  try {
    // Capture EVERY intent at click time, not when the preceding request finishes.
    for (const source of selected) {
      if (source.dirty()) { const job = source.prepareSave(); if (job) jobs.push(job); }
    }
  } catch (error) {
    for (const job of jobs) job.rollback();
    busy = false; draftChanged();
    return Promise.reject(error);
  }
  operation = Promise.resolve().then(async () => {
    let next = 0;
    try { for (; next < jobs.length; next++) await jobs[next].run(); }
    finally { for (const job of jobs.slice(next + 1)) job.rollback(); }
  }).finally(() => { busy = false; operation = undefined; draftChanged(); });
  draftChanged();
  return operation;
}
/** Explicit flushes wait for the current save, then capture their own pending sources.
 * Manual saveAll deliberately keeps its single-click/join behavior. */
export async function flushSources(selected: DraftSource[]): Promise<unknown> {
  while (busy) await operation;
  return saveSources(selected);
}
export const saveAll = () => saveSources([...sources.values()]);
export function discardAll() {
  if (busy) return;
  for (const s of [...sources.values()]) if (s.dirty()) s.discard();
  draftChanged();
}

/** true mientras alguna pantalla con guardado manual está montada (los guardados automáticos esperan). */
export const holding = () => holds > 0;
export function onHold(fn: (on: boolean) => void) { holdSubs.add(fn); return () => { holdSubs.delete(fn); }; }

/** Activa el guardado manual mientras el componente está montado. Al salir sin guardar, se descarta. */
export function useManualSave() {
  useEffect(() => {
    holds++;
    if (holds === 1) holdSubs.forEach(f => f(true));
    return () => {
      holds--;
      if (holds === 0) { discardAll(); holdSubs.forEach(f => f(false)); }
    };
  }, []);
}

/** Re-renderiza con cada cambio de borrador. */
export function useDraftVersion() { return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => version); }

/** Pregunta antes de perder cambios (navegación por hash y cierre de ventana). */
export function confirmLeave(): boolean {
  if (isSaving()) return false;
  if (!isDirty()) return true;
  if (!confirm('Tienes cambios sin guardar. ¿Salir y descartarlos?')) return false;
  discardAll();
  return true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', e => { if (isSaving() || isDirty()) { e.preventDefault(); e.returnValue = ''; } });
}
