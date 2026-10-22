// Issue #60: proteger los atajos GET /sd/* cuando el navegador no envía Sec-Fetch-Site.
// Un <img src="http://127.0.0.1:4500/sd/marca"> en una web ajena dispara el atajo si solo
// miramos Origin/Sec-Fetch-Site. La decisión del mantenedor (opción a): rechazar GET de
// /sd/* con Referer de otro origen o con cabeceras de navegador sin Sec-Fetch-Site;
// las peticiones sin Origin, Referer ni Sec-Fetch-*, como las del plugin, siguen funcionando.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-sd-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const close = () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
  return { app, port, close };
}

// http.request deja fijar Referer/Sec-Fetch-* a mano (fetch no).
function raw(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}
const markers = app => (app.session.data.notes || []).filter(n => n.kind === 'marker');

test('GET /sd/* con Referer de otro origen y sin Sec-Fetch-Site se rechaza sin crear marcas', async () => {
  const { app, port, close } = await start();
  try {
    const before = markers(app).length;
    const r = await raw(port, { path: '/sd/marca', headers: { Referer: 'https://evil.example/trampa' } });
    assert.equal(r.status, 403);
    assert.equal(markers(app).length, before, 'no se creó ninguna marca');

    // cabeceras de navegador (webview sin Sec-Fetch-Site, p. ej. <img>) también se rechazan
    const img = await raw(port, { path: '/sd/marca', headers: { 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', Accept: 'image/*' } });
    assert.equal(img.status, 403);
    assert.equal(markers(app).length, before, 'el <img> no creó marcas');

    // Referer de otro puerto no es same-origin
    const otherPort = await raw(port, { path: '/sd/pausa', headers: { Referer: `http://127.0.0.1:${port + 1}/panel` } });
    assert.equal(otherPort.status, 403);
  } finally { await close(); }
});

test('el plugin del Stream Deck y un navegador same-origin siguen funcionando', async () => {
  const { app, port, close } = await start();
  try {
    // plugin: sin Origin, Referer ni Sec-Fetch-*
    assert.equal((await raw(port, { path: '/sd/pausa' })).status, 200);
    // navegador same-origin completo
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { Referer: `http://127.0.0.1:${port}/`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } })).status, 200);
    // Sec-Fetch-Site cross-site sigue bloqueado por la política de siempre
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  } finally { await close(); }
});
