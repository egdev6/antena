// Synthetic reproduction of the supported interrupted-cutover retention case (#136).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.mjs';

const ID = '000-current-id-owed';
const TOKEN = 'SYNTHETIC-CURRENT-ID-OBLIGATION';
const initial = { id: ID, title: 'synthetic', startedAt: '2026-01-01T00:00:00.000Z',
  events: [], notes: [], goalOffsets: {}, meldAutoSession: true,
  platforms: { twitch: { streamId: 'synthetic' } } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 800; i++) {
    const result = await check();
    if (result) return result;
    await sleep(5);
  }
  assert.fail(`timeout: ${label}`);
}

test('S8: interrupted cutover preserves a current-ID obligation until durable enqueue', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'antena-current-id-regression-'));
  const data = path.join(root, 'data');
  await fs.mkdir(data);
  await fs.writeFile(path.join(data, 'session-current.json'), JSON.stringify(initial));
  let app, held, failNewPrimary = false, failQueue = false, blockedPrimary = 0, blockedQueue = 0;
  const originalOpen = fs.open, requests = [];
  const receiver = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ body, authorization: req.headers.authorization });
    held = res;
  });
  t.after(async () => {
    fs.open = originalOpen;
    if (app) { app.viewers.halt(); await app.closeHttp().catch(() => {}); }
    receiver.closeAllConnections();
    if (receiver.listening) await new Promise(resolve => receiver.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  const push = { url: `http://127.0.0.1:${receiver.address().port}/ingest`, token: TOKEN };
  fs.open = async function (file, ...args) {
    const name = path.basename(String(file));
    if (failQueue && name.includes('.push-export.json.')) {
      blockedQueue++;
      throw new Error('synthetic queue checkpoint failure');
    }
    const handle = await originalOpen.call(this, file, ...args);
    if (failNewPrimary && name.includes('.session-current.json.')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (value, ...rest) => {
        let saved;
        try { saved = JSON.parse(String(value)); } catch { /* unrelated checkpoint */ }
        if (saved?.id && saved.id !== ID) {
          blockedPrimary++;
          throw new Error('synthetic interrupted NEW primary checkpoint');
        }
        return write(value, ...rest);
      };
    }
    return handle;
  };
  async function launch(config) {
    app = await createApp({ dataDir: data, mediaDir: path.join(root, 'media'), push: config, log: () => {} });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  async function stop() {
    if (!app) return;
    const previous = app; app = undefined;
    previous.viewers.halt();
    await previous.closeHttp();
  }
  async function request(method, route, body = {}) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${route}`, {
      method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(1500),
      ...(['POST', 'PUT'].includes(method) ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  await launch({});
  assert.equal((await request('POST', '/api/session/end')).status, 200);
  assert.equal((await request('PUT', '/api/config', { sessions: { retention: 1 } })).status, 200);
  failNewPrimary = true;
  assert.equal((await request('POST', '/api/session/new')).status, 500);
  assert.ok(blockedPrimary > 0, 'the NEW primary checkpoint fault fired');
  await stop();

  failNewPrimary = false; failQueue = true;
  await launch(push);
  const current = await request('GET', '/api/session');
  assert.equal(current.status, 200);
  assert.equal(current.body.id, ID, 'OLD is recovered as current');
  const before = await request('GET', `/api/metrics/v1/sessions/${ID}`);
  assert.equal(before.status, 200);
  await until(async () => (await request('GET', '/api/status')).body.push.lastError === 'No se pudo guardar o leer la cola de envío.', 'failed initial queue checkpoint');
  assert.ok(blockedQueue > 0);
  assert.deepEqual(requests, []);
  await stop();

  await launch({});
  assert.equal((await request('GET', '/api/status')).body.push.enabled, false);
  for (let i = 0; i < 2; i++) assert.equal((await request('POST', '/api/session/new')).status, 200);
  const after = await request('GET', `/api/metrics/v1/sessions/${ID}`);
  assert.equal(after.status, 200, 'the previously owed current-ID archive survives disabled retention');
  assert.deepEqual({ ...after.body, generatedAt: before.body.generatedAt }, before.body);
  assert.deepEqual(requests, [], 'disabled push never sends');
  await stop();

  failQueue = false;
  await launch(push);
  await until(() => held, 'owed session sent after re-enabling');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
  const sent = JSON.parse(requests[0].body);
  assert.deepEqual({ ...sent, generatedAt: before.body.generatedAt }, before.body);
  assert.equal((await request('GET', '/api/status')).body.push.pending, 1);
  await until(async () => (await request('GET', `/api/metrics/v1/sessions/${ID}`)).status === 404,
    'ordinary retention resumes after durable enqueue');
  held.end('{"result":"stored"}');
  await until(async () => (await request('GET', '/api/status')).body.push.pending === 0, 'delivery completed');
  const surfaces = [JSON.stringify(await request('GET', '/api/status')), JSON.stringify(await request('GET', '/api/session')),
    await fs.readFile(path.join(data, 'push-export.json'), 'utf8')];
  for (const text of surfaces) assert.ok(!text.includes(TOKEN));
});
