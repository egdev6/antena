// Rutas de Meld remoto: estado, conexión y control de escenas, capas, efectos,
// comandos, eventos, pistas, media y propiedades (/api/meld*). Tercer corte del
// patrón de rutas por áreas (#71, #107, #119).
//
// El módulo exporta una única función registerMeldRoutes(ctx) que registra sus rutas
// llamando a route(method, pattern, fn) del ctx, en el mismo punto y orden donde
// estaban en server.mjs. ctx recibe: instancias vivas (store, meld) y la closure
// scheduleLayerHide de createApp (ocultado diferido de capas, #119: se queda en
// server.mjs porque es la cola de tareas que vigila el apagado). Las constantes del
// área (MELD_COMMANDS, MELD_STREAM_EVENTS) vienen de src/meld.mjs; httpError de
// src/http-util.mjs (se aceptan por ctx por compatibilidad con los tests).
import { MELD_COMMANDS, MELD_STREAM_EVENTS } from '../meld.mjs';
import { httpError as httpErrorBase } from '../http-util.mjs';
import { createMeldRecording } from '../meld-recording.mjs';

// El cuerpo ya es JSON válido. Solo se cuentan claves del objeto superior, decodificando
// escapes ("\\u0061ction" también es "action"); los strings y objetos anidados no cuentan.
function repeatedAction(raw = '') {
  let depth = 0, key = false, count = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      const start = i++;
      for (; i < raw.length; i++) {
        if (raw[i] === '\\') { i++; continue; }
        if (raw[i] === '"') break;
      }
      if (depth === 1 && key) {
        if (JSON.parse(raw.slice(start, i + 1)) === 'action' && ++count > 1) return true;
        key = false;
      }
    } else if (ch === '{' || ch === '[') {
      depth++;
      if (depth === 1 && ch === '{') key = true;
    } else if (ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 1) key = true;
  }
  return false;
}

const STREAM_PENDING_MS = 20000;

export function registerMeldRoutes({ route, store, meld, scheduleLayerHide, httpError = httpErrorBase, now = () => performance.now(), recordingTimers }) {
  const recording = createMeldRecording({ meld, enabled: () => store.config.meld.recordOnStart === true, timers: recordingTimers });
  const needMeld = () => { if (!meld.connected) throw httpError(409, 'Meld no está conectado. Actívalo en Ajustes › Avanzado › «Allow remote connections» y pulsa Conectar.'); };
  // Por instancia, compartido entre todos los clientes HTTP; no se borra al desconectar.
  const pending = new Map();
  meld.on?.('status', st => {
    if (st.state !== 'conectado' || st.streamingKnown !== true) return;
    for (const action of pending.keys()) if (st.streaming === (action === 'start')) pending.delete(action);
  });
  route('GET', '/api/meld', async () => ({ status: meld.status, ...meld.session(), commands: MELD_COMMANDS, events: MELD_STREAM_EVENTS }));
  route('POST', '/api/meld/connect', async ({ url } = {}) => { await store.patchConfig({ meld: { enabled: true, ...(url ? { url } : {}) } }); meld.stop(); meld.start(store.config.meld.url); return meld.status; });
  route('POST', '/api/meld/disconnect', async () => { await store.patchConfig({ meld: { enabled: false } }); meld.stop(); return meld.status; });
  route('POST', '/api/meld/scene', async ({ scene }) => { needMeld(); const s = await meld.showScene(scene); return { scene: s.name }; });
  route('POST', '/api/meld/layer', async ({ scene, layer, visible, seconds }) => {
    needMeld();
    const vis = visible === undefined ? undefined : !!visible;
    const f = await meld.setLayer(scene, layer, vis);
    if (Number(seconds) > 0 && vis !== false) scheduleLayerHide(f.scene.id, f.layer.id, Number(seconds) * 1000);
    return { scene: f.scene.name, layer: f.layer.name };
  });
  route('POST', '/api/meld/effect', async ({ scene, layer, effect }) => { needMeld(); await meld.toggleEffect(scene, layer, effect); return { ok: true }; });
  route('POST', '/api/meld/stream', async (body, _unused, _url, req) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !['start', 'stop'].includes(body.action))
      throw httpError(400, 'Indica una acción válida: start o stop.');
    if (repeatedAction(req?.rawBody)) throw httpError(400, 'La acción no puede repetirse en el mismo JSON.');
    needMeld();
    // Un valor ausente no es una confirmación de que Meld no emite.
    const streaming = meld.status.streamingKnown ? meld.status.streaming : null;
    if (body.action === 'start' && streaming === true) throw httpError(409, 'Meld ya está emitiendo.');
    if (body.action === 'stop' && streaming === false) throw httpError(409, 'Meld no está emitiendo.');
    const current = now(), deadline = pending.get(body.action);
    if (deadline !== undefined && deadline > current) throw httpError(409, 'Ya hay una orden pendiente de confirmación de Meld.');
    // Reservar antes del primer await: dos clientes no pueden enviar la misma orden.
    // Si falla la respuesta, pudo haberse enviado; se conserva hasta confirmar o agotar el plazo.
    pending.set(body.action, current + STREAM_PENDING_MS);
    const intent = recording.begin(body.action, streaming);
    try { await recording.streamCommand(body.action === 'start' ? 'meld.startStreamingAction' : 'meld.stopStreamingAction'); }
    catch (error) { recording.streamFailed(intent); throw error; }
    return { requested: body.action, streaming };
  });
  route('POST', '/api/meld/command', async ({ command }) => { needMeld(); await meld.command(command); return { ok: true }; });
  route('POST', '/api/meld/event', async ({ event, amount }) => { needMeld(); await meld.streamEvent(event, amount ? { amount: Number(amount) } : undefined); return { ok: true }; });
  route('POST', '/api/meld/track', async ({ track, action = 'mute', gain }) => { needMeld(); if (action === 'gain') await meld.setGain(track, gain); else await meld.toggleMute(track); return { ok: true }; });
  route('POST', '/api/meld/media', async ({ layer, command = 'play', seconds }) => { needMeld(); await meld.media(layer, command, seconds); return { ok: true }; });
  route('POST', '/api/meld/property', async ({ id, property, value }) => { needMeld(); await meld.setProperty(id, property, value); return { ok: true }; });
  route('POST', '/api/meld/call', async ({ method, args = [] }) => { needMeld(); return { result: await meld.call(method, ...args) }; });
}
