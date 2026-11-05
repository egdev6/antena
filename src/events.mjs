// Contrato único de eventos SSE (#72): servidor y consumidores (React, overlay y
// widgets) deben usar solo los nombres declarados aquí. El test de contrato
// (test/events-contract.test.mjs) falla si alguien emite o escucha un evento sin
// declarar, o si un evento declarado se queda sin emisor y sin consumidor.
//
// Clasificación:
// - "replaceable": snapshot sustituible — el último valor manda. Con contrapresión se
//   coalesce (se retiene el último valor por tipo y se envía al hacer drain), y al
//   reconectar el cliente recibe un snapshot fresco de todos modos.
// - "ephemeral": no persistido y sin replay prometido (alertas, chat, control…). Los
//   que se pierden por saturación se contabilizan y se reportan en el evento `gap`.
// - Los registros críticos persistidos (p. ej. donaciones de Session) no dependen del
//   bus: viven en la persistencia de Session y se re-obtienen vía /api/state al reconectar.

// Eventos cuyo payload es siempre un snapshot sustituible del estado actual.
export const REPLACEABLE_EVENTS = new Set([
  'status', 'persistence', 'interactive', 'widgets', 'pause',
  'meld', 'timeline', 'config', 'prompter', 'timers', 'history', 'viewers', 'teleprompter', 'theme',
  'customOverlays', 'customOverlayVersions',
]);

// Eventos efímeros: sin persistencia y sin replay prometido.
export const EPHEMERAL_EVENTS = new Set([
  'alert', 'publicAlert', 'chat', 'chatDelete', 'chatClear', 'chatResult',
  'control', 'credits', 'say', 'gap',
]);

// Todos los eventos declarados: unión de ambos sets, en orden estable.
export const ALL_EVENTS = new Set([...REPLACEABLE_EVENTS, ...EPHEMERAL_EVENTS]);

// Eventos que escucha el cliente React sin llegar por el SSE del servidor (p. ej. el
// propio Live hace fire('error', …) con fallos de fetch/config). No son eventos del bus.
export const CLIENT_ONLY_EVENTS = new Set(['error']);

// Aviso una sola vez por nombre cuando el cliente escucha un evento que el contrato no
// declara (ni como SSE ni como solo-cliente). Nunca lanza: un nombre raro no puede romper
// la suscripción. Devuelve true solo la primera vez que avisa (útil para los tests).
const unknownClientEventsWarned = new Set();
export function warnUnknownClientEvent(name) {
  if (ALL_EVENTS.has(name) || CLIENT_ONLY_EVENTS.has(name)) return false;
  if (unknownClientEventsWarned.has(name)) return false;
  unknownClientEventsWarned.add(name);
  try { console.warn(`[live] evento SSE sin declarar en el contrato (src/events.mjs): ${name}`); }
  catch { /* el aviso no puede romper la suscripción */ }
  return true;
}

/** Clase de un tipo de evento: 'replaceable' | 'ephemeral' | null (sin clasificar). */
export function eventClass(name) {
  if (REPLACEABLE_EVENTS.has(name)) return 'replaceable';
  if (EPHEMERAL_EVENTS.has(name)) return 'ephemeral';
  return null;
}
