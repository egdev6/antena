import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(c, l) { const e = Date.now() + 6000; while (!(await c())) { assert.ok(Date.now() < e, l); await delay(15); } }
test('OBS 501 on stop surfaces as 500, session kept, guard kept', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'probe-501-'));
  const fake = fakeObs({ streaming: true }); await new Promise(r => fake.server.listen(0, '127.0.0.1', r));
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    try { await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); await fake.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  await api('PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: `ws://127.0.0.1:${fake.server.address().port}` }, meld: { autoSession: true } });
  await until(async () => (await api('GET', '/api/session')).body.meldAutoSession === true, 'live session');
  const s = (await api('GET', '/api/session')).body;
  fake.failRequest('StopStream', { code: 501, comment: 'Output not running' });
  const r = await api('POST', '/api/program/stream', { action: 'stop' });
  console.log('PROBE501', JSON.stringify(r));
  assert.deepEqual(r, { status: 500, body: { error: 'OBS rechazó la petición «StopStream».' } });
  assert.deepEqual(await api('POST', '/api/meld/stream', { action: 'stop' }), { status: 409, body: { error: 'Ya hay una orden pendiente de confirmación del programa de emisión.' } });
  const after = (await api('GET', '/api/session')).body; assert.equal(after.id, s.id); assert.equal(after.endedAt, undefined);
  // toggle with OBS rejection surfaces through /command
  fake.failRequest('ToggleStream', { code: 500, comment: 'x' });
  const tg = await api('POST', '/api/program/command', { command: 'meld.toggleStreamingAction' });
  console.log('PROBETOGGLE', JSON.stringify(tg));
  assert.deepEqual(tg, { status: 500, body: { error: 'OBS rechazó la petición «ToggleStream».' } });
});
