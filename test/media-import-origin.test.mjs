import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

// Arranca el servidor con la carpeta de datos y la de media separadas,
// como hace el resto de la suite.
async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-import-'));
  // carpeta externa a data/ para los orígenes válidos (como media/ junto a data/ en producción)
  const fueraDir = await mkdtemp(path.join(tmpdir(), 'antena-fuera-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const mediaDir = path.join(dataDir, 'media');
  return { app, base, dataDir, fueraDir, mediaDir, close: () => new Promise(r => { app.server.closeAllConnections(); app.server.close(r); }) };
}

const importa = (base, src, name) => fetch(base + '/api/media/import', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: src, ...(name ? { name } : {}) }),
});

test('la importación de media valida el origen: sin data/, sin extensiones raras y sin enlaces a data/', async () => {
  const { base, dataDir, fueraDir, mediaDir, close } = await start();
  try {
    // datos sintéticos: un «secreto» dentro de data/ y un vídeo válido fuera
    await writeFile(path.join(dataDir, 'secrets.json'), '{"token":"sintetico"}');
    await writeFile(path.join(dataDir, 'nota.txt'), 'hola');
    const video = path.join(fueraDir, 'clip.webm');
    await writeFile(video, Buffer.alloc(16, 1));

    // 1) importar data/secrets.json con cualquier nombre → 400 y nada en media/
    for (const name of [undefined, 'trabajo.webm', 'secrets.png']) {
      const res = await importa(base, path.join(dataDir, 'secrets.json'), name);
      assert.equal(res.status, 400, `secrets.json con name=${name} debe dar 400`);
    }
    // 2) origen con extensión no admitida → 400 (aunque el destino parezca media)
    assert.equal((await importa(base, path.join(dataDir, 'nota.txt'), 'nota.webm')).status, 400);
    // 3) origen válido fuera de data/ sigue funcionando
    const ok = await (await importa(base, video)).json();
    assert.equal(ok.name, 'clip.webm');
    const lista = await (await fetch(base + '/api/media')).json();
    assert.ok(lista.some(m => m.name === 'clip.webm'));
    // 4) enlace simbólico con extensión de media que apunta a data/ → rechazado
    await symlink(path.join(dataDir, 'secrets.json'), path.join(dataDir, 'trampa.webm'));
    const trampa = await importa(base, path.join(dataDir, 'trampa.webm'));
    assert.equal(trampa.status, 400);
    // los enlaces simbólicos válidos fuera de data/ siguen bien
    await symlink(video, path.join(dataDir, 'bueno.png'));
    const bueno = await (await importa(base, path.join(dataDir, 'bueno.png'))).json();
    assert.equal(bueno.name, 'bueno.png');

    const enMedia = await readdir(mediaDir);
    assert.deepEqual(enMedia.sort(), ['bueno.png', 'clip.webm']);
  } finally { await close(); }
});

test('la carpeta de datos alcanzada por enlace simbólico también queda confinada', async () => {
  // ANTENA_DATA puede ser un enlace: la comparación usa la carpeta de datos canonicalizada.
  const realDir = await mkdtemp(path.join(tmpdir(), 'antena-datos-real-'));
  const enlace = path.join(await mkdtemp(path.join(tmpdir(), 'antena-datos-enl-')), 'datos');
  await symlink(realDir, enlace);
  const app = await createApp({ dataDir: enlace, mediaDir: path.join(enlace, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await writeFile(path.join(realDir, 'secrets.json'), '{"token":"sintetico"}');
    await writeFile(path.join(realDir, 'video-interno.webm'), Buffer.alloc(8, 3));
    const importa = (src, name) => fetch(base + '/api/media/import', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: src, name }),
    });
    // importado por su ruta REAL (tras resolver el enlace) → 400 y nada en media/
    const res = await importa(path.join(realDir, 'secrets.json'), 'robo.webm');
    assert.equal(res.status, 400);
    assert.equal((await importa(path.join(realDir, 'video-interno.webm'), 'robo.webm')).status, 400,
      'un .webm dentro de data/ (vía enlace) debe quedar confinado');
    assert.deepEqual(await readdir(path.join(enlace, 'media')), []);
  } finally { await new Promise(r => { app.server.closeAllConnections(); app.server.close(r); }); }
});
