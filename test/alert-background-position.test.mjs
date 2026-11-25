import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { buildCommandAlert, buildCustomAlert } from '../src/alerts.mjs';

const xy = look => [look.bgX, look.bgY, look.cardX, look.cardY];

test('mixed background offsets round-trip independently through alert APIs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-background-api-'));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.timers.stop(); app.viewers.stop(); app.meld.stop(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body, status = 200) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal(r.status, status, url); return r.json();
  };
  const sample = async () => (await api('GET', '/api/alerts/follow/sample')).alert.look;
  assert.deepEqual(xy(await sample()), [0, 0, 0, 0], 'old configurations remain centered');
  const state = await api('GET', '/api/state');
  assert.equal(state.fields.bgX, 'number'); assert.equal(state.fields.bgY, 'number');
  for (const media of ['background.png', 'background.webm']) {
    await api('PUT', '/api/alerts/follow', { layout: 'mixed', media, bgX: -120, bgY: 70, cardX: 40, cardY: -90 });
    assert.deepEqual(xy(await sample()), [-120, 70, 40, -90]);
    assert.deepEqual(xy((await api('GET', '/api/alerts/follow')).config), [-120, 70, 40, -90]);
  }
  for (const [bgX, bgY] of [[-1920, -1080], [1920, 1080], [0, 0]]) {
    await api('PUT', '/api/config', { alerts: { follow: { bgX, bgY } } });
    assert.deepEqual(xy(await sample()), [bgX, bgY, 40, -90]);
  }
  const before = await api('GET', '/api/alerts/follow');
  for (const [field, value, message] of [
    ['bgX', -1921, 'el valor mínimo es -1920'], ['bgX', 1921, 'el valor máximo es 1920'],
    ['bgY', -1081, 'el valor mínimo es -1080'], ['bgY', 1081, 'el valor máximo es 1080'],
  ]) {
    const result = await api('PUT', '/api/config', { alerts: { follow: { [field]: value } } }, 400);
    assert.equal(result.error, `alerts.follow.${field}: ${message}`);
    assert.deepEqual(await api('GET', '/api/alerts/follow'), before, 'rejected input must not change stored settings');
  }
  const { variation } = await api('POST', '/api/alerts/follow/variations', { name: 'Offset', overrides: { bgX: 80, bgY: -60 } });
  assert.deepEqual(variation.overrides, { bgX: 80, bgY: -60 });
  const reset = await api('PUT', `/api/alerts/follow/variations/${variation.id}`, { overrides: { bgX: null, bgY: null } });
  assert.deepEqual(reset.variation.overrides, {}, 'reset restores inheritance');
});

test('shared command/custom appearance keeps card offsets and accepts independent background offsets', () => {
  for (const build of [fields => buildCommandAlert({ id: 'fixture', ...fields }, { user: 'Ana' }, {}), fields => buildCustomAlert(fields, { user: 'Ana' }, {})]) {
    assert.deepEqual(xy(build({ layout: 'mixed', media: 'bg.webm', cardX: 30, cardY: -20 }).look), [0, 0, 30, -20]);
    assert.deepEqual(xy(build({ layout: 'mixed', media: 'bg.png', bgX: '120', bgY: -70, cardX: 30, cardY: -20 }).look), [120, -70, 30, -20]);
    assert.equal(build({ layout: 'mixed', media: '' }).look.layout, 'card', 'missing media still falls back to card');
  }
});
