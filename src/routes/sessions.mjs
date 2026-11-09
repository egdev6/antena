// Rutas de sesión y cronología: estado del directo (/api/session*, /api/sessions)
// y cronología con marcas (/api/timeline*, /api/markers).
// Extracción de server.mjs (#107, corte del patrón de rutas por áreas #71).
//
// Patrón (ver cabecera de src/routes/shortcuts.mjs):
// - El módulo exporta una única función registerSessionRoutes(ctx) que registra sus
//   rutas llamando a route(method, pattern, fn) del ctx. Nada más sale por defecto.
// - ctx recibe: instancias vivas de createApp (session) y closures internas de
//   server.mjs (timelinePayload, addMarker). Los helpers puros (httpError) se
//   importan de src/http-util.mjs; NOTE_KINDS viene de src/session.mjs. Las
//   constantes solo de esta área viven aquí (límites de eventos).
// - El orden de registro importa: server.mjs llama a register en el punto exacto
//   donde estaban las rutas; los patrones son coincidencia exacta, así que reunir
//   aquí las rutas de sesión y cronología no cambia ninguna resolución.
// - Handlers con la misma convención del dispatcher: con :vars en el patrón,
//   fn(vars, body, url, req); sin vars, fn(body, null, url, req).
// - Se puede probar sin arrancar la app: construyendo un ctx falso y llamando a los
//   handlers directamente (ver test/routes-sessions.test.mjs).
import { NOTE_KINDS } from '../session.mjs';
import { httpError } from '../http-util.mjs';

// #68: tope de limit para eventos del directo; la respuesta documenta el recorte.
const EVENTS_DEFAULT_LIMIT = 500;
const EVENTS_MAX_LIMIT = 1000;

export function registerSessionRoutes({ route, session, timelinePayload, addMarker }) {
  // ---------- directo (sesión) ----------
  route('GET', '/api/session', async () => ({ ...session.data, events: undefined, eventCount: session.data.events.length, totals: session.totals(), latest: session.latest() }));
  route('GET', '/api/session/events', async (_, __, url) => {
    const pedida = Math.floor(Number(url.searchParams.get('limit')));
    const limit = Number.isFinite(pedida) && pedida > 0 ? Math.min(pedida, EVENTS_MAX_LIMIT) : EVENTS_DEFAULT_LIMIT;
    const items = session.data.events.slice(-limit);
    return { items, limit, total: session.data.events.length, capped: Number.isFinite(pedida) && pedida > limit };
  });
  route('GET', '/api/session/summary', async (_, __, url) => {
    const d = await session.get(url.searchParams.get('id')).catch(() => { throw httpError(404, 'No existe ese directo'); });
    return url.searchParams.get('format') === 'json'
      ? { ...d, totals: session.totals(d), credits: session.credits(d) }
      : { markdown: session.summaryMarkdown(d) };
  });
  route('POST', '/api/session/new', async ({ title = '' } = {}) => ({ session: await session.startNew(title) }));
  route('PUT', '/api/session', async ({ title }) => { session.data.title = String(title || ''); session.save(); return { ok: true }; });
  route('GET', '/api/sessions', async () => ({ current: { id: session.data.id, title: session.data.title, startedAt: session.data.startedAt, events: session.data.events.length,
    ...(session.data.endedAt !== undefined ? { endedAt: session.data.endedAt } : {}), ...(session.data.platforms !== undefined ? { platforms: session.data.platforms } : {}) }, past: await session.list() }));

  // ---------- cronología y marcas ----------
  route('GET', '/api/timeline', async (_, __, url) => {
    const kinds = (url.searchParams.get('kinds') || '').split(',').filter(Boolean);
    if (!kinds.length) return timelinePayload();
    const filtered = session.timeline().filter(i => kinds.includes(i.kind) || (i.kind === 'event' && kinds.includes(i.type)));
    // #68: el filtrado por kinds también respeta el tope y documenta el recorte.
    return { ...timelinePayload(), items: filtered.slice(-TIMELINE_MAX), limit: TIMELINE_MAX, capped: filtered.length > TIMELINE_MAX };
  });
  route('POST', '/api/timeline', async ({ kind = 'saved', text, user, platform, label }) => {
    if (!NOTE_KINDS.includes(kind)) throw httpError(400, `Tipo desconocido. Tipos: ${NOTE_KINDS.join(', ')}`);
    return { note: kind === 'marker' ? await addMarker(label || text) : session.addNote({ kind, text, user, platform, label }) };
  });
  route('PUT', '/api/timeline/:id', async ({ id }, body) => ({ note: session.updateNote(id, body) }));
  route('DELETE', '/api/timeline/:id', async ({ id }) => { session.removeNote(id); return { ok: true }; });
  route('POST', '/api/timeline/:id/done', async ({ id }, { value = true } = {}) => { const r = session.setThanked(id, value); return { id, done: !!(r.thanked ?? r.done) }; });
  route('POST', '/api/markers', async ({ label = '' } = {}) => ({ marker: await addMarker(label) }));
}

// #68: tope común de cronología, también al filtrar por kinds. Lo fija server.mjs al
// construir timelinePayload y este módulo lo reexporta para mantener un único valor.
export const TIMELINE_MAX = 300;
