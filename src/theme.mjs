// Tema de todo lo que sale en pantalla (overlay de alertas, widgets y créditos): Apariencia.
//
// Un único tema para todo. El de serie es el de EGDEV y la página Apariencia lo sobrescribe.
// Se sirve como /theme.css en la capa `egdev-theme`, que va DESPUÉS de la capa `egdev` de los
// estilos de serie: el tema gana a la serie sin !important y el CSS propio (sin capa) gana a los dos.
// Lo que no se puede expresar con CSS (icono por tipo de alerta, etiqueta de plataforma, posición,
// sonido) viaja en el evento SSE `theme` y lo aplica el propio overlay.
// El teleprompter y el prompter no se tematizan: son para ti, no para el directo.
import { createHash } from 'node:crypto';

export const FONTS = {
  'egdev-cond':  { label: 'Barlow Condensed (EGDEV)', css: "'EG Barlow Condensed','Barlow Condensed','Arial Narrow',sans-serif" },
  'egdev-body':  { label: 'Barlow (EGDEV)',           css: "'EG Barlow','Barlow','Segoe UI',system-ui,sans-serif" },
  'mono':        { label: 'JetBrains Mono',           css: "'EG JetBrains Mono','JetBrains Mono',Consolas,monospace" },
  'bahnschrift': { label: 'Bahnschrift (Windows)',    css: "Bahnschrift,'DIN Alternate','Arial Narrow',sans-serif" },
  'impact':      { label: 'Impact',                   css: "Impact,'Haettenschweiler','Arial Narrow Bold',sans-serif" },
  'arial-black': { label: 'Arial Black',              css: "'Arial Black','Arial Bold',sans-serif" },
  'segoe':       { label: 'Segoe UI',                 css: "'Segoe UI',system-ui,sans-serif" },
  'arial':       { label: 'Arial',                    css: 'Arial,Helvetica,sans-serif' },
  'verdana':     { label: 'Verdana',                  css: 'Verdana,Geneva,sans-serif' },
  'trebuchet':   { label: 'Trebuchet MS',             css: "'Trebuchet MS',sans-serif" },
  'georgia':     { label: 'Georgia',                  css: "Georgia,'Times New Roman',serif" },
  'courier':     { label: 'Courier New',              css: "'Courier New',monospace" },
};
/** Id de una fuente de la lista; propia, nunca heredada del prototipo (constructor, toString…). */
const isFontId = f => Object.hasOwn(FONTS, f);

/** Iconos de trazo del overlay (public/overlay.html › ICONS) que se pueden elegir por tipo de alerta. */
export const ICON_NAMES = ['heart', 'star', 'gift', 'gem', 'rocket', 'spark', 'coin', 'badge', 'eye', 'bell', 'fire', 'trophy', 'crown', 'zap', 'megaphone', 'music', 'smile', 'users', 'rocket2', 'thumb'];

export const DEFAULT_THEME = {
  // color
  accent: '#FF0036', accentSoft: '#FF8FA6', text: '#FFFFFF', textSoft: '#CCCCCC', muted: '#888888',
  surface: '#0F0F13', surfaceOpacity: 96, surfaceStyle: 'gradient', border: '', borderWidth: 2, glow: 100,
  platformAccent: false, twitchColor: '#9146FF', youtubeColor: '#FF0000',
  // tipografía
  fontDisplay: 'egdev-cond', fontBody: 'egdev-body', textScale: 100, uppercase: true, outline: false,
  // iconografía
  iconStroke: 'normal', iconColor: '#FFFFFF', tileShape: 'square', platformBadge: 'text', icons: {},
  // forma y efectos
  round: 100, alertWidth: 860, alertScale: 100, tilt: true, reflection: true, decorations: true, timerBar: true,
  // posición y movimiento
  position: 'center', align: 'center', offsetX: 0, offsetY: 0, animation: '3d',
  // sonido
  sound: 'default', soundVolume: 100,
};

/** Puntos de partida: solo lo que cambian respecto al de serie. */
export const PRESETS = {
  egdev:    { label: 'EGDEV (de serie)', theme: {} },
  cian:     { label: 'Cian', theme: { accent: '#00D1FF', accentSoft: '#8FE9FF', surface: '#0B1116' } },
  esmeralda:{ label: 'Esmeralda', theme: { accent: '#18E08B', accentSoft: '#9AF5C9', surface: '#0B130F' } },
  ambar:    { label: 'Ámbar', theme: { accent: '#FFB21E', accentSoft: '#FFD98A', surface: '#15110A' } },
  plataforma:{ label: 'Color de cada plataforma', theme: { platformAccent: true, platformBadge: 'logo' } },
  sobrio:   { label: 'Sobrio', theme: { glow: 15, tilt: false, reflection: false, decorations: false, animation: 'slide', surfaceStyle: 'solid', surfaceOpacity: 92, round: 60 } },
  cristal:  { label: 'Cristal', theme: { surfaceStyle: 'glass', surfaceOpacity: 70, glow: 55, tilt: false, reflection: false } },
};

const ENUMS = {
  surfaceStyle: ['gradient', 'solid', 'glass'],
  iconStroke: ['thin', 'normal', 'bold'],
  tileShape: ['square', 'round', 'none'],
  platformBadge: ['text', 'logo', 'none'],
  position: ['top', 'center', 'bottom'],
  align: ['left', 'center', 'right'],
  animation: ['3d', 'slide', 'fade', 'pop', 'none'],
};
const RANGES = {
  surfaceOpacity: [0, 100], borderWidth: [0, 8], glow: [0, 200], textScale: [50, 200], round: [0, 300],
  alertWidth: [400, 1600], alertScale: [30, 200], offsetX: [-960, 960], offsetY: [-540, 540], soundVolume: [0, 200],
};
const COLORS = ['accent', 'accentSoft', 'text', 'textSoft', 'muted', 'surface', 'twitchColor', 'youtubeColor', 'iconColor'];
const BOOLS = ['platformAccent', 'uppercase', 'outline', 'tilt', 'reflection', 'decorations', 'timerBar'];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const err = m => Object.assign(new Error(m), { status: 400 });
const isFontFile = name => /\.(woff2?|ttf|otf)$/i.test(name);
const SAFE_FILE = /^[\w .()\-áéíóúñüÁÉÍÓÚÑÜ]+$/;
// Tipos de icono: solo nombres simples y nunca claves de prototipo (#151).
const ICON_KEY = /^[\w-]+$/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ANULAR_ICONO = ic => ic === null || ic === '' || ic === 'default';

/** Reglas por campo del tema: única tabla, compartida con el esquema de configuración
 *  (src/config-schema.mjs), para que todas las vías de escritura validen igual (#151). */
export const THEME_RULES = (() => {
  const rules = Object.create(null);
  for (const k of COLORS) rules[k] = 'color';
  for (const k of BOOLS) rules[k] = 'bool';
  for (const k of Object.keys(ENUMS)) rules[k] = 'enum';
  for (const k of Object.keys(RANGES)) rules[k] = 'num';
  for (const k of ['fontDisplay', 'fontBody']) rules[k] = 'font';
  rules.border = 'border';
  rules.icons = 'icons';
  rules.sound = 'sound';
  return rules;
})();
/** Rangos por campo (mismos que recorta cleanTheme); el esquema los usa como mínimo y máximo. */
export const THEME_RANGES = RANGES;

/** Motivo por el que un campo numérico se sale de su rango, o null. Las vías de escritura que
 *  no importan temas antiguos rechazan con este motivo (el mismo del esquema) en vez de recortar. */
export function themeRangeError(key, value) {
  const r = RANGES[key];
  if (!r || typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < r[0]) return `${key}: el valor mínimo es ${r[0]}`;
  if (value > r[1]) return `${key}: el valor máximo es ${r[1]}`;
  return null;
}

const isIcon = s => ICON_NAMES.includes(s) || s === 'none' || s === 'logo' || s === 'twitch' || s === 'youtube'
  || (s.startsWith('emoji:') && s.length <= 20)
  || (s.startsWith('media:') && /\.(png|webp|gif|svg|jpe?g|avif)$/i.test(s) && SAFE_FILE.test(s.slice(6)));

/** Motivo por el que el icono de un tipo de alerta no vale, o null. */
export function themeIconError(type, icon) {
  if (!ICON_KEY.test(type) || PROTO_KEYS.has(type)) return 'nombre de tipo no válido (letras, números, «_» y «-»)';
  if (ANULAR_ICONO(icon)) return null;   // borra el icono de ese tipo
  return isIcon(String(icon)) ? null : `icono desconocido (${ICON_NAMES.join(', ')}, logo, none, emoji:🎉 o media:archivo.png)`;
}

/** Motivo por el que un campo del tema no vale, o null si vale (undefined = campo desconocido).
 *  Es la regla única: la usan cleanTheme y el esquema de configuración. */
export function themeFieldError(key, value) {
  switch (THEME_RULES[key]) {
    case 'color': return HEX.test(String(value)) ? null : 'usa un color #RRGGBB';
    case 'border': return !value || HEX.test(String(value)) ? null : 'usa un color #RRGGBB o vacío (sale del acento)';
    case 'bool': return typeof value === 'boolean' ? null : 'true o false';
    case 'enum': return ENUMS[key].includes(value) ? null : `tiene que ser uno de ${ENUMS[key].join(', ')}`;
    case 'num': return typeof value === 'number' && Number.isFinite(value) ? null : 'tiene que ser un número';
    case 'font': {
      const f = String(value);
      return isFontId(f) || (f.startsWith('media:') && isFontFile(f) && SAFE_FILE.test(f.slice(6)))
        ? null : `fuente desconocida (${Object.keys(FONTS).join(', ')} o media:archivo.woff2)`;
    }
    case 'sound': {
      const s = String(value);
      return ['default', 'none'].includes(s) || (/\.(mp3|ogg|wav|m4a|opus)$/i.test(s) && SAFE_FILE.test(s))
        ? null : 'default, none o un archivo de audio de media/';
    }
    case 'icons': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return 'tiene que ser un objeto { tipo: icono }';
      for (const [type, ic] of Object.entries(value)) {
        const motivo = themeIconError(type, ic);
        if (motivo) return `${type}: ${motivo}`;
      }
      return null;
    }
    default: return undefined;
  }
}

/** Los iconos válidos de un mapa y nada más: saneo entrada a entrada al cargar config.json. */
export const keepValidIcons = value => (value && typeof value === 'object' && !Array.isArray(value))
  ? Object.fromEntries(Object.entries(value).filter(([type, ic]) => !ANULAR_ICONO(ic) && !themeIconError(type, ic)))
  : {};

/** Valor guardado de un campo ya validado (mayúsculas de color, recorte de rangos). */
const coerceTheme = (key, value) => {
  switch (THEME_RULES[key]) {
    case 'color': return String(value).toUpperCase();
    case 'border': return value ? String(value).toUpperCase() : '';
    case 'num': return Math.round(Math.min(RANGES[key][1], Math.max(RANGES[key][0], value)));
    default: return value;   // enum, fuente, sonido y bool se guardan tal cual
  }
};

/** Valida y limpia un parche del tema. Lanza 400 con un mensaje claro si algo no vale. */
export function cleanTheme(patch = {}, base = DEFAULT_THEME) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw err('El tema tiene que ser un objeto');
  const out = { ...DEFAULT_THEME, ...base, icons: { ...(base.icons || {}) } };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'version') continue;
    const motivo = themeFieldError(k, v);
    if (motivo === undefined) throw err(`Ajuste del tema desconocido: ${k}`);
    if (motivo) throw err(`${k}: ${motivo}`);
    if (THEME_RULES[k] === 'icons') {
      for (const [type, ic] of Object.entries(v)) {
        if (ANULAR_ICONO(ic)) delete out.icons[type]; else out.icons[type] = String(ic);
      }
      continue;
    }
    out[k] = coerceTheme(k, v);
  }
  return out;
}

/** Tema saneado campo a campo: lo inválido cae a su valor de serie sin tirar el resto. Defensa en
 *  profundidad de themeCss, que también recibe config.theme guardado sin pasar por cleanTheme. */
const safeTheme = theme => {
  const out = { ...DEFAULT_THEME, icons: {} };
  for (const [k, v] of Object.entries(theme || {})) {
    const rule = THEME_RULES[k];
    if (!rule || rule === 'icons') continue;   // los iconos no pintan CSS
    if (themeFieldError(k, v) === null) out[k] = coerceTheme(k, v);
  }
  return out;
};

export const themeVersion = t => createHash('sha1').update(JSON.stringify(t)).digest('hex').slice(0, 10);

const rgb = hex => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const rgba = (c, a) => `rgba(${c.join(',')},${Math.round(a * 1000) / 1000})`;
const fontCss = (f, fallback) => {
  if (isFontId(f)) return FONTS[f].css;
  if (f?.startsWith('media:')) return `'${fontFamilyOf(f.slice(6))}',${FONTS[fallback].css}`;
  return FONTS[fallback].css;
};
export const fontFamilyOf = file => 'EGU ' + file.replace(/\.[^.]+$/, '').replace(/[^\w -]/g, '').slice(0, 40);

/** Texto seguro dentro de url('…'): escapa lo que puede cerrar la cadena o el url() (#151). */
export const escapeCssUrl = s => String(s).replace(/['"()\\\n\r\f]/g, c => '\\' + c.charCodeAt(0).toString(16) + ' ');

/** Hoja de estilos del tema (capa egdev-theme). */
export function themeCss(theme = DEFAULT_THEME) {
  const t = safeTheme(theme);
  const acc = t.accent;
  const s = rgb(t.surface), op = t.surfaceOpacity / 100;
  const light = mix(s, [255, 255, 255], 0.12), dark = mix(s, [0, 0, 0], 0.45);
  const surfaceBg = t.surfaceStyle === 'solid' ? rgba(s, op)
    : t.surfaceStyle === 'glass' ? `linear-gradient(160deg,${rgba(light, op * 0.7)},${rgba(s, op * 0.6)})`
    : `linear-gradient(160deg,${rgba(light, op)},${rgba(s, Math.min(1, op + 0.01))} 55%,${rgba(dark, Math.min(1, op + 0.02))})`;
  const stroke = { thin: 1.6, normal: 2.2, bold: 3 }[t.iconStroke];
  const vars = [
    `--red:${acc}`, `--red-2:color-mix(in srgb,${acc} 80%,#fff)`, `--red-dark:color-mix(in srgb,${acc} 50%,#000)`,
    `--pink:${t.accentSoft}`, `--white:${t.text}`, `--grey:${t.textSoft}`, `--muted:${t.muted}`,
    `--glow:${t.glow / 100}`, `--surface-bg:${surfaceBg}`, ...(t.border ? [`--surface-border:${t.border}`] : []),
    `--line-w:${t.borderWidth}px`, `--round:${t.round / 100}`, `--text-k:${t.textScale / 100}`,
    `--alert-width:${t.alertWidth}px`, `--alert-scale:${t.alertScale / 100}`, `--off-x:${t.offsetX}px`, `--off-y:${t.offsetY}px`,
    `--icon-ink:${t.iconColor}`, `--icon-stroke:${stroke}`,
    `--f-cond:${fontCss(t.fontDisplay, 'egdev-cond')}`, `--f-body:${fontCss(t.fontBody, 'egdev-body')}`,
  ];
  const rules = [`:root{${vars.join(';')}}`];
  const pfVars = c => `--red:${c};--red-2:color-mix(in srgb,${c} 80%,#fff);--red-dark:color-mix(in srgb,${c} 50%,#000);--accent:${c}`;
  if (t.platformAccent) rules.push(`.pf-twitch{${pfVars(t.twitchColor)}}`, `.pf-youtube{${pfVars(t.youtubeColor)}}`);
  if (t.surfaceStyle === 'glass') rules.push('.eg-card,.card,.msg,.band,.chip{backdrop-filter:blur(16px) saturate(1.2)}');
  if (!t.uppercase) rules.push('body *{text-transform:none}');
  if (t.outline) rules.push('.alert-name,.alert-title,.alert-sub,.big,.kick,.who,.text,.title,.nums,.it,.prize,.join,.grp li,.chip,.label,.reel .name{-webkit-text-stroke:.05em #000;paint-order:stroke fill}');
  if (t.tileShape === 'round') rules.push('.alert-card{--tile-radius:50%}');
  if (t.tileShape === 'none') rules.push('.alert-card .tile{background:none;border:0;box-shadow:none}');
  if (!t.tilt) rules.push('.alert-card{--tilt:rotate(0deg)}');
  if (!t.reflection) rules.push('.alert-card{--reflection:linear-gradient(transparent,transparent)}');
  if (!t.decorations) rules.push('.alert-card .halo,.alert-card .dots,.alert-card .cube,.q::before{display:none}');
  if (!t.timerBar) rules.push('.alert-card .timer{display:none}');
  const anim = {
    slide: '@keyframes enter{from{opacity:0;transform:translate3d(0,70px,0) var(--tilt)}to{opacity:1;transform:translate3d(0,0,0) var(--tilt) scale(1)}}@keyframes leave{from{opacity:1;transform:var(--tilt)}to{opacity:0;transform:translate3d(0,-50px,0) var(--tilt)}}',
    fade: '@keyframes enter{from{opacity:0;transform:var(--tilt)}to{opacity:1;transform:var(--tilt) scale(1)}}@keyframes leave{from{opacity:1;transform:var(--tilt)}to{opacity:0;transform:var(--tilt)}}',
    pop: '@keyframes enter{0%{opacity:0;transform:var(--tilt) scale(.55)}70%{opacity:1;transform:var(--tilt) scale(1.05)}to{opacity:1;transform:var(--tilt) scale(1)}}@keyframes leave{from{opacity:1;transform:var(--tilt)}to{opacity:0;transform:var(--tilt) scale(.8)}}',
    none: '@keyframes enter{from,to{opacity:1;transform:var(--tilt)}}@keyframes leave{from,to{opacity:0}}',
  }[t.animation];
  if (anim) rules.push(anim);
  // fuentes subidas a media/
  const faces = [...new Set([t.fontDisplay, t.fontBody].filter(f => f?.startsWith('media:')).map(f => f.slice(6)))]
    .map(file => `@font-face{font-family:'${fontFamilyOf(file)}';font-display:swap;src:url('/media/${escapeCssUrl(encodeURIComponent(file))}')}`);
  return `/* antena · tema de pantalla (Apariencia). Generado: no lo edites a mano. */\n@layer egdev, egdev-theme;\n${faces.join('\n')}\n@layer egdev-theme {\n${rules.join('\n')}\n}\n`;
}

/** Lo que reciben overlay y widgets por SSE (`theme`). */
export const publicTheme = theme => {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  return { ...t, version: themeVersion(t) };
};
export { isFontFile };
