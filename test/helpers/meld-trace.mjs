// End-to-end baseline: only HTTP/SSE drive antena; fake Meld supplies observations.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeMeldRecording } from './fake-meld-recording.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

// Observe every client-to-server Qt WebChannel text message, including init, signal
// subscriptions, idle and observer RPCs (not just fakeMeld.state.calls). WebSocket
// control frames are transport, not WebChannel messages. Reassemble TCP chunks.
export function observeWire(server) {
  const messages = [], signal = new EventEmitter();
  server.prependListener('upgrade', (_req, socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        assert.notEqual(size, 127, 'unexpected oversized WebChannel frame');
        if (buffer.length < offset + 4 + size) return;
        assert.ok(buffer[1] & 128, 'client frame must be masked');
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size).map((b, i) => b ^ mask[i % 4]));
        const opcode = buffer[0] & 15;
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 1) { messages.push(JSON.parse(body.toString())); signal.emit('message'); }
        else assert.ok(opcode >= 8, `unexpected fragmented message: ${opcode}`);
      }
    });
  });
  return {
    messages,
    idleCount: () => messages.filter(m => m.type === 4).length,
    async waitIdleAfter(count) {
      if (this.idleCount() > count) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.off('message', check); reject(new Error('WebChannel idle timeout')); }, 5000);
        const check = () => { if (this.idleCount() > count) { clearTimeout(timer); signal.off('message', check); resolve(); } };
        signal.on('message', check); check();
      });
    },
  };
}

export async function panel(base, observations) {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/stream?client=panel`, { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(), queue = [];
  let buffer = '';
  return {
    stop: () => abort.abort(),
    async next(name, matches = () => true) {
      for (;;) {
        while (queue.length) {
          const event = queue.shift();
          if (event.name === 'status') observations.push({ sse: 'status', meld: event.data.meld });
          if (event.name === 'meld') observations.push({ sse: 'meld', meld: event.data });
          if (event.name === name && matches(event.data)) return event.data;
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, `SSE closed before ${name}`);
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1], data = /^data: (.*)$/m.exec(raw)?.[1];
          if (event && data) queue.push({ name: event, data: JSON.parse(data) });
        }
      }
    },
  };
}

// The fixture preserves all WebChannel messages and all status/meld SSE events read
// up to each barrier, in order. Only dynamic session/alert IDs and timestamps are
// excluded by selecting their public boolean relationships; Meld's stable IDs and
// request IDs, names, values, event ordering and duplicates are never normalized.
export function formatTrace(trace) {
  return '{\n' + Object.entries(trace).map(([key, values]) =>
    `  ${JSON.stringify(key)}: [\n${values.map(value => `    ${JSON.stringify(value)}`).join(',\n')}\n  ]`).join(',\n') + '\n}\n';
}

export async function meldTrace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-trace-'));
  process.env.ANTENA_DATA = path.join(dir, 'data');
  process.env.ANTENA_MEDIA = path.join(dir, 'media');
  const { createApp } = await import('../../src/server.mjs');
  const fake = fakeMeldRecording(), wire = observeWire(fake.server), observations = [];
  fake.state.session.items = {
    s1: { type: 'scene', name: 'Cámara', index: 0, current: true },
    s2: { type: 'scene', name: 'Pantalla', index: 1, current: false },
    l1: { type: 'layer', parent: 's1', name: 'Alertas', index: 0, visible: false },
    t1: { type: 'track', name: 'Micro', muted: false },
  };
  let app, events, overlay;
  t.after(async () => {
    events?.stop(); overlay?.abort();
    if (app) { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); await app.closeHttp(); }
    await close(fake.server);
    await rm(dir, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: process.env.ANTENA_DATA, mediaDir: process.env.ANTENA_MEDIA, push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    assert.equal(response.status, 200, `${method} ${url}: ${JSON.stringify(value)}`);
    return value;
  };
  const snapshot = async label => observations.push({ http: label, meld: (await api('GET', '/api/status')).meld });
  const connect = async () => {
    const idle = wire.idleCount();
    await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
    await events.next('status', s => s.meld.state === 'conectado');
    await events.next('meld'); // initial session
    await events.next('meld'); // registerTrackObserver's session update
    await wire.waitIdleAfter(idle);
  };
  const action = async (url, body, predicate = () => true) => {
    const idle = wire.idleCount();
    await api('POST', url, body);
    await events.next('meld', predicate);
    await wire.waitIdleAfter(idle);
  };
  const report = async (values, predicate) => {
    const idle = wire.idleCount();
    fake.report(values);
    await events.next('status', s => predicate(s.meld));
    await events.next('meld');
    await wire.waitIdleAfter(idle);
  };
  // Poll only a public durable session result, with an explicit bound; never sleep
  // for an assumed amount of work to finish.
  const sessionWhere = async predicate => {
    const until = Date.now() + 5000;
    for (;;) {
      const value = await api('GET', '/api/session');
      if (predicate(value)) return value;
      assert.ok(Date.now() < until, 'automatic session did not settle');
    }
  };
  await api('POST', '/api/config/set', { path: 'meld.autoSession', value: true });
  await api('POST', '/api/config/set', { path: 'meld.recordOnStart', value: true });
  events = await panel(base, observations);
  await events.next('status');
  await snapshot('initial');
  await connect(); await snapshot('connected');
  await action('/api/meld/scene', { scene: 'Pantalla' }, s => s.scenes[1].current);
  await action('/api/meld/layer', { scene: 'Cámara', layer: 'Alertas', visible: true }, s => s.scenes[0].layers[0].visible);
  await action('/api/meld/track', { track: 'Micro' }, s => s.tracks[0].muted);
  await action('/api/meld/track', { track: 'Micro', action: 'gain', gain: 0.25 }, s => s.tracks[0].gain === 0.25);
  await action('/api/meld/event', { event: 'COUNTER_INCREMENT', amount: 2 });
  const shortcut = await api('POST', '/api/shortcuts', { name: 'Trace', steps: [
    { kind: 'scene', scene: 'Cámara' }, { kind: 'hideLayer', scene: 'Cámara', layer: 'Alertas' },
    { kind: 'streamEvent', event: 'CONFETTIPOP_TRIGGER' },
  ] });
  assert.equal((await api('POST', `/api/shortcuts/${shortcut.shortcut.id}/run`)).ok, true);
  await events.next('meld', s => s.scenes[0].current);
  await events.next('meld', s => !s.scenes[0].layers[0].visible);
  await events.next('meld');
  await api('PUT', '/api/alerts/raid', { actions: [
    { kind: 'scene', scene: 'Pantalla' }, { kind: 'layer', scene: 'Cámara', layer: 'Alertas' },
  ] });
  overlay = new AbortController();
  const overlayResponse = await fetch(`${base}/api/stream?client=overlay`, { signal: overlay.signal });
  assert.equal(overlayResponse.status, 200);
  const alert = await api('POST', '/api/simulate', { type: 'raid', vars: { user: 'Trace', amount: 20 } });
  assert.ok(alert.alert?.id);
  await api('POST', '/api/overlay/shown', { id: alert.alert.id });
  await events.next('meld', s => s.scenes[1].current);
  await events.next('meld', s => s.scenes[0].layers[0].visible);
  const before = await api('GET', '/api/session');
  await action('/api/meld/stream', { action: 'start' });
  await report({ streaming: true }, s => s.streaming === true);
  await events.next('meld'); // automatic start-recording RPC
  await report({ recording: true }, s => s.recording === true);
  const live = await sessionWhere(s => s.id !== before.id && s.meldAutoSession === true);
  observations.push({ session: 'started', changedId: live.id !== before.id, auto: live.meldAutoSession });
  await snapshot('live');
  await action('/api/meld/stream', { action: 'stop' });
  await report({ streaming: false }, s => s.streaming === false);
  await events.next('meld'); // automatic stop-recording RPC
  await report({ recording: false }, s => s.recording === false);
  const ended = await sessionWhere(s => s.id === live.id && !!s.endedAt);
  observations.push({ session: 'ended', sameId: ended.id === live.id, ended: !!ended.endedAt });
  await snapshot('ended');
  await api('POST', '/api/meld/disconnect');
  await events.next('status', s => s.meld.state === 'desconectado');
  await connect(); await snapshot('reconnected');
  // The final injected update is a barrier: its idle reaches the fake before capture.
  await report({ streaming: false, recording: false }, s => !s.streaming && !s.recording);
  await api('POST', '/api/meld/disconnect');
  await events.next('status', s => s.meld.state === 'desconectado');
  await snapshot('disconnected');
  return { wire: wire.messages, observations };
}
