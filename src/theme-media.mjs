// Referencias de medios del esquema de un look. No inspecciona textos, acciones ni datos globales.
import path from 'node:path';
import { checkZipName } from './zip-archive.mjs';

// CSS escapes are decoded with raw offsets, so a rename can retain the original spelling,
// quotes, percent encoding, whitespace and query/fragment around the filename.
function cssValue(raw) {
  let value = ''; const offsets = [0];
  const add = (text, end) => { value += text; for (let j = 0; j < text.length; j++) offsets.push(end); };
  for (let i = 0; i < raw.length;) {
    if (raw[i] !== '\\') {
      const point = raw.codePointAt(i), text = String.fromCodePoint(point); i += text.length; add(text, i); continue;
    }
    i++;
    if (i >= raw.length) { add('\ufffd', i); continue; }
    if (raw[i] === '\n' || raw[i] === '\f' || raw[i] === '\r') {
      if (raw[i] === '\r' && raw[i + 1] === '\n') i++;
      i++; offsets[offsets.length - 1] = i; continue;
    }
    const hex = /^[0-9a-f]{1,6}/i.exec(raw.slice(i));
    if (hex) {
      i += hex[0].length;
      if (/[\t\n\f\r ]/.test(raw[i] || '')) { if (raw[i] === '\r' && raw[i + 1] === '\n') i++; i++; }
      const n = parseInt(hex[0], 16), point = !n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? 0xfffd : n;
      add(String.fromCodePoint(point), i);
    } else {
      const text = String.fromCodePoint(raw.codePointAt(i)); i += text.length; add(text, i);
    }
  }
  return { value, offsets };
}

// Consume one CSS escape without mistaking escaped quotes, parentheses or whitespace for delimiters.
function escapeEnd(text, start) {
  let i = start + 1;
  if (i >= text.length) return i;
  const hex = /^[0-9a-f]{1,6}/i.exec(text.slice(i));
  if (hex) {
    i += hex[0].length;
    if (/[\t\n\f\r ]/.test(text[i] || '')) { if (text[i] === '\r' && text[i + 1] === '\n') i++; i++; }
    return i;
  }
  if (text[i] === '\r' && text[i + 1] === '\n') return i + 2;
  return i + 1;
}

function quotedEnd(text, start) {
  const quote = text[start]; let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i = escapeEnd(text, i); continue; }
    if (text[i] === quote) return i;
    if (text[i] === '\n' || text[i] === '\r' || text[i] === '\f') return -1;
    i++;
  }
  return -1;
}

// Only actual URL tokens and the quoted form of @import, not comments or ordinary strings.
function rewriteCss(text, change) {
  let result = '', last = 0, i = 0;
  const replace = (start, end) => { result += text.slice(last, start) + change(text.slice(start, end)); last = end; };
  while (i < text.length) {
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (text[i] === '"' || text[i] === "'") { const end = quotedEnd(text, i); i = end < 0 ? text.length : end + 1; continue; }
    if (text[i] === '@' && /^@import(?![-_a-z0-9\\])/i.test(text.slice(i))) {
      let j = i + 7;
      for (;;) {
        while (/[\t\n\f\r ]/.test(text[j] || '')) j++;
        if (!text.startsWith('/*', j)) break;
        const end = text.indexOf('*/', j + 2); j = end < 0 ? text.length : end + 2;
      }
      if (text[j] === '"' || text[j] === "'") {
        const end = quotedEnd(text, j);
        if (end >= 0) { replace(j + 1, end); i = end + 1; continue; }
      }
    }
    if ((i === 0 || !/[-_a-z0-9\\]/i.test(text[i - 1])) && /^url\(/i.test(text.slice(i))) {
      let j = i + 4;
      while (/[\t\n\f\r ]/.test(text[j] || '')) j++;
      if (text[j] === '"' || text[j] === "'") {
        const end = quotedEnd(text, j);
        if (end >= 0) {
          let close = end + 1; while (/[\t\n\f\r ]/.test(text[close] || '')) close++;
          if (text[close] === ')') { replace(j + 1, end); i = close + 1; continue; }
        }
      } else {
        const start = j;
        while (j < text.length && text[j] !== ')' && !/[\t\n\f\r ]/.test(text[j])) {
          if (text[j] === '\\') j = escapeEnd(text, j); else j++;
        }
        let close = j; while (/[\t\n\f\r ]/.test(text[close] || '')) close++;
        if (text[close] === ')') { replace(start, j); i = close + 1; continue; }
      }
    }
    if (text[i] === '\\') i = escapeEnd(text, i); else i++;
  }
  return result + text.slice(last);
}

/** Recorre las referencias conocidas y devuelve copias reescritas y nombres únicos. */
export function themeMedia(inputLook, inputAvatar, replacements = new Map(), { cssOnly = false } = {}) {
  const look = structuredClone(inputLook), avatar = structuredClone(inputAvatar);
  const names = new Set(), required = new Set(), cssNames = new Set(), warnings = new Set();
  const rewrite = (name, kind) => {
    if (!name) return name;
    checkZipName(`media/${name}`, undefined, { allowCss: kind === 'css' }); names.add(name); (kind === 'css' ? cssNames : required).add(name);
    return replacements.get(name) || name;
  };
  const direct = (object, key) => {
    const value = object?.[key];
    if (typeof value === 'string' && value && value !== 'default' && value !== 'none') object[key] = rewrite(value, 'direct');
  };
  const tagged = (object, key) => {
    const value = object?.[key];
    if (typeof value === 'string' && value.startsWith('media:')) object[key] = `media:${rewrite(value.slice(6), 'direct')}`;
  };
  const cssUrl = (raw, base) => {
    const decoded = cssValue(raw), value = decoded.value.trim();
    if (!value || value.startsWith('#')) return raw;
    const outside = () => { warnings.add(`Referencia CSS fuera de media: «${value.slice(0, 300)}»`); return raw; };
    // Absolute URLs can point to another machine/port after transfer. Never fetch or follow them.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return outside();
    let url;
    try { url = new URL(value, `http://antena.invalid${base}`); } catch { return outside(); }
    if (url.origin !== 'http://antena.invalid' || !url.pathname.startsWith('/media/')) return outside();
    const encoded = url.pathname.slice('/media/'.length);
    let name;
    try { name = decodeURIComponent(encoded); checkZipName(`media/${name}`, undefined, { allowCss: true }); } catch { return outside(); }
    if (encoded.includes('/') || !name) return outside();
    const next = rewrite(name, 'css');
    if (next === name) return raw;
    const valueEnd = decoded.value.search(/[?#]/), end = valueEnd < 0 ? decoded.value.length : valueEnd;
    const start = decoded.value.lastIndexOf('/', end - 1) + 1;
    let original;
    try { original = decodeURIComponent(decoded.value.slice(start, end)); } catch { return raw; }
    if (original !== name) return raw;
    const ext = path.extname(name), stem = name.slice(0, -ext.length || undefined);
    if (next.startsWith(stem) && next.endsWith(ext)) {
      const inserted = next.slice(stem.length, next.length - ext.length);
      for (let k = start + 1; k <= end; k++) {
        try {
          if (decodeURIComponent(decoded.value.slice(start, k)) === stem) {
            const at = decoded.offsets[k]; return raw.slice(0, at) + encodeURIComponent(inserted) + raw.slice(at);
          }
        } catch { /* incomplete percent-encoded UTF-8 */ }
      }
    }
    return raw.slice(0, decoded.offsets[start]) + encodeURIComponent(next) + raw.slice(decoded.offsets[end]);
  };
  const styles = (value, base) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) styles(item, base); return; }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'css' && typeof child === 'string') value[key] = rewriteCss(child, raw => cssUrl(raw, base));
      else if (child && typeof child === 'object') styles(child, base);
    }
  };
  if (!cssOnly) {
    tagged(look.theme, 'fontDisplay'); tagged(look.theme, 'fontBody');
    for (const key of Object.keys(look.theme?.icons || {})) tagged(look.theme.icons, key);
    direct(look.theme, 'sound');
    const alert = item => {
      if (!item || typeof item !== 'object') return;
      direct(item, 'media'); direct(item, 'sound');
      for (const variation of item.variations || []) { direct(variation, 'media'); direct(variation, 'sound'); alert(variation.overrides); }
    };
    for (const item of Object.values(look.alerts || {})) alert(item);
    for (const item of look.commands || []) alert(item);
    for (const item of look.timers || []) alert(item);
  }
  for (const key of ['theme', 'alerts', 'overlay', 'commands', 'timers']) styles(look[key], '/overlay');
  for (const key of ['widgets', 'interactive']) styles(look[key], '/widget/chat');
  for (const [id, text] of Object.entries(look.customOverlayCss || {})) if (typeof text === 'string') {
    look.customOverlayCss[id] = rewriteCss(text, raw => cssUrl(raw, `/custom/${id}/frame`));
  }
  if (!cssOnly && avatar?.image) avatar.image = rewrite(avatar.image, 'direct');
  return { look, avatar, names, required, cssNames, warnings: [...warnings] };
}
