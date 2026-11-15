import { createHash } from 'node:crypto';
import { Program } from './program.mjs';

const OBS_EVENTS = (1 << 2) | (1 << 3) | (1 << 6) | (1 << 7);
const hash = value => createHash('sha256').update(value).digest('base64');
const unavailable = () => { throw new Error('Acción todavía no disponible con OBS.'); };

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
    this.capabilities.add('scene-layers');
  }

  get status() { return this._status; }
  setStatus(patch) { this._status = { ...this.status, ...patch }; this.emit('status', this.status); }
  session() { return { scenes: structuredClone(this.scenes), tracks: [], streaming: this.status.streaming, recording: this.status.recording }; }

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
    let id = 0, sceneRevision = 0, refreshing = null;
    this.scenes = [];
    let handshake = setTimeout(() => { try { ws.close(); } catch {} }, this.requestTimeout);
    handshake.unref?.();
    const current = () => !this.stopped && this.ws === ws;
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
    const refreshScenes = () => {
      sceneRevision++;
      if (refreshing) return refreshing;
      refreshing = (async () => {
        while (current()) {
          const revision = sceneRevision, list = await request('GetSceneList');
          const scenes = await Promise.all(list.scenes.map(async scene => {
            const id = scene.sceneUuid ?? scene.sceneName;
            const items = await request('GetSceneItemList', { sceneName: scene.sceneName });
            return { id, name: scene.sceneName, current: scene.sceneUuid && list.currentProgramSceneUuid ? scene.sceneUuid === list.currentProgramSceneUuid : scene.sceneName === list.currentProgramSceneName,
              layers: items.sceneItems.map(item => ({ id: `${id}:${item.sceneItemId}`, name: item.sourceName, visible: item.sceneItemEnabled })) };
          }));
          if (!current()) return;
          if (revision !== sceneRevision) continue;
          this.scenes = scenes;
          if (this.connected) this.emit('session', this.session());
          return;
        }
      })().finally(() => { refreshing = null; });
      return refreshing;
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
        clearTimeout(handshake); handshake = null;
        const initial = { ...revisions };
        void Promise.allSettled([request('GetVersion'), request('GetStreamStatus'), request('GetRecordStatus'), refreshScenes()]).then(results => {
          if (!current()) return;
          const version = results[0].value?.obsVersion;
          if (typeof version === 'string') this._status = { ...this.status, version };
          for (const [index, field] of [[1, 'streaming'], [2, 'recording']]) {
            const value = results[index].value?.outputActive;
            if (revisions[field] === initial[field] && typeof value === 'boolean')
              this._status = { ...this.status, [field]: value, [field + 'Known']: true };
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
        else entry.reject(new Error(`OBS rechazó la petición «${entry.name}».`));
      } else if (message.op === 5) {
        const field = d.eventType === 'StreamStateChanged' ? 'streaming' : d.eventType === 'RecordStateChanged' ? 'recording' : null;
        if (field) {
          const value = d.eventData?.outputActive;
          if (typeof value !== 'boolean') return;
          revisions[field]++;
          if (field === 'streaming' && this.connected && value !== this.status.streaming) this.emit('streaming', value);
          this.setStatus({ [field]: value, [field + 'Known']: true });
          if (this.connected) this.emit('session', this.session());
        } else if (/^(CurrentProgramSceneChanged|SceneCreated|SceneRemoved|SceneNameChanged|SceneListChanged|SceneItemCreated|SceneItemRemoved|SceneItemListReindexed|SceneItemEnableStateChanged|InputNameChanged)$/.test(d.eventType)) sceneEvent(d);
      }
    };
    ws.onerror = () => {}; // No raw transport errors, URLs, close reasons or credentials in logs/status.
    ws.onclose = event => {
      this.sockets.delete(ws);
      ws.clearPending();
      if (!current()) return;
      this.ws = null;
      if (event.code === 4009 || event.code === 4011) {
        this.setStatus({ state: 'error', streamingKnown: false, recordingKnown: false,
          error: event.code === 4009 ? 'Contraseña de OBS incorrecta.' : 'La sesión de OBS ha sido invalidada.' });
      } else this.retry();
    };
  }

  retry() {
    if (this.stopped || this.closePromise) return;
    const wait = this.retryDelays[this.attempts++];
    if (wait === undefined) {
      this.setStatus({ state: 'error', streamingKnown: false, recordingKnown: false, error: 'No se puede conectar con OBS.' });
      return;
    }
    this.setStatus({ state: 'reintentando', streamingKnown: false, recordingKnown: false, error: 'No se puede conectar con OBS.' });
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
  async showScene(ref) {
    const scene = this.findScene(ref);
    if (!scene) throw new Error(`No encuentro la escena «${ref}» en Meld`);
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
  toggleEffect() { return unavailable(); }
  command() { return unavailable(); }
  streamEvent() { return unavailable(); }
  toggleMute() { return unavailable(); }
  setGain() { return unavailable(); }
  media() { return unavailable(); }
  setProperty() { return unavailable(); }
  call() { return unavailable(); }
  dispose() { /* No external listeners: quiesceClose owns the transport. */ }
}
