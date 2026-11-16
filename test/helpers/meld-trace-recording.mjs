// Characterize route guards and recording ownership on the unchanged Meld consumer.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server.mjs';
import { fakeMeldRecording } from './fake-meld-recording.mjs';
import { observeWire, panel } from './meld-trace.mjs';
import { observeStatusConsumers } from './meld-trace-order.mjs';

export async function recordingTrace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-recording-trace-'));
  const fake = fakeMeldRecording(), wire = observeWire(fake.server), sse = [], steps = [], control = [], order = [];
  let app, events, captureStatus = false;
  t.after(async () => {
    events?.stop();
    if (app) { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose(); await app.closeHttp(); }
    await new Promise(resolve => fake.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.json() };
  };
  const next = async (name, predicate) => {
    let timer;
    try { return await Promise.race([events.next(name, predicate), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SSE ${name} timeout`)), 5000);
    })]); } finally { clearTimeout(timer); }
  };
  for (const [key, value] of [['autoSession', false], ['recordOnStart', true]])
    assert.equal((await request('POST', '/api/config/set', { path: `meld.${key}`, value })).status, 200);
  events = await panel(base, sse); await next('status'); await next('status');

  // Pin the adapter's live status identity and its start/stop delegation at connect.
  const lifecycle = [], start = app.meld.start.bind(app.meld), stop = app.meld.stop.bind(app.meld);
  let startStatus;
  app.meld.start = url => {
    lifecycle.push(['start', url === `ws://127.0.0.1:${fake.server.address().port}`]);
    const result = start(url); startStatus = app.meld.status;
    assert.strictEqual(app.program.status, startStatus);
    return result;
  };
  app.meld.stop = () => { lifecycle.push('stop'); return stop(); };
  let idle = wire.idleCount();
  const connected = await request('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
  assert.equal(connected.status, 200); assert.deepEqual(connected.body, startStatus);
  await next('status', s => s.meld.state === 'conectado'); await next('meld'); await wire.waitIdleAfter(idle);
  steps.push({ step: 'connect', result: connected, lifecycle: [...lifecycle], sameStatusObject: true });

  // The recording listener is the only non-forwarder controlCommand consumer.
  // Wrap at its current emitter so the same probe observes it before and after migration.
  const emitters = [app.program, app.meld];
  const listeners = emitters.flatMap(emitter => emitter.listeners('controlCommand').map(listener => ({ emitter, listener })));
  const recording = listeners.filter(({ listener }) => listener.toString().includes('sendingOwn'));
  const forward = listeners.filter(({ listener }) => listener.toString().includes('this.emit(event'));
  assert.equal(recording.length, 1); assert.equal(forward.length, 1); assert.equal(listeners.length, 2);
  for (const emitter of emitters) {
    const current = emitter.listeners('controlCommand');
    for (const listener of current) emitter.off('controlCommand', listener);
    for (const listener of current) emitter.on('controlCommand', function (command) {
      control.push([listener === forward[0].listener ? 'adapter' : 'recording', command]);
      return listener.call(this, command);
    });
  }
  observeStatusConsumers(app, label => { if (captureStatus) order.push(label); });
  const rpc = async (label, url, body) => {
    const before = wire.idleCount(), result = await request('POST', url, body);
    if (result.status === 200) { await next('meld'); await wire.waitIdleAfter(before); }
    steps.push({ step: label, result });
    return result;
  };
  const stream = (label, action) => rpc(label, '/api/meld/stream', { action });
  const duplicate = async action => {
    const before = await request('GET', '/api/session'), count = wire.messages.length;
    const result = await stream(`duplicate-${action}`, action);
    assert.deepEqual(result, { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación del programa de emisión.' } });
    assert.deepEqual(await request('GET', '/api/session'), before); assert.equal(wire.messages.length, count);
  };
  const report = async (values, extraRpc = false) => {
    const before = wire.idleCount(); fake.report(values);
    await next('status', s => Object.entries(values).every(([key, value]) => s.meld[key] === value));
    await next('meld'); if (extraRpc) await next('meld');
    await wire.waitIdleAfter(before + (extraRpc ? 1 : 0));
  };

  // An HTTP request is not confirmation: duplicates fail until real status clears each guard.
  await stream('owned-start', 'start'); await duplicate('start');
  captureStatus = true; await report({ streaming: true }, true); captureStatus = false;
  await report({ recording: true });
  await stream('owned-stop', 'stop'); await duplicate('stop');
  await report({ streaming: false }, true); await report({ recording: false });
  // Already-active external recording is never claimed or stopped.
  await report({ recording: true }); await stream('external-start', 'start');
  await report({ streaming: true }); await stream('external-stop', 'stop'); await report({ streaming: false });
  await report({ recording: false });
  // A failed recording request warns but leaves the confirmed stream live.
  const command = app.meld.command.bind(app.meld);
  app.meld.command = value => value === 'meld.startRecordingAction' ? Promise.reject(new Error('simulated recording failure')) : command(value);
  await stream('failure-start', 'start'); await report({ streaming: true });
  if (!sse.some(event => event.sse === 'status' && event.meld.recordingWarning))
    await next('status', s => !!s.meld.recordingWarning);
  steps.push({ step: 'recording-failure-status', result: await request('GET', '/api/status') });
  app.meld.command = command;
  await stream('failure-stop', 'stop'); await report({ streaming: false });
  // A manual external control command revokes ownership before any status change.
  await stream('manual-start', 'start'); await report({ streaming: true }, true); await report({ recording: true });
  await rpc('manual-command', '/api/meld/command', { command: 'meld.toggleRecordingAction' });
  await stream('manual-stop', 'stop'); await report({ streaming: false });
  const disconnected = await request('POST', '/api/meld/disconnect');
  await next('status', s => s.meld.state === 'desconectado');
  steps.push({ step: 'disconnect', result: disconnected, lifecycle: [...lifecycle] });
  // Other service status fields are unrelated and can contain dynamic metadata.
  const warning = steps.find(step => step.step === 'recording-failure-status').result.body.meld;
  steps.find(step => step.step === 'recording-failure-status').result.body = warning;
  // Group adjacent entries for a compact fixture without dropping order or payloads.
  const pairs = values => Array.from({ length: Math.ceil(values.length / 2) }, (_, i) => values.slice(i * 2, i * 2 + 2));
  return { wire: pairs(wire.messages), sse, steps, order: [order], control: pairs(control) };
}
