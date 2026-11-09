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

test('autoSession desactivado no abre, cierra ni registra identidades', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.store.config.meld.autoSession = false;
  const before = await ctx.get('/api/session');
  ctx.app.meld.emit('streaming', true);
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus(video);
  stubTwitch(ctx.app, stream); await ctx.app.viewers.tick();
  ctx.app.meld.emit('streaming', false);
  await tick(); await tick();
  assert.deepEqual(await ctx.get('/api/session'), before);
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

test('con espectadores desactivados se reintenta Twitch sin métricas, récord ni alertas', async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.store.config.viewers.enabled = false;
  ctx.app.store.config.viewers.confirmPolls = 1;
  ctx.app.store.config.viewers.warmupMin = 0;
  ctx.app.store.config.viewers.alertFirst = true;
  const before = await ctx.get('/api/viewers');
  await live(ctx);
  stubTwitch(ctx.app, null); await ctx.app.viewers.tick();
  assert.equal((await ctx.get('/api/session')).platforms, undefined);
  stubTwitch(ctx.app, { ...stream, viewer_count: 999 }); await ctx.app.viewers.tick();
  const identity = await until(async () => (await ctx.get('/api/session')).platforms?.twitch, 'identidad sin espectadores');
  assert.equal(identity.streamId, stream.id); assert.equal(identity.startedAt, stream.started_at);
  assert.deepEqual(await ctx.get('/api/viewers'), before);
  assert.equal((await ctx.get('/api/session')).eventCount, 0);
});

test('una búsqueda YouTube iniciada en el directo anterior no identifica el siguiente', async t => {
  const { start } = await setup(t); const ctx = await start();
  await live(ctx);
  ctx.app.youtube.cfg.apiKey = 'fake'; ctx.app.youtube.cfg.video = 'abcdefghijk';
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const requested = new Promise(r => { entered = r; });
  t.after(() => { release(); return ctx.app.youtube.stop(); });
  ctx.app.youtube.api = async p => {
    if (p === '/videos') { entered(); await gate; return { items: [{ liveStreamingDetails: { activeLiveChatId: 'old-chat' }, snippet: { title: 'Old' } }] }; }
    return { items: [] };
  };
  const pending = ctx.app.youtube.start();
  await requested;
  ctx.app.meld.emit('streaming', false); ctx.app.meld.emit('streaming', true);
  release(); await pending; await ctx.app.session.transitionChain; await tick();
  assert.equal((await ctx.get('/api/session')).platforms?.youtube, undefined);
});

test('reconectar mientras se guarda el cierre abre otra sesión para la nueva identidad', { timeout: 12000 }, async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus(video);
  const first = await until(async () => { const s = await ctx.get('/api/session'); return s.platforms?.youtube && s; }, 'vídeo anterior');
  const { createJsonWriter } = await import('../src/json-file.mjs');
  const writer = createJsonWriter();
  let release, entered, armed = true;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  t.after(() => release());
  ctx.app.session.writer = (f, d, o = {}) => writer(f, d, { ...o, after: Promise.resolve(o.after).then(async () => {
    if (armed && f.endsWith('session-current.backup.json')) { armed = false; entered(); await gate; }
  }) });
  ctx.app.meld.emit('streaming', false);
  await started;
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2' });
  release();
  const next = await until(async () => { const s = await ctx.get('/api/session'); return s.id !== first.id && s.platforms?.youtube?.videoId === 'video-2' && s; }, 'directo tras cierre retenido');
  assert.equal(next.endedAt, undefined);
  const old = await until(async () => (await ctx.get('/api/sessions')).past.find(s => s.id === first.id), 'archivo tras cierre retenido');
  iso(old.endedAt); assert.equal(old.platforms.youtube.videoId, video.videoId);
});

test('una observación anterior al corte detectado al reconectar no se atribuye al directo nuevo', async t => {
  const { start } = await setup(t); const ctx = await start();
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus(video);
  const first = await until(async () => { const s = await ctx.get('/api/session'); return s.platforms?.youtube && s; }, 'vídeo anterior');
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  ctx.app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2' });
  ctx.app.viewers.emit('streamIdentity', { streamId: stream.id, startedAt: stream.started_at }, ctx.app.viewers.identityEpoch());
  const next = await until(async () => { const s = await ctx.get('/api/session'); return s.id !== first.id && s.platforms?.youtube?.videoId === 'video-2' && s; }, 'directo nuevo');
  await ctx.app.session.transitionChain;
  assert.equal((await ctx.get('/api/session')).platforms?.twitch, undefined);
  assert.equal(next.platforms.youtube.videoId, 'video-2');
});

test('100 compact regressions', async t => {
  for (const k of ['off','youtube','twitch','reconnect','disabled']) await t.test(k, async t => {
    const {app:a} = await (await setup(t)).start();
    const done = () => a.session.transitionChain;
    let release; const gate = new Promise(r => { release = r; });
    if (k === 'off') {
      const {readFile} = await import('node:fs/promises');
      a.store.config.meld.autoSession = false; await a.session.flush();
      const before = await readFile(a.session.file);
      a.meld.setStatus({state:'conectado',streaming:true}); a.youtube.setStatus(video);
      stubTwitch(a,stream); await a.viewers.tick(); a.meld.emit('streaming',false);
      await done(); await new Promise(r => setTimeout(r,500));
      assert.deepEqual(await readFile(a.session.file),before); return;
    }
    if (k === 'reconnect') {
      const {createJsonWriter} = await import('../src/json-file.mjs');
      let enter; const started = new Promise(r => { enter = r; }); const writer = createJsonWriter();
      a.session.writer = (f,d,o={}) => writer(f,d,{...o,after:Promise.resolve(o.after).then(async () => {
        if (f.endsWith('.meta.json')) { enter(); await gate; }
      })});
      a.meld.setStatus({state:'conectado',streaming:true}); await started;
      a.youtube.setStatus(video); a.meld.setStatus({state:'reintentando'});
      a.meld.setStatus({state:'conectado',streaming:true});
      a.youtube.setStatus({...video,videoId:'video-2'}); release(); await done(); await tick();
      assert.equal(a.session.data.platforms?.youtube?.videoId,'video-2');
      assert.ok((await a.session.list()).some(s => s.platforms?.youtube?.videoId === video.videoId)); return;
    }
    if (k === 'disabled') { a.store.config.viewers.enabled = false; stubTwitch(a,stream); }
    a.meld.setStatus({state:'conectado',streaming:true}); await done(); await tick();
    if (k === 'disabled') {
      await a.viewers.tick(); await done(); await tick();
      assert.equal(a.session.data.platforms?.twitch?.streamId,stream.id); return;
    }
    a.youtube.setStatus(video); await done(); let poll;
    if (k === 'youtube') { a.youtube.running=true; a.youtube.api=()=>gate; poll=a.youtube.pollOnce(); release({items:[]}); }
    else { a.store.secrets.twitch={access:'fake'}; a.twitch.userId='u'; a.twitch.helix=()=>gate; a.youtube.api=async()=>({items:[]}); poll=a.viewers.tick(); }
    for (const v of [false,true]) { a.meld.values.isStreaming=v; a.meld.afterChange(); }
    if (k === 'twitch') { await done(); release({ok:true,data:{data:[stream]}}); }
    await poll; await done(); await tick(); assert.equal(a.session.data.platforms?.[k],undefined);
  });
});

for (const k of ['fresh Twitch', 'old YouTube']) test(`identity rollover: ${k}`, async t => {
  const {app:a} = await (await setup(t)).start();
  const done = async () => { await a.session.transitionChain; await tick(); };
  a.meld.setStatus({state:'conectado',streaming:true}); a.youtube.setStatus(video);
  stubTwitch(a,stream); await a.viewers.tick(); await done();
  a.meld.setStatus({state:'reintentando'}); a.meld.setStatus({state:'conectado',streaming:true});
  if (k === 'fresh Twitch') {
    let enter, release; const entered = new Promise(r=>enter=r), gate = new Promise(r=>release=r);
    const result = {ok:true,data:{data:[{...stream,id:'stream-2'}]}};
    t.after(()=>release(result)); a.twitch.helix=()=>{enter();return gate;};
    const poll=a.viewers.tick(); await entered;
    a.youtube.setStatus({...video,videoId:'video-2'}); await done();
    release(result); await poll; await done();
    assert.equal(a.session.data.platforms.twitch?.streamId,'stream-2');
  } else {
    stubTwitch(a,{...stream,id:'stream-2'}); await a.viewers.tick(); await done();
    assert.equal(a.session.data.platforms.youtube,undefined);
    a.youtube.running=true; await a.youtube.pollOnce(); await done(); await a.youtube.stop();
    assert.equal(a.session.data.platforms.youtube,undefined);
  }
});

test('un sondeo del mismo Twitch antes de crear la sesión nueva no cuenta como confirmación', async t => {
  const { app: a, get } = await (await setup(t)).start();
  a.meld.setStatus({ state: 'conectado', streaming: true }); a.youtube.setStatus(video);
  stubTwitch(a, stream); await a.viewers.tick(); await a.session.transitionChain;
  a.meld.setStatus({ state: 'reintentando' }); a.meld.setStatus({ state: 'conectado', streaming: true });
  await a.session.transitionChain;
  const { createJsonWriter } = await import('../src/json-file.mjs');
  const writer = createJsonWriter(); let enter, release, armed = true;
  const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; });
  t.after(() => release());
  a.session.writer = (f, d, o = {}) => writer(f, d, { ...o, after: Promise.resolve(o.after).then(async () => {
    if (armed && f.endsWith('session-current.backup.json')) { armed = false; enter(); await gate; }
  }) });
  a.youtube.setStatus({ ...video, videoId: 'video-2' });
  await entered;
  await a.viewers.tick(); // todavía no se ha creado la sesión nueva
  release(); await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms?.twitch, undefined);
  await a.viewers.tick(); await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms.twitch.streamId, stream.id);
});

test('un Twitch antiguo en vuelo se descarta hasta que otro sondeo confirme el mismo id', async t => {
  const { app: a, get } = await (await setup(t)).start();
  a.meld.setStatus({ state: 'conectado', streaming: true }); a.youtube.setStatus(video);
  stubTwitch(a, stream); await a.viewers.tick(); await a.session.transitionChain;
  a.meld.setStatus({ state: 'reintentando' }); a.meld.setStatus({ state: 'conectado', streaming: true });
  let enter, release;
  const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; });
  const result = { ok: true, data: { data: [stream] } };
  t.after(() => release(result));
  a.twitch.helix = () => { enter(); return gate; };
  const poll = a.viewers.tick(); await entered;
  a.youtube.setStatus({ ...video, videoId: 'video-2' });
  await a.session.transitionChain; release(result); await poll; await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms?.twitch, undefined);
  stubTwitch(a, stream); await a.viewers.tick(); await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms.twitch.streamId, stream.id);
});

test('el mismo vídeo YouTube necesita una búsqueda nueva tras el corte', async t => {
  const { app: a, get } = await (await setup(t)).start();
  const old = { ...video, videoId: 'abcdefghijk' };
  a.meld.setStatus({ state: 'conectado', streaming: true }); a.youtube.setStatus(old);
  stubTwitch(a, stream); await a.viewers.tick(); await a.session.transitionChain;
  a.meld.setStatus({ state: 'reintentando' }); a.meld.setStatus({ state: 'conectado', streaming: true });
  stubTwitch(a, { ...stream, id: 'stream-2' }); await a.viewers.tick(); await a.session.transitionChain;
  t.after(() => a.youtube.stop());
  a.youtube.running = true; await a.youtube.pollOnce(); await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms?.youtube, undefined);
  a.youtube.cfg.apiKey = 'fake'; a.youtube.poll = () => {};
  a.youtube.api = async () => ({ items: [{ liveStreamingDetails: { activeLiveChatId: old.liveChatId }, snippet: { title: old.title } }] });
  await a.youtube.start(old.videoId); await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms.youtube.videoId, old.videoId);
});

test('una búsqueda anterior a dos cortes se acepta si difiere del directo reemplazado', async t => {
  const { app: a, get } = await (await setup(t)).start();
  a.meld.setStatus({ state: 'conectado', streaming: true }); a.youtube.setStatus(video);
  stubTwitch(a, stream); await a.viewers.tick(); await a.session.transitionChain;
  a.youtube.cfg.apiKey = 'fake'; a.youtube.poll = () => {};
  let enter, release; const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; });
  t.after(() => { release(); return a.youtube.stop(); });
  a.youtube.api = async () => { enter(); await gate; return { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-3' }, snippet: { title: 'Tercero' } }] }; };
  const pending = a.youtube.start('abcdefghij3'); await entered;
  a.youtube.api = async () => ({ items: [] });
  a.meld.setStatus({ state: 'reintentando' }); a.meld.setStatus({ state: 'conectado', streaming: true });
  a.twitch.helix = async () => ({ ok: true, data: { data: [{ ...stream, id: 'stream-2' }] } });
  await a.viewers.tick(); await a.session.transitionChain;
  a.youtube.setStatus({ ...video, videoId: 'video-2' }); await a.session.transitionChain;
  a.meld.setStatus({ state: 'reintentando' }); a.meld.setStatus({ state: 'conectado', streaming: true });
  a.twitch.helix = async () => ({ ok: true, data: { data: [{ ...stream, id: 'stream-3' }] } });
  await a.viewers.tick(); await a.session.transitionChain;
  release(); await pending; await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms.youtube.videoId, 'abcdefghij3');
});

test('una búsqueda YouTube en vuelo con otro id se conserva al cortar por Twitch', async t => {
  const { app: a, get } = await (await setup(t)).start();
  a.meld.setStatus({ state: 'conectado', streaming: true }); a.youtube.setStatus(video);
  stubTwitch(a, stream); await a.viewers.tick(); await a.session.transitionChain;
  a.meld.setStatus({ state: 'reintentando' }); a.meld.setStatus({ state: 'conectado', streaming: true });
  a.youtube.cfg.apiKey = 'fake'; a.youtube.poll = () => {};
  let enter, release; const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; });
  t.after(() => { release(); return a.youtube.stop(); });
  a.youtube.api = async () => { enter(); await gate; return { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-2' }, snippet: { title: 'Nuevo' } }] }; };
  const pending = a.youtube.start('abcdefghij2'); await entered;
  a.twitch.helix = async () => ({ ok: true, data: { data: [{ ...stream, id: 'stream-2' }] } });
  await a.viewers.tick(); await a.session.transitionChain;
  release(); await pending; await a.session.transitionChain;
  assert.equal((await get('/api/session')).platforms.youtube.videoId, 'abcdefghij2');
});

for (const startup of [false, true]) test(`already-listening discovery: ${startup}`, async t => {
  const { app: a } = await (await setup(t)).start();
  a.youtube.cfg.apiKey = 'fake'; a.youtube.cfg.video = 'abcdefghijk'; a.youtube.poll = () => {};
  let discoveries = 0;
  a.youtube.api = async p => p === '/videos'
    ? (discoveries++, { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' }, snippet: { title: 'Live' } }] })
    : { items: [] };
  t.after(() => a.youtube.stop());
  await a.youtube.start(); await a.session.transitionChain;
  assert.equal(a.session.data.platforms.youtube.videoId, 'abcdefghijk');
  if (startup) a.meld.setStatus({ state: 'conectado', streaming: true });
  else { a.meld.setStatus({ state: 'conectado', streaming: false }); a.meld.values.isStreaming = true; a.meld.afterChange(); }
  await a.session.transitionChain; await a.youtube.pollOnce();
  await until(() => a.session.data.platforms?.youtube?.videoId === 'abcdefghijk', 'identidad YouTube confirmada');
  assert.ok(discoveries >= 2, 'un sondeo de chat no confirma la identidad');
  assert.equal(discoveries, 2, 'un solo /videos adicional por inicio');
});

test('si YouTube no escucha al comenzar no se hace una confirmación extra', async t => {
  const { app: a } = await (await setup(t)).start();
  const paths = [];
  a.youtube.api = async p => { paths.push(p); return { items: [] }; };
  a.meld.setStatus({ state: 'conectado', streaming: true });
  await a.session.transitionChain; await tick();
  assert.deepEqual(paths, []);
  assert.equal(a.session.data.platforms?.youtube, undefined);
});

test('confirmación en vuelo: sin duplicados, búsquedas ni reinicio del chat al reconectar', async t => {
  const { app: a } = await (await setup(t)).start();
  a.youtube.cfg.apiKey = 'fake'; a.youtube.cfg.video = 'abcdefghijk';
  let polls = 0, calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const row = { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' }, snippet: { title: 'Live' } }] };
  t.after(() => { release(); return a.youtube.stop(); });
  a.youtube.poll = () => { polls++; };
  a.youtube.api = async (p, params) => {
    assert.equal(p, '/videos'); assert.equal(params.id, 'abcdefghijk');
    if (++calls === 2) await gate;
    return row;
  };
  try {
    await a.youtube.start(); await a.session.transitionChain;
    a.meld.setStatus({ state: 'conectado', streaming: true });
    await until(() => calls === 2, 'consulta en vuelo');
    a.meld.setStatus({ state: 'conectado', streaming: true });
    a.meld.setStatus({ state: 'reintentando' });
    a.meld.setStatus({ state: 'conectado', streaming: true });
    await tick(); assert.equal(calls, 2); assert.equal(polls, 1);
    release();
    await until(() => a.session.data.platforms?.youtube?.videoId === 'abcdefghijk', 'confirmación');
    assert.equal(calls, 2); assert.equal(polls, 1);
  } finally { release(); }
});

for (const failure of ['sin vídeo', 'sin chat activo', 'otro chat', 'error']) test(`confirmación fallida: ${failure}`, async t => {
  const { app: a } = await (await setup(t)).start();
  a.youtube.cfg.apiKey = 'fake'; a.youtube.cfg.video = 'abcdefghijk'; a.youtube.poll = () => {};
  let calls = 0;
  a.youtube.api = async p => {
    assert.equal(p, '/videos');
    if (++calls === 1) return { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' }, snippet: { title: 'Live' } }] };
    if (failure === 'error') throw new Error('fallo de prueba');
    if (failure === 'sin vídeo') return { items: [] };
    return { items: [{ liveStreamingDetails: failure === 'otro chat' ? { activeLiveChatId: 'otro' } : {}, snippet: { title: 'Live' } }] };
  };
  t.after(() => a.youtube.stop());
  await a.youtube.start(); await a.session.transitionChain;
  a.meld.setStatus({ state: 'conectado', streaming: true });
  await until(() => calls === 2, 'consulta de confirmación');
  await a.session.transitionChain; await tick();
  assert.equal(a.session.data.platforms?.youtube, undefined);
  assert.equal(a.youtube.status.videoId, 'abcdefghijk');
  assert.equal(a.youtube.status.liveChatId, 'chat');
  assert.equal(calls, 2);
});

test('una confirmación fallida no interrumpe el chat', async t => {
  const { app: a } = await (await setup(t)).start();
  a.youtube.cfg.apiKey = 'fake'; a.youtube.cfg.video = 'abcdefghijk';
  let videos = 0, chats = 0;
  a.youtube.api = async p => p === '/videos'
    ? (++videos === 1 ? { items: [{ liveStreamingDetails: { activeLiveChatId: 'c' } }] } : Promise.reject(Error('offline')))
    : (chats++, { items: [] });
  t.after(() => a.youtube.stop());
  await a.youtube.start(); await until(() => chats === 1, 'primer chat');
  a.meld.setStatus({ state: 'conectado', streaming: true });
  await until(() => videos === 2, 'confirmación'); await tick(); await a.session.transitionChain;
  assert.equal(a.session.data.platforms?.youtube, undefined);
  clearTimeout(a.youtube.timer); await a.youtube.poll();
  assert.equal(chats, 2); assert.equal(videos, 2); assert.equal(a.youtube.running, true);
});
