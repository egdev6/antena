// Esquema de la configuración (#106 y #118), sin dependencias de la app. Describe tipos, rangos
// y valores permitidos de las hojas de DEFAULT_CONFIG (src/store.mjs), incluidas las secciones
// estructurales (alerts, commands, timers, shortcuts, interactive, filters) desde #118.
// Política de claves desconocidas: se ACEPTAN tal cual (llegan antes que su default,
// p. ej. prompter.monitor de #61); solo se avisan una vez por ruta en el registro.
// El 400 queda para tipos, rangos y enums inválidos de campos conocidos.
// Fuentes de los enums y rangos (contrato del motor, no del slider de la UI):
// - TIMER_DESTINATIONS y ANNOUNCE_COLORS: src/timers.mjs (exportadas).
// - Permisos: los que entiende canUse (src/commands.mjs:16-22); mismo enum documentado en el MCP (src/mcp.mjs, CMD_HELP).
// - Kinds de acción: los despachados por Engine.#execAction (src/engine.mjs:499) y los pasos
//   de atajo de src/routes/shortcuts.mjs:30 (SHORTCUT_ENGINE_KINDS); ninguna de las dos listas
//   está exportada, así que se replican aquí citando la línea.
// Rangos: solo mínimos con significado real; el motor recorta intervalMin con Math.max(1, …)
// (src/timers.mjs:158), así que el mínimo 1 es su contrato. Los topes de los sliders de la UI
// no son contrato: fontSize, mediaSize, textWidth, minLength, maxPerUser, memberLuck o
// rollSeconds aceptan cualquier valor por encima del mínimo.
import { isDeepStrictEqual } from 'node:util';
import { TIMER_DESTINATIONS, ANNOUNCE_COLORS, DEFAULT_TIMER } from './timers.mjs';
import { DEFAULT_ALERTS, DEFAULT_COMMAND } from './alerts.mjs';
import { PLATFORM_METRICS } from './goals.mjs';
import { TELEPROMPTER_SCRIPTS_MAX_BYTES } from './teleprompter.mjs';
import { CUSTOM_OVERLAYS_MAX_ITEMS, CUSTOM_OVERLAYS_MAX_BYTES, CUSTOM_OVERLAY_ACTION_KINDS } from './custom-overlays.mjs';
import { THEME_RULES, THEME_RANGES, themeFieldError, themeIconError, keepValidIcons } from './theme.mjs';
// #130: animaciones de los mensajes del chat en pantalla, las mismas para entrar y para salir;
// fuente única compartida con el widget y el panel.
import { CHAT_ANIMS } from '../public/widgets/chat-anims.js';

// ---------- constructores de nodos ----------
const num = o => ({ kind: 'num', ...o });
const str = { kind: 'str' };
const bool = { kind: 'bool' };
const en = values => ({ kind: 'enum', values });
const arrStr = values => ({ kind: 'arrStr', values });
const list = (item, o = {}) => ({ kind: 'list', item, ...o });   // lista de objetos con esquema por elemento

// Objetivos por plataforma (#128): cada objetivo es una caja con barras. La métrica válida
// de una barra depende de su plataforma (src/goals.mjs); la comprobación cruzada va en el
// kind «goalBar» de checkNode porque el resto del esquema valida hojas de forma aislada.
const GOAL_METRICS = ['follows', 'subs', 'bits', 'raids', 'subscribers', 'superchats', 'members', 'events'];
// kind «crossBar»: esquema de barra con comprobación cruzada plataforma↔métrica; el resto
// del esquema valida hojas de forma aislada, así que la dependencia va aparte (checkNode).
const GOAL_BAR = { kind: 'crossBar', fields: {
  id: str, platform: en(Object.keys(PLATFORM_METRICS)), metric: en(GOAL_METRICS),
  target: num({ int: true, min: 1, max: 1000000 }), visible: bool,
} };
/** Esquema de los elementos de una lista: soporta nodos «crossBar» (usar sus fields). */
const itemSchemaOf = node => (node?.item && node.item.kind === 'crossBar' ? node.item.fields : node?.item);
/** Comprobación cruzada de una barra: la métrica debe ser contable en su plataforma. */
function crossCheckBar(value, path, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  if (value.platform === undefined || value.metric === undefined) return;   // lo cubre el enum del campo
  const validas = PLATFORM_METRICS[value.platform];
  if (validas && !validas.includes(value.metric)) errors.push({ path, message: `${path}: la métrica «${value.metric}» no se cuenta en ${value.platform} (válidas: ${validas.join(', ')})` });
}
const GOAL_BOX = {
  id: str, title: str, visible: bool, showMetric: bool, css: str,
  label: str, showLabel: bool, showTitle: bool,   // cabecera (O1.3): ausentes = «Objetivo» y ambos visibles
  bars: list(GOAL_BAR),
};
// Chat predeterminado y variantes comparten exactamente las mismas reglas por campo.
const CHAT_FIELDS = {
  platforms: arrStr(['twitch', 'youtube']),
  maxMessages: num({ int: true, min: 1, max: 200 }),
  fadeAfterSec: num({ min: 0, max: 600 }),
  fontSize: num({ min: 8, max: 80 }),
  hideCommands: bool, hideOwner: bool, showPlatform: bool, reverse: bool,
  animIn: en(CHAT_ANIMS), animOut: en(CHAT_ANIMS),
  layout: en(['vertical', 'horizontal']), css: str,
};
const CHAT_VARIANTS = list({ id: str, name: str, ...CHAT_FIELDS });

/** Mismo slug y reserva para CRUD y escrituras genéricas. */
export function chatVariantId(name, variants) {
  const slug = name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'variante';
  const used = new Set(['default', ...variants.map(v => v?.id)]);
  let id = slug;
  for (let n = 2; used.has(id); n++) id = `${slug}-${n}`;
  return id;
}

// ---------- enums compartidos (fuentes citadas arriba) ----------
const PERMISOS = ['everyone', 'members', 'vips', 'mods', 'broadcaster'];   // canUse (src/commands.mjs:16)
// Kind de acción del motor: la lista vive en src/custom-overlays.mjs (CUSTOM_OVERLAY_ACTION_KINDS),
// compartida con los permisos de los overlays (S11) y el enum del MCP; es la de Engine.#execAction.
const ACCION_KINDS = CUSTOM_OVERLAY_ACTION_KINDS;
const PASO_KINDS = ['builtin', ...ACCION_KINDS];   // cleanSteps de src/routes/shortcuts.mjs (builtin + SHORTCUT_ENGINE_KINDS, línea 30)

// ---------- hojas de alerta (ALERT_FIELDS, src/alerts.mjs) ----------
// Campos de acción de Meld/chat/voz; los que dependen de Meld (scene, layer, effect…) quedan
// sin validar salvo el tipo: la referencia válida la comprueba el motor en vivo.
const accionItem = {
  // kind es un discriminador con efecto en vivo: un kind desconocido se CONSERVA al cargar
  // (con aviso) para que el motor siga fallando con «Acción desconocida» (src/engine.mjs:520)
  // en vez de convertir la acción en otra cosa válida (p. ej. scene cambiaría de escena).
  kind: { ...en(ACCION_KINDS), keepInvalid: true }, destination: en(TIMER_DESTINATIONS),
  text: str, scene: str, layer: str, effect: str, command: str, event: str,
  amount: num({ min: 0 }), returnAfterSec: num({ min: 0 }), seconds: num({ min: 0 }), delaySec: num({ min: 0 }),
};
const condiciones = {
  minAmount: str, maxAmount: str, tier: str, users: str, messageContains: str,   // DEFAULT_CONDITIONS: strings ('' = sin condición)
  chance: num({ min: 0 }),
};
const hojasAlerta = {
  enabled: bool, title: str, text: str, sub: str,
  durationMs: num({ min: 0 }), minAmount: num({ min: 0 }),
  layout: en(['card', 'media', 'mixed']), cardX: num({ min: -1920, max: 1920 }), cardY: num({ min: -1080, max: 1080 }), media: str, mediaSize: num({ min: 0 }), mediaVolume: num({ min: 0, max: 100 }),
  sound: str, soundVolume: num({ min: 0, max: 100 }), durationMode: en(['fixed', 'media']), textDelayMs: num({ min: 0 }),
  textX: num({ min: 0, max: 100 }), textY: num({ min: 0, max: 100 }), textWidth: num({ min: 0 }),   // textX/Y: porcentajes reales
  textAlign: en(['left', 'center', 'right']), fontSize: num({ min: 0 }),
  textColor: str, accentColor: str,
  animIn: en(['pop', 'fade', 'slide', 'zoom', 'none']), animOut: en(['fade', 'slide', 'zoom', 'none']),
  css: str, ttsEnabled: bool, ttsTemplate: str, ttsMinAmount: num({ min: 0 }),
  actions: list(accionItem),
};
const variacionItem = {
  id: str, name: str, enabled: bool, conditions: condiciones,
  ...hojasAlerta,
};
// Las alertas conocidas: hojas de alerta más sus variaciones (que a su vez llevan hojas y acciones).
const alertaItem = { ...hojasAlerta, variations: list(variacionItem) };
const comandoItem = {
  id: str, trigger: str, outputMode: en(['alert', 'chat']), chatReply: str,
  permission: en(PERMISOS), cooldownSec: num({ int: true, min: 0 }), userCooldownSec: num({ int: true, min: 0 }),
  platforms: arrStr(['twitch', 'youtube']),
  ...hojasAlerta,
};
const timerItem = {
  id: str, name: str, enabled: bool, message: str,
  intervalMin: num({ int: true, min: 1 }),   // el motor fuerza Math.max(1, …) (src/timers.mjs:158)
  minChatLines: num({ int: true, min: 0 }), announce: bool, announceColor: en(ANNOUNCE_COLORS),
  onlyWhenLive: bool, showAlert: bool, destination: en(TIMER_DESTINATIONS),
  ...hojasAlerta,
};
// Defaults por hoja de los elementos de lista (para el saneo al cargar: la hoja inválida de un
// elemento vuelve a su default sin borrar el elemento). Salen de DEFAULT_COMMAND (src/alerts.mjs)
// y DEFAULT_TIMER (src/timers.mjs), que comparten las hojas de alerta.
const conDefaults = (item, defaults) => Object.fromEntries(Object.entries(item).map(([k, n]) =>
  (n && n.kind !== undefined && defaults[k] !== undefined) ? [k, { ...n, def: structuredClone(defaults[k]) }] : [k, n]));
const COMANDO_ITEM = conDefaults(comandoItem, DEFAULT_COMMAND);
const TIMER_ITEM = conDefaults(timerItem, DEFAULT_TIMER);
// El kind de paso también es discriminador: lo ejecuta runShortcut por kind (src/routes/shortcuts.mjs).
const pasoItem = { kind: { ...en(PASO_KINDS), keepInvalid: true }, action: str, arg: str };   // action/arg concretos: los valida cleanSteps en vivo (SD, PROMPTER_TABS)
const atajoItem = { id: str, name: str, enabled: bool, steps: list(pasoItem, { maxItems: 20 }) };   // tope de cleanSteps: 20 pasos

// Defaults genéricos por kind, para hojas de lista sin plantilla (variaciones, pasos de atajo).
const defaultGenerico = node => {
  switch (node.kind) {
    case 'enum': return node.values[0];
    case 'bool': return false;
    case 'num': return node.def !== undefined ? node.def : (node.min !== undefined ? node.min : 0);
    case 'arrStr': return [];
    default: return '';
  }
};

// Apariencia (#151): las reglas viven en src/theme.mjs (THEME_RULES y themeFieldError) y aquí solo
// se envuelven, para que PUT /api/config, POST /api/config/set y la carga de config.json validen
// exactamente igual que cleanTheme. Los iconos se sanean entrada a entrada al cargar.
const THEME_SCHEMA = Object.fromEntries(Object.keys(THEME_RULES).map(k => [k, {
  kind: 'theme', key: k,
  ...(THEME_RANGES[k] ? { min: THEME_RANGES[k][0], max: THEME_RANGES[k][1] } : {}),
  ...(k === 'icons' ? { repair: keepValidIcons } : {}),
}]));

export const CONFIG_SCHEMA = {
  port: num({ int: true, min: 1, max: 65535 }),
  paused: bool,
  twitch: { clientId: str },
  youtube: {
    apiKey: str, channelId: str, video: str,
    pollSeconds: num({ int: true, min: 5, max: 60 }),   // la UI ya acota 5–60
    subscriberPollSeconds: num({ int: true, min: 0 }),  // 0 disables; positive values clamp to 60 s
    clientId: str, clientSecret: str, apiKeySet: bool, clientSecretSet: bool,
  },
  chat: { twitchChannel: str, sendTo: en(['twitch', 'youtube', 'both']) },
  overlay: {
    volume: num({ min: 0, max: 1 }),
    gapMs: num({ int: true, min: 0, max: 10000 }),
    css: str,
    queueMax: num({ int: true, min: 0, max: 500 }),     // 0 = sin tope (#66)
  },
  tts: {
    enabled: bool, voice: str,
    rate: num({ min: 0.5, max: 2 }),                    // slider de la UI: 0.5–2
    pitch: num({ min: 0, max: 2 }),
    volume: num({ min: 0, max: 1 }),
    maxChars: num({ int: true, min: 20, max: 2000 }),   // la UI ya acota desde 20
  },
  meld: { enabled: bool, url: str, autoSession: bool },
  panel: { onboardingDone: bool },   // bienvenida del panel vista (relanzable desde General)
  access: { lan: bool, key: str },
  sessions: { retention: num({ int: true, min: 0, max: 1000 }) },
  alerts: Object.fromEntries(Object.keys(DEFAULT_ALERTS).map(k => [k, alertaItem])),   // #118: known alerts; new keys are accepted with a warning
  commands: list(COMANDO_ITEM),
  timers: list(TIMER_ITEM),
  interactive: {
    questions: {
      enabled: bool, command: str, permission: en(PERMISOS),
      maxPerUser: num({ int: true, min: 1 }), minLength: num({ int: true, min: 0 }), maxLength: num({ int: true, min: 0 }),
      confirmInChat: bool, confirmText: str, showUser: bool, css: str,
    },
    tierlist: { acceptBare: bool, command: str, voteSeconds: num({ int: true, min: 0 }), css: str },   // 0 = la cierras tú
    giveaway: {
      command: str, title: str, prize: str, permission: en(PERMISOS),
      memberLuck: num({ int: true, min: 1 }), excludeWinners: bool, announceInChat: bool,
      openText: str, closeText: str, winnerText: str,
      meldConfetti: bool, rollSeconds: num({ int: true, min: 1 }), css: str,
    },
  },
  filters: {
    enabled: bool, blockedWords: arrStr(), blockedUsers: arrStr(),   // listas de textos libres, sin enum
    replaceWith: str, blockLinks: bool, maxMessageLength: num({ int: true, min: 0 }),
  },
  shortcuts: list(atajoItem),
  // Overlays propios (src/custom-overlays.mjs): HTML/CSS/JS libre del usuario o del agente. Los
  // topes son los de CustomOverlays (CUSTOM_OVERLAYS_MAX_*) para que todo camino de escritura valide igual.
  customOverlays: list({
    id: str, name: str, html: str, css: str, js: str,
    width: num({ int: true, min: 16, max: 7680 }), height: num({ int: true, min: 16, max: 4320 }),
    transparent: bool, updatedAt: num({ min: 0 }),
    // S11: lo pedido por el agente y lo aprobado por el usuario. Las escrituras genéricas
    // (PUT /api/config, /api/config/set, cambiar_config) validan los tipos pero NUNCA cambian
    // `permissions`: CustomOverlays.replaceAll conserva las aprobaciones guardadas de ese id.
    requestedPermissions: arrStr(CUSTOM_OVERLAY_ACTION_KINDS), permissions: arrStr(CUSTOM_OVERLAY_ACTION_KINDS),
    approvedAt: num({ min: 0 }), approvedUpdatedAt: num({ min: 0 }),
  }, { maxItems: CUSTOM_OVERLAYS_MAX_ITEMS, maxBytes: CUSTOM_OVERLAYS_MAX_BYTES }),
  viewers: {
    enabled: bool, alertFirst: bool,
    pollSec: num({ int: true, min: 20, max: 600 }),
    minViewers: num({ int: true, min: 0 }), confirmPolls: num({ int: true, min: 1, max: 10 }),
    minStep: num({ int: true, min: 1 }), minStepPct: num({ min: 0, max: 100 }),
    cooldownMin: num({ min: 0, max: 240 }), warmupMin: num({ min: 0, max: 120 }),
    records: { twitch: num({ int: true, min: 0 }), youtube: num({ int: true, min: 0 }) },
  },
  theme: THEME_SCHEMA,   // Apariencia (src/theme.mjs): reglas compartidas con cleanTheme
  teleprompter: {
    activeId: str,
    wpm: num({ int: true, min: 60, max: 300 }), size: num({ min: 14, max: 72 }),
    mirror: bool, line: bool, pauseAtNotes: bool, countdownSec: num({ int: true, min: 0, max: 10 }), monitor: str,
    // Tope de tamaño total de los guiones (TELEPROMPTER_SCRIPTS_MAX_BYTES, src/teleprompter.mjs): por debajo
    // del límite de cuerpo de 2e6 bytes de readBody (src/server.mjs), así un PUT nunca truena por tamaño.
    scripts: list({ id: str, title: str, blocks: list({ id: str, title: str, text: str }) }, { maxItems: 50, maxBytes: TELEPROMPTER_SCRIPTS_MAX_BYTES }),
  },
  prompter: {
    fontSize: num({ min: 10, max: 40 }),                // slider de la UI: 16–32
    mirror: bool, hideCommands: bool, autoSwitch: bool,
    chatLines: num({ int: true, min: 10, max: 200 }),   // la UI ya acota 20–200
    micTrack: str, css: str,
  },
  widgets: {
    chat: CHAT_FIELDS,
    chatVariants: CHAT_VARIANTS,
    goals: list(GOAL_BOX),
    latest: { items: arrStr(['follow', 'sub', 'cheer', 'superchat']), css: str },
    ticker: { label: str, count: num({ int: true, min: 1, max: 100 }), speed: num({ int: true, min: 10, max: 500 }), css: str },
    credits: { title: str, subtitle: str, speed: num({ int: true, min: 10, max: 500 }), css: str },
    viewers: { platforms: arrStr(['twitch', 'youtube']), showTotal: bool, showPeak: bool, css: str },
  },
};

// ---------- validación ----------
const TIPO = { num: 'un número', str: 'un texto', bool: 'true o false', enum: 'uno de los valores permitidos', arrStr: 'una lista de textos' };

function checkNode(node, value, path, errors) {
  // Solo la lista nueva exige elementos completos y no acepta null. Los demás nodos
  // conservan su política histórica de parches parciales y valores ausentes.
  if (node === CHAT_VARIANTS && value !== undefined) {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `${path}: se esperaba una lista de variantes` });
      return;
    }
    const ids = new Set();
    for (const [i, item] of value.entries()) {
      const itemPath = `${path}.${i}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push({ path: itemPath, message: `${itemPath}: se esperaba un objeto de variante` });
        continue;
      }
      for (const field of Object.keys(CHAT_VARIANTS.item)) {
        if (item[field] == null) errors.push({ path: `${itemPath}.${field}`, message: `${itemPath}.${field}: campo obligatorio de la variante` });
      }
      if (typeof item.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || item.id === 'default') {
        errors.push({ path: `${itemPath}.id`, message: `${itemPath}.id: id de variante no válido o reservado (default)` });
      } else if (ids.has(item.id)) {
        errors.push({ path: `${itemPath}.id`, message: `${itemPath}.id: id de variante repetido` });
      } else ids.add(item.id);
      if (typeof item.name !== 'string' || !item.name.trim() || item.name !== item.name.trim() || item.name.length > 60) {
        errors.push({ path: `${itemPath}.name`, message: `${itemPath}.name: nombre obligatorio, sin espacios exteriores y de hasta 60 caracteres` });
      }
      checkObject(CHAT_VARIANTS.item, item, itemPath, errors);
    }
    return;
  }
  if (value === undefined || value === null) return;   // ausente no es inválido: queda el default
  // objeto anidado sin kind (sección con esquema propio)
  if (node && node.kind === undefined && typeof node === 'object') {
    checkObject(node, value, path, errors);
    return;
  }
  const fail = motivo => errors.push({ path, message: `${path}: ${motivo}` });
  if (node.kind === 'crossBar') {
    checkObject(node.fields, value, path, errors);   // campos aislados: tipos y rangos
    crossCheckBar(value, path, errors);              // comprobación cruzada plataforma↔métrica
    return;
  }
  switch (node.kind) {
    case 'num':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`se esperaba ${TIPO.num}`);
      if (node.int && !Number.isInteger(value)) return fail('se esperaba un número entero');
      if (node.min !== undefined && value < node.min) return fail(`el valor mínimo es ${node.min}`);
      if (node.max !== undefined && value > node.max) return fail(`el valor máximo es ${node.max}`);
      return;
    case 'str':
      if (typeof value !== 'string') return fail(`se esperaba ${TIPO.str}`);
      return;
    case 'bool':
      if (typeof value !== 'boolean') return fail(`se esperaba ${TIPO.bool}`);
      return;
    case 'enum':
      if (!node.values.includes(value)) return fail(`se esperaba uno de: ${node.values.join(', ')}`);
      return;
    case 'arrStr':
      if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) return fail(`se esperaba ${TIPO.arrStr}`);
      if (node.values) {
        for (const v of value) if (!node.values.includes(v)) return fail(`cada elemento debe ser uno de: ${node.values.join(', ')}`);
      }
      return;
    case 'theme': {   // campo del tema de Apariencia: misma regla y mensaje que cleanTheme (#151)
      const motivo = themeFieldError(node.key, value);
      if (motivo) return fail(motivo);
      if (node.min !== undefined && value < node.min) return fail(`el valor mínimo es ${node.min}`);
      if (node.max !== undefined && value > node.max) return fail(`el valor máximo es ${node.max}`);
      return;
    }
    case 'list':
      if (!Array.isArray(value)) return fail('se esperaba una lista');
      if (node.maxItems !== undefined && value.length > node.maxItems) return fail(`como mucho ${node.maxItems} elementos`);
      if (node.maxBytes !== undefined && JSON.stringify(value ?? []).length > node.maxBytes) {
        return fail(`ocupan demasiado: como mucho ${node.maxBytes} bytes de JSON`);
      }
      for (const [i, item] of value.entries()) {
        checkObject(itemSchemaOf(node), item, `${path}.${i}`, errors);
        if (node.item?.kind === 'crossBar') crossCheckBar(item, `${path}.${i}`, errors);
      }
      return;
    case 'struct':
      if (node.type === 'array' ? !Array.isArray(value) : (typeof value !== 'object' || value === null || Array.isArray(value))) {
        return fail(`se esperaba ${node.type === 'array' ? 'una lista' : 'un objeto'}`);
      }
      return;
    default: return; // nodo sin esquema: se acepta
  }
}

function checkObject(schema, value, prefix, errors) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: prefix, message: `${prefix}: se esperaba un objeto` });
    return;
  }
  for (const [k, node] of Object.entries(schema)) checkNode(node, value[k], `${prefix}.${k}`, errors);
}

/** Valida un parche parcial (PUT /api/config). Devuelve errores [{path, message}]. */
export function validatePatch(patch) {
  const errors = [];
  checkObject(CONFIG_SCHEMA, patch || {}, 'config', errors);
  return errors.map(e => ({ path: e.path.replace(/^config\./, ''), message: e.message.replace(/^config\./, '') }));
}

/** La lista completa mantiene ids estables; una adición copia el chat y usa el slug del CRUD. */
export function validateChatVariantsTransition(previous, next, defaultChat) {
  const errors = validatePatch({ widgets: { chatVariants: next } });
  if (errors.length || !Array.isArray(next)) return errors;
  const existing = Array.isArray(previous) ? [...previous] : [];
  const before = new Set(existing.map(v => v?.id));
  const after = new Set(next.map(v => v.id));
  if ([...before].some(id => !after.has(id)) && [...after].some(id => !before.has(id))) {
    errors.push({ path: 'widgets.chatVariants', message: 'widgets.chatVariants: no se puede cambiar el id de una variante; crea o borra por separado' });
    return errors;
  }
  const { id: _id, name: _name, ...chat } = defaultChat || {};
  for (const [i, variant] of next.entries()) {
    if (before.has(variant.id)) continue;
    const expectedId = chatVariantId(variant.name, existing);
    const { id, name, ...fields } = variant;
    if (id !== expectedId) errors.push({ path: `widgets.chatVariants.${i}.id`, message: `widgets.chatVariants.${i}.id: el id debe ser el slug único del nombre (${expectedId})` });
    if (!isDeepStrictEqual(fields, chat)) errors.push({ path: `widgets.chatVariants.${i}`, message: `widgets.chatVariants.${i}: una variante nueva debe copiar el chat predeterminado completo` });
    existing.push(variant);
  }
  return errors;
}

/** Tramos de ruta que llegarían al prototipo de los objetos: nunca se leen ni se escriben. */
export const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Hojas con un valor simple: por debajo no hay nada que guardar (lo convertiría en objeto). */
const HOJAS = new Set(['num', 'str', 'bool', 'enum', 'arrStr', 'theme']);

/** Valida el valor de una ruta con puntos («overlay.queueMax», «widgets.goals.0.target»).
 *  Las rutas sin esquema (claves nuevas) se aceptan, pero nunca las que tocan el prototipo,
 *  las que bajan por debajo de un valor simple ni una sección entera sin validar. */
export function validatePath(dotted, value) {
  const keys = String(dotted || '').split('.').filter(Boolean);
  const proto = keys.find(k => PROTO_KEYS.has(k));
  if (proto) return [{ path: dotted, message: `${dotted}: ruta no válida («${proto}»)` }];
  let node = CONFIG_SCHEMA, prefix = '';
  for (const [i, k] of keys.entries()) {
    if (node?.fields) {
      // nodo cruzado (goalBar de #128): sus campos viven en .fields
      node = node.fields[k];
    } else if (node && node.kind !== undefined) {
      // mapa de iconos del tema: se baja un nivel más, al icono de un tipo (#151)
      if (node.kind === 'theme' && node.key === 'icons' && i === keys.length - 1) {
        const motivo = themeIconError(k, value);
        return motivo ? [{ path: `${prefix}.${k}`, message: `${prefix}.${k}: ${motivo}` }] : [];
      }
      // lista de textos: un elemento por índice (escribir un texto o borrarlo)
      if (node.kind === 'arrStr' && /^\d+$/.test(k) && i === keys.length - 1) {
        if (value === undefined) return [];
        if (typeof value !== 'string') return [{ path: dotted, message: `${dotted}: se esperaba ${TIPO.str}` }];
        return node.values && !node.values.includes(value) ? [{ path: dotted, message: `${dotted}: tiene que ser uno de: ${node.values.join(', ')}` }] : [];
      }
      if (HOJAS.has(node.kind)) return [{ path: dotted, message: `${dotted}: ${prefix} no admite subcampos` }];
      if (node.kind !== 'list' || !/^\d+$/.test(k)) return [];   // no se puede bajar más: se acepta
      node = node.item;
    } else {
      node = node?.[k];
      if (node === undefined) return [];                          // ruta desconocida: se acepta
    }
    prefix = prefix ? `${prefix}.${k}` : k;
  }
  if (!node || value === undefined) return [];   // sin esquema, o borrar: se acepta
  // hoja o sección entera: misma validación que PUT /api/config (una sección, campo a campo)
  const errors = [];
  checkNode(node, value, prefix, errors);
  return errors;
}

// ---------- saneo al cargar ----------
/** Recorre el esquema sobre la configuración ya fusionada: cada hoja conocida e inválida
 *  se sustituye por su valor por defecto. Devuelve avisos [{path, message}] para el registro. */
export function sanitizeConfig(config, defaults) {
  const warnings = [];
  const walk = (schema, value, def, prefix) => {
    for (const [k, node] of Object.entries(schema)) {
      const path = `${prefix}.${k}`;
      const v = value?.[k], d = def?.[k];
      if (node.kind === undefined) { walk(node, v, d, path); continue; }
      // #118: dentro de una lista (comandos, timers, atajos, variaciones) la hoja inválida
      // vuelve a su default y el elemento se conserva: nunca se borra el elemento ni la lista.
      if (node.kind === 'list') {
        if (!Array.isArray(v)) continue;
        const itemSchema = itemSchemaOf(node);
        for (const [i, item] of v.entries()) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            walk(itemSchema, item, (Array.isArray(d) ? d[i] : undefined) ?? node.itemDef, `${path}.${i}`);
            if (node.item?.kind === 'crossBar') {   // comprobación cruzada: se avisa, no se sustituye
              const cross = [];
              crossCheckBar(item, `${path}.${i}`, cross);
              for (const c of cross) warnings.push({ path: c.path, message: c.message });
            }
          }
        }
        continue;
      }
      const errors = [];
      checkNode(node, v, path, errors);
      if (errors.length && v !== undefined) {
        // Discriminadores (kind de acción y de paso): el valor inválido se conserva con aviso;
        // sustituirlo daría un efecto en vivo no pedido (el motor sí falla con kind desconocido).
        if (node.keepInvalid) {
          warnings.push({ path, message: `${path}: valor inválido; lo conservo tal cual (${JSON.stringify(v)})` });
          continue;
        }
        const reemplazo = node.repair ? node.repair(v) : (d !== undefined ? d : (node.def !== undefined ? node.def : defaultGenerico(node)));
        value[k] = structuredClone(reemplazo);
        warnings.push({ path, message: `${path}: valor inválido; uso el valor por defecto (${JSON.stringify(reemplazo)})` });
      }
    }
  };
  walk(CONFIG_SCHEMA, config, defaults, 'config');
  return warnings.map(w => ({ path: w.path.replace(/^config\./, ''), message: w.message.replace(/^config\./, '') }));
}

// ---------- aviso de claves desconocidas (una vez por ruta) ----------
const avisadas = new Set();
/** Resuelve una ruta con puntos en el esquema; undefined si no existe (ruta desconocida). */
export function schemaAt(dotted) {
  let node = CONFIG_SCHEMA;
  for (const k of String(dotted || '').split('.').filter(Boolean)) {
    if (node && node.kind !== undefined) {
      if (node.kind === 'list' && /^\d+$/.test(k)) node = node.item;
      else return undefined;
    } else {
      node = node?.[k];
      if (node === undefined) return undefined;
    }
  }
  return node;
}
/** Avisa en el registro de cada ruta del parche que no esté en el esquema; solo la primera vez. */
export function warnUnknownKeys(patch, base = '') {
  for (const [k, v] of Object.entries(patch || {})) {
    const path = base ? `${base}.${k}` : k;
    const node = schemaAt(path);
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && node && node.kind === undefined) {
      // rama con esquema propio: baja comparando hoja a hoja
      warnUnknownKeys(v, path);
    } else if (node === undefined && !avisadas.has(path)) {
      avisadas.add(path);
      console.warn(`campo desconocido en la configuración: ${path}`);
    }
  }
}
