// #103 S1/S7: listener ownership uses synthetic events and private fixtures only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const video = { state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1' };
async function fixture(t, { current, backup } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-listener-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await mkdir(dataDir);
  for (const [name, value] of [['session-current.json', current], ['session-current.backup.json', backup]]) {
    if (value) await writeFile(path.join(dataDir, name), JSON.stringify(value));
  }
  const apps = [];
  t.after(async () => {
    for (const app of apps) {
      app.viewers.halt(); await app.youtube.quiescePoll().catch(() => {}); await app.chat.quiesceChat().catch(() => {});
      await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
      await app.session.flush().catch(() => {}); await app.closeHttp().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const start = async () => {
    const app = await createApp({ dataDir, mediaDir, log: () => {} }); apps.push(app);
    app.youtube.start = async () => {};
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const get = async url => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.json(); };
    return { app, get };
  };
  return { start };
}
async function live(app) {
  app.meld.setStatus({ state: 'conectado', streaming: true });
  await app.session.transitionChain;
}
const raw = app => app.session.get();

test('S1/S7: solo el JOIN del canal propio cuenta, persiste y no aparece en API públicas', async t => {
  const f = await fixture(t), { app, get } = await f.start();
  app.twitch.status.user = 'Canal';
  await live(app);
  const before = await Promise.all(['/api/session', '/api/session/summary?format=json', '/api/sessions'].map(get));
  app.chat.channel = 'otro'; app.chat.setStatus({ state: 'conectado', channel: 'otro' });
  await app.session.transitionChain; assert.equal((await raw(app)).chatListeners, undefined);
  app.chat.channel = 'canal'; app.chat.setStatus({ state: 'conectado', channel: 'canal' });
  await app.session.transitionChain;
  assert.deepEqual((await raw(app)).chatListeners, { twitch: true });
  const after = await Promise.all(['/api/session', '/api/session/summary?format=json', '/api/sessions'].map(get));
  assert.deepEqual(after, before);
  await app.session.flush();
  const reopened = await f.start();
  assert.deepEqual((await raw(reopened.app)).chatListeners, { twitch: true });
  for (const url of ['/api/session', '/api/session/summary?format=json', '/api/sessions']) assert.doesNotMatch(JSON.stringify(await reopened.get(url)), /chatListeners/);
});

test('S1: una conexión previa pertenece al inicio automático encolado, no al directo anterior', async t => {
  const { app } = await (await fixture(t)).start();
  app.twitch.status.user = 'Canal'; app.chat.channel = 'canal'; app.chat.setStatus({ state: 'conectado', channel: 'canal' });
  const old = (await raw(app)).id;
  const gate = deferred(), entered = deferred(), flush = app.session.flush.bind(app.session); let first = true;
  t.after(() => gate.resolve());
  app.session.flush = async (...args) => { if (first) { first = false; entered.resolve(); await gate.promise; } return flush(...args); };
  app.meld.setStatus({ state: 'conectado', streaming: true });
  await entered.promise; gate.resolve(); await app.session.transitionChain;
  assert.notEqual((await raw(app)).id, old);
  assert.deepEqual((await raw(app)).chatListeners, { twitch: true });
  assert.equal((await app.session.get(old)).chatListeners, undefined);
});

test('S1: YouTube exige un poll exitoso y acepta el primer poll sin mensajes', async t => {
  const { app } = await (await fixture(t)).start(); await live(app);
  app.youtube.setStatus(video); await app.session.transitionChain;
  assert.equal((await raw(app)).chatListeners, undefined);
  app.youtube.running = true; app.youtube.api = async () => { throw new Error('fallo sintético'); };
  await app.youtube.poll(); await app.session.transitionChain;
  assert.equal((await raw(app)).chatListeners, undefined);
  app.youtube.api = async (url, params) => { assert.equal(url, '/liveChat/messages'); assert.equal(params.liveChatId, 'chat-1'); return { items: [] }; };
  await app.youtube.poll(); await app.session.transitionChain;
  assert.deepEqual((await raw(app)).chatListeners, { youtube: true });
});

test('S1: YouTube conectado antes del inicio acredita chat silencioso tras confirmar identidad', async t => {
  const { app, get } = await (await fixture(t)).start();
  app.store.config.youtube.apiKey = 'synthetic';
  app.youtube.api = async p => {
    if (p === '/liveChat/messages') return { items: [] };
    assert.equal(p, '/videos'); return { items: [{ id: video.videoId, liveStreamingDetails: { activeLiveChatId: video.liveChatId } }] };
  };
  app.youtube.running = true; app.youtube.setStatus(video);
  await app.youtube.poll(); assert.equal(app.youtube.status.polls, 1);
  const done = deferred(), confirm = app.youtube.confirmListeningIdentity.bind(app.youtube);
  app.youtube.confirmListeningIdentity = () => { const work = confirm(); work.then(done.resolve, done.resolve); return work; };
  app.meld.setStatus({ state: 'conectado', streaming: true });
  await done.promise; await new Promise(resolve => setImmediate(resolve)); await app.session.transitionChain;
  const id = (await get('/api/session')).id;
  app.meld.setStatus({ streaming: false }); await app.session.transitionChain;
  const doc = await get('/api/metrics/v1/sessions/' + id);
  const rate = Date.parse(doc.session.endedAt) > Date.parse(doc.session.startedAt) ? 0 : null;
  assert.deepEqual(doc.metrics.filter(r => r.platform === 'youtube' && r.metric.startsWith('chat_')).map(r => [r.value, r.coverage.ratio]),
    [[0, 1], [0, 1], [rate, 1]]);
});

test('S1: escuchar sin poll exitoso no acredita listener al iniciar', async t => {
  const { app, get } = await (await fixture(t)).start();
  app.store.config.youtube.apiKey = 'synthetic';
  app.youtube.api = async p => { assert.equal(p, '/videos'); return { items: [{ id: video.videoId, liveStreamingDetails: { activeLiveChatId: video.liveChatId } }] }; };
  app.youtube.running = true; app.youtube.setStatus(video); assert.equal(app.youtube.status.polls, 0);
  const done = deferred(), confirm = app.youtube.confirmListeningIdentity.bind(app.youtube);
  app.youtube.confirmListeningIdentity = () => { const work = confirm(); work.then(done.resolve, done.resolve); return work; };
  app.meld.setStatus({ state: 'conectado', streaming: true });
  await done.promise; await new Promise(resolve => setImmediate(resolve)); await app.session.transitionChain;
  const id = (await get('/api/session')).id;
  app.meld.setStatus({ streaming: false }); await app.session.transitionChain;
  const doc = await get('/api/metrics/v1/sessions/' + id);
  assert.deepEqual(doc.metrics.filter(r => r.platform === 'youtube' && r.metric.startsWith('chat_')).map(r => [r.value, r.coverage.ratio]),
    [[null, 0], [null, 0], [null, 0]]);
});

test('S1: una confirmación tardía no acredita otro chat de YouTube', async t => {
  const { app, get } = await (await fixture(t)).start();
  const entered = deferred(), response = deferred();
  t.after(() => response.resolve({ items: [] }));
  app.store.config.youtube.apiKey = 'synthetic';
  app.youtube.api = async p => {
    if (p === '/liveChat/messages') return { items: [] };
    assert.equal(p, '/videos'); entered.resolve(); return response.promise;
  };
  app.youtube.running = true; app.youtube.setStatus(video); await app.youtube.poll();
  const done = deferred(), confirm = app.youtube.confirmListeningIdentity.bind(app.youtube);
  app.youtube.confirmListeningIdentity = () => { const work = confirm(); work.then(done.resolve, done.resolve); return work; };
  app.meld.setStatus({ state: 'conectado', streaming: true }); await entered.promise;
  app.youtube.setStatus({ ...video, liveChatId: 'chat-2' });
  response.resolve({ items: [{ id: video.videoId, liveStreamingDetails: { activeLiveChatId: video.liveChatId } }] });
  await done.promise; await new Promise(resolve => setImmediate(resolve)); await app.session.transitionChain;
  const id = (await get('/api/session')).id;
  app.meld.setStatus({ streaming: false }); await app.session.transitionChain;
  const doc = await get('/api/metrics/v1/sessions/' + id);
  assert.deepEqual(doc.metrics.filter(r => r.platform === 'youtube' && r.metric.startsWith('chat_')).map(r => [r.value, r.coverage.ratio]),
    [[null, 0], [null, 0], [null, 0]]);
});

test('S1: poll tardío del vídeo y sesión anterior no marca el directo nuevo', async t => {
  const { app } = await (await fixture(t)).start(); await live(app);
  app.youtube.setStatus(video); await app.session.transitionChain;
  const response = deferred(), entered = deferred(); t.after(() => response.resolve({ items: [] }));
  app.youtube.running = true; app.youtube.api = async () => { entered.resolve(); return response.promise; };
  const poll = app.youtube.poll(); await entered.promise;
  app.youtube.running = false;
  app.meld.setStatus({ streaming: false }); await app.session.transitionChain;
  app.meld.setStatus({ streaming: true }); await app.session.transitionChain;
  app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2' }); await app.session.transitionChain;
  response.resolve({ items: [] }); await poll; await app.session.transitionChain;
  assert.equal((await raw(app)).chatListeners, undefined);
});

test('S1: mensajes admitidos prueban el listener; manual y terminado no cambian', async t => {
  const { app } = await (await fixture(t)).start();
  app.twitch.userId = 'channel-id'; await live(app);
  app.chat.emit('message', { id: 'm', platform: 'twitch', roomId: 'channel-id', authorId: 'author', user: 'Ana', text: 'hola', parts: [], at: new Date().toISOString() });
  await app.session.transitionChain;
  assert.deepEqual((await raw(app)).chatListeners, { twitch: true });
  await app.session.startNew('manual');
  app.chat.channel = 'canal'; app.twitch.status.user = 'canal'; app.chat.setStatus({ state: 'conectado', channel: 'canal' });
  await app.session.transitionChain; assert.equal((await raw(app)).chatListeners, undefined);
  app.meld.setStatus({ streaming: false }); await app.session.transitionChain;
  app.chat.setStatus({ state: 'conectado' }); await app.session.transitionChain;
  assert.equal((await raw(app)).chatListeners, undefined);
});

test('S1: la propiedad exige id, identidades y habilitación; repetir es idempotente', async t => {
  const { app } = await (await fixture(t)).start(); await live(app);
  app.youtube.setStatus(video);
  app.viewers.emit('streamIdentity', { streamId: 'stream-1' }, app.viewers.identityEpoch());
  await app.session.transitionChain;
  const session = app.session, target = await session.captureIdentity(), before = structuredClone(await raw(app));
  await session.recordChatListener('youtube', video, { ...target, id: 'other' });
  await session.recordChatListener('youtube', { ...video, videoId: 'wrong' }, target);
  await session.recordChatListener('youtube', { ...video, liveChatId: 'wrong' }, target);
  await session.recordChatListener('twitch', {}, { ...target, twitch: 'wrong' });
  await session.recordChatListener('youtube', video, target, () => false);
  assert.deepEqual(await raw(app), before);
  let saves = 0; const save = session.save.bind(session); session.save = () => { saves++; return save(); };
  await session.recordChatListener('youtube', video, target);
  await session.recordChatListener('youtube', video, target);
  assert.equal(saves, 1); assert.deepEqual((await raw(app)).chatListeners, { youtube: true });
  await session.endCurrent(); const ended = structuredClone(await raw(app));
  await session.recordChatListener('twitch', {}, target); assert.deepEqual(await raw(app), ended);
});

test('S1: valores inválidos del indicador recuperan el backup', async t => {
  const base = { id: 'backup', startedAt: '2026-01-01T00:00:00.000Z', events: [], chatListeners: { youtube: true } };
  for (const value of [null, [], { twitch: false }, { twitch: 1 }, { other: true }]) await t.test(JSON.stringify(value), async child => {
    const { app } = await (await fixture(child, { current: { ...base, id: 'invalid', chatListeners: value }, backup: base })).start();
    assert.equal((await raw(app)).id, 'backup');
    assert.deepEqual((await raw(app)).chatListeners, { youtube: true });
  });
});

test('S1: dos inicios encolados atribuyen el listener propio a cada sesión', async t => {
  const { app } = await (await fixture(t)).start();
  app.twitch.status.user = 'canal'; app.chat.channel = 'canal'; app.chat.setStatus({ state: 'conectado', channel: 'canal' });
  const gate = deferred(), entered = deferred(), flush = app.session.flush.bind(app.session); let first = true;
  t.after(() => gate.resolve());
  app.session.flush = async (...args) => { if (first) { first = false; entered.resolve(); await gate.promise; } return flush(...args); };
  app.meld.emit('streaming', true); await entered.promise;
  app.meld.emit('streaming', true); gate.resolve(); await app.session.transitionChain;
  const current = await raw(app), past = await app.session.list();
  assert.deepEqual(current.chatListeners, { twitch: true });
  const firstAuto = (await Promise.all(past.map(p => app.session.get(p.id)))).find(p => p.meldAutoSession);
  assert.deepEqual(firstAuto?.chatListeners, { twitch: true });
});

test('S1: en un rollover el canal Twitch ya conectado pertenece también al nuevo directo', async t => {
  const { app } = await (await fixture(t)).start(); await live(app);
  app.twitch.status.user = 'canal'; app.chat.channel = 'canal'; app.chat.setStatus({ state: 'conectado', channel: 'canal' });
  app.viewers.emit('streamIdentity', { streamId: 'stream-1' }, app.viewers.identityEpoch());
  await app.session.transitionChain; const oldId = (await raw(app)).id;
  app.meld.setStatus({ state: 'reintentando' }); app.meld.setStatus({ state: 'conectado', streaming: true });
  app.viewers.emit('streamIdentity', { streamId: 'stream-2' }, app.viewers.identityEpoch());
  await app.session.transitionChain; await app.session.transitionChain;
  assert.notEqual((await raw(app)).id, oldId);
  assert.deepEqual((await raw(app)).chatListeners, { twitch: true });
  assert.deepEqual((await app.session.get(oldId)).chatListeners, { twitch: true });
});

test('S1: el drenaje espera el registro aceptado antes del checkpoint', async t => {
  const f = await fixture(t), { app } = await f.start(); await live(app);
  assert.equal(typeof app.session.recordChatListener, 'function');
  const gate = deferred(), entered = deferred(), record = app.session.recordChatListener.bind(app.session);
  t.after(() => gate.resolve());
  app.session.recordChatListener = (...args) => { entered.resolve(); return gate.promise.then(() => record(...args)); };
  app.twitch.status.user = 'canal'; app.chat.channel = 'canal'; app.chat.setStatus({ state: 'conectado', channel: 'canal' });
  await entered.promise;
  let drained = false; const drain = app.drainChatMetrics().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  gate.resolve(); await drain; await app.session.flush();
  const reopened = await f.start();
  assert.deepEqual((await raw(reopened.app)).chatListeners, { twitch: true });
});

test('S1: el cierre real espera un poll primario y el listener antes de guardar', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-listener-close-'));
  const source = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { createServer } from 'node:net';
    import path from 'node:path';
    import { createApp, startServer } from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};
    const dir = process.env.ANTENA_DATA, media = process.env.ANTENA_MEDIA;
    await mkdir(dir, { recursive: true }); await mkdir(media, { recursive: true });
    const reserve = createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
    const port = reserve.address().port; await new Promise(r => reserve.close(r));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ port, access: { lan: false },
      meld: { enabled: false, autoSession: true }, chat: { twitchChannel: '' }, viewers: { enabled: false } }));
    let outside = 0; const fetchLocal = globalThis.fetch;
    globalThis.fetch = (input, ...args) => { const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (u.hostname !== '127.0.0.1') { outside++; return Promise.reject(new Error('red externa prohibida')); }
      return fetchLocal(input, ...args); };
    globalThis.WebSocket = class { constructor() { outside++; throw new Error('red externa prohibida'); } };
    const app = await startServer({ quiet: true, log: () => {}, handleSignals: false, shutdownTimeoutMs: 10000 });
    app.viewers.halt(); app.youtube.start = async () => {};
    app.meld.setStatus({ state: 'conectado', streaming: true }); await app.session.transitionChain;
    app.youtube.setStatus({ state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1' }); await app.session.transitionChain;
    let releasePoll, enterPoll, releaseWrite;
    const response = new Promise(r => { releasePoll = r; });
    const entered = new Promise(r => { enterPoll = r; });
    const writeGate = new Promise(r => { releaseWrite = r; });
    const record = app.session.recordChatListener.bind(app.session); let recorded = false, drained = false;
    app.session.recordChatListener = (...args) => writeGate.then(() => record(...args)).then(() => { recorded = true; });
    const drain = app.drainChatMetrics;
    app.drainChatMetrics = () => {
      const work = drain(); let settled = false; work.then(() => { settled = true; }, () => { settled = true; });
      return new Promise((resolve, reject) => setImmediate(() => {
        if (settled) return reject(new Error('drenaje prematuro'));
        releaseWrite(); work.then(() => { drained = true; resolve(); }, reject);
      }));
    };
    app.youtube.api = async p => { assert.equal(p, '/liveChat/messages'); enterPoll(); return response; };
    app.youtube.running = true; const poll = app.youtube.poll(); await entered;
    const close = app.close(); releasePoll({ items: [] });
    const [, code] = await Promise.all([poll, close]);
    const reopened = await createApp({ dataDir: dir, mediaDir: media, log: () => {} });
    const stored = await reopened.session.get();
    await reopened.drainAutoSession(); await reopened.drainChatMetrics(); await reopened.session.flush(); await reopened.closeHttp();
    process.stdout.write(JSON.stringify({ code, drained, recorded, outside, listeners: stored.chatListeners }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { PATH: process.env.PATH, TMPDIR: root, ANTENA_DATA: path.join(root, 'data'), ANTENA_MEDIA: path.join(root, 'media') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close'); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } await rm(root, { recursive: true, force: true }); });
  const [code] = await closed;
  assert.equal(code, 0, stderr + '\n' + stdout); assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { code: 0, drained: true, recorded: true, outside: 0, listeners: { youtube: true } });
});
