// #158: el dock pide órdenes explícitas a Meld; solo una observación de Meld confirma la emisión.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

function frame(message) {
  const data = Buffer.from(JSON.stringify(message));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

// El simulador compartido conserva sus métodos; este adaptador añade avisos de emisión
// y permite simular un Meld que no anuncia isStreaming en el handshake.
function streamFake({ omitStreaming = false } = {}) {
  const meld = fakeMeld({});
  let socket;
  meld.server.prependListener('upgrade', (_req, sock) => {
    socket = sock;
    const write = sock.write.bind(sock);
    sock.write = (chunk, ...args) => {
      if (omitStreaming && Buffer.isBuffer(chunk) && chunk[0] === 0x81) {
        const offset = (chunk[1] & 127) === 126 ? 4 : 2;
        try {
          const m = JSON.parse(chunk.subarray(offset).toString());
          if (m.type === 10 && m.data?.meld) {
            m.data.meld.properties = m.data.meld.properties.filter(p => p[1] !== 'isStreaming');
            chunk = frame(m);
          }
        } catch { /* no es un frame de inicialización */ }
      }
      return write(chunk, ...args);
    };
  });
  return { ...meld, report(value) { socket.write(frame({ type: 2, data: [{ object: 'meld', properties: { 2: value } }] })); } };
}

function nextWhere(emitter, event, predicate) {
  return new Promise(resolve => {
    const on = value => { if (predicate(value)) { emitter.off(event, on); resolve(value); } };
    emitter.on(event, on);
  });
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-stream-control-'));
  const meld = streamFake(options);
  let app;
  t.after(async () => {
    if (app) {
      await app.drainAutoSession().catch(() => {});
      await app.session.flush().catch(() => {});
      app.meld.stop();
      await app.closeHttp().catch(() => {});
    }
    await new Promise(resolve => meld.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const connect = async () => {
    const ready = nextWhere(app.meld, 'status', s => s.state === 'conectado');
    assert.equal((await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` })).status, 200);
    await ready;
  };
  const report = async value => {
    const changed = nextWhere(app.meld, 'status', s => s.state === 'conectado' && s.streaming === value);
    meld.report(value);
    await changed;
  };
  return { app, meld, api, connect, report };
}

const commandCalls = meld => meld.state.calls.filter(c => c[0] === 12);
const current = async api => (await api('GET', '/api/session')).body;
const list = async api => (await api('GET', '/api/sessions')).body;

test('desconectado, incluso con estado anterior de emisión, rechaza ambas órdenes sin cambiar sesión', async t => {
  const f = await setup(t);
  for (const action of ['start', 'stop']) {
    const before = await current(f.api);
    const res = await f.api('POST', '/api/meld/stream', { action });
    assert.equal(res.status, 409); assert.match(res.body.error, /Meld no está conectado/i);
    assert.deepEqual(commandCalls(f.meld), []); assert.deepEqual(await current(f.api), before);
  }
  await f.connect();
  const reset = nextWhere(f.app.session, 'change', v => v.reset);
  await f.report(true); await reset;
  await f.api('POST', '/api/meld/disconnect');
  const before = await current(f.api);
  for (const action of ['start', 'stop']) {
    const res = await f.api('POST', '/api/meld/stream', { action });
    assert.equal(res.status, 409); assert.match(res.body.error, /Meld no está conectado/i);
    assert.deepEqual(commandCalls(f.meld), []); assert.deepEqual(await current(f.api), before);
  }
});

test('cuerpos inválidos devuelven 400 sin enviar ni cambiar sesión', async t => {
  const f = await setup(t); await f.connect();
  const before = await current(f.api), beforeList = await list(f.api);
  for (const body of [null, [], {}, { action: 'toggle' }, { action: '' }, { action: 1 }, { action: 'start', extra: true }]) {
    const res = await f.api('POST', '/api/meld/stream', body);
    assert.equal(res.status, 400); assert.match(res.body.error, /acción/i);
    assert.deepEqual(commandCalls(f.meld), []); assert.deepEqual(await current(f.api), before); assert.deepEqual(await list(f.api), beforeList);
  }
});

test('no termina cuando Meld confirma que no emite', async t => {
  const f = await setup(t); await f.connect();
  const before = await current(f.api);
  const res = await f.api('POST', '/api/meld/stream', { action: 'stop' });
  assert.equal(res.status, 409); assert.match(res.body.error, /no está emitiendo/i);
  assert.deepEqual(commandCalls(f.meld), []); assert.deepEqual(await current(f.api), before);
});

test('no inicia cuando Meld confirma que ya emite', async t => {
  const f = await setup(t); await f.connect();
  const reset = nextWhere(f.app.session, 'change', v => v.reset);
  await f.report(true); await reset;
  const before = await current(f.api);
  const res = await f.api('POST', '/api/meld/stream', { action: 'start' });
  assert.equal(res.status, 409); assert.match(res.body.error, /ya está emitiendo/i);
  assert.deepEqual(commandCalls(f.meld), []); assert.deepEqual(await current(f.api), before);
});

test('start pide una sola orden y solo Meld inicia la sesión automática al confirmar', async t => {
  const f = await setup(t); await f.connect();
  const before = await current(f.api), beforeList = await list(f.api);
  const res = await f.api('POST', '/api/meld/stream', { action: 'start' });
  assert.equal(res.status, 200); assert.deepEqual(res.body, { requested: 'start', streaming: false });
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.startStreamingAction']]);
  assert.deepEqual(await current(f.api), before); assert.deepEqual(await list(f.api), beforeList);
  const reset = nextWhere(f.app.session, 'change', v => v.reset);
  await f.report(true); await reset;
  const after = await current(f.api);
  assert.notEqual(after.id, before.id); assert.equal(after.meldAutoSession, true);
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.startStreamingAction']]);
});

test('stop pide una sola orden y no cierra la sesión hasta que Meld confirme', async t => {
  const f = await setup(t); await f.connect();
  const reset = nextWhere(f.app.session, 'change', v => v.reset);
  await f.report(true); await reset;
  const before = await current(f.api);
  const res = await f.api('POST', '/api/meld/stream', { action: 'stop' });
  assert.equal(res.status, 200); assert.deepEqual(res.body, { requested: 'stop', streaming: true });
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.stopStreamingAction']]);
  assert.deepEqual(await current(f.api), before);
  const ended = nextWhere(f.app.session, 'change', v => v.ended);
  await f.report(false); await ended;
  assert.ok((await current(f.api)).endedAt);
});

test('una propiedad isStreaming ausente es desconocida, no una confirmación false', async t => {
  const f = await setup(t, { omitStreaming: true }); await f.connect();
  const status = (await f.api('GET', '/api/status')).body.meld;
  assert.equal(status.streamingKnown, false);
  const before = await current(f.api);
  for (const action of ['start', 'stop']) {
    const res = await f.api('POST', '/api/meld/stream', { action });
    assert.equal(res.status, 200); assert.deepEqual(res.body, { requested: action, streaming: null });
  }
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.startStreamingAction'], [12, 'meld.stopStreamingAction']]);
  assert.deepEqual(await current(f.api), before);
});

test('las rutas genéricas command y call conservan sus respuestas y órdenes', async t => {
  const f = await setup(t); await f.connect();
  const before = await current(f.api);
  assert.deepEqual(await f.api('POST', '/api/meld/command', { command: 'meld.screenshot' }), { status: 200, body: { ok: true } });
  assert.deepEqual(await f.api('POST', '/api/meld/call', { method: 'sendCommand', args: ['meld.recordClip'] }), { status: 200, body: { result: null } });
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.screenshot'], [12, 'meld.recordClip']]);
  assert.deepEqual(await current(f.api), before);
});

test('peticiones simultáneas no duplican órdenes sin cambio de estado', async t => {
  const f = await setup(t);
  await f.connect();
  const before = await current(f.api), beforeList = await list(f.api);

  const starts = await Promise.all(Array.from({ length: 4 }, () =>
    f.api('POST', '/api/meld/stream', { action: 'start' })));
  assert.deepEqual(starts.map(r => r.status).sort((a, b) => a - b), [200, 409, 409, 409]);
  for (const r of starts) assert.deepEqual(r.body, r.status === 200
    ? { requested: 'start', streaming: false }
    : { error: 'Ya hay una orden pendiente de confirmación de Meld.' });
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.startStreamingAction']]);
  assert.deepEqual(await current(f.api), before);
  assert.deepEqual(await list(f.api), beforeList);

  const reset = nextWhere(f.app.session, 'change', v => v.reset);
  await f.report(true);
  await reset;
  await f.app.drainAutoSession();
  const beforeStop = await current(f.api), beforeStopList = await list(f.api);
  const stops = await Promise.all(Array.from({ length: 2 }, () =>
    f.api('POST', '/api/meld/stream', { action: 'stop' })));
  assert.deepEqual(stops.map(r => r.status).sort((a, b) => a - b), [200, 409]);
  for (const r of stops) assert.deepEqual(r.body, r.status === 200
    ? { requested: 'stop', streaming: true }
    : { error: 'Ya hay una orden pendiente de confirmación de Meld.' });
  assert.deepEqual(commandCalls(f.meld), [
    [12, 'meld.startStreamingAction'],
    [12, 'meld.stopStreamingAction'],
  ]);
  assert.deepEqual(await current(f.api), beforeStop);
  assert.deepEqual(await list(f.api), beforeStopList);
});

test('acciones JSON duplicadas y contradictorias se rechazan sin orden', async t => {
  const f = await setup(t, { omitStreaming: true });
  await f.connect();
  const before = await current(f.api), beforeList = await list(f.api);
  const url = `http://127.0.0.1:${f.app.server.address().port}/api/meld/stream`;

  for (const body of [
    '{"action":"stop","action":"start"}',
    '{"action":"start","action":"stop"}',
  ]) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'La acción no puede repetirse en el mismo JSON.' });
    assert.deepEqual(commandCalls(f.meld), []);
    assert.deepEqual(await current(f.api), before);
    assert.deepEqual(await list(f.api), beforeList);
  }
});

test('la orden pendiente bloquea duplicados hasta la confirmación o el plazo inyectado', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = await setup(t); await f.connect();
  const before = await current(f.api);
  assert.equal((await f.api('POST', '/api/meld/stream', { action: 'start' })).status, 200);
  const duplicate = await f.api('POST', '/api/meld/stream', { action: 'start' });
  assert.equal(duplicate.status, 409); assert.match(duplicate.body.error, /pendiente/i);
  now += 19999;
  assert.equal((await f.api('POST', '/api/meld/stream', { action: 'start' })).status, 409);
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.startStreamingAction']]);
  assert.deepEqual(await current(f.api), before);
  now += 1;
  assert.equal((await f.api('POST', '/api/meld/stream', { action: 'start' })).status, 200);
  const reset = nextWhere(f.app.session, 'change', v => v.reset);
  await f.report(true); await reset;
  assert.equal((await f.api('POST', '/api/meld/stream', { action: 'stop' })).status, 200);
  assert.equal((await f.api('POST', '/api/meld/stream', { action: 'stop' })).status, 409);
  const ended = nextWhere(f.app.session, 'change', v => v.ended);
  await f.report(false); await ended;
  assert.equal((await f.api('POST', '/api/meld/stream', { action: 'start' })).status, 200);
  assert.deepEqual(commandCalls(f.meld), [
    [12, 'meld.startStreamingAction'], [12, 'meld.startStreamingAction'],
    [12, 'meld.stopStreamingAction'], [12, 'meld.startStreamingAction'],
  ]);
});

test('claves action duplicadas incluso con escapes JSON no envían órdenes', async t => {
  const f = await setup(t, { omitStreaming: true }); await f.connect();
  const before = await current(f.api), beforeList = await list(f.api);
  const url = `http://127.0.0.1:${f.app.server.address().port}/api/meld/stream`;
  for (const body of [
    '{"action":"start","action":"start"}',
    '{"\\u0061ction":"start","action":"stop"}',
    '{"action":"start","\\u0061ction":"stop"}',
  ]) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'La acción no puede repetirse en el mismo JSON.' });
    assert.deepEqual(commandCalls(f.meld), []);
    assert.deepEqual(await current(f.api), before);
    assert.deepEqual(await list(f.api), beforeList);
  }
  const valid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"\\u0061ction":"start"}' });
  assert.equal(valid.status, 200); assert.deepEqual(await valid.json(), { requested: 'start', streaming: null });
  assert.deepEqual(commandCalls(f.meld), [[12, 'meld.startStreamingAction']]);
});
