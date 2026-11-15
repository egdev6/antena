// Contrato público del simulador OBS WebSocket v5, sin OBS ni dependencias externas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { fakeObs } from './helpers/fake-obs.mjs';

const SCENES = 1 << 2;
const INPUTS = 1 << 3;
const FILTERS = 1 << 5;
const OUTPUTS = 1 << 6;
const SCENE_ITEMS = 1 << 7;
const METERS = 1 << 16;
const ALL_NEEDED = SCENES | INPUTS | FILTERS | OUTPUTS | SCENE_ITEMS;
const TIMEOUT = 2000;

const fixtures = () => ({
  scenes: [
    { sceneName: 'Camera', sceneUuid: 'scene-camera', sceneItems: [
      { sceneItemId: 10, sourceName: 'Micro', sourceUuid: 'input-micro', sceneItemEnabled: true },
      { sceneItemId: 11, sourceName: 'Logo', sourceUuid: 'source-logo', sceneItemEnabled: false },
    ] },
    { sceneName: 'Slides', sceneUuid: 'scene-slides', sceneItems: [
      { sceneItemId: 12, sourceName: 'Camera', sceneItemEnabled: true },
      { sceneItemId: 13, sourceName: 'Logo', sceneItemEnabled: true },
    ] },
  ],
  inputs: [
    { inputName: 'Micro', inputUuid: 'input-micro', inputKind: 'wasapi_input_capture', inputMuted: false,
      inputVolumeMul: 1, monitorType: 'OBS_MONITORING_TYPE_NONE', filters: [
        { filterName: 'Compressor', filterKind: 'compressor_filter', filterEnabled: true, filterSettings: { ratio: 4 } },
      ] },
    { inputName: 'Music', inputUuid: 'input-music', inputKind: 'ffmpeg_source', inputMuted: true,
      inputVolumeMul: 0.5, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
  ],
});

function client(url, protocol) {
  const ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
  const messages = [], pending = [], history = [];
  let closed;
  let nextId = 0;
  const deliver = () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const waiter = pending[i];
      const index = messages.findIndex(waiter.match);
      if (index !== -1) {
        const [message] = messages.splice(index, 1);
        pending.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  };
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    history.push(message);
    messages.push(message);
    deliver();
  });
  ws.addEventListener('close', event => {
    closed = { code: event.code, reason: event.reason };
    messages.push({ closed });
    deliver();
  });
  const waitFor = (match, label) => new Promise((resolve, reject) => {
    const waiter = { match, resolve, timer: setTimeout(() => {
      const index = pending.indexOf(waiter);
      if (index !== -1) pending.splice(index, 1);
      reject(new Error(`Timed out waiting for ${label}`));
    }, TIMEOUT) };
    pending.push(waiter);
    deliver();
  });
  const send = (op, d) => ws.send(JSON.stringify({ op, d }));
  return {
    history,
    protocol: () => ws.protocol,
    hello: () => waitFor(m => m.op === 0, 'Hello'),
    identify: async ({ password, subscriptions } = {}) => {
      const hello = await waitFor(m => m.op === 0, 'Hello');
      const d = { rpcVersion: 1 };
      if (subscriptions !== undefined) d.eventSubscriptions = subscriptions;
      if (password !== undefined && hello.d.authentication) {
        const hash = value => createHash('sha256').update(value).digest('base64');
        d.authentication = hash(hash(password + hello.d.authentication.salt) + hello.d.authentication.challenge);
      }
      send(1, d);
      return hello;
    },
    identified: () => waitFor(m => m.op === 2, 'Identified'),
    reidentify: subscriptions => send(3, { eventSubscriptions: subscriptions }),
    sendOnly: (requestType, requestData = {}) => send(6, { requestType, requestId: String(++nextId), requestData }),
    request: (requestType, requestData = {}) => {
      const requestId = String(++nextId);
      send(6, { requestType, requestId, requestData });
      return waitFor(m => m.op === 7 && m.d.requestId === requestId, `${requestType} response`).then(m => {
        assert.equal(m.d.requestType, requestType);
        return m.d;
      });
    },
    closed: () => closed ? Promise.resolve(closed) : waitFor(m => m.closed, 'close').then(m => m.closed),
    events: type => history.filter(m => m.op === 5 && m.d.eventType === type).map(m => m.d),
  };
}

async function start(t, options = {}) {
  const fake = fakeObs(options);
  t.after(() => fake.close());
  await new Promise((resolve, reject) => {
    fake.server.once('error', reject);
    fake.server.listen(0, '127.0.0.1', resolve);
  });
  return { fake, url: `ws://127.0.0.1:${fake.server.address().port}` };
}

async function connect(url, options) {
  const c = client(url);
  const hello = await c.identify(options);
  assert.deepEqual((await c.identified()).d, { negotiatedRpcVersion: 1 });
  return { c, hello };
}

function success(response, expected = {}) {
  assert.equal(response.requestStatus.result, true);
  assert.equal(response.requestStatus.code, 100);
  if (response.requestStatus.comment !== undefined) assert.equal(typeof response.requestStatus.comment, 'string');
  assert.deepEqual(response.responseData ?? {}, expected);
}

function eventData(c, type, intent) {
  const events = c.events(type);
  for (const event of events) assert.equal(event.eventIntent, intent);
  return events.map(event => event.eventData);
}

// Una respuesta posterior actúa de barrera: no depende de dormir ni de polling.
const barrier = async c => { await c.request('GetCurrentProgramScene'); };

test('Hello/Identify sin contraseña y suscripción por defecto', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c, hello } = await connect(url);
  assert.equal(hello.d.rpcVersion, 1);
  assert.equal(typeof hello.d.obsWebSocketVersion, 'string');
  assert.equal(Object.hasOwn(hello.d, 'authentication'), false);
  fake.emit('CurrentProgramSceneChanged', { sceneName: 'Camera', sceneUuid: 'scene-camera' });
  fake.setVolumeMeters([{ inputName: 'Micro', inputUuid: 'input-micro', inputLevelsMul: [[0.5, 0.4, 0.6]] }]);
  await barrier(c);
  assert.equal(c.events('CurrentProgramSceneChanged').length, 1);
  assert.equal(c.events('InputVolumeMeters').length, 0, 'el volumen de alta frecuencia no se suscribe por defecto');
});

test('negocia el subprotocolo JSON oficial de OBS', { timeout: 5000 }, async t => {
  const { url } = await start(t, fixtures());
  const c = client(url, 'obswebsocket.json');
  await c.identify();
  assert.deepEqual((await c.identified()).d, { negotiatedRpcVersion: 1 });
  assert.equal(c.protocol(), 'obswebsocket.json');
  success(await c.request('GetCurrentProgramScene'), { currentProgramSceneName: 'Camera', currentProgramSceneUuid: 'scene-camera' });
});

test('autenticación oficial con contraseña', { timeout: 5000 }, async t => {
  const { url } = await start(t, { ...fixtures(), password: 'prueba-OBS' });
  const { c, hello } = await connect(url, { password: 'prueba-OBS' });
  assert.equal(typeof hello.d.authentication.challenge, 'string');
  assert.ok(hello.d.authentication.challenge.length > 0);
  assert.equal(typeof hello.d.authentication.salt, 'string');
  assert.ok(hello.d.authentication.salt.length > 0);
  assert.equal((await c.request('GetCurrentProgramScene')).requestStatus.result, true);
});

test('contraseña incorrecta cierra con 4009 y nunca Identified', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, { ...fixtures(), password: 'correcta' });
  const c = client(url);
  await c.identify({ password: 'incorrecta' });
  assert.equal((await c.closed()).code, 4009);
  assert.equal(c.history.some(m => m.op === 2), false);
  assert.deepEqual(fake.requests, []);
});

test('invalidar sesión cierra con 4011 y permite una sesión posterior', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c } = await connect(url);
  fake.invalidateSession();
  assert.equal((await c.closed()).code, 4011);
  const next = await connect(url);
  success(await next.c.request('GetCurrentProgramScene'), { currentProgramSceneName: 'Camera', currentProgramSceneUuid: 'scene-camera' });
});

test('GetVersion anuncia las peticiones implementadas', { timeout: 5000 }, async t => {
  const { url } = await start(t, fixtures());
  const { c } = await connect(url);
  const response = await c.request('GetVersion');
  assert.equal(response.requestStatus.code, 100);
  assert.equal(response.requestStatus.result, true);
  assert.equal(response.responseData.rpcVersion, 1);
  assert.equal(typeof response.responseData.obsVersion, 'string');
  assert.equal(typeof response.responseData.obsWebSocketVersion, 'string');
  assert.ok(Array.isArray(response.responseData.supportedImageFormats));
  assert.deepEqual(new Set(response.responseData.availableRequests), new Set([
    'GetVersion', 'GetSceneList', 'CreateScene', 'RemoveScene', 'GetCurrentProgramScene', 'SetCurrentProgramScene', 'GetSceneItemList',
    'GetSceneItemId', 'SetSceneItemEnabled', 'GetSourceFilterList', 'CreateSourceFilter', 'RemoveSourceFilter', 'SetSourceFilterName', 'SetSourceFilterEnabled', 'GetInputList',
    'GetInputAudioTracks', 'GetInputMute', 'SetInputMute', 'ToggleInputMute', 'GetInputVolume', 'SetInputVolume',
    'GetInputAudioMonitorType', 'SetInputAudioMonitorType', 'TriggerMediaInputAction', 'SetMediaInputCursor', 'GetMediaInputStatus', 'GetStreamStatus',
    'StartStream', 'StopStream', 'ToggleStream', 'GetRecordStatus', 'StartRecord', 'StopRecord',
  ]));
});

test('escenas y elementos: respuestas, cambios, eventos y rechazo sin mutación', { timeout: 5000 }, async t => {
  const { url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: ALL_NEEDED });
  const list = await c.request('GetSceneList');
  assert.equal(list.requestStatus.code, 100);
  assert.equal(list.responseData.currentProgramSceneName, 'Camera');
  assert.equal(list.responseData.currentProgramSceneUuid, 'scene-camera');
  assert.deepEqual(list.responseData.scenes.map(({ sceneIndex, sceneName, sceneUuid }) => ({ sceneIndex, sceneName, sceneUuid })), [
    { sceneIndex: 0, sceneName: 'Camera', sceneUuid: 'scene-camera' },
    { sceneIndex: 1, sceneName: 'Slides', sceneUuid: 'scene-slides' },
  ]);
  success(await c.request('GetCurrentProgramScene'), { currentProgramSceneName: 'Camera', currentProgramSceneUuid: 'scene-camera' });
  success(await c.request('SetCurrentProgramScene', { sceneName: 'Slides' }));
  success(await c.request('GetCurrentProgramScene'), { currentProgramSceneName: 'Slides', currentProgramSceneUuid: 'scene-slides' });
  const items = await c.request('GetSceneItemList', { sceneName: 'Camera' });
  assert.equal(items.requestStatus.code, 100);
  assert.deepEqual(items.responseData.sceneItems.map(({ sceneItemId, sourceName, sourceType, sceneItemEnabled }) => ({ sceneItemId, sourceName, sourceType, sceneItemEnabled })), [
    { sceneItemId: 10, sourceName: 'Micro', sourceType: 'OBS_SOURCE_TYPE_INPUT', sceneItemEnabled: true },
    { sceneItemId: 11, sourceName: 'Logo', sourceType: 'OBS_SOURCE_TYPE_INPUT', sceneItemEnabled: false },
  ]);
  const nested = await c.request('GetSceneItemList', { sceneName: 'Slides' });
  assert.equal(nested.requestStatus.code, 100);
  assert.equal(nested.responseData.sceneItems[0].sourceType, 'OBS_SOURCE_TYPE_SCENE');
  assert.equal(nested.responseData.sceneItems[0].sourceUuid, 'scene-camera');
  assert.equal(nested.responseData.sceneItems[1].sourceUuid, 'source-logo', 'una misma fuente conserva su UUID en cada escena');
  success(await c.request('GetSceneItemId', { sceneName: 'Camera', sourceName: 'Logo' }), { sceneItemId: 11 });
  success(await c.request('SetSceneItemEnabled', { sceneName: 'Camera', sceneItemId: 11, sceneItemEnabled: true }));
  assert.equal((await c.request('GetSceneItemList', { sceneName: 'Camera' })).responseData.sceneItems[1].sceneItemEnabled, true);
  const missing = await c.request('SetCurrentProgramScene', { sceneName: 'Missing' });
  assert.equal(missing.requestStatus.result, false);
  assert.equal(missing.requestStatus.code, 600);
  assert.equal(typeof missing.requestStatus.comment, 'string');
  success(await c.request('GetCurrentProgramScene'), { currentProgramSceneName: 'Slides', currentProgramSceneUuid: 'scene-slides' });
  assert.deepEqual(eventData(c, 'CurrentProgramSceneChanged', SCENES), [{ sceneName: 'Slides', sceneUuid: 'scene-slides' }]);
  assert.deepEqual(eventData(c, 'SceneItemEnableStateChanged', SCENE_ITEMS), [
    { sceneName: 'Camera', sceneUuid: 'scene-camera', sceneItemId: 11, sceneItemEnabled: true },
  ]);
});

test('escenas creadas y eliminadas cambian la lista y emiten eventos', { timeout: 5000 }, async t => {
  const { url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: SCENES });
  const created = await c.request('CreateScene', { sceneName: 'Overlay' });
  assert.equal(created.requestStatus.result, true);
  assert.equal(typeof created.responseData.sceneUuid, 'string');
  assert.deepEqual((await c.request('GetSceneList')).responseData.scenes.map(s => s.sceneName), ['Camera', 'Slides', 'Overlay']);
  success(await c.request('RemoveScene', { sceneName: 'Overlay' }));
  assert.deepEqual((await c.request('GetSceneList')).responseData.scenes.map(s => s.sceneName), ['Camera', 'Slides']);
  assert.deepEqual(c.events('SceneCreated').map(e => e.eventData.sceneName), ['Overlay']);
  assert.deepEqual(c.events('SceneRemoved').map(e => e.eventData.sceneName), ['Overlay']);
  assert.equal(c.events('SceneListChanged').length, 2);
});

test('filtros, entradas, audio y acción multimedia', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: ALL_NEEDED });
  const filters = await c.request('GetSourceFilterList', { sourceName: 'Micro' });
  assert.equal(filters.requestStatus.code, 100);
  assert.deepEqual(filters.responseData.filters.map(({ filterName, filterKind, filterEnabled, filterSettings }) => ({ filterName, filterKind, filterEnabled, filterSettings })), [
    { filterName: 'Compressor', filterKind: 'compressor_filter', filterEnabled: true, filterSettings: { ratio: 4 } },
  ]);
  success(await c.request('SetSourceFilterEnabled', { sourceName: 'Micro', filterName: 'Compressor', filterEnabled: false }));
  assert.equal((await c.request('GetSourceFilterList', { sourceName: 'Micro' })).responseData.filters[0].filterEnabled, false);
  const inputs = await c.request('GetInputList');
  assert.equal(inputs.requestStatus.code, 100);
  assert.deepEqual(inputs.responseData.inputs.map(({ inputName, inputUuid, inputKind }) => ({ inputName, inputUuid, inputKind })), [
    { inputName: 'Micro', inputUuid: 'input-micro', inputKind: 'wasapi_input_capture' },
    { inputName: 'Music', inputUuid: 'input-music', inputKind: 'ffmpeg_source' },
  ]);
  assert.deepEqual((await c.request('GetInputList', { inputKind: 'ffmpeg_source' })).responseData.inputs.map(i => i.inputName), ['Music']);
  success(await c.request('GetInputAudioTracks', { inputName: 'Micro' }), { inputAudioTracks: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true } });
  success(await c.request('GetInputMute', { inputName: 'Micro' }), { inputMuted: false });
  success(await c.request('SetInputMute', { inputName: 'Micro', inputMuted: true }));
  success(await c.request('GetInputMute', { inputName: 'Micro' }), { inputMuted: true });
  success(await c.request('ToggleInputMute', { inputName: 'Micro' }), { inputMuted: false });
  success(await c.request('GetInputMute', { inputName: 'Micro' }), { inputMuted: false });
  success(await c.request('GetInputVolume', { inputName: 'Micro' }), { inputVolumeMul: 1, inputVolumeDb: 0 });
  success(await c.request('SetInputVolume', { inputName: 'Micro', inputVolumeMul: 0.5 }));
  const volume = await c.request('GetInputVolume', { inputName: 'Micro' });
  assert.equal(volume.responseData.inputVolumeMul, 0.5);
  assert.ok(Math.abs(volume.responseData.inputVolumeDb - 20 * Math.log10(0.5)) < 1e-9);
  success(await c.request('SetInputVolume', { inputName: 'Micro', inputVolumeDb: -20 }));
  const dbVolume = await c.request('GetInputVolume', { inputName: 'Micro' });
  assert.ok(Math.abs(dbVolume.responseData.inputVolumeMul - 0.1) < 1e-9);
  assert.ok(Math.abs(dbVolume.responseData.inputVolumeDb + 20) < 1e-9);
  success(await c.request('GetInputAudioMonitorType', { inputName: 'Micro' }), { monitorType: 'OBS_MONITORING_TYPE_NONE' });
  success(await c.request('SetInputAudioMonitorType', { inputName: 'Micro', monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' }));
  success(await c.request('GetInputAudioMonitorType', { inputName: 'Micro' }), { monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
  success(await c.request('TriggerMediaInputAction', { inputName: 'Music', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }));
  assert.deepEqual(fake.requests.at(-1), { requestType: 'TriggerMediaInputAction', requestData: { inputName: 'Music', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' } });
  assert.deepEqual(eventData(c, 'SourceFilterEnableStateChanged', FILTERS), [
    { sourceName: 'Micro', sourceUuid: 'input-micro', filterName: 'Compressor', filterEnabled: false },
  ]);
  assert.deepEqual(eventData(c, 'InputMuteStateChanged', INPUTS), [
    { inputName: 'Micro', inputUuid: 'input-micro', inputMuted: true },
    { inputName: 'Micro', inputUuid: 'input-micro', inputMuted: false },
  ]);
  const volumeEvents = eventData(c, 'InputVolumeChanged', INPUTS);
  assert.equal(volumeEvents.length, 2);
  assert.equal(volumeEvents[0].inputName, 'Micro');
  assert.equal(volumeEvents[0].inputUuid, 'input-micro');
  assert.equal(volumeEvents[0].inputVolumeMul, 0.5);
  assert.ok(Math.abs(volumeEvents[0].inputVolumeDb - 20 * Math.log10(0.5)) < 1e-9);
  assert.ok(Math.abs(volumeEvents[1].inputVolumeMul - 0.1) < 1e-9);
  assert.ok(Math.abs(volumeEvents[1].inputVolumeDb + 20) < 1e-9);
  assert.deepEqual(eventData(c, 'InputAudioMonitorTypeChanged', INPUTS), [
    { inputName: 'Micro', inputUuid: 'input-micro', monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
  ]);
});

test('las peticiones de audio rechazan entradas sin audio con 604 sin emitir cambios', { timeout: 5000 }, async t => {
  const { url } = await start(t, { inputs: [
    { inputName: 'Voice', inputUuid: 'voice', inputVolumeMul: 0.5 },
    { inputName: 'Picture', inputUuid: 'picture', inputKind: 'image_source' },
    { inputName: 'Browser', inputUuid: 'browser', inputKind: 'browser_source', audio: false },
  ] });
  const { c } = await connect(url, { subscriptions: INPUTS });
  const before = (await c.request('GetInputList')).responseData;
  for (const [type, data] of [
    ['GetInputAudioTracks', {}], ['GetInputMute', {}], ['SetInputMute', { inputMuted: true }],
    ['ToggleInputMute', {}], ['GetInputVolume', {}], ['SetInputVolume', { inputVolumeMul: 0.25 }],
    ['GetInputAudioMonitorType', {}], ['SetInputAudioMonitorType', { monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' }],
  ]) {
    await t.test(type, async () => {
      for (const ref of [{ inputName: 'Picture' }, { inputUuid: 'browser' }]) {
        const response = await c.request(type, { ...ref, ...data });
        assert.deepEqual(response.requestStatus, { result: false, code: 604, comment: 'The specified input does not support audio.' });
        assert.equal(response.responseData, undefined);
      }
    });
  }
  assert.deepEqual((await c.request('GetInputList')).responseData, before);
  success(await c.request('GetInputAudioTracks', { inputName: 'Voice' }), { inputAudioTracks: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true } });
  success(await c.request('GetInputMute', { inputName: 'Voice' }), { inputMuted: false });
  success(await c.request('GetInputVolume', { inputName: 'Voice' }), { inputVolumeMul: 0.5, inputVolumeDb: 20 * Math.log10(0.5) });
  success(await c.request('GetInputAudioMonitorType', { inputName: 'Voice' }), { monitorType: 'OBS_MONITORING_TYPE_NONE' });
  assert.deepEqual(c.events('InputMuteStateChanged'), []);
  assert.deepEqual(c.events('InputVolumeChanged'), []);
  assert.deepEqual(c.events('InputAudioMonitorTypeChanged'), []);
});

test('el hook de fallo puede limitarse a una entrada sin afectar a las demás', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: INPUTS });
  fake.failRequest('GetInputMute', { code: 604, comment: 'scoped failure' }, { inputUuid: 'input-music' });
  success(await c.request('GetInputMute', { inputUuid: 'input-micro' }), { inputMuted: false });
  const rejected = await c.request('GetInputMute', { inputUuid: 'input-music' });
  assert.deepEqual(rejected.requestStatus, { result: false, code: 604, comment: 'scoped failure' });
  assert.equal(rejected.responseData, undefined);
  fake.failRequest('GetInputMute', null);
  success(await c.request('GetInputMute', { inputUuid: 'input-music' }), { inputMuted: true });
  assert.deepEqual(c.events('InputMuteStateChanged'), []);
});

test('filtros externos y cursor multimedia conservan estado, eventos y rechazan entradas inválidas', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: FILTERS });
  success(await c.request('CreateSourceFilter', { sourceName: 'Micro', filterName: 'Glow', filterKind: 'fake_filter' }));
  assert.deepEqual((await c.request('GetSourceFilterList', { sourceName: 'Micro' })).responseData.filters.map(f => f.filterName), ['Compressor', 'Glow']);
  success(await c.request('SetSourceFilterName', { sourceName: 'Micro', filterName: 'Glow', newFilterName: 'Light' }));
  assert.deepEqual((await c.request('GetSourceFilterList', { sourceName: 'Micro' })).responseData.filters.map(f => f.filterName), ['Compressor', 'Light']);
  success(await c.request('RemoveSourceFilter', { sourceName: 'Micro', filterName: 'Light' }));
  assert.deepEqual((await c.request('GetSourceFilterList', { sourceName: 'Micro' })).responseData.filters.map(f => f.filterName), ['Compressor']);
  assert.deepEqual(c.events('SourceFilterCreated').map(e => e.eventData.filterName), ['Glow']);
  assert.deepEqual(c.events('SourceFilterNameChanged').map(e => [e.eventData.oldFilterName, e.eventData.filterName]), [['Glow', 'Light']]);
  assert.deepEqual(c.events('SourceFilterRemoved').map(e => e.eventData.filterName), ['Light']);
  success(await c.request('SetMediaInputCursor', { inputName: 'Music', mediaCursor: 1234 }));
  assert.deepEqual(fake.requests.at(-1), { requestType: 'SetMediaInputCursor', requestData: { inputName: 'Music', mediaCursor: 1234 } });
  for (const [type, data] of [
    ['SetMediaInputCursor', { inputName: 'Micro', mediaCursor: 0 }],
    ['TriggerMediaInputAction', { inputName: 'Micro', mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' }],
  ]) assert.equal((await c.request(type, data)).requestStatus.code, 602);
  assert.equal((await c.request('SetMediaInputCursor', { inputName: 'Music', mediaCursor: -1 })).requestStatus.result, false);
  success(await c.request('GetMediaInputStatus', { inputName: 'Music' }), { mediaState: 'OBS_MEDIA_STATE_STOPPED', mediaDuration: 0, mediaCursor: 1234 });
});

test('emisión: estado, start, stop, toggle y transiciones', { timeout: 5000 }, async t => {
  const { url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: OUTPUTS });
  let status = await c.request('GetStreamStatus');
  assert.equal(status.requestStatus.code, 100);
  assert.deepEqual(status.responseData, { outputActive: false, outputReconnecting: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 });
  success(await c.request('StartStream'));
  assert.equal((await c.request('GetStreamStatus')).responseData.outputActive, true);
  success(await c.request('ToggleStream'), { outputActive: false });
  assert.equal((await c.request('GetStreamStatus')).responseData.outputActive, false);
  success(await c.request('ToggleStream'), { outputActive: true });
  success(await c.request('StopStream'));
  status = await c.request('GetStreamStatus');
  assert.equal(status.responseData.outputActive, false);
  assert.deepEqual(eventData(c, 'StreamStateChanged', OUTPUTS), [
    { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' },
    { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' },
    { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' },
    { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' },
    { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' },
    { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' },
    { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' },
    { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' },
  ]);
});

test('grabación: estado, start, stop y ruta solo al parar', { timeout: 5000 }, async t => {
  const { url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: OUTPUTS });
  let status = await c.request('GetRecordStatus');
  assert.equal(status.requestStatus.code, 100);
  assert.deepEqual(status.responseData, { outputActive: false, outputPaused: false, outputTimecode: '00:00:00.000', outputDuration: 0, outputBytes: 0 });
  success(await c.request('StartRecord'));
  assert.equal((await c.request('GetRecordStatus')).responseData.outputActive, true);
  const stopped = await c.request('StopRecord');
  assert.equal(stopped.requestStatus.code, 100);
  assert.equal(typeof stopped.responseData.outputPath, 'string');
  assert.ok(stopped.responseData.outputPath.length > 0);
  status = await c.request('GetRecordStatus');
  assert.equal(status.responseData.outputActive, false);
  assert.deepEqual(eventData(c, 'RecordStateChanged', OUTPUTS), [
    { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' },
    { outputActive: true, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' },
    { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING' },
    { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: stopped.responseData.outputPath },
  ]);
});

test('suscripciones independientes, Reidentify y medidores de alto volumen', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c: scenes } = await connect(url, { subscriptions: SCENES });
  const { c: meters } = await connect(url, { subscriptions: METERS });
  const levels = [{ inputName: 'Micro', inputUuid: 'input-micro', inputLevelsMul: [[0.5, 0.4, 0.6]] }];
  fake.emit('CurrentProgramSceneChanged', { sceneName: 'Slides', sceneUuid: 'scene-slides' });
  fake.setVolumeMeters(levels);
  fake.emit('InputVolumeMeters', { inputs: levels });
  await barrier(scenes);
  await barrier(meters);
  assert.equal(scenes.events('CurrentProgramSceneChanged').length, 1);
  assert.equal(scenes.events('InputVolumeMeters').length, 0);
  assert.equal(meters.events('CurrentProgramSceneChanged').length, 0);
  assert.deepEqual(eventData(meters, 'InputVolumeMeters', METERS), [{ inputs: levels }, { inputs: levels }]);
  scenes.reidentify(); // Una Reidentify vacía conserva las suscripciones actuales.
  await barrier(scenes);
  fake.emit('CurrentProgramSceneChanged', { sceneName: 'Camera', sceneUuid: 'scene-camera' });
  await barrier(scenes);
  assert.equal(scenes.events('CurrentProgramSceneChanged').length, 2);
  scenes.reidentify(METERS);
  await barrier(scenes);
  fake.emit('CurrentProgramSceneChanged', { sceneName: 'Camera', sceneUuid: 'scene-camera' });
  fake.setVolumeMeters(levels);
  await barrier(scenes);
  await barrier(meters);
  assert.equal(scenes.events('CurrentProgramSceneChanged').length, 2);
  assert.deepEqual(eventData(scenes, 'InputVolumeMeters', METERS), [{ inputs: levels }]);
  assert.equal(meters.events('InputVolumeMeters').length, 3);
  meters.reidentify(0);
  await barrier(meters);
  fake.setVolumeMeters(levels);
  await barrier(meters);
  assert.equal(meters.events('InputVolumeMeters').length, 3);
});

test('petición desconocida 204 y registro fiel de datos y orden', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c } = await connect(url);
  const missing = await c.request('NotAnObsRequest', { marker: 12 });
  assert.equal(missing.requestType, 'NotAnObsRequest');
  assert.equal(missing.requestStatus.result, false);
  assert.equal(missing.requestStatus.code, 204);
  assert.equal(typeof missing.requestStatus.comment, 'string');
  assert.equal(missing.responseData, undefined);
  success(await c.request('GetInputMute', { inputName: 'Micro' }), { inputMuted: false });
  assert.deepEqual(fake.requests, [
    { requestType: 'NotAnObsRequest', requestData: { marker: 12 } },
    { requestType: 'GetInputMute', requestData: { inputName: 'Micro' } },
  ]);
});

test('hooks de fallo y demora no mutan al rechazar ni bloquean otras respuestas', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const { c } = await connect(url, { subscriptions: INPUTS });
  fake.failRequest('SetInputMute', { code: 601, comment: 'Simulated failure' });
  const failed = await c.request('SetInputMute', { inputName: 'Micro', inputMuted: true });
  assert.deepEqual(failed.requestStatus, { result: false, code: 601, comment: 'Simulated failure' });
  assert.equal(failed.responseData, undefined);
  success(await c.request('GetInputMute', { inputName: 'Micro' }), { inputMuted: false });
  assert.deepEqual(c.events('InputMuteStateChanged'), []);
  fake.delayRequest('GetInputMute', 100);
  const slow = c.request('GetInputMute', { inputName: 'Micro' });
  const fast = c.request('GetCurrentProgramScene');
  success(await fast, { currentProgramSceneName: 'Camera', currentProgramSceneUuid: 'scene-camera' });
  const responseTypes = c.history.filter(m => m.op === 7).map(m => m.d.requestType);
  assert.deepEqual(responseTypes, ['SetInputMute', 'GetInputMute', 'GetCurrentProgramScene']);
  success(await slow, { inputMuted: false });
  assert.deepEqual(fake.requests.map(r => r.requestType), ['SetInputMute', 'GetInputMute', 'GetInputMute', 'GetCurrentProgramScene']);
});

test('frames largos de ida y vuelta conservan los datos', { timeout: 5000 }, async t => {
  const options = fixtures();
  const large = 'x'.repeat(70000);
  options.inputs[0].filters[0].filterSettings = { large };
  const { fake, url } = await start(t, options);
  const { c } = await connect(url);
  success(await c.request('GetInputMute', { inputName: 'Micro', large }), { inputMuted: false });
  assert.equal(fake.requests[0].requestData.large, large);
  const filters = await c.request('GetSourceFilterList', { sourceName: 'Micro' });
  assert.equal(filters.requestStatus.code, 100);
  assert.equal(filters.responseData.filters[0].filterSettings.large, large);
});

test('close cancela peticiones demoradas, desconecta limpiamente y libera el puerto', { timeout: 5000 }, async t => {
  const { fake, url } = await start(t, fixtures());
  const port = fake.server.address().port;
  const { c } = await connect(url);
  fake.delayRequest('GetInputMute', 10000);
  // Una barrera confirma que el servidor recibió la petición demorada antes del cierre.
  c.sendOnly('GetInputMute', { inputName: 'Micro' });
  await barrier(c);
  assert.deepEqual(fake.requests.map(r => r.requestType), ['GetInputMute', 'GetCurrentProgramScene']);
  await fake.close();
  assert.equal((await c.closed()).code, 1001);
  await fake.close();
  const probe = net.createServer();
  t.after(() => new Promise(resolve => probe.listening ? probe.close(resolve) : resolve()));
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  assert.equal(probe.address().port, port);
});
