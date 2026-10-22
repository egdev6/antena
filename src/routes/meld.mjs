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

export function registerMeldRoutes({ route, store, meld, scheduleLayerHide, httpError = httpErrorBase }) {
  const needMeld = () => { if (!meld.connected) throw httpError(409, 'Meld no está conectado. Actívalo en Ajustes › Avanzado › «Allow remote connections» y pulsa Conectar.'); };
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
  route('POST', '/api/meld/command', async ({ command }) => { needMeld(); await meld.command(command); return { ok: true }; });
  route('POST', '/api/meld/event', async ({ event, amount }) => { needMeld(); await meld.streamEvent(event, amount ? { amount: Number(amount) } : undefined); return { ok: true }; });
  route('POST', '/api/meld/track', async ({ track, action = 'mute', gain }) => { needMeld(); if (action === 'gain') await meld.setGain(track, gain); else await meld.toggleMute(track); return { ok: true }; });
  route('POST', '/api/meld/media', async ({ layer, command = 'play', seconds }) => { needMeld(); await meld.media(layer, command, seconds); return { ok: true }; });
  route('POST', '/api/meld/property', async ({ id, property, value }) => { needMeld(); await meld.setProperty(id, property, value); return { ok: true }; });
  route('POST', '/api/meld/call', async ({ method, args = [] }) => { needMeld(); return { result: await meld.call(method, ...args) }; });
}
