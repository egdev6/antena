// Parches acumulados que se mandan al servidor tras un rato sin cambios (widgets, interactivos…).
// Con guardado manual (draft.ts) se quedan en borrador hasta «Guardar»; «Descartar» vuelve a la copia.
import { api } from './api';
import { deepMerge, live } from './live';
import { toast } from './ui';
import { draftChanged, holding, registerDraft } from './draft';

// Fuera del guardado manual, un guardado fallido vuelve a la cola (gana lo más nuevo) y se reintenta
// con espera creciente: 2 s, 4 s, 8 s… hasta 30 s. El aviso de error sale una vez por racha de fallos;
// un guardado bueno reinicia la espera. Con «Guardar» (borrador) el fallo se avisa al momento y el
// borrador sigue ahí para volver a intentarlo: no hay reintento automático a escondidas.
export function patcher(method: string, url: string, after?: (d: any) => void, ms = 400, snap?: { take: () => any; restore: (v: any) => void }) {
  let pending: any = {}, t: any = null, fails = 0, chain: Promise<void> = Promise.resolve(), copy: any = undefined;
  const send = async (manual: boolean) => {
    clearTimeout(t);
    if (!Object.keys(pending).length) return;
    const p = pending; pending = {};
    // la petición va primero: `after?.(await api(…))` se salta los argumentos si no hay `after`
    try { const d = await api(method, url, p); fails = 0; copy = undefined; after?.(d); } catch (e: any) {
      pending = deepMerge(p, pending);
      if (manual) { toast(e.message, true); throw e; }
      if (!fails++) toast(e.message, true);
      clearTimeout(t); t = setTimeout(() => { flush().catch(() => {}); }, Math.min(30000, 2000 * 2 ** (fails - 1)));
    } finally { draftChanged(); }
  };
  // las peticiones van de una en una: un reintento nunca llega después (y encima) de un guardado más nuevo
  const run = (manual: boolean) => { const next = chain.then(() => send(manual)); chain = next.catch(() => {}); return next; };
  const flush = () => run(false);
  const save = () => run(true);
  const push = (patch: any) => {
    if (holding() && !Object.keys(pending).length && snap) copy = structuredClone(snap.take());
    pending = deepMerge(pending, patch);
    clearTimeout(t);
    if (holding()) { draftChanged(); return; }
    t = setTimeout(() => { flush().catch(() => {}); }, ms);
  };
  const discard = () => { clearTimeout(t); pending = {}; if (copy !== undefined && snap) snap.restore(copy); copy = undefined; draftChanged(); };
  registerDraft(url, { dirty: () => Object.keys(pending).length > 0, keys: () => Object.keys(pending), save, discard });
  return { push, flush, discard };
}

/** Configuración de widgets (config.widgets): cambia al momento y se guarda con PUT /api/widgets. */
const W = patcher('PUT', '/api/widgets', undefined, 400, {
  take: () => live.state?.config.widgets,
  restore: v => live.update(s => ({ config: { ...s.config, widgets: v } })),
});
export function patchWidgets(patch: any) {
  live.update(s => ({ config: { ...s.config, widgets: deepMerge(s.config.widgets, patch) } }));
  W.push(patch);
}

/** Configuración de preguntas, tier list y sorteo. */
const IX = patcher('PUT', '/api/interactive/config', cfg => live.update(s => ({ interactive: { ...s.interactive, config: cfg } })), 400, {
  take: () => live.state?.interactive?.config,
  restore: v => live.update(s => ({ interactive: { ...s.interactive, config: v } })),
});
export function patchIx(section: string, patch: any) {
  live.update(s => ({ interactive: { ...s.interactive, config: { ...s.interactive.config, [section]: { ...s.interactive.config[section], ...patch } } } }));
  IX.push({ [section]: patch });
}
export const flushAll = () => Promise.all([W.flush(), IX.flush(), live.flushConfig()]);
