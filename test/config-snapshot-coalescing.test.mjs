import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

// Only the first config write blocks; persistence frames must not consume that slot.
function sink(block = false, blockEvent = 'config') {
  const res = new EventEmitter();
  res.frames = [];
  res.writableLength = 0;
  res.write = frame => {
    res.frames.push(frame);
    if (block && frame.startsWith(`event: ${blockEvent}\n`)) { block = false; return false; }
    return true;
  };
  res.configs = () => res.frames.filter(frame => frame.startsWith('event: config\n'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  res.themes = () => res.frames.filter(frame => frame.startsWith('event: theme\n'))
    .map(frame => JSON.parse(frame.split('\ndata: ')[1]));
  return res;
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-config-snapshot-'));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({
    access: { key: 'SYNTHETIC_TEST_ACCESS' }, prompter: { fontSize: 20 }, chat: { sendTo: 'twitch' },
  }));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  t.after(() => app.closeHttp()); // createApp does not start integrations or listen.
  const slow = sink(true), healthy = sink(), outsiders = ['overlay', 'preview', 'widget', 'teleprompter'].map(() => sink());
  app.bus.addClient(slow, 'panel');
  app.bus.addClient(healthy, 'panel');
  outsiders.forEach((res, i) => app.bus.addClient(res, ['overlay', 'preview', 'widget', 'teleprompter'][i]));
  // Exercise the real Store change listener registered by createApp, not copied broadcast code.
  await app.store.patchConfig({ prompter: { fontSize: 20 } });
  return { ...app, slow, healthy, outsiders };
}

const viewPatch = { chat: { sendTo: 'both' }, prompter: { fontSize: 30 } };
const alertsPatch = { alerts: { follow: { title: 'Updated synthetic alert' } } };
const snapshot = store => ({ prompter: store.config.prompter, chat: store.config.chat, alerts: store.publicConfig().alerts });

function verify({ store, slow, healthy, outsiders }) {
  assert.equal(slow.configs().length, 1, 'queued config must wait for drain');
  slow.emit('drain');
  const delivered = slow.configs();
  assert.equal(delivered.length, 2, 'drain delivers one retained config snapshot');
  const merged = Object.assign({}, ...delivered);
  assert.equal(merged.chat.sendTo, 'both', 'drain must not leave chat at its old value');
  assert.equal(merged.prompter.fontSize, 30, 'drain must not leave prompter at its old value');
  assert.equal(merged.alerts.follow.title, alertsPatch.alerts.follow.title);
  assert.deepEqual(delivered.at(-1), snapshot(store), 'retained config is self-contained');
  for (const config of healthy.configs()) {
    assert.deepEqual(Object.keys(config).sort(), ['alerts', 'chat', 'prompter'], 'no extra config sections or credentials');
  }
  assert.deepEqual(healthy.configs().at(-1), snapshot(store));
  for (const res of outsiders) assert.equal(res.configs().length, 0, 'config remains panel-only');
}

test('real config producer retains chat/prompter when alerts replace a queued config', async t => {
  const app = await fixture(t);
  await app.store.patchConfig(viewPatch);
  assert.deepEqual(app.healthy.configs().at(-1), snapshot(app.store), 'healthy client sees view change immediately');
  await app.store.patchConfig(alertsPatch);
  assert.equal(app.healthy.configs().length, 3);
  verify(app);
});

test('reverse order retains alerts when chat/prompter replace the queued config', async t => {
  const app = await fixture(t);
  await app.store.patchConfig(alertsPatch);
  assert.deepEqual(app.healthy.configs().at(-1), snapshot(app.store), 'healthy client sees alerts immediately');
  await app.store.patchConfig(viewPatch);
  assert.equal(app.healthy.configs().length, 3);
  verify(app);
});

test('patch.all emits exactly one complete panel snapshot', async t => {
  const app = await fixture(t);
  await app.store.patchConfig(viewPatch);
  await app.store.patchConfig(alertsPatch);
  const before = app.healthy.configs().length;
  app.store.emit('change', { all: true });
  assert.equal(app.healthy.configs().length, before + 1);
  verify(app);
});

test('unrelated config changes do not publish a config snapshot', async t => {
  const app = await fixture(t);
  await app.store.patchConfig({ overlay: { volume: 0.5 } });
  app.slow.emit('drain');
  assert.equal(app.slow.configs().length, 1);
  assert.equal(app.healthy.configs().length, 1);
  for (const res of app.outsiders) assert.equal(res.configs().length, 0);
});

test('saved thumbnail fingerprints isolate alerts and include common CSS/theme, not unrelated config', async t => {
  const app = await fixture(t);
  app.store.emit('change', { alerts: true });
  const initial = app.healthy.themes().at(-1)?.alertPreviews;
  assert.ok(initial?.follow?.version, 'panel receives confirmed per-alert preview fingerprints');
  const count = app.healthy.themes().length;
  await app.store.patchConfig(viewPatch);
  await app.store.patchConfig({ overlay: { volume: 0.5 } });
  assert.equal(app.healthy.themes().length, count, 'unrelated settings do not invalidate thumbnails');
  await app.store.patchConfig(alertsPatch);
  const alert = app.healthy.themes().at(-1).alertPreviews;
  assert.notEqual(alert.follow.version, initial.follow.version);
  for (const type of Object.keys(initial).filter(type => type !== 'follow')) assert.deepEqual(alert[type], initial[type]);
  await app.store.patchConfig({ overlay: { css: '.alert { opacity: .9; }' } });
  const css = app.healthy.themes().at(-1).alertPreviews;
  for (const type of Object.keys(initial)) assert.notEqual(css[type].version, alert[type].version, 'saved common CSS refreshes every type');
  await app.store.patchConfig({ theme: { accent: '#00D1FF' } });
  const themed = app.healthy.themes().at(-1).alertPreviews;
  for (const type of Object.keys(initial)) assert.notEqual(themed[type].version, css[type].version, 'saved theme refreshes every type');
  await app.store.patchConfig({ alerts: { follow: { media: 'synthetic-preview.webm' } } });
  const media = app.healthy.themes().at(-1).alertPreviews;
  assert.equal(media.follow.media, 'synthetic-preview.webm', 'media stamp uses the saved filename, not the UI draft');
  assert.notEqual(media.follow.version, themed.follow.version);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/state`, { signal: AbortSignal.timeout(6000) });
  assert.equal(response.ok, true);
  assert.deepEqual((await response.json()).alertPreviews, media, 'boot/reconnect and SSE use the same confirmed projection');
});

test('slow panel retains a complete latest thumbnail projection without changing other clients theme payloads', async t => {
  const app = await fixture(t);
  const slowTheme = sink(true, 'theme');
  app.bus.addClient(slowTheme, 'panel');
  app.store.emit('change', { alerts: true });
  assert.ok(slowTheme.themes()[0]?.alertPreviews, 'first confirmed projection is held by backpressure');
  await app.store.patchConfig(alertsPatch);
  await app.store.patchConfig({ overlay: { css: '/* saved common CSS */' }, theme: { accent: '#00D1FF' } });
  assert.equal(slowTheme.themes().length, 1);
  slowTheme.emit('drain');
  assert.equal(slowTheme.themes().length, 2, 'one retained theme snapshot after drain');
  assert.deepEqual(slowTheme.themes().at(-1), app.healthy.themes().at(-1));
  assert.equal(Object.keys(slowTheme.themes().at(-1).alertPreviews).length, Object.keys(app.store.config.alerts).length);
  for (const res of app.outsiders) for (const theme of res.themes()) {
    assert.equal(Object.hasOwn(theme, 'alertPreviews'), false, 'thumbnail metadata is panel-only');
  }
});
