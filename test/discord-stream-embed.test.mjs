// Discord delivery uses only synthetic credentials and a loopback fake endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createApp } from '../src/server.mjs';
import { openZip } from '../src/zip-archive.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/SYNTHETIC_DISCORD_TOKEN_53';
const VIDEO = 'AbCdEfGhI12';
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(10); }
  assert.fail(`timeout: ${label}`);
}
async function fixture(t, responses = []) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-discord-test-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  const requests = [], logs = [], meld = fakeMeld();
  const receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), at: Date.now() });
    const reply = responses.shift() ?? { code: 200, body: { id: '987654321' } };
    if (reply === 'disconnect') { req.socket.destroy(); return; }
    if (reply === 'hang') return;
    res.writeHead(reply.code, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await listen(receiver); await listen(meld.server);
  const origin = `http://127.0.0.1:${receiver.address().port}`;
  // The production URL is validated, but test traffic is always redirected to loopback.
  const discordFetch = (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://discord.com');
    return fetch(origin + parsed.pathname + parsed.search, options);
  };
  let app, base;
  const open = async () => {
    app = await createApp({ dataDir, mediaDir, push: {}, log: (...x) => logs.push(x.join(' ')), discordFetch, discordRetryDelayMs: 20, discordTimeoutMs: 150 });
    app.twitch.helix = async () => ({ ok: true, data: { data: [{ id: 'tw-stream', title: 'Título Twitch', viewer_count: 10 }] } });
    app.twitch.setStatus({ user: 'synthetic_channel' });
    app.viewers.readers = { twitch: async () => ({ live: true, streamId: 'tw-stream', viewers: 10 }), youtube: async () => ({ live: false }) };
    app.youtube.api = async () => ({ items: [{ id: VIDEO, snippet: { title: 'Título YouTube', description: 'Primera línea\nSegunda línea\nTercera línea\nCuarta línea' } }] });
    await listen(app.server); base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const close = async () => {
    if (!app) return;
    const current = app; app = null;
    current.viewers.halt();
    await current.youtube.quiescePoll().catch(() => {});
    await current.drainAutoSession().catch(() => {});
    await current.drainChatMetrics().catch(() => {});
    await current.session.flush().catch(() => {});
    current.program.stop(); current.meld.stop(); current.program.dispose();
    current.server.closeAllConnections(); current.closeUpgradedConnections();
    await current.closeHttp();
  };
  t.after(async () => {
    try { await close(); } finally {
      receiver.closeAllConnections(); meld.server.closeAllConnections();
      await Promise.all([new Promise(resolve => receiver.close(resolve)), new Promise(resolve => meld.server.close(resolve))]);
      await rm(root, { recursive: true, force: true });
    }
  });
  await open();
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    return { status: r.status, body: JSON.parse(text), text };
  };
  const ok = async (method, url, body) => { const r = await call(method, url, body); assert.equal(r.status, 200, r.text); return r.body; };
  const enable = async () => {
    await ok('PUT', '/api/config', { discord: { webhookUrl: WEBHOOK } });
    await ok('PUT', '/api/config', { discord: { enabled: true } });
  };
  const connect = async () => {
    await ok('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
    await until(async () => (await ok('GET', '/api/status')).meld.state === 'conectado', 'Meld connected');
  };
  const start = async ({ poll = true } = {}) => {
    await connect();
    const before = (await ok('GET', '/api/session')).id;
    meld.setStreaming(true);
    await until(async () => (await ok('GET', '/api/session')).id !== before, 'session start');
    await ok('PUT', '/api/session', { title: 'Título de sesión' });
    if (poll) await app.viewers.tick();
    return (await ok('GET', '/api/session')).id;
  };
  const startManual = async () => {
    await ok('PUT', '/api/config', { program: { autoSession: false } });
    await ok('PUT', '/api/session', { title: 'Sesión manual' });
    const id = (await ok('GET', '/api/session')).id;
    await connect(); meld.setStreaming(true);
    await until(async () => (await ok('GET', '/api/status')).meld.streaming, 'manual broadcast');
    return id;
  };
  const stopManual = async () => {
    meld.setStreaming(false);
    await until(async () => !(await ok('GET', '/api/status')).meld.streaming, 'manual broadcast stopped');
    await ok('POST', '/api/session/end', {});
  };
  const youtube = async () => {
    app.youtube.setStatus({ state: 'escuchando', videoId: VIDEO, liveChatId: 'fake-chat', title: 'Título YouTube' });
    await until(async () => (await ok('GET', '/api/session')).platforms?.youtube?.videoId === VIDEO, 'YouTube identity');
  };
  const end = async () => {
    meld.setStreaming(false);
    await until(async () => !!(await ok('GET', '/api/session')).endedAt, 'session end');
  };
  return { root, requests, responses, logs, call, ok, enable, connect, start, startManual, stopManual, youtube, end,
    get base() { return base; }, restart: async () => { await close(); await open(); }, get app() { return app; } };
}
const state = async f => (await f.ok('GET', '/api/status')).discord;
const embed = req => req.body.embeds[0];

// Mock the authenticated Helix boundary, leaving ViewerWatch's real reader intact.
function fakeHelixStream(twitch) {
  const calls = [];
  let live = false;
  Object.defineProperty(twitch, 'token', { configurable: true, get: () => ({ access: 'synthetic-access' }) });
  twitch.userId = 'synthetic-user';
  twitch.helix = async (method, pathname) => {
    calls.push({ method, pathname });
    return { ok: true, data: { data: live ? [{ id: 'tw-stream', title: 'Título Twitch', viewer_count: 10 }] : [] } };
  };
  return { calls, goLive: () => { live = true; } };
}
// The public check route debounces its first request until five seconds after process start.
const waitForViewerCheck = () => sleep(Math.max(0, 5100 - performance.now()));

test('S4: off by default, no request when a session starts', async t => {
  const f = await fixture(t);
  const config = await f.ok('GET', '/api/config'); assert.equal(config.discord.enabled, false);
  await f.start(); await sleep(100); assert.deepEqual(f.requests, []);
});

test('S2/S5: one live embed, platform join edits it, end edits it without VOD', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  await until(() => f.requests.length >= 1, 'initial post');
  assert.equal(f.requests[0].method, 'POST'); assert.match(f.requests[0].url, /\?wait=true$/);
  assert.match(JSON.stringify(embed(f.requests[0])), /En directo/);
  assert.match(JSON.stringify(embed(f.requests[0])), /https:\/\/twitch.tv\/synthetic_channel/);
  assert.match(embed(f.requests[0]).title, /Título Twitch|Título de sesión/);
  await f.youtube();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes(VIDEO)), 'YouTube patch');
  const joined = f.requests.find(r => r.method === 'PATCH' && JSON.stringify(r.body).includes(VIDEO));
  assert.match(joined.url, /\/messages\/987654321$/);
  assert.match(JSON.stringify(embed(joined)), /https:\/\/youtu.be\/AbCdEfGhI12/);
  assert.match(JSON.stringify(embed(joined)), /https:\/\/twitch.tv\/synthetic_channel/);
  assert.match(JSON.stringify(embed(joined)), /Primera línea/);
  assert.doesNotMatch(JSON.stringify(embed(joined)), /Cuarta línea/);
  assert.match(JSON.stringify(embed(joined)), /i.ytimg.com\/vi\/AbCdEfGhI12/);
  await f.end();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('Terminado')), 'end patch');
  const ended = f.requests.findLast(r => r.method === 'PATCH');
  assert.match(JSON.stringify(ended.body), /twitch.tv\/synthetic_channel/);
  assert.match(JSON.stringify(ended.body), /youtu.be\/AbCdEfGhI12/);
  assert.doesNotMatch(JSON.stringify(ended.body), /vod/i);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('S2 design: live embed is red with a linked title, large image, author and start time; ended is grey with the duration', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  await until(() => f.requests.length >= 1, 'initial post');
  const live = embed(f.requests[0]);
  assert.equal(live.color, 0xFF0036, 'red bar while live');
  assert.equal(live.url, 'https://twitch.tv/synthetic_channel', 'the title opens the stream (Twitch until YouTube joins)');
  assert.equal(live.author?.name, 'synthetic_channel está en directo');
  assert.ok(!Number.isNaN(Date.parse(live.timestamp)), 'start time as an ISO timestamp');
  await f.youtube();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes(VIDEO)), 'YouTube patch');
  const joined = embed(f.requests.find(r => r.method === 'PATCH' && JSON.stringify(r.body).includes(VIDEO)));
  assert.equal(joined.url, 'https://youtu.be/AbCdEfGhI12', 'with YouTube the title opens the YouTube stream');
  assert.equal(joined.image?.url, 'https://i.ytimg.com/vi/AbCdEfGhI12/hqdefault.jpg', 'large image');
  assert.equal(joined.thumbnail, undefined, 'no small thumbnail');
  assert.equal(joined.timestamp, live.timestamp, 'the start time does not move');
  await f.end();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('Terminado')), 'end patch');
  const ended = embed(f.requests.findLast(r => r.method === 'PATCH'));
  assert.equal(ended.color, 0x80848E, 'grey bar when ended');
  assert.equal(ended.author?.name, 'synthetic_channel estuvo en directo');
  assert.match(ended.fields.find(x => x.name === 'Estado').value, /^Terminado · duró (\d+ h )?\d+ min$/);
  assert.equal(ended.timestamp, live.timestamp);
});

test('S2: links follow confirmed platform offline and live observations', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'publicado', 'post');
  await f.youtube();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes(VIDEO)), 'YouTube join');
  let count = f.requests.length;
  f.app.viewers.readers.twitch = async () => ({ live: false });
  await f.app.viewers.tick();
  await until(() => f.requests.slice(count).some(r => r.method === 'PATCH' && !JSON.stringify(r.body).includes('twitch.tv/') && JSON.stringify(r.body).includes(VIDEO)), 'Twitch offline');
  count = f.requests.length;
  f.app.viewers.readers.twitch = async () => ({ live: true, streamId: 'tw-stream', viewers: 10 });
  await f.app.viewers.tick();
  await until(() => f.requests.slice(count).some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('twitch.tv/synthetic_channel')), 'Twitch returns');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('S2: a confirmed stream posts with session-title fallback before a platform is identified', async t => {
  const f = await fixture(t); await f.enable(); await f.start({ poll: false });
  await until(() => f.requests.length === 1, 'fallback post');
  assert.equal(embed(f.requests[0]).title, 'Título de sesión');
  assert.match(JSON.stringify(embed(f.requests[0])), /En directo/);
  assert.doesNotMatch(JSON.stringify(embed(f.requests[0])), /youtu\.be|twitch\.tv/);
  await f.app.viewers.tick();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('twitch.tv/synthetic_channel')), 'late Twitch');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('S2/S5: a short stream still publishes once and edits to ended', async t => {
  const f = await fixture(t); await f.enable(); await f.start({ poll: false }); await f.end();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('Terminado')), 'short stream end');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.match(JSON.stringify(f.requests[0].body), /En directo/);
});

test('S2: Discord observes Twitch in a manual session even when viewer polling is disabled', async t => {
  const f = await fixture(t); const helix = fakeHelixStream(f.app.twitch);
  await f.enable(); await f.ok('PUT', '/api/config', { viewers: { enabled: false } });
  const id = await f.startManual();
  await until(async () => (await state(f))?.state === 'publicado', 'manual announcement');
  assert.equal(f.requests.length, 1); assert.doesNotMatch(JSON.stringify(f.requests[0].body), /twitch\.tv/);
  const beforeViewers = await f.ok('GET', '/api/viewers');
  const beforeSession = await f.ok('GET', '/api/session');
  helix.goLive(); await waitForViewerCheck();
  const check = await f.ok('POST', '/api/viewers/check', {});
  assert.deepEqual(check, { fired: [], ...beforeViewers });
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('https://twitch.tv/synthetic_channel')), 'Twitch link');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.match(f.requests.find(r => r.method === 'PATCH').url, /\/messages\/987654321$/);
  assert.ok(helix.calls.length >= 1);
  assert.deepEqual(helix.calls[0], { method: 'GET', pathname: '/streams?user_id=synthetic-user' });
  assert.deepEqual(await f.ok('GET', '/api/viewers'), beforeViewers);
  assert.deepEqual(await f.ok('GET', '/api/session'), beforeSession);
  assert.equal(beforeSession.id, id);
  await f.stopManual();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('Terminado')), 'manual end');
  const callsAtEnd = helix.calls.length;
  await sleep(5100);
  await f.ok('POST', '/api/viewers/check', {});
  assert.equal(helix.calls.length, callsAtEnd, 'no Twitch poll after the session ends');
});

test('S7: Discord disabled causes no Helix stream requests with manual sessions and viewer polling disabled', async t => {
  const f = await fixture(t); const helix = fakeHelixStream(f.app.twitch);
  await f.ok('PUT', '/api/config', { viewers: { enabled: false } });
  const id = await f.startManual();
  const beforeViewers = await f.ok('GET', '/api/viewers');
  const beforeSession = await f.ok('GET', '/api/session');
  helix.goLive(); await waitForViewerCheck();
  const check = await f.ok('POST', '/api/viewers/check', {});
  assert.deepEqual(check, { fired: [], ...beforeViewers });
  await sleep(100);
  assert.deepEqual(helix.calls, []); assert.deepEqual(f.requests, []);
  assert.deepEqual(await f.ok('GET', '/api/viewers'), beforeViewers);
  assert.deepEqual(await f.ok('GET', '/api/session'), beforeSession);
  assert.equal(beforeSession.id, id);
});

test('PRESERVE: automatic sessions still observe Twitch with viewer polling and Discord disabled', async t => {
  const f = await fixture(t); const helix = fakeHelixStream(f.app.twitch);
  await f.ok('PUT', '/api/config', { viewers: { enabled: false } });
  const id = await f.start({ poll: false });
  const beforeViewers = await f.ok('GET', '/api/viewers');
  helix.goLive(); await waitForViewerCheck();
  const check = await f.ok('POST', '/api/viewers/check', {});
  assert.deepEqual(check, { fired: [], ...beforeViewers });
  const session = await until(async () => {
    const current = await f.ok('GET', '/api/session');
    return current.platforms?.twitch?.streamId === 'tw-stream' && current;
  }, 'automatic Twitch identity');
  assert.equal(session.id, id);
  assert.deepEqual(helix.calls, [{ method: 'GET', pathname: '/streams?user_id=synthetic-user' }]);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await f.ok('GET', '/api/viewers'), beforeViewers);
});

test('S2/S7: a manually maintained session announces and ends without changing its identity', async t => {
  const f = await fixture(t); await f.enable(); const id = await f.startManual();
  await until(() => f.requests.length === 1, 'manual post');
  assert.equal(embed(f.requests[0]).title, 'Sesión manual');
  await f.app.viewers.tick();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('twitch.tv/synthetic_channel')), 'manual Twitch');
  assert.equal((await f.ok('GET', '/api/session')).id, id);
  await f.stopManual();
  await until(() => f.requests.some(r => r.method === 'PATCH' && JSON.stringify(r.body).includes('Terminado')), 'manual end');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('S2: restart with saved message id edits instead of posting', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'publicado', 'published');
  await f.restart(); await f.connect(); await f.youtube();
  await until(() => f.requests.some(r => r.method === 'PATCH'), 'restart edit');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.match(f.requests.find(r => r.method === 'PATCH').url, /\/messages\/987654321$/);
});

test('S8: ambiguous POST is unconfirmed, never retried automatically, explicit republish creates once', async t => {
  const f = await fixture(t, ['disconnect', { code: 200, body: { id: '987654321' } }]);
  await f.enable(); const id = await f.start();
  await until(async () => (await state(f))?.state === 'sin confirmar', 'unconfirmed');
  await sleep(150); assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.call('POST', '/api/discord/republish', { sessionId: id }),
    { status: 400, body: { error: 'Confirma antes de volver a publicar.' }, text: '{"error":"Confirma antes de volver a publicar."}' });
  assert.equal(f.requests.length, 1);
  await f.ok('POST', '/api/discord/republish', { sessionId: id, confirm: true });
  await until(async () => (await state(f))?.state === 'publicado', 'republished');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  await f.youtube(); await until(() => f.requests.some(r => r.method === 'PATCH'), 'edit republished');
  assert.match(f.requests.find(r => r.method === 'PATCH').url, /\/messages\/987654321$/);
});

test('S8: explicit recovery can use a replacement saved webhook', async t => {
  const f = await fixture(t, ['disconnect', { code: 200, body: { id: '987654321' } }]);
  await f.enable(); const id = await f.start();
  await until(async () => (await state(f))?.state === 'sin confirmar', 'unconfirmed');
  const replacement = 'https://discord.com/api/webhooks/24680/SYNTHETIC_REPLACEMENT_TOKEN';
  await f.ok('PUT', '/api/config', { discord: { webhookUrl: replacement } });
  assert.equal(f.requests.length, 1);
  await f.ok('POST', '/api/discord/republish', { sessionId: id, confirm: true });
  await until(async () => (await state(f))?.state === 'publicado', 'recovery on replacement');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  assert.match(f.requests[1].url, /\/24680\/SYNTHETIC_REPLACEMENT_TOKEN\?wait=true$/);
});

test('S8: restart during an in-flight POST becomes unconfirmed without another POST', async t => {
  const f = await fixture(t, ['hang']); await f.enable(); await f.start();
  await until(() => f.requests.length === 1, 'in-flight post');
  await f.restart();
  await until(async () => (await state(f))?.state === 'sin confirmar', 'restart fence');
  await sleep(250); assert.equal(f.requests.length, 1);
});

test('S8: 429 POST respects retry_after and PATCH failures retry safely', async t => {
  const f = await fixture(t, [
    { code: 429, body: { retry_after: 0.12 } }, { code: 200, body: { id: '987654321' } },
    { code: 503 }, { code: 200, body: { id: '987654321' } },
  ]);
  await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'publicado', 'post retry');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
  assert.ok(f.requests[1].at - f.requests[0].at >= 100, 'retry_after respected');
  await f.youtube(); await until(() => f.requests.filter(r => r.method === 'PATCH').length >= 2, 'patch retry');
  const patches = f.requests.filter(r => r.method === 'PATCH');
  assert.ok(patches.every(r => r.url.endsWith('/messages/987654321')));
});

test('S8: a definitive 429 and its backoff survive restart', async t => {
  const f = await fixture(t, [{ code: 429, body: { retry_after: 0.25 } }, { code: 200, body: { id: '987654321' } }]);
  await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'esperando', '429 persisted');
  assert.equal(f.requests.length, 1);
  await f.restart();
  await until(async () => (await state(f))?.state === 'publicado', 'retry after restart');
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].at - f.requests[0].at >= 200, 'backoff survives restart');
});

test('S8: 429 Retry-After header also controls the next POST', async t => {
  const f = await fixture(t, [{ code: 429, headers: { 'retry-after': '0.12' } }, { code: 200, body: { id: '987654321' } }]);
  await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'publicado', 'header retry');
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests[1].at - f.requests[0].at >= 100, 'Retry-After header respected');
});

test('S8: a request-timeout response does not prove that a create was rejected', async t => {
  const f = await fixture(t, [{ code: 408 }, { code: 200, body: { id: '987654321' } }]);
  await f.enable(); await f.start();
  const observed = await until(async () => {
    const current = await state(f);
    return ['sin confirmar', 'publicado'].includes(current?.state) && current;
  }, 'timeout classification');
  assert.equal(observed.state, 'sin confirmar');
  await sleep(100); assert.equal(f.requests.length, 1);
});

test('S8: definitive create rejection has bounded backoff', async t => {
  const f = await fixture(t, Array.from({ length: 5 }, () => ({ code: 401 })));
  await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'error', 'retry limit');
  assert.equal(f.requests.length, 5); await sleep(100); assert.equal(f.requests.length, 5);
});

test('S8: restarting during the final PATCH does not exceed the attempt limit', async t => {
  const f = await fixture(t, [{ code: 200, body: { id: '987654321' } },
    ...Array.from({ length: 4 }, () => ({ code: 503 })), 'hang']);
  await f.enable(); await f.start(); await until(async () => (await state(f))?.state === 'publicado', 'post');
  await f.youtube();
  await until(() => f.requests.filter(r => r.method === 'PATCH').length === 5, 'final in-flight edit');
  await f.restart();
  await until(async () => ['error', 'publicado'].includes((await state(f))?.state), 'restart edit outcome');
  await sleep(100);
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 5);
  assert.equal((await state(f)).state, 'error');
});

test('S2: YouTube description is bounded to three lines and 300 characters', async t => {
  const f = await fixture(t); await f.enable(); await f.start();
  await until(async () => (await state(f))?.state === 'publicado', 'post');
  f.app.youtube.api = async () => ({ items: [{ id: VIDEO, snippet: { description: 'x'.repeat(350) + '\nsecond\nthird\nfourth' } }] });
  await f.youtube();
  await until(() => f.requests.some(r => r.method === 'PATCH' && embed(r).description?.length === 300), 'excerpt');
  const patch = f.requests.findLast(r => r.method === 'PATCH');
  assert.equal(embed(patch).description, 'x'.repeat(300));
});

test('S8: a rejected PATCH is retried against the same message', async t => {
  const f = await fixture(t, [{ code: 200, body: { id: '987654321' } }, { code: 400 }, { code: 200, body: { id: '987654321' } }]);
  await f.enable(); await f.start(); await until(async () => (await state(f))?.state === 'publicado', 'post');
  await f.youtube(); await until(() => f.requests.filter(r => r.method === 'PATCH').length === 2, 'rejected patch retry');
  assert.ok(f.requests.filter(r => r.method === 'PATCH').every(r => r.url.endsWith('/messages/987654321')));
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('S8: deleted message produces message-not-found and never reposts', async t => {
  const f = await fixture(t, [{ code: 200, body: { id: '987654321' } }, { code: 404 }]);
  await f.enable(); await f.start(); await until(async () => (await state(f))?.state === 'publicado', 'post');
  await f.youtube(); await until(async () => (await state(f))?.state === 'mensaje no encontrado', '404');
  await f.end(); await sleep(120);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(f.requests.filter(r => r.method === 'PATCH').length, 1);
});

test('S4/S6: validation and enable guard reject without changing public state or persistence counters', async t => {
  const f = await fixture(t);
  const snapshot = async () => ({ config: await f.ok('GET', '/api/config'), persistence: (await f.ok('GET', '/api/status')).persistence });
  const before = await snapshot();
  for (const [method, endpoint, body, error] of [
    ['PUT', '/api/config', { discord: { enabled: true } }, 'discord.enabled: guarda primero un webhook de Discord'],
    ['POST', '/api/config/set', { path: 'discord.enabled', value: true }, 'discord.enabled: guarda primero un webhook de Discord'],
    ...['http://discord.com/api/webhooks/123/token', 'https://evil.invalid/api/webhooks/123/token',
      'https://discord.com.evil.invalid/api/webhooks/123/token', 'https://discord.com/api/webhooks/123/token?x=1',
      'https://user@discord.com/api/webhooks/123/token', 'https://discord.com/api/webhooks/123'].flatMap(url => [
      ['PUT', '/api/config', { discord: { webhookUrl: url } }, 'discord.webhookUrl: se esperaba una URL de webhook de Discord válida'],
      ['POST', '/api/config/set', { path: 'discord.webhookUrl', value: url }, 'discord.webhookUrl: se esperaba una URL de webhook de Discord válida'],
    ]),
  ]) {
    const result = await f.call(method, endpoint, body);
    assert.equal(result.status, 400); assert.deepEqual(result.body, { error }); assert.deepEqual(await snapshot(), before);
  }
  assert.deepEqual(f.requests, []);
  assert.equal((await f.call('PUT', '/api/config', { discord: { webhookUrl: 'https://discordapp.com/api/webhooks/123/token' } })).status, 200);
});

test('S4: Probar sends a marked sample to the saved webhook without enabling announcements', async t => {
  const f = await fixture(t);
  await f.ok('PUT', '/api/config', { discord: { webhookUrl: WEBHOOK } });
  assert.deepEqual(await f.ok('POST', '/api/discord/test'), { ok: true });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].method, 'POST');
  assert.match(JSON.stringify(f.requests[0].body), /Prueba de antena/);
  assert.equal((await f.ok('GET', '/api/config')).discord.enabled, false);
});

test('S6: webhook stays secret in config, exports, SSE, errors, logs and MCP; import cannot overwrite it', async t => {
  const f = await fixture(t, [{ code: 401, body: { message: WEBHOOK } }]);
  const ctrl = new AbortController();
  const streamResponse = await fetch(f.base + '/api/stream?client=panel', { signal: ctrl.signal });
  const reader = streamResponse.body.getReader(); let stream = '';
  const pump = (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; stream += new TextDecoder().decode(r.value); } } catch {} })();
  t.after(async () => { ctrl.abort(); await pump; });
  const set = await f.ok('PUT', '/api/config', { discord: { webhookUrl: WEBHOOK } });
  assert.equal(set.config.discord.webhookUrlSet, true); assert.notEqual(set.config.discord.webhookUrl, WEBHOOK);
  const failedTest = await f.call('POST', '/api/discord/test'); assert.equal(failedTest.status, 400);
  const config = await f.ok('GET', '/api/config');
  const json = await f.ok('GET', '/api/config/export?format=json');
  const zip = Buffer.from(await (await fetch(f.base + '/api/config/export')).arrayBuffer());
  const archiveFile = path.join(f.root, 'export.zip'); await writeFile(archiveFile, zip);
  const archive = await openZip(archiveFile);
  const zipConfig = (await archive.readConfig()).toString('utf8'); await archive.close();
  const imported = structuredClone(json); imported.config.discord.webhookUrl = '••••';
  const rejected = await f.call('POST', '/api/config/import/preview', imported); assert.equal(rejected.status, 400);
  await f.ok('PUT', '/api/config', { discord: config.discord });
  assert.equal((await f.ok('GET', '/api/config')).discord.webhookUrlSet, true);
  const child = spawn(process.execPath, ['src/mcp.mjs'], { env: { PATH: process.env.PATH, ANTENA_URL: f.base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const rpc = new Promise(resolve => lines.once('line', line => resolve(line)));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ver_config', arguments: {} } }) + '\n');
  const mcp = await rpc; child.stdin.end(); const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(code, 0);
  await until(() => stream.includes('webhookUrlSet'), 'Discord config event');
  for (const sample of [JSON.stringify(set), JSON.stringify(config), JSON.stringify(json), zipConfig, failedTest.text, JSON.stringify(rejected), stream, mcp, stderr, JSON.stringify(f.logs)]) {
    assert.equal(sample.includes(WEBHOOK), false); assert.equal(sample.includes('SYNTHETIC_DISCORD_TOKEN_53'), false);
  }
  await f.restart();
  assert.equal((await f.ok('GET', '/api/config')).discord.webhookUrlSet, true);
});

test('S6: import treats the read-only discord.webhookUrlSet flag like PUT (matching ignored, different rejected, never stored)', async t => {
  const f = await fixture(t);
  const json = await f.ok('GET', '/api/config/export?format=json');
  assert.equal(Object.hasOwn(json.config.discord || {}, 'webhookUrlSet'), false, 'exports never carry the flag');
  const before = await f.ok('GET', '/api/config');
  assert.equal(before.discord.webhookUrlSet, false);
  const lying = structuredClone(json); lying.config.discord = { ...lying.config.discord, webhookUrlSet: true };
  const rejected = await f.call('POST', '/api/config/import/preview', lying);
  assert.equal(rejected.status, 400); assert.match(rejected.text, /webhookUrlSet/);
  assert.equal((await f.call('PUT', '/api/config', { discord: { webhookUrlSet: true } })).status, 400, 'PUT rejects a different value too');
  const matching = structuredClone(json); matching.config.discord = { ...matching.config.discord, webhookUrlSet: false };
  const preview = await f.call('POST', '/api/config/import/preview', matching);
  assert.equal(preview.status, 200);
  assert.doesNotMatch(preview.text, /webhookUrlSet/, 'a matching flag is ignored, not reported as a change');
  assert.deepEqual((await f.ok('GET', '/api/config')).discord, before.discord, 'nothing changed');
});

test('PRESERVE: generic config writes and session end still work', async t => {
  const f = await fixture(t);
  assert.equal((await f.ok('PUT', '/api/config', { overlay: { volume: 0.8 } })).config.overlay.volume, 0.8);
  assert.deepEqual(await f.ok('POST', '/api/config/set', { path: 'tts.rate', value: 1.25 }), { path: 'tts.rate', value: 1.25 });
  assert.ok((await f.ok('POST', '/api/session/end', {})).session.endedAt);
});
