// Test de src/routes/media.mjs (#107): rutas /api/media* extraídas de server.mjs
// sin cambio de comportamiento (incluida la validación de origen de /api/media/import
// de #58). No arranca la app: ctx falso con carpeta de media real en tmp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerMediaRoutes } from '../src/routes/media.mjs';
import { mediaKind } from '../src/alerts.mjs';

async function ownDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// ctx falso: misma lista de media que hace server.mjs (readdir + mediaKind + tamaño).
function fakeCtx(t, mediaDir, dataDir, maxUpload) {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const listMedia = async () => {
    try {
      const files = (await readdir(mediaDir)).filter(f => mediaKind(f)).sort((a, b) => a.localeCompare(b));
      return await Promise.all(files.map(async name => {
        const { stat } = await import('node:fs/promises');
        const st = await stat(path.join(mediaDir, name)).catch(() => null);
        return { name, kind: mediaKind(name), size: st?.size ?? 0 };
      }));
    } catch { return []; }
  };
  const ctx = {
    route,
    store: { dir: dataDir },
    mediaDir,
    listMedia,
    MAX_UPLOAD: maxUpload ?? 300 * 1024 * 1024,
    _spies: { listMedia },
  };
  registerMediaRoutes(ctx);
  const find = (method, p) => {
    const r = routes.find(x => x.method === method && x.re.test(p));
    assert.ok(r, `${method} ${p} registrada`);
    return { vars: p.match(r.re).groups, fn: r.fn };
  };
  return { ctx, find };
}

test('solo se registran las rutas de /api/media', async t => {
  const dir = await ownDir(t, 'egdev-media-');
  const { find } = fakeCtx(t, dir, dir);
  assert.ok(find('GET', '/api/media'));
});

test('GET /api/media: lista vía ctx', async t => {
  const dir = await ownDir(t, 'egdev-media-');
  await writeFile(path.join(dir, 'a.png'), 'x');
  const { find } = fakeCtx(t, dir, dir);
  const out = await find('GET', '/api/media').fn();
  assert.deepEqual(out, [{ name: 'a.png', kind: 'image', size: 1 }]);
});

test('POST /api/media/delete: borra, 404 si falta y 403 si se sale del directorio', async t => {
  const dir = await ownDir(t, 'egdev-media-');
  await mkdir(path.join(dir, 'media'), { recursive: true });
  await writeFile(path.join(dir, 'media', 'b.png'), 'x');
  await writeFile(path.join(dir, 'secreto.json'), '{}');
  const { find } = fakeCtx(t, path.join(dir, 'media'), dir);
  assert.deepEqual((await find('POST', '/api/media/delete').fn({ name: 'b.png' })).media, []);
  await assert.rejects(find('POST', '/api/media/delete').fn({ name: 'b.png' }), /No existe/);
  await assert.rejects(find('POST', '/api/media/delete').fn({ name: '..%2Fsecreto.json' }), e => e.status === 403);
});

test('POST /api/media/import: copia con nombre libre, 400/404/413 en los casos de siempre', async t => {
  const base = await ownDir(t, 'egdev-media-');
  const mediaDir = path.join(base, 'media'), dataDir = path.join(base, 'data');
  await mkdir(mediaDir); await mkdir(dataDir);
  await writeFile(path.join(mediaDir, 'c.png'), 'ocupado');
  const origen = path.join(base, 'origen.png');
  await writeFile(origen, 'contenido');
  const { find } = fakeCtx(t, mediaDir, dataDir);
  // nombre libre: c-1.png
  const out = await find('POST', '/api/media/import').fn({ path: origen, name: 'c.png' });
  assert.equal(out.name, 'c-1.png');
  assert.deepEqual(out.media.map(x => x.name), ['c-1.png', 'c.png']);
  // sin path
  await assert.rejects(find('POST', '/api/media/import').fn({}), /Falta «path»/);
  // formato no admitido (nombre y por basename del path)
  await assert.rejects(find('POST', '/api/media/import').fn({ path: origen, name: 'mal.exe' }), /Formato no admitido/);
  await assert.rejects(find('POST', '/api/media/import').fn({ path: path.join(base, 'sinformato') }), /Formato no admitido/);
  // origen inexistente
  await assert.rejects(find('POST', '/api/media/import').fn({ path: path.join(base, 'no.png') }), /No encuentro el archivo indicado/);
  // origen dentro de la carpeta de datos
  await writeFile(path.join(dataDir, 'd.png'), 'x');
  await assert.rejects(find('POST', '/api/media/import').fn({ path: path.join(dataDir, 'd.png') }), /No se pueden importar archivos de la carpeta de datos/);
  // tamaño por encima del tope del ctx
  const { find: findTope } = fakeCtx(t, mediaDir, dataDir, 0);
  await assert.rejects(findTope('POST', '/api/media/import').fn({ path: origen, name: 'g.png' }), e => e.status === 413);
});
