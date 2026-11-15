import { createHash } from 'node:crypto';
import { Program } from './program.mjs';

const OUTPUT_EVENTS = 1 << 6;
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
  }

  get status() { return this._status; }
  setStatus(patch) { this._status = { ...this.status, ...patch }; this.emit('status', this.status); }
  session() { return { scenes: [], tracks: [], streaming: this.status.streaming, recording: this.status.recording }; }

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
    let id = 0, initializing = false;
    let handshake = setTimeout(() => { try { ws.close(); } catch {} }, this.requestTimeout);
    handshake.unref?.();
    ws.clearPending = () => {
      clearTimeout(handshake); handshake = null;
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    };
    const current = () => !this.stopped && this.ws === ws;
    const finish = () => {
      if (!current() || !initializing || pending.size) return;
      initializing = false;
      this.attempts = 0;
      this.setStatus({ state: 'conectado', error: null });
      this.emit('session', this.session());
    };
    const request = (name, field) => {
      const requestId = String(++id), revision = field ? revisions[field] : 0;
      const timer = setTimeout(() => { pending.delete(requestId); finish(); }, this.requestTimeout);
      timer.unref?.();
      pending.set(requestId, { name, field, revision, timer });
      ws.send(JSON.stringify({ op: 6, d: { requestType: name, requestId } }));
    };
    ws.onmessage = event => {
      if (!current()) return;
      let message;
      try { message = JSON.parse(event.data); } catch { try { ws.close(); } catch {} return; }
      const d = message?.d;
      if (!d || typeof d !== 'object') return;
      if (message.op === 0) {
        const identify = { rpcVersion: 1, eventSubscriptions: OUTPUT_EVENTS };
        if (d.authentication) {
          try {
            const password = String(this.getPassword() ?? '');
            identify.authentication = hash(hash(password + d.authentication.salt) + d.authentication.challenge);
          } catch { try { ws.close(); } catch {} return; }
        }
        ws.send(JSON.stringify({ op: 1, d: identify }));
      } else if (message.op === 2) {
        clearTimeout(handshake); handshake = null;
        initializing = true;
        request('GetVersion'); request('GetStreamStatus', 'streaming'); request('GetRecordStatus', 'recording');
      } else if (message.op === 7) {
        const entry = pending.get(d.requestId);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(d.requestId);
        if (d.requestStatus?.result === true) {
          if (entry.name === 'GetVersion' && typeof d.responseData?.obsVersion === 'string')
            this._status = { ...this.status, version: d.responseData.obsVersion };
          else if (entry.field && revisions[entry.field] === entry.revision && typeof d.responseData?.outputActive === 'boolean')
            this._status = { ...this.status, [entry.field]: d.responseData.outputActive, [entry.field + 'Known']: true };
        }
        finish();
      } else if (message.op === 5) {
        const field = d.eventType === 'StreamStateChanged' ? 'streaming' : d.eventType === 'RecordStateChanged' ? 'recording' : null;
        const value = d.eventData?.outputActive;
        if (!field || typeof value !== 'boolean') return;
        revisions[field]++;
        if (field === 'streaming' && this.connected && value !== this.status.streaming) this.emit('streaming', value);
        this.setStatus({ [field]: value, [field + 'Known']: true });
        if (this.connected) this.emit('session', this.session());
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

  showScene() { return unavailable(); }
  setLayer() { return unavailable(); }
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
