import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createProgram } from '../src/programs/index.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { waitFor } from './helpers/program-contract.mjs';

const scenes = [
  { sceneName: 'Camera', sceneUuid: 'cam', sceneItems: [
    { sceneItemId: 7, sourceName: 'Logo', sceneItemEnabled: false },
    { sceneItemId: 8, sourceName: 'Logo', sceneItemEnabled: true },
  ] },
  { sceneName: 'Slides', sceneUuid: 'slides', sceneItems: [
    { sceneItemId: 7, sourceName: 'Video', sceneItemEnabled: true },
  ] },
];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = server => `ws://127.0.0.1:${server.address().port}`;
async function startProgram(t, fake, options = {}) {
  const program = createProgram('obs', { retryDelays: [10, 20], ...options });
  t.after(async () => { await program.quiesceClose(); program.dispose(); });
  const ready = waitFor(program, 'status', status => status.state === 'conectado');
  program.start(url(fake.server)); await ready;
  return program;
}
async function fixture(t) {
  const fake = fakeObs({ scenes });
  t.after(() => fake.close());
  await listen(fake.server);
  return { fake, program: await startProgram(t, fake) };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'observable state did not arrive'); await new Promise(r => setTimeout(r, 5)); }
}

test('input rename events are subscribed and refresh the scene list', async t => {
  const { fake, program } = await fixture(t);
  const before = fake.requests.filter(r => r.requestType === 'GetSceneList').length;
  const published = waitFor(program, 'session');
  fake.emit('InputNameChanged', { inputName: 'Logo', oldInputName: 'Old Logo' });
  assert.deepEqual((await published)[0], program.session());
  assert.equal(fake.requests.filter(r => r.requestType === 'GetSceneList').length, before + 1);
});

test('each scene, item, list and input event publishes exactly one session', async t => {
  const { fake, program } = await fixture(t), snapshots = [];
  program.on('session', session => snapshots.push(session));
  for (const [type, data] of [
    ['CurrentProgramSceneChanged', { sceneName: 'Slides', sceneUuid: 'slides' }],
    ['SceneItemEnableStateChanged', { sceneName: 'Camera', sceneUuid: 'cam', sceneItemId: 7, sceneItemEnabled: true }],
    ['SceneListChanged', { scenes: [] }],
    ['InputNameChanged', { inputName: 'Logo', oldInputName: 'Old Logo' }],
  ]) {
    const before = snapshots.length, published = waitFor(program, 'session');
    fake.emit(type, data);
    await published;
    await program.requestObs('GetVersion'); // Response barrier for queued notifications.
    assert.equal(snapshots.length, before + 1, type);
    assert.deepEqual(snapshots.at(-1), program.session());
  }
});

test('unknown current scene causes exactly one scene-list refresh', async t => {
  const { fake, program } = await fixture(t);
  const before = fake.requests.filter(r => r.requestType === 'GetSceneList').length;
  const published = waitFor(program, 'session');
  fake.emit('CurrentProgramSceneChanged', { sceneName: 'New', sceneUuid: 'new' });
  await published;
  await program.requestObs('GetVersion');
  assert.equal(fake.requests.filter(r => r.requestType === 'GetSceneList').length, before + 1);
  assert.deepEqual(program.session().scenes.map(s => s.name), ['Camera', 'Slides']);
});

test('setLayer uses the new OBS socket after reconnect', async t => {
  const first = fakeObs({ scenes });
  t.after(() => first.close());
  await listen(first.server);
  const port = first.server.address().port;
  const program = await startProgram(t, first, { retryDelays: [100, 200, 300, 400, 500, 600] });
  const retry = waitFor(program, 'status', s => s.state === 'reintentando');
  await first.close(); await retry;
  const second = fakeObs({ scenes });
  t.after(() => second.close());
  await new Promise((resolve, reject) => {
    second.server.once('error', reject);
    second.server.listen(port, '127.0.0.1', resolve);
  });
  await waitFor(program, 'status', s => s.state === 'conectado');
  const oldCount = first.requests.length;
  await program.setLayer('Camera', 'Logo', true);
  assert.equal(first.requests.length, oldCount);
  assert.deepEqual(second.requests.at(-1), { requestType: 'SetSceneItemEnabled',
    requestData: { sceneName: 'Camera', sceneItemId: 7, sceneItemEnabled: true } });
  assert.equal(program.session().scenes[0].layers[0].visible, true);
});

test('OBS scene and item actions use stable scoped ids, names and visibility semantics', async t => {
  const { fake, program } = await fixture(t);
  assert.deepEqual(program.session().scenes, [
    { id: 'cam', name: 'Camera', current: true, layers: [
      { id: 'cam:7', name: 'Logo', visible: false, effects: [] },
      { id: 'cam:8', name: 'Logo', visible: true, effects: [] },
    ] },
    { id: 'slides', name: 'Slides', current: false, layers: [{ id: 'slides:7', name: 'Video', visible: true, effects: [] }] },
  ]);
  const copy = program.session(); copy.scenes[0].layers[0].visible = true;
  assert.equal(program.session().scenes[0].layers[0].visible, false);
  const before = fake.requests.length;
  assert.equal((await program.showScene('SLIDES')).name, 'Slides');
  assert.equal((await program.showScene('cam')).name, 'Camera');
  await program.setLayer('cam', 'cam:8', false);
  await program.setLayer('Camera', 'Logo', true);
  await program.setLayer(null, 'slides:7');
  const count = fake.requests.length;
  await program.setLayer('cam', 'Logo', true);
  assert.equal(fake.requests.length, count, 'explicit existing visibility is a no-op');
  assert.deepEqual(fake.requests.slice(before), [
    { requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Slides' } },
    { requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Camera' } },
    { requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Camera', sceneItemId: 8, sceneItemEnabled: false } },
    { requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Camera', sceneItemId: 7, sceneItemEnabled: true } },
    { requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Slides', sceneItemId: 7, sceneItemEnabled: false } },
  ]);
  assert.deepEqual(program.session().scenes.map(s => s.layers.map(l => l.visible)), [[true, false], [false]]);
  const snapshot = program.session(), calls = fake.requests.length;
  await assert.rejects(program.showScene('missing'), { message: 'No encuentro la escena «missing» en el programa de emisión' });
  await assert.rejects(program.setLayer('missing', 'Logo', true), { message: 'No encuentro la capa «Logo»' });
  await assert.rejects(program.setLayer('Camera', 'missing', true), { message: 'No encuentro la capa «missing»' });
  assert.equal(fake.requests.length, calls); assert.deepEqual(program.session(), snapshot);
});

test('OBS scene, item and list events publish the same current session shape', async t => {
  const { fake, program } = await fixture(t);
  let event = waitFor(program, 'session', s => s.scenes[1].current);
  fake.emit('CurrentProgramSceneChanged', { sceneName: 'Slides', sceneUuid: 'slides' });
  assert.deepEqual((await event)[0], program.session());
  assert.deepEqual(program.session().scenes.map(s => s.current), [false, true]);
  event = waitFor(program, 'session', s => s.scenes[0].layers[0].visible);
  fake.emit('SceneItemEnableStateChanged', { sceneName: 'Camera', sceneUuid: 'cam', sceneItemId: 7, sceneItemEnabled: true });
  assert.deepEqual((await event)[0], program.session());
  assert.deepEqual(program.session().scenes[0].layers.map(l => l.visible), [true, true]);
  const before = fake.requests.filter(r => r.requestType === 'GetSceneList').length;
  event = waitFor(program, 'session');
  fake.emit('SceneListChanged', { scenes: [] });
  assert.deepEqual((await event)[0], program.session());
  assert.equal(fake.requests.filter(r => r.requestType === 'GetSceneList').length, before + 1);
  assert.deepEqual(program.session().scenes.map(s => s.current), [true, false]);
});

test('external scene creation and removal refresh the actual OBS scene list', async t => {
  const { fake, program } = await fixture(t), messages = new Map(), snapshots = [];
  const socket = new WebSocket(url(fake.server), 'obswebsocket.json');
  t.after(() => socket.close());
  let identified;
  const ready = new Promise(resolve => { identified = resolve; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.op === 0) socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1 } }));
    if (message.op === 2) identified();
    if (message.op === 7) messages.get(message.d.requestId)?.(message.d);
  };
  await ready;
  let id = 0;
  const request = (requestType, requestData) => new Promise(resolve => {
    const requestId = String(++id); messages.set(requestId, resolve);
    socket.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } }));
  });
  program.on('session', session => snapshots.push(session));
  assert.equal((await request('CreateScene', { sceneName: 'Overlay' })).requestStatus.result, true);
  await until(() => program.session().scenes.some(s => s.name === 'Overlay'));
  assert.deepEqual(program.session().scenes.find(s => s.name === 'Overlay').layers, []);
  assert.deepEqual(snapshots.at(-1), program.session());
  assert.equal((await request('RemoveScene', { sceneName: 'Overlay' })).requestStatus.result, true);
  await until(() => !program.session().scenes.some(s => s.name === 'Overlay'));
  assert.deepEqual(snapshots.at(-1), program.session());
});

test('scene event during initialization cannot be overwritten by an older scene list', async t => {
  const { fake, program: other } = await fixture(t);
  fake.delayRequest('GetSceneItemList', 100);
  const initial = fake.requests.filter(r => r.requestType === 'GetSceneItemList').length;
  const starting = startProgram(t, fake);
  await until(() => fake.requests.filter(r => r.requestType === 'GetSceneItemList').length > initial);
  await other.showScene('Slides');
  const program = await starting;
  assert.deepEqual(program.session().scenes.map(s => s.current), [false, true]);
});

test('a rejected OBS item request leaves the public session unchanged', async t => {
  const { fake, program } = await fixture(t), before = program.session();
  fake.failRequest('SetSceneItemEnabled', { code: 600, comment: 'internal transport detail' });
  await assert.rejects(program.setLayer('Camera', 'Logo', true), { message: 'OBS rechazó la petición «SetSceneItemEnabled».' });
  assert.deepEqual(program.session(), before);
  assert.deepEqual(fake.requests.at(-1), { requestType: 'SetSceneItemEnabled',
    requestData: { sceneName: 'Camera', sceneItemId: 7, sceneItemEnabled: true } });
});

test('disconnect rejects a pending scene-item operation promptly', async t => {
  const { fake, program } = await fixture(t);
  fake.delayRequest('SetSceneItemEnabled', 1000);
  const pending = program.setLayer('Camera', 'Logo', true);
  await until(() => fake.requests.some(r => r.requestType === 'SetSceneItemEnabled'));
  program.stop();
  await assert.rejects(pending, /OBS.*desconect/i);
});

test('HTTP aliases, timed layer hide and engine actions use the OBS facade', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-scenes-'));
  const fake = fakeObs({ scenes });
  let app;
  t.after(async () => {
    if (app) { await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); }
    await fake.close(); await rm(root, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, endpoint, body) => {
    const r = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  };
  const ready = waitFor(app.program, 'status', s => s.state === 'conectado');
  assert.equal((await call('PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: url(fake.server) } })).status, 200);
  await ready;
  assert.deepEqual((await call('GET', '/api/program')).body.scenes, app.program.session().scenes);
  assert.deepEqual(await call('POST', '/api/program/scene', { scene: 'slides' }), { status: 200, body: { scene: 'Slides' } });
  const hidden = waitFor(app.program, 'session', s => !s.scenes[0].layers[0].visible);
  assert.deepEqual(await call('POST', '/api/program/layer', { scene: 'Camera', layer: 'Logo', visible: true, seconds: 0.1 }),
    { status: 200, body: { scene: 'Camera', layer: 'Logo' } });
  await hidden;
  assert.deepEqual(fake.requests.filter(r => r.requestType === 'SetSceneItemEnabled').map(r => r.requestData.sceneItemEnabled), [true, false]);
  const snapshot = app.program.session(), count = fake.requests.length;
  assert.deepEqual(await call('POST', '/api/program/scene', { scene: 'missing' }),
    { status: 500, body: { error: 'No encuentro la escena «missing» en el programa de emisión' } });
  assert.deepEqual(await call('POST', '/api/program/layer', { scene: 'Camera', layer: 'missing' }),
    { status: 500, body: { error: 'No encuentro la capa «missing»' } });
  assert.equal(fake.requests.length, count); assert.deepEqual(app.program.session(), snapshot);
  assert.deepEqual(await call('POST', '/api/actions/run', { actions: [
    { kind: 'scene', scene: 'Camera' }, { kind: 'layer', scene: 'Camera', layer: 'Logo' },
    { kind: 'toggleLayer', scene: 'Camera', layer: 'Logo' },
  ] }), { status: 200, body: { ok: true } });
  assert.equal(app.program.session().scenes[0].current, true);
  assert.equal(app.program.session().scenes[0].layers[0].visible, false);
});
