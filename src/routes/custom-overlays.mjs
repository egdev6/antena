// Rutas de los overlays propios (/api/custom-overlays*). Mismo patrón que el resto de
// src/routes: registerCustomOverlayRoutes(ctx) con route(method, pattern, fn); con :vars en el
// patrón, fn(vars, body, url, req); sin vars, fn(body, null, url, req).
// La validación vive en CustomOverlays (src/custom-overlays.mjs): aquí solo se resuelve el id.
// Las páginas /custom/<id> y /custom/<id>/frame no son API y las sirve server.mjs.
//
// S11 (seguridad): las acciones de un overlay solo se ejecutan si el USUARIO aprobó ese tipo de
// acción desde el panel. La aprobación (PUT …/permissions) exige `Sec-Fetch-Site: same-origin`,
// que solo manda un navegador de nuestro propio origen: el MCP, un fetch de Node o curl no
// aprueban nada. Las acciones (POST …/action) las pide la shell de confianza del overlay: el
// marco opaco no tiene acceso a la API (S5) y no puede saltarse el puente. Cada ejecución y cada
// rechazo se registra en el log, y hay un límite por overlay para que un bucle roto no inunde el
// chat o Meld (10 acciones cada 10 s; por encima, 429 y no se ejecuta nada).
import { httpError } from '../http-util.mjs';
import {
  CUSTOM_OVERLAY_ID, CUSTOM_OVERLAY_RATE, cleanActionParams, isApprovedAction, overlayTestPayload, publicOverlay,
} from '../custom-overlays.mjs';

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

/** Ventana deslizante por overlay: solo cuentan las acciones admitidas y ejecutadas. */
function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  return id => {
    const now = Date.now();
    const recent = (hits.get(id) || []).filter(t => now - t < windowMs);
    if (recent.length >= max) { hits.set(id, recent); return false; }
    recent.push(now);
    hits.set(id, recent);
    return true;
  };
}

export function registerCustomOverlayRoutes({ route, customOverlays, bus, engine, checkActions, log = () => {} }) {
  const admitAction = createRateLimiter(CUSTOM_OVERLAY_RATE);

  route('GET', '/api/custom-overlays', async () => ({ overlays: customOverlays.list().map(publicOverlay) }));
  route('POST', '/api/custom-overlays', async (body = {}) => ({ overlay: await customOverlays.create(body || {}) }));
  route('GET', '/api/custom-overlays/:id', async ({ id }) => ({ overlay: publicOverlay(customOverlays.get(customOverlayId(id))) }));
  route('PUT', '/api/custom-overlays/:id', async ({ id }, body) => ({ overlay: await customOverlays.update(customOverlayId(id), body || {}) }));
  route('DELETE', '/api/custom-overlays/:id', async ({ id }) => customOverlays.remove(customOverlayId(id)));
  // Aprobación/revoca de permisos (S11a): SOLO desde el navegador del panel. La cabecera
  // Sec-Fetch-Site la pone el navegador y no se puede falsificar desde otro origen; el MCP y los
  // fetch de Node no la mandan, así que el agente nunca aprueba lo que pide.
  route('PUT', '/api/custom-overlays/:id/permissions', async ({ id }, body = {}, _url, req) => {
    if (req?.headers?.['sec-fetch-site'] !== 'same-origin') {
      log('[overlays]', String(id).slice(0, 40), 'aprobación rechazada: no viene del panel');
      throw httpError(403, 'Los permisos de un overlay se aprueban desde el panel de antena: abre «Overlays» en el navegador y aprueba ahí. El agente solo puede pedirlos.');
    }
    const overlay = await customOverlays.approve(customOverlayId(id), body?.permissions);
    log('[overlays]', overlay.id, 'permisos aprobados:', overlay.permissions.join(', ') || 'ninguno');
    return { overlay };
  });
  // Acción pedida por la shell del overlay (S11b/S11c). La petición del marco opaco la rechaza el
  // check de origen de siempre (Origin null / Sec-Fetch-Site cross-site); esta ruta no ejecuta nada
  // que el usuario no haya aprobado y valida los parámetros con la misma validación de las acciones.
  route('POST', '/api/custom-overlays/:id/action', async ({ id }, body = {}) => {
    const overlay = customOverlays.get(customOverlayId(id));
    const action = cleanActionParams(body?.kind, body?.params);
    checkActions([action]);
    if (!isApprovedAction(overlay, action.kind)) {
      log('[overlays]', overlay.id, 'acción rechazada sin permiso:', action.kind);
      throw httpError(403, `El overlay no tiene permiso para «${action.kind}». Los permisos los aprueba el usuario desde el panel.`);
    }
    if (!admitAction(overlay.id)) {
      log('[overlays]', overlay.id, 'acción rechazada por el límite:', action.kind);
      throw httpError(429, 'Demasiadas acciones seguidas de este overlay: espera unos segundos y vuelve a probar.');
    }
    log('[overlays]', overlay.id, 'acción aprobada:', action.kind);
    // El mismo despachador del motor que usan alertas, timers y atajos: nada paralelo.
    await engine.runAction(action, {});
    return { ok: true };
  });
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
