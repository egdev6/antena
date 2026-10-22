// Helpers puros compartidos por server.mjs y los módulos de rutas (#107, segundo
// corte del patrón de rutas por áreas). Al vivir aquí, ya no hace falta pasarlos
// por ctx ni por los constructores: server.mjs y src/routes/*.mjs los importan.
// Sin dependencias de la app: solo módulos de Node. Sin cambio de comportamiento
// respecto a sus versiones en server.mjs.
import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

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
