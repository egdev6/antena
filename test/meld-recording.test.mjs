// #159: acciones reales solo contra Meld sintético; las confirmaciones se controlan por separado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeldRecording, recordingClock } from './helpers/fake-meld-recording.mjs';

const START = 'meld.startStreamingAction', STOP = 'meld.stopStreamingAction';
const RECORD = 'meld.startRecordingAction', END_RECORD = 'meld.stopRecordingAction';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`No llegó: ${label}`); await tick(); }
}
function nextWhere(emitter, event, predicate) {
  return new Promise(resolve => {
    const on = value => { if (predicate(value)) { emitter.off(event, on); resolve(value); } };
    emitter.on(event, on);
  });
}
async function setup(t, { initial, ...options } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-recording-'));
  const dataDir = path.join(dir, 'data'), mediaDir = path.join(dir, 'media');
  await mkdir(dataDir);
  if (initial) await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(initial));
  const meld = fakeMeldRecording(options), clock = recordingClock();
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
  app = await createApp({ dataDir, mediaDir, push: {}, log: () => {}, recordingTimers: clock.timers });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    return { status: res.status, body: await res.json() };
  };
  const connect = async () => {
    const ready = nextWhere(app.meld, 'status', s => s.state === 'conectado');
    const result = await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
    assert.equal(result.status, 200); await ready;
  };
  const report = async values => {
    const received = nextWhere(app.meld, 'status', s => s.state === 'conectado'
      && (!Object.hasOwn(values, 'streaming') || s.streaming === !!values.streaming)
      && (!Object.hasOwn(values, 'recording') || s.recording === !!values.recording));
    meld.report(values); await received;
    // Barrera pública en el mismo WebSocket: las órdenes previas ya llegaron al simulador.
    assert.deepEqual(await api('POST', '/api/meld/call', { method: 'registerTrackObserver', args: ['recording-test', 'synthetic'] }),
      { status: 200, body: { result: null } });
  };
  const calls = () => meld.state.calls.filter(c => c[0] === 12).map(c => c[1]);
  const expectCalls = async expected => { await until(() => calls().length >= expected.length, expected.join(',')); assert.deepEqual(calls(), expected); };
  const stream = action => api('POST', '/api/meld/stream', { action });
  const config = async value => api('PUT', '/api/config', { meld: { recordOnStart: value } });
  const session = async () => (await api('GET', '/api/session')).body;
  const sessions = async () => (await api('GET', '/api/sessions')).body;
  return { app, meld, clock, base, api, connect, report, calls, expectCalls, stream, config, session, sessions, dataDir, mediaDir };
}
const enabled = { meld: { recordOnStart: true, autoSession: false } };
async function startOwned(f) {
  assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
  await f.report({ recording: true });
}

test('setting: legacy/default false, validated writes, persistence and rejected inputs do not change public state', async t => {
  const f = await setup(t, { initial: { meld: { autoSession: false } } });
  await f.connect();
  assert.equal((await f.api('GET', '/api/config')).body.meld.recordOnStart, false);
  assert.equal((await f.api('GET', '/api/status')).body.meld.recordingKnown, true);
  const before = await f.session(), archives = await f.sessions();
  for (const [method, url, body] of [
    ['PUT', '/api/config', { meld: { recordOnStart: 'sí' } }],
    ['PUT', '/api/config', { meld: { recordOnStart: null } }],
    ['POST', '/api/config/set', { path: 'meld.recordOnStart', value: 1 }],
    ['POST', '/api/config/set', { path: 'meld.recordOnStart', value: null }],
  ]) {
    assert.deepEqual(await f.api(method, url, body), { status: 400, body: { error: 'meld.recordOnStart: se esperaba true o false' } });
    assert.equal((await f.api('GET', '/api/config')).body.meld.recordOnStart, false);
    assert.deepEqual(await f.session(), before); assert.deepEqual(await f.sessions(), archives); assert.deepEqual(f.calls(), []);
  }
  assert.equal((await f.config(true)).body.config.meld.recordOnStart, true);
  const other = await createApp({ dataDir: f.dataDir, mediaDir: f.mediaDir, push: {}, log: () => {} });
  try {
    await new Promise(resolve => other.server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${other.server.address().port}/api/config?path=meld.recordOnStart`, { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: 'meld.recordOnStart', value: true });
  } finally { await other.closeHttp(); }
});

test('setting alone through both public writers keeps connection; old Meld fields retain restart behavior', async t => {
  const f = await setup(t); await f.connect();
  let disconnected = 0;
  f.app.meld.on('status', st => { if (st.state !== 'conectado') disconnected++; });
  let result = await f.api('PUT', '/api/config', { meld: { recordOnStart: true }, overlay: { volume: 0.8 } });
  assert.equal(result.status, 200); assert.equal(result.body.config.meld.recordOnStart, true);
  assert.equal(result.body.config.overlay.volume, 0.8);
  assert.deepEqual(await f.api('POST', '/api/config/set', { path: 'meld.recordOnStart', value: false }),
    { status: 200, body: { path: 'meld.recordOnStart', value: false } });
  assert.equal(disconnected, 0); assert.equal((await f.api('GET', '/api/status')).body.meld.state, 'conectado');
  // The draft merges pending fields: other Meld changes alongside the new one still reconnect.
  const ready = nextWhere(f.app.meld, 'status', s => s.state === 'conectado');
  result = await f.api('PUT', '/api/config', { meld: { autoSession: false, recordOnStart: true } });
  assert.equal(result.status, 200); await ready; assert.ok(disconnected > 0);
  const before = disconnected;
  const readyAgain = nextWhere(f.app.meld, 'status', s => s.state === 'conectado');
  assert.deepEqual(await f.api('POST', '/api/config/set', { path: 'meld.autoSession', value: true }),
    { status: 200, body: { path: 'meld.autoSession', value: true } });
  await readyAgain; assert.ok(disconnected > before); assert.deepEqual(f.calls(), []);
});

test('default off and an external start never issue recording commands', async t => {
  const f = await setup(t, { initial: { meld: { autoSession: false } } }); await f.connect();
  assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  await f.report({ streaming: true }); await f.expectCalls([START]);
  await f.report({ streaming: false });
  assert.equal((await f.config(true)).status, 200);
  await f.report({ streaming: true }); await f.report({ streaming: false });
  assert.deepEqual(f.calls(), [START]);
});

test('start intent precedes stream RPC acknowledgement; Meld streaming confirmation precedes recording', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === START ? original(command).then(() => gate) : original(command);
  const response = f.stream('start');
  try {
    await f.expectCalls([START]);
    assert.deepEqual(f.calls(), [START], 'RPC acknowledgement is not a stream confirmation');
    await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
    release();
    assert.deepEqual(await response, { status: 200, body: { requested: 'start', streaming: false } });
    await f.report({ streaming: true });
    assert.deepEqual(f.calls(), [START, RECORD]);
  } finally { release(); await response.catch(() => {}); }
});

test('already recording or unknown recording is never taken over', async t => {
  for (const initialRecording of [true, null]) {
    const f = await setup(t, { initial: enabled, recording: initialRecording }); await f.connect();
    assert.equal((await f.api('GET', '/api/status')).body.meld.recordingKnown, initialRecording !== null);
    assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
    await f.report({ streaming: true });
    assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
    await f.report({ streaming: false }); await f.expectCalls([START, STOP]);
  }
});

test('only confirmed owned recording stops, after antena stream stop confirmation, once', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
  assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
  const session = await f.session(), archives = await f.sessions();
  assert.deepEqual(await f.stream('stop'), { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación de Meld.' } });
  assert.deepEqual(await f.session(), session); assert.deepEqual(await f.sessions(), archives);
  await f.expectCalls([START, RECORD, STOP]);
  await f.report({ streaming: false }); await f.expectCalls([START, RECORD, STOP, END_RECORD]);
  await f.report({ recording: false }); await f.report({ streaming: false, recording: false });
  assert.deepEqual(f.calls(), [START, RECORD, STOP, END_RECORD]);
});

test('recording acknowledgement and later state are both required before ownership', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === RECORD ? original(command).then(() => gate) : original(command);
  try {
    assert.equal((await f.stream('start')).status, 200);
    await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
    await f.report({ recording: true });
    assert.equal((await f.stream('stop')).status, 200);
    await f.report({ streaming: false }); release(); await tick();
    await f.expectCalls([START, RECORD, STOP]);
  } finally { release(); }
});

test('external stream stop never authorizes stopping an owned recording', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
  await f.report({ streaming: false }); await f.report({ streaming: true });
  assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
  await f.report({ streaming: false }); await f.expectCalls([START, RECORD, STOP]);
});

test('a generic streaming command supersedes the pending antena intent', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  assert.deepEqual(await f.api('POST', '/api/meld/command', { command: START }), { status: 200, body: { ok: true } });
  await f.report({ streaming: true }); await f.expectCalls([START, START]);
});

test('a manual recording command supersedes ownership before its status arrives', async t => {
  for (const [endpoint, body, manual, expected] of [
    ['/api/meld/command', { command: 'meld.toggleRecordingAction' }, 'meld.toggleRecordingAction', { ok: true }],
    ['/api/meld/call', { method: 'sendCommand', args: ['meld.stopRecordingAction'] }, 'meld.stopRecordingAction', { result: null }],
  ]) {
    const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
    const before = await f.session();
    assert.deepEqual(await f.api('POST', endpoint, body), { status: 200, body: expected });
    assert.deepEqual(await f.session(), before);
    assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
    await f.report({ streaming: false }); await f.expectCalls([START, RECORD, manual, STOP]);
  }
});

test('observed manual stop or unknown recording revokes ownership permanently', async t => {
  for (const recording of [false, null]) {
    const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
    await f.report({ recording }); await f.report({ recording: true });
    assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
    await f.report({ streaming: false }); await f.expectCalls([START, RECORD, STOP]);
  }
});

test('disconnect and a late recording confirmation cannot resurrect ownership', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  assert.equal((await f.stream('start')).status, 200); await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
  assert.equal((await f.api('POST', '/api/meld/disconnect')).status, 200);
  assert.equal((await f.api('GET', '/api/status')).body.meld.recordingKnown, false);
  await f.connect();
  await f.report({ recording: true, streaming: true });
  assert.equal((await f.stream('stop')).status, 200); await f.report({ streaming: false });
  await f.expectCalls([START, RECORD, STOP]);
});

test('an absent recording property stays unknown until Meld supplies a boolean', async t => {
  const f = await setup(t, { initial: enabled, omitRecording: true }); await f.connect();
  const status = (await f.api('GET', '/api/status')).body.meld;
  assert.equal(status.recording, false); assert.equal(status.recordingKnown, false);
  assert.equal((await f.stream('start')).status, 200); await f.report({ streaming: true });
  assert.deepEqual(f.calls(), [START]);
  assert.match((await f.api('GET', '/api/status')).body.meld.recordingWarning, /no informa/i);
});

test('unknown stream before request and unknown/late confirmation never start recording', async t => {
  const f = await setup(t, { initial: enabled, streaming: null }); await f.connect();
  assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: null } });
  await f.report({ streaming: true }); await f.expectCalls([START]);
});

test('recording RPC failure is nonfatal and visible via status, snapshot and SSE', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  const abort = new AbortController();
  const sse = await fetch(`${f.base}/api/stream?client=panel`, { signal: abort.signal });
  const reader = sse.body.getReader();
  const event = (async () => {
    let data = '';
    while (!data.includes('No se pudo iniciar la grabación')) {
      const next = await reader.read(); if (next.done) throw new Error('SSE cerrado'); data += new TextDecoder().decode(next.value);
    }
    return data;
  })();
  event.catch(() => {});
  try {
    const original = f.app.meld.command.bind(f.app.meld);
    f.app.meld.command = command => command === RECORD ? Promise.reject(new Error('fallo simulado')) : original(command);
    assert.equal((await f.stream('start')).status, 200); await f.report({ streaming: true });
    await until(() => !!f.app.meld.status.recordingWarning, 'aviso de grabación');
    const status = (await f.api('GET', '/api/status')).body.meld;
    assert.equal(status.streaming, true); assert.equal(status.recording, false);
    assert.equal(status.recordingWarning, 'No se pudo iniciar la grabación en Meld. Comprueba la grabación.');
    assert.equal((await f.api('GET', '/api/state')).body.status.meld.recordingWarning, status.recordingWarning);
    assert.match(await event, /event: status/); assert.deepEqual(f.calls(), [START]);
  } finally { abort.abort(); await event.catch(() => {}); }
});

test('missing recording confirmation expires without retry or late ownership', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  assert.equal((await f.stream('start')).status, 200); await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
  assert.ok(f.clock.expire() > 0, 'the confirmation deadline is injectable');
  assert.match((await f.api('GET', '/api/status')).body.meld.recordingWarning, /no confirm[oó]/i);
  await f.report({ recording: true });
  assert.equal((await f.stream('stop')).status, 200); await f.report({ streaming: false });
  await f.expectCalls([START, RECORD, STOP]);
});

test('superseding stop or expired stream intent cannot claim a late recording', async t => {
  for (const supersede of [true, false]) {
    const f = await setup(t, { initial: enabled }); await f.connect();
    assert.equal((await f.stream('start')).status, 200);
    if (supersede) {
      await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
      assert.equal((await f.stream('stop')).status, 200);
      await f.report({ recording: true }); await f.report({ streaming: false });
      await f.expectCalls([START, RECORD, STOP]);
    } else {
      assert.ok(f.clock.expire() > 0);
      await f.report({ streaming: true }); await f.expectCalls([START]);
    }
  }
});

test('an owned recording warns if the pending antena stop becomes unknown or expires', async t => {
  for (const unknown of [true, false]) {
    const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
    assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
    if (unknown) await f.report({ streaming: null });
    else assert.ok(f.clock.expire() > 0);
    const status = (await f.api('GET', '/api/status')).body.meld;
    assert.equal(status.recordingWarning, 'No se pudo comprobar si detener la grabación. Comprueba la grabación en Meld.');
    await f.report({ streaming: false }); await f.expectCalls([START, RECORD, STOP]);
  }
});

test('stop recording failure or missing confirmation warns without retrying or restarting the stream', async t => {
  for (const fail of [true, false]) {
    const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
    const original = f.app.meld.command.bind(f.app.meld);
    f.app.meld.command = command => fail && command === END_RECORD ? Promise.reject(new Error('fallo simulado')) : original(command);
    assert.equal((await f.stream('stop')).status, 200); await f.report({ streaming: false });
    if (fail) await until(() => !!f.app.meld.status.recordingWarning, 'fallo al detener');
    else { await f.expectCalls([START, RECORD, STOP, END_RECORD]); assert.ok(f.clock.expire() > 0); }
    const status = (await f.api('GET', '/api/status')).body.meld;
    assert.equal(status.streaming, false); assert.match(status.recordingWarning, /grabaci[oó]n/i);
    await f.report({ recording: false });
    assert.deepEqual(f.calls(), fail ? [START, RECORD, STOP] : [START, RECORD, STOP, END_RECORD]);
  }
});

test('a late stream RPC failure cannot hide a subsequent recording-stop failure', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect(); await startOwned(f);
  let rejectStream, rejectRecording;
  const streamGate = new Promise((_resolve, reject) => { rejectStream = reject; });
  const recordGate = new Promise((_resolve, reject) => { rejectRecording = reject; });
  streamGate.catch(() => {}); recordGate.catch(() => {});
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === STOP ? original(command).then(() => streamGate)
    : command === END_RECORD ? original(command).then(() => recordGate) : original(command);
  const response = f.stream('stop');
  try {
    await f.expectCalls([START, RECORD, STOP]);
    await f.report({ streaming: false }); await f.expectCalls([START, RECORD, STOP, END_RECORD]);
    rejectStream(new Error('stream RPC falló'));
    assert.deepEqual(await response, { status: 500, body: { error: 'stream RPC falló' } });
    rejectRecording(new Error('record RPC falló'));
    await until(() => !!f.app.meld.status.recordingWarning, 'fallo de grabación tras RPC de emisión');
    assert.equal((await f.api('GET', '/api/status')).body.meld.recordingWarning,
      'No se pudo detener la grabación en Meld. Comprueba la grabación.');
    assert.deepEqual(f.calls(), [START, RECORD, STOP, END_RECORD]);
  } finally {
    rejectStream(new Error('fin')); rejectRecording(new Error('fin')); await response.catch(() => {});
  }
});

test('automatic session starts and ends exactly once; autoSession off preserves the current session', async t => {
  for (const autoSession of [true, false]) {
    const f = await setup(t, { initial: { meld: { autoSession, recordOnStart: true } } }); await f.connect();
    const before = await f.session(), list = await f.sessions(); let resets = 0, ends = 0;
    f.app.session.on('change', change => { if (change?.reset) resets++; if (change?.ended) ends++; });
    await startOwned(f); await f.report({ streaming: true, recording: true });
    await until(() => !autoSession || resets === 1, 'sesión automática');
    assert.equal((await f.stream('stop')).status, 200); await f.report({ streaming: false });
    await f.expectCalls([START, RECORD, STOP, END_RECORD]); await f.report({ recording: false });
    await until(() => !autoSession || ends === 1, 'cierre automático');
    if (autoSession) {
      await f.app.drainAutoSession();
      const after = await f.session(), history = await f.sessions();
      assert.equal(resets, 1); assert.equal(ends, 1); assert.notEqual(after.id, before.id);
      assert.equal(history.current.id, after.id); assert.equal(history.past.length, list.past.length + 1);
      assert.equal(history.past[0].id, before.id);
    } else { assert.equal(resets, 0); assert.equal(ends, 0); assert.deepEqual(await f.session(), before); assert.deepEqual(await f.sessions(), list); }
  }
});

test('S2: turning off the setting before confirmation suppresses the recording request', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  assert.deepEqual(await f.api('POST', '/api/config/set', { path: 'meld.recordOnStart', value: false }),
    { status: 200, body: { path: 'meld.recordOnStart', value: false } });
  assert.equal((await f.api('GET', '/api/config?path=meld.recordOnStart')).body.value, false);
  await f.report({ streaming: true });
  assert.deepEqual(f.calls(), [START]);
});

test('S2: late stream RPC failure cannot revoke an already confirmed owned recording', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let reject;
  const gate = new Promise((_, no) => { reject = no; }); gate.catch(() => {});
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === START ? original(command).then(() => gate) : original(command);
  const pending = f.stream('start'); pending.catch(() => {});
  try {
    await f.expectCalls([START]);
    await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
    await f.report({ recording: true });
    reject(new Error('Meld no responde'));
    assert.deepEqual(await pending, { status: 500, body: { error: 'Meld no responde' } });
    assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
    await f.report({ streaming: false });
    assert.deepEqual(f.calls(), [START, RECORD, STOP, END_RECORD]);
  } finally { reject(new Error('fin')); await pending.catch(() => {}); }
});

test('S2: an accepted equivalent setting path does not reconnect Meld', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let disconnected = 0;
  f.app.meld.on('status', st => { if (st.state !== 'conectado') disconnected++; });
  assert.deepEqual(await f.api('POST', '/api/config/set', { path: 'meld..recordOnStart', value: false }),
    { status: 200, body: { path: 'meld..recordOnStart', value: false } });
  assert.equal((await f.api('GET', '/api/config?path=meld.recordOnStart')).body.value, false);
  assert.equal(disconnected, 0);
});

test('S2: lost recording RPC response warns even after recording state turns true', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let reject;
  const gate = new Promise((_, no) => { reject = no; }); gate.catch(() => {});
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === RECORD ? original(command).then(() => gate) : original(command);
  try {
    assert.equal((await f.stream('start')).status, 200);
    await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
    await f.report({ recording: true }); reject(new Error('Meld no responde'));
    await until(() => !!f.app.meld.status.recordingWarning, 'warning');
    const status = (await f.api('GET', '/api/status')).body.meld;
    assert.equal(status.streaming, true); assert.equal(status.recording, true);
    assert.equal(status.recordingWarning, 'No se pudo iniciar la grabación en Meld. Comprueba la grabación.');
    assert.equal((await f.api('GET', '/api/state')).body.status.meld.recordingWarning, status.recordingWarning);
    assert.deepEqual(f.calls(), [START, RECORD]);
  } finally { reject(new Error('fin')); }
});

test('S2: restoring the setting before confirmation still requests recording', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  assert.deepEqual(await f.stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  for (const value of [false, true]) {
    assert.deepEqual(await f.api('POST', '/api/config/set', { path: 'meld.recordOnStart', value }),
      { status: 200, body: { path: 'meld.recordOnStart', value } });
  }
  await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
});

test('S2: late start RPC failure cannot cancel a pending owned-recording stop', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let reject;
  const gate = new Promise((_, no) => { reject = no; }); gate.catch(() => {});
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === START ? original(command).then(() => gate) : original(command);
  const pending = f.stream('start'); pending.catch(() => {});
  try {
    await f.expectCalls([START]);
    await f.report({ streaming: true }); await f.expectCalls([START, RECORD]);
    await f.report({ recording: true });
    assert.deepEqual(await f.stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
    reject(new Error('Meld no responde'));
    assert.deepEqual(await pending, { status: 500, body: { error: 'Meld no responde' } });
    await f.report({ streaming: false });
    assert.deepEqual(f.calls(), [START, RECORD, STOP, END_RECORD]);
  } finally { reject(new Error('fin')); await pending.catch(() => {}); }
});

test('S2: accepted dotted variants of the recording setting keep the connection', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let reconnects = 0;
  f.meld.server.on('upgrade', () => { reconnects++; });
  for (const [path, value] of [['..meld..recordOnStart..', false], ['meld.recordOnStart..', true], ['meld...recordOnStart', false]]) {
    assert.deepEqual(await f.api('POST', '/api/config/set', { path, value }), { status: 200, body: { path, value } });
    assert.equal((await f.api('GET', '/api/config?path=meld.recordOnStart')).body.value, value);
    assert.equal((await f.api('GET', '/api/status')).body.meld.state, 'conectado');
    await f.report({ streaming: false });
    assert.equal(reconnects, 0);
  }
  assert.deepEqual(f.calls(), []);
});

test('S2: changing another Meld setting through config/set still reconnects', async t => {
  const f = await setup(t, { initial: enabled }); await f.connect();
  let reconnects = 0;
  f.meld.server.on('upgrade', () => { reconnects++; });
  assert.deepEqual(await f.api('POST', '/api/config/set', { path: 'meld.autoSession', value: true }),
    { status: 200, body: { path: 'meld.autoSession', value: true } });
  assert.equal((await f.api('GET', '/api/config?path=meld.autoSession')).body.value, true);
  await until(() => reconnects > 0, 'reconexión a Meld');
  const deadline = Date.now() + 3000;
  let state;
  do {
    state = (await f.api('GET', '/api/status')).body.meld.state;
    if (state !== 'conectado') await tick();
  } while (state !== 'conectado' && Date.now() < deadline);
  assert.equal(state, 'conectado');
  assert.equal(reconnects, 1);
  assert.deepEqual(f.calls(), []);
});
