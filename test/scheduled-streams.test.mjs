// All external services in this suite are synthetic and bound to loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createApp } from '../src/server.mjs';
import { Twitch } from '../src/twitch.mjs';
import { openZip } from '../src/zip-archive.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const TOKEN = 'SYNTHETIC_CALENDAR_TOKEN_310';
const VIDEO = 'AbCdEfGhI12', SEARCH_VIDEO = 'ZyXwVuTsR98';
// The provider sends scheduledStart as epoch milliseconds; antena stores it as an ISO date.
const SCHEDULED_ISO = '2026-01-01T12:00:00.000Z';
const EVENT = { eventId: 'event-310', criterioEventId: null, youtube: { broadcastId: VIDEO, url: null },
  title: 'Directo de prueba', scheduledStart: 1767268800000, durationMin: 60, state: 'scheduled',
  twitch: { title: 'Título Twitch', category: 'Software', categoryId: '123' } };
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(10); }
  assert.fail(`timeout: ${label}`);
}
async function fixture(t, { reply = { code: 200, body: EVENT }, patchOk = true, push = false, timeoutMs = 80 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ant-schedule-'));
  const logs = [], requests = [], youtubeCalls = [], patches = [], pushed = [];
  const meld = fakeMeld();
  const calendar = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, method: req.method });
    if (reply === 'hang') return;
    if (reply === 'disconnect') { req.socket.destroy(); return; }
    res.writeHead(reply.code, { 'content-type': 'application/json', ...reply.headers });
    res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
  });
  const receiver = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    pushed.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"result":"stored"}');
  });
  await Promise.all([listen(meld.server), listen(calendar), listen(receiver)]);
  const calendarUrl = `http://127.0.0.1:${calendar.address().port}`;
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'),
    log: (...args) => logs.push(args.join(' ')), scheduleCalendarTimeoutMs: timeoutMs,
    push: push ? { url: `http://127.0.0.1:${receiver.address().port}`, token: 'synthetic-push' } : {} });
  t.after(async () => {
    app.viewers.halt(); await app.youtube.quiescePoll().catch(() => {});
    await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
    await app.session.flush().catch(() => {}); app.program.stop(); app.program.dispose();
    app.server.closeAllConnections(); app.closeUpgradedConnections(); await app.closeHttp().catch(() => {});
    for (const server of [calendar, meld.server, receiver]) server.closeAllConnections();
    await Promise.all([calendar, meld.server, receiver].map(server => new Promise(resolve => server.close(resolve))));
    await rm(root, { recursive: true, force: true });
  });
  app.youtube.poll = () => {};
  app.youtube.api = async (pathname, params) => {
    youtubeCalls.push({ pathname, params });
    if (pathname === '/search') return { items: [{ id: { videoId: SEARCH_VIDEO } }] };
    if (pathname === '/videos') return { items: [{ id: params.id, liveStreamingDetails: { activeLiveChatId: 'fake-chat' }, snippet: { title: 'Título original' } }] };
    throw new Error('unexpected fake YouTube request');
  };
  app.twitch.userId = 'fake-user';
  app.twitch.helix = async (method, pathname, body) => {
    if (method === 'PATCH') { patches.push({ method, pathname, body }); return { ok: patchOk, status: patchOk ? 204 : 403, data: { message: TOKEN } }; }
    return { ok: true, data: { data: [] } };
  };
  app.viewers.readers = { twitch: async () => ({ live: false }), youtube: async () => ({ live: false }) };
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const text = await r.text(); return { status: r.status, body: JSON.parse(text), text };
  };
  const ok = async (method, url, body) => { const result = await call(method, url, body); assert.equal(result.status, 200, result.text); return result.body; };
  await ok('PUT', '/api/config', { youtube: { apiKey: 'synthetic-key', channelId: 'UCfake', video: '' }, viewers: { enabled: false } });
  const enable = async () => {
    await ok('PUT', '/api/config', { scheduleCalendar: { url: calendarUrl, token: TOKEN } });
    await ok('PUT', '/api/config', { scheduleCalendar: { enabled: true } });
  };
  const start = async () => {
    await ok('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
    await until(async () => (await ok('GET', '/api/status')).meld.state === 'conectado', 'program connection');
    const old = (await ok('GET', '/api/session')).id;
    meld.setStreaming(true);
    return until(async () => { const data = await ok('GET', '/api/session'); return data.id !== old && data; }, 'new session');
  };
  const end = async () => {
    meld.setStreaming(false);
    return until(async () => { const data = await ok('GET', '/api/session'); return data.endedAt && data; }, 'session end');
  };
  return { app, base, root, calendarUrl, requests, youtubeCalls, patches, pushed, logs, call, ok, enable, start, end, meld };
}

test('S2/S6: disabled by default makes no calendar request and preserves YouTube search', async t => {
  const f = await fixture(t); const cfg = await f.ok('GET', '/api/config');
  assert.equal(cfg.scheduleCalendar.enabled, false);
  await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'YouTube');
  assert.deepEqual(f.requests, []); assert.deepEqual(f.patches, []);
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal(f.app.youtube.status.videoId, SEARCH_VIDEO);
  assert.equal((await f.ok('GET', '/api/session')).scheduledEvent, undefined);
});

test('S2/S7: current event supplies YouTube, links the session and both v1 exports and pushes once', async t => {
  const f = await fixture(t, { push: true }); await f.enable(); await f.start();
  const session = await until(async () => { const s = await f.ok('GET', '/api/session'); return s.scheduledEvent && s; }, 'scheduled event');
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos') && f.patches.length, 'platform updates');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'GET');
  const requested = new URL(f.requests[0].url, f.calendarUrl);
  assert.equal(requested.pathname, '/api/v1/live-events/current');
  assert.equal(Number(requested.searchParams.get('at')), Date.parse(session.startedAt));
  assert.equal(f.requests[0].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(session.scheduledEvent, { id: EVENT.eventId, title: EVENT.title, scheduledStart: SCHEDULED_ISO });
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 0);
  assert.equal(f.youtubeCalls.find(c => c.pathname === '/videos').params.id, VIDEO);
  assert.equal((await f.ok('GET', '/api/config')).youtube.video, '');
  assert.deepEqual(f.patches, [{ method: 'PATCH', pathname: '/channels?broadcaster_id=fake-user', body: { title: 'Título Twitch', game_id: '123' } }]);
  f.app.program.emit('status', { ...f.app.program.status, state: 'conectado', streaming: true });
  await sleep(100); assert.equal(f.requests.length, 1); assert.equal(f.patches.length, 1);
  await f.end();
  const detail = await f.ok('GET', `/api/metrics/v1/sessions/${session.id}`);
  const list = await f.ok('GET', '/api/metrics/v1/sessions');
  assert.equal(detail.session.scheduledEventId, EVENT.eventId);
  assert.equal(list.sessions.find(x => x.session.id === session.id).session.scheduledEventId, EVENT.eventId);
  await until(() => f.pushed.length, 'push export');
  assert.equal(f.pushed[0].session.scheduledEventId, EVENT.eventId);
});

test('S7: numeric scheduledStart is normalised and a null category sends only the title', async t => {
  const event = { ...EVENT, scheduledStart: 1800000000000, twitch: { title: 'T', category: null, categoryId: null } };
  const f = await fixture(t, { reply: { code: 200, body: event } }); await f.enable(); await f.start();
  const session = await until(async () => { const s = await f.ok('GET', '/api/session'); return s.scheduledEvent && s; }, 'scheduled event');
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos') && f.patches.length === 1, 'platform updates');
  assert.equal(session.scheduledEvent.scheduledStart, '2027-01-15T08:00:00.000Z');
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 0);
  assert.equal(f.app.youtube.status.videoId, VIDEO);
  assert.deepEqual(f.patches.map(p => p.body), [{ title: 'T' }]);
  assert.equal(f.requests.length, 1);
});

test('S7: numeric Twitch category IDs are normalised to digit strings', async t => {
  const event = { ...EVENT, twitch: { title: null, category: null, categoryId: 509658 } };
  const f = await fixture(t, { reply: { code: 200, body: event } }); await f.enable(); await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'YouTube');
  await until(() => f.patches.length === 1, 'Twitch PATCH');
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 0);
  assert.deepEqual(f.patches.map(p => p.body), [{ game_id: '509658' }]);
  assert.equal(f.requests.length, 1);
});

test('S6: numeric category normalisation never sends an echoed numeric credential to Twitch', async t => {
  const event = { ...EVENT, twitch: { title: null, category: null, categoryId: 509658 } };
  const f = await fixture(t, { reply: { code: 200, body: event } });
  await f.ok('PUT', '/api/config', { scheduleCalendar: { url: f.calendarUrl, token: '509658' } });
  await f.ok('PUT', '/api/config', { scheduleCalendar: { enabled: true } });
  await f.start(); await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'fallback');
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal((await f.ok('GET', '/api/status')).scheduleCalendar.state, 'calendario no disponible');
  assert.deepEqual(f.patches, []); assert.equal(f.requests.length, 1);
});

for (const categoryId of [0, -1, 1.5, true, {}, '5x']) test(`S7: invalid categoryId ${JSON.stringify(categoryId)} falls back`, async t => {
  const event = { ...EVENT, twitch: { title: 'T', category: null, categoryId } };
  const f = await fixture(t, { reply: { code: 200, body: event } }); await f.enable(); await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'fallback');
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal((await f.ok('GET', '/api/status')).scheduleCalendar.state, 'calendario no disponible');
  assert.deepEqual(f.patches, []); assert.equal(f.requests.length, 1);
});

test('S2/S3: repeated program status and streaming signals do not query or patch twice', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  await until(() => f.requests.length === 1 && f.patches.length === 1, 'first lookup');
  f.app.program.emit('status', { ...f.app.program.status, state: 'conectado', streaming: true });
  f.app.program.emit('streaming', true);
  await f.app.session.transitionChain; await sleep(100);
  assert.equal(f.requests.length, 1); assert.equal(f.patches.length, 1);
});

for (const [label, reply, status] of [
  ['404', { code: 404, body: { code: 'no_current_event' } }, 'sin evento programado'],
  ['401', { code: 401, body: { code: 'unauthenticated' } }, 'credencial no válida'],
  ['403', { code: 403, body: { code: 'scope_denied' } }, 'sin permiso de lectura'],
  ['400', { code: 400, body: { code: 'invalid_input' } }, 'calendario no disponible'],
  ['500', { code: 500, body: { code: TOKEN } }, 'calendario no disponible'],
  ['timeout', 'hang', 'calendario no disponible'],
  ['network', 'disconnect', 'calendario no disponible'],
  ['invalid JSON', { code: 200, body: '{' }, 'calendario no disponible'],
  ['invalid video', { code: 200, body: { ...EVENT, youtube: { broadcastId: 'bad', url: null } } }, 'calendario no disponible'],
]) test(`S2/S7: ${label} falls back to normal discovery with a safe status`, async t => {
  const f = await fixture(t, { reply }); await f.enable(); await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'fallback');
  const current = await f.ok('GET', '/api/session');
  assert.equal(current.scheduledEvent, undefined); assert.deepEqual(f.patches, []);
  assert.equal(f.requests.length, 1); assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal(f.app.youtube.status.videoId, SEARCH_VIDEO);
  assert.equal((await f.ok('GET', '/api/status')).scheduleCalendar.state, status);
});

for (const [title, categoryId, expected] of [
  ['Solo título', null, { title: 'Solo título' }],
  [null, '987', { game_id: '987' }],
  [null, null, null],
]) test(`S3: Twitch skips null fields (${title}/${categoryId})`, async t => {
  const event = { ...EVENT, twitch: { title, category: null, categoryId } };
  const f = await fixture(t, { reply: { code: 200, body: event } }); await f.enable(); await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'YouTube'); await sleep(60);
  assert.deepEqual(f.patches.map(c => c.body), expected ? [expected] : []);
});

test('S7: an adopted event without a YouTube video still links the session and applies its available Twitch fields', async t => {
  const event = { ...EVENT, youtube: { broadcastId: null, url: null }, twitch: { title: 'Adoptado', category: null, categoryId: null } };
  const f = await fixture(t, { reply: { code: 200, body: event } }); await f.enable(); await f.start();
  const session = await until(async () => { const s = await f.ok('GET', '/api/session'); return s.scheduledEvent && s; }, 'adopted event');
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos') && f.patches.length, 'fallback and Twitch');
  assert.deepEqual(session.scheduledEvent, { id: EVENT.eventId, title: EVENT.title, scheduledStart: SCHEDULED_ISO });
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal(f.app.youtube.status.videoId, SEARCH_VIDEO);
  assert.deepEqual(f.patches.map(p => p.body), [{ title: 'Adoptado' }]);
  assert.equal(f.requests.length, 1);
});

test('S2: a previously listening YouTube video cannot claim the newly scheduled session', async t => {
  const f = await fixture(t); await f.app.youtube.start();
  assert.equal(f.app.youtube.status.videoId, SEARCH_VIDEO);
  await f.enable(); await f.start();
  await until(() => f.app.youtube.status.videoId === VIDEO, 'scheduled YouTube');
  const session = await until(async () => { const s = await f.ok('GET', '/api/session'); return s.platforms?.youtube && s; }, 'YouTube identity');
  assert.equal(session.platforms.youtube.videoId, VIDEO);
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1, 'no additional search at live start');
  assert.equal(f.requests.length, 1);
});

test('S2: identity rollover after reconnect queries once for the new session', async t => {
  const f = await fixture(t); await f.enable(); const first = await f.start();
  await until(() => f.app.youtube.status.videoId === VIDEO && f.patches.length === 1, 'first scheduled session');
  await until(async () => (await f.ok('GET', '/api/session')).platforms?.youtube?.videoId === VIDEO, 'first identity');
  f.app.meld.setStatus({ state: 'reintentando' });
  f.app.meld.setStatus({ state: 'conectado', streaming: true });
  f.app.youtube.setStatus({ state: 'escuchando', videoId: 'ZZZZZZZZZZZ', liveChatId: 'new-chat' });
  const second = await until(async () => { const s = await f.ok('GET', '/api/session'); return s.id !== first.id && s; }, 'rollover');
  await until(() => f.requests.length === 2 && f.patches.length === 2, 'rollover schedule');
  assert.notEqual(second.id, first.id);
  assert.equal(Number(new URL(f.requests[1].url, f.calendarUrl).searchParams.get('at')), Date.parse(second.startedAt));
  await sleep(80); assert.equal(f.requests.length, 2); assert.equal(f.patches.length, 2);
});

test('S2: disabling the integration during a pending lookup releases ordinary discovery', async t => {
  const f = await fixture(t, { reply: 'hang' }); await f.enable(); await f.start();
  await until(() => f.requests.length === 1, 'pending calendar request');
  await f.ok('PUT', '/api/config', { scheduleCalendar: { enabled: false } });
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'normal discovery');
  assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal(f.app.youtube.status.videoId, SEARCH_VIDEO); assert.deepEqual(f.patches, []);
  await until(async () => (await f.ok('GET', '/api/session')).platforms?.youtube?.videoId === SEARCH_VIDEO, 'fallback identity');
});

test('S2: ending while a lookup is in flight prevents late YouTube or Twitch work', async t => {
  const f = await fixture(t, { reply: 'hang' }); await f.enable(); await f.start();
  await until(() => f.requests.length === 1, 'pending calendar request');
  await f.end(); await sleep(120);
  assert.deepEqual(f.youtubeCalls, []); assert.deepEqual(f.patches, []);
  assert.equal(f.requests.length, 1);
});

test('S2: shutdown retains the cached auto-session drain and waits for a pending calendar lookup', async t => {
  const f = await fixture(t, { reply: 'hang', timeoutMs: 300 }); await f.enable(); await f.start();
  await until(() => f.requests.length === 1, 'pending calendar request');
  f.app.beginAutoSessionDrain();
  const drain = f.app.drainAutoSession();
  assert.strictEqual(f.app.drainAutoSession(), drain, 'the same drain promise is returned');
  let settled = false;
  drain.then(() => { settled = true; }, () => { settled = true; });
  await sleep(20); assert.equal(settled, false, 'the accepted lookup is drained');
  await drain; assert.equal(settled, true);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.youtubeCalls, []); assert.deepEqual(f.patches, []);
});

test('S6: a provider echoing the secret in an event cannot publish it', async t => {
  const event = { ...EVENT, title: TOKEN };
  const f = await fixture(t, { reply: { code: 200, body: event } }); await f.enable(); await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'fallback');
  const session = await f.ok('GET', '/api/session'), status = await f.ok('GET', '/api/status');
  assert.equal(session.scheduledEvent, undefined); assert.equal(f.youtubeCalls.filter(c => c.pathname === '/search').length, 1);
  assert.equal(JSON.stringify({ session, status, logs: f.logs }).includes(TOKEN), false);
});

test('S6: redirects are not followed and never receive the credential', async t => {
  const f = await fixture(t, { reply: { code: 302, headers: { location: '/redirected' } } });
  await f.enable(); await f.start();
  await until(() => f.youtubeCalls.some(c => c.pathname === '/videos'), 'fallback');
  assert.equal(f.requests.length, 1); assert.equal(f.app.youtube.status.videoId, SEARCH_VIDEO);
  assert.equal((await f.ok('GET', '/api/status')).scheduleCalendar.state, 'calendario no disponible');
});

test('S3: Twitch failure is reported without blocking or leaking the response', async t => {
  const f = await fixture(t, { patchOk: false }); await f.enable(); await f.start();
  await until(() => f.patches.length, 'Twitch');
  await until(async () => /Twitch/.test((await f.ok('GET', '/api/status')).scheduleCalendar.state), 'Twitch warning');
  assert.equal(f.app.youtube.status.videoId, VIDEO); assert.equal(f.patches.length, 1);
  assert.equal(JSON.stringify(f.logs).includes(TOKEN), false);
  assert.equal(JSON.stringify(await f.ok('GET', '/api/status')).includes(TOKEN), false);
});

test('S6: the calendar URL is a base address only, so no path can carry the credential', async t => {
  const f = await fixture(t);
  const before = await f.ok('GET', '/api/config');
  for (const url of ['http://localhost:4400/api', 'http://localhost:4400/cad_c_secret', 'http://127.0.0.1:4400/x/y', 'http://[::1]:4400/token']) {
    assert.equal((await f.call('PUT', '/api/config', { scheduleCalendar: { url } })).status, 400, `PUT ${url}`);
    assert.equal((await f.call('POST', '/api/config/set', { path: 'scheduleCalendar.url', value: url })).status, 400, `set ${url}`);
    const exported = await f.ok('GET', '/api/config/export?format=json');
    exported.config.scheduleCalendar = { ...exported.config.scheduleCalendar, url };
    assert.equal((await f.call('POST', '/api/config/import/preview', exported)).status, 400, `import ${url}`);
  }
  assert.deepEqual(await f.ok('GET', '/api/config'), before, 'nothing changed');
  for (const url of ['http://localhost:4400', 'http://localhost:4400/', 'https://127.0.0.1:4400', 'http://[::1]:4400/'])
    assert.equal((await f.call('PUT', '/api/config', { scheduleCalendar: { url } })).status, 200, `base ${url}`);
});

test('S4/S6: ambiguous loopback URLs are rejected without changing config bytes', async t => {
  const f = await fixture(t), file = path.join(f.root, 'data', 'config.json');
  const before = await readFile(file);
  for (const url of ['http://localhost:4400?', 'http://0.0.0.0', 'http://[::ffff:127.0.0.1]',
    'http://localhost%2f@evil', 'http://127.1', 'http://localhost:99999']) {
    for (const [method, endpoint, body] of [
      ['PUT', '/api/config', { scheduleCalendar: { url } }],
      ['POST', '/api/config/set', { path: 'scheduleCalendar.url', value: url }],
    ]) {
      assert.equal((await f.call(method, endpoint, body)).status, 400, `${method} ${url}`);
      assert.deepEqual(await readFile(file), before, `${method} ${url}: config bytes`);
    }
  }
});

test('S4/S6: non-loopback and credential-bearing URLs and enabling without a saved secret are rejected before mutation', async t => {
  const f = await fixture(t);
  const before = { config: await f.ok('GET', '/api/config'), persistence: (await f.ok('GET', '/api/status')).persistence };
  const check = async (method, url, body) => {
    const result = await f.call(method, url, body); assert.equal(result.status, 400, result.text);
    assert.deepEqual({ config: await f.ok('GET', '/api/config'), persistence: (await f.ok('GET', '/api/status')).persistence }, before);
  };
  await check('PUT', '/api/config', { scheduleCalendar: { enabled: true } });
  await check('POST', '/api/config/set', { path: 'scheduleCalendar.enabled', value: true });
  for (const url of ['http://example.invalid:4400', 'http://127.0.0.2:4400', 'http://127.1:4400',
    'http://localhost.evil.invalid', 'http://user:password@localhost:4400', 'http://localhost:4400?token=x',
    'http://localhost:4400#fragment', 'file:///tmp/x', 'http://localhost:4400?']) {
    await check('PUT', '/api/config', { scheduleCalendar: { url } });
    await check('POST', '/api/config/set', { path: 'scheduleCalendar.url', value: url });
  }
  const exported = await f.ok('GET', '/api/config/export?format=json');
  exported.config.scheduleCalendar = { enabled: true, url: f.calendarUrl };
  await check('POST', '/api/config/import/preview', exported);
});

test('S6: the credential is masked in HTTP, SSE, MCP, logs and exports and cannot be imported', async t => {
  const f = await fixture(t, { reply: { code: 401, body: { code: TOKEN } } });
  const abort = new AbortController();
  const response = await fetch(f.base + '/api/stream?client=panel', { signal: abort.signal });
  const reader = response.body.getReader(); let stream = '';
  const pump = (async () => { try { for (;;) { const item = await reader.read(); if (item.done) break; stream += new TextDecoder().decode(item.value); } } catch {} })();
  t.after(async () => { abort.abort(); await pump; });
  const saved = await f.ok('PUT', '/api/config', { scheduleCalendar: { url: f.calendarUrl, token: TOKEN } });
  assert.equal(saved.config.scheduleCalendar.tokenSet, true); assert.notEqual(saved.config.scheduleCalendar.token, TOKEN);
  const tested = await f.call('POST', '/api/schedule-calendar/test', {});
  const config = await f.ok('GET', '/api/config'), state = await f.ok('GET', '/api/state'), status = await f.ok('GET', '/api/status');
  const exported = await f.ok('GET', '/api/config/export?format=json');
  const zip = Buffer.from(await (await fetch(f.base + '/api/config/export')).arrayBuffer());
  const zipFile = path.join(f.root, 'export.zip'); await writeFile(zipFile, zip);
  const archive = await openZip(zipFile); const zipConfig = (await archive.readConfig()).toString('utf8'); await archive.close();
  const injected = structuredClone(exported); injected.config.scheduleCalendar.token = 'different-secret';
  const rejected = await f.call('POST', '/api/config/import/preview', injected); assert.equal(rejected.status, 400);
  await f.ok('PUT', '/api/config', { scheduleCalendar: config.scheduleCalendar });
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'data', 'secrets.json'), 'utf8')).scheduleCalendar.token, TOKEN);
  const child = spawn(process.execPath, ['src/mcp.mjs'], { env: { PATH: process.env.PATH, ANTENA_URL: f.base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout }); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const rpc = new Promise(resolve => lines.once('line', resolve));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ver_config', arguments: {} } }) + '\n');
  const mcp = await rpc; child.stdin.end(); assert.equal(await new Promise(resolve => child.once('close', resolve)), 0);
  await until(() => stream.includes('tokenSet'), 'public config SSE');
  for (const sample of [saved, tested, config, state, status, exported, zipConfig, rejected, stream, mcp, stderr, f.logs])
    assert.equal(JSON.stringify(sample).includes(TOKEN), false);
});

test('S3 and PRESERVE: the real Helix client sends the channel PATCH once while retaining ordinary auth refresh', async t => {
  const calls = [], originalFetch = globalThis.fetch;
  const store = { config: { twitch: { clientId: 'fake-client' } }, secrets: { twitch: { access: 'old', refresh: 'refresh' } },
    async setSecret(key, value) { this.secrets[key] = value; } };
  const twitch = new Twitch(store, () => {});
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body });
    if (String(url).includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'refresh', expires_in: 3600 }), { status: 200 });
    const status = calls.filter(c => c.url.includes('/helix/')).length === 1 ? 401 : 200;
    return new Response('{}', { status });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await twitch.helix('PATCH', '/channels?broadcaster_id=fake', { title: 'Título' }, { retryUnauthorized: false });
  assert.equal(result.status, 401); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].body), { title: 'Título' });
  calls.length = 0;
  const preserved = await twitch.helix('GET', '/streams?user_id=fake');
  assert.equal(preserved.status, 200);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'GET']);
});

test('PRESERVE: other config writes and manual session end still work', async t => {
  const f = await fixture(t);
  assert.equal((await f.ok('PUT', '/api/config', { overlay: { volume: 0.8 } })).config.overlay.volume, 0.8);
  assert.deepEqual(await f.ok('POST', '/api/config/set', { path: 'tts.rate', value: 1.25 }), { path: 'tts.rate', value: 1.25 });
  assert.ok((await f.ok('POST', '/api/session/end', {})).session.endedAt);
});
