import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { Meld, MELD_COMMANDS as rawCommands, MELD_STREAM_EVENTS as rawEvents } from '../src/meld.mjs';
import { Timers } from '../src/timers.mjs';
import { Interactive, DEFAULT_INTERACTIVE_CONFIG } from '../src/interactive.mjs';
import { MeldAdapter } from '../src/programs/meld-adapter.mjs';
import { createProgram, MELD_COMMANDS, MELD_STREAM_EVENTS } from '../src/programs/index.mjs';
import { createApp } from '../src/server.mjs';
import { YouTubeAutoConnect } from '../src/youtube-auto.mjs';
import { observeStatusConsumers } from './helpers/meld-trace-order.mjs';

const names = ['status', 'session', 'streaming', 'controlCommand'];

test('program factory creates a Meld adapter, accepts the raw instance and re-exports the same catalogues', () => {
  const created = createProgram('meld', { log: () => {} });
  assert.ok(created instanceof MeldAdapter);
  assert.equal(created.status.state, 'desconectado');
  created.stop(); created.dispose();
  const meld = new Meld(() => {}), program = createProgram('meld', { meld });
  assert.ok(program instanceof MeldAdapter);
  assert.strictEqual(program.status, meld.status);
  program.setStatus({ error: 'same instance' });
  assert.strictEqual(program.status, meld.status);
  assert.equal(meld.status.error, 'same instance');
  assert.strictEqual(MELD_COMMANDS, rawCommands);
  assert.strictEqual(MELD_STREAM_EVENTS, rawEvents);
  assert.throws(() => createProgram('unknown'), /Unsupported program/);
  program.dispose();
});

test('createApp keeps raw Meld and registers each adapter forwarder before every consumer', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-wiring-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  assert.ok(app.meld instanceof Meld);
  assert.ok(app.program instanceof MeldAdapter);
  assert.strictEqual(app.program.raw, app.meld);
  assert.strictEqual(app.program.status, app.meld.status);
  for (const name of names) {
    const value = {}, extra = {};
    let seen;
    app.program.once(name, (...args) => { seen = args; });
    app.meld.listeners(name)[0](value, extra);
    assert.strictEqual(seen[0], value, name);
    assert.strictEqual(seen[1], extra, name);
  }
  const order = [], send = app.bus.send.bind(app.bus);
  app.bus.send = (name, ...args) => { if (name === 'status') order.push('broadcast'); return send(name, ...args); };
  app.program.prependListener('status', () => order.push('program'));
  app.meld.on('status', () => order.push('raw'));
  app.meld.setStatus({ error: 'observable' });
  assert.deepEqual(order, ['program', 'broadcast', 'raw']);
  assert.strictEqual(app.program.status, app.meld.status);
  assert.equal(app.meld.status.error, 'observable');
});

test('timers react once to program status and to status forwarded from Meld', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-timers-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (url, body) => {
    const response = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await post('/api/config/set', { path: 'meld.autoSession', value: false });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const { timer } = await post('/api/timers', { name: 'Program', message: '', intervalMin: 1, minChatLines: 0 });
  const syncLive = app.timers._syncLive.bind(app.timers);
  let reactions = 0;
  app.timers._syncLive = (...args) => { reactions++; return syncLive(...args); };
  t.mock.timers.tick(120_000);
  // Change the raw state without emitting there: only the program event can
  // reset the overdue timer. Reading due() does not synchronize live state.
  app.meld.status = { ...app.meld.status, state: 'conectado', streaming: true };
  assert.equal(app.timers.due(timer), null);
  app.program.emit('status', app.program.status);
  assert.equal(app.timers.due(timer), 'aún no toca');
  assert.equal(reactions, 1);
  assert.strictEqual(app.timers.meld, app.program);
  t.mock.timers.tick(60_000);
  assert.equal(app.timers.due(timer), null);
  app.meld.setStatus({ streaming: false });
  assert.equal(app.timers.due(timer), 'no estás emitiendo');
  t.mock.timers.tick(120_000);
  app.meld.setStatus({ streaming: true });
  assert.equal(app.timers.due(timer), 'aún no toca');
  assert.equal(reactions, 3, 'one reaction per program or forwarded raw status');
});

test('legacy meld constructor input still accepts a duck-typed status emitter', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const meld = new EventEmitter();
  meld.connected = false; meld.status = { streaming: false };
  const timer = { id: 'legacy', intervalMin: 1, minChatLines: 0, onlyWhenLive: true };
  const timers = new Timers({ store: { config: { timers: [timer] } }, meld });
  timers.snapshot(); // establish its initial off-stream interval
  t.mock.timers.tick(120_000);
  meld.connected = true; meld.status.streaming = true; meld.emit('status', meld.status);
  assert.equal(timers.due(timer), 'aún no toca');
  t.mock.timers.tick(60_000);
  assert.equal(timers.due(timer), null);
});

test('shutdown forwards Meld terminal status before disposing its adapter', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-shutdown-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import path from 'node:path';
    import { DATA } from './src/store.mjs';
    import { startServer } from './src/server.mjs';
    assert.equal(DATA, process.env.ANTENA_DATA, 'server data must be isolated before startup');
    assert.notEqual(path.resolve(DATA), path.resolve('data'));
    assert.notEqual(path.resolve(process.env.ANTENA_MEDIA), path.resolve('media'));
    const originalListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (_port, host, callback) { return originalListen.call(this, 0, host, callback); };
    const app = await startServer({ quiet: true, handleSignals: false, log: () => {} });
    net.Server.prototype.listen = originalListen;
    const names = ${JSON.stringify(names)};
    const events = [], close = app.meld.quiesceClose.bind(app.meld), dispose = app.program.dispose.bind(app.program);
    const counts = names.map(name => app.meld.listenerCount(name));
    app.program.on('status', status => events.push(status.state));
    app.meld.quiesceClose = () => { events.push('close'); return close().then(() => { events.push('closed'); }); };
    app.program.dispose = () => { events.push('dispose'); return dispose(); };
    const code = await app.close();
    const afterClose = [...events], afterCounts = names.map(name => app.meld.listenerCount(name));
    app.meld.setStatus({ error: 'after shutdown' });
    console.log(JSON.stringify({ code, afterClose, counts, afterCounts, afterLateStatus: events,
      dataDir: app.store.dir, mediaDir: app.mediaDir }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH || '', ANTENA_DATA: path.join(dir, 'data'), ANTENA_MEDIA: path.join(dir, 'media') },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  const { code, afterClose, counts, afterCounts, afterLateStatus, dataDir, mediaDir } = JSON.parse(result.stdout);
  assert.equal(dataDir, path.join(dir, 'data'));
  assert.equal(mediaDir, path.join(dir, 'media'));
  assert.equal(code, 0);
  assert.deepEqual(afterClose, ['close', 'desconectado', 'closed', 'dispose']);
  assert.deepEqual(afterCounts, counts.map(n => n - 1));
  assert.deepEqual(afterLateStatus, ['close', 'desconectado', 'closed', 'dispose']);
});

test("timers react to Meld status before any later raw status listener", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "ant-program-timers-order-"));
  const app = await createApp({ dataDir: path.join(dir, "data"), mediaDir: path.join(dir, "media"), push: {}, log: () => {} });
  t.after(async () => { app.meld.stop(); app.program.dispose(); await rm(dir, { recursive: true, force: true }); });
  const seen = [], sync = app.timers._syncLive.bind(app.timers);
  app.timers._syncLive = (...a) => { seen.push("timers"); return sync(...a); };
  app.meld.on("status", () => seen.push("late-raw"));
  app.meld.setStatus({ streaming: true });
  assert.deepEqual(seen.filter(x => x === "timers" || x === "late-raw").slice(0, 2), ["timers", "late-raw"]);
});

test('panel status broadcast follows timers and precedes later raw listeners', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-status-broadcast-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  const order = [], sent = [], send = app.bus.send.bind(app.bus), sync = app.timers._syncLive.bind(app.timers);
  app.timers._syncLive = (...args) => { order.push('timers'); return sync(...args); };
  app.bus.send = (name, data, kinds) => {
    if (name === 'status') { order.push('broadcast'); sent.push({ data, kinds }); }
    return send(name, data, kinds);
  };
  app.meld.on('status', () => order.push('late-raw'));
  app.meld.setStatus({ error: 'broadcast probe' });
  assert.deepEqual(order, ['timers', 'broadcast', 'late-raw']);
  assert.equal(sent.length, 1);
  assert.strictEqual(sent[0].data.meld, app.meld.status);
  assert.deepEqual(sent[0].kinds, ['panel']);
  order.length = 0; sent.length = 0;
  app.program.emit('status', app.program.status);
  assert.deepEqual(order, ['timers', 'broadcast']);
  assert.equal(sent.length, 1);
  assert.strictEqual(sent[0].data.meld, app.meld.status);
  assert.deepEqual(sent[0].kinds, ['panel']);
  // The unchanged non-Meld sources still each publish exactly once.
  for (const name of ['twitch', 'youtube', 'chat']) {
    order.length = 0; sent.length = 0;
    app[name].emit('status', app[name].status);
    assert.deepEqual(order, ['broadcast'], name);
    assert.equal(sent.length, 1, name);
    assert.strictEqual(sent[0].data[name], app[name].status, name);
    assert.deepEqual(sent[0].kinds, ['panel'], name);
  }
});

test('automatic session reacts to program status after broadcast and before later raw status', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-auto-status-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  const order = [], send = app.bus.send.bind(app.bus);
  const start = app.session.startNew.bind(app.session), end = app.session.endCurrent.bind(app.session);
  app.bus.send = (name, ...args) => { if (name === 'status') order.push('broadcast'); return send(name, ...args); };
  app.session.startNew = (...args) => { order.push('start'); return start(...args); };
  app.session.endCurrent = (...args) => { order.push('end'); return end(...args); };
  app.meld.on('status', () => order.push('later-raw'));
  app.meld.status = { ...app.meld.status, state: 'conectado', streaming: true, streamingKnown: true };
  app.program.emit('status', app.program.status);
  assert.deepEqual(order, ['broadcast', 'start']);
  await app.session.transitionChain;
  assert.equal(app.session.data.meldAutoSession, true);
  order.length = 0;
  app.meld.setStatus({ streaming: false });
  assert.deepEqual(order, ['broadcast', 'end', 'later-raw']);
  await app.session.transitionChain;
  assert.ok(app.session.data.endedAt);
  order.length = 0;
  app.meld.setStatus({ streaming: true });
  assert.deepEqual(order, ['broadcast', 'start', 'later-raw']);
  await app.session.transitionChain;
  assert.equal(app.session.data.meldAutoSession, true);
  assert.equal(app.session.data.endedAt, undefined);
});

test('automatic session reacts to program streaming before later raw streaming listeners', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-auto-stream-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  const order = [], start = app.session.startNew.bind(app.session), end = app.session.endCurrent.bind(app.session);
  app.session.startNew = (...args) => { order.push('start'); return start(...args); };
  app.session.endCurrent = (...args) => { order.push('end'); return end(...args); };
  app.meld.on('streaming', () => order.push('later-raw'));
  app.program.emit('streaming', true);
  assert.deepEqual(order, ['start']);
  await app.session.transitionChain;
  assert.equal(app.session.data.meldAutoSession, true);
  order.length = 0;
  app.meld.emit('streaming', false);
  assert.deepEqual(order, ['end', 'later-raw']);
  await app.session.transitionChain;
  assert.ok(app.session.data.endedAt);
  order.length = 0;
  app.meld.emit('streaming', true);
  assert.deepEqual(order, ['start', 'later-raw']);
  await app.session.transitionChain;
  assert.equal(app.session.data.meldAutoSession, true);
  assert.equal(app.session.data.endedAt, undefined);
});

test('panel session broadcast preserves payload before later raw listeners', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-session-broadcast-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  const order = [], sent = [], send = app.bus.send.bind(app.bus);
  app.bus.send = (name, data, kinds) => {
    if (name === 'meld') { order.push('broadcast'); sent.push({ data, kinds }); }
    return send(name, data, kinds);
  };
  const session = { scenes: [{ id: 'probe', layers: [] }], tracks: [], streaming: true, recording: false };
  app.meld.on('session', data => { order.push('late-raw'); assert.strictEqual(data, session); });
  app.meld.emit('session', session);
  assert.deepEqual(order, ['broadcast', 'late-raw']);
  assert.equal(sent.length, 1);
  assert.strictEqual(sent[0].data, session);
  assert.deepEqual(sent[0].kinds, ['panel']);
  order.length = 0; sent.length = 0;
  app.program.emit('session', session);
  assert.deepEqual(order, ['broadcast']);
  assert.equal(sent.length, 1);
  assert.strictEqual(sent[0].data, session);
  assert.deepEqual(sent[0].kinds, ['panel']);
});

async function youtubeWiring(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-youtube-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  const order = [], begin = YouTubeAutoConnect.prototype.begin, end = YouTubeAutoConnect.prototype.end;
  YouTubeAutoConnect.prototype.begin = function () { order.push('youtube-begin'); };
  YouTubeAutoConnect.prototype.end = function () { order.push('youtube-end'); return Promise.resolve(); };
  for (const [method, label] of [['startNew', 'session-start'], ['endCurrent', 'session-end'], ['captureIdentity', 'identity-check']]) {
    const original = app.session[method].bind(app.session);
    app.session[method] = (...args) => { order.push(label); return original(...args); };
  }
  t.after(async () => {
    YouTubeAutoConnect.prototype.begin = begin; YouTubeAutoConnect.prototype.end = end;
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(dir, { recursive: true, force: true });
  });
  return { app, order };
}

test('YouTube auto reacts to program streaming after auto-session and before later raw listeners', async t => {
  const { app, order } = await youtubeWiring(t);
  app.meld.on('streaming', () => order.push('later-raw'));
  for (const [emitter, live, expected] of [
    [app.program, true, ['session-start', 'youtube-begin']],
    [app.program, false, ['session-end', 'youtube-end']],
    [app.meld, true, ['session-start', 'youtube-begin', 'later-raw']],
    [app.meld, false, ['session-end', 'youtube-end', 'later-raw']],
  ]) {
    order.length = 0; emitter.emit('streaming', live);
    assert.deepEqual(order, expected);
    await app.session.transitionChain;
  }
});

test('YouTube auto reacts to live program status after auto-session and before forwarded recording', async t => {
  const { app, order } = await youtubeWiring(t);
  const send = app.bus.send.bind(app.bus);
  app.bus.send = (name, ...args) => { if (name === 'status') order.push('broadcast'); return send(name, ...args); };
  // This existing assertion tracks recording on forwarded raw statuses; the
  // program-only recording reaction is asserted separately below.
  let forwarded = false;
  observeStatusConsumers(app, label => { if (forwarded && label === 'recording-status') order.push('recording'); });
  app.meld.on('status', () => order.push('later-raw'));
  app.meld.status = { ...app.meld.status, state: 'conectado', streaming: true, streamingKnown: true };
  app.program.emit('status', app.program.status);
  assert.deepEqual(order, ['broadcast', 'session-start', 'youtube-begin']);
  await app.session.transitionChain;
  app.store.config.program.autoSession = false;
  for (const status of [{ state: 'desconectado', streaming: true }, { state: 'reintentando', streaming: true },
    { state: 'conectado', streaming: false }]) {
    order.length = 0; app.program.emit('status', status);
    assert.deepEqual(order, ['broadcast']);
  }
  app.store.config.program.autoSession = true; forwarded = true;
  app.meld.setStatus({ state: 'reintentando' }); order.length = 0;
  app.meld.setStatus({ state: 'conectado', streaming: true });
  assert.deepEqual(order, ['broadcast', 'identity-check', 'youtube-begin', 'recording', 'later-raw']);
});

async function routeWiring(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-routes-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose(); await app.closeHttp(); await rm(dir, { recursive: true, force: true }); });
  app.store.config.program.autoSession = false;
  app.meld.status = { ...app.meld.status, state: 'conectado', streaming: false, streamingKnown: true, recording: false, recordingKnown: true };
  const calls = [];
  app.meld.command = command => { calls.push(command); app.meld.emit('controlCommand', command); return Promise.resolve(); };
  const post = async (url, body) => {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const report = streaming => { app.meld.status = { ...app.meld.status, streaming }; app.program.emit('status', app.meld.status); };
  return { app, calls, post, report };
}

test('recording and guard react to program status after YouTube', async t => {
  const { app, calls, post, report } = await routeWiring(t), order = [];
  app.store.config.program.recordOnStart = true;
  const begin = YouTubeAutoConnect.prototype.begin;
  YouTubeAutoConnect.prototype.begin = () => order.push('youtube');
  t.after(() => { YouTubeAutoConnect.prototype.begin = begin; });
  observeStatusConsumers(app, label => { if (['recording-status', 'route-guard-status'].includes(label)) order.push(label); });
  assert.deepEqual(await post('/api/meld/stream', { action: 'start' }), { status: 200, body: { requested: 'start', streaming: false } });
  report(true);
  assert.deepEqual(order, ['youtube', 'recording-status', 'route-guard-status']);
  assert.deepEqual(calls, ['meld.startStreamingAction', 'meld.startRecordingAction']);
});

test('program controlCommand revokes an owned recording', async t => {
  const { app, calls, post } = await routeWiring(t);
  app.store.config.program.recordOnStart = true;
  assert.equal((await post('/api/meld/stream', { action: 'start' })).status, 200);
  app.meld.setStatus({ streaming: true }); app.meld.setStatus({ recording: true });
  await new Promise(resolve => setImmediate(resolve)); // recording acknowledgement plus confirmation
  app.program.emit('controlCommand', 'meld.toggleRecordingAction');
  assert.equal((await post('/api/meld/stream', { action: 'stop' })).status, 200);
  app.meld.setStatus({ streaming: false });
  assert.deepEqual(calls, ['meld.startStreamingAction', 'meld.startRecordingAction', 'meld.stopStreamingAction']);
});

test('program confirmations clear both pending route guards', async t => {
  const { post, report } = await routeWiring(t);
  const stream = action => post('/api/meld/stream', { action });
  const pending = { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación del programa de emisión.' } };
  assert.deepEqual(await stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  assert.deepEqual(await stream('start'), pending); report(true);
  assert.deepEqual(await stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
  assert.deepEqual(await stream('stop'), pending); report(false);
  assert.deepEqual(await stream('start'), { status: 200, body: { requested: 'start', streaming: false } });
  report(true);
  assert.deepEqual(await stream('stop'), { status: 200, body: { requested: 'stop', streaming: true } });
});

test('HTTP Meld routes invoke program actions including connect and disconnect', async t => {
  const { app, post } = await routeWiring(t), calls = [];
  app.program.showScene = async scene => { calls.push(['scene', scene]); return { name: 'program scene' }; };
  assert.deepEqual(await post('/api/meld/scene', { scene: 'requested' }), { status: 200, body: { scene: 'program scene' } });
  app.program.stop = () => calls.push('stop'); app.program.start = url => calls.push(['start', url]);
  const status = app.meld.status, url = 'ws://127.0.0.1:1';
  assert.strictEqual(app.program.status, status);
  assert.deepEqual(await post('/api/meld/connect', { url }), { status: 200, body: status });
  assert.deepEqual(await post('/api/meld/disconnect', {}), { status: 200, body: status });
  assert.deepEqual(calls, [['scene', 'requested'], 'stop', ['start', url], 'stop']);
});

test("only adapter forwarders remain on raw Meld status and controlCommand", async t => {
  const { app } = await routeWiring(t);
  assert.equal(app.meld.listenerCount("status"), 1);
  assert.equal(app.meld.listenerCount("controlCommand"), 1);
});

test('an alert action reaches the program rather than bypassing it', async t => {
  const { app, calls: rawCalls, post } = await routeWiring(t), programCalls = [];
  app.program.command = command => { programCalls.push(command); return Promise.resolve(); };
  const response = await post('/api/alert/custom', { title: 'Wiring', actions: [{ kind: 'command', command: 'meld.recordClip' }] });
  assert.equal(response.status, 200);
  assert.ok(response.body.alert?.id);
  await app.engine.drainActions();
  assert.deepEqual(programCalls, ['meld.recordClip']);
  assert.deepEqual(rawCalls, []);
});

test('the engine retains the program as its action provider', async t => {
  const { app } = await routeWiring(t);
  assert.strictEqual(app.engine.meld, app.program);
});

test('interactive retains the program as its confetti provider', async t => {
  const { app } = await routeWiring(t);
  assert.strictEqual(app.interactive.meld, app.program);
});

test('giveaway confetti reaches the program only while connected', async t => {
  const { app, post } = await routeWiring(t), programCalls = [], rawCalls = [];
  app.program.streamEvent = async (...args) => { programCalls.push(args); };
  app.meld.streamEvent = async (...args) => { rawCalls.push(args); };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const config = await fetch(`${base}/api/interactive/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ giveaway: { announceInChat: false, meldConfetti: true, rollSeconds: 1 } }),
  });
  assert.equal(config.status, 200);
  const draw = async () => {
    assert.equal((await post('/api/giveaway/open', {})).status, 200);
    assert.deepEqual(await post('/api/giveaway/join', { user: 'Probe' }), { status: 200, body: { added: true } });
    assert.deepEqual(await post('/api/giveaway/draw', {}), { status: 200, body: { winner: 'Probe', entries: 1, pool: 1 } });
    await app.interactive.drainDraws();
  };
  try {
    assert.equal(app.program.connected, true);
    await draw();
    assert.deepEqual(programCalls, [['CONFETTIPOP_TRIGGER']]);
    assert.deepEqual(rawCalls, []);
    app.meld.setStatus({ state: 'desconectado' });
    assert.equal(app.program.connected, false);
    await draw();
    assert.deepEqual(programCalls, [['CONFETTIPOP_TRIGGER']]);
    assert.deepEqual(rawCalls, []);
  } finally {
    try { await app.interactive.drainDraws(); } finally { await app.interactive.flush(); }
  }
});

test('status snapshots use the program status', async t => {
  const { app } = await routeWiring(t);
  const status = { ...app.meld.status, error: 'program status' };
  Object.defineProperty(app.program, 'status', { get: () => status });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.deepEqual((await (await fetch(base + '/api/status')).json()).meld, status);
  assert.deepEqual((await (await fetch(base + '/api/state')).json()).status.meld, status);
});

test('state snapshot uses the program session', async t => {
  const { app } = await routeWiring(t);
  const session = { scenes: [{ id: 'program', layers: [] }], tracks: [], streaming: false, recording: false };
  app.program.session = () => session;
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).meld.session, session);
});

test('manual end checks live program status without changing the session on rejection', async t => {
  const { app, post } = await routeWiring(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const before = await (await fetch(base + '/api/session')).json();
  const persistence = (await (await fetch(base + '/api/status')).json()).persistence;
  Object.defineProperty(app.program, 'status', { get: () => ({ ...app.meld.status, streaming: true }) });
  assert.deepEqual(await post('/api/session/end', { id: before.id }),
    { status: 409, body: { error: 'No se puede terminar el directo mientras el programa de emisión está emitiendo.' } });
  assert.deepEqual(await (await fetch(base + '/api/session')).json(), before);
  assert.deepEqual((await (await fetch(base + '/api/status')).json()).persistence, persistence);
});

test('configuration changes restart the program, except recordOnStart alone', async t => {
  const { app, post } = await routeWiring(t), calls = [];
  app.program.stop = () => calls.push('stop');
  app.program.start = url => calls.push(['start', url]);
  const url = 'ws://127.0.0.1:12345';
  assert.equal((await post('/api/config/set', { path: 'meld.url', value: url })).status, 200);
  assert.deepEqual(calls.splice(0), ['stop']);
  assert.equal((await post('/api/config/set', { path: 'meld.enabled', value: true })).status, 200);
  assert.deepEqual(calls.splice(0), ['stop', ['start', url]]);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meld: { recordOnStart: true } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, []);
  assert.equal((await post('/api/config/set', { path: 'meld.enabled', value: false })).status, 200);
  assert.deepEqual(calls, ['stop']);
});

test('a timed layer hide is dispatched through the program at expiry', async t => {
  const { app, post } = await routeWiring(t), calls = [];
  app.program.setLayer = async (...args) => {
    calls.push(args);
    return { scene: { id: 'scene-1', name: 'Escena' }, layer: { id: 'layer-1', name: 'Capa' } };
  };
  assert.deepEqual(await post('/api/meld/layer', { scene: 'Escena', layer: 'Capa', visible: true, seconds: 0.01 }),
    { status: 200, body: { scene: 'Escena', layer: 'Capa' } });
  await app.drainLayerHides();
  assert.deepEqual(calls, [['Escena', 'Capa', true], ['scene-1', 'layer-1', false]]);
});

test('startup and terminal shutdown use the program and retain close-before-dispose order', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import { Store } from './src/store.mjs';
    import { Meld } from './src/meld.mjs';
    import { MeldAdapter } from './src/programs/meld-adapter.mjs';
    import { startServer } from './src/server.mjs';
    const store = await new Store().load();
    await store.patchConfig({ meld: { enabled: true, url: 'ws://127.0.0.1:12345' } });
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (_port, host, cb) { return listen.call(this, 0, host, cb); };
    const events = [], close = MeldAdapter.prototype.quiesceClose, dispose = MeldAdapter.prototype.dispose;
    Meld.prototype.start = () => events.push('raw-start');
    MeldAdapter.prototype.start = url => events.push(['program-start', url]);
    MeldAdapter.prototype.quiesceClose = function () { events.push('program-close'); return close.call(this); };
    MeldAdapter.prototype.dispose = function () { events.push('dispose'); return dispose.call(this); };
    const app = await startServer({ quiet: true, handleSignals: false, log: () => {} });
    app.program.on('status', status => events.push(['status', status.state]));
    assert.equal(await app.close(), 0);
    assert.deepEqual(events, [['program-start', 'ws://127.0.0.1:12345'], 'program-close', ['status', 'desconectado'], 'dispose']);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20000,
    env: { PATH: process.env.PATH || '', ANTENA_DATA: path.join(dir, 'data'), ANTENA_MEDIA: path.join(dir, 'media') },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

test('legacy Interactive constructor still accepts a duck-typed Meld provider', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = structuredClone(DEFAULT_INTERACTIVE_CONFIG), calls = [];
  Object.assign(config.giveaway, { announceInChat: false, rollSeconds: 1 });
  const meld = { connected: true, streamEvent: async (...args) => { calls.push(args); } };
  const interactive = new Interactive({ store: { dir: '.', config: { interactive: config } }, twitch: {}, meld, writer: async () => {}, log: () => {} });
  await interactive.openGiveaway();
  assert.equal(interactive.join({ user: 'Probe' }), true);
  assert.deepEqual(await interactive.draw(), { winner: 'Probe', entries: 1, pool: 1 });
  const done = interactive.drainDraws();
  t.mock.timers.tick(1000); await done;
  assert.deepEqual(calls, [['CONFETTIPOP_TRIGGER']]);
  assert.equal(interactive.giveawayState().history[0].winner, 'Probe');
});
