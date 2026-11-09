// #100: identidad de cada directo a través de Meld, las plataformas, REST y MCP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.mjs';

const video = { state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1', title: 'Primer directo' };
const stream = { id: 'stream-1', started_at: '2026-01-01T10:00:00Z', viewer_count: 0 };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(fn, label) {
  const limit = Date.now() + 4000;
  while (Date.now() < limit) { const value = await fn(); if (value) return value; await tick(); }
  assert.fail(`No llegó ${label}`);
}
function iso(value) { assert.equal(typeof value, 'string'); assert.equal(new Date(value).toISOString(), value); }

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-session-identity-'));
  const apps = [];
  async function start() {
    const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), log: () => {} });
    apps.push(app);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const get = async p => { const r = await fetch(base + p); assert.equal(r.status, 200); return r.json(); };
    const post = async (p, body = {}) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 200); return r.json();
    };
    return { app, base, get, post };
  }
  t.after(async () => {
    for (const app of apps) {
      app.viewers.halt();
      await app.drainAutoSession().catch(() => {});
      await app.session.flush().catch(() => {});
      await app.closeHttp().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  return { start };
}
function stubTwitch(app, row) {
  app.store.secrets.twitch = { access: 'fake' };
  app.twitch.userId = 'test-user';
  app.twitch.helix = async (method, url) => {
    assert.equal(method, 'GET'); assert.equal(url, '/streams?user_id=test-user');
    return { ok: true, data: { data: row ? [row] : [] } };
  };
  app.youtube.api = async () => ({ items: [] });
}
async function live(ctx) {
  const old = (await ctx.get('/api/session')).id;
  ctx.app.meld.emit('streaming', true);
  return until(async () => { const s = await ctx.get('/api/session'); return s.id !== old && s; }, 'nueva sesión');
}
function mcp(t, base) {
  const child = spawn(process.execPath, [new URL('../src/mcp.mjs', import.meta.url).pathname], {
    env: { ANTENA_URL: base, ANTENA_NO_EMBED: '1', TMPDIR: tmpdir(), PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', id = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  t.after(() => { child.stdin.end(); });
  return async (method, params = {}) => {
    const n = ++id;
    const response = new Promise(resolve => pending.set(n, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    return response;
  };
}

test('Meld abre y guarda los identificadores aunque lleguen durante el corte; REST y MCP los muestran', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  const old = (await ctx.get('/api/session')).id;
  stubTwitch(ctx.app, stream);
  ctx.app.meld.emit('streaming', true);
  ctx.app.youtube.setStatus(video);
  await ctx.app.viewers.tick();
  const current = await until(async () => {
    const s = await ctx.get('/api/session');
    return s.id !== old && s.platforms?.youtube && s.platforms?.twitch && s;
  }, 'identificadores de ambas plataformas');
  assert.deepEqual({ ...current.platforms.youtube, seenAt: undefined }, { videoId: video.videoId, liveChatId: video.liveChatId, title: video.title, seenAt: undefined });
  assert.deepEqual({ ...current.platforms.twitch, seenAt: undefined }, { streamId: stream.id, startedAt: stream.started_at, seenAt: undefined });
  iso(current.platforms.youtube.seenAt); iso(current.platforms.twitch.seenAt);
  const rest = await ctx.get('/api/sessions');
  assert.deepEqual(rest.current.platforms, current.platforms);
  assert.deepEqual({ id: rest.current.id, title: rest.current.title, startedAt: rest.current.startedAt, events: rest.current.events },
    { id: current.id, title: current.title, startedAt: current.startedAt, events: current.eventCount });
  assert.deepEqual((await ctx.get('/api/session/summary?format=json')).platforms, current.platforms);
  const rpc = mcp(t, ctx.base);
  const toolList = await rpc('tools/list');
  assert.match(toolList.result.tools.find(tool => tool.name === 'listar_directos').description, /platforms/);
  const result = await rpc('tools/call', { name: 'listar_directos', arguments: {} });
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(JSON.parse(result.result.content[0].text), rest);
  await ctx.app.session.flush();
  const reopened = await start();
  assert.deepEqual((await reopened.get('/api/session')).platforms, current.platforms, 'la identidad sobrevive al reinicio');
});

test('conexión ya en directo y reconexión: una sola sesión, incluso tras reiniciar antena', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  const previous = (await ctx.get('/api/session')).id;
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus(video);
  const first = await until(async () => {
    const s = await ctx.get('/api/session'); return s.id !== previous && s.platforms?.youtube && s;
  }, 'sesión iniciada con Meld ya emitiendo');
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await tick(); await tick();
  assert.equal((await ctx.get('/api/session')).id, first.id);
  await ctx.app.session.flush();
  const reopened = await start();
  reopened.app.meld.setStatus({ state: 'conectado', streaming: true });
  await tick(); await tick();
  assert.equal((await reopened.get('/api/session')).id, first.id);
  assert.deepEqual((await reopened.get('/api/session')).platforms, first.platforms);
});

test('al terminar se cierra la misma sesión y un directo posterior abre otra sin alterar endedAt', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  const first = await live(ctx);
  ctx.app.youtube.setStatus(video);
  await until(async () => (await ctx.get('/api/session')).platforms?.youtube, 'YouTube');
  ctx.app.meld.emit('streaming', false);
  const ended = await until(async () => { const s = await ctx.get('/api/session'); return s.endedAt && s; }, 'cierre');
  assert.equal(ended.id, first.id); iso(ended.endedAt);
  assert.equal((await ctx.get('/api/sessions')).current.endedAt, ended.endedAt);
  ctx.app.meld.emit('streaming', true);
  const second = await until(async () => { const s = await ctx.get('/api/session'); return s.id !== first.id && s; }, 'segundo directo');
  assert.equal(second.endedAt, undefined);
  const listed = await until(async () => (await ctx.get('/api/sessions')).past.find(s => s.id === first.id), 'archivo');
  assert.equal(listed.endedAt, ended.endedAt);
  assert.equal(listed.events, 0);
  assert.deepEqual(listed.platforms.youtube, ended.platforms.youtube);
  const archived = await ctx.get(`/api/session/summary?format=json&id=${first.id}`);
  assert.equal(archived.endedAt, ended.endedAt);
  assert.deepEqual(archived.platforms, ended.platforms);
});

test('plataforma sin conectar ausente, nunca inventada, incluso en archivo', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  const first = await live(ctx);
  ctx.app.youtube.setStatus(video);
  const known = await until(async () => (await ctx.get('/api/session')).platforms?.youtube, 'YouTube');
  assert.equal(known.videoId, video.videoId);
  assert.equal(Object.hasOwn((await ctx.get('/api/session')).platforms, 'twitch'), false);
  await ctx.post('/api/session/new');
  const past = (await ctx.get('/api/sessions')).past.find(s => s.id === first.id);
  assert.deepEqual(Object.keys(past.platforms), ['youtube']);
});

test('autoSession desactivado no abre ni cierra y registra datos reales en la sesión actual', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.store.config.meld.autoSession = false;
  const before = await ctx.get('/api/session');
  ctx.app.meld.emit('streaming', true);
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus(video);
  stubTwitch(ctx.app, stream); await ctx.app.viewers.tick();
  const s = await until(async () => { const x = await ctx.get('/api/session'); return x.platforms?.youtube && x.platforms?.twitch && x; }, 'identidad manual');
  ctx.app.meld.emit('streaming', false);
  await tick(); await tick();
  const after = await ctx.get('/api/session');
  assert.equal(after.id, before.id); assert.equal(after.endedAt, undefined);
  assert.equal(after.platforms.youtube.videoId, video.videoId);
  assert.equal(after.platforms.twitch.streamId, stream.id);
  assert.deepEqual((await ctx.get('/api/sessions')).past, []);
});

test('si cambian los ids durante el mismo directo se conserva la primera identidad y seenAt', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start(); await live(ctx);
  ctx.app.youtube.setStatus(video); stubTwitch(ctx.app, stream); await ctx.app.viewers.tick();
  const first = await until(async () => { const x = await ctx.get('/api/session'); return x.platforms?.youtube && x.platforms?.twitch && x.platforms; }, 'primera identidad');
  ctx.app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2', title: 'Otro' });
  stubTwitch(ctx.app, { ...stream, id: 'stream-2', started_at: '2026-01-02T10:00:00Z' });
  await ctx.app.viewers.tick(); await tick();
  assert.deepEqual((await ctx.get('/api/session')).platforms, first);
});

test('listados REST y MCP mantienen los campos previos para una sesión antigua sin platforms', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  const original = await ctx.get('/api/session');
  await ctx.post('/api/session/new', { title: 'Siguiente' });
  const out = await ctx.get('/api/sessions');
  const legacy = out.past.find(s => s.id === original.id);
  assert.deepEqual(Object.keys(out.current).sort(), ['events', 'id', 'startedAt', 'title']);
  assert.deepEqual(Object.keys(legacy).sort(), ['endedAt', 'events', 'id', 'startedAt', 'title']);
  assert.equal(legacy.title, original.title); assert.equal(legacy.startedAt, original.startedAt);
  assert.equal(legacy.events, 0); iso(legacy.endedAt);
  const rpc = mcp(t, ctx.base);
  const result = await rpc('tools/call', { name: 'listar_directos', arguments: {} });
  assert.deepEqual(JSON.parse(result.result.content[0].text), out);
});

test('las observaciones anteriores al inicio no se copian; una nueva observación sí se registra', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.youtube.setStatus(video); stubTwitch(ctx.app, stream); await ctx.app.viewers.tick();
  await until(async () => (await ctx.get('/api/session')).platforms?.twitch, 'observación anterior');
  const first = await live(ctx);
  await tick();
  assert.equal((await ctx.get('/api/session')).platforms, undefined);
  ctx.app.youtube.setStatus(video); await ctx.app.viewers.tick();
  const s = await until(async () => { const x = await ctx.get('/api/session'); return x.id === first.id && x.platforms?.youtube && x.platforms?.twitch && x; }, 'identificadores observados de nuevo');
  assert.equal(s.platforms.youtube.videoId, video.videoId);
  assert.equal(s.platforms.twitch.streamId, stream.id);
});

test('tras reiniciar, Twitch igual reutiliza la sesión y Twitch distinto cierra la anterior', { timeout: 20000 }, async t => {
  for (const changed of [false, true]) await t.test(changed ? 'stream B' : 'stream A', async t => {
    const { start } = await setup(t); const firstApp = await start();
    const first = await live(firstApp);
    stubTwitch(firstApp.app, stream); await firstApp.app.viewers.tick();
    const original = await until(async () => (await firstApp.get('/api/session')).platforms?.twitch, 'Twitch A');
    await firstApp.app.drainAutoSession(); await firstApp.app.session.flush(); await firstApp.app.closeHttp();
    const reopened = await start();
    reopened.app.meld.setStatus({ state: 'conectado', streaming: true });
    assert.equal((await reopened.get('/api/session')).id, first.id);
    const row = changed ? { ...stream, id: 'stream-2', started_at: '2026-01-02T10:00:00Z' } : stream;
    stubTwitch(reopened.app, row); await reopened.app.viewers.tick();
    if (!changed) {
      await tick(); await tick();
      const same = await reopened.get('/api/session');
      assert.equal(same.id, first.id); assert.equal(same.endedAt, undefined);
      assert.deepEqual(same.platforms.twitch, original);
    } else {
      const next = await until(async () => { const s = await reopened.get('/api/session'); return s.id !== first.id && s.platforms?.twitch?.streamId === row.id && s; }, 'nuevo directo Twitch B');
      assert.equal(next.endedAt, undefined);
      const old = await until(async () => (await reopened.get('/api/sessions')).past.find(s => s.id === first.id), 'archivo Twitch A');
      iso(old.endedAt); assert.deepEqual(old.platforms.twitch, original);
      const full = await reopened.get(`/api/session/summary?format=json&id=${first.id}`);
      assert.equal(full.endedAt, old.endedAt); assert.deepEqual(full.platforms.twitch, original);
    }
  });
});

test('tras reconectar, una coincidencia inicial no oculta un identificador distinto posterior', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  stubTwitch(ctx.app, stream); await ctx.app.viewers.tick();
  const first = await until(async () => { const s = await ctx.get('/api/session'); return s.platforms?.twitch && s; }, 'stream A');
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await ctx.app.viewers.tick();
  assert.equal((await ctx.get('/api/session')).id, first.id, 'A conserva la sesión');
  stubTwitch(ctx.app, { ...stream, id: 'stream-2' }); await ctx.app.viewers.tick();
  const next = await until(async () => { const s = await ctx.get('/api/session'); return s.id !== first.id && s.platforms?.twitch?.streamId === 'stream-2' && s; }, 'stream B posterior');
  assert.equal(next.endedAt, undefined);
  const old = await until(async () => (await ctx.get('/api/sessions')).past.find(s => s.id === first.id), 'archivo de A');
  iso(old.endedAt); assert.equal(old.platforms.twitch.streamId, stream.id);
});

test('una reconexión de Meld detecta otro vídeo YouTube, sin sobrescribir la sesión previa', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus(video);
  const first = await until(async () => { const s = await ctx.get('/api/session'); return s.platforms?.youtube && s; }, 'vídeo inicial');
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2', title: 'Segundo' });
  const next = await until(async () => { const s = await ctx.get('/api/session'); return s.id !== first.id && s.platforms?.youtube?.videoId === 'video-2' && s; }, 'nuevo vídeo');
  assert.equal(next.platforms.youtube.liveChatId, 'chat-2');
  const old = await until(async () => (await ctx.get('/api/sessions')).past.find(s => s.id === first.id), 'archivo del vídeo inicial');
  iso(old.endedAt); assert.deepEqual(old.platforms.youtube, first.platforms.youtube);
});

test('sin identificadores previos, la reconexión conserva la sesión al observar una plataforma', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  const first = await live(ctx);
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  stubTwitch(ctx.app, stream); await ctx.app.viewers.tick();
  const current = await until(async () => { const s = await ctx.get('/api/session'); return s.platforms?.twitch && s; }, 'primer identificador');
  assert.equal(current.id, first.id); assert.equal(current.endedAt, undefined);
  assert.equal(current.platforms.twitch.streamId, stream.id);
});

test('stop/start inmediato no copia YouTube anterior, pero acepta un anuncio nuevo del mismo u otro vídeo', { timeout: 20000 }, async t => {
  for (const changed of [false, true]) await t.test(changed ? 'video V2' : 'video V1 reanunciado', async t => {
    const { start } = await setup(t); const ctx = await start();
    const first = await live(ctx);
    ctx.app.youtube.setStatus(video);
    await until(async () => (await ctx.get('/api/session')).platforms?.youtube, 'vídeo V1');
    ctx.app.meld.emit('streaming', false);
    ctx.app.meld.emit('streaming', true);
    const next = await until(async () => { const s = await ctx.get('/api/session'); return s.id !== first.id && s; }, 'siguiente directo');
    await tick(); assert.equal((await ctx.get('/api/session')).platforms?.youtube, undefined);
    const fresh = changed ? { ...video, videoId: 'video-2', liveChatId: 'chat-2' } : video;
    ctx.app.youtube.setStatus(fresh);
    const observed = await until(async () => (await ctx.get('/api/session')).platforms?.youtube, 'vídeo anunciado tras empezar');
    assert.equal(observed.videoId, fresh.videoId); assert.equal(observed.liveChatId, fresh.liveChatId);
    assert.equal((await ctx.get('/api/session')).id, next.id);
    const old = await until(async () => (await ctx.get('/api/sessions')).past.find(s => s.id === first.id), 'directo cerrado');
    iso(old.endedAt); assert.equal(old.platforms.youtube.videoId, video.videoId);
  });
});
