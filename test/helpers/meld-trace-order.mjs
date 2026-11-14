// Characterize the order of real consumer consequences before any migration.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeMeldRecording } from './fake-meld-recording.mjs';
import { observeWire, panel } from './meld-trace.mjs';

export async function consumerOrderTrace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-consumer-order-'));
  const fake = fakeMeldRecording(), wire = observeWire(fake.server), received = [], order = [], broadcasts = [];
  fake.state.session.items = { s1: { type: 'scene', name: 'Cámara', index: 0, current: true } };
  const { createApp } = await import('../../src/server.mjs');
  let app, events;
  t.after(async () => {
    events?.stop();
    if (app) { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); await app.closeHttp(); }
    await new Promise(resolve => fake.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const value = await response.json();
    assert.equal(response.status, 200, `${method} ${url}: ${JSON.stringify(value)}`);
    return value;
  };
  const next = async (name, predicate) => {
    let timer;
    try {
      return await Promise.race([events.next(name, predicate), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`SSE ${name} timeout`)), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  // A read-only projection of the already-initialized timer: snapshot() would
  // call _syncLive and make a late status listener look as if it ran in time.
  const row = () => {
    const [timer] = app.timers.list, state = app.timers.state.get(timer.id);
    assert.ok(state, 'timer state must already exist');
    const pausedOffStream = !!timer.onlyWhenLive && !app.timers.isLive();
    const countAt = pausedOffStream ? Math.max(state.lastAt, state.offlineAt) : Date.now();
    const nextInSec = Math.round(Math.max(0, state.lastAt + app.timers.intervalMs(timer) - countAt) / 1000);
    return { pausedOffStream, nextInSec, runs: state.runs, lines: state.lines, lastRun: !!state.lastRunAt };
  };
  await api('POST', '/api/config/set', { path: 'meld.autoSession', value: true });
  await api('POST', '/api/config/set', { path: 'meld.recordOnStart', value: true });
  await api('POST', '/api/timers', { name: 'Order', message: '', intervalMin: 1, minChatLines: 0 });
  const before = await api('GET', '/api/session');
  events = await panel(base, received);
  await next('status'); await next('status'); // initial snapshot and panel-connected broadcast
  let idle = wire.idleCount();
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
  await next('status', s => s.meld.state === 'conectado'); await next('meld'); await wire.waitIdleAfter(idle);
  idle = wire.idleCount();
  await api('POST', '/api/meld/stream', { action: 'start' });
  await next('meld'); await wire.waitIdleAfter(idle); // stream command acknowledgement

  // These public seams delegate immediately. Capture the same snapshots that are
  // actually sent to the panel, alongside the synchronous auto-session and
  // recording-on-start calls; then verify the real SSE reader received each one.
  let capture = false, statusDepth = 0;
  // Preserve the existing raw registration order while observing the entry to
  // each later consumer, including branches that do not produce an SSE event.
  const laterConsumers = [
    ['auto-session-status', 'const connectedNow ='],
    ['youtube-auto-status', 'youtubeAuto.begin()'],
    ['recording-status', 'const op = operation;'],
    ['route-guard-status', 'pending.keys()'],
  ];
  const listeners = app.meld.listeners('status');
  const labels = new Map(laterConsumers.map(([label, source]) => {
    const matches = listeners.filter(listener => listener.toString().includes(source));
    assert.equal(matches.length, 1, `expected one raw ${label} listener`);
    return [matches[0], label];
  }));
  for (const listener of listeners) app.meld.off('status', listener);
  for (const listener of listeners) {
    const label = labels.get(listener);
    app.meld.on('status', label ? function (...args) {
      if (capture) order.push({ event: label });
      return listener.apply(this, args);
    } : listener);
  }
  // No other raw session consumers exist today. This sentinel detects whether
  // the exact session sent to the panel has already been broadcast on entry.
  app.meld.on('session', data => {
    if (capture) order.push({ event: 'later-raw-session', meld: structuredClone(data) });
  });
  const send = app.bus.send.bind(app.bus), startNew = app.session.startNew.bind(app.session), command = app.meld.command.bind(app.meld);
  const setStatus = app.meld.setStatus.bind(app.meld), syncLive = app.timers._syncLive.bind(app.timers);
  // Store changes also sync timers, notably before disconnect; only record calls
  // made synchronously while the real Meld status event is being dispatched.
  app.meld.setStatus = (...args) => {
    statusDepth++;
    try { return setStatus(...args); } finally { statusDepth--; }
  };
  app.timers._syncLive = (...args) => {
    const result = syncLive(...args);
    if (capture && statusDepth) order.push({ event: 'timers-status', row: row() });
    return result;
  };
  app.bus.send = (name, data, kinds) => {
    if (capture && (name === 'status' || name === 'meld')) {
      const event = { sse: name, meld: structuredClone(name === 'status' ? data.meld : data) };
      broadcasts.push(event); order.push({ ...event, row: row() });
    }
    return send(name, data, kinds);
  };
  app.session.startNew = (...args) => {
    if (capture) order.push({ event: 'auto-session-start', row: row() });
    return startNew(...args);
  };
  app.meld.command = (...args) => {
    if (capture && args[0] === 'meld.startRecordingAction') order.push({ event: 'recording-on-start', row: row() });
    return command(...args);
  };
  let seen = received.length;
  capture = true; idle = wire.idleCount(); fake.report({ streaming: true });
  await next('meld'); await next('meld'); // report and recording command's separate session update
  await wire.waitIdleAfter(idle + 1);
  assert.deepEqual(received.slice(seen), broadcasts);
  const deadline = performance.now() + 5000;
  let live;
  do {
    live = await api('GET', '/api/session');
    assert.ok(performance.now() < deadline, 'automatic session did not settle');
  } while (live.id === before.id || live.meldAutoSession !== true);
  order.push({ event: 'live-settled', row: row(), changedId: live.id !== before.id, auto: live.meldAutoSession,
    recordingCalls: fake.state.calls.filter(c => c[1] === 'meld.startRecordingAction') });
  capture = false;
  idle = wire.idleCount(); fake.report({ recording: true });
  await next('status', s => s.meld.recording === true); await next('meld'); await wire.waitIdleAfter(idle);
  t.mock.timers.tick(20000);
  seen = received.length; const sent = broadcasts.length;
  capture = true;
  await api('POST', '/api/meld/disconnect');
  await next('status', s => s.meld.state === 'desconectado');
  assert.deepEqual(received.slice(seen), broadcasts.slice(sent));
  order.push({ event: 'disconnected-settled', row: row() });
  capture = false;
  return order;
}
