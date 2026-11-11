// Issue #59: endurecer la clave de acceso LAN.
// Cookie HttpOnly, redirección tras canje de ?key=, comparación en tiempo
// constante y clave enmascarada en la configuración pública (HTTP y MCP ver_config).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';

const KEY = 'CLAVE_FALSA_LAN_59';
const LAN_IP = '192.168.1.77'; // cliente no loopback simulado

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-lan-59-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await Promise.all([dataDir, mediaDir].map(dir => mkdir(dir)));
  const config = {
    port: 0,
    access: { lan: true, key: KEY },
    youtube: { apiKey: '', clientSecret: '' },
  };
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config), { flag: 'wx' });
  const { createApp } = await import('../src/server.mjs');
  const app = await createApp({ dataDir, mediaDir, log: () => {} });
  t.after(async () => { await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  // Cliente no loopback simulado: cada socket aceptado aparece como LAN_IP.
  app.server.on('connection', sock => Object.defineProperty(sock, 'remoteAddress', { value: LAN_IP }));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

// Petición contra el servidor como cliente no loopback simulado.
function lanRequest(app, reqPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: app.server.address().port, path: reqPath,
      method, headers,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

test('canje de ?key=: cookie HttpOnly y redirección a la URL sin la clave', async t => {
  const { app } = await fixture(t);
  const res = await lanRequest(app, '/?key=' + encodeURIComponent(KEY));
  assert.equal(res.statusCode, 302, 'redirige tras canjear la clave');
  assert.equal(res.headers.location, '/', 'la redirección no lleva la clave');
  const cookie = String(res.headers['set-cookie']?.[0] || '');
  assert.match(cookie, /egk=/, 'fija la cookie de sesión');
  assert.match(cookie, /HttpOnly/i, 'la cookie es HttpOnly');
  const body = await new Promise(resolve => { res.resume(); res.on('end', resolve); });
  assert.ok(!String(body).includes(KEY));
  await t.test('la sesión sigue autorizada solo con la cookie', async () => {
    const follow = await lanRequest(app, '/api/status', { headers: { cookie } });
    assert.equal(follow.statusCode, 200);
    const sinCookie = await lanRequest(app, '/api/status');
    assert.equal(sinCookie.statusCode, 401);
  });
});

test('status identity is still protected by LAN admission', async t => {
  const { app } = await fixture(t);
  const denied = await lanRequest(app, '/api/status');
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.headers['set-cookie'], undefined);
  const deniedBody = await new Promise(resolve => { let body = ''; denied.on('data', c => { body += c; }); denied.on('end', () => resolve(body)); });
  assert.deepEqual(JSON.parse(deniedBody), { error: 'Acceso desde la red: abre el enlace con la clave que aparece en el panel (General › Acceso desde el móvil).' });
  const allowed = await lanRequest(app, '/api/status', { headers: { 'x-egdev-key': KEY } });
  assert.equal(allowed.statusCode, 200);
  const body = await new Promise(resolve => { let text = ''; allowed.on('data', c => { text += c; }); allowed.on('end', () => resolve(JSON.parse(text))); });
  const record = JSON.parse(await readFile(path.join(app.store.dir, 'instance.json'), 'utf8'));
  assert.deepEqual(body.instance, { app: 'antena', id: record.id });
});

test('clave incorrecta o vacía: 401 sin cookie ni efectos', async t => {
  const { app } = await fixture(t);
  for (const intento of ['?key=incorrecta', '?key=', '?key']) {
    const res = await lanRequest(app, '/' + intento);
    assert.equal(res.statusCode, 401, `401 para «${intento}»`);
    assert.equal(res.headers['set-cookie'], undefined, 'sin clave válida no hay cookie');
    assert.equal(res.headers.location, undefined, 'sin clave válida no hay redirección');
    res.resume();
  }
});

test('la configuración pública (HTTP y MCP ver_config) no contiene la clave en claro', async t => {
  const { app } = await fixture(t);
  for (const ruta of ['/api/config', '/api/state']) {
    const res = await lanRequest(app, ruta, { headers: { cookie: `egk=${KEY}` } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(await new Promise(resolve => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d));
    }));
    assert.ok(!JSON.stringify(body.config ?? body).includes(KEY), `${ruta} no filtra la clave en la config`);
    res.resume();
  }
  await t.test('la máscara mantiene la pista de la clave', async () => {
    const res = await lanRequest(app, '/api/config?path=access.key', { headers: { cookie: `egk=${KEY}` } });
    const body = JSON.parse(await new Promise(resolve => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d));
    }));
    assert.match(String(body.value), /^••••/, 'access.key aparece enmascarado');
    res.resume();
  });
});

test('el enlace del móvil sigue disponible en /api/access', async t => {
  const { app } = await fixture(t);
  const res = await lanRequest(app, '/api/access', { headers: { cookie: `egk=${KEY}` } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(await new Promise(resolve => {
    let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d));
  }));
  assert.equal(body.key, KEY, 'donde se genera el enlace la clave sigue visible');
  res.resume();
});

test('guardar la config con la máscara no pisa la clave real', async t => {
  const { app } = await fixture(t);
  const res = await lanRequest(app, '/api/config', {
    method: 'PUT',
    headers: { cookie: `egk=${KEY}`, 'content-type': 'application/json' },
  });
  res.resume();
  assert.equal(res.statusCode, 200);
  assert.equal(app.store.config.access.key, KEY, 'la clave real se conserva');
});
