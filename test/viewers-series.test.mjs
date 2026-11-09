// #101: serie por plataforma, huecos, cobertura y persistencia sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const iso = ms => new Date(ms).toISOString();
const video = { state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1', title: 'Vídeo' };
const live = (value, streamId = 'stream-1') => ({ live: true, viewers: value, streamId });
const offline = { live: false };
const disconnected = { live: false, off: true };

async function fixture(t, { current, backup } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-viewers-series-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  for (const [name, value] of [['session-current.json', current], ['session-current.backup.json', backup]]) {
    if (value) await writeFile(path.join(dataDir, name), JSON.stringify(value));
  }
  const apps = [];
  t.after(async () => {
    for (const a of apps) {
      a.viewers.halt();
      await a.drainAutoSession().catch(() => {});
      await a.session.flush().catch(() => {});
      await a.closeHttp().catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  async function start() {
    const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), log: () => {} });
    apps.push(app);
    app.store.config.viewers.records = { twitch: 1_000_000, youtube: 1_000_000 };
    app.store.config.viewers.confirmPolls = 1;
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const get = async p => { const r = await fetch(base + p); assert.equal(r.status, 200); return r.json(); };
    const post = async (p, body = {}) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 200); return r.json();
    };
    return { app, base, get, post };
  }
  return { start };
}

async function startLive(ctx) {
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await ctx.app.session.transitionChain;
  ctx.app.youtube.setStatus(video);
  await ctx.app.session.transitionChain;
  return Date.parse((await ctx.get('/api/session')).startedAt);
}
function poller(ctx, start) {
  let time = start, twitch = offline, youtube = offline;
  ctx.app.viewers.now = () => time;
  ctx.app.viewers.readers = {
    twitch: async () => { if (twitch instanceof Error) throw twitch; return twitch; },
    youtube: async () => { if (youtube instanceof Error) throw youtube; return youtube; },
  };
  return async (seconds, tw, yt) => {
    time = start + seconds * 1000; twitch = tw; youtube = yt;
    await ctx.app.viewers.tick(); await ctx.app.session.transitionChain;
  };
}
function rpc(t, base) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    env: { ANTENA_URL: base, ANTENA_NO_EMBED: '1', TMPDIR: tmpdir(), PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', id = 0; const pending = new Map();
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
    const n = ++id; const result = new Promise(resolve => pending.set(n, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    return result;
  };
}
async function tool(call, name, args = {}) {
  const response = await call('tools/call', { name, arguments: args });
  assert.equal(response.result.isError, undefined);
  return JSON.parse(response.result.content[0].text);
}

// Twitch: 10×30s + 20×40s + 50×30s = 2600 / 100s = 26.
// YouTube: 100×30 + 200×40 + 300×30 + 400×30 + 500×30 + 600×60 + 700×30 = 104000 / 250 = 416.
test('muestras, media ponderada, pico y huecos independientes en REST y MCP', { timeout: 15000 }, async t => {
  const ctx = await (await fixture(t)).start(); const start = await startLive(ctx); const poll = poller(ctx, start);
  const baseline = await ctx.get('/api/session');
  await poll(0, live(10), live(100));
  await poll(30, live(20), live(200));
  await poll(70, new Error('fallo'), live(300));
  await poll(100, new Error('fallo'), live(400));
  await poll(130, offline, live(500));
  await poll(160, disconnected, live(600));
  await poll(220, live(50), live(700));
  await ctx.app.session.endCurrent(iso(start + 250_000));
  const current = await ctx.get('/api/session');
  assert.deepEqual(current.viewers.twitch.samples, [{ at: iso(start), value: 10 }, { at: iso(start + 30_000), value: 20 }, { at: iso(start + 220_000), value: 50 }]);
  assert.deepEqual(current.viewers.youtube.samples, [0, 30, 70, 100, 130, 160, 220].map((seconds, i) => ({ at: iso(start + seconds * 1000), value: (i + 1) * 100 })) );
  assert.deepEqual(current.viewers.twitch.gaps, [
    { from: iso(start + 70_000), to: iso(start + 130_000), reason: 'error' },
    { from: iso(start + 130_000), to: iso(start + 160_000), reason: 'offline' },
    { from: iso(start + 160_000), to: iso(start + 220_000), reason: 'disconnected' },
  ]);
  assert.deepEqual(current.viewerMetrics.twitch, { average: 26, peak: 50, coverage: { liveSeconds: 250, coveredSeconds: 100, ratio: 0.4 } });
  assert.deepEqual(current.viewerMetrics.youtube, { average: 416, peak: 700, coverage: { liveSeconds: 250, coveredSeconds: 250, ratio: 1 } });
  assert.deepEqual(Object.keys(current.viewerMetrics).sort(), ['twitch', 'youtube']);
  for (const key of ['id', 'title', 'startedAt', 'eventCount', 'totals', 'latest']) assert.deepEqual(current[key], baseline[key]);
  assert.deepEqual(current.platforms.youtube, baseline.platforms.youtube);
  const list = await ctx.get('/api/sessions');
  assert.deepEqual(list.current.viewerMetrics, current.viewerMetrics);
  assert.equal(list.current.viewers, undefined);
  assert.deepEqual({ id: list.current.id, title: list.current.title, startedAt: list.current.startedAt, events: list.current.events, platforms: list.current.platforms },
    { id: current.id, title: current.title, startedAt: current.startedAt, events: current.eventCount, platforms: current.platforms });
  const summary = await ctx.get('/api/session/summary?format=json');
  assert.deepEqual(summary.viewers, current.viewers); assert.deepEqual(summary.viewerMetrics, current.viewerMetrics);
  assert.deepEqual(summary.totals, current.totals); assert.ok(Array.isArray(summary.events)); assert.ok(Array.isArray(summary.credits));
  const call = rpc(t, ctx.base); const descriptions = (await call('tools/list')).result.tools;
  assert.match(descriptions.find(x => x.name === 'listar_directos').description, /viewerMetrics/);
  assert.match(descriptions.find(x => x.name === 'resumen_directo').description, /viewerMetrics/);
  assert.deepEqual(await tool(call, 'listar_directos'), list);
  assert.deepEqual(await tool(call, 'resumen_directo', { formato: 'json' }), summary);
  await ctx.post('/api/session/new');
  const past = (await ctx.get('/api/sessions')).past.find(x => x.id === current.id);
  assert.deepEqual(past.viewerMetrics, current.viewerMetrics); assert.equal(past.viewers, undefined);
  assert.deepEqual((await ctx.get(`/api/session/summary?format=json&id=${current.id}`)).viewerMetrics, current.viewerMetrics);
});

test('sin muestras la cobertura es cero y no se inventan valores', async t => {
  const ctx = await (await fixture(t)).start(); const start = await startLive(ctx); const poll = poller(ctx, start);
  await poll(10, offline, disconnected); await poll(40, offline, disconnected);
  await ctx.app.session.endCurrent(iso(start + 60_000));
  const current = await ctx.get('/api/session');
  for (const p of ['twitch', 'youtube']) {
    assert.deepEqual(current.viewers[p].samples, []);
    assert.deepEqual(current.viewerMetrics[p], { average: null, peak: null, coverage: { liveSeconds: 60, coveredSeconds: 0, ratio: 0 } });
  }
});

test('el intervalo de cada muestra se conserva si cambian los ajustes', async t => {
  const ctx = await (await fixture(t)).start(); const start = await startLive(ctx); const poll = poller(ctx, start);
  await poll(0, live(10), live(10));
  ctx.app.store.config.viewers.pollSec = 20;
  await poll(90, live(20), live(20));
  await ctx.app.session.endCurrent(iso(start + 120_000));
  const current = await ctx.get('/api/session');
  assert.deepEqual(current.viewerMetrics.twitch, { average: 12.5, peak: 20, coverage: { liveSeconds: 120, coveredSeconds: 80, ratio: 2 / 3 } });
});

test('un reinicio conserva la serie y marca el periodo incierto como restart', async t => {
  const { start: create } = await fixture(t); const first = await create(); const start = await startLive(first); const poll = poller(first, start);
  await poll(0, live(10), live(100));
  const id = (await first.get('/api/session')).id;
  first.app.viewers.halt(); await first.app.drainAutoSession(); await first.app.session.flush(); await first.app.closeHttp();
  const second = await create();
  const resumed = await second.get('/api/session');
  assert.equal(resumed.viewers.twitch.gaps[0].reason, 'restart');
  assert.equal(resumed.viewers.twitch.gaps[0].from, iso(start));
  assert.equal(resumed.viewerMetrics.twitch.coverage.coveredSeconds, 0);
  second.app.meld.setStatus({ state: 'conectado', streaming: true }); await second.app.session.transitionChain;
  second.app.youtube.setStatus(video); await second.app.session.transitionChain;
  const nextPoll = poller(second, start); await nextPoll(120, live(30), live(300));
  await second.app.session.endCurrent(iso(start + 150_000));
  const result = await second.get('/api/session');
  assert.equal(result.id, id);
  assert.deepEqual(result.viewers.twitch.samples, [{ at: iso(start), value: 10 }, { at: iso(start + 120_000), value: 30 }]);
  assert.deepEqual(result.viewers.twitch.gaps, [{ from: iso(start), to: iso(start + 120_000), reason: 'restart' }]);
  assert.deepEqual(result.viewerMetrics.twitch, { average: 30, peak: 30, coverage: { liveSeconds: 150, coveredSeconds: 30, ratio: 0.2 } });
});

test('un sondeo del directo anterior que termina tarde no entra en el nuevo', async t => {
  const ctx = await (await fixture(t)).start(); const start = await startLive(ctx); const poll = poller(ctx, start);
  await poll(0, live(10), live(100)); const oldId = (await ctx.get('/api/session')).id;
  let release, entered; const gate = new Promise(r => { release = r; }); const called = new Promise(r => { entered = r; });
  t.after(() => release(live(999)));
  ctx.app.viewers.readers.twitch = () => { entered(); return gate; };
  const waiting = ctx.app.viewers.tick(); await called;
  ctx.app.meld.emit('streaming', false); ctx.app.meld.emit('streaming', true);
  await ctx.app.session.transitionChain; release(live(999)); await waiting; await ctx.app.session.transitionChain;
  const current = await ctx.get('/api/session'); assert.notEqual(current.id, oldId);
  assert.equal(current.viewers?.twitch?.samples?.length || 0, 0);
  const old = await ctx.get(`/api/session/summary?format=json&id=${oldId}`);
  assert.deepEqual(old.viewers.twitch.samples.map(x => x.value), [10]);
});

test('mirar espectadores y estado MCP conservan sus respuestas anteriores', async t => {
  const ctx = await (await fixture(t)).start(); const start = await startLive(ctx);
  ctx.app.viewers.now = () => start;
  ctx.app.viewers.readers = { twitch: async () => live(12), youtube: async () => live(34) };
  const checked = await ctx.post('/api/viewers/check');
  const snapshot = await ctx.get('/api/viewers');
  assert.deepEqual(checked, { fired: [], ...snapshot });
  assert.equal(snapshot.platforms.twitch.current, 12);
  assert.equal(snapshot.platforms.youtube.current, 34);
  assert.deepEqual(await tool(rpc(t, ctx.base), 'estado_espectadores'), snapshot);
  await ctx.app.session.transitionChain;
  assert.deepEqual((await ctx.get('/api/session')).viewers.twitch.samples, [{ at: iso(start), value: 12 }]);
});

test('sesiones legacy mantienen exactamente los campos previos en listado y resumen REST/MCP', async t => {
  const ctx = await (await fixture(t)).start();
  const before = await ctx.get('/api/session'); const initialList = await ctx.get('/api/sessions');
  assert.deepEqual(initialList.current, { id: before.id, title: before.title, startedAt: before.startedAt, events: before.eventCount });
  const call = rpc(t, ctx.base); assert.deepEqual(await tool(call, 'listar_directos'), initialList);
  const summary = await ctx.get('/api/session/summary?format=json');
  assert.equal(summary.viewers, undefined); assert.equal(summary.viewerMetrics, undefined);
  assert.deepEqual(await tool(call, 'resumen_directo', { formato: 'json' }), summary);
  await ctx.post('/api/session/new', { title: 'Siguiente' });
  const past = (await ctx.get('/api/sessions')).past.find(x => x.id === before.id);
  assert.deepEqual(Object.keys(past).sort(), ['endedAt', 'events', 'id', 'startedAt', 'title']);
  assert.deepEqual({ id: past.id, title: past.title, startedAt: past.startedAt, events: past.events }, initialList.current);
});

test('cada muestra se conserva también después de 20 000 lecturas por plataforma', { timeout: 120000 }, async t => {
  const ctx = await (await fixture(t)).start(); const start = await startLive(ctx); const poll = poller(ctx, start);
  for (let i = 0; i < 20_002; i++) await poll(i * 60, live(i % 100), live(i % 100));
  await ctx.app.session.endCurrent(iso(start + 20_002 * 60_000));
  const result = await ctx.get('/api/session');
  for (const p of ['twitch', 'youtube']) {
    assert.equal(result.viewers[p].samples.length, 20_002);
    assert.equal(result.viewerMetrics[p].coverage.coveredSeconds, 20_002 * 60);
    assert.equal(result.viewerMetrics[p].coverage.liveSeconds, 20_002 * 60);
  }
});


test('una lectura del inicio pendiente conserva su hora aunque el checkpoint tarde', async t => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const ctx = await (await fixture(t)).start();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const flush = ctx.app.session.flush.bind(ctx.app.session);
  let first = true;
  ctx.app.session.flush = async (...args) => {
    if (first) { first = false; entered(); await gate; }
    return flush(...args);
  };
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await blocked;
  ctx.app.youtube.setStatus(video);
  t.mock.timers.tick(1000);
  ctx.app.viewers.now = () => now + 1000;
  ctx.app.viewers.readers = { twitch: async () => live(12), youtube: async () => live(34) };
  await ctx.app.viewers.tick();
  t.mock.timers.tick(5000);
  release();
  await ctx.app.session.transitionChain;
  const result = await ctx.get('/api/session');
  for (const [platform, value] of [['twitch', 12], ['youtube', 34]]) {
    assert.deepEqual(result.viewers?.[platform]?.samples, [{ at: iso(now + 1000), value }]);
  }
});

test('una serie inválida usa el respaldo válido sin romper el arranque', async t => {
  const at = iso(Date.now() - 60_000);
  const valid = { samples: [{ at, value: 10 }], gaps: [], intervals: [{ from: at, seconds: 60 }] };
  const backup = { id: 'viewer-backup', startedAt: at, events: [], meldAutoSession: true, viewers: { twitch: valid } };
  for (const [name, invalid] of [
    ['samples', { ...valid, samples: {} }],
    ['gap', { ...valid, gaps: [{ from: at, to: 'inválido', reason: 'error' }] }],
    ['value', { ...valid, samples: [{ at, value: null }] }],
    ['interval', { ...valid, intervals: [{ from: at, seconds: 0 }] }],
  ]) await t.test(name, async child => {
    const current = { ...backup, id: 'viewer-invalid', viewers: { twitch: invalid } };
    const ctx = await (await fixture(child, { current, backup })).start();
    const result = await ctx.get('/api/session');
    assert.equal(result.id, 'viewer-backup');
    assert.deepEqual(result.viewers.twitch.samples, valid.samples);
    assert.equal(result.viewerMetrics.twitch.peak, 10);
  });
});


for (const failed of [false, true]) test(failed
  ? 'el hueco de error de YouTube pertenece al rollover pendiente de reconexión'
  : 'la muestra de YouTube pertenece al rollover pendiente de reconexión', { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const ctx = await (await fixture(t)).start();
  const start = await startLive(ctx), poll = poller(ctx, start);
  await poll(0, live(10), live(100));
  const before = await ctx.get('/api/session');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = new Promise(resolve => { entered = resolve; });
  t.after(() => release());
  const capture = ctx.app.session.captureIdentity.bind(ctx.app.session);
  ctx.app.session.captureIdentity = () => capture().then(async identity => {
    entered(); await gate; return identity;
  });
  ctx.app.meld.setStatus({ state: 'reintentando' });
  ctx.app.meld.setStatus({ state: 'conectado', streaming: true });
  await blocked;
  t.mock.timers.tick(30_000);
  ctx.app.youtube.setStatus({ ...video, videoId: 'video-2', liveChatId: 'chat-2' });
  ctx.app.viewers.now = () => start + 30_000;
  ctx.app.viewers.readers = {
    twitch: async () => live(10),
    youtube: async () => { if (failed) throw new Error('fallo'); return live(80); },
  };
  await ctx.app.viewers.tick(); // No drenar la transición antes de liberar la barrera.
  release();
  await ctx.app.session.transitionChain;
  await ctx.app.session.endCurrent(iso(start + 60_000));
  const current = await ctx.get('/api/session');
  assert.notEqual(current.id, before.id);
  assert.equal(current.platforms.youtube.videoId, 'video-2');
  assert.deepEqual(current.viewers?.youtube?.samples, failed ? [] : [{ at: iso(start + 30_000), value: 80 }]);
  assert.deepEqual(current.viewers.youtube.gaps, failed
    ? [{ from: iso(start + 30_000), to: iso(start + 60_000), reason: 'error' }] : []);
  assert.deepEqual(current.viewerMetrics.youtube, {
    average: failed ? null : 80, peak: failed ? null : 80,
    coverage: { liveSeconds: 30, coveredSeconds: failed ? 0 : 30, ratio: failed ? 0 : 1 },
  });
  const previous = await ctx.get('/api/session/summary?format=json&id=' + before.id);
  assert.deepEqual(previous.viewers.youtube.samples, before.viewers.youtube.samples);
  assert.deepEqual(previous.viewers.youtube.gaps, before.viewers.youtube.gaps);
  assert.deepEqual(previous.totals, before.totals);
});
