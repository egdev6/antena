// Rutas del teleprompter (/api/teleprompter*). Mismo patrón que el resto de src/routes:
// registerTeleprompterRoutes(ctx) con route(method, pattern, fn); con :vars en el patrón,
// fn(vars, body, url, req); sin vars, fn(body, null, url, req).
import { httpError } from '../http-util.mjs';

/** decodeURIComponent que responde 400 con un id mal formado (p. ej. «%zz») en vez de 500. */
function decodeId(raw) {
  try { return decodeURIComponent(raw); }
  catch { throw httpError(400, 'Id de guion no válido'); }
}

export function registerTeleprompterRoutes({ route, teleprompter }) {
  const T = teleprompter;
  route('GET', '/api/teleprompter', async () => T.snapshot());
  route('PUT', '/api/teleprompter/settings', async (body = {}) => T.settings(body));
  route('POST', '/api/teleprompter/select', async ({ id } = {}) => T.select(String(id || '')));
  route('POST', '/api/teleprompter/control', async ({ action, arg } = {}) => T.control(String(action || ''), arg));
  route('POST', '/api/teleprompter/scripts', async (body = {}) => T.createScript(body || {}));
  route('PUT', '/api/teleprompter/scripts/:id', async ({ id }, body) => T.updateScript(decodeId(id), body || {}));
  route('DELETE', '/api/teleprompter/scripts/:id', async ({ id }) => T.deleteScript(decodeId(id)));
}
