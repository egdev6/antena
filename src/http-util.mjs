// Helpers puros compartidos por server.mjs y los módulos de rutas (#107, segundo
// corte del patrón de rutas por áreas). Al vivir aquí, ya no hace falta pasarlos
// por ctx ni por los constructores: server.mjs y src/routes/*.mjs los importan.
// Sin dependencias de la app: solo módulos de Node. Sin cambio de comportamiento
// respecto a sus versiones en server.mjs.
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// Las mismas reglas sirven a la configuración pública y a la transferencia portable.
export const credential = (key, prefix) => (prefix === 'access' && key === 'key') ||
  /token|secret|password|passwd|apikey|privatekey|credential|^passphrase$|^authorization$/i.test(key.replace(/[_-]/g, '')) ||
  (['twitch', 'youtube'].includes(prefix) && ['access', 'refresh'].includes(key));
export const credentialParam = key => ['key', 'pass', 'pwd', 'auth'].includes(key.toLowerCase()) || credential(key, '');

// Only portable URL parts leave the PC; whitespace must not bypass credential detection.
export function cleanUrl(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^wss?:\/\//i.test(trimmed)) return value;
  try {
    const url = new URL(trimmed); let changed = !!(url.username || url.password);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (credentialParam(key)) { url.searchParams.delete(key); changed = true; }
    return changed ? url.toString() : trimmed;
  } catch {
    // Meld accepts arbitrary text, including malformed URLs. Redact their authority and query
    // without relying on URL parsing; if even the split is ambiguous, fail closed.
    const parts = /^(wss?:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?(#.*)?$/is.exec(trimmed);
    if (!parts) return '';
    const at = parts[2].lastIndexOf('@');
    let changed = at !== -1;
    const query = new URLSearchParams(parts[4] || '');
    for (const key of [...query.keys()]) if (credentialParam(key)) { query.delete(key); changed = true; }
    if (!changed) return trimmed;
    const params = query.toString();
    return `${parts[1]}${parts[2].slice(at + 1)}${parts[3]}${params ? '?' + params : ''}${parts[5] || ''}`;
  }
}

export const id8 = () => randomBytes(4).toString('hex');

export function safePath(dir, rel) {
  const file = path.resolve(dir, decodeURIComponent(String(rel || '')));
  if (!file.startsWith(path.resolve(dir) + path.sep)) throw httpError(403, 'Prohibido');
  return file;
}

export function cleanName(name) {
  if (!name) return '';
  const base = path.basename(String(name).replace(/\\/g, '/')).normalize('NFC');
  return base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 120);
}

export async function freeName(dir, name) {
  const ext = path.extname(name), stem = name.slice(0, -ext.length || undefined);
  for (let i = 0; ; i++) {
    const candidate = path.join(dir, i ? `${stem}-${i}${ext}` : name);
    try { await stat(candidate); } catch { return candidate; }
  }
}
