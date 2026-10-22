// Rutas del récord de espectadores (/api/viewers*), módulo propio (#142, revisión: fuera de
// routes/teleprompter.mjs). Mismo patrón que el resto de src/routes: register<Area>Routes(ctx)
// con route(method, pattern, fn); con :vars en el patrón, fn(vars, body, url, req); sin vars,
// fn(body, null, url, req).
import { httpError as httpErrorBase } from '../http-util.mjs';
import { DEFAULT_VIEWERS, VIEWER_PLATFORMS } from '../viewers.mjs';

// Ajustes numéricos con su rango (CONFIG_SCHEMA manda en la validación final; aquí solo
// recortamos antes de persistir para que un error de schema no deje el config a medias).
const VIEWER_SETTINGS = {
  pollSec: [20, 600], minViewers: [0, 1000000], confirmPolls: [1, 10], minStep: [1, 100000], minStepPct: [0, 100], cooldownMin: [0, 240], warmupMin: [0, 120],
};

// «Mirar ahora»: como cada lectura de YouTube gasta cuota, se desfasea: dos peticiones
// seguidas comparten la misma lectura (revisión #142: debounce de ~5 s). El desfase vive en
// el cierre de ESTA app: dos instancias en el mismo proceso no comparten lectura.
const CHECK_DEBOUNCE_MS = 5000;

export function registerViewersRoutes({ route, store, viewers, httpError = httpErrorBase, now = Date.now }) {
  const V = viewers;
  let lastCheckAt = 0;
  route('GET', '/api/viewers', async () => V.snapshot());
  route('PUT', '/api/viewers/settings', async (body = {}) => {
    const current = { ...DEFAULT_VIEWERS, ...(store.config.viewers || {}) };
    const next = { ...current };
    for (const [k, rule] of Object.entries(VIEWER_SETTINGS)) {
      if (body?.[k] === undefined) continue;
      const v = Number(body[k]);
      if (!Number.isFinite(v)) throw httpError(400, `${k} tiene que ser un número`);
      next[k] = Math.round(Math.min(rule[1], Math.max(rule[0], v)));
    }
    if (body?.enabled !== undefined) next.enabled = !!body.enabled;
    if (body?.alertFirst !== undefined) next.alertFirst = !!body.alertFirst;
    await store.patchConfig({ viewers: next });   // CONFIG_SCHEMA valida y persiste
    V.refresh();
    const snap = V.snapshot();
    V.emit('change', snap);
    return snap;
  });
  route('PUT', '/api/viewers/records/:platform', async ({ platform }, { value } = {}) => {
    if (!VIEWER_PLATFORMS.includes(platform)) throw httpError(400, `Plataforma desconocida: ${platform}. Usa twitch o youtube.`);
    return V.setRecord(platform, value);
  });
  route('POST', '/api/viewers/check', async () => {
    const t = now();
    if (t - lastCheckAt < CHECK_DEBOUNCE_MS) return { fired: [], ...V.snapshot(), debounced: true };
    lastCheckAt = t;
    return { fired: await V.tick(), ...V.snapshot() };
  });
}
