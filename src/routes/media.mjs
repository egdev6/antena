// Rutas de media: listado, borrado e importación de archivos de la carpeta de media
// (/api/media, /api/media/delete, /api/media/import).
// Extracción de server.mjs (#107, corte del patrón de rutas por áreas #71).
//
// Patrón (ver cabecera de src/routes/shortcuts.mjs):
// - El módulo exporta una única función registerMediaRoutes(ctx) que registra sus
//   rutas llamando a route(method, pattern, fn) del ctx. Nada más sale por defecto.
// - ctx recibe: instancias vivas de createApp (store), la carpeta de media (mediaDir),
//   el listado de media (listMedia, compartido con /api/state en server.mjs) y el tope
//   de subida (MAX_UPLOAD). Los helpers puros (httpError, safePath, cleanName,
//   freeName) se importan de src/http-util.mjs y mediaKind de src/alerts.mjs.
// - La validación de origen de la importación (#58) vive aquí: origenImportable
//   resuelve enlaces simbólicos y prohíbe importar desde la carpeta de datos.
// - Handlers con la misma convención del dispatcher: con :vars en el patrón,
//   fn(vars, body, url, req); sin vars, fn(body, null, url, req).
// - Se puede probar sin arrancar la app: construyendo un ctx falso y llamando a los
//   handlers directamente (ver test/routes-media.test.mjs).
import { unlink, copyFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { mediaKind } from '../alerts.mjs';
import { httpError, safePath, cleanName, freeName } from '../http-util.mjs';

// Límite compartido por la subida, la importación y los archivos ZIP.
export const MAX_UPLOAD = 300 * 1024 * 1024;

// Origen importable de media: resuelve enlaces simbólicos, exige extensión de media
// en el archivo real y lo prohíbe si vive en la carpeta de datos (tokens, sesiones…).
// La carpeta de datos también se canonicaliza (ANTENA_DATA puede ser un enlace) y,
// en Windows, la comparación ignora mayúsculas/minúsculas.
async function rutaReal(p) {
  try { return await realpath(p); } catch { return path.resolve(p); }
}

const origenNoValido = () => httpError(400, 'No se puede importar el archivo indicado');

async function origenImportable(dir, src) {
  let file;
  try { file = await realpath(src); } catch { throw origenNoValido(); }
  const mismoCamino = f => process.platform === 'win32' ? f.toLowerCase() : f;
  const datos = mismoCamino(await rutaReal(dir));
  const real = mismoCamino(file);
  if (real === datos || real.startsWith(datos + path.sep)) {
    throw origenNoValido();
  }
  if (!mediaKind(path.basename(file))) throw origenNoValido();
  return file;
}

export function registerMediaRoutes({ route, store, mediaDir, listMedia, MAX_UPLOAD }) {
  route('GET', '/api/media', async () => listMedia());
  route('POST', '/api/media/delete', async ({ name }) => {
    await unlink(safePath(mediaDir, name)).catch(() => { throw httpError(404, 'No existe'); });
    return { media: await listMedia() };
  });
  route('POST', '/api/media/import', async ({ path: src, name }) => {
    if (typeof src !== 'string' || !src.trim()) throw origenNoValido();
    const base = cleanName(name || path.basename(src));
    // Valida un nombre explícito antes de mirar el origen: tampoco puede usarse como oráculo.
    if (name && !mediaKind(base)) throw httpError(400, 'Formato no admitido. Usa webm, mp4, gif, png, jpg, jpeg, webp, mp3, ogg, wav o una fuente (woff2, woff, ttf, otf).');
    // Todas las rutas inexistentes o inválidas tienen el mismo resultado, sin revelar si existen.
    if (!mediaKind(base)) throw origenNoValido();
    const origen = await origenImportable(store.dir, src);
    const st = await stat(origen).catch(() => { throw origenNoValido(); });
    if (!st.isFile()) throw origenNoValido();
    if (st.size > MAX_UPLOAD) throw httpError(413, 'El archivo pasa de 300 MB.');
    const dest = await freeName(mediaDir, base);
    await copyFile(origen, dest);
    return { name: path.basename(dest), media: await listMedia() };
  });
}
