// Parches acumulados que se mandan al servidor tras un rato sin cambios (widgets, interactivos…).
import { api } from './api';
import { deepMerge, live } from './live';
import { toast } from './ui';

export function patcher(method: string, url: string, after?: (d: any) => void, ms = 400) {
  let pending: any = {}, t: any = null;
  const flush = async () => {
    clearTimeout(t);
    if (!Object.keys(pending).length) return;
    const p = pending; pending = {};
    try { after?.(await api(method, url, p)); } catch (e: any) { toast(e.message, true); }
  };
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
