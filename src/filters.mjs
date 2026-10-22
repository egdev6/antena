// Filtro de palabras, usuarios y enlaces para alertas, voz y chat.
export const DEFAULT_FILTERS = {
  enabled: true,
  blockedWords: [],        // se sustituyen por `replaceWith`
  blockedUsers: [],        // no generan alertas ni salen en el chat
  replaceWith: '***',
  blockLinks: true,        // los enlaces se cambian por «[enlace]»
  maxMessageLength: 200,
};

const fold = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|es|net|org|io|dev|gg|tv|ly|me|co|xyz|app)(?:\/\S*)?\b/gi;

export function isBlockedUser(user, filters = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  if (!f.enabled || !user) return false;
  const u = fold(user).replace(/^@/, '');
  return (f.blockedUsers || []).some(b => fold(b).replace(/^@/, '') === u);
}

export function cleanText(text, filters = {}) {
  const f = { ...DEFAULT_FILTERS, ...filters };
  let s = String(text ?? '');
  if (!f.enabled || !s) return s;
  if (f.blockLinks) s = s.replace(LINK, '[enlace]');
  for (const w of f.blockedWords || []) {
    if (!String(w).trim()) continue;
    // sin distinguir mayúsculas ni tildes, y solo palabras completas
    const pattern = [...fold(w).trim()].map(ch => /[a-z]/.test(ch) ? `[${ch}${accentsOf(ch)}]` : escRe(ch)).join('');
    s = s.replace(new RegExp(`(?<![\\p{L}\\d])${pattern}(?![\\p{L}\\d])`, 'giu'), f.replaceWith);
  }
  const max = Number(f.maxMessageLength) || 0;
  if (max && s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

function accentsOf(ch) {
  return ({ a: 'áàäâÁÀÄÂ', e: 'éèëêÉÈËÊ', i: 'íìïîÍÌÏÎ', o: 'óòöôÓÒÖÔ', u: 'úùüûÚÙÜÛ', n: 'ñÑ', c: 'çÇ' })[ch] || '';
}

const TEXT_VARS = ['message', 'input', 'args', 'user', 'reward'];

export function cleanVars(vars = {}, filters = {}) {
  const out = { ...vars };
  for (const k of TEXT_VARS) if (typeof out[k] === 'string') out[k] = cleanText(out[k], k === 'user' ? { ...filters, blockLinks: false, maxMessageLength: 60 } : filters);
  return out;
}
