// Offline followers (#128): synthetic platform responses and isolated temporary data only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChannelTotals } from '../src/channel-totals.mjs';
import { Twitch } from '../src/twitch.mjs';
import { FollowerRegistry } from '../src/followers.mjs';
import { writeJson } from '../src/json-file.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'followers-128-'));
process.env.ANTENA_DATA = path.join(root, 'server-data');
process.env.ANTENA_MEDIA = path.join(root, 'server-media');
const { createApp, startServer } = await import('../src/server.mjs');
after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const dir = () => mkdtemp(path.join(root, 'case-'));
const file = d => path.join(d, 'followers.json');
const clock = () => {
  let time = Date.parse('2026-01-01T00:00:00.000Z');
  return { now: () => time, advance: () => { time += 60_000; }, iso: () => new Date(time).toISOString() };
};
const follow = (id, name, at) => ({ user_id: id, user_name: name, followed_at: at });
const subscriber = (id, name) => ({ subscriberSnippet: { channelId: id, title: name } });
const make = async (d, options = {}) => new FollowerRegistry({ dir: d, ...options }).load();
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function httpApp(d) {
  const app = await createApp({ dataDir: d, mediaDir: path.join(d, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, body) => {
    const res = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { app, request };
}

async function serverPort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('S1/S2/S5: first Twitch and YouTube syncs establish silent baselines', async () => {
  const c = clock(), calls = [];
  const twitch = { userId: '42', token: { access: 'x' }, helix: async (...args) => {
    calls.push(args); return { ok: true, data: { data: [follow('old-t', 'Old Twitch', '2025-12-31T23:00:00.000Z')] } };
  } };
  const youtube = { token: { access: 'x' }, api: async (...args) => {
    calls.push(args); return { items: [subscriber('old-y', 'Old YouTube')] };
  } };
  const channelTotals = { totals: { 'subscribers@youtube': { value: 100, live: 5 } }, offsets: { 'subscribers@youtube': 9 } };
  const r = await make(await dir(), { twitch, youtube, channelTotals, now: c.now });
  await r.sync('twitch'); await r.sync('youtube'); await r.flush();
  assert.deepEqual(r.list().entries, []); assert.deepEqual(r.list().anonymous, []);
  assert.equal(r.snapshot().twitch.lastSync, c.iso()); assert.equal(r.snapshot().youtube.lastSync, c.iso());
  assert.equal(r.snapshot().youtube.status, 'ok');
  assert.deepEqual(calls, [
    ['GET', '/channels/followers?broadcaster_id=42&first=100'],
    ['/subscriptions', { part: 'subscriberSnippet', myRecentSubscribers: 'true', maxResults: 50 }, { auth: true }],
  ]);
  const restored = await make(path.dirname(r.file), { twitch, youtube, channelTotals, now: c.now });
  c.advance(); await restored.sync('youtube');
  assert.deepEqual(restored.list().entries, []); assert.deepEqual(restored.list().anonymous, []);
});

test('S2: Twitch follows cursors, stops at lastSync including equality, and caps at ten pages', async () => {
  const c = clock(), calls = []; let phase = 0;
  const twitch = { userId: 'a b', token: { access: 'x' }, helix: async (_method, url) => {
    calls.push(url);
    if (!phase) return { ok: true, data: { data: [] } };
    if (url.includes('after=next')) return { ok: true, data: { data: [
      follow('two', 'Two', '2026-01-01T00:00:01.000Z'), follow('boundary', 'Boundary', '2026-01-01T00:00:00.000Z'),
    ], pagination: { cursor: 'should-not-read' } } };
    return { ok: true, data: { data: [follow('one', 'One', '2026-01-01T00:00:02.000Z')], pagination: { cursor: 'next' } } };
  } };
  const r = await make(await dir(), { twitch, now: c.now });
  await r.sync('twitch'); phase = 1; c.advance(); await r.sync('twitch');
  assert.deepEqual(calls, [
    '/channels/followers?broadcaster_id=a%20b&first=100',
    '/channels/followers?broadcaster_id=a%20b&first=100',
    '/channels/followers?broadcaster_id=a%20b&first=100&after=next',
  ]);
  assert.deepEqual(r.list().entries.map(e => [e.id, e.name, e.followedAt, e.source, e.thanked]), [
    ['one', 'One', '2026-01-01T00:00:02.000Z', 'offline', false],
    ['two', 'Two', '2026-01-01T00:00:01.000Z', 'offline', false],
  ]);
  let pages = 0;
  twitch.helix = async () => ({ ok: true, data: { data: [], pagination: { cursor: String(++pages) } } });
  await r.sync('twitch'); assert.equal(pages, 10);
});

test('S2/S6: YouTube follows nextPageToken with auth, caps four pages and only reports unseen ids', async () => {
  const c = clock(), calls = []; let phase = 0;
  const youtube = { token: { access: 'x' }, api: async (url, params, options) => {
    calls.push([url, params, options]);
    if (!phase) return params.pageToken ? { items: [subscriber('old-2', 'Old Two')] } : { items: [subscriber('old-1', 'Old One')], nextPageToken: 'next' };
    return { items: [subscriber('new', 'New'), subscriber('old-2', 'Old Two')], nextPageToken: 'same' };
  } };
  const channelTotals = { totals: { 'subscribers@youtube': { value: 3 } } };
  const r = await make(await dir(), { youtube, channelTotals, now: c.now });
  await r.sync('youtube'); assert.equal(calls.length, 2); assert.equal(calls[1][1].pageToken, 'next');
  phase = 1; c.advance(); channelTotals.totals['subscribers@youtube'].value = 4;
  await r.sync('youtube'); assert.equal(calls.length, 6);
  for (const [url, params, opts] of calls) {
    assert.equal(url, '/subscriptions'); assert.equal(params.part, 'subscriberSnippet');
    assert.equal(params.myRecentSubscribers, 'true'); assert.equal(params.maxResults, 50); assert.deepEqual(opts, { auth: true });
  }
  assert.deepEqual(r.list().entries.map(e => [e.id, e.name, e.source]), [['new', 'New', 'offline']]);
});

test('S6: anonymous count is max(0, raw growth minus named new); drops never delete records', async () => {
  const c = clock(); let raw = 100, items = [subscriber('old', 'Old')];
  const youtube = { token: { access: 'x' }, api: async () => ({ items }) };
  const channelTotals = await new ChannelTotals({ dir: await dir(), readers: { 'subscribers@youtube': async () => raw } }).load();
  await channelTotals.poll(); channelTotals.adjust('subscribers@youtube', 50);
  channelTotals.totals['subscribers@youtube'].live = 17;
  const r = await make(await dir(), { youtube, channelTotals, now: c.now });
  await r.sync('youtube'); raw = 105; await channelTotals.poll(); c.advance();
  items = [subscriber('a', 'A'), subscriber('b', 'B'), subscriber('old', 'Old')];
  await r.sync('youtube');
  assert.deepEqual(r.list().entries.map(e => e.id), ['a', 'b']);
  assert.deepEqual(r.list().anonymous, [{ at: c.iso(), count: 3, thanked: false }]);
  raw = 90; await channelTotals.poll(); c.advance(); items = [subscriber('a', 'A')]; await r.sync('youtube');
  assert.deepEqual(r.list().entries.map(e => e.id), ['a', 'b']);
  assert.deepEqual(r.list().anonymous.map(e => e.count), [3]);
  await channelTotals.flush(); await r.flush();
});

test('S6: unknown previous or current YouTube total does not invent anonymous followers', async () => {
  const c = clock(), totals = { totals: {} };
  const youtube = { token: { access: 'x' }, api: async () => ({ items: [] }) };
  const r = await make(await dir(), { youtube, channelTotals: totals, now: c.now });
  await r.sync('youtube'); totals.totals['subscribers@youtube'] = { value: 50 }; c.advance(); await r.sync('youtube');
  delete totals.totals['subscribers@youtube']; c.advance(); await r.sync('youtube');
  totals.totals['subscribers@youtube'] = { value: 70 }; c.advance(); await r.sync('youtube');
  assert.deepEqual(r.list().anonymous, []);
});

test('S2: without an OAuth account YouTube is skipped with needs_account and no error', async () => {
  let calls = 0;
  const youtube = { token: null, cfg: { apiKey: 'public-only' }, api: async () => { calls++; } };
  const r = await make(await dir(), { youtube }); await r.sync('youtube');
  assert.equal(calls, 0); assert.equal(r.snapshot().youtube.status, 'needs_account');
  assert.equal(r.snapshot().youtube.error, null); assert.equal(r.snapshot().youtube.lastSync, null);
  assert.deepEqual(r.list().entries, []); assert.deepEqual(r.list().anonymous, []);
});

test('S2/S4: sync failures do not advance checkpoints or commit partial pages', async () => {
  const c = clock(); let fail = false;
  const twitch = { token: { access: 'x' }, userId: '1', helix: async (_method, url) => {
    if (!fail) return { ok: true, data: { data: [] } };
    if (url.includes('after=')) return { ok: false, status: 500, data: {} };
    return { ok: true, data: { data: [follow('a', 'A', '2026-01-01T00:00:01.000Z')], pagination: { cursor: 'next' } } };
  } };
  const r = await make(await dir(), { twitch, now: c.now }); await r.sync('twitch'); const baseline = r.snapshot().twitch.lastSync;
  fail = true; c.advance(); await r.sync('twitch');
  assert.equal(r.snapshot().twitch.lastSync, baseline); assert.match(r.snapshot().twitch.error, /500/);
  assert.deepEqual(r.list().entries, []);
});

test('S4: live then offline and offline then live deduplicate by id or case-insensitive name', async () => {
  const c = clock(); let rows = [];
  const twitch = { token: { access: 'x' }, userId: '1', helix: async () => ({ ok: true, data: { data: rows } }) };
  const r = await make(await dir(), { twitch, now: c.now }); await r.sync('twitch'); c.advance();
  r.onLiveFollow({ platform: 'twitch', id: 'live-id', name: 'Live', at: c.iso() });
  r.onLiveFollow({ platform: 'twitch', name: 'NoId', at: c.iso() });
  rows = [follow('live-id', 'Renamed', c.iso()), follow('resolved-id', 'noid', c.iso()), follow('offline-id', 'Offline', c.iso())];
  await r.sync('twitch');
  r.onLiveFollow({ platform: 'twitch', id: 'offline-id', name: 'Changed', at: c.iso() });
  r.onLiveFollow({ platform: 'twitch', name: 'OFFLINE', at: c.iso() });
  assert.deepEqual(r.list().entries.map(e => [e.id, e.source, e.thanked]), [
    ['live-id', 'live', false], ['resolved-id', 'live', false], ['offline-id', 'offline', false],
  ]);
});

test('S4: an exact id match takes precedence over an earlier name-only match', async () => {
  const r = await make(await dir());
  r.onLiveFollow({ platform: 'twitch', name: 'Alice' });
  r.onLiveFollow({ platform: 'twitch', id: 'bob-id', name: 'Bob' });
  r.onLiveFollow({ platform: 'twitch', id: 'bob-id', name: 'Alice' });
  assert.deepEqual(r.list().entries.map(e => [e.id, e.name]), [[null, 'Alice'], ['bob-id', 'Bob']]);
  await r.flush();
});

test('S2/S4: a live follow arriving during a sync is deduplicated and retained on halt', async () => {
  const c = clock(), g = gate(); let delayed = false, calls = 0;
  const twitch = { token: { access: 'x' }, userId: '1', helix: async () => {
    calls++; if (delayed) await g.promise;
    return { ok: true, data: { data: delayed ? [follow('same', 'Alice', c.iso())] : [] } };
  } };
  const r = await make(await dir(), { twitch, now: c.now }); await r.sync('twitch'); c.advance();
  delayed = true; const syncing = r.sync('twitch'); await tick();
  r.onLiveFollow({ platform: 'twitch', id: 'same', name: 'Alice', at: c.iso() });
  g.release(); await syncing;
  assert.deepEqual(r.list().entries.map(e => [e.id, e.source]), [['same', 'live']]);
  r.halt(); await r.sync('twitch'); assert.equal(calls, 2);
  r.onLiveFollow({ platform: 'twitch', id: 'late', name: 'Late', at: c.iso() });
  await r.flush();
  assert.deepEqual((await make(path.dirname(r.file))).list().entries.map(e => e.id), ['same', 'late']);
});

test('S1/S5: persistence survives restart, including thank flags and anonymous records', async () => {
  const d = await dir(), c = clock(); let rows = [], total = 10;
  const youtube = { token: { access: 'x' }, api: async () => ({ items: rows }) };
  const totals = { totals: { 'subscribers@youtube': { value: total } } };
  const r = await make(d, { youtube, channelTotals: totals, now: c.now }); await r.sync('youtube');
  c.advance(); rows = [subscriber('new', 'New')]; totals.totals['subscribers@youtube'].value = total += 3;
  await r.sync('youtube'); r.markThanked(['new']); await r.flush();
  const restored = await make(d, { youtube, channelTotals: totals, now: c.now });
  assert.equal(restored.list().entries[0].thanked, true);
  assert.deepEqual(restored.list().anonymous, [{ at: c.iso(), count: 2, thanked: false }]);
  assert.equal(restored.list({ pending: true }).entries.length, 0);
  restored.markThanked('all'); await restored.flush();
  assert.deepEqual(restored.list({ pending: true }).anonymous, []);
  const again = await make(d, { youtube, channelTotals: totals, now: c.now });
  assert.equal(again.list().anonymous[0].thanked, true);
});

test('S1: corrupt registry is copied aside before a replacement; unreadable registry is read-only', async () => {
  const d = await dir(), broken = '{"platforms":'; await writeFile(file(d), broken);
  const r = await make(d); const backups = (await readdir(d)).filter(x => x.startsWith('followers.json.corrupt-'));
  assert.equal(backups.length, 1); assert.equal(await readFile(path.join(d, backups[0]), 'utf8'), broken);
  r.onLiveFollow({ platform: 'twitch', id: 'x', name: 'X', at: '2026-01-01T00:00:00.000Z' }); await r.flush();
  assert.equal((await make(d)).list().entries[0].id, 'x');
  const unreadable = await dir(); await mkdir(file(unreadable));
  const locked = await make(unreadable);
  assert.match(locked.snapshot().twitch.error, /No se puede leer/);
  assert.throws(() => locked.markThanked('all'), e => e.status === 503);
  locked.onLiveFollow({ platform: 'twitch', id: 'x', name: 'X' }); await locked.flush();
  assert.deepEqual(await readdir(file(unreadable)), []);
});

test('S1: structurally corrupt JSON is copied aside instead of silently dropping entries', async () => {
  const d = await dir();
  const broken = JSON.stringify({ version: 1, platforms: { twitch: { lastSync: null, entries: 'lost' }, youtube: {} } });
  await writeFile(file(d), broken);
  const r = await make(d);
  const backups = (await readdir(d)).filter(x => x.startsWith('followers.json.corrupt-'));
  assert.equal(backups.length, 1); assert.equal(await readFile(path.join(d, backups[0]), 'utf8'), broken);
  r.onLiveFollow({ platform: 'twitch', id: 'x', name: 'X' }); await r.flush();
  assert.equal((await make(d)).list().entries[0].id, 'x');
});

test('S1: a failed write stays visible and the next flush retries the latest generation', async () => {
  const d = await dir(); let fail = true;
  const write = async (target, data) => {
    if (fail) { fail = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    await writeJson(target, data);
  };
  const r = await make(d, { write });
  r.onLiveFollow({ platform: 'twitch', id: 'x', name: 'X' });
  await assert.rejects(r.flush()); assert.match(r.snapshot().twitch.error, /guardar/);
  await r.flush(); assert.equal(r.snapshot().twitch.error, null);
  assert.equal((await make(d)).list().entries[0].id, 'x');
});

test('S1/S5: HTTP list and thank reject invalid bodies without touching memory or disk', async t => {
  const d = await dir(), { app, request } = await httpApp(d); t.after(() => app.closeHttp());
  app.followers.onLiveFollow({ platform: 'twitch', id: '1', name: 'One' });
  app.followers.onLiveFollow({ platform: 'twitch', id: '2', name: 'Two' }); await app.followers.flush();
  const before = await readFile(file(d), 'utf8'); const initial = await request('/api/followers');
  assert.equal(initial.status, 200); assert.equal(initial.body.entries.length, 2);
  assert.ok(initial.body.platforms.twitch); assert.ok(initial.body.platforms.youtube);
  for (const body of [null, [], {}, { ids: '1' }, { ids: ['1', 2] }, { all: false }, { all: true, ids: ['1'] }]) {
    const invalid = await request('/api/followers/thank', body);
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { error: 'Indica «ids» como lista de identificadores o «all»: true.' });
    assert.deepEqual((await request('/api/followers')).body, initial.body);
    assert.equal(await readFile(file(d), 'utf8'), before);
  }
  assert.equal((await request('/api/followers/thank', { ids: ['1'] })).status, 200);
  assert.deepEqual((await request('/api/followers?pending=true')).body.entries.map(e => e.id), ['2']);
  assert.equal((await request('/api/followers/thank', { all: true })).status, 200);
  assert.equal((await request('/api/followers?pending=true')).body.entries.length, 0);
  await app.followers.flush();
});

test('S1: HTTP thank returns 503 when followers.json is unreadable', async t => {
  const d = await dir(); await mkdir(file(d));
  const { app, request } = await httpApp(d); t.after(() => app.closeHttp());
  const res = await request('/api/followers/thank', { all: true });
  assert.equal(res.status, 503); assert.match(res.body.error, /No se puede leer/);
  assert.deepEqual(res.body, { error: app.followers.snapshot().twitch.error });
  assert.deepEqual(await readdir(file(d)), []);
});

test('S3/S4: recovered followers never reach the alert engine; real live follows still do', async t => {
  const d = await dir(), { app, request } = await httpApp(d); t.after(() => app.closeHttp());
  const calls = []; app.engine.handleEvent = e => calls.push(e);
  app.twitch.userId = 'channel'; app.store.secrets.twitch = { access: 'fixture' };
  let rows = [];
  app.twitch.helix = async () => ({ ok: true, data: { data: rows } });
  const c = clock(); app.followers.now = c.now;
  await app.followers.sync('twitch'); c.advance();
  rows = [follow('recovered', 'Recovered', c.iso())]; await app.followers.sync('twitch');
  assert.deepEqual(calls, []); assert.equal((await request('/api/followers')).body.entries[0].source, 'offline');
  app.twitch.emitEvent('live', 'channel.follow', { user_id: 'live', user_name: 'Live', followed_at: c.iso() });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].vars, { user: 'Live' });
  assert.deepEqual((await request('/api/followers')).body.entries.map(e => e.id), ['recovered', 'live']);
  await app.followers.flush();
});

test('PRESERVE: Twitch follow alert vars and non-follow emitted event shape remain unchanged', () => {
  const twitch = new Twitch({ config: { twitch: {} }, secrets: {} }, () => {}); const events = [];
  twitch.on('event', e => events.push(e));
  twitch.emitEvent('1', 'channel.follow', { user_id: '123', user_name: 'Alice', followed_at: '2026-01-01T00:00:00Z' });
  twitch.emitEvent('2', 'channel.subscribe', { user_name: 'Bob', tier: '1000', is_gift: false });
  assert.deepEqual(events[0].vars, { user: 'Alice' });
  assert.deepEqual(events[1], { externalId: 'tw:2', type: 'sub', vars: { user: 'Bob', tier: 1 } });
});

test('S2: reconnect transitions refresh totals first and synchronize each platform once', async t => {
  const d = await dir(), { app } = await httpApp(d); t.after(() => app.closeHttp());
  const calls = []; app.channelTotals.refresh = async p => { calls.push('total:' + p); };
  app.followers.sync = async p => { calls.push('sync:' + p); };
  app.twitch.setStatus({ state: 'conectado' }); app.twitch.setStatus({ state: 'conectado' });
  app.youtube.setStatus({ account: 'channel' }); app.youtube.setStatus({ account: 'channel' });
  await tick();
  assert.deepEqual(calls, ['total:twitch', 'total:youtube', 'sync:twitch', 'sync:youtube']);
});

test('S1/S2: startServer schedules both platform syncs and shutdown waits for accepted writes', async t => {
  const originalRefresh = ChannelTotals.prototype.refresh, originalSync = FollowerRegistry.prototype.sync;
  const calls = [];
  ChannelTotals.prototype.refresh = async function (p) { calls.push('total:' + p); };
  FollowerRegistry.prototype.sync = async function (p) { calls.push('sync:' + p); };
  process.env.PORT = String(await serverPort());
  t.after(() => { ChannelTotals.prototype.refresh = originalRefresh; FollowerRegistry.prototype.sync = originalSync; });
  const app = await startServer({ quiet: true, log: () => {}, handleSignals: false, shutdownTimeoutMs: 3000 });
  t.after(() => app.close()); await tick();
  assert.deepEqual(calls, ['total:twitch', 'total:youtube', 'sync:twitch', 'sync:youtube']);
  const g = gate(); app.followers.writing = g.promise;
  app.followers.onLiveFollow({ platform: 'twitch', id: 'late', name: 'Late' });
  const closing = app.close(); let closed = false; closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); g.release();
  assert.equal(await closing, 0);
  const restored = await make(process.env.ANTENA_DATA);
  assert.equal(restored.list().entries[0].id, 'late');
});
