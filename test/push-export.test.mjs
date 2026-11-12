// #136: synthetic sessions and a loopback-only fake receiver; no platform accounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const TOKEN = 'synthetic-push-token-9Qx';
const PATHNAME = '/api/v1/ingest/antena/sessions';
const startedAt = '2026-01-01T12:00:00.000Z';
const initial = (extra = {}) => ({ id: 'synthetic-session', title: 'Prueba', startedAt,
  events: [{ id: 'e1', type: 'follow', at: startedAt, vars: {}, text: 'synthetic' }],
  notes: [], goalOffsets: {}, meldAutoSession: true,
  platforms: { twitch: { streamId: 'synthetic-stream' } }, chatListeners: { twitch: true }, ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 5000) {
  const end = Date.now() + ms;
  // Date may be frozen for byte-for-byte export comparisons.
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(5);
  }
  assert.fail(`timed out waiting for ${label} (${end})`);
}
function fakeTimers() {
  const tasks = [];
  let now = Date.now();
  return {
    tasks, now: () => now,
    setTimeout(fn, ms) { const task = { fn, ms, cancelled: false }; tasks.push(task); return task; },
    clearTimeout(task) { if (task) task.cancelled = true; },
    runNext() {
      const task = tasks.find(x => !x.cancelled);
      assert.ok(task, 'expected a pending backoff timer');
      task.cancelled = true;
      now += task.ms;
      task.fn();
      return task.ms;
    },
  };
}
async function receiver(t, responses = [200], host = '127.0.0.1') {
  const requests = [];
  let release;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const choice = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (choice === 'hang') { release = () => res.destroy(); return; }
    if (choice === 'network') { req.socket.destroy(); return; }
    if (choice === 'redirect') {
      res.writeHead(302, { location: 'http://192.0.2.10:9/never-follow' }); res.end(); return;
    }
    if (choice === 'unchanged') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"result":"unchanged"}'); return;
    }
    res.writeHead(choice, { 'content-type': 'application/json' });
    res.end(choice === 200 ? '{"result":"stored"}' : JSON.stringify({ error: TOKEN }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  t.after(async () => { release?.(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const authority = host === '::1' ? '[::1]' : host;
  return { requests, url: `http://${authority}:${server.address().port}${PATHNAME}`, release: () => release?.() };
}
async function fixture(t, { push, timers = fakeTimers(), current = initial() } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-push-test-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'session-current.json'), JSON.stringify(current));
  const logs = [];
  let app;
  t.after(async () => {
    if (app) {
      app.viewers.halt();
      await app.youtube.quiescePoll().catch(() => {});
      await app.chat.quiesceChat().catch(() => {});
      await app.drainAutoSession().catch(() => {});
      await app.drainChatMetrics().catch(() => {});
      await app.session.flush().catch(() => {});
      await app.closeHttp().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: (...x) => logs.push(x.join(' ')),
    push, pushTimers: timers, pushNow: timers.now, pushTimeoutMs: 250 });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, text: await res.text() };
  };
  const json = async (method, url, body) => { const r = await request(method, url, body); return { ...r, body: JSON.parse(r.text) }; };
  return { get app() { return app; }, get base() { return base; }, logs, timers, request, json,
    end: () => json('POST', '/api/session/end', {}),
    async restart(nextPush = push) {
      await app.closeHttp();
      push = nextPush;
      app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: (...x) => logs.push(x.join(' ')),
        push, pushTimers: timers, pushNow: timers.now, pushTimeoutMs: 250 });
      await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${app.server.address().port}`;
    } };
}
const config = url => ({ url, token: TOKEN });
const status = async f => (await f.json('GET', '/api/status')).body.push;
async function mcpStatus(base) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    env: { ANTENA_URL: base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; if (out.includes('\n')) child.stdin.end(); });
  child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estado', arguments: {} } }) + '\n');
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0); assert.equal(err, ''); assert.ok(!out.includes(TOKEN));
  const result = JSON.parse(out.trim()).result;
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content[0].text).push;
}

// The URL and token are process settings, never public config fields.
test('S1: disabled by default, with status and no request on session end', async t => {
  const r = await receiver(t), f = await fixture(t, { push: {} });
  const ended = await f.end(); assert.equal(ended.status, 200);
  await sleep(50);
  assert.deepEqual(r.requests, []);
  assert.deepEqual(await status(f), { enabled: false, lastSuccess: null, lastError: null, pending: 0 });
});

test('S1: invalid receiver URLs fail activation without echoing their values', async t => {
  const invalid = [
    'http://localhost:1234/x', 'http://127.0.0.2:1234/x', 'http://192.0.2.10:1234/x',
    'http://127.1:1234/x', 'http://user:pass@127.0.0.1:1234/x', 'http://127.0.0.1:1234/x?q=1',
    'http://127.0.0.1:1234/x#fragment', 'http://127.0.0.1:1234/x?', 'http://127.0.0.1:1234/x#',
    'https://127.0.0.1:1234/x', 'ftp://127.0.0.1:1234/x',
    'http://127.0.0.1/x', 'http://[::1]/x', 'http://[::2]:1234/x', 'http://127.0.0.1:0/x', 'http://127.0.0.1:65536/x',
  ];
  for (const url of invalid) await t.test('reject invalid receiver', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'antena-push-invalid-'));
    try {
      await assert.rejects(createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'),
        log: () => {}, push: config(url) }), e => {
        assert.equal(e.message, 'La URL del receptor no es válida.');
        assert.ok(!e.message.includes(url)); assert.ok(!e.message.includes(TOKEN)); return true;
      });
      assert.deepEqual(await readdir(root), [], 'invalid settings must not create or change stored state');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('S1: explicit IPv6 loopback with a port is accepted', async t => {
  let r;
  try { r = await receiver(t, ['unchanged'], '::1'); }
  catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) return t.skip('IPv6 loopback unavailable');
    throw error;
  }
  const f = await fixture(t, { push: config(r.url) });
  assert.equal((await f.end()).status, 200);
  await until(async () => (await status(f))?.lastSuccess, 'IPv6 delivery');
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('S1/S3: process environment enables local push without exposing its token', async t => {
  const r = await receiver(t);
  const root = await mkdtemp(path.join(tmpdir(), 'antena-push-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data', 'session-current.json'), JSON.stringify(initial()));
  const moduleUrl = new URL('../src/server.mjs', import.meta.url).href;
  const source = `
    import { createApp } from ${JSON.stringify(moduleUrl)};
    const app = await createApp({ dataDir: ${JSON.stringify(path.join(root, 'data'))}, mediaDir: ${JSON.stringify(path.join(root, 'media'))}, log: () => {} });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const end = await fetch(base + '/api/session/end', { method: 'POST', body: '{}' });
    let status;
    for (let i = 0; i < 100; i++) {
      status = await fetch(base + '/api/status').then(r => r.json());
      if (status.push?.lastSuccess) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    process.stdout.write(JSON.stringify({ end: end.status, push: status.push }));
    await app.closeHttp();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ANTENA_PUSH_URL: r.url, ANTENA_PUSH_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0); assert.equal(err, ''); assert.ok(!out.includes(TOKEN));
  const result = JSON.parse(out); assert.equal(result.end, 200); assert.equal(result.push.pending, 0);
  assert.ok(result.push.lastSuccess); assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('S3: invalid bearer tokens fail without revealing the value', async t => {
  const r = await receiver(t);
  const root = await mkdtemp(path.join(tmpdir(), 'antena-push-token-'));
  try {
    for (const token of ['', 'synthetic bad token', 'synthetic\r\nheader']) {
      await assert.rejects(createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'),
        log: () => {}, push: { url: r.url, token } }), e => {
        assert.equal(e.message, 'El token del receptor no es válido.');
        if (token) assert.ok(!e.message.includes(token)); return true;
      });
    }
    assert.deepEqual(await readdir(root), []); assert.deepEqual(r.requests, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('S2: POST is exactly the unchanged v1 detail response', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T12:00:00.000Z') });
  const r = await receiver(t), f = await fixture(t, { push: config(r.url) });
  const ended = await f.end(); assert.equal(ended.status, 200);
  await until(() => r.requests.length === 1, 'one export');
  const detail = await f.request('GET', '/api/metrics/v1/sessions/synthetic-session');
  assert.equal(detail.status, 200); assert.equal(r.requests[0].method, 'POST');
  assert.equal(r.requests[0].path, PATHNAME); assert.equal(r.requests[0].headers['content-type'], 'application/json');
  assert.equal(r.requests[0].body, detail.text); assert.ok(Buffer.byteLength(detail.text) <= 256 * 1024);
  assert.equal(JSON.parse(detail.text).schema, 'antena.session-metrics'); assert.equal(JSON.parse(detail.text).version, 1);
});

test('S2: a v1 document exactly 256 KiB is delivered unchanged', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T12:00:00.000Z') });
  const baseline = await fixture(t, { push: {}, current: initial({ platforms: { twitch: { streamId: 'x' } } }) });
  assert.equal((await baseline.end()).status, 200);
  const small = await baseline.request('GET', '/api/metrics/v1/sessions/synthetic-session');
  const count = 256 * 1024 - Buffer.byteLength(small.text) + 1;
  const r = await receiver(t), f = await fixture(t, { push: config(r.url),
    current: initial({ platforms: { twitch: { streamId: 'x'.repeat(count) } } }) });
  assert.equal((await f.end()).status, 200);
  await until(() => r.requests.length === 1, 'boundary-size delivery');
  const exported = await f.request('GET', '/api/metrics/v1/sessions/synthetic-session');
  assert.equal(Buffer.byteLength(exported.text), 256 * 1024); assert.equal(r.requests[0].body, exported.text);
});

test('S2: oversized v1 documents are not sent or modified', async t => {
  const r = await receiver(t), f = await fixture(t, { push: config(r.url),
    current: initial({ platforms: { twitch: { streamId: 'x'.repeat(260 * 1024) } } }) });
  assert.equal((await f.end()).status, 200);
  await until(async () => (await status(f))?.lastError, 'oversized error');
  assert.deepEqual(r.requests, []); assert.equal((await status(f)).pending, 0);
  const exported = await f.request('GET', '/api/metrics/v1/sessions/synthetic-session');
  assert.equal(exported.status, 200); assert.ok(Buffer.byteLength(exported.text) > 256 * 1024);
});

test('S3: bearer token is confined to the receiver Authorization header', async t => {
  const r = await receiver(t, [401]), f = await fixture(t, { push: config(r.url) });
  const ended = await f.end(); assert.equal(ended.status, 200);
  await until(() => r.requests.length === 1, 'authenticated request');
  await until(async () => (await status(f))?.lastError, 'sanitized failure');
  assert.equal(r.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  for (const data of [r.requests[0].path, r.requests[0].body, ended.text, JSON.stringify(f.logs),
    (await f.request('GET', '/api/status')).text, (await f.request('GET', '/api/state')).text,
    (await f.request('GET', '/api/config')).text, (await f.request('GET', '/api/metrics/v1/sessions/synthetic-session')).text]) {
    assert.ok(!data.includes(TOKEN));
  }
});

test('S4: permanent 4xx errors never retry and leave the session intact', async t => {
  for (const code of [400, 401, 403, 404, 413, 422]) await t.test(String(code), async t => {
    const r = await receiver(t, [code]), f = await fixture(t, { push: config(r.url) });
    const before = await f.json('GET', '/api/session/summary?format=json');
    const ended = await f.end(); assert.equal(ended.status, 200);
    await until(async () => { const s = await status(f); return s?.lastError && s.pending === 0; }, 'durable permanent error');
    assert.equal(r.requests.length, 1); assert.equal((await status(f)).pending, 0);
    assert.equal(f.timers.tasks.filter(x => !x.cancelled).length, 0);
    const after = await f.json('GET', '/api/session/summary?format=json');
    assert.equal(after.status, 200); assert.deepEqual(after.body.events, before.body.events);
    assert.equal(after.body.id, before.body.id); assert.ok(after.body.endedAt);
  });
});

test('S4: retryable HTTP failures and network errors use increasing bounded backoff', async t => {
  for (const code of [408, 429, 500, 503, 'network']) await t.test(String(code), async t => {
    const r = await receiver(t, [code, code, 200]), f = await fixture(t, { push: config(r.url) });
    assert.equal((await f.end()).status, 200);
    await until(() => f.timers.tasks.some(x => !x.cancelled), 'first retry');
    assert.equal(r.requests.length, 1); assert.equal((await status(f)).pending, 1);
    const first = f.timers.runNext();
    await until(() => f.timers.tasks.filter(x => !x.cancelled).length === 1, 'second retry');
    assert.equal(r.requests.length, 2); assert.equal((await status(f)).pending, 1);
    const second = f.timers.runNext(); assert.ok(first > 0 && second > first && second <= 60_000);
    await until(async () => (await status(f))?.pending === 0, 'delivered');
    assert.equal(r.requests.length, 3); assert.ok(r.requests.every(x => x.body === r.requests[0].body));
  });
});

test('S3/S4: redirects are not followed and cannot send the token elsewhere', async t => {
  const r = await receiver(t, ['redirect']), f = await fixture(t, { push: config(r.url) });
  assert.equal((await f.end()).status, 200);
  await until(async () => { const s = await status(f); return s?.lastError && s.pending === 0; }, 'durable redirect error');
  assert.equal(r.requests.length, 1); assert.equal((await status(f)).pending, 0);
  assert.equal(f.timers.tasks.filter(x => !x.cancelled).length, 0);
  assert.ok(!JSON.stringify(await status(f)).includes(TOKEN));
});

test('S4: a nonresponsive receiver times out while the next session starts', async t => {
  const r = await receiver(t, ['hang', 200]), f = await fixture(t, { push: config(r.url) });
  const end = await f.end(); assert.equal(end.status, 200);
  await until(() => r.requests.length === 1, 'hanging receiver');
  const next = await f.json('POST', '/api/session/new', { title: 'continuation' });
  assert.equal(next.status, 200); assert.notEqual(next.body.session.id, end.body.session.id);
  assert.equal((await status(f)).pending, 1);
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'timeout retry');
  f.timers.runNext();
  await until(async () => (await status(f))?.pending === 0, 'delivery after timeout');
  assert.equal(r.requests.length, 2); assert.equal(r.requests[0].body, r.requests[1].body);
  const archived = await f.json('GET', '/api/session/summary?format=json&id=synthetic-session');
  assert.equal(archived.status, 200); assert.deepEqual(archived.body.events, initial().events);
});

test('S4: pending is retained until retries are exhausted without blocking capture', async t => {
  const r = await receiver(t, [500]), f = await fixture(t, { push: config(r.url) });
  assert.equal((await f.end()).status, 200);
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'first retry');
  const next = await f.json('POST', '/api/session/new', { title: 'next' });
  assert.equal(next.status, 200); assert.notEqual(next.body.session.id, 'synthetic-session');
  assert.equal((await status(f)).pending, 1);
  let previous = 0;
  for (let i = 0; i < 4; i++) {
    const delay = f.timers.runNext(); assert.ok(delay > previous); previous = delay;
    await until(async () => r.requests.length >= i + 2 && ((await status(f))?.pending === 0 || f.timers.tasks.some(x => !x.cancelled)), 'next attempt');
  }
  assert.equal(r.requests.length, 5); assert.equal((await status(f)).pending, 0);
  assert.equal(f.timers.tasks.filter(x => !x.cancelled).length, 0);
  const old = await f.json('GET', '/api/session/summary?format=json&id=synthetic-session');
  assert.equal(old.status, 200); assert.equal(old.body.events.length, 1); assert.ok(old.body.endedAt);
});

test('S4: pending survives a restart and retains its original export', async t => {
  const r = await receiver(t, [500, 200]), f = await fixture(t, { push: config(r.url) });
  assert.equal((await f.end()).status, 200);
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'first retry before restart');
  assert.equal((await status(f)).pending, 1);
  await f.restart();
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'backoff retained after restart');
  f.timers.runNext();
  await until(async () => (await status(f))?.lastSuccess, 'delivery after restart');
  assert.equal((await status(f)).pending, 0);
  assert.equal(r.requests.length, 2); assert.equal(r.requests[1].body, r.requests[0].body);
  assert.equal(r.requests[1].headers.authorization, `Bearer ${TOKEN}`);
});

test('S4: disabling or changing the receiver preserves pending without redirecting it', async t => {
  const original = await receiver(t, [500, 200]), other = await receiver(t);
  const f = await fixture(t, { push: config(original.url) });
  assert.equal((await f.end()).status, 200);
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'pending before configuration change');
  await f.restart({});
  assert.equal((await status(f)).enabled, false); assert.equal((await status(f)).pending, 1);
  await f.restart(config(other.url));
  assert.equal((await status(f)).pending, 1); assert.match((await status(f)).lastError, /otro receptor/);
  assert.deepEqual(other.requests, []);
  await f.restart(config(original.url));
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'original receiver backoff');
  f.timers.runNext();
  await until(async () => (await status(f))?.lastSuccess, 'original receiver delivery');
  assert.equal(original.requests.length, 2); assert.deepEqual(other.requests, []);
  assert.equal((await status(f)).pending, 0);
});

test('S5: status shows pending, sanitized last error and last successful send', async t => {
  const r = await receiver(t, [503, 200]), f = await fixture(t, { push: config(r.url) });
  assert.deepEqual(await status(f), { enabled: true, lastSuccess: null, lastError: null, pending: 0 });
  assert.equal((await f.end()).status, 200);
  await until(() => f.timers.tasks.some(x => !x.cancelled), 'retry status');
  const failed = await status(f);
  assert.equal(failed.pending, 1); assert.match(failed.lastError, /503/); assert.equal(failed.lastSuccess, null);
  assert.ok(!JSON.stringify(failed).includes(TOKEN));
  assert.deepEqual((await f.json('GET', '/api/state')).body.status.push, failed);
  assert.deepEqual(await mcpStatus(f.base), failed);
  f.timers.runNext();
  const delivered = await until(async () => { const s = await status(f); return s?.lastSuccess && s.pending === 0 ? s : null; }, 'success status');
  assert.ok(!Number.isNaN(Date.parse(delivered.lastSuccess)));
});

test('S4: automatic stop and implicit cutover each deliver the finished session once', async t => {
  await t.test('Meld stop', async t => {
    const r = await receiver(t), f = await fixture(t, { push: config(r.url) });
    f.app.meld.setStatus({ state: 'conectado', streaming: false });
    await until(() => r.requests.length === 1, 'automatic end');
    assert.equal(JSON.parse(r.requests[0].body).session.id, 'synthetic-session');
    assert.ok((await f.json('GET', '/api/session')).body.endedAt);
  });
  await t.test('start next session', async t => {
    const r = await receiver(t), f = await fixture(t, { push: config(r.url) });
    const next = await f.json('POST', '/api/session/new', { title: 'next' });
    assert.equal(next.status, 200); assert.notEqual(next.body.session.id, 'synthetic-session');
    await until(() => r.requests.length === 1, 'cutover export');
    assert.equal(JSON.parse(r.requests[0].body).session.id, 'synthetic-session');
  });
});

test('S6: only a fake loopback receiver and synthetic ended sessions are used', async t => {
  const r = await receiver(t), f = await fixture(t, { push: config(r.url) });
  assert.equal((await f.end()).status, 200);
  await until(() => r.requests.length === 1, 'synthetic push');
  const body = JSON.parse(r.requests[0].body);
  assert.equal(body.session.id, 'synthetic-session'); assert.equal(body.session.platforms[0].externalId, 'synthetic-stream');
});

test('S7: pushing leaves the read-only v1 export and existing session-end semantics intact', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-02T12:00:00.000Z') });
  const r = await receiver(t), f = await fixture(t, { push: config(r.url) });
  const end = await f.end(); assert.equal(end.status, 200);
  const before = await f.request('GET', '/api/metrics/v1/sessions/synthetic-session');
  await until(() => r.requests.length === 1, 'push');
  const repeated = await f.end(); assert.equal(repeated.status, 200); assert.equal(repeated.text, end.text);
  const after = await f.request('GET', '/api/metrics/v1/sessions/synthetic-session');
  assert.equal(before.status, 200); assert.equal(after.text, before.text); assert.equal(r.requests[0].body, before.text);
  await sleep(30); assert.equal(r.requests.length, 1);
});

test('PRESERVE: ordinary config writes and status remain available', async t => {
  const f = await fixture(t, { push: {} });
  const put = await f.json('PUT', '/api/config', { tts: { rate: 1.25 } });
  assert.equal(put.status, 200); assert.equal(put.body.config.tts.rate, 1.25);
  const st = await f.json('GET', '/api/status'); assert.equal(st.status, 200);
  assert.equal(st.body.instance.app, 'antena'); assert.ok(st.body.persistence);
});
