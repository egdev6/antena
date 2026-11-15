// Public HTTP and MCP compatibility contracts for the permanent Meld aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const origin = server => `http://127.0.0.1:${server.address().port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Advertise the extra methods used by the existing consumer trace, and acknowledge
// them through the shared fake's normal WebChannel handler.
function addMethods(fake) {
  fake.state.session.items.e1 = { type: 'effect', parent: 'l1', name: 'Brillo', enabled: true };
  fake.server.prependListener('upgrade', (_req, socket) => {
    const write = socket.write.bind(socket);
    socket.write = (chunk, ...args) => {
      if (Buffer.isBuffer(chunk) && chunk[0] === 0x81) {
        const offset = (chunk[1] & 127) === 126 ? 4 : 2;
        try {
          const message = JSON.parse(chunk.subarray(offset).toString());
          if (message.type === 10 && message.data?.meld) {
            message.data.meld.methods.push(['callFunction', 19], ['setProperty', 21]);
            const data = Buffer.from(JSON.stringify(message));
            const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
            chunk = Buffer.concat([head, data]);
          }
        } catch { /* not an initialization frame */ }
      }
      return write(chunk, ...args);
    };
  });
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-aliases-'));
  const fake = fakeMeld(); addMethods(fake);
  let app;
  t.after(async () => {
    if (app) { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); await app.closeHttp(); }
    if (fake.server.listening) await close(fake.server);
    await rm(dir, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const url = `ws://127.0.0.1:${fake.server.address().port}`;
  const request = async (method, p, body, raw = false) => {
    const response = await fetch(origin(app.server) + p, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text() };
  };
  const snapshot = async () => ({
    config: (await request('GET', '/api/config?path=meld')).body,
    session: (await request('GET', '/api/session')).body,
    calls: structuredClone(fake.state.calls),
  });
  const connected = async () => {
    const deadline = Date.now() + 5000;
    while (JSON.parse((await request('GET', '/api/meld')).body).status.state !== 'conectado' || !fake.state.observerCalls.length) {
      assert.ok(Date.now() < deadline, 'Meld handshake timed out'); await wait(10);
    }
  };
  return { fake, url, request, snapshot, connected };
}

const routes = [
  { suffix: '', method: 'GET' },
  { suffix: '/connect', body: f => ({ url: f.url }) },
  { suffix: '/scene', body: { scene: 'Pantalla' }, result: { scene: 'Pantalla' }, call: [10, 's2'] },
  { suffix: '/layer', body: { scene: 'Cámara', layer: 'Alertas', visible: true }, result: { scene: 'Cámara', layer: 'Alertas' }, call: [11, 's1', 'l1'] },
  { suffix: '/effect', body: { scene: 'Cámara', layer: 'Alertas', effect: 'Brillo' }, result: { ok: true }, call: [15, 's1', 'l1', 'e1'] },
  { suffix: '/command', body: { command: 'meld.screenshot' }, result: { ok: true }, call: [12, 'meld.screenshot'] },
  { suffix: '/event', body: { event: 'COUNTER_INCREMENT', amount: 2 }, result: { ok: true }, call: [13, 'COUNTER_INCREMENT', { amount: 2 }] },
  { suffix: '/track', body: { track: 'Micro', action: 'gain', gain: 0.25 }, result: { ok: true }, call: [16, 't1', 0.25] },
  { suffix: '/media', body: { layer: 'Alertas', command: 'play' }, result: { ok: true }, call: [19, 'l1', 'play'] },
  { suffix: '/property', body: { id: 'l1', property: 'opacity', value: 0.75 }, result: { ok: true }, call: [21, 'l1', 'opacity', 0.75] },
  { suffix: '/call', body: { method: 'sendCommand', args: ['meld.recordClip'] }, result: { result: null }, call: [12, 'meld.recordClip'] },
  { suffix: '/stream', body: { action: 'start' }, result: { requested: 'start', streaming: false }, call: [12, 'meld.startStreamingAction'] },
  { suffix: '/disconnect', body: {} },
];

test('HTTP: every route pair preserves response bytes, effects and rejected requests', { timeout: 60000 }, async t => {
  const fixtures = [await fixture(t), await fixture(t)];
  const prefixes = ['/api/meld', '/api/program'];
  await t.test('disconnected controls reject without changing state', async () => {
    for (const row of routes.filter(r => r.call)) {
      const before = await Promise.all(fixtures.map(f => f.snapshot()));
      const results = await Promise.all(fixtures.map((f, i) => f.request('POST', prefixes[i] + row.suffix, row.body)));
      assert.deepEqual(results[0], results[1]);
      assert.deepEqual(results[0], { status: 409, body: JSON.stringify({ error: 'Meld no está conectado. Actívalo en Ajustes › Avanzado › «Allow remote connections» y pulsa Conectar.' }) });
      for (let i = 0; i < 2; i++) assert.deepEqual(await fixtures[i].snapshot(), before[i]);
    }
  });
  for (const row of routes) await t.test(row.method === 'GET' ? 'GET /' : `POST ${row.suffix}`, async () => {
    const method = row.method || 'POST';
    const before = await Promise.all(fixtures.map(f => f.snapshot()));
    // GET has no request body; a wrong method is its rejected request.
    const rejected = await Promise.all(fixtures.map((f, i) => f.request('POST', prefixes[i] + row.suffix, row.method === 'GET' ? {} : '{bad', row.method !== 'GET')));
    assert.deepEqual(rejected[0], rejected[1]);
    assert.deepEqual(rejected[0], row.method === 'GET'
      ? { status: 404, body: '{"error":"No existe"}' }
      : { status: 400, body: '{"error":"JSON no válido"}' });
    for (let i = 0; i < 2; i++) assert.deepEqual(await fixtures[i].snapshot(), before[i]);
    const results = await Promise.all(fixtures.map((f, i) => f.request(method, prefixes[i] + row.suffix,
      typeof row.body === 'function' ? row.body(f) : row.body)));
    assert.deepEqual(results[0], results[1]); assert.equal(results[0].status, 200);
    if (row.result) assert.equal(results[0].body, JSON.stringify(row.result));
    if (row.suffix === '/connect') {
      await Promise.all(fixtures.map(f => f.connected()));
      assert.deepEqual(fixtures[0].fake.state.observerCalls, fixtures[1].fake.state.observerCalls);
      for (const f of fixtures) {
        assert.equal(JSON.parse((await f.request('GET', '/api/config?path=meld.enabled')).body).value, true);
        assert.equal(JSON.parse((await f.request('GET', '/api/config?path=meld.url')).body).value, f.url);
      }
    }
    if (row.suffix === '/disconnect') for (const f of fixtures)
      assert.equal(JSON.parse((await f.request('GET', '/api/config?path=meld.enabled')).body).value, false);
    for (let i = 0; i < 2; i++) assert.deepEqual(fixtures[i].fake.state.calls.slice(before[i].calls.length), row.call ? [row.call] : []);
    if (row.suffix === '/stream') {
      // Pending commands and duplicate-key validation must be shared across prefixes.
      for (let i = 0; i < 2; i++) {
        const f = fixtures[i], other = prefixes[1 - i];
        const duplicate = await f.request('POST', other + '/stream', row.body);
        assert.deepEqual(duplicate, { status: 409, body: JSON.stringify({ error: 'Ya hay una orden pendiente de confirmación de Meld.' }) });
        for (const prefix of prefixes) {
          const invalid = await f.request('POST', prefix + '/stream', '{"action":"start","\\u0061ction":"stop"}', true);
          assert.deepEqual(invalid, { status: 400, body: JSON.stringify({ error: 'La acción no puede repetirse en el mismo JSON.' }) });
        }
        assert.deepEqual(f.fake.state.calls.slice(before[i].calls.length), [row.call]);
      }
    }
  });
});

function mcp(t, url) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))],
    { env: { ...process.env, ANTENA_URL: url, ANTENA_NO_EMBED: '1' } });
  let buffer = '', id = 0; const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end; while ((end = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(response.id)?.(response); pending.delete(response.id);
    }
  });
  t.after(async () => { const exited = once(child, 'exit'); child.stdin.end(); await exited; });
  return (method, params) => new Promise(resolve => {
    const n = ++id; pending.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
}

// name, REST suffix, MCP arguments, expected HTTP payload. Legacy and generic
// calls must send the same payload to their respective route, not merely succeed.
const tools = [
  ['estado', '', {}, undefined],
  ['conectar', '/connect', { url: 'ws://127.0.0.1:13376' }, { url: 'ws://127.0.0.1:13376' }],
  ['desconectar', '/disconnect', {}, {}],
  ['escena', '/scene', { escena: 'Pantalla' }, { scene: 'Pantalla' }],
  ['capa', '/layer', { escena: 'Cámara', capa: 'Alertas', visible: true, segundos: 3 }, { scene: 'Cámara', layer: 'Alertas', visible: true, seconds: 3 }],
  ['efecto', '/effect', { escena: 'Cámara', capa: 'Alertas', efecto: 'Brillo' }, { scene: 'Cámara', layer: 'Alertas', effect: 'Brillo' }],
  ['comando', '/command', { comando: 'meld.screenshot' }, { command: 'meld.screenshot' }],
  ['evento', '/event', { evento: 'COUNTER_INCREMENT', cantidad: 2 }, { event: 'COUNTER_INCREMENT', amount: 2 }],
  ['audio', '/track', { pista: 'Micro', accion: 'gain', ganancia: 0.25 }, { track: 'Micro', action: 'gain', gain: 0.25 }],
  ['media', '/media', { capa: 'Alertas', accion: 'play' }, { layer: 'Alertas', command: 'play' }],
  ['propiedad', '/property', { id: 'l1', propiedad: 'opacity', valor: 0.75 }, { id: 'l1', property: 'opacity', value: 0.75 }],
  ['llamar', '/call', { metodo: 'sendCommand', args: ['meld.recordClip'] }, { method: 'sendCommand', args: ['meld.recordClip'] }],
];

test('MCP: legacy metadata stays byte-identical and every pair uses its route', { timeout: 30000 }, async t => {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.url === '/api/status') { res.end('{}'); return; }
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const data = body ? JSON.parse(body) : undefined;
      seen.push({ path: req.url, method: req.method, body: data });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ method: req.method, body: data ?? null }));
    });
  });
  await listen(server); t.after(() => close(server));
  const rpc = mcp(t, origin(server));
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const list = (await rpc('tools/list')).result.tools;
  const legacy = tools.map(([name]) => list.find(tool => tool.name === `meld_${name}`));
  await t.test('base metadata snapshot', () => {
    assert.ok(legacy.every(Boolean));
    // Captured from tools/list at base 9d9645b: names, descriptions and schemas.
    assert.equal(createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), '403f982b931ceb976a0592d254e1c0c500a9e1aea08cf2cf4ed9756e801db22d');
  });
  for (const [name, suffix, args, body] of tools) await t.test(name, async () => {
    const old = list.find(tool => tool.name === `meld_${name}`), generic = list.find(tool => tool.name === `programa_${name}`);
    assert.ok(old && generic, `missing tool pair ${name}`);
    assert.deepEqual(generic.inputSchema, old.inputSchema);
    assert.match(generic.description, /programa de emisión/i); assert.doesNotMatch(generic.description, /Meld/);
    const results = [];
    for (const prefix of ['meld', 'programa']) {
      results.push((await rpc('tools/call', { name: `${prefix}_${name}`, arguments: args })).result);
      assert.deepEqual(seen.at(-1), { path: `/api/${prefix === 'meld' ? 'meld' : 'program'}${suffix}`, method: name === 'estado' ? 'GET' : 'POST', body });
    }
    assert.deepEqual(results[0], results[1]); assert.ok(!results[0].isError);
  });
});
