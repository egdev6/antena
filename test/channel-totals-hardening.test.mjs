// Hardening probes for #132 channel totals, adopted from the independent verification:
// persistence, shutdown flush, halt, corrupt files, credentials, malformed counts and live events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChannelTotals } from '../src/channel-totals.mjs';
// startServer() reads ANTENA_DATA/ANTENA_MEDIA at import: point them at a temp dir FIRST so these
// probes never write the repository's real data/.
process.env.ANTENA_DATA = await mkdtemp(path.join(tmpdir(), 'totals-132-data-'));
process.env.ANTENA_MEDIA = path.join(process.env.ANTENA_DATA, 'media');
const { createApp, startServer } = await import('../src/server.mjs');
const dir = () => mkdtemp(path.join(tmpdir(), 'independent-132-'));
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = b => createHash('sha256').update(b).digest('hex');

test('S1/S8: queued writes persist every accepted correction across restart and failures', async () => {
  const d = await dir(); let failed = false;
  const t = await new ChannelTotals({ dir: d, readers: { 'follows@twitch': async () => { if (failed) throw Error('offline'); return 100; } } }).load();
  await t.poll(); for (let i = 0; i < 50; i++) t.adjust('follows@twitch', 1);
  await t.flush(); failed = true; await t.poll(); await t.flush();
  const saved = JSON.parse(await readFile(t.file, 'utf8'));
  const restored = await new ChannelTotals({ dir: d, readers: {} }).load();
  assert.equal(saved.offsets['follows@twitch'], 50); assert.equal(restored.value('follows@twitch'), 150);
});

test('S3: timer and reconnect refresh serialize behind a slow poll', async () => {
  const g = gate(); let count = 0, active = 0, max = 0;
  const t = await new ChannelTotals({ dir: await dir(), initialDelayMs: 0, pollMs: 10000, readers: { 'follows@twitch': async () => {
    count++; active++; max = Math.max(max, active); if (count === 1) await g.promise; active--; return count;
  } } }).load();
  const first = t.poll(); await sleep(0); const second = t.refresh('twitch'); t.start(); await sleep(20); t.stop();
  g.release(); await Promise.all([first, second]); await t.busy; await t.flush();
  assert.equal(max, 1); assert.equal(count, 3); assert.equal(t.value('follows@twitch'), 3);
});

test('S3: halt prevents a poll already queued behind an in-flight poll from starting', async () => {
  const g = gate(); let calls = 0;
  const t = await new ChannelTotals({ dir: await dir(), readers: { 'follows@twitch': async () => { calls++; await g.promise; return 10; } } }).load();
  const first = t.poll(); await sleep(0); const queued = t.refresh('twitch'); t.halt(); g.release();
  await Promise.all([first, queued]); await t.flush(); assert.equal(calls, 1);
});

test('S1/S7: failed poll does not overwrite corrupt persisted totals and offsets', async () => {
  const d = await dir(), file = path.join(d, 'channel-totals.json');
  await writeFile(file, '{"version":1,"totals":{"follows@twitch":{"value":42}},"offsets":{"follows@twitch":-1');
  const before = hash(await readFile(file));
  const t = await new ChannelTotals({ dir: d, readers: { 'follows@twitch': async () => { throw Error('offline'); } } }).load();
  await t.poll(); await t.flush(); const after = hash(await readFile(file)); assert.equal(after, before);
});

test('S5: configured YouTube channel without credentials is unavailable, not an error', async () => {
  let calls = 0; const youtube = { cfg: { channelId: 'UCexample', apiKey: '' }, token: null, api: async () => { calls++; throw Error('no credentials'); } };
  const t = await new ChannelTotals({ dir: await dir(), twitch: {}, youtube }).load(); await t.poll();
  assert.equal(calls, 0); assert.equal(t.snapshot()['subscribers@youtube'].error, null);
});

test('S5/S7: malformed null counts cannot replace valid last-known counts with zero', async () => {
  let invalid = false;
  const twitch = { userId: '42', token: { access: 'x' }, helix: async () => ({ ok: true, data: { total: invalid ? null : 42 } }) };
  const youtube = { cfg: { channelId: 'UCexample', apiKey: 'x' }, api: async () => ({ items: [{ statistics: { subscriberCount: invalid ? null : '90' } }] }) };
  const t = await new ChannelTotals({ dir: await dir(), twitch, youtube }).load(); await t.poll(); invalid = true; await t.poll(); await t.flush();
  assert.deepEqual([t.value('follows@twitch'), t.value('subs@twitch'), t.value('subscribers@youtube')], [42, 42, 90]);
});

test('S3: real live event received while a previous platform snapshot is in flight is not lost', async () => {
  const g = gate(); let delayed = false;
  const t = await new ChannelTotals({ dir: await dir(), readers: { 'follows@twitch': async () => { if (delayed) await g.promise; return 100; } } }).load();
  await t.poll(); delayed = true; const pending = t.poll(); await sleep(0); t.onEvent({ type: 'follow', vars: { user: 'u' } });
  assert.equal(t.value('follows@twitch'), 101); g.release(); await pending; await t.flush(); assert.equal(t.value('follows@twitch'), 101);
});

test('S3: server reconnect transitions and real gift notifications feed totals once', async () => {
  const d = await dir(), app = await createApp({ dataDir: d, mediaDir: path.join(d, 'media'), log: () => {} });
  const t = app.channelTotals; const refreshes = []; t.refresh = async p => { refreshes.push(p); };
  app.twitch.setStatus({ state: 'conectado' }); app.twitch.setStatus({ state: 'conectado' }); app.twitch.setStatus({ state: 'desconectado' }); app.twitch.setStatus({ state: 'conectado' });
  app.youtube.setStatus({ state: 'escuchando' }); app.youtube.setStatus({ state: 'escuchando' }); app.youtube.setStatus({ account: 'canal B' }); app.youtube.setStatus({ account: 'canal B' });
  assert.deepEqual(refreshes, ['twitch', 'twitch', 'youtube', 'youtube']);
  t.readers = { 'follows@twitch': async () => 100, 'subs@twitch': async () => 10 }; await t.poll();
  app.twitch.emitEvent('1', 'channel.follow', { user_name: 'Ana' }); app.twitch.emitEvent('1', 'channel.follow', { user_name: 'Ana' });
  app.twitch.emitEvent('2', 'channel.subscribe', { is_gift: true, user_name: 'Regalo' });
  app.twitch.emitEvent('3', 'channel.subscription.gift', { user_name: 'Ana', total: 5 });
  app.twitch.emitEvent('4', 'channel.subscription.message', { user_name: 'Ana' });
  assert.equal(t.value('follows@twitch'), 101); assert.equal(t.value('subs@twitch'), 15);
  await app.session.startNew('nuevo'); assert.equal(t.value('follows@twitch'), 101); await t.flush(); await app.session.flush();
});

test('S3: disabling an alert does not suppress the real live follower complement', async () => {
  const d = await dir(), app = await createApp({ dataDir: d, mediaDir: path.join(d, 'media'), log: () => {} });
  const t = app.channelTotals; t.readers = { 'follows@twitch': async () => 100 }; await t.poll();
  app.store.config.alerts.follow.enabled = false; app.twitch.emitEvent('live', 'channel.follow', { user_name: 'Ana' });
  await t.flush(); assert.equal(t.value('follows@twitch'), 101);
});

test('S1/S8: server shutdown waits for pending channel-total persistence', async () => {
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r)); process.env.PORT = String(port);
  const app = await startServer({ log: () => {}, quiet: true, handleSignals: false, shutdownTimeoutMs: 3000 });
  const t = app.channelTotals; t.readers = { 'follows@twitch': async () => 10 }; await t.poll(); await t.flush();
  const g = gate(); t.writing = g.promise; t.adjust('follows@twitch', 1);
  const result = await Promise.race([app.close().then(code => `closed:${code}`), sleep(500).then(() => 'pending')]);
  const onDisk = JSON.parse(await readFile(t.file, 'utf8')); g.release(); await t.flush(); await app.close();
  assert.equal(onDisk.offsets['follows@twitch'], undefined); assert.equal(result, 'pending');
});

test('S3: a duplicate delivery refreshes recency, so a late redelivery still counts once', async () => {
  const t = await new ChannelTotals({ dir: await dir(), readers: { 'follows@twitch': async () => 100 } }).load();
  await t.poll();
  t.onEvent({ externalId: 'A', type: 'follow', vars: {} });
  for (let i = 0; i < 999; i++) t.onEvent({ externalId: `x${i}`, type: 'cheer', vars: {} });
  t.onEvent({ externalId: 'A', type: 'follow', vars: {} });
  t.onEvent({ externalId: 'C', type: 'cheer', vars: {} });
  t.onEvent({ externalId: 'A', type: 'follow', vars: {} });
  assert.equal(t.value('follows@twitch'), 101);
});

test('S3: a live event during the very first read is added to its result', async () => {
  const g = gate();
  const t = await new ChannelTotals({ dir: await dir(), readers: { 'follows@twitch': async () => { await g.promise; return 100; } } }).load();
  const first = t.poll(); await sleep(0);
  t.onEvent({ type: 'follow', vars: {} });
  assert.equal(t.value('follows@twitch'), null);
  g.release(); await first;
  assert.equal(t.value('follows@twitch'), 101);
});

test('S1/S7: an unreadable totals file does not stop antena; totals stay in memory and the file is never written', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const { chmod } = await import('node:fs/promises');
  const d = await dir(), file = path.join(d, 'channel-totals.json');
  await writeFile(file, '{"version":1,"offsets":{"follows@twitch":-1}}');
  await chmod(file, 0o000);
  try {
    const app = await createApp({ dataDir: d, mediaDir: path.join(d, 'media'), log: () => {} });
    const t = app.channelTotals;
    assert.match(t.snapshot()['follows@twitch'].error, /No se puede leer/);
    t.readers = { 'follows@twitch': async () => 7 };
    await t.poll(); t.adjust('follows@twitch', 1); await t.flush();
    assert.equal(t.value('follows@twitch'), 8);
    await chmod(file, 0o600);
    assert.equal(await readFile(file, 'utf8'), '{"version":1,"offsets":{"follows@twitch":-1}}');
    await app.session.flush();
  } finally { await chmod(file, 0o600); }
});
