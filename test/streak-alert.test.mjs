// Watch streaks (#290): real producers and the public HTTP alert/session interfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { youtubeChatMessage } from '../src/alerts.mjs';
import { Twitch, SCOPES } from '../src/twitch.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, check, label) {
  for (let n = 0; n < 100; n++) {
    const value = await read();
    if (check(value)) return value;
    await pause(10);
  }
  assert.fail(label);
}
const archive = (id, date, platform, authorIds) => ({ id, title: id, startedAt: `${date}T10:00:00.000Z`, endedAt: `${date}T11:00:00.000Z`, events: [],
  chatStats: { [platform]: { authorIds, minutes: authorIds.length ? [{ at: `${date}T10:00:00.000Z`, messages: authorIds.length }] : [] } } });

async function fixture(t, archives = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-streak-test-'));
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  for (const a of archives) await writeFile(path.join(dataDir, 'sessions', `${a.id}.json`), JSON.stringify(a));
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  t.after(async () => {
    app.viewers.halt(); app.followers.halt(); app.channelTotals.halt();
    await app.youtube.quiescePoll().catch(() => {}); await app.chat.quiesceChat().catch(() => {});
    await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
    await app.session.flush().catch(() => {}); await app.closeHttp().catch(() => {});
    await app.twitch.rawLog.flush();
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
  async function start() {
    app.twitch.userId = 'streamer-id';
    app.meld.setStatus({ state: 'conectado', streaming: true });
    await app.session.transitionChain;
    app.youtube.setStatus({ state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1', title: 'Synthetic' });
    await app.session.transitionChain;
  }
  let serial = 0;
  async function message(platform, authorId, user, extra = {}) {
    const id = `m${++serial}`;
    if (platform === 'twitch') app.chat.emit('message', { id: `tw:${id}`, platform, authorId, roomId: 'streamer-id', user, login: user.toLowerCase(), text: 'hola', ...extra });
    else {
      const msg = youtubeChatMessage({ id, snippet: { type: 'textMessageEvent', displayMessage: 'hola' }, authorDetails: { channelId: authorId, displayName: user } });
      app.youtube.emit('chat', { ...msg, ...extra }, { target: app.session.captureIdentity(), videoId: 'video-1', liveChatId: 'chat-1' });
    }
    await app.session.transitionChain;
    await app.settleChatMetrics();
  }
  return { app, request, get, post, start, message, history: () => get('/api/history') };
}

class FakeWebSocket extends EventTarget {
  constructor() { super(); this.readyState = 1; }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('S6: EventSub asks for chat notifications only with user:read:chat; missing scope warns without interrupting other subscriptions', async t => {
  assert.ok(SCOPES.includes('user:read:chat'));
  const original = globalThis.WebSocket; globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const client = new Twitch({ config: { twitch: { clientId: 'client' } }, secrets: { twitch: { access: 'synthetic' } } }, () => {});
  t.after(() => client.stop());
  let scopes = ['user:read:chat'];
  client.validate = async () => ({ user_id: 'streamer-id', login: 'streamer', scopes });
  const calls = [];
  client.helix = async (_method, _path, body) => { calls.push(body); return { ok: true, status: 202, data: {} }; };
  const welcome = { metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'session-1' } } };
  await client.start(); await client.onMessage(client.ws, welcome);
  assert.deepEqual(calls.find(c => c.type === 'channel.chat.notification'), { type: 'channel.chat.notification', version: '1', condition: { broadcaster_user_id: 'streamer-id', user_id: 'streamer-id' }, transport: { method: 'websocket', session_id: 'session-1' } });
  assert.equal(client.status.state, 'conectado'); assert.equal(client.status.streakWarning, null);
  assert.ok(client.status.subscriptions.includes('channel.follow'));
  await client.stop(); calls.length = 0; scopes = [];
  await client.start(); await client.onMessage(client.ws, welcome);
  assert.equal(calls.some(c => c.type === 'channel.chat.notification'), false);
  assert.ok(calls.some(c => c.type === 'channel.follow'));
  assert.ok(client.status.subscriptions.includes('channel.follow'));
  assert.equal(client.status.state, 'conectado'); assert.deepEqual(client.status.errors, []);
  assert.match(client.status.streakWarning, /reconecta Twitch para activar las rachas/i);
  assert.match(client.status.streakWarning, /Volver a conectar/);
  await client.stop(); scopes = ['user:read:chat'];
  await client.start(); await client.onMessage(client.ws, welcome);
  assert.equal(client.status.streakWarning, null);
});

const notice = (id = 'viewer-id', type = 'watch_streak') => ({ broadcaster_user_id: 'streamer-id', chatter_user_id: id, chatter_user_name: 'Ana', chatter_is_anonymous: false,
  notice_type: type, watch_streak: { streak_count: 4, channel_points_awarded: 350 }, message: { text: 'hola chat' } });

test('S6/S7: official watch streak delivers exactly once with its fields; other notices and owner do not alert', async t => {
  const f = await fixture(t); await f.start();
  assert.equal((await f.request('PUT', '/api/alerts/streak', { text: '{user} {platform} {count}', sub: '{channelPointsAwarded} · {message}' })).status, 200);
  const before = await f.get('/api/session');
  f.app.twitch.emitEvent('one', 'channel.chat.notification', notice());
  f.app.twitch.emitEvent('one', 'channel.chat.notification', notice());
  for (const type of ['sub', 'resub', 'sub_gift', 'raid', 'announcement']) f.app.twitch.emitEvent(type, 'channel.chat.notification', notice('other', type));
  f.app.twitch.emitEvent('owner', 'channel.chat.notification', notice('streamer-id'));
  const history = await until(f.history, h => h.length === 1, 'official streak not delivered');
  assert.deepEqual(history.map(h => [h.type, h.text, h.sub]), [['streak', 'Ana twitch 4', '350 · hola chat']]);
  const events = await f.get('/api/session/events'); assert.equal(events.total, 1);
  assert.doesNotMatch(JSON.stringify(events), /viewer-id/);
  assert.equal((await f.get('/api/timeline')).items.filter(x => x.type === 'streak').length, 1);
  assert.deepEqual((await f.get('/api/session')).totals, before.totals);
});

test('S4: consecutive YouTube archives are ordered by start, skip non-YouTube sessions, and replace welcome once', async t => {
  const f = await fixture(t, [archive('z-first', '2024-01-01', 'youtube', ['private-ana']), archive('a-second', '2024-02-01', 'youtube', ['private-ana']), archive('b-twitch', '2024-03-01', 'twitch', ['other'])]);
  await f.start();
  assert.equal((await f.request('PUT', '/api/alerts/streak', { text: '{user} {platform} {count}' })).status, 200);
  const before = await f.get('/api/session');
  await f.message('youtube', 'private-ana', 'Ana');
  let h = await until(f.history, rows => rows.length === 1, 'streak 3 missing');
  assert.deepEqual(h.map(x => [x.type, x.text]), [['streak', 'Ana youtube 3']]);
  await f.message('youtube', 'private-ana', 'Ana');
  h = await f.history(); assert.equal(h.length, 1);
  const events = await f.get('/api/session/events'); assert.equal(events.total, 1); assert.doesNotMatch(JSON.stringify(events), /private-ana/);
  assert.equal((await f.get('/api/timeline')).items.filter(x => x.type === 'streak').length, 1);
  assert.deepEqual((await f.get('/api/session')).totals, before.totals);
});

test('S4: a missing author in an immediately previous YouTube session breaks the run; below minimum falls back to returning welcome', async t => {
  const f = await fixture(t, [archive('older', '2024-01-01', 'youtube', ['ana']), archive('gap', '2024-02-01', 'youtube', []), archive('newer', '2024-03-01', 'youtube', ['ana'])]);
  await f.start(); await f.message('youtube', 'ana', 'Ana');
  const h = await until(f.history, rows => rows.length === 1, 'returning welcome missing');
  assert.deepEqual(h.map(x => [x.type, x.text]), [['welcome', '¡Ana, qué bueno verte de nuevo!']]);
  assert.equal((await f.get('/api/session/events')).total, 1);
});

test('S4: configurable minimum includes the current session and the gap caps the count', async t => {
  const f = await fixture(t, [archive('old', '2024-01-01', 'youtube', ['ana']), archive('gap', '2024-02-01', 'youtube', ['other']), archive('last', '2024-03-01', 'youtube', ['ana'])]);
  await f.start();
  assert.equal((await f.request('PUT', '/api/config', { youtube: { streakMinSessions: 2 } })).status, 200);
  assert.equal((await f.request('PUT', '/api/alerts/streak', { sub: '{count}' })).status, 200);
  await f.message('youtube', 'ana', 'Ana');
  const h = await until(f.history, rows => rows.length === 1, 'minimum 2 streak missing');
  assert.deepEqual(h.map(x => [x.type, x.sub]), [['streak', '2']]);
});

test('S4/S7: local switch off keeps settings and alert counters unchanged; both off switches fall back to welcome', async t => {
  const f = await fixture(t, [archive('one', '2024-01-01', 'youtube', ['ana', 'bea', 'cora']), archive('two', '2024-02-01', 'youtube', ['ana', 'bea', 'cora'])]);
  await f.start();
  assert.equal((await f.request('PUT', '/api/config', { youtube: { streakAlert: false }, alerts: { welcome: { enabled: false } } })).status, 200);
  const beforeConfig = await f.get('/api/config'), before = await f.get('/api/session');
  await f.message('youtube', 'ana', 'Ana');
  assert.deepEqual(await f.history(), []); assert.equal((await f.get('/api/session/events')).total, 0);
  assert.deepEqual((await f.get('/api/session')).totals, before.totals);
  assert.deepEqual(await f.get('/api/config'), beforeConfig);
  assert.equal((await f.request('PUT', '/api/config', { alerts: { welcome: { enabled: true } } })).status, 200);
  await f.message('youtube', 'cora', 'Cora');
  let h = await until(f.history, rows => rows.length === 1, 'local switch must leave welcome enabled');
  assert.deepEqual(h.map(x => [x.type, x.text]), [['welcome', '¡Cora, qué bueno verte de nuevo!']]);
  assert.equal((await f.request('PUT', '/api/config', { youtube: { streakAlert: true }, alerts: { streak: { enabled: false } } })).status, 200);
  await f.message('youtube', 'bea', 'Bea');
  h = await until(f.history, rows => rows.length === 2, 'welcome should remain when the global streak switch is off');
  assert.deepEqual(h.map(x => [x.type, x.text]), [['welcome', '¡Bea, qué bueno verte de nuevo!'], ['welcome', '¡Cora, qué bueno verte de nuevo!']]);
  f.app.twitch.emitEvent('off', 'channel.chat.notification', notice());
  assert.equal((await f.history()).length, 2);
});

test('S4: the minimum of one includes the current session even when welcome is disabled', async t => {
  const f = await fixture(t); await f.start();
  assert.equal((await f.request('PUT', '/api/config', { youtube: { streakMinSessions: 1 }, alerts: { welcome: { enabled: false } } })).status, 200);
  assert.equal((await f.request('PUT', '/api/alerts/streak', { sub: '{count}' })).status, 200);
  await f.message('youtube', 'new-ana', 'Ana');
  const h = await until(f.history, rows => rows.length === 1, 'streak must not depend on welcome being enabled');
  assert.deepEqual(h.map(x => [x.type, x.sub]), [['streak', '1']]);
});

test('S4/S7: streaks share the first-message burst cap and suppressed people are not replayed', async t => {
  const ids = Array.from({ length: 6 }, (_, i) => `person-${i}`);
  const f = await fixture(t, [archive('one', '2024-01-01', 'youtube', ids), archive('two', '2024-02-01', 'youtube', ids)]);
  await f.start(); await f.post('/api/pause');
  for (let i = 0; i < 5; i++) await f.message('youtube', ids[i], `Person${i}`);
  await until(f.history, rows => rows.length === 5, 'five streaks should be admitted');
  await f.message('youtube', ids[5], 'Person5');
  assert.equal((await f.history()).filter(x => x.type === 'streak').length, 5);
  assert.equal((await f.get('/api/session/events')).total, 5);
  await f.post('/api/resume', { discard: true }); await f.message('youtube', ids[5], 'Person5');
  assert.equal((await f.history()).length, 5); assert.equal((await f.get('/api/session/events')).total, 5);
});

test('S4/S7: Twitch chat never computes local streaks and YouTube owners and blocked users never alert', async t => {
  const f = await fixture(t, [archive('one', '2024-01-01', 'twitch', ['ana']), archive('two', '2024-02-01', 'twitch', ['ana'])]);
  await f.start(); assert.equal((await f.request('PUT', '/api/config', { filters: { blockedUsers: ['bot'] } })).status, 200);
  await f.message('youtube', 'owner', 'Owner', { owner: true });
  await f.message('youtube', 'bot-id', 'Bot');
  f.app.twitch.emitEvent('blocked', 'channel.chat.notification', { ...notice('bot-id'), chatter_user_name: 'Bot' });
  await f.message('twitch', 'ana', 'Ana');
  const h = await until(f.history, rows => rows.length === 1, 'Twitch welcome missing');
  assert.deepEqual(h.map(x => [x.type, x.text]), [['welcome', '¡Ana, qué bueno verte de nuevo!']]);
  assert.equal((await f.get('/api/session/events')).total, 1);
});

test('S7: streak is editable with variations and voice, previewable, simulable and recorded in timeline', async t => {
  const f = await fixture(t); const state = await f.get('/api/state');
  assert.deepEqual(state.types.streak, { platform: 'egdev', icon: 'fire', label: 'Racha', system: true });
  assert.equal(state.config.alerts.streak.enabled, true);
  assert.deepEqual([state.config.youtube.streakAlert, state.config.youtube.streakMinSessions], [true, 3]);
  assert.deepEqual([state.samples.streak.user, state.samples.streak.platform, state.samples.streak.count], ['Ana', 'youtube', 3]);
  const added = await f.post('/api/alerts/streak/variations', { name: 'Ana', conditions: { users: 'Ana' }, overrides: { title: 'Racha', text: '{user} {count}', sub: '{platform}', ttsEnabled: true, ttsTemplate: 'Racha {count}' } });
  const preview = await f.post('/api/test', { type: 'streak', variationId: added.variation.id, vars: { user: 'Ana', count: 5, platform: 'youtube' }, target: 'preview' });
  assert.deepEqual([preview.alert.title, preview.alert.text, preview.alert.sub, preview.alert.tts], ['Racha', 'Ana 5', 'youtube', 'Racha 5']);
  assert.deepEqual(await f.history(), []); assert.equal((await f.get('/api/session/events')).total, 0);
  const result = await f.post('/api/simulate', { type: 'streak', vars: { user: 'Ana', count: 5, platform: 'youtube' } });
  assert.equal(result.ok, true); assert.equal(result.alert.text, 'Ana 5');
  assert.equal((await f.history())[0].type, 'streak'); assert.equal((await f.get('/api/timeline')).items[0].type, 'streak');
});

test('S4: invalid YouTube streak settings are rejected with no stored change or counter movement', async t => {
  const f = await fixture(t); const before = await f.get('/api/config'), counters = (await f.get('/api/status')).persistence;
  for (const [value, error] of [[0, 'youtube.streakMinSessions: el valor mínimo es 1'], [1.5, 'youtube.streakMinSessions: se esperaba un número entero']]) {
    assert.deepEqual(await f.request('PUT', '/api/config', { youtube: { streakMinSessions: value } }), { status: 400, body: { error } });
    assert.deepEqual(await f.get('/api/config'), before); assert.deepEqual((await f.get('/api/status')).persistence, counters);
  }
  assert.deepEqual(await f.request('PUT', '/api/config', { youtube: { streakAlert: 'false' } }), { status: 400, body: { error: 'youtube.streakAlert: se esperaba true o false' } });
  assert.deepEqual(await f.get('/api/config'), before); assert.deepEqual((await f.get('/api/status')).persistence, counters);
  assert.equal((await f.get('/api/session/events')).total, 0);
});

test('PRESERVE: a follow notification still reaches history, timeline and totals', async t => {
  const f = await fixture(t); await f.start();
  f.app.twitch.emitEvent('follow-1', 'channel.follow', { user_name: 'Bea', user_id: 'bea' });
  const h = await until(f.history, rows => rows.length === 1, 'follow missing');
  assert.deepEqual(h.map(x => [x.type, x.text]), [['follow', 'Bea']]);
  assert.equal((await f.get('/api/timeline')).items[0].type, 'follow');
  assert.equal((await f.get('/api/session')).totals.follows, 1);
});
