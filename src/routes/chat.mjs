// Rutas de chat: anuncios, lectura, envío a Twitch/YouTube, simulación y conexión
// (/api/chat*). Tercer corte del patrón de rutas por áreas (#71, #107, #119).
//
// El módulo exporta una única función registerChatRoutes(ctx) que registra sus rutas
// llamando a route(method, pattern, fn) del ctx, en el mismo punto y orden donde
// estaban en server.mjs. ctx recibe: instancias vivas (store, engine, twitch, youtube,
// chat), el helper id8 y la lista CHAT_TO de destinos. httpError se
// importa de src/http-util.mjs (se acepta por ctx por compatibilidad con los tests).
import { httpError as httpErrorBase, id8 as id8Base } from '../http-util.mjs';

// escribir en Twitch, YouTube o los dos (to: twitch | youtube | both; por defecto chat.sendTo)
const CHAT_TO = ['twitch', 'youtube', 'both'];

export function registerChatRoutes({ route, store, engine, twitch, youtube, chat, id8 = id8Base, httpError = httpErrorBase }) {
  route('POST', '/api/chat/announce', async ({ text, color }) => ({ sent: await twitch.sendAnnouncement(text, color) }));

  route('GET', '/api/chat', async (_, __, url) => engine.chat.slice(-(Number(url.searchParams.get('limit')) || 50)));
  // Destino efectivo sin coerciones: «to» string manda; vacío/ausente usa chat.sendTo (o twitch).
  // false/0/array/objeto o valores fuera de la lista se rechazan sin enviar nada.
  const chatDestination = to => {
    if (to !== undefined && to !== null && typeof to !== 'string') return null;
    const requested = typeof to === 'string' ? to.trim() : '';
    if (requested) return CHAT_TO.includes(requested) ? requested : null;
    const cfg = store.config.chat.sendTo;
    if (cfg !== undefined && cfg !== null && typeof cfg !== 'string') return null;
    const fallback = (typeof cfg === 'string' ? cfg.trim() : '') || 'twitch';
    return CHAT_TO.includes(fallback) ? fallback : null;
  };
  route('POST', '/api/chat/send', async ({ text, to }) => {
    const dest = chatDestination(to);
    if (!dest) throw httpError(400, 'Destino de chat no válido. Usa twitch, youtube o both.');
    const targets = dest === 'both' ? ['twitch', 'youtube'] : [dest];
    const out = {}, errors = {};
    await Promise.all(targets.map(async t => {
      try { out[t] = await (t === 'twitch' ? twitch.sendChat(text) : youtube.sendChat(text)); }
      catch (e) { errors[t] = e.message; }
      return out[t];
    }));
    if (!Object.keys(out).length) throw httpError(400, Object.entries(errors).map(([k, v]) => `${k === 'twitch' ? 'Twitch' : 'YouTube'}: ${v}`).join(' · '));
    return { sent: out, errors, to: dest };
  });
  route('POST', '/api/chat/simulate', async ({ user = 'espectador', text = '', platform = 'twitch', mod = false, owner = false, member = false, highlighted = false }) => {
    engine.handleChat({ id: 'sim:' + id8(), platform, user, login: String(user).toLowerCase(), text, parts: [{ t: text }], mod, owner, member, highlighted: !!highlighted, at: new Date().toISOString() });
    return { ok: true };
  });
  route('POST', '/api/chat/clear', async () => { engine.clearChatUser(null); return { ok: true }; });
  route('POST', '/api/chat/join', async ({ channel }) => { await store.patchConfig({ chat: { twitchChannel: channel || '' } }); chat.join(channel || twitch.status.user); return chat.status; });
}
