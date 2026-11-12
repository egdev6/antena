// Tipos de alerta, plantillas, variaciones y normalización de eventos de Twitch y YouTube.
import { randomUUID } from 'node:crypto';

export const ALERT_TYPES = {
  follow:      { platform: 'twitch',  icon: 'heart',   label: 'Nuevo seguidor' },
  sub:         { platform: 'twitch',  icon: 'star',    label: 'Suscripción' },
  resub:       { platform: 'twitch',  icon: 'star',    label: 'Resuscripción' },
  giftsub:     { platform: 'twitch',  icon: 'gift',    label: 'Subs regaladas' },
  cheer:       { platform: 'twitch',  icon: 'gem',     label: 'Bits' },
  raid:        { platform: 'twitch',  icon: 'rocket',  label: 'Raid' },
  redemption:  { platform: 'twitch',  icon: 'spark',   label: 'Recompensa' },
  superchat:   { platform: 'youtube', icon: 'coin',    label: 'Super Chat' },
  supersticker:{ platform: 'youtube', icon: 'coin',    label: 'Super Sticker' },
  member:      { platform: 'youtube', icon: 'badge',   label: 'Nuevo miembro' },
  milestone:   { platform: 'youtube', icon: 'badge',   label: 'Hito de miembro' },
  giftmember:  { platform: 'youtube', icon: 'gift',    label: 'Membresías regaladas' },
  // Récord de espectadores a la vez (src/viewers.mjs). `system`: no los manda nadie del chat, así que
  // no cuentan como eventos (métricas, objetivos, últimos, ticker, créditos) ni piden «gracias».
  viewers:     { platform: 'twitch',  icon: 'eye',     label: 'Récord de espectadores', system: true },
  ytviewers:   { platform: 'youtube', icon: 'eye',     label: 'Récord de espectadores', system: true },
};

/** ¿Es una alerta del propio directo (récords…) y no de una persona? */
export const isSystemType = type => !!ALERT_TYPES[type]?.system;

export const COMMAND_META = { platform: 'chat', icon: 'spark', label: 'Comando de chat' };

// Ajustes de aspecto comunes a todas las alertas. `layout`:
//   card  → tarjeta 3D EGDEV
//   media → tu vídeo o imagen con el mensaje encima (texto sobre imagen)
//   mixed → tu vídeo o imagen de fondo (a pantalla completa) y encima la tarjeta 3D EGDEV
export const LOOK_DEFAULTS = {
  layout: 'card',
  media: '',            // archivo de media/ (webm, mp4, gif, png, webp…)
  mediaSize: 100,       // % del tamaño original
  mediaVolume: 100,     // % volumen del vídeo
  sound: 'default',     // 'default' | 'none' | archivo de audio de media/
  soundVolume: 100,
  durationMode: 'fixed',// 'fixed' | 'media' (lo que dure el vídeo)
  textDelayMs: 0,
  textX: 50, textY: 78, textWidth: 90, // % dentro del recurso (centro del bloque de texto)
  textAlign: 'center',
  fontSize: 64,
  textColor: '#FFFFFF',
  accentColor: '#FF0036',
  animIn: 'pop',        // pop | fade | slide | zoom | none
  animOut: 'fade',      // fade | slide | zoom | none
  cardX: 0, cardY: 0,   // mixta: ajuste de la tarjeta sobre el fondo (px, desde la posición del tema)
  css: '',
};

// Voz y acciones de Meld, por alerta (y por variación o comando).
export const EXTRA_DEFAULTS = {
  ttsEnabled: false,
  ttsTemplate: '{user} dice: {message}',
  ttsMinAmount: 0,
  actions: [],          // [{ kind: 'scene'|'layer'|'toggleLayer'|'command'|'streamEvent', ... }]
};

/** Todos los campos editables de una alerta, con su tipo, para el panel y el MCP. */
export const ALERT_FIELDS = {
  enabled: 'boolean', title: 'string', text: 'string', sub: 'string', durationMs: 'number', minAmount: 'number',
  layout: ['card', 'media', 'mixed'], media: 'string', mediaSize: 'number', mediaVolume: 'number',
  sound: 'string', soundVolume: 'number', durationMode: ['fixed', 'media'], textDelayMs: 'number',
  textX: 'number', textY: 'number', textWidth: 'number', textAlign: ['left', 'center', 'right'], fontSize: 'number',
  textColor: 'string', accentColor: 'string', cardX: 'number', cardY: 'number', animIn: ['pop', 'fade', 'slide', 'zoom', 'none'], animOut: ['fade', 'slide', 'zoom', 'none'],
  css: 'string', ttsEnabled: 'boolean', ttsTemplate: 'string', ttsMinAmount: 'number', actions: 'array',
};

const base = { enabled: true, durationMs: 6500, minAmount: 0, ...LOOK_DEFAULTS, ...EXTRA_DEFAULTS, variations: [] };

export const DEFAULT_ALERTS = {
  follow:      { ...base, title: 'Nuevo seguidor',      text: '{user}', sub: 'gracias por seguir el canal', durationMs: 5500 },
  sub:         { ...base, title: 'Nueva suscripción',   text: '{user}', sub: 'se suscribe · tier {tier}' },
  resub:       { ...base, title: 'Resuscripción',       text: '{user}', sub: '{months} meses · {message}', ttsTemplate: '{user}: {message}' },
  giftsub:     { ...base, title: 'Subs regaladas',      text: '{user}', sub: 'regala {amount} subs' },
  cheer:       { ...base, title: 'Bits',                text: '{user}', sub: '{amount} bits · {message}', minAmount: 1, ttsTemplate: '{user} dice: {message}' },
  raid:        { ...base, title: 'Raid',                text: '{user}', sub: 'llega con {amount} personas', durationMs: 8000 },
  redemption:  { ...base, title: 'Recompensa',          text: '{user}', sub: '{reward} · {input}', ttsTemplate: '{user}: {input}' },
  superchat:   { ...base, title: 'Super Chat',          text: '{user}', sub: '{amountText} · {message}', durationMs: 8000 },
  supersticker:{ ...base, title: 'Super Sticker',       text: '{user}', sub: '{amountText}' },
  member:      { ...base, title: 'Nuevo miembro',       text: '{user}', sub: 'se une como {level}' },
  milestone:   { ...base, title: 'Miembro',             text: '{user}', sub: '{months} meses · {message}' },
  giftmember:  { ...base, title: 'Membresías regaladas',text: '{user}', sub: 'regala {amount} membresías' },
  viewers:     { ...base, title: 'Nuevo récord',        text: '{amount} espectadores', sub: 'a la vez en Twitch · antes {previous}' },
  ytviewers:   { ...base, title: 'Nuevo récord',        text: '{amount} espectadores', sub: 'a la vez en YouTube · antes {previous}' },
};

// cada alerta con sus propias listas (nunca compartidas)
for (const a of Object.values(DEFAULT_ALERTS)) { a.variations = []; a.actions = []; }

export const DEFAULT_COMMAND = {
  ...base,
  trigger: '!hola', permission: 'everyone', cooldownSec: 30, userCooldownSec: 60, platforms: ['twitch', 'youtube'],
  title: 'Comando', text: '{user}', sub: '{args}', durationMs: 5000, ttsTemplate: '{user}: {args}',
};

export const SAMPLES = {
  follow:      { user: 'devconcafe' },
  sub:         { user: 'ana_frontend', tier: 1 },
  resub:       { user: 'pixelmaria', months: 14, tier: 1, message: 'a por la V2 del design system' },
  giftsub:     { user: 'testing_tom', amount: 5, tier: 1 },
  cheer:       { user: 'reactivo', amount: 500, message: 'eso del stream de anoche me ha volado la cabeza' },
  raid:        { user: 'midudev', amount: 120 },
  redemption:  { user: 'lucia_codes', reward: 'Revisa mi repo', input: 'github.com/lucia/portfolio' },
  superchat:   { user: 'Carlos Ruiz', amount: 5, amountText: '5,00 €', message: '¡Gracias por los directos!' },
  supersticker:{ user: 'Marta G.', amount: 2, amountText: '2,00 €' },
  member:      { user: 'Javi Dev', level: 'Miembro EGDEV' },
  milestone:   { user: 'Laura Test', months: 6, message: 'medio año construyendo criterio' },
  giftmember:  { user: 'Pablo M.', amount: 3, level: 'Miembro EGDEV' },
  viewers:     { amount: 48, previous: 41, platform: 'twitch' },
  ytviewers:   { amount: 23, previous: 19, platform: 'youtube' },
  command:     { user: 'devconcafe', args: 'hola a todos', command: '!hola' },
};

export const DEFAULT_CONDITIONS = { minAmount: '', maxAmount: '', tier: '', users: '', messageContains: '', chance: 100 };

/** Sustituye {clave} y limpia separadores que quedan colgando si falta un dato. */
export function render(template = '', vars = {}) {
  const out = String(template).replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined || v === null ? '' : String(v);
  });
  return tidy(out);
}

export function tidy(s) {
  return s
    .replace(/\s+/g, ' ')
    .split(/\s*·\s*/)
    .map(p => p.trim())
    .filter(Boolean)
    .join(' · ')
    .trim();
}

const list = s => String(s || '').split(/[,\n]/).map(x => x.trim().toLowerCase()).filter(Boolean);
const num = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** ¿Cumplen los datos del evento las condiciones de una variación? */
export function matchesConditions(cond = {}, vars = {}, rnd = Math.random) {
  const c = { ...DEFAULT_CONDITIONS, ...cond };
  const amount = num(vars.amount);
  if (num(c.minAmount) !== null && (amount === null || amount < num(c.minAmount))) return false;
  if (num(c.maxAmount) !== null && (amount === null || amount > num(c.maxAmount))) return false;
  if (num(c.tier) !== null && Number(vars.tier) !== num(c.tier)) return false;
  const users = list(c.users);
  if (users.length && !users.includes(String(vars.user || '').toLowerCase())) return false;
  const words = list(c.messageContains);
  if (words.length) {
    const msg = String(vars.message ?? vars.input ?? vars.args ?? '').toLowerCase();
    if (!words.some(w => msg.includes(w))) return false;
  }
  const chance = num(c.chance) ?? 100;
  if (chance < 100 && rnd() * 100 >= chance) return false;
  return true;
}

/** Primera variación activa cuyas condiciones se cumplen (el orden es la prioridad). */
export function pickVariation(variations = [], vars = {}, rnd) {
  return variations.find(v => v.enabled !== false && matchesConditions(v.conditions, vars, rnd)) || null;
}

/** Config efectiva de una alerta: valores por defecto + los tuyos + (si toca) la variación. */
export function alertConfig(type, config, variation = null) {
  const cfg = { ...structuredClone(DEFAULT_ALERTS[type]), ...(config?.alerts?.[type] || {}) };
  if (!variation) return cfg;
  const { enabled, ...overrides } = variation.overrides || {};
  return { ...cfg, ...overrides };
}

export function buildAlert(type, vars, config, { test = false, variationId = null, rnd } = {}) {
  const meta = ALERT_TYPES[type];
  if (!meta) return null;
  const baseCfg = alertConfig(type, config);
  if (!baseCfg.enabled && !test) return null;
  const amount = Number(vars.amount ?? 0);
  if (!test && baseCfg.minAmount && vars.amount !== undefined && amount < baseCfg.minAmount) return null;
  const variations = baseCfg.variations || [];
  const variation = variationId ? variations.find(v => v.id === variationId) : (test ? null : pickVariation(variations, vars, rnd));
  const cfg = alertConfig(type, config, variation);
  return finalize({ type, meta, cfg, vars, config, test, variation });
}

export function buildCommandAlert(cmd, vars, config, { test = false } = {}) {
  const cfg = { ...DEFAULT_COMMAND, ...cmd };
  return finalize({ type: 'command', meta: COMMAND_META, cfg, vars, config, test, variation: null, commandId: cmd.id });
}

/** Alerta libre (desde el MCP o el panel) con los campos que se quieran. */
export function buildCustomAlert(fields, vars, config) {
  const cfg = { ...base, title: '', text: '', sub: '', ...fields };
  return finalize({ type: 'custom', meta: { platform: fields.platform || 'egdev', icon: fields.icon || 'spark' }, cfg, vars: vars || {}, config, test: false, variation: null });
}

function finalize({ type, meta, cfg, vars, config, test, variation, commandId }) {
  const ttsGlobal = config?.tts || {};
  let tts = null;
  const amount = Number(vars.amount ?? 0);
  if (cfg.ttsEnabled && ttsGlobal.enabled !== false && (!cfg.ttsMinAmount || amount >= cfg.ttsMinAmount)) {
    const text = cutWords(render(cfg.ttsTemplate, vars).replace(/ · /g, '. '), Number(ttsGlobal.maxChars) || 200);
    if (text) tts = { text, voice: ttsGlobal.voice || '', rate: Number(ttsGlobal.rate) || 1, pitch: Number(ttsGlobal.pitch) || 1, volume: clamp(Number(ttsGlobal.volume ?? 1), 0, 1) };
  }
  return {
    id: randomUUID(),
    type,
    commandId,
    variation: variation ? { id: variation.id, name: variation.name } : null,
    platform: meta.platform,
    icon: meta.icon,
    title: render(cfg.title, vars),
    text: render(cfg.text, vars) || 'Anónimo',
    sub: render(cfg.sub, vars),
    durationMs: clamp(Number(cfg.durationMs) || 6000, 1000, 60000),
    sound: cfg.sound ?? 'default',
    volume: clamp(Number(config?.overlay?.volume ?? 0.6), 0, 1),
    look: pickLook(cfg),
    globalCss: String(config?.overlay?.css || ''),
    tts,
    actions: Array.isArray(cfg.actions) ? cfg.actions : [],
    test,
    at: new Date().toISOString(),
    vars,
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Recorta sin partir palabras. */
export function cutWords(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const i = cut.lastIndexOf(' ');
  return (i > max * 0.5 ? cut.slice(0, i) : s.slice(0, max)).trim();
}

export function mediaKind(name = '') {
  if (/\.(webm|mp4|mov|m4v)$/i.test(name)) return 'video';
  if (/\.(gif|png|jpe?g|webp|apng|avif|svg)$/i.test(name)) return 'image';
  if (/\.(mp3|ogg|wav|m4a|opus)$/i.test(name)) return 'audio';
  if (/\.(woff2?|ttf|otf)$/i.test(name)) return 'font';   // fuentes para el tema (Apariencia)
  return null;
}

function pickLook(cfg) {
  const out = {};
  for (const k of Object.keys(LOOK_DEFAULTS)) out[k] = cfg[k] ?? LOOK_DEFAULTS[k];
  // sin archivo, «vídeo» y «mixta» caen a la tarjeta
  out.layout = ['media', 'mixed'].includes(out.layout) && out.media ? out.layout : 'card';
  out.mediaKind = out.media ? mediaKind(out.media) : null;
  for (const k of ['mediaSize', 'mediaVolume', 'soundVolume', 'textDelayMs', 'textX', 'textY', 'textWidth', 'fontSize', 'cardX', 'cardY']) out[k] = Number(out[k]) || 0;
  return out;
}

const tierOf = t => ({ '1000': 1, '2000': 2, '3000': 3 })[t] || 1;

/** Evento de EventSub de Twitch → { type, vars } o null si no genera alerta. */
export function normalizeTwitch(subType, e = {}) {
  switch (subType) {
    case 'channel.follow':
      return { type: 'follow', vars: { user: e.user_name } };
    case 'channel.subscribe':
      if (e.is_gift) return null; // ya sale en la alerta de subs regaladas
      return { type: 'sub', vars: { user: e.user_name, tier: tierOf(e.tier) } };
    case 'channel.subscription.message':
      return { type: 'resub', vars: { user: e.user_name, tier: tierOf(e.tier), months: e.cumulative_months, message: e.message?.text } };
    case 'channel.subscription.gift':
      return { type: 'giftsub', vars: { user: e.is_anonymous ? 'Anónimo' : e.user_name, amount: e.total, tier: tierOf(e.tier) } };
    case 'channel.cheer':
      return { type: 'cheer', vars: { user: e.is_anonymous ? 'Anónimo' : e.user_name, amount: e.bits, message: stripCheermotes(e.message) } };
    case 'channel.raid':
      return { type: 'raid', vars: { user: e.from_broadcaster_user_name, amount: e.viewers } };
    case 'channel.bits.use':
      // Power-ups spend bits without a channel.cheer event; plain cheers arrive here too
      // (type «cheer») and already alert through channel.cheer, so they are ignored.
      if (e.type !== 'power_up' && e.type !== 'custom_power_up') return null;
      return { type: 'cheer', vars: { user: e.user_name, amount: e.bits, message: stripCheermotes(e.message?.text || ''), powerUp: e.power_up?.type || e.type } };
    case 'channel.channel_points_custom_reward_redemption.add':
      return { type: 'redemption', vars: { user: e.user_name, reward: e.reward?.title, cost: e.reward?.cost, input: e.user_input } };
    default:
      return null;
  }
}

function stripCheermotes(msg = '') {
  return String(msg).replace(/\b[a-z]+\d+\b/gi, '').replace(/\s+/g, ' ').trim();
}

/** Mensaje de liveChatMessages de YouTube → { type, vars } o null. */
export function normalizeYouTube(item = {}) {
  const s = item.snippet || {};
  const user = item.authorDetails?.displayName;
  switch (s.type) {
    case 'superChatEvent': {
      const d = s.superChatDetails || {};
      return { type: 'superchat', vars: { user, amount: micros(d.amountMicros), amountText: d.amountDisplayString, message: d.userComment, currency: d.currency } };
    }
    case 'superStickerEvent': {
      const d = s.superStickerDetails || {};
      return { type: 'supersticker', vars: { user, amount: micros(d.amountMicros), amountText: d.amountDisplayString, sticker: d.superStickerMetadata?.altText } };
    }
    case 'newSponsorEvent': {
      const d = s.newSponsorDetails || {};
      return { type: 'member', vars: { user, level: d.memberLevelName || 'miembro', upgrade: !!d.isUpgrade } };
    }
    case 'memberMilestoneChatEvent': {
      const d = s.memberMilestoneChatDetails || {};
      return { type: 'milestone', vars: { user, months: d.memberMonth, level: d.memberLevelName, message: d.userComment } };
    }
    case 'membershipGiftingEvent': {
      const d = s.membershipGiftingDetails || {};
      return { type: 'giftmember', vars: { user, amount: d.giftMembershipsCount, level: d.giftMembershipsLevelName } };
    }
    default:
      return null;
  }
}

/** Mensaje normal del chat de YouTube → mensaje de chat unificado, o null. */
export function youtubeChatMessage(item = {}) {
  const s = item.snippet || {};
  if (s.type !== 'textMessageEvent') return null;
  const a = item.authorDetails || {};
  return {
    id: 'yt:' + item.id, platform: 'youtube', user: a.displayName, color: '',
    ...(a.channelId ? { authorId: a.channelId } : {}),
    text: s.textMessageDetails?.messageText ?? s.displayMessage ?? '',
    mod: !!a.isChatModerator, owner: !!a.isChatOwner, member: !!a.isChatSponsor, at: s.publishedAt || new Date().toISOString(),
  };
}

const micros = m => (m ? Number(m) / 1e6 : undefined);
