// Cliente mínimo de Qt WebChannel para la conexión remota de Meld Studio (ws://127.0.0.1:13376).
// Meld: Ajustes › Avanzado › «Allow remote connections». API: github.com/MeldStudio/streamdeck (WebChannelAPI.md)
import { EventEmitter } from 'node:events';

const T = { signal: 1, propertyUpdate: 2, init: 3, idle: 4, debug: 5, invokeMethod: 6, connectToSignal: 7, disconnectFromSignal: 8, setProperty: 9, response: 10 };

export const MELD_COMMANDS = [
  'meld.screenshot', 'meld.screenshot.vertical', 'meld.startStreamingAction', 'meld.stopStreamingAction', 'meld.toggleStreamingAction',
  'meld.startRecordingAction', 'meld.stopRecordingAction', 'meld.toggleRecordingAction', 'meld.toggleVirtualCameraAction',
  'meld.recordClip', 'meld.replay.show', 'meld.replay.dismiss',
];
export const MELD_STREAM_EVENTS = [
  'CONFETTIFALL_TRIGGER', 'CONFETTIPOP_TRIGGER', 'WHEELSPIN_SPIN', 'COUNTER_INCREMENT', 'COUNTER_DECREMENT',
  'STOPWATCH_RESET', 'STOPWATCH_PAUSE', 'STOPWATCH_RESUME', 'COUNTDOWN_RESET', 'COUNTDOWN_PAUSE', 'COUNTDOWN_RESUME',
  'SUBATHONTIMER_RESET', 'SUBATHONTIMER_PAUSE', 'SUBATHONTIMER_RESUME', 'SUBATHONTIMER_ADDTIME',
];

export class Meld extends EventEmitter {
  constructor(log = console.log) {
    super();
    this.log = log;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sockets = new Set();
    this.retryTimer = null;
    this.closePromise = null;
    this.methods = {};   // nombre → índice
    this.signals = {};   // índice → nombre
    this.props = {};     // índice → nombre
    this.values = {};    // nombre → valor
    this.stopped = true;
    this.url = 'ws://127.0.0.1:13376';
    this.status = { state: 'desconectado', streaming: false, recording: false, version: null, error: null };
  }
  setStatus(p) { this.status = { ...this.status, ...p }; this.emit('status', this.status); }
  get connected() { return this.status.state === 'conectado'; }

  start(url) {
    if (this.closePromise) return;
    if (url) this.url = url;
    this.stopped = false;
    this.connect();
  }
  stop() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    this.clearRetry();
    this.ws = null;
    for (const ws of this.sockets) {
      try { ws.close(); } catch {}
    }
    this.setStatus({ state: 'desconectado' });
  }

  /** Corte terminal: conserva RPC aceptadas y espera cierre físico, sin deadline propio. */
  quiesceClose() {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    this.clearRetry();
    const pending = [...this.pending.values()].map(p => p.done);
    this.closePromise = Promise.resolve().then(async () => {
      const results = await Promise.all(pending);
      const errors = results.filter(result => result.failed).map(result => result.error);
      const closures = [...this.sockets].map(ws => new Promise((resolve, reject) => {
        if (ws.readyState === 3) { resolve(); return; }
        const closed = () => { ws.removeEventListener('close', closed); resolve(); };
        ws.addEventListener('close', closed);
        try {
          if (ws.readyState !== 2) ws.close();
        } catch (error) {
          ws.removeEventListener('close', closed);
          reject(error);
        }
      }));
      for (const result of await Promise.allSettled(closures)) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
      this.ws = null;
      try { this.setStatus({ state: 'desconectado' }); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'No se pudo cerrar la conexión con Meld.');
    });
    return this.closePromise;
  }

  clearRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  connect() {
    if (this.stopped) return;
    this.clearRetry();
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { return this.retry(e); }
    this.ws = ws;
    this.sockets.add(ws);
    this.setStatus({ state: 'conectando', error: null });
    ws.onopen = () => {
      if (this.stopped || ws !== this.ws) return;
      this.send({ type: T.init }, true).then(data => {
        if (!this.stopped && ws === this.ws) this.onInit(data);
      }).catch(e => { try { this.log('[meld]', e.message); } catch {} });
    };
    ws.onmessage = ev => this.onMessage(JSON.parse(ev.data), ws);
    ws.onerror = () => {};
    ws.onclose = () => {
      this.sockets.delete(ws);
      for (const p of this.pending.values()) {
        if (p.ws === ws) p.reject(new Error('Meld se ha desconectado'));
      }
      if (ws !== this.ws) return;
      this.retry(new Error('No se puede conectar con Meld. ¿Está abierto y con «Allow remote connections» activado?'));
    };
  }
  retry(err) {
    if (this.closePromise) return;
    this.setStatus({ state: this.stopped ? 'desconectado' : 'reintentando', error: this.stopped ? null : err.message });
    this.clearRetry();
    if (!this.stopped) {
      const timer = setTimeout(() => {
        if (!this.stopped && this.retryTimer === timer) this.connect();
      }, 5000);
      this.retryTimer = timer;
      timer.unref?.();
    }
  }

  send(msg, expectResponse = false) {
    if (this.closePromise) return Promise.reject(new Error('La conexión con Meld se está cerrando.'));
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('Meld no está conectado'));
    if (!expectResponse) { this.ws.send(JSON.stringify(msg)); return Promise.resolve(); }
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise((resolve, reject) => {
      let complete;
      const done = new Promise(resolveDone => { complete = resolveDone; });
      const finish = (settle, value) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        settle(value);
        complete({ failed: settle === reject, error: value });
      };
      const p = { ws, done, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      const timer = setTimeout(() => p.reject(new Error('Meld no responde')), 8000);
      timer.unref?.();
      this.pending.set(id, p);
      try { ws.send(JSON.stringify({ ...msg, id })); } catch (e) { p.reject(e); }
    });
  }

  onInit(data) {
    const o = data?.meld;
    if (!o) throw new Error('Meld no expone el objeto «meld»');
    this.methods = {}; this.signals = {}; this.props = {}; this.values = {};
    for (const [name, idx] of o.methods || []) {
      const short = name.replace(/\(.*$/, '');
      if (!(short in this.methods)) this.methods[short] = idx;
      this.methods[name] = idx;
    }
    for (const [name, idx] of o.signals || []) this.signals[idx] = name.replace(/\(.*$/, '');
    for (const [idx, name, , value] of o.properties || []) { this.props[idx] = name; this.values[name] = value; }
    // escuchar las señales que interesan
    for (const [idx, name] of Object.entries(this.signals)) {
      if (['sessionChanged', 'isStreamingChanged', 'isRecordingChanged'].includes(name)) this.send({ type: T.connectToSignal, object: 'meld', signal: Number(idx) });
    }
    this.send({ type: T.idle });
    this.setStatus({ state: 'conectado', error: null, version: this.values.version ?? 1, streaming: !!this.values.isStreaming, recording: !!this.values.isRecording });
    this.emit('session', this.session());
  }

  onMessage(m, ws = this.ws) {
    if (m.type === T.response) {
      const p = this.pending.get(m.id);
      if (p?.ws === ws) p.resolve(m.data);
      return;
    }
    if (this.stopped || ws !== this.ws) return;
    if (m.type === T.propertyUpdate) {
      for (const upd of m.data || []) {
        if (upd.object !== 'meld') continue;
        for (const [idx, value] of Object.entries(upd.properties || {})) this.values[this.props[idx]] = value;
      }
      this.send({ type: T.idle }).catch(() => {});
      this.afterChange();
      return;
    }
    if (m.type === T.signal && m.object === 'meld') this.afterChange(this.signals[m.signal]);
  }

  afterChange() {
    const streaming = !!this.values.isStreaming, recording = !!this.values.isRecording;
    if (streaming !== this.status.streaming) this.emit('streaming', streaming);
    this.setStatus({ streaming, recording });
    this.emit('session', this.session());
  }

  async call(method, ...args) {
    const idx = this.methods[method];
    if (idx === undefined) throw new Error(`Meld no tiene el método «${method}»`);
    return this.send({ type: T.invokeMethod, object: 'meld', method: idx, args }, true);
  }

  /** Escenas con sus capas, ordenadas como en Meld. */
  session() {
    const items = this.values.session?.items || {};
    const all = Object.entries(items).map(([id, v]) => ({ id, ...v }));
    const scenes = all.filter(i => i.type === 'scene').sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map(s => ({ id: s.id, name: s.name, current: !!s.current, staged: !!s.staged,
        layers: all.filter(l => l.type === 'layer' && l.parent === s.id).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map(l => ({ id: l.id, name: l.name, visible: !!l.visible, url: l.url || '',
            effects: all.filter(e => e.type === 'effect' && e.parent === l.id).map(e => ({ id: e.id, name: e.name, enabled: !!e.enabled })) })) }));
    const tracks = all.filter(i => i.type === 'track').map(t => ({ id: t.id, name: t.name, muted: !!t.muted, monitoring: !!t.monitoring, parent: t.parent || null }));
    return { scenes, tracks, streaming: !!this.values.isStreaming, recording: !!this.values.isRecording };
  }

  // ---- búsquedas por nombre o id ----
  findScene(ref) {
    const s = this.session().scenes;
    const r = String(ref ?? '').toLowerCase();
    return s.find(x => x.id === ref) || s.find(x => x.name.toLowerCase() === r) || null;
  }
  findLayer(sceneRef, layerRef) {
    const scenes = sceneRef ? [this.findScene(sceneRef)].filter(Boolean) : this.session().scenes;
    const r = String(layerRef ?? '').toLowerCase();
    for (const s of scenes) {
      const l = s.layers.find(x => x.id === layerRef) || s.layers.find(x => x.name.toLowerCase() === r);
      if (l) return { scene: s, layer: l };
    }
    return null;
  }
  findTrack(ref) {
    const r = String(ref ?? '').toLowerCase();
    return this.session().tracks.find(t => t.id === ref || t.name.toLowerCase() === r) || null;
  }

  // ---- acciones ----
  async showScene(ref) {
    const s = this.findScene(ref); if (!s) throw new Error(`No encuentro la escena «${ref}» en Meld`);
    await this.call('showScene', s.id); return s;
  }
  async setLayer(sceneRef, layerRef, visible) {
    const f = this.findLayer(sceneRef, layerRef); if (!f) throw new Error(`No encuentro la capa «${layerRef}»`);
    if (visible === undefined || f.layer.visible !== visible) await this.call('toggleLayer', f.scene.id, f.layer.id);
    return f;
  }
  async toggleEffect(sceneRef, layerRef, effectRef) {
    const f = this.findLayer(sceneRef, layerRef); if (!f) throw new Error(`No encuentro la capa «${layerRef}»`);
    const r = String(effectRef).toLowerCase();
    const e = f.layer.effects.find(x => x.id === effectRef || x.name.toLowerCase() === r); if (!e) throw new Error(`No encuentro el efecto «${effectRef}»`);
    await this.call('toggleEffect', f.scene.id, f.layer.id, e.id);
  }
  command(cmd) { return this.call('sendCommand', cmd); }
  streamEvent(type, data) { return data === undefined ? this.call('sendStreamEvent', type) : this.call('sendStreamEvent', type, data); }
  async toggleMute(ref) { const t = this.findTrack(ref); if (!t) throw new Error(`No encuentro la pista «${ref}»`); await this.call('toggleMute', t.id); }
  async setGain(ref, gain) { const t = this.findTrack(ref); if (!t) throw new Error(`No encuentro la pista «${ref}»`); await this.call('setGain', t.id, Math.max(0, Math.min(1, Number(gain)))); }
  async media(layerRef, cmd, seconds) {
    const f = this.findLayer(null, layerRef); if (!f) throw new Error(`No encuentro la capa «${layerRef}»`);
    if (cmd === 'seekTo') return this.call('callFunctionWithArgs', f.layer.id, 'seekTo', [Number(seconds) || 0]);
    return this.call('callFunction', f.layer.id, cmd);
  }
  async setProperty(objectId, prop, value) { return this.call('setProperty', objectId, prop, value); }
}
