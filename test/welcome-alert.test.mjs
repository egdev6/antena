// Welcome alerts (#289): synthetic chat producers and the public HTTP interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { youtubeChatMessage } from '../src/alerts.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label) {
  for (let n = 0; n < 100; n++) {
    const value = await read();
    if (check(value)) return value;
    await pause(10);
  }
  assert.fail(label);
}
async function fixture(t, archives = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-welcome-test-'));
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  for (const archive of archives) await writeFile(path.join(dataDir, 'sessions', `${archive.id}.json`), JSON.stringify(archive));
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  t.after(async () => {
    app.viewers.halt(); app.followers.halt(); app.channelTotals.halt();
    await app.youtube.quiescePoll().catch(() => {}); await app.chat.quiesceChat().catch(() => {});
    await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
    await app.session.flush().catch(() => {}); await app.closeHttp().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(method, url, body) {
    const r = await fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  }
  async function get(url) { const r = await request('GET', url); assert.equal(r.status, 200); return r.body; }
  async function post(url, body = {}) { const r = await request('POST', url, body); assert.equal(r.status, 200); return r.body; }
  const history = async () => (await get('/api/history')).filter(x => x.type === 'welcome');
  let serial = 0;
  async function start() {
    app.twitch.userId = 'streamer-id';
    app.meld.setStatus({ state: 'conectado', streaming: true });
    await app.session.transitionChain;
    app.youtube.setStatus({ state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1', title: 'Synthetic' });
    await app.session.transitionChain;
  }
  async function message(platform, authorId, user, extra = {}) {
    const id = `m${++serial}`;
    if (platform === 'twitch') {
      app.chat.emit('message', { id: 'tw:' + id, platform, authorId, roomId: 'streamer-id', user, login: user.toLowerCase(), text: 'hola', ...extra });
    } else {
      const msg = youtubeChatMessage({ id, snippet: { type: 'textMessageEvent', displayMessage: 'hola' }, authorDetails: { channelId: authorId, displayName: user } });
      app.youtube.emit('chat', { ...msg, ...extra }, { target: app.session.captureIdentity(), videoId: 'video-1', liveChatId: 'chat-1' });
    }
    await app.session.transitionChain;
  }
  return { app, base, request, get, post, history, start, message };
}
const archive = (id, date, platform, authorIds) => ({ id, title: id, startedAt: `${date}T10:00:00.000Z`, endedAt: `${date}T11:00:00.000Z`, events: [],
  chatStats: { [platform]: { authorIds, minutes: [{ at: `${date}T10:00:00.000Z`, messages: authorIds.length }] } } });

// These tests exercise the real producer → engine → HTTP history/timeline path, not internal storage.
test('S1/S2: first chat per platform/id alerts once, commands count and the next session alerts again', async t => {
  const f = await fixture(t); await f.start();
  const before = await f.get('/api/session');
  await f.message('twitch', 'id-1', 'Ana', { text: '!hola' });
  let h = await until(f.history, a => a.length === 1, 'first Twitch welcome missing');
  assert.equal(h[0].text, 'Primera vez de Ana hoy');
  await f.message('twitch', 'id-1', 'AnaRenombrada');
  await f.message('youtube', 'id-1', 'Bea');
  h = await until(f.history, a => a.length === 2, 'YouTube identity needs its own welcome');
  assert.deepEqual(h.map(a => a.text), ['Primera vez de Bea hoy', 'Primera vez de Ana hoy']);
  await pause(80); assert.equal((await f.history()).length, 2);
  const chat = await f.get('/api/chat');
  assert.equal(chat.length, 3); assert.equal(chat[0].command, true);
  assert.ok(chat.every(m => !('authorId' in m) && !('roomId' in m)));
  const events = await f.get('/api/session/events');
  assert.equal(events.total, 2); assert.ok(events.items.every(e => e.type === 'welcome' && !JSON.stringify(e).includes('id-1')));
  const timeline = await f.get('/api/timeline'); assert.equal(timeline.items.filter(e => e.type === 'welcome').length, 2);
  assert.deepEqual((await f.get('/api/session')).totals, before.totals, 'welcome is not a support event');
  f.app.meld.setStatus({ streaming: false }); await f.app.session.transitionChain;
  f.app.meld.setStatus({ streaming: true }); await f.app.session.transitionChain;
  await f.message('twitch', 'id-1', 'Ana');
  h = await until(f.history, a => a.length === 3, 'welcome missing in the next session');
  assert.equal(h[0].text, '¡Ana, qué bueno verte de nuevo!');
});

test('S1: disabling automatic sessions during an open session does not disable welcome', async t => {
  const f = await fixture(t); await f.start();
  const result = await f.request('PUT', '/api/config', { program: { autoSession: false } });
  assert.equal(result.status, 200);
  await f.message('twitch', 'manual-author', 'Manu');
  const h = await until(f.history, rows => rows.length === 1, 'welcome must not depend on automatic session metrics');
  assert.equal(h[0].text, 'Primera vez de Manu hoy');
  assert.equal((await f.get('/api/session/events')).total, 1);
});

test('S2: archived chatStats determine returning separately for Twitch and YouTube', async t => {
  const f = await fixture(t, [archive('old-one', '2024-01-01', 'twitch', ['return-id']), archive('old-two', '2024-02-01', 'youtube', ['yt-return'])]);
  await f.start();
  await f.message('twitch', 'return-id', 'Ana');
  let h = await until(f.history, a => a.length === 1, 'returning Twitch welcome missing');
  assert.equal(h[0].text, '¡Ana, qué bueno verte de nuevo!');
  await f.message('youtube', 'return-id', 'Bea');
  h = await until(f.history, a => a.length === 2, 'new YouTube welcome missing');
  assert.equal(h[0].text, 'Primera vez de Bea hoy');
  await f.message('youtube', 'yt-return', 'Cris');
  h = await until(f.history, a => a.length === 3, 'returning YouTube welcome missing');
  assert.equal(h[0].text, '¡Cris, qué bueno verte de nuevo!');
});

test('S7: owner, blocked users and disabled welcome never create an alert or alter alert records', async t => {
  const f = await fixture(t); await f.start();
  assert.equal((await f.request('PUT', '/api/config', { filters: { blockedUsers: ['bot'] } })).status, 200);
  await f.message('twitch', 'streamer-id', 'Owner');
  await f.message('youtube', 'owner-yt', 'OwnerYT', { owner: true });
  await f.message('twitch', 'bot-id', 'Bot');
  await pause(80); assert.deepEqual(await f.history(), []);
  assert.equal((await f.get('/api/session/events')).total, 0);
  const off = await f.request('PUT', '/api/alerts/welcome', { enabled: false }); assert.equal(off.status, 200);
  const before = await f.get('/api/alerts/welcome');
  await f.message('twitch', 'viewer-id', 'Viewer');
  await f.message('youtube', 'viewer-yt', 'ViewerYT');
  await pause(80);
  assert.deepEqual(await f.history(), []); assert.equal((await f.get('/api/session/events')).total, 0);
  assert.deepEqual(await f.get('/api/alerts/welcome'), before);
  const chat = await f.get('/api/chat'); assert.equal(chat.length, 4); // owners and viewers, never blocked bot
});

test('S7: catalog, editable variation, preview, simulation and timeline use the standard alert interface', async t => {
  const f = await fixture(t); const state = await f.get('/api/state');
  assert.deepEqual(state.types.welcome, { platform: 'egdev', icon: 'smile', label: 'Bienvenida', system: true });
  assert.equal(state.config.alerts.welcome.enabled, true);
  const defaultVariation = state.config.alerts.welcome.variations.find(v => v.conditions.returning === 'true');
  assert.ok(defaultVariation);
  const changed = await f.request('PUT', `/api/alerts/welcome/variations/${defaultVariation.id}`, { overrides: { title: 'Hola', text: 'Vuelve {user}', sub: 'Bien', ttsEnabled: true, ttsTemplate: 'Hola {user}' } });
  assert.equal(changed.status, 200);
  const preview = await f.post('/api/test', { type: 'welcome', variationId: defaultVariation.id, vars: { user: 'Ana' }, target: 'preview' });
  assert.deepEqual([preview.alert.title, preview.alert.text, preview.alert.sub, preview.alert.tts], ['Hola', 'Vuelve Ana', 'Bien', 'Hola Ana']);
  assert.deepEqual(await f.history(), []); assert.equal((await f.get('/api/session/events')).total, 0);
  const simulation = await f.post('/api/simulate', { type: 'welcome', vars: { user: 'Ana', returning: true } });
  assert.equal(simulation.ok, true); assert.equal(simulation.alert.text, 'Vuelve Ana');
  assert.equal((await f.history())[0].text, 'Vuelve Ana');
  assert.equal((await f.get('/api/timeline')).items[0].type, 'welcome');
});

test('S1: at most five queued welcomes survive a burst, without replaying skipped first messages', async t => {
  const f = await fixture(t); await f.start(); await f.post('/api/pause');
  for (let i = 0; i < 5; i++) await f.message('twitch', `user-${i}`, `User${i}`);
  await until(f.history, a => a.length === 5, 'five welcomes should be admitted');
  await f.message('twitch', 'overflow', 'Overflow'); await pause(80);
  assert.equal((await f.history()).length, 5); assert.equal((await f.get('/api/session/events')).total, 5);
  assert.equal((await f.get('/api/chat')).length, 6);
  await f.post('/api/resume', { discard: true });
  await f.message('twitch', 'overflow', 'Overflow'); await pause(80);
  assert.equal((await f.history()).length, 5);
});

test('S1: disconnected overlays do not leave a phantom queue that suppresses later welcomes', async t => {
  const f = await fixture(t); await f.start();
  for (let i = 0; i < 6; i++) await f.message('twitch', `absent-${i}`, `Guest${i}`);
  const h = await until(f.history, a => a.length === 6, 'without an overlay no welcomes are queued');
  assert.equal(h[0].text, 'Primera vez de Guest5 hoy');
  assert.equal((await f.get('/api/session/events')).total, 6);
  const controller = new AbortController();
  try {
    const stream = await fetch(f.base + '/api/stream?client=overlay', { signal: controller.signal });
    assert.equal(stream.status, 200);
    await f.message('twitch', 'after-connect', 'AfterConnect');
    const connected = await until(f.history, a => a.length === 7, 'the connected overlay must not inherit phantom welcomes');
    assert.equal(connected[0].text, 'Primera vez de AfterConnect hoy');
  } finally { controller.abort(); }
});

test('S7: invalid welcome configuration is rejected without changing saved settings or counters', async t => {
  const f = await fixture(t);
  const before = await f.get('/api/alerts/welcome'), counters = (await f.get('/api/status')).persistence;
  const result = await f.request('PUT', '/api/config', { alerts: { welcome: { enabled: 'false' } } });
  assert.deepEqual(result, { status: 400, body: { error: 'alerts.welcome.enabled: se esperaba true o false' } });
  assert.deepEqual(await f.get('/api/alerts/welcome'), before);
  assert.deepEqual((await f.get('/api/status')).persistence, counters);
  const invalidCondition = await f.request('PUT', '/api/config', { alerts: { welcome: { variations: [{ id: 'v', conditions: { returning: 'never' } }] } } });
  assert.deepEqual(invalidCondition, { status: 400, body: { error: 'alerts.welcome.variations.0.conditions.returning: se esperaba uno de: , true, false' } });
  assert.deepEqual(await f.get('/api/alerts/welcome'), before);
  assert.deepEqual((await f.get('/api/status')).persistence, counters);
  assert.equal((await f.get('/api/session/events')).total, 0);
});

test('S2: the shared history helper returns matching archives oldest-first without IDs of authors', async t => {
  const f = await fixture(t, [archive('later', '2024-02-01', 'twitch', ['private-author']), archive('earlier', '2024-01-01', 'twitch', ['private-author']), archive('youtube', '2024-03-01', 'youtube', ['private-author'])]);
  const { pastSessionsForAuthor } = await import('../src/welcome.mjs');
  const rows = await pastSessionsForAuthor(f.app.session, 'twitch', 'private-author', await f.get('/api/session'));
  assert.deepEqual(rows.map(row => row.id), ['earlier', 'later']);
  assert.doesNotMatch(JSON.stringify(rows), /private-author/);
});

test('PRESERVE: existing follow simulations still reach history, timeline and metrics', async t => {
  const f = await fixture(t);
  await f.post('/api/alerts/follow/variations', { name: 'Seguimiento', conditions: { returning: 'true' }, overrides: { title: 'Seguimiento' } });
  const result = await f.post('/api/simulate', { type: 'follow', vars: { user: 'Antes', returning: false } });
  assert.equal(result.ok, true); assert.equal(result.alert.text, 'Antes'); assert.equal(result.alert.title, 'Seguimiento');
  assert.equal((await f.get('/api/history'))[0].type, 'follow');
  assert.equal((await f.get('/api/session')).totals.follows, 1);
  assert.equal((await f.get('/api/timeline')).items[0].type, 'follow');
  const follow = await f.get('/api/alerts/follow');
  const variation = { ...follow.config.variations[0], conditions: { returning: 'legacy-value' } };
  const saved = await f.request('PUT', '/api/config', { alerts: { follow: { variations: [variation] } } });
  assert.equal(saved.status, 200, 'an unrelated alert keeps accepting previously unknown fields');
  assert.equal((await f.get('/api/alerts/follow')).config.variations[0].conditions.returning, 'legacy-value');
});

test('history lookups read the archives once per session, not once per new chatter', async () => {
  const { pastSessionsForAuthor } = await import('../src/welcome.mjs');
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T10:00:00Z`, endedAt: `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z` }));
  let reads = 0;
  const session = {
    list: async () => rows,
    get: async id => { reads++; return { chatStats: { twitch: { authorIds: id === 's03' || id === 's07' ? ['ana'] : ['otro'] } } }; },
  };
  const current = { id: 'now', startedAt: '2026-02-01T10:00:00Z' };
  const [ana, bea, again] = await Promise.all([
    pastSessionsForAuthor(session, 'twitch', 'ana', current),
    pastSessionsForAuthor(session, 'twitch', 'bea', current),
    pastSessionsForAuthor(session, 'twitch', 'ana', current),
  ]);
  assert.deepEqual(ana.map(s => s.id), ['s03', 's07'], 'oldest first');
  assert.deepEqual(again, ana);
  assert.deepEqual(bea, []);
  assert.deepEqual(await pastSessionsForAuthor(session, 'youtube', 'ana', current), [], 'per platform');
  assert.equal(reads, 30, 'each archive is read once for the session');
  // a new session builds its own index
  await pastSessionsForAuthor(session, 'twitch', 'ana', { id: 'next', startedAt: '2026-03-01T10:00:00Z' });
  assert.equal(reads, 60);
});

test('S2: missing or non-string author ids never welcome', async t => {
  const f = await fixture(t);
  await f.start();
  for (const id of ['', 123, null]) await f.message('twitch', id, 'X');
  await pause(150);
  assert.deepEqual(await f.history(), []);
});
