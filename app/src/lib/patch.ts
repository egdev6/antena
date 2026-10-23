// Parches acumulados que se mandan al servidor tras un rato sin cambios (widgets, interactivos…).
import { api } from './api';
import { deepMerge, live } from './live';
import { toast } from './ui';

// A failed save goes back to the queue (newer edits win) and is retried with backoff: 2 s, 4 s, 8 s… up to 30 s.
// The error toast shows once per failure streak; a successful save resets the backoff.
export function patcher(method: string, url: string, after?: (d: any) => void, ms = 400) {
  let pending: any = {}, t: any = null, fails = 0, chain: Promise<void> = Promise.resolve();
  const send = async () => {
    clearTimeout(t);
    if (!Object.keys(pending).length) return;
    const p = pending; pending = {};
    // The request goes first: `after?.(await api(…))` skips the arguments when there is no `after`.
    try { const d = await api(method, url, p); fails = 0; after?.(d); } catch (e: any) {
      pending = deepMerge(p, pending);
      if (!fails++) toast(e.message, true);
      clearTimeout(t); t = setTimeout(flush, Math.min(30000, 2000 * 2 ** (fails - 1)));
    }
  };
  // Requests run one at a time, so a retry never lands after (and over) a newer save.
  const flush = () => (chain = chain.then(send));
  const push = (patch: any) => { pending = deepMerge(pending, patch); clearTimeout(t); t = setTimeout(flush, ms); };
  return { push, flush };
}

/** Configuración de widgets (config.widgets): cambia al momento y se guarda con PUT /api/widgets. */
const W = patcher('PUT', '/api/widgets');
export function patchWidgets(patch: any) {
  live.update(s => ({ config: { ...s.config, widgets: deepMerge(s.config.widgets, patch) } }));
  W.push(patch);
}

/** Configuración de preguntas, tier list y sorteo. */
const IX = patcher('PUT', '/api/interactive/config', cfg => live.update(s => ({ interactive: { ...s.interactive, config: cfg } })));
export function patchIx(section: string, patch: any) {
  live.update(s => ({ interactive: { ...s.interactive, config: { ...s.interactive.config, [section]: { ...s.interactive.config[section], ...patch } } } }));
  IX.push({ [section]: patch });
}
export const flushAll = () => Promise.all([W.flush(), IX.flush(), live.flushConfig()]);
