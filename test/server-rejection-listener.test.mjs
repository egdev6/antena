// Ownership of the process listener only: exercise real startServer/close in private children.
// Never emit unhandledRejection in the node:test worker, or replace process.exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SERVER_URL = new URL('../src/server.mjs', import.meta.url).href;
const STORE_URL = new URL('../src/store.mjs', import.meta.url).href;

const CHILD = `
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

// Install guards BEFORE production imports: no credentials, provider sockets or external fetch.
let unexpectedNetwork = 0;
globalThis.fetch = () => {
  unexpectedNetwork++;
  throw new Error('unexpected fixture fetch');
};
globalThis.WebSocket = class {
  constructor() {
    unexpectedNetwork++;
    throw new Error('unexpected fixture WebSocket');
  }
};

// Bind real HTTP sockets atomically to independent loopback ports; no reserve/release race.
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  assert.equal(host, '127.0.0.1');
  return realListen.call(this, 0, host, callback);
};
const { startServer } = await import(${JSON.stringify(SERVER_URL)});
const { Store } = await import(${JSON.stringify(STORE_URL)});

// DATA is captured at module import, not per startServer call. Redirect only the fixture's
// next Store before its REAL load so concurrent apps never share config/session files.
// No storage adapter, production API, persistence algorithm or shutdown is replaced.
const realLoad = Store.prototype.load;
let nextData;
Store.prototype.load = function (...args) {
  assert.ok(nextData, 'fixture must select a private Store before starting');
  this.dir = nextData;
  this.cfgFile = path.join(nextData, 'config.json');
  this.secFile = path.join(nextData, 'secrets.json');
  return realLoad.apply(this, args);
};

const event = 'unhandledRejection';
const listeners = () => process.listeners(event);
const inherited = listeners();
const signals = ['SIGINT', 'SIGTERM'].map(name => process.listeners(name));
const foreignBefore = () => {};
const foreignAfter = () => {};
process.on(event, foreignBefore);
const baseline = listeners();
const logs = [];
const apps = [];

async function start(name) {
  nextData = path.join(process.env.FIXTURE_ROOT, name, 'data');
  const media = path.join(process.env.FIXTURE_ROOT, name, 'media');
  await mkdir(nextData, { recursive: true, mode: 0o700 });
  await mkdir(media, { recursive: true, mode: 0o700 });
  process.env.ANTENA_MEDIA = media;
  const before = listeners();
  const app = await startServer({
    quiet: true,
    handleSignals: false,
    shutdownTimeoutMs: 2000,
    log: (...args) => logs.push(args),
  });
  const added = listeners().filter(fn => !before.includes(fn));
  assert.equal(added.length, 1, 'startServer registers exactly one owned listener');
  assert.deepEqual(listeners(), [...before, added[0]]);
  assert.equal(app.store.dir, nextData);
  assert.equal(app.mediaDir, media);
  assert.equal(app.server.address().address, '127.0.0.1');
  apps.push(app);
  return { app, own: added[0] };
}

function assertNoSignalChanges() {
  for (const [i, name] of ['SIGINT', 'SIGTERM'].entries()) {
    assert.deepEqual(process.listeners(name), signals[i], 'handleSignals:false preserves ' + name);
  }
}
function assertRemoved(own, expected) {
  assert.equal(listeners().includes(own), false, 'closed app listener must be absent');
  assert.deepEqual(listeners(), expected, 'preserve every foreign listener by reference and order');
}
function addLateForeign() {
  process.on(event, foreignAfter);
}
function checkCloseIdentity(app) {
  const closing = app.close();
  assert.equal(app.close(), closing, 'in-flight close returns the same promise');
  return closing;
}
async function assertClosed(app, closing, code) {
  assert.equal(await closing, code);
  assert.equal(app.close(), closing, 'completed close returns the cached promise');
  assert.equal(await app.close(), code);
  assert.equal(app.server.listening, false);
}

const mode = process.argv[1];
if (mode === 'success' || mode === 'failure') {
  const { app, own } = await start('a');
  addLateForeign();
  let flushes = 0;
  const flush = app.session.flush.bind(app.session);
  app.session.flush = async () => {
    flushes++;
    if (mode === 'failure') throw new Error('synthetic flush failure');
    return flush();
  };
  const closing = checkCloseIdentity(app);
  await assertClosed(app, closing, mode === 'failure' ? 1 : 0);
  assert.equal(flushes, 1, 'repeated close must not repeat flush');
  assertRemoved(own, [...baseline, foreignAfter]);
} else if (mode === 'gated') {
  const { app, own } = await start('a');
  addLateForeign();
  let entered, release;
  const atFlush = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const flush = app.session.flush.bind(app.session);
  app.session.flush = async () => {
    entered();
    await gate;
    return flush();
  };
  const closing = checkCloseIdentity(app);
  let settled = false;
  closing.then(() => { settled = true; });
  try {
    await atFlush;
    assert.equal(settled, false, 'close is still draining the gated flush');
    assert.deepEqual(listeners(), [...baseline, own, foreignAfter]);
    assert.equal(listeners().includes(own), true, 'do not remove the listener at beginClose');
    assert.equal(app.server.listening, true, 'HTTP remains live until persistence finishes');
    assert.equal(app.close(), closing);
  } finally {
    release(); // Successful gate fixture always releases, no sleep until the deadline.
  }
  await assertClosed(app, closing, 0);
  assertRemoved(own, [...baseline, foreignAfter]);
} else if (mode === 'independent') {
  const a = await start('a');
  const b = await start('b');
  addLateForeign();
  assert.notEqual(a.own, b.own);
  assert.notEqual(a.app.store.dir, b.app.store.dir);
  assert.notEqual(a.app.mediaDir, b.app.mediaDir);
  assert.notEqual(a.app.server.address().port, b.app.server.address().port);
  const closingA = checkCloseIdentity(a.app);
  await assertClosed(a.app, closingA, 0);
  assertRemoved(a.own, [...baseline, b.own, foreignAfter]);
  assert.equal(b.app.server.listening, true, 'closing A must not close B');
  assert.equal(a.app.close(), closingA);
  assert.deepEqual(listeners(), [...baseline, b.own, foreignAfter]);
  const closingB = checkCloseIdentity(b.app);
  await assertClosed(b.app, closingB, 0);
  assertRemoved(b.own, [...baseline, foreignAfter]);
} else if (mode === 'repeat') {
  addLateForeign();
  for (let i = 0; i < 3; i++) {
    const { app, own } = await start('round-' + i);
    const closing = checkCloseIdentity(app);
    await assertClosed(app, closing, 0);
    assertRemoved(own, [...baseline, foreignAfter]);
    assertNoSignalChanges();
  }
} else if (mode === 'logging') {
  const { app, own } = await start('a');
  const error = new Error('synthetic message');
  const fallback = { synthetic: true };
  const offset = logs.length;
  // Deliberate event emission belongs ONLY to this isolated child, never node:test itself.
  process.emit(event, error, Promise.resolve());
  process.emit(event, fallback, Promise.resolve());
  assert.deepEqual(logs.slice(offset), [['[error]', 'synthetic message'], ['[error]', fallback]]);
  addLateForeign();
  await assertClosed(app, checkCloseIdentity(app), 0);
  assertRemoved(own, [...baseline, foreignAfter]);
  const count = logs.length;
  process.emit(event, new Error('after close'), Promise.resolve());
  assert.equal(logs.length, count, 'closed app must no longer log process rejections');
} else {
  assert.fail('unknown fixture mode');
}
assertNoSignalChanges();
assert.equal(unexpectedNetwork, 0, 'no external fixture networking');
assert.ok(apps.every(app => !app.server.listening));
// Remove only the harness-owned foreign listeners; never clean up a leaked production listener.
process.removeListener(event, foreignBefore);
process.removeListener(event, foreignAfter);
assert.deepEqual(listeners(), inherited);
Store.prototype.load = realLoad;
net.Server.prototype.listen = realListen;
console.log('LISTENER-OWNERSHIP:OK:' + mode);
`;

async function runChild(mode) {
  // Retain synthetic files for inspection, confined to the explicitly allowed scratch prefix.
  const root = await mkdtemp(path.join(tmpdir(), 'rj26-'));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  await mkdir(home, { mode: 0o700 });
  await mkdir(temp, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    CHROME_PATH: '/usr/bin/google-chrome',
    FIXTURE_ROOT: root,
    ANTENA_DATA: path.join(root, 'initial-data'),
    ANTENA_MEDIA: path.join(root, 'initial-media'),
    PORT: '0',
  };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, mode], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 6000,
      killSignal: 'SIGKILL',
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const evidence = JSON.stringify({ mode, root, ...result });
  assert.equal(result.signal, null, evidence);
  assert.equal(result.code, 0, evidence);
  assert.equal(result.stderr, '', evidence);
  assert.equal(result.stdout.trim(), 'LISTENER-OWNERSHIP:OK:' + mode, evidence);
}

test('close removes only its owned rejection listener on result 0', { timeout: 10000 }, async () => {
  await runChild('success');
});

test('failed flush removes only its owned rejection listener on result 1', { timeout: 10000 }, async () => {
  await runChild('failure');
});

test('gated flush keeps the owned rejection listener until close resolves', { timeout: 10000 }, async () => {
  await runChild('gated');
});

test('two concurrent servers own independent rejection listeners and storage', { timeout: 10000 }, async () => {
  await runChild('independent');
});

test('repeated close and handleSignals false preserve listener counts', { timeout: 10000 }, async () => {
  await runChild('repeat');
});

test('owned rejection listener keeps its existing log argument format', { timeout: 10000 }, async () => {
  await runChild('logging');
});
