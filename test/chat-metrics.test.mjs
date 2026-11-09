// #102: entradas reales sintéticas, agregados por plataforma y ninguna cuenta real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseIrc, twitchChatMessage } from '../src/chat.mjs';
import { youtubeChatMessage } from '../src/alerts.mjs';
import { createApp } from '../src/server.mjs';

const iso = ms => new Date(ms).toISOString();
const yt = (authorId, user = 'Ana', extra = {}) => youtubeChatMessage({
  id: 'message-' + user, snippet: { type: 'textMessageEvent', displayMessage: 'hola', publishedAt: '2026-01-01T12:00:00.000Z' },
  authorDetails: { channelId: authorId, displayName: user, ...extra },
});
const tw = (authorId, user = 'Ana', extra = '') => twitchChatMessage(parseIrc(
  `@id=message-${user};${authorId === undefined ? '' : `user-id=${authorId};`}room-id=streamer-1;display-name=${user};tmi-sent-ts=1767268800000;${extra} :ana!ana@host PRIVMSG #canal :hola`,
));

async function fixture(t, { current, backup } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-chat-metrics-'));
  await mkdir(path.join(root, 'data'));
  for (const [name, value] of [['session-current.json', current], ['session-current.backup.json', backup]]) {
    if (value) await writeFile(path.join(root, 'data', name), JSON.stringify(value));
  }
  const apps = [];
  t.after(async () => {
    for (const app of apps) {
      app.viewers.halt();
      await app.youtube.quiescePoll().catch(() => {});
      await app.chat.quiesceChat().catch(() => {});
      await app.drainAutoSession().catch(() => {});
      await app.drainChatMetrics?.().catch(() => {});
      await app.session.flush().catch(() => {});
      await app.closeHttp().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), log: () => {} });
    apps.push(app);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const get = async url => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.json(); };
    const post = async (url, body = {}) => {
      const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 200); return r.json();
    };
    return { app, base, get, post };
  }
  return { start, root };
}

test('Twitch conserva user-id y room-id sin usar el nombre visible como identidad', () => {
  const a = tw('author-1'), renamed = tw('author-1', 'Otro');
  assert.equal(a.authorId, 'author-1'); assert.equal(renamed.authorId, a.authorId);
  assert.equal(a.roomId, 'streamer-1'); assert.notEqual(a.user, renamed.user);
  const legacy = twitchChatMessage(parseIrc(':ana!ana@host PRIVMSG #canal :hola'));
  assert.equal(legacy.authorId, undefined); assert.equal(legacy.roomId, undefined);
  assert.equal(legacy.user, 'ana'); assert.equal(legacy.text, 'hola');
});

test('YouTube conserva channelId del autor sin confundirlo con id del mensaje', () => {
  const a = yt('author-1'), renamed = yt('author-1', 'Otro');
  assert.equal(a.authorId, 'author-1'); assert.equal(renamed.authorId, a.authorId);
  assert.notEqual(a.id, renamed.id); assert.notEqual(a.user, renamed.user);
  assert.equal(yt(undefined).authorId, undefined);
  assert.equal(yt('owner', 'Canal', { isChatOwner: true }).owner, true);
});

test('chat público REST y SSE conserva los campos previos y no filtra IDs internos', async t => {
  const ctx = await (await fixture(t)).start();
  const publicMessage = { id: 'tw:public', platform: 'twitch', user: 'Ana', login: 'ana', color: '', text: 'hola',
    parts: [{ t: 'hola' }], mod: false, owner: false, member: false, vip: false, highlighted: false, at: '2026-01-01T12:00:00.000Z' };
  const sent = [], send = ctx.app.bus.send.bind(ctx.app.bus);
  ctx.app.bus.send = (event, data, ...args) => { if (event === 'chat') sent.push(structuredClone(data)); return send(event, data, ...args); };
  ctx.app.engine.handleChat({ ...publicMessage, authorId: 'private-author', roomId: 'private-room' });
  const expected = { ...publicMessage, command: false, used: false };
  assert.deepEqual(await ctx.get('/api/chat'), [expected]);
  assert.deepEqual(sent, [expected]);
});


const video = { state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1', title: 'Directo' };
async function startLive(ctx) {
  ctx.app.twitch.userId = 'streamer-1';
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await ctx.app.session.transitionChain;
  ctx.app.youtube.setStatus(video);
  ctx.app.viewers.emit('streamIdentity', { streamId: 'stream-1', startedAt: iso(Date.now()) }, ctx.app.viewers.identityEpoch());
  await ctx.app.session.transitionChain;
  return Date.parse((await ctx.get('/api/session')).startedAt);
}
async function message(ctx, platform, author, user = 'Ana', extra = {}) {
  if (platform === 'twitch') ctx.app.chat.emit('message', { ...tw(author, user), ...extra });
  else ctx.app.youtube.emit('chat', { ...yt(author, user), ...extra }, {
    target: ctx.app.session.captureIdentity(), videoId: ctx.app.youtube.status.videoId, liveChatId: ctx.app.youtube.status.liveChatId,
  });
  await ctx.app.session.transitionChain;
}
function rpc(t, base) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    env: { ANTENA_URL: base, ANTENA_NO_EMBED: '1', TMPDIR: tmpdir(), PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', id = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  t.after(() => child.stdin.end());
  return async (method, params = {}) => {
    const n = ++id;
    let timer;
    const response = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MCP no respondió')), 5000);
      pending.set(n, resolve);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    try { return await response; } finally { clearTimeout(timer); }
  };
}
async function tool(call, name, args = {}) {
  const r = await call('tools/call', { name, arguments: args });
  assert.equal(r.result.isError, undefined);
  return JSON.parse(r.result.content[0].text);
}

test('autores repetidos/renombrados, media y minutos por plataforma sin exponer identidad', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T12:00:00.000Z') });
  const ctx = await (await fixture(t)).start(), start = await startLive(ctx);
  await message(ctx, 'twitch', 'author-tw', 'Ana');
  await message(ctx, 'youtube', 'author-yt', 'Ana');
  t.mock.timers.tick(30_000);
  await message(ctx, 'twitch', 'author-tw', 'Renombrada');
  await message(ctx, 'youtube', 'author-yt-2', 'Ana');
  t.mock.timers.tick(30_000);
  await message(ctx, 'twitch', 'author-tw-2', 'Ana');
  await message(ctx, 'youtube', 'author-yt', 'Otra');
  t.mock.timers.tick(60_000);
  await message(ctx, 'twitch', undefined, 'SinID');
  t.mock.timers.tick(30_000);
  await ctx.app.session.endCurrent();
  const current = await ctx.get('/api/session');
  const expected = {
    twitch: { uniqueChatters: 2, messages: 4, messagesPerMinute: 1.6, minutes: [
      { at: iso(start), messages: 2 }, { at: iso(start + 60_000), messages: 1 }, { at: iso(start + 120_000), messages: 1 },
    ] },
    youtube: { uniqueChatters: 2, messages: 3, messagesPerMinute: 1.2, minutes: [
      { at: iso(start), messages: 2 }, { at: iso(start + 60_000), messages: 1 },
    ] },
  };
  assert.deepEqual(current.chatMetrics, expected);
  assert.equal(current.chatStats, undefined);
  assert.equal(JSON.stringify(current).includes('author-tw'), false);
  const summary = await ctx.get('/api/session/summary?format=json');
  assert.deepEqual(summary.chatMetrics, expected); assert.equal(summary.chatStats, undefined);
  const list = await ctx.get('/api/sessions');
  const small = Object.fromEntries(Object.entries(expected).map(([p, { minutes, ...metrics }]) => [p, metrics]));
  assert.deepEqual(list.current.chatMetrics, small);
  const call = rpc(t, ctx.base);
  assert.deepEqual(await tool(call, 'listar_directos'), list);
  assert.deepEqual(await tool(call, 'resumen_directo', { formato: 'json' }), summary);
  const descriptions = (await call('tools/list')).result.tools;
  assert.match(descriptions.find(x => x.name === 'resumen_directo').description, /chatMetrics/);
  const next = await ctx.post('/api/session/new', { title: 'Siguiente' });
  assert.equal(next.session.chatStats, undefined);
  const past = (await ctx.get('/api/sessions')).past.find(x => x.id === current.id);
  assert.deepEqual(past.chatMetrics, small);
  const archived = await ctx.get('/api/session/summary?format=json&id=' + current.id);
  assert.deepEqual(archived.chatMetrics, expected); assert.equal(archived.chatStats, undefined);
});

test('simular_chat, dueños y otro canal no cambian recuentos; conservan su chat público', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start(); await startLive(ctx);
  await message(ctx, 'twitch', 'valid-author'); await message(ctx, 'youtube', 'valid-author');
  const before = (await ctx.get('/api/session')).chatMetrics;
  assert.ok(before);
  await message(ctx, 'twitch', 'streamer-1', 'Streamer');
  await message(ctx, 'youtube', 'owner-yt', 'Canal', { owner: true });
  await message(ctx, 'twitch', 'other', 'Otro', { roomId: 'another-channel' });
  assert.deepEqual(await ctx.post('/api/chat/simulate', { user: 'Sim', text: 'hola', authorId: 'forged', source: 'twitch', real: true }), { ok: true });
  assert.deepEqual(await tool(rpc(t, ctx.base), 'simular_chat', { usuario: 'Sim2', texto: 'hola', plataforma: 'youtube' }), { ok: true });
  await ctx.app.session.transitionChain;
  assert.deepEqual((await ctx.get('/api/session')).chatMetrics, before);
  const chat = await ctx.get('/api/chat');
  assert.equal(chat.length, 7);
  assert.equal(chat.filter(x => x.id.startsWith('sim:')).length, 2);
  assert.equal(chat.some(x => x.authorId || x.roomId), false);
});

test('el promedio de una sesión sin duración es null; los mensajes usados sí cuentan', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start(); await startLive(ctx);
  ctx.app.interactive.onChat = () => true;
  await message(ctx, 'twitch', 'author');
  const current = await ctx.get('/api/session');
  assert.deepEqual(current.chatMetrics?.twitch, { uniqueChatters: 1, messages: 1, messagesPerMinute: null,
    minutes: [{ at: current.startedAt, messages: 1 }] });
  assert.equal((await ctx.get('/api/chat'))[0].used, true);
  t.mock.timers.tick(30_000);
  assert.equal((await ctx.get('/api/session')).chatMetrics.twitch.messagesPerMinute, 2);
});

test('más de 300 mensajes y autores únicos sobreviven al checkpoint y reinicio', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t), first = await f.start(), start = await startLive(first);
  for (let i = 0; i < 320; i++) await message(first, 'twitch', 'same-author', 'Autor' + i);
  await message(first, 'youtube', 'yt-author');
  assert.equal((await first.get('/api/chat?limit=1000')).length, 300);
  assert.equal((await first.get('/api/session')).chatMetrics?.twitch.messages, 320);
  const id = (await first.get('/api/session')).id;
  first.app.viewers.halt(); await first.app.youtube.quiescePoll(); await first.app.drainAutoSession();
  await first.app.drainChatMetrics(); await first.app.session.flush(); await first.app.closeHttp();
  t.mock.timers.tick(120_000);
  const second = await f.start(); await startLive(second);
  assert.equal((await second.get('/api/session')).id, id);
  await message(second, 'twitch', 'same-author', 'OtroNombre'); await message(second, 'twitch', 'new-author', 'Autor0');
  t.mock.timers.tick(60_000); await second.app.session.endCurrent();
  const current = await second.get('/api/session');
  assert.deepEqual(current.chatMetrics.twitch, { uniqueChatters: 2, messages: 322, messagesPerMinute: 322 / 3,
    minutes: [{ at: iso(start), messages: 320 }, { at: iso(start + 120_000), messages: 2 }] });
  assert.equal(current.chatMetrics.youtube.messages, 1);
});

test('solo sesiones automáticas activas: sin contabilizar antes, en manuales o después del cierre', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start(); ctx.app.twitch.userId = 'streamer-1';
  await message(ctx, 'twitch', 'before'); assert.equal((await ctx.get('/api/session')).chatMetrics, undefined);
  await startLive(ctx); await ctx.post('/api/session/new', { title: 'Manual' });
  await message(ctx, 'twitch', 'manual'); assert.equal((await ctx.get('/api/session')).chatMetrics, undefined);
  ctx.app.meld.setStatus({ streaming: false }); await ctx.app.session.transitionChain;
  ctx.app.meld.setStatus({ streaming: true }); await ctx.app.session.transitionChain;
  await message(ctx, 'twitch', 'live');
  ctx.app.meld.setStatus({ streaming: false }); await ctx.app.session.transitionChain;
  const ended = await ctx.get('/api/session');
  assert.equal(ended.chatMetrics?.twitch.messages, 1);
  await message(ctx, 'twitch', 'after');
  assert.deepEqual((await ctx.get('/api/session')).chatMetrics, ended.chatMetrics);
});


function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

test('mensajes durante un inicio retenido esperan su sesión sin perder la hora de recepción', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start(); ctx.app.twitch.userId = 'streamer-1';
  const gate = deferred(), entered = deferred(), flush = ctx.app.session.flush.bind(ctx.app.session);
  t.after(() => gate.resolve());
  let first = true;
  ctx.app.session.flush = async (...args) => {
    if (first) { first = false; entered.resolve(); await gate.promise; }
    return flush(...args);
  };
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await entered.promise;
  ctx.app.youtube.setStatus(video);
  ctx.app.chat.emit('message', tw('tw-author'));
  ctx.app.youtube.emit('chat', yt('yt-author'), { ...ctx.app.youtube.chatEpoch(), videoId: video.videoId, liveChatId: video.liveChatId });
  t.mock.timers.tick(1000); gate.resolve();
  await ctx.app.session.transitionChain;
  const current = await ctx.get('/api/session');
  for (const p of ['twitch', 'youtube']) assert.deepEqual(current.chatMetrics[p], {
    uniqueChatters: 1, messages: 1, messagesPerMinute: null, minutes: [{ at: current.startedAt, messages: 1 }],
  });
});

test('un mensaje de YouTube en el rollover pendiente va al directo nuevo, no al anterior', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start(); await startLive(ctx);
  await message(ctx, 'youtube', 'old-author');
  const before = await ctx.get('/api/session'), gate = deferred(), entered = deferred();
  t.after(() => gate.resolve());
  const capture = ctx.app.session.captureIdentity.bind(ctx.app.session);
  ctx.app.session.captureIdentity = () => capture().then(async identity => { entered.resolve(); await gate.promise; return identity; });
  ctx.app.meld.setStatus({ state: 'reintentando' }); ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await entered.promise; t.mock.timers.tick(30_000);
  const nextVideo = { ...video, videoId: 'video-2', liveChatId: 'chat-2' };
  ctx.app.youtube.setStatus(nextVideo);
  ctx.app.youtube.emit('chat', yt('new-author'), { ...ctx.app.youtube.chatEpoch(), videoId: nextVideo.videoId, liveChatId: nextVideo.liveChatId });
  gate.resolve(); await ctx.app.session.transitionChain;
  t.mock.timers.tick(10_000); await ctx.app.session.endCurrent();
  const current = await ctx.get('/api/session');
  assert.notEqual(current.id, before.id);
  assert.equal(current.platforms.youtube.videoId, 'video-2');
  assert.deepEqual(current.chatMetrics.youtube, { uniqueChatters: 1, messages: 1, messagesPerMinute: 6,
    minutes: [{ at: current.startedAt, messages: 1 }] });
  const old = await ctx.get('/api/session/summary?format=json&id=' + before.id);
  assert.equal(old.chatMetrics.youtube.messages, 1);
});

test('un poll viejo que emite tarde conserva su contexto y no modifica los recuentos del directo nuevo', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start(); await startLive(ctx);
  await message(ctx, 'youtube', 'old-author'); const oldId = (await ctx.get('/api/session')).id;
  const response = deferred(), entered = deferred(); let requestedChat;
  t.after(() => response.resolve({ items: [] }));
  ctx.app.youtube.api = async (url, params) => {
    assert.equal(url, '/liveChat/messages'); requestedChat = params.liveChatId; entered.resolve(); return response.promise;
  };
  ctx.app.youtube.running = true; ctx.app.youtube.primed = true;
  const poll = ctx.app.youtube.poll(); await entered.promise;
  ctx.app.youtube.running = false; // Solo queda la respuesta anterior, sin iniciar otra búsqueda.
  ctx.app.meld.setStatus({ streaming: false }); await ctx.app.session.transitionChain;
  t.mock.timers.tick(30_000);
  ctx.app.meld.setStatus({ streaming: true }); await ctx.app.session.transitionChain;
  ctx.app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2' });
  await ctx.app.session.transitionChain;
  await message(ctx, 'youtube', 'new-author');
  const before = (await ctx.get('/api/session')).chatMetrics;
  ctx.app.youtube.primed = true;
  response.resolve({ items: [{ id: 'late', snippet: { type: 'textMessageEvent', displayMessage: 'tarde' },
    authorDetails: { channelId: 'late-author', displayName: 'Tarde' } }] });
  await poll; await ctx.app.youtube.quiescePoll(); await ctx.app.session.transitionChain;
  assert.equal(requestedChat, 'chat-1');
  assert.equal((await ctx.get('/api/chat')).some(m => m.id === 'yt:late'), true, 'conservar el comportamiento anterior del chat');
  assert.deepEqual((await ctx.get('/api/session')).chatMetrics, before);
  assert.equal((await ctx.get('/api/session/summary?format=json&id=' + oldId)).chatMetrics.youtube.messages, 1);
});

test('la validación de contabilidad recupera el backup sin publicar el conjunto de autores', async t => {
  const at = iso(Date.now() - 60_000);
  const valid = { authorIds: ['saved-author'], minutes: [{ at, messages: 1 }] };
  const backup = { id: 'chat-backup', startedAt: at, endedAt: iso(Date.now()), events: [], meldAutoSession: true, chatStats: { twitch: valid } };
  const invalid = [
    ['array', { twitch: { ...valid, authorIds: {} } }],
    ['identity', { twitch: { ...valid, authorIds: [1] } }],
    ['duplicate', { twitch: { ...valid, authorIds: ['a', 'a'], minutes: [{ at, messages: 2 }] } }],
    ['zero', { twitch: { ...valid, minutes: [{ at, messages: 0 }] } }],
    ['date', { twitch: { ...valid, minutes: [{ at: 'inválida', messages: 1 }] } }],
    ['order', { twitch: { ...valid, minutes: [{ at, messages: 1 }, { at, messages: 1 }] } }],
    ['count', { twitch: { ...valid, authorIds: ['a', 'b'] } }],
    ['platform', { unknown: valid }],
  ];
  for (const [name, chatStats] of invalid) await t.test(name, async child => {
    const current = { ...backup, id: 'chat-invalid', chatStats };
    const ctx = await (await fixture(child, { current, backup })).start();
    const restored = await ctx.get('/api/session');
    assert.equal(restored.id, 'chat-backup');
    assert.equal(restored.chatMetrics.twitch.messages, 1);
    assert.equal(restored.chatMetrics.twitch.uniqueChatters, 1);
    assert.equal(restored.chatStats, undefined);
    assert.equal(JSON.stringify(restored).includes('saved-author'), false);
  });
});

test('un fallo de contabilidad no rompe el chat y el drenaje conserva el fallo', async t => {
  const ctx = await (await fixture(t)).start(); await startLive(ctx);
  await message(ctx, 'twitch', 'before'); const before = (await ctx.get('/api/session')).chatMetrics;
  t.mock.method(ctx.app.session, 'recordChat', () => { throw new Error('fallo sintético'); });
  await message(ctx, 'twitch', 'after');
  const current = await ctx.get('/api/session');
  assert.equal(current.chatMetrics.twitch.messages, before.twitch.messages);
  assert.equal(current.chatMetrics.twitch.uniqueChatters, before.twitch.uniqueChatters);
  assert.equal((await ctx.get('/api/chat')).length, 2);
  await assert.rejects(ctx.app.drainChatMetrics(), /completar las métricas/);
});


test('S7: los minutos públicos excluyen extras privados del checkpoint', async t => {
  const at = iso(Date.now() - 60_000);
  const backup = { id: 'backup', startedAt: at, endedAt: iso(Date.now()), events: [], meldAutoSession: true,
    chatStats: { youtube: { authorIds: ['private-author'], minutes: [{ at, messages: 1 }] } } };
  const current = structuredClone(backup);
  Object.assign(current.chatStats.youtube.minutes[0], { authorIds: ['private-author'], text: 'private-text' });
  const ctx = await (await fixture(t, { current, backup })).start();
  for (const url of ['/api/session', '/api/session/summary?format=json']) {
    const json = await ctx.get(url);
    assert.deepEqual(json.chatMetrics.youtube.minutes, [{ at, messages: 1 }]);
    assert.doesNotMatch(JSON.stringify(json), /private-author|private-text/);
  }
});
