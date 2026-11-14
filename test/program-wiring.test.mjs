import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Meld, MELD_COMMANDS as rawCommands, MELD_STREAM_EVENTS as rawEvents } from '../src/meld.mjs';
import { MeldAdapter } from '../src/programs/meld-adapter.mjs';
import { createProgram, MELD_COMMANDS, MELD_STREAM_EVENTS } from '../src/programs/index.mjs';
import { createApp, startServer } from '../src/server.mjs';

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
  app.program.on('status', () => order.push('program'));
  app.meld.on('status', () => order.push('raw'));
  app.meld.setStatus({ error: 'observable' });
  assert.deepEqual(order, ['program', 'broadcast', 'raw']);
  assert.strictEqual(app.program.status, app.meld.status);
  assert.equal(app.meld.status.error, 'observable');
});

test('shutdown forwards Meld terminal status before disposing its adapter', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-program-shutdown-'));
  const old = { data: process.env.ANTENA_DATA, media: process.env.ANTENA_MEDIA };
  const originalListen = net.Server.prototype.listen;
  process.env.ANTENA_DATA = path.join(dir, 'data'); process.env.ANTENA_MEDIA = path.join(dir, 'media');
  net.Server.prototype.listen = function (_port, host, callback) { return originalListen.call(this, 0, host, callback); };
  t.after(async () => {
    net.Server.prototype.listen = originalListen;
    if (old.data === undefined) delete process.env.ANTENA_DATA; else process.env.ANTENA_DATA = old.data;
    if (old.media === undefined) delete process.env.ANTENA_MEDIA; else process.env.ANTENA_MEDIA = old.media;
    await rm(dir, { recursive: true, force: true });
  });
  const app = await startServer({ quiet: true, handleSignals: false, log: () => {} });
  net.Server.prototype.listen = originalListen;
  const events = [], close = app.meld.quiesceClose.bind(app.meld), dispose = app.program.dispose.bind(app.program);
  const counts = names.map(name => app.meld.listenerCount(name));
  app.program.on('status', status => events.push(status.state));
  app.meld.quiesceClose = () => { events.push('close'); return close().then(() => { events.push('closed'); }); };
  app.program.dispose = () => { events.push('dispose'); return dispose(); };
  assert.equal(await app.close(), 0);
  assert.deepEqual(events, ['close', 'desconectado', 'closed', 'dispose']);
  assert.deepEqual(names.map(name => app.meld.listenerCount(name)), counts.map(n => n - 1));
  app.meld.setStatus({ error: 'after shutdown' });
  assert.deepEqual(events, ['close', 'desconectado', 'closed', 'dispose']);
});
