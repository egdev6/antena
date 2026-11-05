// Rutas de los overlays propios (/api/custom-overlays*). Mismo patrón que el resto de
// src/routes: registerCustomOverlayRoutes(ctx) con route(method, pattern, fn); con :vars en el
// patrón, fn(vars, body, url, req); sin vars, fn(body, null, url, req).
// La validación vive en CustomOverlays (src/custom-overlays.mjs): aquí solo se resuelve el id.
// Las páginas /custom/<id> y /custom/<id>/frame no son API y las sirve server.mjs.
import { httpError } from '../http-util.mjs';
import { CUSTOM_OVERLAY_ID, overlayTestPayload } from '../custom-overlays.mjs';

/** decodeURIComponent que responde 400 con un id mal formado (p. ej. «%zz») en vez de 500. */
function decodeId(raw) {
  try { return decodeURIComponent(raw); }
  catch { throw httpError(400, 'Id de overlay no válido'); }
}

/** Id de un overlay: un id mal formado no existe, igual que uno desconocido (404). */
function customOverlayId(raw) {
  const id = decodeId(raw);
  if (!CUSTOM_OVERLAY_ID.test(id)) throw httpError(404, 'No existe ese overlay');
  return id;
}

export function registerCustomOverlayRoutes({ route, customOverlays, bus }) {
  route('GET', '/api/custom-overlays', async () => ({ overlays: customOverlays.list() }));
  route('POST', '/api/custom-overlays', async (body = {}) => ({ overlay: await customOverlays.create(body || {}) }));
  route('GET', '/api/custom-overlays/:id', async ({ id }) => ({ overlay: customOverlays.get(customOverlayId(id)) }));
  route('PUT', '/api/custom-overlays/:id', async ({ id }, body) => ({ overlay: await customOverlays.update(customOverlayId(id), body || {}) }));
  route('DELETE', '/api/custom-overlays/:id', async ({ id }) => customOverlays.remove(customOverlayId(id)));
  // Prueba de una capa (panel o MCP): un evento efímero dirigido a UNA sola capa. No pasa por el
  // motor, así que no toca la cola de alertas, el directo, los totales ni el historial; la shell
  // del overlay lo reenvía a su marco solo si el id coincide.
  route('POST', '/api/custom-overlays/:id/test', async ({ id }, body = {}) => {
    const overlay = customOverlays.get(customOverlayId(id));
    const test = { id: overlay.id, ...overlayTestPayload(body) };
    bus.send('customOverlayTest', test, ['widget']);
    return { ok: true, test };
  });
}
