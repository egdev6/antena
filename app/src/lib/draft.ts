// Guardado manual (v2): mientras una pantalla de edición está abierta, los cambios se quedan en
// borrador hasta pulsar «Guardar». Cada pieza que guarda algo se registra como una fuente:
// la configuración general (live.patchConfig), los widgets, los interactivos, el editor de
// alertas, el tema… SaveBar suma todas y Guardar / Descartar actúan sobre todas a la vez.
import { useEffect, useSyncExternalStore } from 'react';

export type DraftSource = {
  /** ¿Hay cambios sin guardar? */
  dirty: () => boolean;
  /** Pestañas (o claves) con cambios, para el punto de cada pestaña. */
  keys?: () => string[];
  save: () => Promise<unknown>;
  discard: () => void;
};

const sources = new Map<string, DraftSource>();
const subs = new Set<() => void>();
let version = 0;
let holds = 0;
const holdSubs = new Set<(on: boolean) => void>();

/** Avisa a SaveBar (y a las pestañas) de que algo ha cambiado. */
export function draftChanged() { version++; subs.forEach(f => f()); }
export function registerDraft(id: string, s: DraftSource) { sources.set(id, s); draftChanged(); return () => { sources.delete(id); draftChanged(); }; }

export const isDirty = () => [...sources.values()].some(s => s.dirty());
export const dirtyKeys = () => [...new Set([...sources.values()].flatMap(s => (s.dirty() ? (s.keys?.() || ['*']) : [])))];
export async function saveAll() {
  for (const s of [...sources.values()]) if (s.dirty()) await s.save();
  draftChanged();
}
export function discardAll() {
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
  if (!isDirty()) return true;
  if (!confirm('Tienes cambios sin guardar. ¿Salir y descartarlos?')) return false;
  discardAll();
  return true;
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
}
