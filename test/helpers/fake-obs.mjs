// OBS WebSocket v5 simulado para tests, solo en loopback y sin dependencias.
// Referencia: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
// Uso: const obs = fakeObs({ password, scenes, inputs });
//      obs.server.listen(0, '127.0.0.1'); ...; await obs.close();
// scenes: [{ sceneName, sceneUuid?, sceneItems?: [{ sceneItemId, sourceName, ... }] }]
// inputs: [{ inputName, inputUuid?, inputKind?, audio?, inputMuted?, inputVolumeMul?, monitorType?, filters? }]
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const RPC_VERSION = 1;
const WS_VERSION = '5.6.1';
const DEFAULT_SUBSCRIPTIONS = (1 << 11) - 1; // All no incluye eventos de alto volumen.
const MAX_FRAME = 1024 * 1024;
const OUTPUT_PATH = '/fake-recording.mkv'; // Dato simulado: nunca se crea este archivo.

const eventIntents = new Map();
function events(intent, names) { for (const name of names.split(' ')) eventIntents.set(name, intent); }
events(1 << 0, 'ExitStarted CustomEvent');
events(1 << 1, 'CurrentSceneCollectionChanging CurrentSceneCollectionChanged SceneCollectionListChanged CurrentProfileChanging CurrentProfileChanged ProfileListChanged');
events(1 << 2, 'SceneCreated SceneRemoved SceneNameChanged CurrentProgramSceneChanged CurrentPreviewSceneChanged SceneListChanged');
events(1 << 3, 'InputCreated InputRemoved InputNameChanged InputSettingsChanged InputMuteStateChanged InputVolumeChanged InputAudioBalanceChanged InputAudioSyncOffsetChanged InputAudioTracksChanged InputAudioMonitorTypeChanged');
events(1 << 4, 'CurrentSceneTransitionChanged CurrentSceneTransitionDurationChanged SceneTransitionStarted SceneTransitionEnded SceneTransitionVideoEnded');
events(1 << 5, 'SourceFilterListReindexed SourceFilterCreated SourceFilterRemoved SourceFilterNameChanged SourceFilterSettingsChanged SourceFilterEnableStateChanged');
events(1 << 6, 'StreamStateChanged RecordStateChanged RecordFileChanged ReplayBufferStateChanged VirtualcamStateChanged ReplayBufferSaved');
events(1 << 7, 'SceneItemCreated SceneItemRemoved SceneItemListReindexed SceneItemEnableStateChanged SceneItemLockStateChanged SceneItemSelected');
events(1 << 8, 'MediaInputPlaybackStarted MediaInputPlaybackEnded MediaInputActionTriggered');
events(1 << 9, 'VendorEvent');
events(1 << 10, 'StudioModeStateChanged ScreenshotSaved');
events(1 << 16, 'InputVolumeMeters');
events(1 << 17, 'InputActiveStateChanged');
events(1 << 18, 'InputShowStateChanged');
events(1 << 19, 'SceneItemTransformChanged');

const REQUEST_TYPES = [
  'GetVersion', 'GetSceneList', 'CreateScene', 'RemoveScene', 'GetCurrentProgramScene', 'SetCurrentProgramScene', 'GetSceneItemList',
  'GetSceneItemId', 'SetSceneItemEnabled', 'GetSourceFilterList', 'CreateSourceFilter', 'RemoveSourceFilter', 'SetSourceFilterName', 'SetSourceFilterEnabled', 'GetInputList',
  'GetInputAudioTracks', 'GetInputMute', 'SetInputMute', 'ToggleInputMute', 'GetInputVolume', 'SetInputVolume',
  'GetInputAudioMonitorType', 'SetInputAudioMonitorType', 'TriggerMediaInputAction', 'SetMediaInputCursor', 'GetMediaInputStatus', 'GetStreamStatus',
  'StartStream', 'StopStream', 'ToggleStream', 'GetRecordStatus', 'StartRecord', 'StopRecord',
];

const hash = value => createHash('sha256').update(value).digest('base64');
const clone = value => structuredClone(value);
const inputDb = mul => mul === 0 ? -100 : 20 * Math.log10(mul);
const failure = (code, comment) => Object.assign(new Error(comment), { code });
function required(value, field) {
  if (value === undefined || value === null || value === '') throw failure(203, `Missing ${field}`);
  return value;
}
function boolean(value, field) {
  required(value, field);
  if (typeof value !== 'boolean') throw failure(400, `Invalid ${field}`);
  return value;
}
function lookup(rows, name, uuid, nameKey, uuidKey) {
  if (!name && !uuid) throw failure(203, `Missing ${nameKey} or ${uuidKey}`);
  const found = rows.find(row => uuid ? row[uuidKey] === uuid : row[nameKey] === name);
  if (!found) throw failure(600, `${nameKey} not found`);
  return found;
}

// Los clientes enmascaran los frames; el servidor no. También admite frames largos,
// fragmentados y ping/pong para que el transporte no dependa de los tamaños JSON.
function frame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}
function closeFrame(code, reason = '') {
  const text = Buffer.from(reason);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0); text.copy(payload, 2);
  return frame(8, payload);
}

export function fakeObs(options = {}) {
  const inputOptions = options.inputs ?? [{ inputName: 'Micro' }];
  const sceneOptions = (options.scenes ?? [{ sceneName: 'Camera' }, { sceneName: 'Slides' }])
    .map(scene => ({ ...scene, sceneUuid: scene.sceneUuid ?? randomUUID() }));
  const filters = list => (list ?? []).map((filter, filterIndex) => ({
    filterName: filter.filterName,
    filterKind: filter.filterKind ?? 'fake_filter',
    filterEnabled: filter.filterEnabled ?? true,
    filterIndex: filter.filterIndex ?? filterIndex,
    filterSettings: clone(filter.filterSettings ?? {}),
  }));
  const makeInput = input => ({
    inputName: input.inputName,
    inputUuid: input.inputUuid ?? randomUUID(),
    inputKind: input.inputKind ?? 'fake_input',
    unversionedInputKind: input.unversionedInputKind ?? input.inputKind ?? 'fake_input',
    inputMuted: input.inputMuted ?? false,
    inputVolumeMul: input.inputVolumeMul ?? 1,
    monitorType: input.monitorType ?? 'OBS_MONITORING_TYPE_NONE',
    audio: input.audio ?? input.inputKind !== 'image_source',
    media: input.media ?? ['ffmpeg_source', 'vlc_source'].includes(input.inputKind),
    mediaCursor: 0, mediaState: 'OBS_MEDIA_STATE_STOPPED',
    filters: filters(input.filters),
  });
  const inputs = inputOptions.map(makeInput);
  // Una fuente compartida por varias escenas conserva la misma identidad OBS.
  const sourceUuids = new Map([
    ...inputs.map(input => [input.inputName, input.inputUuid]),
    ...sceneOptions.map(scene => [scene.sceneName, scene.sceneUuid]),
  ]);
  for (const scene of sceneOptions) for (const item of scene.sceneItems ?? []) {
    if (item.sourceUuid && !sourceUuids.has(item.sourceName)) sourceUuids.set(item.sourceName, item.sourceUuid);
  }
  for (const scene of sceneOptions) for (const item of scene.sceneItems ?? []) {
    if (!sourceUuids.has(item.sourceName)) sourceUuids.set(item.sourceName, randomUUID());
  }
  const scenes = sceneOptions.map((scene, sceneIndex) => ({
    sceneName: scene.sceneName,
    sceneUuid: scene.sceneUuid ?? randomUUID(),
    sceneIndex: scene.sceneIndex ?? sceneIndex,
    filters: filters(scene.filters),
    sceneItems: (scene.sceneItems ?? []).map((item, sceneItemIndex) => ({
      sceneItemId: item.sceneItemId ?? sceneItemIndex + 1,
      sourceName: item.sourceName,
      sourceUuid: item.sourceUuid ?? sourceUuids.get(item.sourceName),
      sourceType: item.sourceType ?? (sceneOptions.some(source => source.sceneName === item.sourceName || (item.sourceUuid && source.sceneUuid === item.sourceUuid)) ? 'OBS_SOURCE_TYPE_SCENE' : 'OBS_SOURCE_TYPE_INPUT'),
      sceneItemIndex: item.sceneItemIndex ?? sceneItemIndex,
      sceneItemEnabled: item.sceneItemEnabled ?? true,
      sceneItemLocked: item.sceneItemLocked ?? false,
      sceneItemBlendMode: item.sceneItemBlendMode ?? 'OBS_BLEND_NORMAL',
      sceneItemTransform: clone(item.sceneItemTransform ?? {}),
      inputKind: item.inputKind ?? inputs.find(input => input.inputName === item.sourceName)?.inputKind ?? null,
      isGroup: item.isGroup ?? false,
      filters: filters(item.filters),
    })),
  }));
  const standaloneSources = [];
  for (const scene of scenes) for (const item of scene.sceneItems) {
    if (!inputs.some(input => input.inputUuid === item.sourceUuid || input.inputName === item.sourceName)
      && !scenes.some(source => source.sceneUuid === item.sourceUuid || source.sceneName === item.sourceName)
      && !standaloneSources.some(source => source.sourceUuid === item.sourceUuid || source.sourceName === item.sourceName)) {
      standaloneSources.push({ sourceName: item.sourceName, sourceUuid: item.sourceUuid, filters: item.filters });
    }
  }
  let program = options.currentProgramSceneName === undefined
    ? scenes[0] ?? null : lookup(scenes, options.currentProgramSceneName, undefined, 'sceneName', 'sceneUuid');
  let streaming = options.streaming === true, recording = false, pendingStream = null;
  const requests = [], clients = new Set(), sockets = new Set();
  const failures = new Map(), delays = new Map();
  let closePromise;
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  function emit(eventType, eventData, intent = eventIntents.get(eventType)) {
    if (!Number.isInteger(intent) || intent <= 0) throw new Error(`Unknown event intent for ${eventType}`);
    const message = { op: 5, d: { eventType, eventIntent: intent, eventData: clone(eventData) } };
    for (const client of clients) {
      if (client.identified && (client.subscriptions & intent) !== 0) client.send(message);
    }
  }
  const sceneFor = data => lookup(scenes, data.sceneName, data.sceneUuid, 'sceneName', 'sceneUuid');
  const inputFor = data => lookup(inputs, data.inputName, data.inputUuid, 'inputName', 'inputUuid');
  const audioFor = data => {
    const input = inputFor(data);
    if (!input.audio) throw failure(604, 'The specified input does not support audio.');
    return input;
  };
  function sourceFor(data) {
    const sources = [
      ...inputs.map(input => ({ sourceName: input.inputName, sourceUuid: input.inputUuid, filters: input.filters })),
      ...scenes.map(scene => ({ sourceName: scene.sceneName, sourceUuid: scene.sceneUuid, filters: scene.filters })),
      ...standaloneSources,
    ];
    return lookup(sources, data.sourceName, data.sourceUuid, 'sourceName', 'sourceUuid');
  }
  function filterFor(source, name) {
    required(name, 'filterName');
    const filter = source.filters.find(entry => entry.filterName === name);
    if (!filter) throw failure(600, 'filterName not found');
    return filter;
  }
  function mediaFor(data) {
    const input = inputFor(data);
    if (!input.media) throw failure(602, 'Input is not controllable media');
    return input;
  }
  function itemFor(scene, id) {
    required(id, 'sceneItemId');
    const item = scene.sceneItems.find(entry => entry.sceneItemId === id);
    if (!item) throw failure(600, 'sceneItemId not found');
    return item;
  }
  const sceneIdentity = scene => ({ sceneName: scene.sceneName, sceneUuid: scene.sceneUuid });
  const inputIdentity = input => ({ inputName: input.inputName, inputUuid: input.inputUuid });
  const currentScene = () => ({ currentProgramSceneName: program?.sceneName ?? null, currentProgramSceneUuid: program?.sceneUuid ?? null });
  const sceneList = () => scenes.map(({ sceneIndex, sceneName, sceneUuid }) => ({ sceneIndex, sceneName, sceneUuid }));
  const volume = input => ({ inputVolumeMul: input.inputVolumeMul, inputVolumeDb: inputDb(input.inputVolumeMul) });
  const outputTime = () => ({ outputTimecode: '00:00:00.000', outputDuration: 0 });
  function completeOutput(kind, active) {
    if (kind === 'Stream') streaming = active; else recording = active;
    const data = { outputActive: active, outputState: `OBS_WEBSOCKET_OUTPUT_${active ? 'STARTED' : 'STOPPED'}` };
    if (kind === 'Record' && !active) data.outputPath = OUTPUT_PATH;
    emit(`${kind}StateChanged`, data);
  }
  function setOutput(kind, active) {
    const previous = kind === 'Stream' ? streaming : recording;
    if (previous === active) throw failure(active ? 500 : 501, `${kind} already ${active ? 'active' : 'inactive'}`);
    emit(`${kind}StateChanged`, { outputActive: kind === 'Stream' ? false : active, outputState: `OBS_WEBSOCKET_OUTPUT_${active ? 'STARTING' : 'STOPPING'}` });
    if (kind === 'Stream' && options.deferStreamConfirmation) pendingStream = active;
    else completeOutput(kind, active);
  }
  const handlers = {
    GetVersion: () => ({ obsVersion: '30.2.3', obsWebSocketVersion: WS_VERSION, rpcVersion: RPC_VERSION,
      availableRequests: [...REQUEST_TYPES], supportedImageFormats: ['png', 'jpg'], platform: 'fake', platformDescription: 'Fake OBS' }),
    GetSceneList: () => ({ ...currentScene(), currentPreviewSceneName: null, currentPreviewSceneUuid: null, scenes: sceneList() }),
    CreateScene(data) {
      const sceneName = required(data.sceneName, 'sceneName');
      if (scenes.some(scene => scene.sceneName === sceneName)) throw failure(601, 'sceneName already exists');
      const scene = { sceneName, sceneUuid: randomUUID(), sceneIndex: scenes.length, filters: [], sceneItems: [] };
      scenes.push(scene);
      emit('SceneCreated', { ...sceneIdentity(scene), isGroup: false });
      emit('SceneListChanged', { scenes: sceneList() });
      return { sceneUuid: scene.sceneUuid };
    },
    RemoveScene(data) {
      const scene = sceneFor(data);
      if (scene === program) throw failure(501, 'Cannot remove current scene');
      scenes.splice(scenes.indexOf(scene), 1);
      scenes.forEach((entry, index) => { entry.sceneIndex = index; });
      emit('SceneRemoved', { ...sceneIdentity(scene), isGroup: false });
      emit('SceneListChanged', { scenes: sceneList() });
    },
    GetCurrentProgramScene: currentScene,
    SetCurrentProgramScene(data) {
      const next = sceneFor(data);
      if (program !== next) { program = next; emit('CurrentProgramSceneChanged', sceneIdentity(program)); }
    },
    GetSceneItemList(data) {
      return { sceneItems: sceneFor(data).sceneItems.map(({ filters: _filters, ...item }) => clone(item)) };
    },
    GetSceneItemId(data) {
      const scene = sceneFor(data);
      required(data.sourceName, 'sourceName');
      const matches = scene.sceneItems.filter(item => item.sourceName === data.sourceName);
      const item = matches[data.searchOffset ?? 0];
      if (!item) throw failure(600, 'sourceName not found in scene');
      return { sceneItemId: item.sceneItemId };
    },
    SetSceneItemEnabled(data) {
      const scene = sceneFor(data), item = itemFor(scene, data.sceneItemId);
      const enabled = boolean(data.sceneItemEnabled, 'sceneItemEnabled');
      if (item.sceneItemEnabled !== enabled) {
        item.sceneItemEnabled = enabled;
        emit('SceneItemEnableStateChanged', { ...sceneIdentity(scene), sceneItemId: item.sceneItemId, sceneItemEnabled: enabled });
      }
    },
    GetSourceFilterList: data => ({ filters: clone(sourceFor(data).filters) }),
    CreateSourceFilter(data) {
      const source = sourceFor(data), filterName = required(data.filterName, 'filterName');
      const filterKind = required(data.filterKind, 'filterKind');
      if (source.filters.some(filter => filter.filterName === filterName)) throw failure(601, 'filterName already exists');
      const filter = { filterName, filterKind, filterEnabled: true, filterIndex: source.filters.length, filterSettings: clone(data.filterSettings ?? {}) };
      source.filters.push(filter);
      emit('SourceFilterCreated', { sourceName: source.sourceName, sourceUuid: source.sourceUuid, ...clone(filter) });
    },
    RemoveSourceFilter(data) {
      const source = sourceFor(data), filter = filterFor(source, data.filterName);
      source.filters.splice(source.filters.indexOf(filter), 1);
      source.filters.forEach((entry, index) => { entry.filterIndex = index; });
      emit('SourceFilterRemoved', { sourceName: source.sourceName, sourceUuid: source.sourceUuid, filterName: filter.filterName });
    },
    SetSourceFilterName(data) {
      const source = sourceFor(data), filter = filterFor(source, data.filterName);
      const filterName = required(data.newFilterName, 'newFilterName');
      if (source.filters.some(entry => entry !== filter && entry.filterName === filterName)) throw failure(601, 'filterName already exists');
      const oldFilterName = filter.filterName;
      filter.filterName = filterName;
      emit('SourceFilterNameChanged', { sourceName: source.sourceName, sourceUuid: source.sourceUuid, oldFilterName, filterName });
    },
    SetSourceFilterEnabled(data) {
      const source = sourceFor(data), filter = filterFor(source, data.filterName);
      const enabled = boolean(data.filterEnabled, 'filterEnabled');
      if (filter.filterEnabled !== enabled) {
        filter.filterEnabled = enabled;
        emit('SourceFilterEnableStateChanged', { sourceName: source.sourceName, sourceUuid: source.sourceUuid, filterName: filter.filterName, filterEnabled: enabled });
      }
    },
    GetInputList: data => ({ inputs: inputs.filter(input => !data.inputKind || input.inputKind === data.inputKind)
      .map(({ inputName, inputUuid, inputKind, unversionedInputKind }) => ({ inputName, inputUuid, inputKind, unversionedInputKind })) }),
    GetInputAudioTracks: data => { audioFor(data); return { inputAudioTracks: { 1: true, 2: true, 3: true, 4: true, 5: true, 6: true } }; },
    GetInputMute: data => ({ inputMuted: audioFor(data).inputMuted }),
    SetInputMute(data) {
      const input = audioFor(data), muted = boolean(data.inputMuted, 'inputMuted');
      if (input.inputMuted !== muted) { input.inputMuted = muted; emit('InputMuteStateChanged', { ...inputIdentity(input), inputMuted: muted }); }
    },
    ToggleInputMute(data) {
      const input = audioFor(data);
      input.inputMuted = !input.inputMuted;
      emit('InputMuteStateChanged', { ...inputIdentity(input), inputMuted: input.inputMuted });
      return { inputMuted: input.inputMuted };
    },
    GetInputVolume: data => volume(audioFor(data)),
    SetInputVolume(data) {
      const input = audioFor(data);
      if (data.inputVolumeMul === undefined && data.inputVolumeDb === undefined) throw failure(203, 'Missing inputVolumeMul or inputVolumeDb');
      const mul = data.inputVolumeMul === undefined ? 10 ** (data.inputVolumeDb / 20) : data.inputVolumeMul;
      if (typeof mul !== 'number' || !Number.isFinite(mul) || mul < 0) throw failure(400, 'Invalid input volume');
      if (input.inputVolumeMul !== mul) { input.inputVolumeMul = mul; emit('InputVolumeChanged', { ...inputIdentity(input), ...volume(input) }); }
    },
    GetInputAudioMonitorType: data => ({ monitorType: audioFor(data).monitorType }),
    SetInputAudioMonitorType(data) {
      const input = audioFor(data), monitorType = required(data.monitorType, 'monitorType');
      if (!['OBS_MONITORING_TYPE_NONE', 'OBS_MONITORING_TYPE_MONITOR_ONLY', 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'].includes(monitorType)) throw failure(400, 'Invalid monitorType');
      if (input.monitorType !== monitorType) { input.monitorType = monitorType; emit('InputAudioMonitorTypeChanged', { ...inputIdentity(input), monitorType }); }
    },
    TriggerMediaInputAction(data) {
      const input = mediaFor(data), action = required(data.mediaAction, 'mediaAction');
      const states = { OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY: 'PLAYING', OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE: 'PAUSED',
        OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART: 'PLAYING', OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP: 'STOPPED' };
      if (!states[action]) throw failure(400, 'Invalid mediaAction');
      input.mediaState = `OBS_MEDIA_STATE_${states[action]}`;
      if (action.endsWith('_RESTART') || action.endsWith('_STOP')) input.mediaCursor = 0;
    },
    SetMediaInputCursor(data) {
      const input = mediaFor(data), cursor = required(data.mediaCursor, 'mediaCursor');
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw failure(400, 'Invalid mediaCursor');
      input.mediaCursor = cursor;
    },
    GetMediaInputStatus(data) {
      const input = mediaFor(data);
      return { mediaState: input.mediaState, mediaDuration: 0, mediaCursor: input.mediaCursor };
    },
    GetStreamStatus: () => ({ outputActive: streaming, outputReconnecting: false, ...outputTime(), outputCongestion: 0, outputBytes: 0, outputSkippedFrames: 0, outputTotalFrames: 0 }),
    StartStream: () => { setOutput('Stream', true); },
    StopStream: () => { setOutput('Stream', false); },
    ToggleStream: () => { const active = !streaming; setOutput('Stream', active); return { outputActive: active }; },
    GetRecordStatus: () => ({ outputActive: recording, outputPaused: false, ...outputTime(), outputBytes: 0 }),
    StartRecord: () => { setOutput('Record', true); },
    StopRecord: () => { setOutput('Record', false); return { outputPath: OUTPUT_PATH }; },
  };

  function handleRequest(client, data) {
    const { requestType, requestId } = data;
    const requestData = data.requestData ?? {};
    requests.push({ requestType, requestData: clone(requestData) });
    const respond = () => {
      if (client.closing) return;
      const d = { requestType, requestId };
      try {
        if (!Object.hasOwn(handlers, requestType)) throw failure(204, `Unknown request type: ${requestType}`);
        const forced = failures.get(requestType);
        if (forced && (forced.inputUuid === undefined || forced.inputUuid === requestData.inputUuid)) throw failure(forced.code, forced.comment);
        const responseData = handlers[requestType](requestData);
        d.requestStatus = { result: true, code: 100 };
        if (responseData !== undefined) d.responseData = responseData;
      } catch (error) {
        d.requestStatus = { result: false, code: error.code ?? 500, comment: error.message };
      }
      client.send({ op: 7, d });
    };
    const delay = delays.get(requestType) ?? 0;
    if (delay > 0) {
      const timer = setTimeout(() => { client.timers.delete(timer); respond(); }, delay);
      client.timers.add(timer);
    } else respond();
  }

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
    const protocolHeader = protocols.includes('obswebsocket.json') ? 'Sec-WebSocket-Protocol: obswebsocket.json\r\n' : '';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${protocolHeader}\r\n`);
    socket.setNoDelay(true);
    const auth = options.password === undefined || options.password === null ? null : {
      challenge: randomBytes(32).toString('base64'), salt: randomBytes(32).toString('base64'),
    };
    const client = {
      identified: false, subscriptions: DEFAULT_SUBSCRIPTIONS, closing: false, timers: new Set(),
      send(message) { if (!this.closing && !socket.destroyed) socket.write(frame(1, JSON.stringify(message))); },
      close(code, reason = '') {
        if (this.closing) return;
        this.closing = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        if (!socket.destroyed) socket.end(closeFrame(code, reason));
      },
    };
    clients.add(client);
    socket.on('error', () => { /* El cliente puede desconectarse durante un test. */ });
    socket.on('close', () => {
      client.closing = true;
      for (const timer of client.timers) clearTimeout(timer);
      client.timers.clear();
      clients.delete(client);
    });
    client.send({ op: 0, d: { obsWebSocketVersion: WS_VERSION, rpcVersion: RPC_VERSION, ...(auth ? { authentication: auth } : {}) } });
    function onMessage(payload) {
      let message;
      try { message = JSON.parse(payload.toString('utf8')); }
      catch { client.close(4002, 'Message decode error'); return; }
      const data = message?.d;
      if (!data || typeof data !== 'object' || Array.isArray(data)) { client.close(4003, 'Missing data'); return; }
      if (message.op === 1) {
        if (client.identified) { client.close(4008, 'Already identified'); return; }
        if (data.rpcVersion !== RPC_VERSION) { client.close(4010, 'Unsupported RPC version'); return; }
        if (auth && data.authentication !== hash(hash(options.password + auth.salt) + auth.challenge)) {
          client.close(4009, 'Authentication failed'); return;
        }
        if (data.eventSubscriptions !== undefined && (!Number.isInteger(data.eventSubscriptions) || data.eventSubscriptions < 0)) {
          client.close(4005, 'Invalid event subscriptions'); return;
        }
        client.subscriptions = data.eventSubscriptions ?? DEFAULT_SUBSCRIPTIONS;
        client.identified = true;
        client.send({ op: 2, d: { negotiatedRpcVersion: RPC_VERSION } });
      } else if (!client.identified) client.close(4007, 'Not identified');
      else if (message.op === 3) {
        if (data.eventSubscriptions !== undefined) {
          if (!Number.isInteger(data.eventSubscriptions) || data.eventSubscriptions < 0) client.close(4005, 'Invalid event subscriptions');
          else client.subscriptions = data.eventSubscriptions;
        }
      } else if (message.op === 6) handleRequest(client, data);
      else client.close(4006, 'Unknown opcode');
    }
    let buffer = Buffer.alloc(0), fragments = [], fragmentSize = 0, fragmented = false;
    function onData(chunk) {
      if (client.closing) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const first = buffer[0], second = buffer[1], opcode = first & 15, fin = (first & 0x80) !== 0;
        let size = second & 127, offset = 2;
        if ((first & 0x70) !== 0 || !(second & 0x80)) { client.close(1002, 'Invalid frame'); return; }
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2); offset = 4;
        } else if (size === 127) {
          if (buffer.length < 10) return;
          const longSize = buffer.readBigUInt64BE(2);
          if (longSize > BigInt(MAX_FRAME)) { client.close(1009, 'Frame too large'); return; }
          size = Number(longSize); offset = 10;
        }
        if (size > MAX_FRAME) { client.close(1009, 'Frame too large'); return; }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4), payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode >= 8 && (!fin || size > 125)) { client.close(1002, 'Invalid control frame'); return; }
        if (opcode === 8) { client.closing = true; socket.end(frame(8, payload)); return; }
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode === 10) continue;
        if (opcode === 1 && !fragmented) {
          if (fin) onMessage(payload);
          else { fragmented = true; fragments = [payload]; fragmentSize = payload.length; }
        } else if (opcode === 0 && fragmented) {
          fragments.push(payload); fragmentSize += payload.length;
          if (fragmentSize > MAX_FRAME) { client.close(1009, 'Message too large'); return; }
          if (fin) { fragmented = false; onMessage(Buffer.concat(fragments)); fragments = []; fragmentSize = 0; }
        } else { client.close(1002, 'Invalid opcode'); return; }
        if (client.closing) return;
      }
    }
    socket.on('data', onData);
    if (head.length) onData(head);
  });

  return {
    server, requests, emit,
    addInput(options) {
      const input = makeInput(options);
      if (inputs.some(i => i.inputName === input.inputName || i.inputUuid === input.inputUuid)) throw new Error('Duplicate input');
      inputs.push(input); emit('InputCreated', { ...inputIdentity(input), inputKind: input.inputKind });
    },
    removeInput(inputName) {
      const input = inputFor({ inputName });
      inputs.splice(inputs.indexOf(input), 1); emit('InputRemoved', inputIdentity(input));
    },
    renameInput(inputName, newName) {
      const input = inputFor({ inputName });
      if (inputs.some(i => i !== input && i.inputName === newName)) throw new Error('Duplicate input');
      input.inputName = newName;
      for (const scene of scenes) for (const item of scene.sceneItems) if (item.sourceUuid === input.inputUuid) item.sourceName = newName;
      emit('InputNameChanged', { ...inputIdentity(input), oldInputName: inputName });
    },
    setVolumeMeters: inputs => emit('InputVolumeMeters', { inputs }),
    confirmStream() {
      if (pendingStream === null) throw new Error('No pending stream transition');
      const active = pendingStream; pendingStream = null; completeOutput('Stream', active);
    },
    invalidateSession() { for (const client of clients) client.close(4011, 'Session invalidated'); },
    // Hooks persistentes; null/0 los desactiva. El fallo puede limitarse a un UUID de entrada.
    // El registro refleja la llegada, no la respuesta.
    failRequest(type, error = { code: 500, comment: 'Simulated failure' }, { inputUuid } = {}) {
      if (error === null) failures.delete(type); else failures.set(type, { code: error.code, comment: error.comment, inputUuid });
    },
    delayRequest(type, ms) { if (ms > 0) delays.set(type, ms); else delays.delete(type); },
    close() {
      if (!closePromise) closePromise = new Promise((resolve, reject) => {
        let deadline;
        server.close(error => {
          clearTimeout(deadline);
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
        });
        for (const client of clients) client.close(1001, 'Server shutting down');
        // HTTP sin upgrade y clientes que no completan el cierre no pueden retener el puerto.
        deadline = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 250);
      });
      return closePromise;
    },
  };
}
