// #247: security regressions through the HTTP and MCP interfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';

const CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
const INVALID_SOURCE = 'No se puede importar el archivo indicado';
const INTERNAL = 'Error interno del servidor';
const REAPPROVE = 'El código del overlay ha cambiado. Revísalo y vuelve a aprobar sus permisos desde el panel.';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-247-'));
  const logs = [];
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: (...args) => logs.push(args) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.timers.stop(); app.viewers.stop(); app.program.stop(); app.program.dispose(); app.meld.stop(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  const request = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (method, url, body, headers) => {
    const result = await request(method, url, body, headers);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  return { root, app, base, logs, request, ok, panel: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } };
}

async function mcp(t, base) {
  const child = spawn(process.execPath, [new URL('../src/mcp.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ANTENA_URL: base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', stderr = '', seq = 0;
  const pending = new Map();
  child.stderr.setEncoding('utf8').on('data', s => { stderr += s; });
  child.stdout.setEncoding('utf8').on('data', s => {
    buffer += s;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    child.stdin.end();
    const result = await closed;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stderr, '');
  });
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++seq; pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'security-247', version: '1' } });
  return async (name, args) => {
    const result = (await rpc('tools/call', { name, arguments: args })).result;
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
}

async function meld(t, f) {
  const fake = fakeMeld();
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { fake.server.closeAllConnections(); fake.server.close(resolve); }));
  await f.ok('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
  for (let i = 0; i < 100 && f.app.meld.status.state !== 'conectado'; i++) await sleep(20);
  assert.equal(f.app.meld.status.state, 'conectado');
  return fake;
}

async function approved(f) {
  const { overlay } = await f.ok('POST', '/api/custom-overlays', { name: 'Prueba', html: '<b>hola</b>', css: 'b{}', js: 'void 0', requestedPermissions: ['scene'] });
  await f.ok('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, f.panel);
  return overlay.id;
}
const action = id => `/api/custom-overlays/${id}/action`;
const scene = { kind: 'scene', params: { scene: 'Pantalla' } };

// CSP applies to the same bytes and range protocol browsers use for media.
test('247 S1: CSP en todas las respuestas media, incluidos 200, 206 y 416', async t => {
  const f = await fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const upload = await fetch(f.base + '/api/media/upload?name=prueba.svg', { method: 'POST', body: svg });
  assert.equal(upload.status, 200);
  for (const [method, url, headers, status, expected] of [
    ['GET', '/media/prueba.svg', {}, 200, svg],
    ['HEAD', '/media/prueba.svg', {}, 200, ''],
    ['GET', '/media/prueba.svg', { Range: 'bytes=0-3' }, 206, svg.slice(0, 4)],
    ['GET', '/media/prueba.svg', { Range: 'bytes=9999-' }, 416, ''],
    ['GET', '/media/no-existe.svg', {}, 404, '{"error":"No encontrado"}'],
    ['POST', '/media/prueba.svg', {}, 405, '{"error":"Método no permitido"}'],
  ]) {
    const res = await fetch(f.base + url, { method, headers });
    assert.equal(res.status, status, `${method} ${status}`);
    assert.equal(res.headers.get('content-security-policy'), CSP, `${method} ${status}`);
    assert.equal(await res.text(), expected);
  }
});

test('247 S2: cada campo de código invalida la aprobación y exige reaprobar', async t => {
  const f = await fixture(t); const fake = await meld(t, f);
  for (const field of ['html', 'css', 'js']) {
    const id = await approved(f);
    const edited = await f.ok('PUT', `/api/custom-overlays/${id}`, { [field]: `cambio-${field}` });
    assert.deepEqual(edited.overlay.permissions, []);
    assert.equal(edited.overlay.reapprovalRequired, true);
    const before = (await f.ok('GET', `/api/custom-overlays/${id}`)).overlay;
    const denied = await f.request('POST', action(id), scene);
    assert.deepEqual(denied, { status: 403, body: { error: REAPPROVE } });
    assert.deepEqual((await f.ok('GET', `/api/custom-overlays/${id}`)).overlay, before);
    assert.equal(fake.state.calls.length, 0);
    await f.ok('PUT', `/api/custom-overlays/${id}/permissions`, { permissions: ['scene'] }, f.panel);
    assert.deepEqual(await f.request('POST', action(id), scene), { status: 200, body: { ok: true } });
    assert.equal(fake.state.calls.length, 1);
    fake.state.calls.length = 0;
  }
});

test('247 S2: sin cambio de código se conservan los permisos y siguen funcionando', async t => {
  const f = await fixture(t); const fake = await meld(t, f); const id = await approved(f);
  const old = (await f.ok('GET', `/api/custom-overlays/${id}`)).overlay;
  const update = await f.ok('PUT', `/api/custom-overlays/${id}`, { name: 'Renombrado', width: 1280, transparent: false, html: old.html });
  assert.deepEqual(update.overlay.permissions, ['scene']);
  assert.equal(update.overlay.reapprovalRequired, false);
  const all = (await f.ok('GET', '/api/custom-overlays')).overlays;
  await f.ok('PUT', '/api/config', { customOverlays: all.map(o => o.id === id ? { ...o, height: 720 } : o) });
  await f.ok('POST', '/api/config/set', { path: 'customOverlays.0.name', value: 'Otro nombre' });
  assert.deepEqual((await f.ok('GET', `/api/custom-overlays/${id}`)).overlay.permissions, ['scene']);
  assert.deepEqual(await f.request('POST', action(id), scene), { status: 200, body: { ok: true } });
  assert.equal(fake.state.calls.length, 1);
});

test('247 S2: MCP y las rutas genéricas tampoco conservan permisos al cambiar código', async t => {
  const f = await fixture(t); const client = await mcp(t, f.base);
  for (const route of ['mcp', 'put', 'set', 'dot-set']) {
    const id = await approved(f);
    if (route === 'mcp') await client('editar_overlay', { id, js: 'cambio MCP' });
    if (route === 'put') {
      const overlays = (await f.ok('GET', '/api/custom-overlays')).overlays;
      await f.ok('PUT', '/api/config', { customOverlays: overlays.map(o => o.id === id ? { ...o, css: 'cambio config' } : o) });
    }
    if (route === 'set' || route === 'dot-set') {
      const overlays = (await f.ok('GET', '/api/custom-overlays')).overlays;
      const prefix = route === 'dot-set' ? '.customOverlays' : 'customOverlays';
      await f.ok('POST', '/api/config/set', { path: `${prefix}.${overlays.findIndex(o => o.id === id)}.html`, value: 'cambio ruta' });
    }
    const before = (await f.ok('GET', `/api/custom-overlays/${id}`)).overlay;
    assert.deepEqual(before.permissions, [], route);
    assert.equal(before.reapprovalRequired, true, route);
    assert.deepEqual(await f.request('POST', action(id), scene), { status: 403, body: { error: REAPPROVE } }, route);
    assert.deepEqual((await f.ok('GET', `/api/custom-overlays/${id}`)).overlay, before);
    const changedName = await f.ok('PUT', `/api/custom-overlays/${id}`, { name: 'Ajuste posterior' });
    assert.equal(changedName.overlay.reapprovalRequired, true, route);
    assert.deepEqual(changedName.overlay.permissions, [], route);
  }
});

// Synthetic canaries built at runtime so secret scanners do not flag test fixtures as credentials.
const canary = name => ['synthetic', 'canary', name].join('-');

test('247 S5: config/set y fijar_valor devuelven solo la vista pública', async t => {
  const f = await fixture(t); const client = await mcp(t, f.base);
  for (const [p, value] of [
    ['youtube', { apiKey: canary('api-private'), clientSecret: canary('secret-private') }],
    ['youtube.apiKey', canary('api-other')],
    ['youtube.clientSecret', canary('secret-other')],
    ['access', { lan: false, key: canary('lan-private') }],
    ['access.key', canary('lan-other')],
    ['obs', { url: 'ws://127.0.0.1:4455', password: canary('obs-private') }],
    ['obs.password', canary('obs-other')],
  ]) {
    const response = await f.ok('POST', '/api/config/set', { path: p, value });
    const publicValue = (await f.ok('GET', `/api/config?path=${encodeURIComponent(p)}`)).value;
    if (p === 'obs.password') assert.deepEqual(response, { path: p, passwordSet: true });
    else assert.deepEqual(response, { path: p, value: publicValue }, p);
    assert.doesNotMatch(JSON.stringify(response), /TEST_(?:API|SECRET|LAN|OBS)_(?:PRIVATE|OTHER)/);
  }
  const viaMcp = await client('fijar_valor', { ruta: 'youtube.apiKey', valor: 'TEST_API_MCP_4321' });
  assert.deepEqual(viaMcp, { path: 'youtube.apiKey', value: '••••4321' });
  assert.deepEqual(await f.ok('POST', '/api/config/set', { path: 'port', value: 4617 }), { path: 'port', value: 4617 });
});

test('247 S5: config/set no revela credenciales en parámetros de la URL de OBS', async t => {
  const f = await fixture(t);
  const canary = 'TEST_OBS_QUERY_PRIVATE_247';
  const url = `ws://127.0.0.1:4455/?password=${canary}&profile=public`;
  const expected = 'ws://127.0.0.1:4455/?profile=public';
  const response = await f.ok('POST', '/api/config/set', { path: 'obs.url', value: url });
  assert.deepEqual(response, { path: 'obs.url', value: expected });
  assert.doesNotMatch(JSON.stringify(response), new RegExp(canary));
  assert.deepEqual(response, await f.ok('GET', '/api/config?path=obs.url'));
  assert.equal((await f.ok('GET', '/api/config')).obs.url, expected);
  assert.equal((await f.ok('GET', '/api/state')).config.obs.url, expected);
});

test('247 S5: Meld redacta userinfo y claves de consulta como la exportación, también por MCP', async t => {
  const f = await fixture(t); const client = await mcp(t, f.base);
  const url = 'ws://USER247:PASS247@127.0.0.1:13376/socket?PaSs=SECRET247&apiToken=TOKEN247&profile=public';
  const expected = 'ws://127.0.0.1:13376/socket?profile=public';
  assert.deepEqual(await f.ok('POST', '/api/config/set', { path: 'meld.url', value: url }), { path: 'meld.url', value: expected });
  for (const view of [await f.ok('GET', '/api/config'), (await f.ok('GET', '/api/state')).config]) {
    assert.equal(view.meld.url, expected);
    assert.doesNotMatch(JSON.stringify(view.meld), /USER247|PASS247|SECRET247|TOKEN247/);
  }
  assert.deepEqual(await f.ok('GET', '/api/config?path=meld.url'), { path: 'meld.url', value: expected });
  assert.deepEqual(await client('ver_config', { ruta: 'meld.url' }), { path: 'meld.url', value: expected });
  assert.equal((await f.ok('GET', '/api/config/export?format=json')).config.meld.url, expected);
  const malformed = '  ws://USER247:PASS247@bad.invalid:abc/path?token=TOKEN247&profile=public  ';
  assert.deepEqual(await f.ok('POST', '/api/config/set', { path: 'meld.url', value: malformed }),
    { path: 'meld.url', value: 'ws://bad.invalid:abc/path?profile=public' });
});

for (const kind of ['meld', 'obs']) for (const method of ['put', 'set-url', 'set-section', 'connect']) {
  test(`247 URL round-trip ${kind} ${method}: la conexión conserva la consulta privada`, async t => {
    const f = await fixture(t), fake = kind === 'obs' ? fakeObs() : fakeMeld(), seen = [];
    await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
    fake.server.on('upgrade', req => seen.push(req.url));
    t.after(async () => {
      if (kind === 'obs') await fake.close();
      else await new Promise(resolve => { fake.server.closeAllConnections(); fake.server.close(resolve); });
    });
    const raw = `ws://127.0.0.1:${fake.server.address().port}/socket?profile=public&token=FAKE_${kind.toUpperCase()}_PRIVATE`;
    const clean = `ws://127.0.0.1:${fake.server.address().port}/socket?profile=public`;
    const expected = `/socket?profile=public&token=FAKE_${kind.toUpperCase()}_PRIVATE`;
    await f.ok('POST', '/api/config/set', { path: `${kind}.url`, value: raw });
    // La exportación y la configuración pública comparten exactamente la proyección.
    assert.equal((await f.ok('GET', '/api/config/export?format=json')).config[kind].url, clean);
    const visible = (await f.ok('GET', '/api/config'))[kind].url;
    assert.equal(visible, clean);
    if (method === 'put') await f.ok('PUT', '/api/config', { [kind]: { url: visible } });
    if (method === 'set-url') await f.ok('POST', '/api/config/set', { path: `${kind}.url`, value: visible });
    if (method === 'set-section') await f.ok('POST', '/api/config/set', { path: kind, value: { url: visible } });
    if (kind === 'obs') {
      await f.ok('POST', '/api/config/set', { path: 'program.kind', value: 'obs' });
      for (let i = 0; i < 200 && seen.length < 1; i++) await sleep(20);
      assert.ok(seen.length, 'OBS recibe la conexión');
      if (method === 'connect') {
        const count = seen.length;
        await f.ok('POST', '/api/program/connect', { url: visible });
        for (let i = 0; i < 200 && seen.length <= count; i++) await sleep(20);
        assert.ok(seen.length > count, 'OBS recibe la reconexión');
      }
    } else {
      await f.ok('POST', '/api/meld/connect', method === 'connect' ? { url: visible } : {});
      for (let i = 0; i < 200 && seen.length < 1; i++) await sleep(20);
      assert.ok(seen.length, 'Meld recibe la conexión');
    }
    assert.equal(seen.at(-1), expected, 'la credencial no se ha perdido al guardar la proyección');
    assert.equal((await f.ok('GET', '/api/config'))[kind].url, visible);
  });
}

for (const kind of ['meld', 'obs']) {
  test(`247 URL PRESERVE ${kind}: una URL nueva no hereda credenciales del destino anterior`, async t => {
    const f = await fixture(t), fake = kind === 'obs' ? fakeObs() : fakeMeld(), seen = [];
    await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
    fake.server.on('upgrade', req => seen.push(req.url));
    t.after(async () => {
      if (kind === 'obs') await fake.close();
      else await new Promise(resolve => { fake.server.closeAllConnections(); fake.server.close(resolve); });
    });
    await f.ok('POST', '/api/config/set', { path: `${kind}.url`, value: 'ws://127.0.0.1:1/?token=OLD_PRIVATE' });
    const url = `ws://127.0.0.1:${fake.server.address().port}/socket?profile=new&token=NEW_PRIVATE`;
    await f.ok('PUT', '/api/config', { [kind]: { url } });
    if (kind === 'obs') await f.ok('POST', '/api/config/set', { path: 'program.kind', value: 'obs' });
    else await f.ok('POST', '/api/meld/connect', {});
    for (let i = 0; i < 200 && seen.length < 1; i++) await sleep(20);
    assert.deepEqual(seen, ['/socket?profile=new&token=NEW_PRIVATE']);
    assert.doesNotMatch(JSON.stringify((await f.ok('GET', '/api/config'))[kind]), /OLD_PRIVATE|NEW_PRIVATE/);
  });
}

test('247 S7: importación local sin oráculo y clave LAN rechazada sin efectos', async t => {
  const f = await fixture(t);
  const valid = path.join(f.root, 'origen.png'), invalid = path.join(f.root, 'texto.txt'), missing = path.join(f.root, 'ausente.png');
  await writeFile(valid, 'contenido'); await writeFile(invalid, 'no media');
  await mkdir(path.join(f.root, 'directorio.png'));
  const before = await f.ok('GET', '/api/media');
  for (const body of [{}, { path: '' }, { path: 42 }, { path: missing }, { path: invalid, name: 'destino.png' },
    { path: path.join(f.root, 'directorio.png') }, { path: path.join(f.root, 'data', 'config.json'), name: 'destino.png' }]) {
    assert.deepEqual(await f.request('POST', '/api/media/import', body), { status: 400, body: { error: INVALID_SOURCE } }, JSON.stringify(body));
    assert.deepEqual(await f.ok('GET', '/api/media'), before);
  }
  // El nombre de destino inválido tampoco permite distinguir un origen existente de uno ausente.
  const badName = { status: 400, body: { error: 'Formato no admitido. Usa webm, mp4, gif, png, webp, mp3, ogg, wav o una fuente (woff2, woff, ttf, otf).' } };
  for (const src of [valid, missing]) {
    assert.deepEqual(await f.request('POST', '/api/media/import', { path: src, name: 'destino.exe' }), badName);
    assert.deepEqual(await f.ok('GET', '/api/media'), before);
  }
  const good = await f.ok('POST', '/api/media/import', { path: valid });
  assert.equal(good.name, 'origen.png');
  const saved = await f.ok('GET', '/api/media');
  await f.ok('PUT', '/api/config', { access: { lan: true, key: 'CLAVE_FALSA_247' } });
  let simulateLan = true;
  f.app.server.on('connection', socket => { if (simulateLan) Object.defineProperty(socket, 'remoteAddress', { value: '192.168.1.77' }); });
  // Un socket nuevo evita que fetch reutilice uno abierto antes de simular la LAN.
  const remote = await new Promise((resolve, reject) => {
    const req = http.request(`${f.base}/api/media/import`, { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'x-egdev-key': 'CLAVE_FALSA_247' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify({ path: valid }));
  });
  assert.deepEqual(remote, { status: 403, body: { error: 'Solo desde este PC' } });
  simulateLan = false;
  assert.deepEqual(await f.ok('GET', '/api/media', undefined, { Connection: 'close' }), saved);
});

test('247 5xx: error genérico al cliente y causa real en el registro; 4xx intacto', async t => {
  const f = await fixture(t); const id = await approved(f);
  const secret = 'fallo interno sintético 247';
  // System errors (with a code, may carry paths) are hidden; deliberate messages stay visible.
  f.app.engine.runAction = async () => { throw Object.assign(new Error(secret), { code: 'EACCES' }); };
  assert.deepEqual(await f.request('POST', action(id), scene), { status: 500, body: { error: INTERNAL } });
  f.app.engine.runAction = async () => { throw new TypeError(secret); };
  assert.deepEqual(await f.request('POST', action(id), scene), { status: 500, body: { error: INTERNAL } });
  f.app.engine.runAction = async () => { throw new Error('Falta el Client ID de tu app de Twitch (dev.twitch.tv).'); };
  assert.deepEqual(await f.request('POST', action(id), scene), { status: 500, body: { error: 'Falta el Client ID de tu app de Twitch (dev.twitch.tv).' } });
  assert.ok(f.logs.some(args => args.some(arg => String(arg).includes(secret))), 'el registro incluye el error real');
  assert.deepEqual(await f.request('POST', '/api/config/set', {}), { status: 400, body: { error: 'Falta «path»' } });
  await f.app.stopAdmission();
  assert.deepEqual(await f.request('GET', '/api/status'), { status: 503, body: { error: 'La app se está cerrando.' } });
  assert.ok(f.logs.some(args => args.some(arg => String(arg).includes('La app se está cerrando.'))));
});
