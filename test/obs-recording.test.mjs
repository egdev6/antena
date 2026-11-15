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
  const deadline = Date.now() + 6000;
  while (!(await check())) { assert.ok(Date.now() < deadline, label); await delay(10); }
}
async function fixture(t, { recordOnStart = true, waitReady = true, delayStatus = 0, ...options } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-recording-'));
  const fake = fakeObs(options), sockets = new Set();
  fake.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  let app;
  t.after(async () => {
    if (app) {
      await app.drainAutoSession(); await app.session.flush();
      await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
    }
    await fake.close(); await rm(root, { recursive: true, force: true });
  });
  await listen(fake.server);
  if (delayStatus) fake.delayRequest('GetRecordStatus', delayStatus);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const status = async () => (await api('GET', '/api/status')).body.meld;
  const calls = () => fake.requests.filter(r => /^(Start|Stop|Toggle)(Stream|Record)$/.test(r.requestType)).map(r => r.requestType);
  const stream = action => api('POST', '/api/program/stream', { action });
  const command = (command, route = '/api/meld/command') => api('POST', route, { command });
  const recordEvent = async (state, active, outputPath = null) => {
    fake.emit('RecordStateChanged', { outputActive: active, outputState: `OBS_WEBSOCKET_OUTPUT_${state}`, outputPath });
    assert.deepEqual(await api('POST', '/api/program/scene', { scene: 'Camera' }), { status: 200, body: { scene: 'Camera' } });
  };
  assert.equal((await api('PUT', '/api/config', { program: { kind: 'obs' },
    obs: { url: `ws://127.0.0.1:${fake.server.address().port}` }, meld: { autoSession: false, recordOnStart } })).status, 200);
  if (waitReady) await until(async () => (await status()).state === 'conectado', 'OBS ready');
  return { app, fake, api, status, calls, stream, command, recordEvent,
    drop: () => { for (const socket of sockets) socket.destroy(); } };
}
const ok = { status: 200, body: { ok: true } };
const started = { status: 200, body: { requested: 'start', streaming: false } };
const stopped = { status: 200, body: { requested: 'stop', streaming: true } };
async function startOwned(f) {
  assert.deepEqual(await f.stream('start'), started);
  await until(async () => (await f.status()).recording && f.calls().includes('StartRecord'), 'owned recording');
}

test('public command aliases map start, stop and toggle to OBS; rejections do not change the output', async t => {
  const f = await fixture(t, { recordOnStart: false });
  for (const [command, route, recording] of [
    ['meld.startRecordingAction', '/api/meld/command', true],
    ['meld.stopRecordingAction', '/api/program/command', false],
    ['meld.toggleRecordingAction', '/api/meld/command', true],
    ['meld.toggleRecordingAction', '/api/program/command', false],
  ]) {
    assert.deepEqual(await f.command(command, route), ok);
    assert.deepEqual([(await f.status()).recording, (await f.status()).recordingKnown], [recording, true]);
  }
  const before = await f.api('GET', '/api/program');
  assert.deepEqual(await f.command('meld.stopRecordingAction'), { status: 500, body: { error: 'OBS rechazó la petición «StopRecord».' } });
  assert.deepEqual(await f.api('GET', '/api/program'), before);
  assert.deepEqual(await f.command('meld.startRecordingAction'), ok);
  const active = await f.api('GET', '/api/program');
  assert.deepEqual(await f.command('meld.startRecordingAction'), { status: 500, body: { error: 'OBS rechazó la petición «StartRecord».' } });
  assert.deepEqual(await f.api('GET', '/api/program'), active);
  assert.deepEqual(f.calls(), ['StartRecord', 'StopRecord', 'ToggleRecord', 'ToggleRecord', 'StopRecord', 'StartRecord', 'StartRecord']);
  assert.ok(f.fake.requests.filter(r => /^(Start|Stop|Toggle)Record$/.test(r.requestType)).every(r => Object.keys(r.requestData).length === 0));
  assert.equal(JSON.stringify(active).includes('/fake-recording.mkv'), false);
});

test('record state transitions preserve confirmed booleans; pause still means an active recording', async t => {
  const f = await fixture(t, { recordOnStart: false });
  for (const [event, active, expected] of [
    ['STARTING', false, false], ['STARTED', true, true], ['STARTING', false, true],
    ['PAUSED', false, true], ['RESUMED', true, true], ['STOPPING', false, true],
    ['STOPPED', false, false], ['STOPPING', false, false], ['FUTURE_STATE', false, false],
  ]) {
    await f.recordEvent(event, active, event === 'STOPPED' ? '/fake-recording.mkv' : null);
    const status = await f.status();
    assert.deepEqual([status.state, status.recording, status.recordingKnown], ['conectado', expected, true], event);
    assert.equal(JSON.stringify(await f.api('GET', '/api/program')).includes('/fake-recording.mkv'), false);
  }
});

test('record-on-start waits for both confirmed outputs, then stops only the owned recording', async t => {
  const f = await fixture(t, { deferStreamConfirmation: true, deferRecordConfirmation: true });
  assert.deepEqual(await f.stream('start'), started);
  assert.deepEqual(f.calls(), ['StartStream']);
  assert.deepEqual([(await f.status()).streaming, (await f.status()).recording], [false, false]);
  f.fake.confirmStream();
  await until(() => f.calls().includes('StartRecord'), 'StartRecord');
  assert.deepEqual([(await f.status()).streaming, (await f.status()).recording, (await f.status()).recordingKnown], [true, false, true]);
  f.fake.confirmRecord();
  await until(async () => (await f.status()).recording, 'record started');
  await f.recordEvent('PAUSED', false);
  assert.equal((await f.status()).recording, true);
  assert.deepEqual(await f.stream('stop'), stopped);
  assert.deepEqual(f.calls(), ['StartStream', 'StartRecord', 'StopStream']);
  assert.deepEqual([(await f.status()).streaming, (await f.status()).recording], [true, true]);
  f.fake.confirmStream();
  await until(() => f.calls().includes('StopRecord'), 'StopRecord');
  assert.deepEqual([(await f.status()).streaming, (await f.status()).recording, (await f.status()).recordingKnown], [false, true, true]);
  f.fake.confirmRecord();
  await until(async () => !(await f.status()).recording, 'record stopped');
  assert.deepEqual(f.calls(), ['StartStream', 'StartRecord', 'StopStream', 'StopRecord']);
  assert.equal((await f.status()).recordingWarning, null);
});

test('pre-existing recording, externally started streams and disabled setting are never taken over', async t => {
  const existing = await fixture(t, { recording: true });
  assert.deepEqual([(await existing.status()).recording, (await existing.status()).recordingKnown], [true, true]);
  assert.deepEqual(await existing.stream('start'), started);
  assert.deepEqual(await existing.stream('stop'), stopped);
  assert.deepEqual(existing.calls(), ['StartStream', 'StopStream']);
  assert.equal((await existing.status()).recording, true);
  const external = await fixture(t);
  assert.deepEqual(await external.command('meld.toggleStreamingAction'), ok);
  assert.deepEqual(await external.command('meld.toggleStreamingAction'), ok);
  assert.deepEqual(external.calls(), ['ToggleStream', 'ToggleStream']);
  const disabled = await fixture(t, { recordOnStart: false });
  assert.deepEqual(await disabled.stream('start'), started);
  assert.deepEqual(await disabled.stream('stop'), stopped);
  assert.deepEqual(disabled.calls(), ['StartStream', 'StopStream']);
});

test('a manual recording command revokes ownership before the RPC, including a rejected command', async t => {
  for (const rejected of [false, true]) {
    const f = await fixture(t); await startOwned(f);
    if (rejected) {
      assert.deepEqual(await f.command('meld.startRecordingAction'), { status: 500, body: { error: 'OBS rechazó la petición «StartRecord».' } });
    } else {
      assert.deepEqual(await f.command('meld.toggleRecordingAction'), ok);
      assert.deepEqual(await f.command('meld.toggleRecordingAction'), ok);
    }
    assert.equal((await f.status()).recording, true);
    assert.deepEqual(await f.stream('stop'), stopped);
    assert.equal((await f.status()).recording, true);
    assert.deepEqual(f.calls(), rejected ? ['StartStream', 'StartRecord', 'StartRecord', 'StopStream']
      : ['StartStream', 'StartRecord', 'ToggleRecord', 'ToggleRecord', 'StopStream']);
  }
});

test('failed recording start or stop warns without changing streaming or retrying', async t => {
  const start = await fixture(t);
  start.fake.failRequest('StartRecord');
  assert.deepEqual(await start.stream('start'), started);
  await until(async () => !!(await start.status()).recordingWarning, 'start warning');
  assert.deepEqual([(await start.status()).streaming, (await start.status()).recording, (await start.status()).recordingWarning],
    [true, false, 'No se pudo iniciar la grabación en Meld. Comprueba la grabación.']);
  assert.deepEqual(await start.stream('stop'), stopped);
  assert.deepEqual(start.calls(), ['StartStream', 'StartRecord', 'StopStream']);
  const stop = await fixture(t); await startOwned(stop);
  stop.fake.failRequest('StopRecord');
  assert.deepEqual(await stop.stream('stop'), stopped);
  await until(async () => !!(await stop.status()).recordingWarning, 'stop warning');
  assert.deepEqual([(await stop.status()).streaming, (await stop.status()).recording, (await stop.status()).recordingWarning],
    [false, true, 'No se pudo detener la grabación en Meld. Comprueba la grabación.']);
  assert.deepEqual(stop.calls(), ['StartStream', 'StartRecord', 'StopStream', 'StopRecord']);
});

test('disconnect revokes recording ownership and reconnect waits for confirmed recording status', async t => {
  const f = await fixture(t); await startOwned(f);
  f.fake.failRequest('GetRecordStatus');
  f.drop();
  await until(async () => (await f.status()).error === 'OBS no informó el estado de la grabación.', 'failed record status');
  let status = await f.status();
  assert.deepEqual([status.state, status.recording, status.recordingKnown], ['reintentando', false, false]);
  f.fake.failRequest('GetRecordStatus', null);
  await until(async () => (await f.status()).state === 'conectado', 'reconnected');
  status = await f.status();
  assert.deepEqual([status.streaming, status.recording, status.recordingKnown], [true, true, true]);
  assert.deepEqual(await f.stream('stop'), stopped);
  assert.equal((await f.status()).recording, true);
  assert.deepEqual(f.calls(), ['StartStream', 'StartRecord', 'StopStream']);
});

test('a transitional recording event during initial status cannot make OBS ready', async t => {
  const f = await fixture(t, { waitReady: false, delayStatus: 200 });
  await until(() => f.fake.requests.some(r => r.requestType === 'GetRecordStatus'), 'record status query');
  f.fake.emit('RecordStateChanged', { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING', outputPath: null });
  await until(async () => ['reintentando', 'conectado'].includes((await f.status()).state), 'first status outcome');
  const status = await f.status();
  assert.deepEqual([status.state, status.recording, status.recordingKnown, status.error],
    ['reintentando', false, false, 'OBS no informó el estado de la grabación.']);
  f.fake.delayRequest('GetRecordStatus', 0);
  await until(async () => (await f.status()).state === 'conectado', 'confirmed retry');
  assert.deepEqual([(await f.status()).recording, (await f.status()).recordingKnown], [false, true]);
});
