// Characterization of consumer traffic through HTTP/SSE and the fake Meld wire.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeMeldRecording } from './fake-meld-recording.mjs';
import { observeWire, panel } from './meld-trace.mjs';
import { consumerOrderTrace } from './meld-trace-order.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));
const frame = m => {
  const data = Buffer.from(JSON.stringify(m));
  return Buffer.concat([data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]), data]);
};

// Advertise the remaining real API methods without modifying the shared fake.
// Its normal method handler records them and acknowledges each with a session update.
function advertiseMedia(fake) {
  fake.server.prependListener('upgrade', (_req, socket) => {
    const write = socket.write.bind(socket);
    socket.write = (chunk, ...args) => {
      if (Buffer.isBuffer(chunk) && chunk[0] === 0x81) {
        const offset = (chunk[1] & 127) === 126 ? 4 : 2;
        try {
          const message = JSON.parse(chunk.subarray(offset).toString());
          if (message.type === 10 && message.data?.meld) {
            message.data.meld.methods.push(['callFunction', 19], ['callFunctionWithArgs', 20], ['setProperty', 21]);
            chunk = frame(message);
          }
        } catch { /* not an initialization frame */ }
      }
      return write(chunk, ...args);
    };
  });
}

export async function consumerTrace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-consumer-trace-'));
  const fake = fakeMeldRecording(), wire = observeWire(fake.server), observations = [];
  advertiseMedia(fake);
  Object.assign(fake.state.session.items, {
    s1: { type: 'scene', name: 'Cámara', index: 0, current: true },
    s2: { type: 'scene', name: 'Pantalla', index: 1, current: false },
    l1: { type: 'layer', parent: 's1', name: 'Alertas', index: 0, visible: false },
    e1: { type: 'effect', parent: 'l1', name: 'Brillo', enabled: true },
    t1: { type: 'track', name: 'Micro', muted: false },
  });
  const { createApp } = await import('../../src/server.mjs');
  let app, events;
  const scheduled = [], engineScheduled = [], originalSetTimeout = globalThis.setTimeout;
  t.after(async () => {
    globalThis.setTimeout = originalSetTimeout;
    events?.stop();
    if (app) {
      await app.interactive.drainDraws(); await app.interactive.flush();
      await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); await app.closeHttp();
    }
    await close(fake.server);
    await rm(dir, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, url, body, status = 200) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${url}: ${JSON.stringify(value)}`);
    return value;
  };
  const api = (method, url, body) => request(method, url, body);
  const record = (label, value) => observations.push({ label, value });
  // Each reader is bounded independently, not just by the enclosing test timeout.
  const next = async (name, predicate) => {
    let timer;
    try {
      return await Promise.race([events.next(name, predicate), new Promise((_, reject) => {
        timer = originalSetTimeout(() => reject(new Error(`SSE ${name} timeout`)), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const connect = async () => {
    const idle = wire.idleCount();
    await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
    await next('status', s => s.meld.state === 'conectado');
    await next('meld'); await next('meld'); // initial session and observer registration
    await wire.waitIdleAfter(idle + 1);
  };
  const action = async (url, body, predicate) => {
    const idle = wire.idleCount();
    const response = await api('POST', url, body);
    await next('meld', predicate); await wire.waitIdleAfter(idle);
    return response;
  };
  const report = async streaming => {
    const idle = wire.idleCount();
    fake.report({ streaming });
    const status = await next('status', s => s.meld.streaming === streaming);
    const session = await next('meld', s => s.streaming === streaming);
    await wire.waitIdleAfter(idle);
    record(`stream-${streaming}`, { status: status.meld, session: { streaming: session.streaming, recording: session.recording } });
  };
  const row = async () => {
    const [timer] = await api('GET', '/api/timers');
    const r = timer.runtime;
    return { pausedOffStream: r.pausedOffStream, nextInSec: r.nextInSec, runs: r.runs, lines: r.lines, lastRun: !!r.lastRunAt };
  };
  await api('POST', '/api/config/set', { path: 'meld.autoSession', value: false });
  events = await panel(base, []); await next('status');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  // Unique long delays leave HTTP, WebSocket, transport timeouts and the draw alone.
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 1234000) { scheduled.push(() => fn(...args)); return { ref() {}, unref() {} }; }
    if (ms === 2345000 || ms === 3456000) {
      const timer = { at: Date.now() + ms, fire: () => fn(...args), ref() {}, unref() {} };
      engineScheduled.push(timer); return timer;
    }
    return originalSetTimeout(fn, ms, ...args);
  };
  const advanceEngine = ms => {
    const end = Date.now() + ms;
    while (engineScheduled.length && engineScheduled[0].at <= end) {
      const timer = engineScheduled.shift();
      t.mock.timers.tick(timer.at - Date.now()); timer.fire();
    }
    t.mock.timers.tick(end - Date.now());
  };
  const timer = (await api('POST', '/api/timers', { name: 'Live', message: '', intervalMin: 1, minChatLines: 0 })).timer;
  const fire = `/api/timers/${timer.id}/fire`;
  record('timer-disconnected', { row: await row(), rejected: await request('POST', fire, {}, 409) });
  t.mock.timers.tick(90000); record('timer-disconnected-later', await row());
  await connect(); record('timer-connected-offline', await row());
  await report(true); record('timer-live', await row());
  t.mock.timers.tick(20000); record('timer-counting', await row());
  await report(false); record('timer-stopped', await row());
  t.mock.timers.tick(120000); record('timer-frozen', await row());
  await report(true); record('timer-restarted', await row());
  const fired = await api('POST', fire, {});
  record('timer-fired', { chat: fired.chat, alert: fired.alert, error: fired.error, row: await row() });

  await action('/api/meld/effect', { scene: 'Cámara', layer: 'Alertas', effect: 'Brillo' });
  await action('/api/meld/media', { layer: 'Alertas', command: 'play' });
  await action('/api/meld/media', { layer: 'Alertas', command: 'pause' });
  await action('/api/meld/media', { layer: 'Alertas', command: 'seekTo', seconds: 12.5 });
  await action('/api/meld/property', { id: 'l1', property: 'opacity', value: 0.75 });
  await action('/api/meld/command', { command: 'meld.screenshot' });

  await api('PUT', '/api/alerts/raid', { actions: [
    { kind: 'scene', scene: 'Pantalla' }, { kind: 'layer', scene: 'Cámara', layer: 'Alertas' },
    { kind: 'effect', scene: 'Cámara', layer: 'Alertas', effect: 'Brillo' },
    { kind: 'command', command: 'meld.recordClip' }, { kind: 'hideLayer', scene: 'Cámara', layer: 'Alertas' },
  ] });
  const idle = wire.idleCount();
  const alert = await api('POST', '/api/simulate', { type: 'raid', vars: { user: 'Trace', amount: 20 } });
  record('engine-alert', { hasId: !!alert.alert?.id });
  await next('meld', s => s.scenes[1].current);
  await next('meld', s => s.scenes[0].layers[0].visible);
  await next('meld'); await next('meld');
  await next('meld', s => !s.scenes[0].layers[0].visible);
  await wire.waitIdleAfter(idle + 4);

  // The public timed route first shows a hidden layer, then hides it at expiry.
  await action('/api/meld/layer', { scene: 'Cámara', layer: 'Alertas', visible: true, seconds: 1234 },
    s => s.scenes[0].layers[0].visible);
  assert.equal(scheduled.length, 1);
  const beforeHide = wire.idleCount(); scheduled.shift()();
  record('timed-hide-sse', await next('meld', s => !s.scenes[0].layers[0].visible));
  await wire.waitIdleAfter(beforeHide);

  await api('PUT', '/api/interactive/config', { giveaway: { announceInChat: false, rollSeconds: 1 } });
  await api('POST', '/api/giveaway/open', {});
  await api('POST', '/api/giveaway/join', { user: 'Trace' });
  const beforeDraw = wire.idleCount();
  record('draw', await api('POST', '/api/giveaway/draw', {}));
  await next('meld'); await wire.waitIdleAfter(beforeDraw); // actual confetti after the draw finishes

  // Changes originate at Meld, not at an antena command. Keep the whole public session.
  fake.state.session.items.l1.visible = true;
  fake.state.session.items.l1.url = 'https://example.invalid/overlay';
  const beforeScene = wire.idleCount(); fake.setCurrentScenes(['s1']);
  record('meld-scene-layer-sse', await next('meld', s => s.scenes[0].current && s.scenes[0].layers[0].url));
  await wire.waitIdleAfter(beforeScene);
  const beforeTrack = wire.idleCount(); fake.addTrack('t2', { name: 'Música', muted: true });
  record('meld-track-added-sse', await next('meld', s => s.tracks.some(x => x.id === 't2')));
  await next('meld', s => s.tracks.some(x => x.id === 't2')); await wire.waitIdleAfter(beforeTrack + 1);
  const beforeRemove = wire.idleCount(); fake.removeTrack('t2');
  record('meld-track-removed-sse', await next('meld', s => !s.tracks.some(x => x.id === 't2')));
  await next('meld', s => !s.tracks.some(x => x.id === 't2')); await wire.waitIdleAfter(beforeRemove + 1);
  const meld = await api('GET', '/api/meld');
  record('meld-http', { status: meld.status, scenes: meld.scenes, tracks: meld.tracks, streaming: meld.streaming, recording: meld.recording });
  record('status-http', (await api('GET', '/api/status')).meld);

  await api('POST', '/api/meld/layer', { scene: 'Cámara', layer: 'Alertas', visible: true, seconds: 1234 });
  assert.equal(scheduled.length, 1);
  await api('POST', '/api/meld/disconnect');
  await next('status', s => s.meld.state === 'desconectado');
  record('timer-disconnected-again', await row());
  scheduled.shift()(); // expire while disconnected; no wire call and no replay
  await new Promise(resolve => setImmediate(resolve));
  await connect();
  record('reconnect-session', (({ scenes, tracks, streaming, recording }) => ({ scenes, tracks, streaming, recording }))(await api('GET', '/api/meld')));
  record('timer-reconnected', await row());

  // Append a second raid so all prior wire messages and observations stay intact.
  // The layer is visible and Cámara is current at this point after reconnection.
  await api('PUT', '/api/alerts/raid', { actions: [
    { kind: 'toggleLayer', scene: 'Cámara', layer: 'Alertas' },
    { kind: 'scene', scene: 'Pantalla', returnAfterSec: 2345 },
    { kind: 'layer', scene: 'Cámara', layer: 'Alertas', seconds: 3456 },
    { kind: 'streamEvent', event: 'COUNTER_INCREMENT', amount: '7' },
  ] });
  const beforeEngine = wire.idleCount();
  const timedAlert = await api('POST', '/api/simulate', { type: 'raid', vars: { user: 'Trace', amount: 20 } });
  record('engine-timed-alert', { hasId: !!timedAlert.alert?.id });
  const view = s => ({ currentScene: s.scenes.find(scene => scene.current)?.id, visible: s.scenes[0].layers[0].visible });
  record('engine-toggle', view(await next('meld', s => !s.scenes[0].layers[0].visible)));
  record('engine-scene', view(await next('meld', s => s.scenes[1].current)));
  record('engine-layer-show', view(await next('meld', s => s.scenes[0].layers[0].visible)));
  record('engine-stream-event', view(await next('meld')));
  await wire.waitIdleAfter(beforeEngine + 3);
  assert.deepEqual(engineScheduled.map(timer => timer.at - Date.now()), [2345000, 3456000]);
  advanceEngine(2344999);
  record('engine-before-return', view(await api('GET', '/api/meld')));
  let beforeExpiry = wire.idleCount(); advanceEngine(1);
  record('engine-return', view(await next('meld', s => s.scenes[0].current)));
  await wire.waitIdleAfter(beforeExpiry);
  advanceEngine(1110999);
  record('engine-before-hide', view(await api('GET', '/api/meld')));
  beforeExpiry = wire.idleCount(); advanceEngine(1);
  record('engine-layer-hidden', view(await next('meld', s => !s.scenes[0].layers[0].visible)));
  await wire.waitIdleAfter(beforeExpiry);
  assert.equal(engineScheduled.length, 0);

  // Compare the two no-confetti paths through the public draw and SSE interfaces.
  // Keep prior history and the configured flag observable, but exclude those two
  // expected differences from the otherwise identical snapshots.
  const drawWithoutConfetti = async (confetti, state) => {
    await api('PUT', '/api/interactive/config', { giveaway: { meldConfetti: confetti } });
    assert.equal((await api('GET', '/api/meld')).status.state, state);
    await api('POST', '/api/giveaway/open', {});
    await api('POST', '/api/giveaway/join', { user: 'Probe' });
    const history = (await api('GET', '/api/giveaway')).history;
    const before = wire.messages.length;
    const result = await api('POST', '/api/giveaway/draw', {});
    assert.deepEqual(result, { winner: 'Probe', entries: 1, pool: 1 });
    const rolling = await next('interactive', s => s.giveaway.rolling?.winner === 'Probe' && s.giveaway.history.length === history.length);
    await app.interactive.drainDraws(); // wait for the real delayed confetti decision
    const finished = await next('interactive', s => s.giveaway.rolling?.winner === 'Probe' && s.giveaway.history.length === history.length + 1);
    assert.equal(rolling.config.giveaway.meldConfetti, confetti);
    assert.equal(finished.config.giveaway.meldConfetti, confetti);
    assert.deepEqual(rolling.giveaway.history, history);
    assert.deepEqual(finished.giveaway.history.slice(1), history);
    await new Promise(resolve => setImmediate(resolve));
    const calls = wire.messages.slice(before);
    assert.deepEqual(calls, [], 'draw must send no WebChannel messages');
    const view = s => {
      const { history: _history, ...giveaway } = s.giveaway;
      const { meldConfetti: _flag, ...giveawayConfig } = s.config.giveaway;
      return { ...s, giveaway, config: { ...s.config, giveaway: giveawayConfig } };
    };
    return { result, rolling: view(rolling), finished: view(finished), historyEntry: finished.giveaway.history[0], calls };
  };
  const disabled = await drawWithoutConfetti(false, 'conectado');
  record('draw-confetti-disabled', disabled);
  await api('POST', '/api/meld/disconnect');
  await next('status', s => s.meld.state === 'desconectado');
  const disconnected = await drawWithoutConfetti(true, 'desconectado');
  assert.deepEqual(disconnected, disabled, 'draw result and SSE are unchanged');
  record('draw-meld-disconnected', disconnected);
  return { wire: wire.messages, observations, order: await consumerOrderTrace(t) };
}
