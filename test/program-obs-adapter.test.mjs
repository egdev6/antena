import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgram } from '../src/programs/index.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { programContract, waitFor } from './helpers/program-contract.mjs';

const initialStatus = { state: 'desconectado', streaming: false, streamingKnown: false, recording: false,
  recordingKnown: false, recordingWarning: null, version: null, error: null };
const connectedStatus = { ...initialStatus, state: 'conectado', streamingKnown: true, recordingKnown: true, version: '30.2.3' };
const methods = ['command', 'streamEvent', 'setProperty', 'call'];
const actions = Object.fromEntries(methods.map(name => [name, [{ args: ['test'], calls: [], error: /todavía no disponible con OBS/i }]]));
const initialSession = { scenes: [
  { id: 'scene-a', name: 'Camera', current: true, layers: [{ id: 'scene-a:7', name: 'Logo', visible: false,
    effects: [{ id: 'Blur', name: 'Blur', enabled: true }] }] },
  { id: 'scene-b', name: 'Slides', current: false, layers: [] },
], tracks: [{ id: 'logo-id', name: 'Logo', muted: false, monitoring: false, parent: null, gain: 1 }], streaming: false, recording: false };
const changedSession = structuredClone(initialSession);
changedSession.scenes[0].current = false; changedSession.scenes[1].current = true;
const layerSession = structuredClone(changedSession);
layerSession.scenes[0].layers[0].visible = true;
const effectSession = structuredClone(layerSession);
effectSession.scenes[0].layers[0].effects[0].enabled = false;
actions.showScene = [
  { args: ['slides'], calls: [{ requestType: 'SetCurrentProgramScene', requestData: { sceneName: 'Slides' } }], session: changedSession },
  { args: ['missing'], calls: [], error: { message: 'No encuentro la escena «missing» en Meld' } },
];
actions.setLayer = [
  { args: ['Camera', 'Logo', true], calls: [{ requestType: 'SetSceneItemEnabled', requestData: { sceneName: 'Camera', sceneItemId: 7, sceneItemEnabled: true } }], session: layerSession },
  { args: ['Camera', 'Logo', true], calls: [], session: layerSession },
];
actions.toggleEffect = [{ args: ['Camera', 'Logo', 'Blur'], calls: [{ requestType: 'SetSourceFilterEnabled',
  requestData: { sourceName: 'Logo', filterName: 'Blur', filterEnabled: false } }], session: effectSession }];
const mutedSession = structuredClone(effectSession); mutedSession.tracks[0].muted = true;
const gainSession = structuredClone(mutedSession); gainSession.tracks[0].gain = 0.25;
actions.toggleMute = [{ args: ['Logo'], calls: [{ requestType: 'ToggleInputMute', requestData: { inputUuid: 'logo-id' } }], result: undefined, session: mutedSession }];
actions.setGain = [{ args: ['logo-id', 0.25], calls: [{ requestType: 'SetInputVolume', requestData: { inputUuid: 'logo-id', inputVolumeMul: 0.25 } }], result: 0.25, session: gainSession }];
actions.media = [{ args: ['Logo', 'play'], calls: [{ requestType: 'TriggerMediaInputAction',
  requestData: { inputName: 'Logo', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' } }], session: gainSession }];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fakeServer(t, options = {}) {
  const fake = fakeObs(options), sockets = new Set();
  let upgrades = 0;
  fake.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  fake.server.on('upgrade', () => upgrades++);
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  if (t) t.after(() => fake.close());
  return { fake, url: `ws://127.0.0.1:${fake.server.address().port}`, upgrades: () => upgrades,
    drop: () => { for (const socket of sockets) socket.destroy(); } };
}
function makeProgram(t, options = {}) {
  const logs = [], program = createProgram('obs', { getPassword: () => '', retryDelays: [10, 20],
    ...options, log: (...args) => logs.push(args.join(' ')) });
  t.after(async () => { await program.quiesceClose(); program.dispose(); });
  return { program, logs };
}
function until(program, predicate) {
  if (predicate(program.status)) return Promise.resolve([program.status]);
  return waitFor(program, 'status', predicate);
}
async function connected(program, url) {
  const ready = until(program, s => s.state === 'conectado' && s.streamingKnown && s.recordingKnown);
  program.start(url);
  await ready;
}

async function makeDriver() {
  const { fake, url } = await fakeServer(null, { scenes: [
    { sceneName: 'Camera', sceneUuid: 'scene-a', sceneItems: [{ sourceName: 'Logo', sceneItemId: 7, sceneItemEnabled: false }] },
    { sceneName: 'Slides', sceneUuid: 'scene-b' },
  ], inputs: [{ inputName: 'Logo', inputUuid: 'logo-id', inputKind: 'ffmpeg_source', filters: [{ filterName: 'Blur' }] }] });
  return { url, capabilities: ['scene-layers', 'layer-effects', 'media-controls', 'audio-tracks'], initialStatus, connectedStatus, initialSession, changedSession, actions,
    changeSession: () => fake.emit('CurrentProgramSceneChanged', { sceneName: 'Slides', sceneUuid: 'scene-b' }),
    ready: async () => {}, settle: async () => {}, calls: () => fake.requests,
    report: ({ streaming, recording }) => {
      fake.emit('StreamStateChanged', { outputActive: streaming });
      fake.emit('RecordStateChanged', { outputActive: recording });
    },
    close: () => fake.close() };
}
programContract(() => createProgram('obs', { getPassword: () => '', retryDelays: [10, 20] }), makeDriver, { statusOnly: true, sessions: true });

test('OBS connects without a password and queries status and version', async t => {
  const { fake, url } = await fakeServer(t, { inputs: [] }), { program } = makeProgram(t);
  await connected(program, url);
  assert.deepEqual(program.status, connectedStatus);
  assert.deepEqual(fake.requests.map(r => r.requestType).sort(), ['GetInputList', 'GetRecordStatus', 'GetSceneItemList', 'GetSceneItemList', 'GetSceneList', 'GetStreamStatus', 'GetVersion']);
  assert.deepEqual(program.session().scenes.map(s => [s.name, s.current, s.layers]), [['Camera', true, []], ['Slides', false, []]]);
  assert.deepEqual(program.session().tracks, []);
});

test('OBS uses the current password at each connection, including restart', async t => {
  const secret = 'OBS_TEST_PASSWORD', { url } = await fakeServer(t, { password: secret });
  let password = 'wrong', reads = 0;
  const { program, logs } = makeProgram(t, { getPassword: () => { reads++; return password; } });
  const error = until(program, s => s.state === 'error');
  program.start(url); await error;
  assert.equal(program.status.error, 'Contraseña de OBS incorrecta.');
  password = secret;
  await connected(program, url);
  assert.ok(reads >= 2);
  assert.equal(program.status.error, null);
  assert.ok(!JSON.stringify(program.status).includes(secret));
  assert.ok(!logs.join('\n').includes(secret));
});

test('4009 is a terminal authentication error, without a retry loop', async t => {
  const server = await fakeServer(t, { password: 'correct' });
  const { program } = makeProgram(t, { getPassword: () => 'wrong' });
  const error = until(program, s => s.state === 'error');
  program.start(server.url); await error;
  assert.equal(program.status.error, 'Contraseña de OBS incorrecta.');
  assert.equal(program.connected, false);
  await delay(150);
  assert.equal(server.upgrades(), 1);
  assert.deepEqual(server.fake.requests, []);
});

test('4011 invalidation does not reconnect automatically but permits explicit restart', async t => {
  const server = await fakeServer(t), { program } = makeProgram(t);
  await connected(program, server.url);
  const error = until(program, s => s.state === 'error');
  server.fake.invalidateSession(); await error;
  assert.equal(program.status.error, 'La sesión de OBS ha sido invalidada.');
  assert.equal(program.status.streamingKnown, false);
  assert.equal(program.status.recordingKnown, false);
  await delay(150);
  assert.equal(server.upgrades(), 1);
  await connected(program, server.url);
  assert.equal(server.upgrades(), 2);
});

test('unexpected disconnect reconnects and status events are forwarded in order', async t => {
  const server = await fakeServer(t), { program } = makeProgram(t), streamingEvents = [];
  program.on('streaming', value => streamingEvents.push(value));
  await connected(program, server.url);
  const retry = until(program, s => s.state === 'reintentando');
  server.drop(); await retry;
  assert.equal(program.status.streamingKnown, false);
  assert.equal(program.status.recordingKnown, false);
  await until(program, s => s.state === 'conectado' && s.streamingKnown && s.recordingKnown);
  assert.equal(server.upgrades(), 2);
  const live = until(program, s => s.streaming && s.recording);
  server.fake.emit('StreamStateChanged', { outputActive: true });
  server.fake.emit('RecordStateChanged', { outputActive: true });
  await live;
  assert.deepEqual(streamingEvents, [true]);
  assert.deepEqual([program.session().streaming, program.session().recording], [true, true]);
  assert.deepEqual(program.session().scenes.map(s => s.name), ['Camera', 'Slides']);
});

test('failed status requests stay unknown and a later event establishes the state', async t => {
  const { fake, url } = await fakeServer(t), { program } = makeProgram(t);
  fake.failRequest('GetStreamStatus');
  const ready = until(program, s => s.state === 'conectado');
  program.start(url); await ready;
  assert.equal(program.status.streamingKnown, false);
  assert.equal(program.status.recordingKnown, true);
  const live = until(program, s => s.streamingKnown && s.streaming);
  fake.emit('StreamStateChanged', { outputActive: true }); await live;
});

test('an event received during initial queries is not overwritten by a stale response', async t => {
  const { fake, url } = await fakeServer(t), { program } = makeProgram(t);
  fake.delayRequest('GetStreamStatus', 120);
  program.start(url);
  const deadline = Date.now() + 3000;
  while (!fake.requests.some(r => r.requestType === 'GetStreamStatus')) {
    assert.ok(Date.now() < deadline, 'initial status request was not sent');
    await delay(5);
  }
  fake.emit('StreamStateChanged', { outputActive: true });
  await until(program, s => s.state === 'conectado');
  assert.equal(program.status.streamingKnown, true);
  assert.equal(program.status.streaming, true);
});

test('reconnect attempts are bounded with backoff and can be restarted explicitly', async t => {
  const server = await fakeServer(t), { program } = makeProgram(t);
  server.fake.server.on('upgrade', (_req, socket) => socket.destroy());
  const error = until(program, s => s.state === 'error');
  program.start(server.url); await error;
  assert.equal(program.status.error, 'No se puede conectar con OBS.');
  assert.equal(server.upgrades(), 3);
  await delay(150);
  assert.equal(server.upgrades(), 3);
});
