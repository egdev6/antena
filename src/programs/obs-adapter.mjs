import { createHash } from 'node:crypto';
import { httpError } from '../http-util.mjs';
import { Program } from './program.mjs';

const OBS_EVENTS = (1 << 2) | (1 << 3) | (1 << 5) | (1 << 6) | (1 << 7);
const OBS_METERS = 1 << 16;
const hash = value => createHash('sha256').update(value).digest('base64');
const unavailable = () => { throw httpError(409, 'Esta acción solo está disponible con Meld.'); };
const STREAM_COMMANDS = { 'meld.startStreamingAction': 'StartStream', 'meld.stopStreamingAction': 'StopStream',
  'meld.toggleStreamingAction': 'ToggleStream' };
const RECORD_COMMANDS = { 'meld.startRecordingAction': 'StartRecord', 'meld.stopRecordingAction': 'StopRecord',
  'meld.toggleRecordingAction': 'ToggleRecord' };
// Meld gain and OBS inputVolumeMul are both linear amplitude: gain = clamp(mul, 0, 1),
// mul = clamp(gain, 0, 1). Thus 0 = silence, 0.1 = -20 dB, 1 = 0 dB; OBS boost > 1 displays as 1.
const gainOf = value => Math.max(0, Math.min(1, Number(value)));
const inputRef = track => track.id === track.name ? { inputName: track.name } : { inputUuid: track.id };

// Node >=24 already provides the WebSocket client (including masking, fragmentation and TLS).
export class ObsAdapter extends Program {
  constructor({ getPassword = () => '', retryDelays = [500, 1000, 2000, 5000, 10000], requestTimeout = 8000 } = {}) {
    super();
    this.getPassword = getPassword;
    this.retryDelays = retryDelays;
    this.requestTimeout = requestTimeout;
    this.url = 'ws://127.0.0.1:4455';
    this._status = { state: 'desconectado', streaming: false, streamingKnown: false, recording: false,
      recordingKnown: false, recordingWarning: null, version: null, error: null };
    this.stopped = true;
    this.ws = null;
    this.sockets = new Set();
    this.retryTimer = null;
    this.closePromise = null;
    this.attempts = 0;
    this.scenes = [];
    this.tracks = [];
    this.metersWanted = false;
    this.syncMeters = null;
    for (const capability of ['scene-layers', 'layer-effects', 'media-controls', 'audio-tracks', 'streaming', 'recording']) this.capabilities.add(capability);
  }

  get status() { return this._status; }
  setStatus(patch) {
    const status = { ...this.status, ...patch };
    // Like Meld, an unknown output is false; a previous socket cannot confirm this one.
    if (!status.streamingKnown) status.streaming = false;
    if (!status.recordingKnown) status.recording = false;
    this._status = status; this.emit('status', this.status);
  }
  session() { return { scenes: structuredClone(this.scenes), tracks: structuredClone(this.tracks), streaming: this.status.streaming, recording: this.status.recording }; }

  // The high-volume bit is never part of Identify; it is added only for viewers.
  watchMeters(wanted) {
    this.metersWanted = !!wanted;
    this.syncMeters?.();
  }

  start(url) {
    if (this.closePromise) return;
    this.stopSocket();
    if (url) this.url = url;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stopSocket() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    this.syncMeters = null;
    if (ws) {
      ws.clearPending?.();
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  stop() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    this.stopSocket();
    this.setStatus({ state: 'desconectado', streamingKnown: false, recordingKnown: false });
  }

  quiesceClose() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    this.stopSocket();
    const closures = [...this.sockets].map(ws => new Promise(resolve => {
      if (ws.readyState === 3) return resolve();
      ws.addEventListener('close', resolve, { once: true });
      try { if (ws.readyState !== 2) ws.close(); } catch { resolve(); }
    }));
    this.closePromise = Promise.all(closures).then(() => {
      this.setStatus({ state: 'desconectado', streamingKnown: false, recordingKnown: false });
    });
    return this.closePromise;
  }

  connect() {
    if (this.stopped || this.closePromise) return;
    let ws;
    try { ws = new WebSocket(this.url, 'obswebsocket.json'); }
    catch { this.retry(); return; }
    this.ws = ws;
    this.sockets.add(ws);
    this.setStatus({ state: 'conectando', streamingKnown: false, recordingKnown: false, error: null });
    const pending = new Map(), revisions = { streaming: 0, recording: 0 };
    let id = 0, sceneRevision = 0, refreshing = null, sceneNeedsEmit = false, trackRevision = 0, refreshingTracks = null;
    this.scenes = [];
    this.tracks = [];
    let handshake = setTimeout(() => { try { ws.close(); } catch {} }, this.requestTimeout);
    handshake.unref?.();
    const current = () => !this.stopped && this.ws === ws;
    let identified = false, metersSubscribed = false;
    this.syncMeters = () => {
      if (!identified || !current() || metersSubscribed === this.metersWanted) return;
      try {
        ws.send(JSON.stringify({ op: 3, d: { eventSubscriptions: OBS_EVENTS | (this.metersWanted ? OBS_METERS : 0) } }));
        metersSubscribed = this.metersWanted;
      } catch { /* socket close/retry owns recovery */ }
    };
    ws.clearPending = () => {
      clearTimeout(handshake); handshake = null;
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('OBS se ha desconectado.')); }
      pending.clear();
    };
    const request = (name, data) => new Promise((resolve, reject) => {
      if (!current() || ws.readyState !== 1) return reject(new Error('OBS se ha desconectado.'));
      const requestId = String(++id);
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('OBS no responde.')); }, this.requestTimeout);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer, name });
      try { ws.send(JSON.stringify({ op: 6, d: { requestType: name, requestId, ...(data && { requestData: data }) } })); }
      catch { clearTimeout(timer); pending.delete(requestId); reject(new Error('OBS se ha desconectado.')); }
    });
    this.requestObs = request;
    const refreshScenes = (notify = true) => {
      sceneRevision++;
      sceneNeedsEmit ||= notify;
      if (refreshing) return refreshing;
      refreshing = (async () => {
        while (current()) {
          const revision = sceneRevision, list = await request('GetSceneList'), filters = new Map();
          const scenes = await Promise.all(list.scenes.map(async scene => {
            const id = scene.sceneUuid ?? scene.sceneName;
            const items = await request('GetSceneItemList', { sceneName: scene.sceneName });
            const layers = await Promise.all(items.sceneItems.map(async item => {
              if (!filters.has(item.sourceName)) filters.set(item.sourceName, request('GetSourceFilterList', { sourceName: item.sourceName }));
              const result = await filters.get(item.sourceName);
              return { id: `${id}:${item.sceneItemId}`, name: item.sourceName, visible: item.sceneItemEnabled,
                effects: result.filters.map(f => ({ id: f.filterName, name: f.filterName, enabled: f.filterEnabled })) };
            }));
            return { id, name: scene.sceneName, current: scene.sceneUuid && list.currentProgramSceneUuid ? scene.sceneUuid === list.currentProgramSceneUuid : scene.sceneName === list.currentProgramSceneName, layers };
          }));
          if (!current()) return;
          if (revision !== sceneRevision) continue;
          this.scenes = scenes;
          if (sceneNeedsEmit && this.connected) this.emit('session', this.session());
          sceneNeedsEmit = false;
          return;
        }
      })().finally(() => { refreshing = null; });
      return refreshing;
    };
    const refreshTracks = () => {
      trackRevision++;
      if (refreshingTracks) return refreshingTracks;
      refreshingTracks = (async () => {
        while (current()) {
          const revision = trackRevision, list = await request('GetInputList');
          const tracks = await Promise.all(list.inputs.map(async input => {
            const ref = input.inputUuid ? { inputUuid: input.inputUuid } : { inputName: input.inputName };
            let mute, volume, monitor;
            try {
              await request('GetInputAudioTracks', ref);
              [mute, volume, monitor] = await Promise.all([
                request('GetInputMute', ref), request('GetInputVolume', ref), request('GetInputAudioMonitorType', ref),
              ]);
            } catch {
              // One unavailable input (including non-audio 604 or disappeared 600/602)
              // must not prevent the remaining inputs from being enumerated.
              return null;
            }
            return { id: input.inputUuid ?? input.inputName, name: input.inputName, muted: mute.inputMuted,
              monitoring: monitor.monitorType !== 'OBS_MONITORING_TYPE_NONE', parent: null, gain: gainOf(volume.inputVolumeMul) };
          }));
          if (!current()) return;
          if (revision !== trackRevision) continue;
          this.tracks = tracks.filter(Boolean);
          return;
        }
      })().finally(() => { refreshingTracks = null; });
      return refreshingTracks;
    };
    const trackEvent = d => {
      const data = d.eventData ?? {};
      const track = this.tracks.find(t => data.inputUuid ? t.id === data.inputUuid : t.name === (data.oldInputName ?? data.inputName));
      if (d.eventType === 'InputCreated') {
        void refreshTracks().catch(() => {}).then(() => { if (current() && this.connected) this.emit('session', this.session()); });
        return;
      }
      trackRevision++;
      if (d.eventType === 'InputNameChanged') {
        if (track) { if (track.id === track.name) track.id = data.inputName; track.name = data.inputName; }
        for (const scene of this.scenes) for (const layer of scene.layers) if (layer.name === data.oldInputName) layer.name = data.inputName;
        void refreshScenes(false).catch(() => {}).then(() => { if (current() && this.connected) this.emit('session', this.session()); });
        return;
      }
      if (d.eventType === 'InputRemoved') this.tracks = this.tracks.filter(t => t !== track);
      else if (track && d.eventType === 'InputMuteStateChanged' && typeof data.inputMuted === 'boolean') track.muted = data.inputMuted;
      else if (track && d.eventType === 'InputVolumeChanged' && Number.isFinite(data.inputVolumeMul)) track.gain = gainOf(data.inputVolumeMul);
      else if (track && d.eventType === 'InputAudioMonitorTypeChanged' && typeof data.monitorType === 'string') track.monitoring = data.monitorType !== 'OBS_MONITORING_TYPE_NONE';
      if (this.connected) this.emit('session', this.session());
    };
    const sceneEvent = d => {
      const data = d.eventData ?? {};
      if (d.eventType === 'CurrentProgramSceneChanged') {
        sceneRevision++;
        const scene = this.scenes.find(s => data.sceneUuid ? s.id === data.sceneUuid : s.name === data.sceneName);
        if (!scene) { if (!refreshing) void refreshScenes().catch(() => {}); return; }
        this.scenes = this.scenes.map(s => ({ ...s, current: s === scene }));
      } else if (d.eventType === 'SceneItemEnableStateChanged') {
        sceneRevision++;
        const scene = this.scenes.find(s => data.sceneUuid ? s.id === data.sceneUuid : s.name === data.sceneName);
        const layer = scene?.layers.find(l => l.id === `${scene.id}:${data.sceneItemId}`);
        if (!layer || typeof data.sceneItemEnabled !== 'boolean') { if (!refreshing) void refreshScenes().catch(() => {}); return; }
        layer.visible = data.sceneItemEnabled;
      } else {
        void refreshScenes().catch(() => {}); return;
      }
      if (this.connected) this.emit('session', this.session());
    };
    const filterEvent = d => {
      if (d.eventType !== 'SourceFilterEnableStateChanged') { void refreshScenes().catch(() => {}); return; }
      sceneRevision++;
      const data = d.eventData ?? {};
      const layers = this.scenes.flatMap(scene => scene.layers.filter(layer => layer.name === data.sourceName));
      if (!layers.length || typeof data.filterEnabled !== 'boolean' || layers.some(layer => !layer.effects.some(effect => effect.name === data.filterName))) {
        if (!refreshing) void refreshScenes().catch(() => {});
        return;
      }
      for (const layer of layers) layer.effects.find(effect => effect.name === data.filterName).enabled = data.filterEnabled;
      if (this.connected) this.emit('session', this.session());
    };
    ws.onmessage = event => {
      if (!current()) return;
      let message;
      try { message = JSON.parse(event.data); } catch { try { ws.close(); } catch {} return; }
      const d = message?.d;
      if (!d || typeof d !== 'object') return;
      if (message.op === 0) {
        const identify = { rpcVersion: 1, eventSubscriptions: OBS_EVENTS };
        if (d.authentication) {
          try {
            const password = String(this.getPassword() ?? '');
            identify.authentication = hash(hash(password + d.authentication.salt) + d.authentication.challenge);
          } catch { try { ws.close(); } catch {} return; }
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (message.op === 2) {
        // OBS also answers every Reidentify with Identified: do not repeat initialization.
        if (identified) return;
        identified = true;
        this.syncMeters?.();
        clearTimeout(handshake); handshake = null;
        const initial = { ...revisions };
        void Promise.allSettled([request('GetVersion'), request('GetStreamStatus'), request('GetRecordStatus'), refreshScenes(), refreshTracks()]).then(results => {
          if (!current()) return;
          const outputs = [[1, 'streaming', 'OBS no informó el estado de la emisión.'],
            [2, 'recording', 'OBS no informó el estado de la grabación.']];
          const failed = outputs.find(([index]) => results[index].status !== 'fulfilled' || typeof results[index].value?.outputActive !== 'boolean');
          if (failed) { this.stopSocket(); this.retry(failed[2]); return; }
          const version = results[0].value?.obsVersion;
          if (typeof version === 'string') this._status = { ...this.status, version };
          for (const [index, field, error] of outputs) {
            if (revisions[field] === initial[field])
              this._status = { ...this.status, [field]: results[index].value.outputActive, [field + 'Known']: true };
            // A transition during the query invalidates its snapshot, but is not itself a confirmation.
            if (!this.status[field + 'Known']) { this.stopSocket(); this.retry(error); return; }
          }
          this.attempts = 0;
          this.setStatus({ state: 'conectado', error: null });
          this.emit('session', this.session());
        });
      } else if (message.op === 7) {
        const entry = pending.get(d.requestId);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(d.requestId);
        if (d.requestStatus?.result === true) entry.resolve(d.responseData ?? {});
        else {
          const error = new Error(`OBS rechazó la petición «${entry.name}».`);
          if (['TriggerMediaInputAction', 'SetMediaInputCursor', 'GetInputAudioTracks', 'GetInputMute', 'GetInputVolume', 'GetInputAudioMonitorType'].includes(entry.name)) error.obsCode = d.requestStatus?.code;
          entry.reject(error);
        }
      } else if (message.op === 5) {
        if (d.eventType === 'InputVolumeMeters') {
          if (!this.metersWanted || !Array.isArray(d.eventData?.inputs)) return;
          const levels = [];
          for (const input of d.eventData.inputs) {
            const track = this.tracks.find(t => input?.inputUuid ? t.id === input.inputUuid : t.name === input?.inputName);
            if (!track || !Array.isArray(input.inputLevelsMul)) continue;
            let peak = 0, clipping = false;
            for (const channel of input.inputLevelsMul) {
              if (!Array.isArray(channel)) continue;
              if (Number.isFinite(channel[1])) peak = Math.max(peak, channel[1]);
              if (Number.isFinite(channel[2]) && channel[2] >= 1) clipping = true;
            }
            // OBS supplies linear amplitude: 0.001 = -60 dB => 0, 0.01 => 1/3,
            // 0.1 => 2/3, 1 = 0 dB => 1. The third value is the pre-fader input peak.
            const level = peak > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(peak) + 60) / 60)) : 0;
            levels.push({ id: track.id, level, clipping });
          }
          this.emit('meters', levels);
          return;
        }
        const field = d.eventType === 'StreamStateChanged' ? 'streaming' : d.eventType === 'RecordStateChanged' ? 'recording' : null;
        if (field) {
          let value = d.eventData?.outputActive;
          if (typeof value !== 'boolean') return;
          revisions[field]++;
          if (field === 'streaming') {
            // OBS reports outputActive=false for STARTING, STOPPING and RECONNECTING.
            // Keep the last confirmed boolean and Known flag during those transitions;
            // only STARTED/RECONNECTED or STOPPED can open/close a live session.
            const state = d.eventData?.outputState;
            if (state === 'OBS_WEBSOCKET_OUTPUT_STARTED' || state === 'OBS_WEBSOCKET_OUTPUT_RECONNECTED') value = true;
            else if (state === 'OBS_WEBSOCKET_OUTPUT_STOPPED') value = false;
            else return;
          } else {
            // STARTING/STOPPING retain the last confirmation. OBS sends PAUSED with
            // outputActive=false, but the recording remains active and still owned.
            const state = d.eventData?.outputState;
            if (['OBS_WEBSOCKET_OUTPUT_STARTED', 'OBS_WEBSOCKET_OUTPUT_PAUSED', 'OBS_WEBSOCKET_OUTPUT_RESUMED'].includes(state)) value = true;
            else if (state === 'OBS_WEBSOCKET_OUTPUT_STOPPED') value = false;
            else return;
          }
          if (field === 'streaming' && this.connected && value !== this.status.streaming) this.emit('streaming', value);
          this.setStatus({ [field]: value, [field + 'Known']: true });
          if (this.connected) this.emit('session', this.session());
        } else if (/^(InputCreated|InputRemoved|InputNameChanged|InputMuteStateChanged|InputVolumeChanged|InputAudioMonitorTypeChanged)$/.test(d.eventType)) trackEvent(d);
        else if (/^(CurrentProgramSceneChanged|SceneCreated|SceneRemoved|SceneNameChanged|SceneListChanged|SceneItemCreated|SceneItemRemoved|SceneItemListReindexed|SceneItemEnableStateChanged)$/.test(d.eventType)) sceneEvent(d);
        else if (/^(SourceFilterEnableStateChanged|SourceFilterCreated|SourceFilterRemoved|SourceFilterNameChanged|SourceFilterListReindexed)$/.test(d.eventType)) filterEvent(d);
      }
    };
    ws.onerror = () => {}; // No raw transport errors, URLs, close reasons or credentials in logs/status.
    ws.onclose = event => {
      this.sockets.delete(ws);
      ws.clearPending();
      if (!current()) return;
      this.ws = null;
      this.syncMeters = null;
      if (event.code === 4009 || event.code === 4011) {
        this.setStatus({ state: 'error', streamingKnown: false, recordingKnown: false,
          error: event.code === 4009 ? 'Contraseña de OBS incorrecta.' : 'La sesión de OBS ha sido invalidada.' });
      } else this.retry();
    };
  }

  retry(error = 'No se puede conectar con OBS.') {
    if (this.stopped || this.closePromise) return;
    const wait = this.retryDelays[this.attempts++];
    if (wait === undefined) {
      this.setStatus({ state: 'error', streamingKnown: false, recordingKnown: false, error });
      return;
    }
    this.setStatus({ state: 'reintentando', streamingKnown: false, recordingKnown: false, error });
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, wait);
    this.retryTimer.unref?.();
  }

  findScene(ref) {
    const scenes = this.session().scenes, name = String(ref ?? '').toLowerCase();
    return scenes.find(s => s.id === ref) || scenes.find(s => s.name.toLowerCase() === name) || null;
  }
  findLayer(sceneRef, layerRef) {
    const scenes = sceneRef ? [this.findScene(sceneRef)].filter(Boolean) : this.session().scenes;
    const name = String(layerRef ?? '').toLowerCase();
    for (const scene of scenes) {
      const layer = scene.layers.find(l => l.id === layerRef) || scene.layers.find(l => l.name.toLowerCase() === name);
      if (layer) return { scene, layer };
    }
    return null;
  }
  findTrack(ref) {
    const name = String(ref ?? '').toLowerCase();
    return this.session().tracks.find(t => t.id === ref || t.name.toLowerCase() === name) || null;
  }
  async showScene(ref) {
    const scene = this.findScene(ref);
    if (!scene) throw new Error(`No encuentro la escena «${ref}» en el programa de emisión`);
    await this.requestObs('SetCurrentProgramScene', { sceneName: scene.name });
    return scene;
  }
  async setLayer(sceneRef, layerRef, visible) {
    const found = this.findLayer(sceneRef, layerRef);
    if (!found) throw new Error(`No encuentro la capa «${layerRef}»`);
    if (visible === undefined || found.layer.visible !== visible) {
      const sceneItemId = Number(found.layer.id.slice(found.layer.id.lastIndexOf(':') + 1));
      await this.requestObs('SetSceneItemEnabled', { sceneName: found.scene.name, sceneItemId, sceneItemEnabled: visible ?? !found.layer.visible });
    }
    return found;
  }
  async toggleEffect(sceneRef, layerRef, effectRef) {
    const found = this.findLayer(sceneRef, layerRef);
    if (!found) throw new Error(`No encuentro la capa «${layerRef}»`);
    const name = String(effectRef).toLowerCase();
    const effect = found.layer.effects.find(e => e.id === effectRef || e.name.toLowerCase() === name);
    if (!effect) throw new Error(`No encuentro el efecto «${effectRef}»`);
    await this.requestObs('SetSourceFilterEnabled', { sourceName: found.layer.name, filterName: effect.name, filterEnabled: !effect.enabled });
  }
  command(command) {
    if (typeof command !== 'string') return unavailable();
    if (Object.hasOwn(STREAM_COMMANDS, command) || Object.hasOwn(RECORD_COMMANDS, command)) {
      try { this.emit('controlCommand', command); } catch { /* a listener must not change the RPC */ }
    }
    if (Object.hasOwn(RECORD_COMMANDS, command)) return this.requestObs(RECORD_COMMANDS[command]).then(() => undefined);
    if (!Object.hasOwn(STREAM_COMMANDS, command)) return unavailable();
    return this.requestObs(STREAM_COMMANDS[command]).then(() => undefined);
  }
  streamEvent() { return unavailable(); }
  async toggleMute(ref) {
    const track = this.findTrack(ref); if (!track) throw new Error(`No encuentro la pista «${ref}»`);
    await this.requestObs('ToggleInputMute', inputRef(track));
  }
  async setGain(ref, gain) {
    const track = this.findTrack(ref); if (!track) throw new Error(`No encuentro la pista «${ref}»`);
    const value = gainOf(gain);
    await this.requestObs('SetInputVolume', { ...inputRef(track), inputVolumeMul: value });
    const current = this.tracks.find(t => t.id === track.id);
    if (current && current.gain !== value) { current.gain = value; if (this.connected) this.emit('session', this.session()); }
    return value;
  }
  async media(layerRef, command, seconds) {
    const found = this.findLayer(null, layerRef);
    if (!found) throw new Error(`No encuentro la capa «${layerRef}»`);
    const actions = { play: 'PLAY', pause: 'PAUSE', restart: 'RESTART', stop: 'STOP' };
    if (command !== 'seekTo' && !Object.hasOwn(actions, command)) throw new Error(`Comando multimedia «${command}» no disponible con OBS.`);
    try {
      if (command === 'seekTo') await this.requestObs('SetMediaInputCursor', { inputName: found.layer.name, mediaCursor: Math.round((Number(seconds) || 0) * 1000) });
      else await this.requestObs('TriggerMediaInputAction', { inputName: found.layer.name, mediaAction: `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${actions[command]}` });
    } catch (error) {
      if (error.obsCode === 600 || error.obsCode === 602) throw new Error(`La capa «${found.layer.name}» no es una fuente multimedia de OBS.`);
      throw error;
    }
  }
  setProperty() { return unavailable(); }
  call() { return unavailable(); }
  dispose() { /* No external listeners: quiesceClose owns the transport. */ }
}
