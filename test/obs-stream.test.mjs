import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (!(await check())) { assert.ok(Date.now() < deadline, label); await delay(10); }
}
async function fixture(t, { streaming = false, recordOnStart = false, youtube = false, deferStreamConfirmation = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ant-obs-stream-'));
  const fake = fakeObs({ streaming, deferStreamConfirmation }), sockets = new Set();
  fake.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let app, release = () => {};
  t.after(async () => {
    release();
    if (app) {
      await app.drainAutoSession(); await app.session.flush();
      await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
    }
    await fake.close(); await rm(root, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (method, url, body) => {
    const result = await api(method, url, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const session = () => ok('GET', '/api/session');
  const status = async () => (await ok('GET', '/api/status')).meld;
  const streamCalls = () => fake.requests.filter(r => ['StartStream', 'StopStream', 'ToggleStream'].includes(r.requestType));
  const trace = [];
  if (youtube) {
    app.store.config.youtube = { ...app.store.config.youtube, apiKey: 'fake', channelId: 'UCcanal' };
    app.youtube.api = async name => {
      if (name === '/channels') return { items: [] };
      trace.push(name);
      if (name === '/search') return { items: [{ id: { videoId: 'abcdefghijk' } }] };
      if (name === '/videos') return { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-1' }, snippet: { title: 'Directo' } }] };
      throw new Error(`unexpected fake YouTube request: ${name}`);
    };
    app.youtube.poll = () => Promise.resolve();
    const start = app.youtube.start.bind(app.youtube), stop = app.youtube.stop.bind(app.youtube);
    app.youtube.start = (...args) => { trace.push('start'); return start(...args); };
    app.youtube.stop = (...args) => { trace.push('stop'); return stop(...args); };
  }
  await ok('PUT', '/api/config', { program: { kind: 'obs' },
    obs: { url: `ws://127.0.0.1:${fake.server.address().port}` }, meld: { autoSession: true, recordOnStart } });
  await until(async () => (await status()).state === 'conectado', 'OBS connection');
  // A scene request is a WebSocket barrier after injected events.
  const emit = async state => {
    fake.emit('StreamStateChanged', { outputActive: ['STARTED', 'RECONNECTED'].includes(state), outputState: `OBS_WEBSOCKET_OUTPUT_${state}` });
    await ok('POST', '/api/program/scene', { scene: 'Camera' });
  };
  const sessionWhere = async predicate => { let value; await until(async () => { value = await session(); return predicate(value); }, 'session'); return value; };
  return { app, fake, api, ok, session, status, streamCalls, emit, sessionWhere, trace,
    drop: () => { for (const socket of sockets) socket.destroy(); }, setRelease: f => { release = f; } };
}

test('OBS stream routes share one pending guard and wait for confirmed transitions', async t => {
  const f = await fixture(t);
  const initial = await f.session(), history = await f.ok('GET', '/api/sessions');
  for (const invalid of [{ action: 'toggle' }, {}, { action: 'start', extra: 1 }]) {
    assert.deepEqual(await f.api('POST', '/api/program/stream', invalid), { status: 400, body: { error: 'Indica una acción válida: start o stop.' } });
  }
  assert.deepEqual(await f.api('POST', '/api/meld/stream', { action: 'stop' }), { status: 409, body: { error: 'Meld no está emitiendo.' } });
  assert.deepEqual(f.streamCalls(), []); assert.deepEqual(await f.session(), initial); assert.deepEqual(await f.ok('GET', '/api/sessions'), history);
  for (const [startRoute, stopRoute] of [['/api/program/stream', '/api/meld/stream'], ['/api/meld/stream', '/api/program/stream']]) {
    const before = await f.session();
    f.fake.delayRequest('StartStream', 200);
    const starting = f.api('POST', startRoute, { action: 'start' });
    await until(() => f.streamCalls().filter(r => r.requestType === 'StartStream').length === (startRoute.includes('program') ? 1 : 2), 'StartStream request');
    assert.deepEqual(await f.api('POST', stopRoute, { action: 'start' }), { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación de Meld.' } });
    assert.deepEqual(await f.session(), before);
    assert.deepEqual(await starting, { status: 200, body: { requested: 'start', streaming: false } });
    f.fake.delayRequest('StartStream', 0);
    const live = await f.sessionWhere(s => s.id !== before.id && s.meldAutoSession === true);
    assert.equal(live.endedAt, undefined);
    assert.equal((await f.status()).streaming, true);
    assert.deepEqual(await f.api('POST', startRoute, { action: 'start' }), { status: 409, body: { error: 'Meld ya está emitiendo.' } });
    f.fake.delayRequest('StopStream', 200);
    const stopping = f.api('POST', stopRoute, { action: 'stop' });
    await until(() => f.streamCalls().filter(r => r.requestType === 'StopStream').length === (startRoute.includes('program') ? 1 : 2), 'StopStream request');
    assert.deepEqual(await f.api('POST', startRoute, { action: 'stop' }), { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación de Meld.' } });
    assert.deepEqual(await f.session(), live);
    assert.deepEqual(await stopping, { status: 200, body: { requested: 'stop', streaming: true } });
    f.fake.delayRequest('StopStream', 0);
    await f.sessionWhere(s => s.id === live.id && !!s.endedAt);
    assert.equal((await f.status()).streaming, false);
  }
  assert.deepEqual(f.streamCalls(), ['StartStream', 'StopStream', 'StartStream', 'StopStream'].map(requestType => ({ requestType, requestData: {} })));
});

test('acknowledgement without a final OBS event keeps both aliases pending and the session unchanged', async t => {
  const f = await fixture(t, { deferStreamConfirmation: true });
  const initial = await f.session();
  assert.deepEqual(await f.api('POST', '/api/program/stream', { action: 'start' }), { status: 200, body: { requested: 'start', streaming: false } });
  assert.deepEqual(await f.session(), initial); assert.equal((await f.status()).streaming, false);
  assert.deepEqual(await f.api('POST', '/api/meld/stream', { action: 'start' }), { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación de Meld.' } });
  f.fake.confirmStream();
  const live = await f.sessionWhere(s => s.id !== initial.id && s.meldAutoSession === true);
  assert.deepEqual(await f.api('POST', '/api/meld/stream', { action: 'stop' }), { status: 200, body: { requested: 'stop', streaming: true } });
  assert.deepEqual(await f.session(), live); assert.equal((await f.status()).streaming, true);
  assert.deepEqual(await f.api('POST', '/api/program/stream', { action: 'stop' }), { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación de Meld.' } });
  f.fake.confirmStream();
  await f.sessionWhere(s => s.id === live.id && !!s.endedAt);
  assert.deepEqual(f.streamCalls(), [{ requestType: 'StartStream', requestData: {} }, { requestType: 'StopStream', requestData: {} }]);
});

test('confirmed OBS states drive session, live-only timer and YouTube; reconnect is not a stop', async t => {
  const f = await fixture(t, { youtube: true }), initial = await f.session();
  const timer = (await f.ok('POST', '/api/timers', { name: 'Live', message: 'Hola', intervalMin: 1, minChatLines: 0 })).timer;
  const paused = async () => (await f.ok('GET', '/api/timers')).find(row => row.id === timer.id).runtime.pausedOffStream;
  const yt = async () => (await f.ok('GET', '/api/status')).youtube;
  assert.equal(await paused(), true);
  await f.emit('STARTING');
  assert.deepEqual(await f.session(), initial); assert.equal(await paused(), true); assert.deepEqual(f.trace, []);
  await f.emit('STARTED');
  await until(async () => (await yt()).state === 'escuchando', 'YouTube live');
  const live = await f.sessionWhere(s => s.id !== initial.id && s.meldAutoSession === true && s.platforms?.youtube?.videoId === 'abcdefghijk');
  assert.equal(await paused(), false); assert.deepEqual(f.trace.slice(0, 4), ['start', 'stop', '/search', '/videos']);
  await f.emit('RECONNECTING');
  assert.deepEqual(await f.session(), live); assert.equal(await paused(), false);
  assert.equal((await f.status()).streaming, true); assert.equal((await yt()).state, 'escuchando');
  await f.emit('RECONNECTED');
  assert.deepEqual(await f.session(), live); assert.equal(f.trace.filter(x => x === 'start').length, 1);
  await f.emit('STOPPING');
  assert.deepEqual(await f.session(), live); assert.equal(await paused(), false); assert.equal((await yt()).state, 'escuchando');
  await f.emit('STOPPED');
  const ended = await f.sessionWhere(s => s.id === live.id && !!s.endedAt);
  await until(async () => (await yt()).state === 'parado', 'YouTube stopped');
  assert.equal(ended.meldAutoSession, true); assert.equal(await paused(), true);
  assert.equal(f.trace.filter(x => x === 'stop').length, 2); // initial reset plus confirmed stop
});

test('already-live OBS uses status to create an automatic session; manual close then new live creates one successor', async t => {
  const f = await fixture(t, { streaming: true, youtube: true });
  const first = await f.sessionWhere(s => s.meldAutoSession === true && !s.endedAt);
  await until(async () => (await f.ok('GET', '/api/status')).youtube.state === 'escuchando', 'YouTube already-live');
  await f.ok('POST', '/api/program/disconnect', {});
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); f.setRelease(release);
  const flush = f.app.session.flush.bind(f.app.session); let held = false;
  f.app.session.flush = async (...args) => { if (!held) { held = true; enter(); await gate; } return flush(...args); };
  const closing = f.api('POST', '/api/session/end', { id: first.id });
  await Promise.race([entered, closing.then(result => { throw new Error(`manual close not held: ${result.status}`); })]);
  await f.ok('POST', '/api/meld/connect', {});
  await until(async () => (await f.status()).state === 'conectado', 'OBS reconnect');
  release();
  const closed = await closing;
  assert.equal(closed.status, 200); assert.equal(closed.body.session.id, first.id); assert.ok(closed.body.session.endedAt);
  const next = await f.sessionWhere(s => s.id !== first.id && s.meldAutoSession === true && !s.endedAt);
  const history = await f.ok('GET', '/api/sessions');
  assert.equal(history.past.filter(s => s.id === first.id).length, 1);
  const archived = await f.ok('GET', `/api/session/summary?format=json&id=${first.id}`);
  assert.equal(archived.meldAutoSession, true); assert.equal(archived.endedAt, closed.body.session.endedAt);
  assert.notEqual(next.id, first.id);
});

test('failed OBS status after a manual close does not start a session until a live retry', async t => {
  const f = await fixture(t, { streaming: true });
  const first = await f.sessionWhere(s => s.meldAutoSession === true);
  await f.ok('POST', '/api/program/disconnect', {});
  const closed = await f.ok('POST', '/api/session/end', { id: first.id });
  assert.ok(closed.session.endedAt);
  const before = await f.session(), seen = [];
  f.app.program.on('status', status => seen.push({ ...status }));
  f.fake.failRequest('GetStreamStatus');
  await f.ok('POST', '/api/program/connect', {});
  await until(() => seen.some(s => s.state === 'conectado' || s.error === 'OBS no informó el estado de la emisión.'), 'failed OBS status');
  assert.equal(seen.find(s => s.state === 'conectado' || s.error === 'OBS no informó el estado de la emisión.').state, 'reintentando');
  await f.app.session.transitionChain;
  assert.deepEqual(await f.session(), before);
  assert.equal((await f.ok('GET', '/api/sessions')).past.filter(s => s.id === first.id).length, 0);
  f.fake.failRequest('GetStreamStatus', null);
  const next = await f.sessionWhere(s => s.id !== first.id && s.meldAutoSession === true && !s.endedAt);
  assert.equal((await f.ok('GET', '/api/sessions')).past.filter(s => s.id === first.id).length, 1);
  assert.notEqual(next.id, first.id);
});

test('an unknown reconnect does not invent live or end the session; a later live snapshot resumes it', async t => {
  const f = await fixture(t, { streaming: true });
  const first = await f.sessionWhere(s => s.meldAutoSession === true && !s.endedAt);
  const timer = (await f.ok('POST', '/api/timers', { name: 'Live', message: 'Hola', intervalMin: 1, minChatLines: 0 })).timer;
  const row = async () => (await f.ok('GET', '/api/timers')).find(entry => entry.id === timer.id);
  assert.equal((await row()).runtime.pausedOffStream, false);
  f.fake.emit('RecordStateChanged', { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputPath: null });
  await f.ok('POST', '/api/program/scene', { scene: 'Camera' });
  assert.equal((await f.status()).recording, true);
  const seen = [];
  f.app.program.on('status', status => seen.push({ ...status }));
  f.fake.failRequest('GetStreamStatus');
  f.drop();
  await until(() => seen.some(s => s.state === 'conectado' || s.error === 'OBS no informó el estado de la emisión.'), 'failed OBS status');
  const failure = seen.find(s => s.state === 'conectado' || s.error === 'OBS no informó el estado de la emisión.');
  assert.equal(failure.state, 'reintentando');
  const unknown = await f.status();
  assert.deepEqual([unknown.state, unknown.streaming, unknown.streamingKnown, unknown.recording, unknown.recordingKnown], ['reintentando', false, false, false, false]);
  assert.equal((await row()).runtime.pausedOffStream, true);
  await f.app.session.transitionChain;
  const still = await f.session();
  assert.equal(still.id, first.id); assert.equal(still.endedAt, undefined); assert.equal(still.meldAutoSession, true);
  assert.equal((await f.ok('GET', '/api/sessions')).past.filter(s => s.id === first.id).length, 0);
  f.fake.failRequest('GetStreamStatus', null);
  await until(async () => { const s = await f.status(); return s.state === 'conectado' && s.streamingKnown && s.streaming && s.recordingKnown; }, 'confirmed live retry');
  await f.app.session.transitionChain;
  const resumed = await f.session();
  assert.equal(resumed.id, first.id); assert.equal(resumed.endedAt, undefined); assert.equal(resumed.meldAutoSession, true);
  assert.equal((await row()).runtime.pausedOffStream, false);
  assert.equal((await f.ok('GET', '/api/sessions')).past.filter(s => s.id === first.id).length, 0);
});

test('record-on-start warns on OBS failure without interrupting streaming', async t => {
  const f = await fixture(t, { recordOnStart: true });
  f.fake.failRequest('StartRecord');
  const before = await f.session();
  assert.deepEqual(await f.api('POST', '/api/program/stream', { action: 'start' }), { status: 200, body: { requested: 'start', streaming: false } });
  await f.sessionWhere(s => s.id !== before.id && s.meldAutoSession === true);
  await until(async () => !!(await f.status()).recordingWarning, 'recording warning');
  assert.deepEqual([(await f.status()).streaming, (await f.status()).recordingWarning], [true, 'No se pudo iniciar la grabación en Meld. Comprueba la grabación.']);
  assert.deepEqual(f.streamCalls(), [{ requestType: 'StartStream', requestData: {} }]);
  assert.deepEqual(fakeRecordCalls(f.fake), [{ requestType: 'StartRecord', requestData: {} }]);
});
const fakeRecordCalls = fake => fake.requests.filter(r => ['StartRecord', 'StopRecord'].includes(r.requestType));

test('generic streaming commands map to OBS toggle and preserve event order', async t => {
  const f = await fixture(t), seen = [];
  f.app.program.on('streaming', value => seen.push(['streaming', value, f.app.program.status.streaming]));
  f.app.program.on('status', value => { if (value.streamingKnown) seen.push(['status', value.streaming]); });
  assert.deepEqual(await f.api('POST', '/api/program/command', { command: 'meld.toggleStreamingAction' }), { status: 200, body: { ok: true } });
  assert.deepEqual(await f.api('POST', '/api/meld/command', { command: 'meld.toggleStreamingAction' }), { status: 200, body: { ok: true } });
  assert.deepEqual(f.streamCalls(), [{ requestType: 'ToggleStream', requestData: {} }, { requestType: 'ToggleStream', requestData: {} }]);
  assert.deepEqual(seen.filter(e => e[0] === 'streaming'), [['streaming', true, false], ['streaming', false, true]]);
  for (const event of [['streaming', true, false], ['streaming', false, true]]) {
    const index = seen.findIndex(e => JSON.stringify(e) === JSON.stringify(event));
    assert.deepEqual(seen[index + 1], ['status', event[1]]);
  }
});
