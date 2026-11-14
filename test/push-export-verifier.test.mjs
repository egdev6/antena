// Regressions from the independent #136 verification. All sessions and tokens are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createPushExport } from '../src/push-export.mjs';
import { createApp } from '../src/server.mjs';

const TOKEN = 'SYNTHETIC-TOKEN-1Q9';
const initial = (id = 'synthetic-136') => ({ id, title: '', startedAt: '2026-01-01T00:00:00.000Z',
  events: [], notes: [], goalOffsets: {}, meldAutoSession: true, platforms: { twitch: { streamId: 'synthetic-stream' } } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) break;
    await sleep(5);
  }
  assert.fail(`timeout: ${label}`);
}
async function fake(t, handler = (_req, res) => res.end('{"result":"stored"}')) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ body, auth: req.headers.authorization });
    handler(req, res, requests.length);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { requests, url: `http://127.0.0.1:${server.address().port}/ingest` };
}
async function fixture(t, receiver, { push = { url: receiver.url, token: TOKEN }, current = initial() } = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-regression-'));
  const data = path.join(root, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'session-current.json'), JSON.stringify(current));
  const logs = [];
  let app;
  async function start() {
    app = await createApp({ dataDir: data, mediaDir: path.join(root, 'media'), push,
      log: (...args) => logs.push(args.join(' ')), pushTimeoutMs: 3000 });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  t.after(async () => {
    if (app) {
      app.viewers.halt();
      await app.session.flush().catch(() => {});
      await app.closeHttp().catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await start();
  return {
    data, logs, get app() { return app; },
    async restart(nextPush = push) { await app.closeHttp(); push = nextPush; await start(); },
    async request(method, url, body = {}) {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}${url}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(method === 'POST' || method === 'PUT' ? { body: JSON.stringify(body) } : {}),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    },
  };
}
const pushStatus = async f => (await f.request('GET', '/api/status')).body.push;

test('finding 1: pathless explicit loopback receivers are accepted', () => {
  const errors = ['http://127.0.0.1:1234', 'http://[::1]:1234'].map(url => {
    try { createPushExport({ config: { url, token: TOKEN } }); return null; }
    catch (error) { return error.message; }
  });
  assert.deepEqual(errors, [null, null]);
});

test('PRESERVE: invalid loopback aliases and URL components do not change stored data', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-urls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); await fs.mkdir(data);
  const file = path.join(data, 'session-current.json'); await fs.writeFile(file, JSON.stringify(initial()));
  const hash = async () => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const before = await hash();
  for (const url of ['http://127.1:1234/x', 'http://2130706433:1234/x', 'http://0x7f.0.0.1:1234/x',
    'http://localhost:1234/x', 'http://x:y@127.0.0.1:1234/x', 'http://127.0.0.1:1234/x?',
    'http://127.0.0.1:1234/x#', 'https://127.0.0.1:1234/x', 'http://127.0.0.1/x']) {
    await assert.rejects(createApp({ dataDir: data, mediaDir: path.join(root, 'media'), push: { url, token: TOKEN }, log: () => {} }),
      error => error.message === 'La URL del receptor no es válida.' && !error.message.includes(url) && !error.message.includes(TOKEN));
    assert.equal(await hash(), before);
  }
});

test('finding 2: forged queued v1 documents are permanently dropped without being sent', async t => {
  for (const [name, mutate] of [
    ['extra top-level field', doc => { doc.injected = 'UNTRUSTED-EXTRA'; }],
    ['extra nested field', doc => { doc.metrics[0].coverage.injected = 'UNTRUSTED-NESTED'; }],
  ]) await t.test(name, async t => {
    const r = await fake(t), f = await fixture(t, r, { push: {} });
    assert.equal((await f.request('POST', '/api/session/end')).status, 200);
    const detail = await f.request('GET', '/api/metrics/v1/sessions/synthetic-136');
    assert.equal(detail.status, 200);
    await f.app.closeHttp();
    const forged = structuredClone(detail.body); mutate(forged);
    const receiver = createHash('sha256').update(new URL(r.url).href).digest('hex');
    await fs.writeFile(path.join(f.data, 'push-export.json'), JSON.stringify({ version: 1, receiver,
      entries: [{ body: JSON.stringify(forged), attempts: 0, nextAt: 0 }] }));
    await f.restart({ url: r.url, token: TOKEN });
    const status = await until(async () => {
      assert.deepEqual(r.requests, [], 'invalid document must never be sent');
      const s = await pushStatus(f); return s.lastError && s.pending === 0 && s;
    }, 'invalid queue dropped');
    assert.ok(!JSON.stringify(status).includes(TOKEN));
    assert.ok(!JSON.stringify(status).includes('UNTRUSTED'));
    assert.equal((await f.request('GET', '/api/metrics/v1/sessions/synthetic-136')).status, 200);
    await f.restart(); await sleep(100);
    assert.deepEqual(r.requests, [], 'invalid item must not be regenerated after restart');
  });
});

test('finding 3: permanent 400 is not retried after a dequeue write fails and another item arrives', async t => {
  const r = await fake(t, (_req, res) => { res.writeHead(400); res.end('untrusted content'); });
  const root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-dequeue-'));
  const p = createPushExport({ config: { url: r.url, token: TOKEN } });
  const open = fs.open;
  t.after(async () => { fs.open = open; await p.close(); await fs.rm(root, { recursive: true, force: true }); });
  await p.load(root);
  let queueOpens = 0;
  fs.open = async function (file, ...args) {
    if (String(file).includes('.push-export.json.') && ++queueOpens === 3) throw new Error('synthetic disk fault');
    return open.call(this, file, ...args);
  };
  const ended = id => ({ ...initial(id), endedAt: '2026-01-01T00:05:00.000Z' });
  p.enqueue(ended('a'));
  await until(() => p.status().lastError === 'No se pudo guardar o leer la cola de envío.', 'dequeue write fault');
  fs.open = open;
  p.enqueue(ended('b'));
  await until(() => r.requests.some(request => JSON.parse(request.body).session.id === 'b'), 'second session sent');
  await until(() => p.status().pending === 0, 'permanent responses durably removed');
  await sleep(50);
  assert.deepEqual(r.requests.map(request => JSON.parse(request.body).session.id), ['a', 'b']);
  assert.ok(!JSON.stringify(p.status()).includes(TOKEN));
});

test('finding 4: recovered archive persistence delivers the finished cutover', async t => {
  const r = await fake(t), f = await fixture(t, r), original = f.app.session.writer;
  let fault = true;
  f.app.session.writer = (file, data, opts) => fault && path.basename(file) === 'synthetic-136.json'
    ? Promise.reject(new Error('synthetic archive failure')) : original(file, data, opts);
  assert.equal((await f.request('POST', '/api/session/new')).status, 500);
  fault = false;
  await f.app.session.flush();
  assert.equal((await f.request('GET', '/api/metrics/v1/sessions/synthetic-136')).status, 200);
  await until(() => r.requests.length === 1, 'recovered archived session delivered');
  assert.equal(JSON.parse(r.requests[0].body).session.id, 'synthetic-136');
});

test('finding 5: a delivered session is not regenerated after restart and cutover', async t => {
  const r = await fake(t), f = await fixture(t, r);
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  await until(async () => r.requests.length === 1 && (await pushStatus(f)).lastSuccess, 'first delivery');
  await f.restart();
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  await sleep(250);
  assert.equal(r.requests.length, 1);
  assert.equal(JSON.parse(r.requests[0].body).session.id, 'synthetic-136');
  const names = (await fs.readdir(f.data)).filter(name => name.startsWith('push-export') && name.endsWith('.json'));
  for (const name of names) assert.ok(!(await fs.readFile(path.join(f.data, name), 'utf8')).includes(TOKEN));
});

test('finding 6: successful end retry queues a checkpoint recovered in the background', async t => {
  const r = await fake(t), f = await fixture(t, r), original = f.app.session.writer;
  let fault = true;
  f.app.session.writer = (file, data, opts) => fault && data.endedAt
    ? Promise.reject(new Error('synthetic checkpoint failure')) : original(file, data, opts);
  assert.equal((await f.request('POST', '/api/session/end')).status, 500);
  assert.ok(f.app.session.lastSaveError);
  fault = false;
  assert.equal((await f.request('PUT', '/api/session', { title: 'synthetic title update' })).status, 200);
  await until(() => !f.app.session.lastSaveError, 'background checkpoint recovered');
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  await until(() => r.requests.length === 1, 'successful end retry delivered');
  assert.equal(JSON.parse(r.requests[0].body).session.id, 'synthetic-136');
});

test('finding 7: acknowledged end survives SIGKILL before the queue write', async t => {
  const r = await fake(t);
  const root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-crash-'));
  const data = path.join(root, 'data'); await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'session-current.json'), JSON.stringify(initial()));
  let child, app;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (app) { app.viewers.halt(); await app.closeHttp().catch(() => {}); }
    await fs.rm(root, { recursive: true, force: true });
  });
  const moduleUrl = new URL('../src/server.mjs', import.meta.url).href;
  const code = `
    import fs from 'node:fs/promises';
    import { createApp } from ${JSON.stringify(moduleUrl)};
    const [data, media, url, token] = process.argv.slice(1);
    const open = fs.open;
    fs.open = async function(file, ...args) {
      if (String(file).includes('.push-export.json.')) { console.log('QUEUE_BLOCKED'); await new Promise(() => {}); }
      return open.call(this, file, ...args);
    };
    const app = await createApp({ dataDir: data, mediaDir: media, push: { url, token }, log: () => {} });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/session/end', { method: 'POST', body: '{}' });
    console.log('END_STATUS=' + response.status);
  `;
  child = spawn(process.execPath, ['--input-type=module', '--eval', code, data, path.join(root, 'media'), r.url, TOKEN],
    { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await until(() => stdout.includes('QUEUE_BLOCKED') && stdout.includes('END_STATUS=200'), 'acknowledged end with queue blocked');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
  assert.equal(stderr, '');
  assert.ok(JSON.parse(await fs.readFile(path.join(data, 'session-current.json'), 'utf8')).endedAt);
  app = await createApp({ dataDir: data, mediaDir: path.join(root, 'media'), push: { url: r.url, token: TOKEN }, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  await until(() => r.requests.length === 1, 'delivery recovered after SIGKILL');
  assert.equal(JSON.parse(r.requests[0].body).session.id, 'synthetic-136');
  assert.equal(r.requests[0].auth, `Bearer ${TOKEN}`);
});

test('finding 4: a failed initial queue write is retried after storage recovers', async t => {
  const r = await fake(t), root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-write-retry-'));
  const p = createPushExport({ config: { url: r.url, token: TOKEN } });
  const open = fs.open; let fault = true;
  t.after(async () => { fs.open = open; await p.close(); await fs.rm(root, { recursive: true, force: true }); });
  await p.load(root);
  fs.open = async function (file, ...args) {
    if (fault && String(file).includes('.push-export.json.')) throw new Error('synthetic temporary write failure');
    return open.call(this, file, ...args);
  };
  p.enqueue({ ...initial('retry-write'), endedAt: '2026-01-01T00:05:00.000Z' });
  await until(() => p.status().lastError === 'No se pudo guardar o leer la cola de envío.', 'initial queue write failed');
  assert.deepEqual(r.requests, []);
  fault = false;
  await until(() => r.requests.length === 1, 'pending write recovered without another enqueue');
  await until(() => p.status().pending === 0, 'recovered item delivered durably');
});

test('finding 4: failed attempt checkpoints do not consume the network retry budget', async t => {
  const r = await fake(t), root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-attempt-write-'));
  const tasks = [];
  const timers = { setTimeout(fn, ms) { const task = { fn, ms }; tasks.push(task); return task; },
    clearTimeout(task) { task.cancelled = true; } };
  const p = createPushExport({ config: { url: r.url, token: TOKEN }, timers });
  const open = fs.open; let queueOpens = 0;
  t.after(async () => { fs.open = open; await p.close(); await fs.rm(root, { recursive: true, force: true }); });
  await p.load(root);
  fs.open = async function (file, ...args) {
    if (String(file).includes('.push-export.json.') && ++queueOpens <= 10 && queueOpens % 2 === 0)
      throw new Error('synthetic attempt checkpoint failure');
    return open.call(this, file, ...args);
  };
  p.enqueue({ ...initial('retry-attempt'), endedAt: '2026-01-01T00:05:00.000Z' });
  for (let i = 0; i < 5; i++) {
    await until(() => tasks[i], `checkpoint retry ${i + 1}`);
    assert.deepEqual(r.requests, []);
    tasks[i].fn();
  }
  await until(() => r.requests.length || p.status().pending === 0, 'delivery or lost item');
  assert.equal(r.requests.length, 1, 'storage failures before POST must not exhaust the delivery budget');
});

test('finding 7: startup reconciles beyond the 50-item listing and the 100-item queue', { timeout: 120000 }, async t => {
  let held;
  const received = new EventEmitter();
  const r = await fake(t, (_req, res, count) => {
    if (count === 1) held = res; else res.end('{"result":"stored"}');
    if (count >= 101) received.emit('all');
  });
  t.after(() => held?.destroy());
  const root = await fs.mkdtemp(path.join(tmpdir(), 'antena-136-archives-'));
  const data = path.join(root, 'data'), archives = path.join(data, 'sessions');
  await fs.mkdir(archives, { recursive: true });
  await fs.writeFile(path.join(data, 'session-current.json'), JSON.stringify({ ...initial('current-open'), meldAutoSession: false }));
  const ids = Array.from({ length: 101 }, (_, i) => `archive-${String(i).padStart(3, '0')}`);
  for (const id of ids) {
    await fs.writeFile(path.join(archives, `${id}.json`), JSON.stringify({ ...initial(id), endedAt: '2026-01-01T00:05:00.000Z' }));
  }
  let app;
  t.after(async () => { if (app) { app.viewers.halt(); await app.closeHttp(); } await fs.rm(root, { recursive: true, force: true }); });
  // The intentionally held response must outlive this whole test, not just the first wait:
  // the 100-durable-documents wait, the release, and the drain check. A shorter sender
  // watchdog (15 001 ms) can expire inside that window on a slow runner, retry, and add a
  // request for an item that was already counted, so the 101-request assertion sees 100 ids.
  app = await createApp({ dataDir: data, mediaDir: path.join(root, 'media'), push: { url: r.url, token: TOKEN },
    pushTimeoutMs: 120000, log: () => {} });
  await until(async () => {
    try { return held && JSON.parse(await fs.readFile(path.join(data, 'push-export.json'), 'utf8')).entries.length === 100; }
    catch { return false; }
  }, '100 durable pending documents', { timeoutMs: 60000 });
  assert.equal(r.requests.length, 1);
  const allReceived = once(received, 'all', { signal: AbortSignal.timeout(30000) });
  held.end('{"result":"stored"}');
  await allReceived;
  const assertRequests = () => {
    assert.equal(r.requests.length, 101);
    assert.deepEqual(new Set(r.requests.map(request => JSON.parse(request.body).session.id)), new Set(ids));
  };
  assertRequests();
  await until(async () => {
    try {
      const queue = JSON.parse(await fs.readFile(path.join(data, 'push-export.json'), 'utf8'));
      return queue.entries.length === 0 && queue.delivered.length === 101;
    } catch { return false; }
  }, 'all 101 archives durably delivered', { timeoutMs: 60000 });
  assertRequests();
});

test('finding 7: a durable permanent failure is not regenerated on restart', async t => {
  const r = await fake(t, (_req, res) => { res.writeHead(400); res.end('untrusted'); });
  const f = await fixture(t, r);
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  await until(async () => r.requests.length === 1 && (await pushStatus(f)).pending === 0, 'permanent failure recorded');
  await f.restart();
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  await sleep(250);
  assert.equal(r.requests.length, 1);
});

test('S3/S4: pending push files and public surfaces do not reveal the token', async t => {
  const r = await fake(t, (_req, res) => { res.writeHead(503); res.end(TOKEN); });
  const f = await fixture(t, r);
  const end = await f.request('POST', '/api/session/end'); assert.equal(end.status, 200);
  await until(async () => r.requests.length === 1 && (await pushStatus(f)).lastError === 'HTTP 503', 'retryable failure');
  const names = (await fs.readdir(f.data)).filter(name => name.startsWith('push-export') && name.endsWith('.json'));
  const files = await Promise.all(names.map(name => fs.readFile(path.join(f.data, name), 'utf8')));
  const surfaces = await Promise.all(['/api/status', '/api/state', '/api/config', '/api/metrics/v1/sessions/synthetic-136']
    .map(url => f.request('GET', url)));
  assert.equal(r.requests[0].auth, `Bearer ${TOKEN}`);
  for (const text of [...files, end.text, JSON.stringify(f.logs), ...surfaces.map(result => result.text)]) {
    assert.ok(!text.includes(TOKEN));
  }
});

test('S8: an undurable first enqueue stays owed through a disabled restart', async t => {
  const id = '000-owed-before-disable';
  let held;
  const open = fs.open;
  t.after(() => { fs.open = open; held?.destroy(); });
  const r = await fake(t, (_req, res) => { held = res; });
  const f = await fixture(t, r, { current: initial(id) });
  assert.equal((await f.request('PUT', '/api/config', { sessions: { retention: 1 } })).status, 200);
  fs.open = async function (file, ...args) {
    if (String(file).includes('.push-export.json.')) throw new Error('synthetic initial queue checkpoint failure');
    return open.call(this, file, ...args);
  };
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  await until(async () => (await pushStatus(f)).lastError === 'No se pudo guardar o leer la cola de envío.', 'first queue checkpoint failed');
  assert.equal((await pushStatus(f)).pending, 1);
  assert.deepEqual(r.requests, []);
  await assert.rejects(fs.stat(path.join(f.data, 'push-export.json')), error => error.code === 'ENOENT');
  const detail = await f.request('GET', `/api/metrics/v1/sessions/${id}`);
  assert.equal(detail.status, 200);
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  assert.equal((await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status, 200);
  await f.restart({});
  assert.equal((await pushStatus(f)).enabled, false);
  assert.equal((await pushStatus(f)).pending, 0);
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  assert.equal((await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status, 200,
    'a previously owed archive must survive retention when restarted with push disabled');
  assert.deepEqual(r.requests, []);

  // A separate disabled-by-default automatic session must keep ordinary retention.
  const ordinary = '000-ordinary-disabled';
  const disabled = await fixture(t, r, { push: {}, current: initial(ordinary) });
  assert.equal((await disabled.request('PUT', '/api/config', { sessions: { retention: 1 } })).status, 200);
  assert.equal((await disabled.request('POST', '/api/session/end')).status, 200);
  assert.equal((await disabled.request('POST', '/api/session/new')).status, 200);
  assert.equal((await disabled.request('POST', '/api/session/new')).status, 200);
  assert.equal((await disabled.request('GET', `/api/metrics/v1/sessions/${ordinary}`)).status, 404);
  assert.equal((await pushStatus(disabled)).enabled, false);
  assert.deepEqual(r.requests, []);

  fs.open = open;
  await f.restart({ url: r.url, token: TOKEN });
  await until(() => held, 'owed document delivered after re-enabling');
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].auth, `Bearer ${TOKEN}`);
  const sent = JSON.parse(r.requests[0].body);
  assert.deepEqual({ ...sent, generatedAt: detail.body.generatedAt }, detail.body);
  await until(async () => (await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status === 404,
    'normal retention resumes after durable enqueue');
  held.end('{"result":"stored"}');
  await until(async () => (await pushStatus(f)).pending === 0, 'delivery completed');
  assert.ok(!JSON.stringify(await pushStatus(f)).includes(TOKEN));
});

test('S8: retention protects an unqueued archive through a full queue, restart and checkpoint failure', async t => {
  const id = '000-pending-retention';
  let releaseQueue = false, heldPending;
  const held = [];
  const open = fs.open;
  t.after(() => { fs.open = open; });
  const r = await fake(t, (_req, res, count) => {
    const sentId = JSON.parse(r.requests[count - 1].body).session.id;
    if (sentId === id) { heldPending = res; return; }
    if (!releaseQueue) { held.push(res); return; }
    res.end('{"result":"stored"}');
  });
  const f = await fixture(t, r, { push: {}, current: initial(id) });
  assert.equal((await f.request('PUT', '/api/config', { sessions: { retention: 1 } })).status, 200);
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  const detail = await f.request('GET', `/api/metrics/v1/sessions/${id}`);
  assert.equal(detail.status, 200);
  await f.app.closeHttp();
  const entries = Array.from({ length: 100 }, (_, i) => {
    const doc = structuredClone(detail.body), queuedId = `queued-${String(i).padStart(3, '0')}`;
    doc.session.id = queuedId;
    for (const row of doc.metrics) row.sessionId = queuedId;
    return { body: JSON.stringify(doc), attempts: 0, nextAt: 0 };
  });
  const receiver = createHash('sha256').update(new URL(r.url).href).digest('hex');
  await fs.writeFile(path.join(f.data, 'push-export.json'), JSON.stringify({ version: 1, receiver, entries }));
  await f.restart({ url: r.url, token: TOKEN });
  await until(async () => held.length === 1 && (await pushStatus(f)).pending === 100, 'full queue and held receiver');
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  assert.equal((await f.request('PUT', '/api/session', { title: 'synthetic capture continues' })).status, 200);
  assert.equal((await f.request('GET', '/api/session')).body.title, 'synthetic capture continues');
  assert.equal((await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status, 200, 'unqueued archive must outlive retention');
  await f.restart();
  await until(async () => held.length >= 2 && (await pushStatus(f)).pending === 100, 'full queue after restart');
  assert.equal((await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status, 200, 'archive must survive restart');
  let blockPending = true;
  fs.open = async function (file, ...args) {
    const handle = await open.call(this, file, ...args);
    if (String(file).includes('.push-export.json.')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (body, ...rest) => {
        if (blockPending && String(body).includes(id)) throw new Error('synthetic enqueue checkpoint failure');
        return write(body, ...rest);
      };
    }
    return handle;
  };
  releaseQueue = true;
  for (const res of held) if (!res.destroyed) res.end('{"result":"stored"}');
  await until(async () => (await pushStatus(f)).lastError === 'No se pudo guardar o leer la cola de envío.', 'enqueue checkpoint failed');
  assert.equal((await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status, 200, 'failed checkpoint is not durable');
  const beforeRecovery = await fs.readFile(path.join(f.data, 'push-export.json'), 'utf8');
  assert.ok(!beforeRecovery.includes(id));
  assert.ok(!beforeRecovery.includes(TOKEN));
  blockPending = false;
  fs.open = open;
  await until(() => heldPending, 'retained archive posted after checkpoint recovery');
  assert.equal((await pushStatus(f)).pending, 1, 'the retained delivery is still in flight');
  await until(async () => (await f.request('GET', `/api/metrics/v1/sessions/${id}`)).status === 404, 'normal retention resumed after durable enqueue');
  heldPending.end('{"result":"stored"}');
  await until(async () => (await pushStatus(f)).pending === 0, 'queue drained');
  assert.equal(r.requests.filter(request => JSON.parse(request.body).session.id === id).length, 1);
  assert.ok(r.requests.every(request => request.auth === `Bearer ${TOKEN}`));
});

test('C1/S8: oversized persisted document is dropped and the following item retains all retries', async t => {
  let p;
  t.after(async () => { await p?.close(); });
  const r = await fake(t, (_req, res, count) => {
    if (count < 5) { res.writeHead(503); res.end('UNTRUSTED-RESPONSE'); }
    else res.end('{"result":"stored"}');
  });
  const f = await fixture(t, r, { push: {} });
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  const detail = await f.request('GET', '/api/metrics/v1/sessions/synthetic-136');
  assert.equal(detail.status, 200);
  await f.app.closeHttp();
  const document = id => {
    const doc = structuredClone(detail.body);
    doc.session.id = id;
    for (const row of doc.metrics) row.sessionId = id;
    return doc;
  };
  const oversized = document('oversized');
  oversized.session.platforms[0].externalId = 'UNTRUSTED-BODY-' + 'x'.repeat(256 * 1024);
  const valid = document('valid');
  const receiver = createHash('sha256').update(new URL(r.url).href).digest('hex');
  await fs.writeFile(path.join(f.data, 'push-export.json'), JSON.stringify({ version: 1, receiver, entries: [
    { body: JSON.stringify(oversized), attempts: 4, nextAt: 0 },
    { body: JSON.stringify(valid), attempts: 0, nextAt: 0 },
  ] }));
  const tasks = [], statuses = [];
  let now = Date.now();
  const timers = { setTimeout(fn, ms) { const task = { fn, ms }; tasks.push(task); return task; },
    clearTimeout(task) { task.cancelled = true; } };
  p = createPushExport({ config: { url: r.url, token: TOKEN }, timers, now: () => now, onChange: () => statuses.push(p.status()) });
  await p.load(f.data);
  for (let i = 0; i < 4; i++) {
    await until(() => {
      assert.notEqual(p.status().lastError, 'No se pudo guardar o leer la cola de envío.', 'oversized document must not block the queue');
      return tasks[i] && r.requests.length === i + 1;
    }, `retry ${i + 1}`);
    assert.equal(tasks[i].ms, 1000 * 2 ** i);
    now += tasks[i].ms;
    tasks[i].fn();
  }
  await until(() => r.requests.length === 5 && p.status().pending === 0, 'valid document delivered after all retries');
  assert.deepEqual(r.requests.map(request => JSON.parse(request.body).session.id), Array(5).fill('valid'));
  assert.ok(r.requests.every(request => request.body === JSON.stringify(valid) && request.auth === `Bearer ${TOKEN}`));
  assert.ok(statuses.some(status => status.lastError === 'El documento de envío no es válido.'));
  assert.ok(!JSON.stringify(statuses).includes(TOKEN));
  assert.ok(!JSON.stringify(statuses).includes('UNTRUSTED'));
  const saved = await fs.readFile(path.join(f.data, 'push-export.json'), 'utf8');
  assert.ok(!saved.includes(TOKEN));
  assert.ok(!saved.includes('UNTRUSTED'));
  assert.ok(JSON.parse(saved).failed.includes('oversized'));
});

test('S4: enqueue during a hanging POST preserves both deliveries and capture', async t => {
  let held;
  const r = await fake(t, (_req, res, count) => { if (count === 1) held = res; else res.end('{"result":"stored"}'); });
  t.after(() => held?.destroy());
  const f = await fixture(t, r);
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  await until(() => held, 'first POST held');
  assert.equal((await f.request('POST', '/api/session/new')).status, 200);
  f.app.session.data.meldAutoSession = true;
  f.app.session.data.platforms = { twitch: { streamId: 'synthetic-B' } };
  f.app.session.record({ id: 'synthetic-event-B', type: 'follow', at: new Date().toISOString(), vars: { user: 'fake' }, text: 'fake' });
  const id = f.app.session.data.id;
  assert.equal((await f.request('POST', '/api/session/end')).status, 200);
  const queue = await until(async () => {
    try { const q = JSON.parse(await fs.readFile(path.join(f.data, 'push-export.json'), 'utf8')); return q.entries.length === 2 && q; }
    catch { return null; }
  }, 'two durable pending documents');
  assert.deepEqual(queue.entries.map(entry => JSON.parse(entry.body).session.id), ['synthetic-136', id]);
  assert.ok(!JSON.stringify(queue).includes(TOKEN));
  held.end('{"result":"stored"}');
  await until(async () => r.requests.length === 2 && (await pushStatus(f)).pending === 0, 'both delivered');
  assert.deepEqual(r.requests.map(request => JSON.parse(request.body).session.id), ['synthetic-136', id]);
  const summary = await f.request('GET', '/api/session/summary?format=json');
  assert.equal(summary.body.events[0].id, 'synthetic-event-B');
});
