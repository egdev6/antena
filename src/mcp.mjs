#!/usr/bin/env node
// Servidor MCP de antena (stdio, sin dependencias). Todo lo que hace el panel se puede hacer desde aquí.
// Habla con la API local (http://127.0.0.1:4500). Si la app no está arrancada, la arranca dentro de este proceso.
// Claude Desktop: "antena": { "command": "node", "args": ["C:\\ruta\\a\\antena\\src\\mcp.mjs"] }
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUSTOM_OVERLAY_ACTION_KINDS } from './custom-overlays.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// La versión anunciada sale de package.json (única fuente de verdad, sin duplicar el número).
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const CLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
const log = (...a) => console.error('[antena]', ...a);   // stdout es solo para el protocolo
let BASE = process.env.ANTENA_URL || '';
let embedded = null;

async function base() {
  if (BASE) return BASE;
  let port = 4500;
  try { port = JSON.parse(await readFile(path.join(process.env.ANTENA_DATA || path.join(ROOT, 'data'), 'config.json'), 'utf8')).port || 4500; } catch {}
  BASE = `http://127.0.0.1:${port}`;
  return BASE;
}

let ready = null;
function ensureServer() {
  // una sola comprobación/arranque aunque lleguen varias llamadas a la vez
  ready ||= doEnsure().catch(e => { ready = null; throw e; });
  return ready;
}
async function doEnsure() {
  const b = await base();
  try { const r = await fetch(b + '/api/status', { signal: AbortSignal.timeout(1500) }); if (r.ok) return b; } catch {}
  if (process.env.ANTENA_NO_EMBED) throw new Error(`La app no responde en ${b}. Arráncala con «pnpm start».`);
  log('la app no estaba en marcha: la arranco dentro del MCP');
  const { startServer } = await import('./server.mjs');
  embedded = await startServer({ log, quiet: true, handleSignals: !CLI });
  return b;
}

async function api(method, p, body) {
  const b = await ensureServer();
  const r = await fetch(b + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(data?.error || `${r.status} ${text.slice(0, 200)}`);
  return data;
}
const get = p => api('GET', p);
const post = (p, b = {}) => api('POST', p, b);
const put = (p, b = {}) => api('PUT', p, b);
const del = p => api('DELETE', p, {});
const enc = encodeURIComponent;

// ---------- esquemas reutilizables ----------
const S = {
  str: d => ({ type: 'string', description: d }),
  num: d => ({ type: 'number', description: d }),
  bool: d => ({ type: 'boolean', description: d }),
  obj: d => ({ type: 'object', description: d, additionalProperties: true }),
  arr: (d, items = {}) => ({ type: 'array', description: d, items }),
  enum: (d, values) => ({ type: 'string', enum: values, description: d }),
};
const TYPES = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'superchat', 'supersticker', 'member', 'milestone', 'giftmember', 'viewers', 'ytviewers'];
const tipo = S.enum('Tipo de alerta. Twitch: follow, sub, resub, giftsub, cheer (bits), raid, redemption (recompensas). YouTube: superchat, supersticker, member, milestone, giftmember. Récord de espectadores a la vez: viewers (Twitch) y ytviewers (YouTube), variables {amount} y {previous}.', TYPES);
const ALERT_HELP = `Campos de una alerta (todos opcionales):
- enabled (bool), title/text/sub (plantillas con {user} {amount} {message} {months} {tier} {reward} {input} {amountText} {level}), durationMs, minAmount
- layout: "card" (tarjeta EGDEV) | "media" (vídeo o imagen con el texto encima) | "mixed" (vídeo o imagen de fondo a pantalla completa y encima la tarjeta EGDEV; textDelayMs = retraso de la tarjeta, cardX/cardY = ajuste en px); media (archivo de media/), mediaSize %, mediaVolume %
- sound ("default" | "none" | archivo de audio), soundVolume %, durationMode ("fixed" | "media" = lo que dure el vídeo), textDelayMs
- textX/textY/textWidth (% dentro del recurso), textAlign (left|center|right), fontSize px, textColor, accentColor, animIn (pop|fade|slide|zoom|none), animOut (fade|slide|zoom|none)
- css: CSS propio de la alerta. Gana siempre a los estilos de serie (no hace falta !important). Clases: .alert (raíz, con .type-<tipo>, .alert-card o .alert-media-layout; .on mientras se ve, .out al salir), .alert-box, .alert-text, .alert-title, .alert-name, .alert-sub (y .alert-sub b), tarjeta: .card, .alert-icon, .alert-platform, .alert-timer, .alert-glow, .alert-dots, .alert-cube; vídeo: .alert-media; mixta: .alert-bg (fondo, con .alert-media dentro) y la tarjeta como .alert-card.alert-mixed. Variables de la tarjeta en .alert { }: --accent, --title-color, --name-color, --sub-color, --hl-color, --card-width, --card-radius, --card-padding, --card-bg, --border-width, --border-color, --tile-size, --icon-size, --icon-color, --title-size, --name-size, --sub-size, --font-title, --font-name, --font-sub, --tilt, --reflection. Ej.: ".alert { --accent: #00E0FF; --tilt: none; }"
- ttsEnabled, ttsTemplate, ttsMinAmount (voz)
- actions: lista de acciones al mostrarse. Cada una con "kind" y opcional "delaySec":
  scene {scene, returnAfterSec} · layer {scene, layer, seconds} (mostrar unos segundos) · hideLayer {scene, layer} · toggleLayer {scene, layer} · effect {scene, layer, effect}
  command {command: meld.recordClip…} · streamEvent {event: CONFETTIPOP_TRIGGER…, amount} · chat {text, destination} (escribe en tu chat: destination twitch|youtube|both, sin él Twitch; resultado por plataforma, y el texto que no cabe —500 Twitch, 200 YouTube— no se envía ahí) · say {text} (voz)
  Escenas y capas se indican por nombre o id de Meld.`;
const CONDITIONS = S.obj('Condiciones (todas opcionales): minAmount, maxAmount, tier (1-3), users (lista separada por comas), messageContains (palabras separadas por comas), chance (0-100 %).');

// ---------- herramientas ----------
const T = [];
const tool = (name, description, properties, call, required = []) => T.push({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, call });

// estado y configuración
tool('estado', 'Estado general: conexiones (Twitch, YouTube, chat, Meld), overlays abiertos, pausa, totales del directo actual y metadatos de recuperación de alertas retenidas (listado limitado, sin payload ni ejecución automática).', {}, async () => {
  const [st, ses] = await Promise.all([get('/api/status'), get('/api/session')]);
  return { ...st, directo: { titulo: ses.title, inicio: ses.startedAt, eventos: ses.eventCount, totales: ses.totals } };
});
tool('ver_config', 'Lee la configuración completa o un valor concreto por ruta con puntos (p. ej. «alerts.raid.title», «widgets.chat», «filters.blockedWords»).', { ruta: S.str('Ruta opcional con puntos') }, ({ ruta }) => get('/api/config' + (ruta ? '?path=' + enc(ruta) : '')));
tool('cambiar_config', 'Cambia la configuración fusionando un objeto parcial (las listas se sustituyen enteras). Sirve para cualquier ajuste: overlay, tts, filters, chat, meld, widgets, youtube, twitch…', { cambios: S.obj('Objeto parcial, p. ej. {"tts":{"rate":1.1},"filters":{"blockedWords":["spoiler"]}}') }, ({ cambios }) => put('/api/config', cambios), ['cambios']);
tool('fijar_valor', 'Fija un valor por ruta con puntos. Crea lo que falte. Ej.: ruta «alerts.follow.fontSize», valor 72; ruta «widgets.goals.0.target», valor 50.', { ruta: S.str('Ruta con puntos'), valor: { description: 'Cualquier valor JSON' } }, ({ ruta, valor }) => post('/api/config/set', { path: ruta, value: valor }), ['ruta', 'valor']);
tool('borrar_valor', 'Borra un valor de la configuración por ruta (en listas, elimina ese elemento).', { ruta: S.str('Ruta con puntos') }, ({ ruta }) => post('/api/config/set', { path: ruta }), ['ruta']);

tool('css_global', 'Lee o cambia el CSS común a TODAS las alertas (se aplica antes que el CSS de cada alerta). Sin «css», solo lo devuelve. Mismas clases y variables que el css de editar_alerta.',
  { css: S.str('CSS nuevo (sustituye al actual)') },
  async ({ css }) => (css === undefined ? (await get('/api/config?path=overlay.css')).value || '' : post('/api/config/set', { path: 'overlay.css', value: css })));

// alertas
tool('listar_alertas', 'Lista las alertas con su estado, diseño, recurso y variaciones.', {}, async () => {
  const all = await get('/api/alerts');
  return Object.entries(all).map(([type, a]) => ({ tipo: type, activa: a.enabled, diseño: a.layout, recurso: a.media || null, sonido: a.sound, titulo: a.title, texto: a.text, linea: a.sub, voz: a.ttsEnabled, acciones: a.actions?.length || 0, variaciones: (a.variations || []).map(v => ({ id: v.id, nombre: v.name, activa: v.enabled !== false, condiciones: v.conditions })) }));
});
tool('ver_alerta', 'Configuración completa de una alerta, con sus variaciones.', { tipo }, ({ tipo: t }) => get('/api/alerts/' + t), ['tipo']);
tool('editar_alerta', 'Edita una alerta. ' + ALERT_HELP, { tipo, cambios: S.obj('Campos a cambiar') }, ({ tipo: t, cambios }) => put('/api/alerts/' + t, cambios), ['tipo', 'cambios']);
tool('restaurar_alerta', 'Devuelve una alerta a sus valores por defecto (borra sus variaciones).', { tipo }, ({ tipo: t }) => post(`/api/alerts/${t}/reset`), ['tipo']);
tool('crear_variacion', 'Crea una variación de una alerta: otra versión que sale cuando se cumplen sus condiciones (la primera que encaja gana). En «cambios» van solo los campos que cambian respecto a la alerta. ' + ALERT_HELP,
  { tipo, nombre: S.str('Nombre, p. ej. «Raid grande»'), condiciones: CONDITIONS, cambios: S.obj('Campos que cambian (p. ej. otro vídeo o sonido)') },
  ({ tipo: t, nombre, condiciones, cambios }) => post(`/api/alerts/${t}/variations`, { name: nombre, conditions: condiciones, overrides: cambios }), ['tipo']);
tool('editar_variacion', 'Edita una variación (por id o nombre). En «cambios», un valor null hace que ese campo vuelva a heredarse de la alerta.',
  { tipo, variacion: S.str('Id o nombre'), nombre: S.str('Nuevo nombre'), activa: S.bool('Activar o desactivar'), condiciones: CONDITIONS, cambios: S.obj('Campos que cambian') },
  ({ tipo: t, variacion, nombre, activa, condiciones, cambios }) => put(`/api/alerts/${t}/variations/${enc(variacion)}`, { name: nombre, enabled: activa, conditions: condiciones, overrides: cambios }), ['tipo', 'variacion']);
tool('borrar_variacion', 'Borra una variación.', { tipo, variacion: S.str('Id o nombre') }, ({ tipo: t, variacion }) => del(`/api/alerts/${t}/variations/${enc(variacion)}`), ['tipo', 'variacion']);
tool('ordenar_variaciones', 'Cambia la prioridad de las variaciones (la primera que encaja es la que sale).', { tipo, ids: S.arr('Ids en el orden deseado', { type: 'string' }) }, ({ tipo: t, ids }) => post(`/api/alerts/${t}/variations-order`, { ids }), ['tipo', 'ids']);

// lanzar y controlar
tool('probar_alerta', 'Lanza una alerta de prueba (no se guarda en el directo). Se puede probar una variación o un comando concreto.',
  { tipo, variacion: S.str('Id o nombre de variación'), comando: S.str('Id o disparador de un comando de chat (en vez de tipo)'), datos: S.obj('Datos de ejemplo: user, amount, message…'), destino: S.enum('Dónde se ve', ['directo', 'vista_previa']) },
  ({ tipo: t, variacion, comando, datos, destino }) => post('/api/test', { type: t, variationId: variacion, commandId: comando, vars: datos, target: destino === 'vista_previa' ? 'preview' : 'live' }));
tool('simular_evento', 'Simula un evento real (pasa por filtros y variaciones y SE GUARDA en el directo, cuenta para objetivos y créditos).', { tipo, datos: S.obj('user, amount, message, tier…') }, ({ tipo: t, datos }) => post('/api/simulate', { type: t, vars: datos }), ['tipo']);
tool('lanzar_alerta', 'Lanza ahora una alerta libre con el diseño que quieras (por ejemplo un aviso propio en pantalla). ' + ALERT_HELP,
  { title: S.str('Antetítulo'), text: S.str('Texto grande'), sub: S.str('Línea de apoyo'), diseño: S.obj('Cualquier otro campo de alerta: layout, media, sound, durationMs, actions…') },
  ({ title, text, sub, diseño }) => post('/api/alert/custom', { title, text, sub, ...(diseño || {}) }));
tool('decir', 'Lee un texto en voz alta en el overlay.', { texto: S.str('Texto'), voz: S.str('Nombre de la voz del sistema'), velocidad: S.num('0.5–2'), tono: S.num('0–2') }, ({ texto, voz, velocidad, tono }) => post('/api/say', { text: texto, voice: voz, rate: velocidad, pitch: tono }), ['texto']);
tool('pausar_alertas', 'Pausa las alertas y los mensajes programados: las alertas se guardan en cola y no salen hasta reanudar; los mensajes programados no se envían, ni solos ni con enviar_mensaje_ahora. El chat que escribes tú (escribir_chat) sigue funcionando.', {}, () => post('/api/pause'));
tool('reanudar_alertas', 'Reanuda las alertas y saca las que estaban en cola (o las descarta). Los mensajes programados vuelven a contar su intervalo completo desde ahora: lo que venció en pausa no se recupera.', { descartar: S.bool('Descartar las acumuladas') }, ({ descartar }) => post('/api/resume', { discard: !!descartar }));
tool('saltar_alerta', 'Quita la alerta que se está viendo.', {}, () => post('/api/skip'));
tool('vaciar_cola', 'Quita la alerta actual y vacía la cola del overlay.', {}, () => post('/api/clear'));
tool('historial_alertas', 'Últimas alertas reales que han salido.', {}, () => get('/api/history'));
tool('repetir_alerta', 'Repite una alerta del historial.', { id: S.str('Id del historial') }, ({ id }) => post('/api/replay', { id }), ['id']);

// comandos de chat
const CMD_HELP = 'Campos: trigger («!engram»), enabled, permission (everyone|members|vips|mods|broadcaster), cooldownSec, userCooldownSec, platforms (["twitch","youtube"]) y cualquier campo de alerta (title, text, sub con {user} {args}, layout, media, sound, actions…; las acciones chat admiten destination twitch|youtube|both, sin él Twitch).';
tool('listar_comandos', 'Lista los comandos de chat que lanzan alertas.', {}, () => get('/api/commands'));
tool('crear_comando', 'Crea un comando de chat que lanza una alerta. ' + CMD_HELP, { comando: S.obj('Campos del comando (mínimo trigger)') }, ({ comando }) => post('/api/commands', comando), ['comando']);
tool('editar_comando', 'Edita un comando (por id o disparador). ' + CMD_HELP, { id: S.str('Id o disparador'), cambios: S.obj('Campos a cambiar') }, ({ id, cambios }) => put('/api/commands/' + enc(id), cambios), ['id', 'cambios']);
tool('borrar_comando', 'Borra un comando.', { id: S.str('Id o disparador') }, ({ id }) => del('/api/commands/' + enc(id)), ['id']);

// mensajes programados
const TIMER_HELP = 'Campos: name, enabled, message (texto del chat; variables {channel} {title} {uptime} {follows}), intervalMin (cada cuántos minutos), minChatLines (mensajes en el chat desde la última vez; 0 = da igual), announce (anuncio destacado de Twitch), announceColor (primary|blue|green|orange|purple), onlyWhenLive (solo mientras emites, según Meld; activado por defecto, y sin Meld conectado no se envía), destination (twitch|youtube|both; sin él, Twitch; los anuncios solo existen en Twitch y YouTube recibe el texto normal; si el texto no cabe —500 Twitch, 200 YouTube— no se envía ahí y la respuesta trae warnings), showAlert (además sale en pantalla) y, para esa alerta, cualquier campo de alerta (title, text, sub, layout, media, sound, actions…).';
tool('listar_mensajes', 'Mensajes programados: se publican en el chat cada X minutos. Incluye cuándo toca el siguiente y el último error.', {}, () => get('/api/timers'));
tool('crear_mensaje', 'Crea un mensaje programado. ' + TIMER_HELP, { mensaje: S.obj('Campos del mensaje (mínimo message e intervalMin)') }, ({ mensaje }) => post('/api/timers', mensaje), ['mensaje']);
tool('editar_mensaje', 'Edita un mensaje programado (por id o nombre). ' + TIMER_HELP, { id: S.str('Id o nombre'), cambios: S.obj('Campos a cambiar') }, ({ id, cambios }) => put('/api/timers/' + enc(id), cambios), ['id', 'cambios']);
tool('borrar_mensaje', 'Borra un mensaje programado.', { id: S.str('Id o nombre') }, ({ id }) => del('/api/timers/' + enc(id)), ['id']);
tool('enviar_mensaje_ahora', 'Publica ya un mensaje programado (y reinicia su cuenta atrás). Devuelve el resultado de cada plataforma en platforms (ok, error) y error si alguna falló. No se envía si la pausa está activa o si es «solo mientras emito» y Meld no está conectado (devuelve el motivo).', { id: S.str('Id o nombre') }, ({ id }) => post(`/api/timers/${enc(id)}/fire`), ['id']);
tool('anunciar_chat', 'Publica un anuncio destacado en tu chat de Twitch.', { texto: S.str('Mensaje'), color: S.enum('Color', ['primary', 'blue', 'green', 'orange', 'purple']) }, ({ texto, color }) => post('/api/chat/announce', { text: texto, color }), ['texto']);

// interactivos: preguntas, tier list y sorteo
tool('estado_interactivos', 'Estado de la cola de preguntas, las tier lists (con la votación abierta) y el sorteo, y su configuración.', {}, () => get('/api/interactive'));
tool('configurar_interactivos', 'Cambia la configuración. questions: enabled, command (!pregunta), permission, maxPerUser, minLength, maxLength, confirmInChat, confirmText, showUser, css · tierlist: acceptBare (votar escribiendo solo «S»), command (!tier), voteSeconds (0 = la cierras tú), css · giveaway: command, title, prize, permission, memberLuck (subs cuentan x veces), excludeWinners, announceInChat, openText, closeText, winnerText ({prize} {command} {count} {winner}), meldConfetti, rollSeconds, css.',
  { cambios: S.obj('{"questions":{...},"tierlist":{...},"giveaway":{...}}') }, ({ cambios }) => put('/api/interactive/config', cambios), ['cambios']);

tool('listar_preguntas', 'Cola de preguntas del chat (pendientes, en pantalla, respondidas y descartadas).', {}, async () => (await get('/api/interactive')).questions);
tool('anadir_pregunta', 'Añade una pregunta a la cola a mano.', { texto: S.str('Pregunta'), usuario: S.str('De quién (opcional)') }, ({ texto, usuario }) => post('/api/questions', { text: texto, user: usuario }), ['texto']);
tool('mostrar_pregunta', 'Pone en pantalla una pregunta (o la siguiente pendiente si no se indica). La que estaba queda como respondida.', { id: S.str('Id de la pregunta (opcional)') }, ({ id }) => post('/api/questions/show', { id }));
tool('ocultar_pregunta', 'Quita de pantalla la pregunta actual.', {}, () => post('/api/questions/hide'));
tool('marcar_pregunta', 'Cambia el estado de una pregunta.', { id: S.str('Id'), estado: S.enum('Estado', ['pending', 'answered', 'discarded']) }, ({ id, estado }) => post(`/api/questions/${enc(id)}/status`, { status: estado }), ['id', 'estado']);
tool('mover_pregunta', 'Sube o baja una pregunta en la cola.', { id: S.str('Id'), direccion: S.enum('Hacia dónde', ['arriba', 'abajo']) }, ({ id, direccion }) => post(`/api/questions/${enc(id)}/move`, { dir: direccion === 'abajo' ? 1 : -1 }), ['id', 'direccion']);
tool('vaciar_preguntas', 'Quita las respondidas y descartadas (o todas).', { todas: S.bool('Borrar también las pendientes') }, ({ todas }) => post('/api/questions/clear', { all: !!todas }));

tool('crear_tierlist', 'Crea una tier list. Por defecto con tiers S, A, B, C y D.', { titulo: S.str('Título'), elementos: S.arr('Elementos a clasificar', { type: 'string' }), tiers: S.arr('Tiers propios: [{label, color}]', { type: 'object' }) },
  ({ titulo, elementos, tiers }) => post('/api/tierlists', { title: titulo, items: elementos, tiers }), ['titulo']);
tool('editar_tierlist', 'Cambia el título o los tiers ([{id?, label, color}], en orden de mejor a peor).', { id: S.str('Id o título'), titulo: S.str('Título'), tiers: S.arr('Tiers', { type: 'object' }) },
  ({ id, titulo, tiers }) => put('/api/tierlists/' + enc(id), { title: titulo, tiers }), ['id']);
tool('borrar_tierlist', 'Borra una tier list.', { id: S.str('Id o título') }, ({ id }) => del('/api/tierlists/' + enc(id)), ['id']);
tool('anadir_elementos', 'Añade elementos a una tier list (texto o {label, image} con una imagen de media/).', { id: S.str('Id o título'), elementos: S.arr('Elementos', {}) }, ({ id, elementos }) => post(`/api/tierlists/${enc(id)}/items`, { items: elementos }), ['id', 'elementos']);
tool('editar_elemento', 'Cambia el nombre o la imagen de un elemento.', { id: S.str('Tier list'), elemento: S.str('Elemento (id o nombre)'), nombre: S.str('Nuevo nombre'), imagen: S.str('Archivo de media/') },
  ({ id, elemento, nombre, imagen }) => put(`/api/tierlists/${enc(id)}/items/${enc(elemento)}`, { label: nombre, image: imagen }), ['id', 'elemento']);
tool('quitar_elemento', 'Quita un elemento de una tier list.', { id: S.str('Tier list'), elemento: S.str('Elemento') }, ({ id, elemento }) => del(`/api/tierlists/${enc(id)}/items/${enc(elemento)}`), ['id', 'elemento']);
tool('colocar_elemento', 'Coloca un elemento en un tier (vacío = sin colocar).', { id: S.str('Tier list'), elemento: S.str('Elemento'), tier: S.str('Tier (S, A…)') }, ({ id, elemento, tier }) => post(`/api/tierlists/${enc(id)}/place`, { item: elemento, tier }), ['id', 'elemento']);
tool('reiniciar_tierlist', 'Deja todos los elementos sin colocar.', { id: S.str('Tier list') }, ({ id }) => post(`/api/tierlists/${enc(id)}/reset`), ['id']);
tool('mostrar_tierlist', 'Elige qué tier list se ve en el widget (vacío = ocultar).', { id: S.str('Tier list') }, ({ id }) => (id ? post(`/api/tierlists/${enc(id)}/show`) : post('/api/tierlists/hide')));
tool('abrir_votacion', 'Abre la votación del chat para un elemento: el chat escribe la letra del tier (S, A…) o «!tier S».', { id: S.str('Tier list'), elemento: S.str('Elemento'), segundos: S.num('Se cierra sola tras estos segundos (opcional)') },
  ({ id, elemento, segundos }) => post(`/api/tierlists/${enc(id)}/vote`, { item: elemento, seconds: segundos }), ['id', 'elemento']);
tool('cerrar_votacion', 'Cierra la votación y coloca el elemento en el tier ganador (o solo la cierra).', { aplicar: S.bool('Colocar el elemento (por defecto sí)') }, ({ aplicar }) => post('/api/vote/close', { apply: aplicar !== false }));
tool('cancelar_votacion', 'Cancela la votación sin colocar nada.', {}, () => post('/api/vote/cancel'));

tool('estado_sorteo', 'Participantes, ganadores e historial del sorteo.', {}, () => get('/api/giveaway'));
tool('abrir_sorteo', 'Abre el sorteo: el chat entra escribiendo el comando configurado.', { reiniciar: S.bool('Vaciar participantes y ganadores (por defecto sí)') }, ({ reiniciar }) => post('/api/giveaway/open', { reset: reiniciar !== false }));
tool('cerrar_sorteo', 'Cierra la inscripción del sorteo.', {}, () => post('/api/giveaway/close'));
tool('sortear', 'Elige un ganador y lo anima en el widget del sorteo; luego lo anuncia en el chat.', {}, () => post('/api/giveaway/draw'));
tool('anadir_participante', 'Añade a alguien al sorteo a mano.', { usuario: S.str('Nombre'), miembro: S.bool('Es sub o miembro') }, ({ usuario, miembro }) => post('/api/giveaway/join', { user: usuario, member: miembro }), ['usuario']);
tool('quitar_participante', 'Quita a alguien del sorteo.', { usuario: S.str('Nombre') }, ({ usuario }) => post('/api/giveaway/remove', { user: usuario }), ['usuario']);
tool('reiniciar_sorteo', 'Vacía participantes y ganadores.', {}, () => post('/api/giveaway/reset'));

// récord de espectadores a la vez (alertas viewers y ytviewers, #142)
tool('estado_espectadores', 'Espectadores a la vez ahora, pico del directo y récord histórico de Twitch y YouTube, con los ajustes anti-spam de la alerta de récord.', {}, () => get('/api/viewers'));
tool('configurar_espectadores', 'Ajustes de la alerta de récord de espectadores. enabled, pollSec (cada cuántos segundos se mira, 20–600), minViewers (no avisa por debajo), confirmPolls (lecturas seguidas por encima para que cuente), minStep y minStepPct (cuánto hay que superar lo último anunciado: el mayor de los dos), cooldownMin (espera mínima entre alertas de la misma plataforma), warmupMin (minutos sin avisar al empezar el directo), alertFirst (avisar también la primera vez que no hay récord guardado).',
  { cambios: S.obj('{"minStep":5,"cooldownMin":20}') }, ({ cambios }) => put('/api/viewers/settings', cambios), ['cambios']);
tool('fijar_record_espectadores', 'Cambia a mano el récord guardado de una plataforma (0 = empezar de cero). No lanza alerta.', { plataforma: S.enum('Plataforma', ['twitch', 'youtube']), valor: S.num('Nuevo récord') },
  ({ plataforma, valor }) => put('/api/viewers/records/' + plataforma, { value: valor }), ['plataforma', 'valor']);

// Apariencia: tema de todo lo que sale en pantalla (overlay, widgets y créditos)
tool('ver_tema', 'Tema de pantalla actual (colores, fuentes, iconos, forma, posición, animación y sonido), el de serie, los puntos de partida, las fuentes y los iconos disponibles.', {}, () => get('/api/theme'));
tool('cambiar_tema', 'Cambia el tema de todo lo que sale en pantalla (solo los campos que pases). Color: accent, accentSoft, text, textSoft, muted, surface, surfaceOpacity (0–100), surfaceStyle (gradient|solid|glass), border (vacío = del acento), borderWidth, glow (0–200 %), platformAccent + twitchColor/youtubeColor. Tipografía: fontDisplay, fontBody (id de fuente o media:archivo.woff2), textScale (%), uppercase, outline. Iconos: iconStroke (thin|normal|bold), iconColor, tileShape (square|round|none), platformBadge (text|logo|none), icons { tipo: icono|logo|none|emoji:🎉|media:archivo.png } (null vuelve al de serie). Forma: round (%), alertWidth (px), alertScale (%), tilt, reflection, decorations, timerBar. Posición: position (top|center|bottom), align (left|center|right), offsetX, offsetY. Movimiento: animation (3d|slide|fade|pop|none). Sonido: sound (default|none|archivo), soundVolume (%).',
  { cambios: S.obj('{"accent":"#00D1FF","animation":"slide","icons":{"follow":"emoji:💜"}}') }, ({ cambios }) => put('/api/theme', cambios), ['cambios']);
tool('tema_de_partida', 'Aplica un punto de partida del tema (sustituye el actual): egdev, cian, esmeralda, ambar, plataforma, sobrio, cristal.', { id: S.str('Punto de partida') }, ({ id }) => post('/api/theme/preset', { id }), ['id']);
tool('restaurar_tema', 'Vuelve al tema de serie de EGDEV.', {}, () => post('/api/theme/reset'));
tool('importar_tema', 'Sustituye el tema entero por uno exportado (JSON del tema); lo que falte vuelve al de serie.', { tema: S.obj('El objeto del tema') }, ({ tema }) => post('/api/theme/import', { theme: tema }), ['tema']);
// teleprompter (solo lo ves tú: /widget/teleprompter)
tool('estado_teleprompter', 'Guion activo, bloques, posición, velocidad y ajustes del teleprompter, y la lista de guiones.', {}, () => get('/api/teleprompter'));
tool('controlar_teleprompter', 'Maneja el teleprompter: play, pause, toggle, reset (al principio), next y prev (bloque), block (ir a un bloque: arg = id o número desde 0), seek (ir a la palabra arg, contando desde 0), faster y slower (±10 palabras/min).',
  { accion: S.enum('Acción', ['play', 'pause', 'toggle', 'reset', 'next', 'prev', 'block', 'seek', 'faster', 'slower']), arg: S.str('Para block: id del bloque o su número. Para seek: palabra a la que ir') },
  ({ accion, arg }) => post('/api/teleprompter/control', { action: accion, arg }), ['accion']);
tool('configurar_teleprompter', 'Ajustes de lectura: wpm (palabras/min, 60–300), size (tamaño del texto, 14–72), mirror (espejo), line (línea de lectura), pauseAtNotes (pararse antes de cada [nota]), countdownSec (cuenta atrás al empezar, 0–10).',
  { cambios: S.obj('{"wpm":150,"mirror":true}') }, ({ cambios }) => put('/api/teleprompter/settings', cambios), ['cambios']);
tool('crear_guion', 'Crea un guion de teleprompter y lo deja activo. Cada bloque: { title, text }. En el texto, lo que va entre [corchetes] son notas para ti: salen en amarillo y no se leen; una línea en blanco separa párrafos.',
  { titulo: S.str('Título del guion'), bloques: S.arr('Lista de bloques [{ "title": "Saludo", "text": "…" }]') }, ({ titulo, bloques }) => post('/api/teleprompter/scripts', { title: titulo, blocks: bloques }), ['titulo']);
tool('editar_guion', 'Sustituye el título y/o los bloques de un guion (los bloques se envían completos).',
  { id: S.str('Id del guion'), titulo: S.str('Título nuevo'), bloques: S.arr('Lista completa de bloques [{ "title", "text" }]') }, ({ id, titulo, bloques }) => put('/api/teleprompter/scripts/' + encodeURIComponent(id), { ...(titulo !== undefined && { title: titulo }), ...(bloques !== undefined && { blocks: bloques }) }), ['id']);
tool('elegir_guion', 'Deja activo otro guion (vuelve al principio).', { id: S.str('Id del guion') }, ({ id }) => post('/api/teleprompter/select', { id }), ['id']);
tool('borrar_guion', 'Borra un guion del teleprompter.', { id: S.str('Id del guion') }, ({ id }) => del('/api/teleprompter/scripts/' + encodeURIComponent(id)), ['id']);

// archivos
tool('listar_archivos', 'Vídeos, imágenes y sonidos disponibles para las alertas (carpeta media/).', {}, () => get('/api/media'));
tool('importar_archivo', 'Copia un archivo de media de tu PC a la carpeta media/ para usarlo en alertas. Solo admite webm, mp4, gif, png, webp, mp3, ogg o wav, y rechaza archivos de la carpeta de datos.', { ruta: S.str('Ruta completa en tu PC'), nombre: S.str('Nombre con el que guardarlo') }, ({ ruta, nombre }) => post('/api/media/import', { path: ruta, name: nombre }), ['ruta']);
tool('borrar_archivo', 'Borra un archivo de media/.', { nombre: S.str('Nombre del archivo') }, ({ nombre }) => post('/api/media/delete', { name: nombre }), ['nombre']);

// chat
tool('leer_chat', 'Últimos mensajes del chat (Twitch y YouTube), ya filtrados.', { limite: S.num('Cuántos (50 por defecto)') }, ({ limite }) => get('/api/chat?limit=' + (limite || 50)));
tool('escribir_chat', 'Escribe un mensaje en tu chat con tu cuenta: Twitch, YouTube (hace falta conectar la cuenta de YouTube y estar escuchando su chat) o los dos. Tus mensajes no salen en el chat en pantalla del directo.', { texto: S.str('Mensaje'), plataforma: S.enum('Dónde (por defecto, la de los ajustes)', ['twitch', 'youtube', 'both']) },
  ({ texto, plataforma }) => post('/api/chat/send', { text: texto, to: plataforma }), ['texto']);
tool('youtube_conectar_cuenta', 'Devuelve el enlace para dar permiso a antena a escribir en tu chat de YouTube (ábrelo en el navegador del PC).', {}, () => post('/api/youtube/auth'));
tool('youtube_desconectar_cuenta', 'Quita el permiso de tu cuenta de YouTube.', {}, () => post('/api/youtube/logout'));
tool('simular_chat', 'Simula un mensaje de chat (útil para probar comandos y el widget de chat).', { usuario: S.str('Nombre'), texto: S.str('Mensaje'), plataforma: S.enum('Plataforma', ['twitch', 'youtube']), mod: S.bool('Es moderador') }, ({ usuario, texto, plataforma, mod }) => post('/api/chat/simulate', { user: usuario, text: texto, platform: plataforma, mod }), ['texto']);
tool('unir_chat', 'Lee el chat de otro canal de Twitch (vacío = el tuyo).', { canal: S.str('Canal de Twitch') }, ({ canal }) => post('/api/chat/join', { channel: canal }));

// widgets
tool('ver_widgets', 'Configuración y datos de los widgets (chat, objetivos, últimos, ticker, créditos, espectadores) y sus URLs.', {}, async () => {
  const [w, st] = await Promise.all([get('/api/widgets'), get('/api/config?path=port')]);
  const b = `http://127.0.0.1:${st.value || 4500}`;
  return { urls: { chat: b + '/widget/chat', objetivo: b + '/widget/goal?id=<id>', ultimos: b + '/widget/latest', ticker: b + '/widget/ticker', creditos: b + '/widget/credits', espectadores: b + '/widget/viewers' }, config: w.widgets, objetivos: w.goals, totales: w.totals, ultimos: w.latest };
});
tool('editar_widget', 'Edita un widget. chat: platforms, maxMessages, fadeAfterSec, fontSize, hideCommands, showPlatform, css · latest: items (follow, sub, cheer, raid, superchat, member, any), css · ticker: label, count, speed, css · credits: title, subtitle, speed, css · viewers: platforms (twitch, youtube), showTotal, showPeak, css.',
  { widget: S.enum('Widget', ['chat', 'latest', 'ticker', 'credits', 'viewers']), cambios: S.obj('Campos a cambiar') }, ({ widget, cambios }) => put('/api/widgets', { [widget]: cambios }), ['widget', 'cambios']);
const METRIC = S.enum('Qué cuenta', ['follows', 'subs', 'bits', 'raids', 'superchats', 'members', 'events']);
const PLATAFORMA = S.enum('Plataforma', ['twitch', 'youtube']);
// #128: cada objetivo es una caja con barras por plataforma. Los tools antiguos siguen
// operando (la caja se crea con una barra); los de barra cubren las claves nuevas.
tool('crear_objetivo', 'Crea un objetivo (caja con una barra). Su widget: /widget/goal?id=<id>.', { titulo: S.str('Título'), metrica: METRIC, meta: S.num('Cifra objetivo'), plataforma: PLATAFORMA, id: S.str('Id opcional') }, ({ titulo, metrica, meta, plataforma, id }) => post('/api/goals', { title: titulo, metric: metrica, target: meta, platform: plataforma, id }), ['titulo', 'metrica', 'meta']);
tool('editar_objetivo', 'Edita un objetivo (caja: título, visible, showMetric, css).', { id: S.str('Id'), titulo: S.str('Título'), visible: S.bool('Se ve en el overlay'), showMetric: S.bool('Muestra qué cuenta'), css: S.str('CSS propio') }, ({ id, titulo, visible, showMetric, css }) => put('/api/goals/' + enc(id), { title: titulo, visible, showMetric, css }), ['id']);
tool('borrar_objetivo', 'Borra un objetivo (caja con todas sus barras).', { id: S.str('Id') }, ({ id }) => del('/api/goals/' + enc(id)), ['id']);
tool('sumar_objetivo', 'Suma (o resta) a mano a un objetivo. Si la caja tiene varias barras, indica «barra».', { id: S.str('Id'), cantidad: S.num('Cantidad (negativa para restar)'), barra: S.str('Id de la barra (cajas con varias)') }, ({ id, cantidad, barra }) => post(`/api/goals/${enc(id)}/add`, { amount: cantidad, barId: barra }), ['id', 'cantidad']);
tool('fijar_objetivo', 'Fija el valor actual de un objetivo. Si la caja tiene varias barras, indica «barra».', { id: S.str('Id'), valor: S.num('Valor'), barra: S.str('Id de la barra (cajas con varias)') }, ({ id, valor, barra }) => post(`/api/goals/${enc(id)}/set`, { value: valor, barId: barra }), ['id', 'valor']);
tool('crear_barra', 'Añade una barra a un objetivo (caja). Plataforma y métrica deben corresponderse: twitch (follows, subs, bits, raids, events) o youtube (superchats, members, events).', { id: S.str('Id del objetivo'), plataforma: PLATAFORMA, metrica: METRIC, meta: S.num('Cifra objetivo'), visible: S.bool('Se ve en el overlay') }, ({ id, plataforma, metrica, meta, visible }) => post(`/api/goals/${enc(id)}/bars`, { platform: plataforma, metric: metrica, target: meta, visible }), ['id', 'plataforma', 'metrica', 'meta']);
tool('editar_barra', 'Edita una barra de un objetivo (plataforma, métrica, meta, visible).', { id: S.str('Id del objetivo'), barra: S.str('Id de la barra'), plataforma: PLATAFORMA, metrica: METRIC, meta: S.num('Cifra objetivo'), visible: S.bool('Se ve en el overlay') }, ({ id, barra, plataforma, metrica, meta, visible }) => put(`/api/goals/${enc(id)}/bars/${enc(barra)}`, { platform: plataforma, metric: metrica, target: meta, visible }), ['id', 'barra']);
tool('borrar_barra', 'Borra una barra de un objetivo (la caja conserva las demás).', { id: S.str('Id del objetivo'), barra: S.str('Id de la barra') }, ({ id, barra }) => del(`/api/goals/${enc(id)}/bars/${enc(barra)}`), ['id', 'barra']);
tool('sumar_barra', 'Suma (o resta) a mano a una barra concreta de un objetivo.', { id: S.str('Id del objetivo'), barra: S.str('Id de la barra'), cantidad: S.num('Cantidad (negativa para restar)') }, ({ id, barra, cantidad }) => post(`/api/goals/${enc(id)}/bars/${enc(barra)}/add`, { amount: cantidad }), ['id', 'barra', 'cantidad']);
tool('fijar_barra', 'Fija el valor actual de una barra concreta de un objetivo.', { id: S.str('Id del objetivo'), barra: S.str('Id de la barra'), valor: S.num('Valor') }, ({ id, barra, valor }) => post(`/api/goals/${enc(id)}/bars/${enc(barra)}/set`, { value: valor }), ['id', 'barra', 'valor']);
tool('lanzar_creditos', 'Lanza los créditos finales en su widget.', {}, () => post('/api/credits/play'));
tool('parar_creditos', 'Para los créditos.', {}, () => post('/api/credits/stop'));

// overlays propios: páginas HTML/CSS/JS del usuario (o del agente) como capa nueva en Meld
const OVERLAY_HELP = `Cómo se escribe un overlay (con unas líneas basta):
- Corre en un iframe con sandbox (origen opaco): NO tiene la API de antena ni puede leer la del panel; los recursos externos por https sí cargan (fuentes, imágenes, animaciones).
- Fondo transparente por defecto (transparente: true): queda bien encima de la cámara o en una escena de Meld. ancho y alto son el lienzo de la capa.
- /theme.css ya está enlazado: usa sus variables CSS (var(--accent), var(--text)…) para que combine con el tema.
- Datos en vivo por el SDK (window.antena): antena.on('alert'|'chat'|'viewers'|'widgets'|'interactive'|'theme', fn), antena.state y antena.ready (espera a tener datos).
  Ej.: antena.on('alert', a => { nombre.textContent = a.text; nombre.animate([{opacity:0},{opacity:1}], 300); });
- Acciones (S11): antena.run(kind, params) devuelve una promesa: resuelve si la acción se ejecutó y se rechaza con el error del servidor si no.
  Tipos y params: scene {scene, returnAfterSec} · layer {scene?, layer, seconds?} · hideLayer/toggleLayer {scene?, layer} · effect {scene?, layer, effect} · command {command} · streamEvent {event, amount?} · chat {text, destination? twitch|youtube|both} · say {text}.
  En el código: antena.run('scene', { scene: 'Cámara' }).catch(e => console.warn(e.message));
- El agente SOLO PIDE permisos con «permisos» (al crear o editar): el usuario los aprueba (o revoca) en el panel, en la sección Overlays. Aquí no hay forma de aprobarlos y editar el código nunca cambia lo aprobado. Sin aprobación, antena.run se rechaza y no pasa nada.
- Límite por overlay: 10 acciones cada 10 s (por encima, 429 y no se ejecuta). Aprovecha una acción por evento, no bucles.
- En Meld se añade como capa de navegador con la URL /custom/<id> (la devuelven crear_overlay y ver_overlay). Al guardar, las capas abiertas se recargan solas.`;
const localBase = async () => `http://127.0.0.1:${(await get('/api/config?path=port')).value || 4500}`;
const overlayUrl = async overlay => (await localBase()) + '/custom/' + overlay.id;

tool('listar_overlays', 'Lista los overlays propios (páginas HTML/CSS/JS que se añaden como capa en Meld) con su id, nombre, tamaño, URL y permisos de acción: los que PIDE el overlay y los que el usuario ha APROBADO en el panel. No incluye el código: para eso, ver_overlay.', {}, async () => {
  const [{ overlays }, b] = await Promise.all([get('/api/custom-overlays'), localBase()]);
  return overlays.map(o => ({
    id: o.id, nombre: o.name, ancho: o.width, alto: o.height, url: b + '/custom/' + o.id,
    permisosSolicitados: o.requestedPermissions || [], permisosAprobados: o.permissions || [],
  }));
});
tool('ver_overlay', 'Un overlay propio completo: nombre, html, css, js, ancho, alto, fondo transparente, su URL para Meld (/custom/<id>) y los permisos de acción pedidos (permisosSolicitados) y aprobados por el usuario (permisosAprobados).', { id: S.str('Id del overlay') }, async ({ id }) => {
  const { overlay } = await get('/api/custom-overlays/' + enc(id));
  return { ...overlay, url: await overlayUrl(overlay), permisosSolicitados: overlay.requestedPermissions || [], permisosAprobados: overlay.permissions || [] };
}, ['id']);
const OVERLAY_PERMISOS = S.arr('Tipos de acción que el overlay PIDE (no aprueba: el usuario los aprueba en el panel y sin aprobación antena.run se rechaza): scene, layer, hideLayer, toggleLayer, effect, command, streamEvent, chat, say.', { type: 'string', enum: CUSTOM_OVERLAY_ACTION_KINDS });
tool('crear_overlay', 'Crea un overlay propio: una página HTML/CSS/JS que se añade en Meld como capa nueva. Solo hace falta el nombre; el resto tiene valores por defecto. Devuelve el id y la URL /custom/<id>. ' + OVERLAY_HELP,
  { nombre: S.str('Nombre, p. ej. «Marco de cámara»'), html: S.str('HTML del cuerpo'), css: S.str('CSS propio (se aplica después de /theme.css)'), js: S.str('JavaScript del overlay'), ancho: S.num('Ancho del lienzo en px (16–7680, por defecto 1920)'), alto: S.num('Alto del lienzo en px (16–4320, por defecto 1080)'), transparente: S.bool('Fondo transparente (por defecto sí)'), permisos: OVERLAY_PERMISOS },
  async ({ nombre, html, css, js, ancho, alto, transparente, permisos }) => {
    const { overlay } = await post('/api/custom-overlays', { name: nombre, html, css, js, width: ancho, height: alto, transparent: transparente, requestedPermissions: permisos });
    return { ...overlay, url: await overlayUrl(overlay), permisosSolicitados: overlay.requestedPermissions || [], permisosAprobados: overlay.permissions || [] };
  }, ['nombre']);
tool('editar_overlay', 'Cambia lo que pases de un overlay (actualización parcial: lo que no mandes se queda como está). Al guardar, todas las capas abiertas se recargan solas. Pedir permisos nuevos no los aprueba: eso es del panel, y las aprobaciones que el overlay deje de pedir se retiran. ' + OVERLAY_HELP,
  { id: S.str('Id del overlay'), nombre: S.str('Nombre nuevo'), html: S.str('HTML nuevo (sustituye al actual)'), css: S.str('CSS nuevo (sustituye al actual)'), js: S.str('JavaScript nuevo (sustituye al actual)'), ancho: S.num('Ancho del lienzo en px (16–7680)'), alto: S.num('Alto del lienzo en px (16–4320)'), transparente: S.bool('Fondo transparente'), permisos: OVERLAY_PERMISOS },
  async ({ id, nombre, html, css, js, ancho, alto, transparente, permisos }) => {
    const { overlay } = await put('/api/custom-overlays/' + enc(id), { name: nombre, html, css, js, width: ancho, height: alto, transparent: transparente, requestedPermissions: permisos });
    return { ...overlay, url: await overlayUrl(overlay), permisosSolicitados: overlay.requestedPermissions || [], permisosAprobados: overlay.permissions || [] };
  }, ['id']);
tool('borrar_overlay', 'Borra un overlay propio: desaparece de «Fuentes para Meld» y las capas abiertas dejan de cargar.', { id: S.str('Id del overlay') }, ({ id }) => del('/api/custom-overlays/' + enc(id)), ['id']);
tool('probar_overlay', 'Manda un evento de ejemplo AHORA a UNA capa abierta (la de Meld o la vista previa del panel), como si acabara de pasar: alert (una alerta), chat (un mensaje), viewers (espectadores) o widgets (totales, objetivos, últimos…). Sin datos usa un ejemplo realista. No toca el directo: ni alertas en cola, ni totales, ni historial.',
  { id: S.str('Id del overlay'), evento: S.enum('Qué evento de ejemplo', ['alert', 'chat', 'viewers', 'widgets']), datos: S.obj('Datos del evento (opcional: sin ellos se usa un ejemplo realista)') },
  ({ id, evento, datos }) => post(`/api/custom-overlays/${enc(id)}/test`, { event: evento, data: datos }), ['id', 'evento']);

// directo
tool('resumen_directo', 'Resumen de un directo: totales, a quién dar las gracias y cronología con el minuto de cada evento.', { id: S.str('Id del directo (vacío = el actual)'), formato: S.enum('Formato', ['markdown', 'json']) },
  async ({ id, formato }) => { const r = await get(`/api/session/summary?format=${formato === 'json' ? 'json' : 'md'}${id ? '&id=' + enc(id) : ''}`); return r.markdown ?? r; });
tool('nuevo_directo', 'Cierra el directo actual (lo archiva) y empieza uno nuevo: totales, objetivos y créditos vuelven a cero.', { titulo: S.str('Título del directo') }, ({ titulo }) => post('/api/session/new', { title: titulo }));
tool('renombrar_directo', 'Pone título al directo actual.', { titulo: S.str('Título') }, ({ titulo }) => put('/api/session', { title: titulo }), ['titulo']);
tool('listar_directos', 'Directo actual y anteriores archivados.', {}, () => get('/api/sessions'));
tool('eventos_directo', 'Eventos del directo actual.', { limite: S.num('Cuántos') }, ({ limite }) => get('/api/session/events?limit=' + (limite || 200)));
// cronología y prompter
tool('cronologia', 'Cronología del directo actual: alertas (con ✔ si ya diste las gracias) y notas (marcas de short, mensajes destacados por los espectadores, guardados, preguntas mostradas, ganadores), cada una con su segundo desde el inicio (offset).', { tipos: S.str('Filtrar por tipos separados por comas: marker, highlight, saved, question, winner, event o un tipo de alerta (raid, sub…)') },
  ({ tipos }) => get('/api/timeline' + (tipos ? '?kinds=' + enc(tipos) : '')));
tool('crear_marca', 'Marca el momento actual para un short: queda en la cronología con su minuto y, si estás emitiendo, también como marcador en Twitch.', { nombre: S.str('Qué ha pasado (opcional, se puede poner luego)') }, ({ nombre }) => post('/api/markers', { label: nombre || '' }));
tool('nota_cronologia', 'Añade una nota a la cronología (por ejemplo, guardar un mensaje del chat).', { tipo: S.enum('Tipo', ['saved', 'highlight', 'marker', 'question', 'winner']), texto: S.str('Texto'), usuario: S.str('Quién lo dijo'), plataforma: S.enum('Plataforma', ['twitch', 'youtube', 'manual']), nombre: S.str('Etiqueta') },
  ({ tipo, texto, usuario, plataforma, nombre }) => post('/api/timeline', { kind: tipo || 'saved', text: texto, user: usuario, platform: plataforma, label: nombre }));
tool('editar_nota_cronologia', 'Cambia el nombre o el texto de una nota de la cronología (p. ej. ponerle nombre a una marca de short).', { id: S.str('Id de la nota'), nombre: S.str('Etiqueta'), texto: S.str('Texto'), hecho: S.bool('Marcada como hecha') },
  ({ id, nombre, texto, hecho }) => put('/api/timeline/' + enc(id), { label: nombre, text: texto, done: hecho }), ['id']);
tool('borrar_nota_cronologia', 'Borra una nota de la cronología (las alertas no se borran).', { id: S.str('Id de la nota') }, ({ id }) => del('/api/timeline/' + enc(id)), ['id']);
tool('marcar_agradecido', 'Marca una alerta de la cronología como agradecida (o la desmarca). Sin id, marca la más antigua pendiente; para desmarcar hace falta el id.', { id: S.str('Id del evento o nota (vacío = la más antigua pendiente)'), valor: S.bool('true = agradecido (por defecto); false = desmarcar (requiere id)') },
  ({ id, valor }) => {
    if (!id && valor === false) throw new Error('Para desmarcar hace falta el id del evento: sin id solo se puede marcar la más antigua pendiente. Llama a marcar_agradecido con «id» y valor false.');
    return id ? post(`/api/timeline/${enc(id)}/done`, { value: valor !== false }) : post('/sd/agradecido');
  });
tool('prompter_pestana', 'Cambia el panel derecho de la vista del prompter: Eventos (id cronologia: cronología y destacados) o Preguntas (la cola de preguntas).', { pestana: S.enum('Pestaña (Eventos = cronologia)', ['cronologia', 'preguntas']) }, ({ pestana }) => post('/api/prompter', { tab: pestana }), ['pestana']);
// atajos personalizados y fuentes de Meld
const STEPS = S.arr('Pasos, en orden. Cada uno es {kind:"builtin", action:"marca"|"pausa"|"saltar"|"siguiente-pregunta"|"ocultar-pregunta"|"cerrar-votacion"|"abrir-sorteo"|"cerrar-sorteo"|"sortear"|"agradecido"|"prompter", arg?: pestaña del prompter (cronologia|preguntas; las retiradas tierlist y sorteo se aceptan en atajos guardados)} o una acción de Meld/chat como en las alertas: {kind:"scene", scene, returnAfterSec?} · {kind:"layer", scene, layer, seconds?} · {kind:"hideLayer"|"toggleLayer", scene, layer} · {kind:"effect", scene, layer, effect} · {kind:"command", command} · {kind:"streamEvent", event, amount?} · {kind:"chat", text, destination?: twitch|youtube|both} · {kind:"say", text}. Todos admiten delaySec.', { type: 'object', additionalProperties: true });
tool('listar_atajos', 'Atajos personalizados (botones para Stream Deck, el dock de Meld y el panel) y acciones disponibles.', {}, () => get('/api/shortcuts'));
tool('crear_atajo', 'Crea un atajo personalizado: un botón que lanza varios pasos seguidos. Para Stream Deck se llama a /sd/custom/<id>.', { nombre: S.str('Nombre del botón'), pasos: STEPS, color: S.str('Color opcional (#hex)') },
  ({ nombre, pasos, color }) => post('/api/shortcuts', { name: nombre, steps: pasos || [], color }), ['nombre', 'pasos']);
tool('editar_atajo', 'Cambia el nombre, el color o los pasos de un atajo.', { id: S.str('Id o nombre'), nombre: S.str('Nombre'), pasos: STEPS, color: S.str('Color') },
  ({ id, nombre, pasos, color }) => put('/api/shortcuts/' + enc(id), { name: nombre, steps: pasos, color }), ['id']);
tool('borrar_atajo', 'Borra un atajo personalizado.', { id: S.str('Id o nombre') }, ({ id }) => del('/api/shortcuts/' + enc(id)), ['id']);
tool('lanzar_atajo', 'Ejecuta un atajo personalizado ahora.', { id: S.str('Id o nombre') }, ({ id }) => post('/api/shortcuts/' + enc(id) + '/run'), ['id']);
tool('fuentes_meld', 'URL y tamaño de cada capa de navegador para añadir en Meld (alertas, chat, objetivos, preguntas…), y las vistas de dock y prompter.', {}, () => get('/api/sources'));

// Meld
tool('meld_estado', 'Estado de Meld y sus escenas, capas (con efectos) y pistas de audio.', {}, () => get('/api/meld'));
tool('meld_conectar', 'Conecta con Meld (Ajustes › Avanzado › «Allow remote connections»).', { url: S.str('Por defecto ws://127.0.0.1:13376') }, ({ url }) => post('/api/meld/connect', { url }));
tool('meld_desconectar', 'Desconecta de Meld.', {}, () => post('/api/meld/disconnect'));
tool('meld_escena', 'Cambia a una escena (por nombre o id).', { escena: S.str('Escena') }, ({ escena }) => post('/api/meld/scene', { scene: escena }), ['escena']);
tool('meld_capa', 'Muestra, oculta o alterna una capa. Con «segundos», la muestra ese tiempo y la vuelve a ocultar.', { escena: S.str('Escena (opcional si el nombre de capa es único)'), capa: S.str('Capa'), visible: S.bool('true mostrar, false ocultar; sin indicar, alterna'), segundos: S.num('Mostrar durante') },
  ({ escena, capa, visible, segundos }) => post('/api/meld/layer', { scene: escena, layer: capa, visible, seconds: segundos }), ['capa']);
tool('meld_efecto', 'Activa o desactiva un efecto de una capa.', { escena: S.str('Escena'), capa: S.str('Capa'), efecto: S.str('Efecto') }, ({ escena, capa, efecto }) => post('/api/meld/effect', { scene: escena, layer: capa, effect: efecto }), ['capa', 'efecto']);
tool('meld_comando', 'Lanza un comando de Meld.', { comando: S.enum('Comando', ['meld.screenshot', 'meld.screenshot.vertical', 'meld.startStreamingAction', 'meld.stopStreamingAction', 'meld.toggleStreamingAction', 'meld.startRecordingAction', 'meld.stopRecordingAction', 'meld.toggleRecordingAction', 'meld.toggleVirtualCameraAction', 'meld.recordClip', 'meld.replay.show', 'meld.replay.dismiss']) }, ({ comando }) => post('/api/meld/command', { command: comando }), ['comando']);
tool('meld_evento', 'Dispara un evento de los widgets de Meld (confeti, ruleta, contador, cronómetros…).', { evento: S.enum('Evento', ['CONFETTIFALL_TRIGGER', 'CONFETTIPOP_TRIGGER', 'WHEELSPIN_SPIN', 'COUNTER_INCREMENT', 'COUNTER_DECREMENT', 'STOPWATCH_RESET', 'STOPWATCH_PAUSE', 'STOPWATCH_RESUME', 'COUNTDOWN_RESET', 'COUNTDOWN_PAUSE', 'COUNTDOWN_RESUME', 'SUBATHONTIMER_RESET', 'SUBATHONTIMER_PAUSE', 'SUBATHONTIMER_RESUME', 'SUBATHONTIMER_ADDTIME']), cantidad: S.num('Para SUBATHONTIMER_ADDTIME') },
  ({ evento, cantidad }) => post('/api/meld/event', { event: evento, amount: cantidad }), ['evento']);
tool('meld_audio', 'Silencia o fija el volumen de una pista de audio de Meld.', { pista: S.str('Pista (nombre o id)'), accion: S.enum('Acción', ['mute', 'gain']), ganancia: S.num('0–1 para «gain»') }, ({ pista, accion, ganancia }) => post('/api/meld/track', { track: pista, action: accion, gain: ganancia }), ['pista']);
tool('meld_media', 'Controla una capa de vídeo de Meld.', { capa: S.str('Capa'), accion: S.enum('Acción', ['play', 'pause', 'seekTo']), segundos: S.num('Para seekTo') }, ({ capa, accion, segundos }) => post('/api/meld/media', { layer: capa, command: accion, seconds: segundos }), ['capa', 'accion']);
tool('meld_propiedad', 'Cambia una propiedad de un objeto de Meld (API v2: x, y, width, height, rotation, visible, name…).', { id: S.str('Id del objeto'), propiedad: S.str('Propiedad'), valor: { description: 'Valor' } }, ({ id, propiedad, valor }) => post('/api/meld/property', { id, property: propiedad, value: valor }), ['id', 'propiedad', 'valor']);
tool('meld_llamar', 'Llama a cualquier método de la API de Meld (para lo que no tenga herramienta propia).', { metodo: S.str('Método (showScene, toggleLayer, setStagedScene, showStagedScene, toggleRecord, toggleStream…)'), args: S.arr('Argumentos') }, ({ metodo, args }) => post('/api/meld/call', { method: metodo, args: args || [] }), ['metodo']);
tool('ejecutar_acciones', 'Ejecuta ahora una lista de acciones (las mismas que puede llevar una alerta).', { acciones: S.arr('Acciones', { type: 'object' }), datos: S.obj('Variables para las plantillas') }, ({ acciones, datos }) => post('/api/actions/run', { actions: acciones, vars: datos }), ['acciones']);

// conexiones y acceso
tool('twitch_conectar', 'Inicia el login de Twitch: devuelve el código y la web donde introducirlo.', {}, () => post('/api/twitch/connect'));
tool('twitch_desconectar', 'Cierra la sesión de Twitch.', {}, () => post('/api/twitch/disconnect'));
tool('youtube_escuchar', 'Empieza a leer el chat del directo de YouTube (alertas y chat).', { video: S.str('Enlace o id del directo (vacío = búscalo en el canal)') }, ({ video }) => post('/api/youtube/start', { video }));
tool('youtube_parar', 'Deja de leer YouTube.', {}, () => post('/api/youtube/stop'));
tool('acceso_movil', 'Activa o desactiva el panel desde el móvil (red local) y devuelve el enlace con la clave.', { activar: S.bool('Activar'), nueva_clave: S.bool('Generar otra clave') }, ({ activar, nueva_clave }) => post('/api/access', { lan: activar, regenerate: nueva_clave }));

// ---------- protocolo MCP (JSON-RPC 2.0 por stdio, un mensaje por línea) ----------
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const pv = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: pv, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'antena', version: VERSION },
      instructions: 'Control total de las alertas de directo de EGDEV para Meld Studio: alertas y variaciones, comandos de chat, mensajes programados, cola de preguntas, tier lists, sorteos, widgets, objetivos, voz, filtros, Meld (escenas, capas, eventos), chat, resumen del directo y archivos. Usa ver_config/cambiar_config/fijar_valor para cualquier ajuste que no tenga herramienta propia.',
    } });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: T.map(({ call, ...t }) => t) } });
  if (method === 'tools/call') {
    const t = T.find(x => x.name === params?.name);
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Herramienta desconocida: ${params?.name}` } });
    try {
      const out = await t.call(params.arguments || {});
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Método no soportado: ${method}` } });
}

export const TOOLS = T;

if (CLI) {
  const rl = createInterface({ input: process.stdin });
  const pending = new Set();
  let closing = false, handlerFailed = false;
  // El CLI posee las señales incluso mientras espera el arranque de su app.
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  rl.on('line', line => {
    if (closing || !line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } }); }
    const work = handle(msg).catch(e => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
    pending.add(work);
    // Atender ambos resultados evita promesas derivadas rechazadas sin consumidor.
    work.then(() => pending.delete(work), () => { handlerFailed = true; pending.delete(work); });
  });
  rl.on('close', shutdown);
  function shutdown() {
    if (closing) return;
    closing = true;
    // Plazo TOTAL desde primera señal o EOF; herramientas/arranque no reciben otros cinco segundos.
    const deadline = setTimeout(() => {
      try { log('[parada] drenado MCP agotado'); } catch { /* el aviso no impide terminar */ }
      process.exit(1);
    }, 5000);
    const accepted = [...pending];
    const finish = code => { clearTimeout(deadline); process.exit(code); };
    (async () => {
      await Promise.allSettled(accepted);
      // Una solicitud precorte puede haber creado la app DESPUÉS del corte. No cortar su causalidad.
      const code = embedded ? await embedded.close() : 0;
      // La barrera termina después de las respuestas ya encoladas, sin cerrar stdout prematuramente.
      await new Promise((resolve, reject) => process.stdout.write('', error => error ? reject(error) : resolve()));
      finish(handlerFailed ? 1 : code);
    })().catch(() => finish(1));
  }
}
