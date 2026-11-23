// Saved themes phase 3: legacy stream clients never receive the opt-in theme identity events,
// /api/state keeps its shape, and the per-overlay theme CSS map keeps its limits and fence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-marker-')), dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { base, call, file: path.join(dataDir, 'config.json') };
}
async function collect(t, base, q) {
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const res = await fetch(`${base}/api/stream?${q}`, { signal: ctrl.signal }), reader = res.body.getReader(), dec = new TextDecoder();
  const events = []; (async () => { let buf = ''; try { for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value);
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = /^event: (.+)$/m.exec(buf.slice(0, i)); if (m) events.push(m[1]); buf = buf.slice(i + 2); } } } catch {} })();
  return events;
}

test('legacy streams never receive the opt-in theme identity events', async t => {
  const { base, call } = await fixture(t);
  const streams = Object.fromEntries(await Promise.all(['overlay', 'preview', 'widget', 'teleprompter'].map(async c => [c, await collect(t, base, 'client=' + c)])));
  const opted = await collect(t, base, 'client=widget&themeInfo=1&customTheme=1');
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Navidad' });
  await call('POST', '/api/themes/navidad/activate');
  await call('PUT', '/api/themes/navidad', { name: 'Navidad 2' });
  await call('POST', '/api/config/set', { path: 'customOverlayCss.demo', value: 'a{}' });
  await new Promise(r => setTimeout(r, 300));
  for (const [c, ev] of Object.entries(streams)) for (const name of ['activeTheme', 'customOverlayTheme', 'customOverlayCss']) assert.ok(!ev.includes(name), `${c} got ${name}`);
  assert.ok(opted.includes('activeTheme') && opted.includes('customOverlayTheme'));
});

test('/api/state keeps its shape: no activeTheme field', async t => {
  const { call } = await fixture(t);
  const { status, body } = await call('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(Object.hasOwn(body, 'activeTheme'), false);
});

test('customOverlayCss map cap holds across separate writes and fence keeps bytes', async t => {
  const { call, file } = await fixture(t);
  const big = 'b'.repeat(480000); const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call('POST', '/api/config/set', { path: `customOverlayCss.big${i}`, value: big })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 400]);
  const before = await readFile(file);
  assert.equal((await call('PUT', '/api/config', { customOverlayCss: { demo: 'z' } }, { 'X-Antena-Theme': 'other' })).status, 409);
  assert.equal((await call('PUT', '/api/config', { customOverlayCss: { demo: 'a'.repeat(520000) } })).status, 400);
  assert.deepEqual(await readFile(file), before);
});
