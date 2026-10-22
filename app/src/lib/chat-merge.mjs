// Fusión del chat al aplicar una instantánea del servidor (load tras abrir el SSE o tras un corte).
// Extraída de live.ts para poder probarla unitariamente desde test/.

/**
 * Une una instantánea de chat del servidor con lo que ya había en la lista local.
 * Solo se conservan, junto al snapshot, los mensajes recibidos por SSE mientras la
 * petición estaba en curso (`inflight`): lo local más antiguo que la ventana del
 * snapshot no reordena la lista y lo borrado en el servidor durante un corte no
 * reaparece (chatDelete/chatClear).
 * @param {Array<{id: string}> | undefined} prev   chat local antes de aplicar el snapshot
 * @param {Array<{id: string}> | undefined} snap   instantánea del servidor
 * @param {Set<string>} inflight ids recibidos por SSE durante la petición
 * @returns {Array<{id: string}>} snapshot seguido de los en curso que no estaban en él
 */
export function mergeChat(prev, snap, inflight) {
  const snapshot = snap || [];
  const ids = new Set(snapshot.map(m => m.id));
  // solo lo recibido por SSE durante la petición entra junto al snapshot, en orden de llegada:
  // lo local más viejo que la ventana no reordena y lo borrado en el servidor no reaparece.
  const extras = (prev || []).filter(m => inflight.has(m.id) && !ids.has(m.id));
  if (!extras.length) return snapshot;
  return [...snapshot, ...extras];
}
