// Saved themes phase 2: existing installs keep their pre-platform default look, new installs and
// «Desde cero» themes use «Color de cada plataforma», the inactive preview is read-only and isolated,
// and the theme fence applies only to themed paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const STALE = 'El tema activo cambió mientras editabas; tus cambios no se guardaron';
async function boot(t, seed) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-dl-'));
  if (seed) await writeFile(path.join(dir, 'config.json'), JSON.stringify(seed));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  t.after(async () => { app.interactive.quiesceVoteTimer(); await app.drainAutoSession(); await app.session.flush(); await app.interactive.flush(); app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); await rm(dir, { recursive: true, force: true }); });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (m, u, b, th) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(th === undefined ? {} : { 'x-antena-theme': th }) }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json() }; };
  return { call, bytes: () => readFile(path.join(dir, 'config.json'), 'utf8') };
}
for (const [name, seed] of [['v0', { theme: { glow: 10 } }], ['v1', { configVersion: 1 }], ['v2', { configVersion: 2, theme: { accent: '#18E08B' } }], ['v2 badge none', { configVersion: 2, theme: { platformBadge: 'none' } }]])
  test(`existing ${name} install keeps the pre-platform default look`, async t => {
    const f = await boot(t, seed); const { theme } = (await f.call('GET', '/api/theme')).body;
    assert.equal(theme.platformAccent, false); assert.equal(theme.platformBadge, seed.theme?.platformBadge ?? 'text');
  });
test('fresh install and from-default use Color de cada plataforma; other presets are gone', async t => {
  const f = await boot(t, null);
  const { theme } = (await f.call('GET', '/api/theme')).body;
  assert.deepEqual([theme.platformAccent, theme.platformBadge], [true, 'logo']);
  assert.equal((await f.call('POST', '/api/theme/preset', { id: 'cian' })).status, 404);
});
test('inactive preview is read-only, uses its own look, and leaks no other theme', async t => {
  const f = await boot(t, { configVersion: 2 });
  const id = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Navidad' })).body.theme.id;
  await f.call('POST', `/api/themes/${id}/activate`); await f.call('PUT', '/api/theme', { accent: '#CC0000' });
  await f.call('POST', '/api/themes/normal/activate'); await f.call('PUT', '/api/theme', { accent: '#00AA00' });
  const before = await f.bytes(); const p = await f.call('GET', `/api/themes/${id}/preview`);
  assert.equal(p.body.theme.accent, '#CC0000'); assert.ok(!JSON.stringify(p.body).includes('#00AA00'));
  assert.equal(p.body.alert.actions, undefined); assert.equal(p.body.alert.tts, undefined);
  assert.equal(await f.bytes(), before);
  assert.equal((await f.call('GET', '/api/themes')).body.themes.find(x => x.active).id, 'normal');
});
test('config/set fences themed paths only', async t => {
  const f = await boot(t, { configVersion: 2 });
  const id = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'B' })).body.theme.id;
  await f.call('POST', `/api/themes/${id}/activate`); const before = await f.bytes();
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'alerts.follow.title', value: 'x' }, 'normal'), { status: 409, body: { error: STALE } });
  assert.equal(await f.bytes(), before);
  assert.equal((await f.call('PUT', '/api/config', { panel: { onboardingDone: true } }, 'normal')).status, 200);
});
