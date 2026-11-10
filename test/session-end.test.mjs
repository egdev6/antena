// #118: lifecycle through HTTP with synthetic loopback data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t, current) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-session-end-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  if (current) await writeFile(path.join(dataDir, 'session-current.json'), JSON.stringify(current));
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  t.after(async () => {
    app.viewers.halt(); await app.youtube.quiescePoll().catch(() => {}); await app.chat.quiesceChat().catch(() => {});
    await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
    await app.session.flush().catch(() => {}); await app.closeHttp().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, url, origin, body = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { app, dataDir, request, get: async url => (await request('GET', url)).body };
}
const at = ms => new Date(ms).toISOString();
const initial = () => ({ id: 'synthetic-manual', title: 'Prueba', startedAt: at(Date.now() - 60000),
  events: [{ id: 'synthetic-event', type: 'follow', at: at(Date.now() - 30000), vars: {}, text: 'Prueba' }],
  notes: [{ id: 'n1', kind: 'saved', text: 'nota', at: at(Date.now() - 20000) }], goalOffsets: { follows: 3 },
  viewers: { twitch: { samples: [], gaps: [{ from: at(Date.now() - 10000), to: at(Date.now() - 10000), reason: 'offline' }], intervals: [], openGap: true } } });

test('S3/S5/S6: cierre manual durable e idempotente, sin archivar ni reiniciar hasta el siguiente inicio', async t => {
  const f = await fixture(t, initial());
  const before = await f.get('/api/session/summary?format=json');
  const list = await f.get('/api/sessions');
  const ended = await f.request('POST', '/api/session/end');
  assert.equal(ended.status, 200); assert.equal(ended.body.session.id, before.id); assert.ok(ended.body.session.endedAt);
  assert.equal(ended.body.session.viewers.twitch.openGap, false);
  assert.equal(ended.body.session.viewers.twitch.gaps[0].to, ended.body.session.endedAt);
  for (const k of ['events', 'notes', 'goalOffsets', 'title']) assert.deepEqual(ended.body.session[k], before[k]);
  assert.deepEqual((await f.get('/api/sessions')).past, list.past);
  assert.equal((await f.get('/api/sessions')).current.endedAt, ended.body.session.endedAt);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'session-current.json'), 'utf8')).endedAt, ended.body.session.endedAt);
  assert.deepEqual(await f.request('POST', '/api/session/end'), ended);
  const next = await f.request('POST', '/api/session/new');
  assert.equal(next.status, 200); assert.notEqual(next.body.session.id, before.id);
  assert.deepEqual(next.body.session.events, []); assert.deepEqual(next.body.session.goalOffsets, {});
  const archived = await f.get(`/api/session/summary?format=json&id=${before.id}`);
  assert.equal(archived.endedAt, ended.body.session.endedAt); assert.deepEqual(archived.events, before.events);
  assert.ok((await f.get('/api/sessions')).past.some(x => x.id === before.id));
});

test('S5: repetir un cierre tras fallar la persistencia solo responde 200 cuando queda guardado', async t => {
  const f = await fixture(t, initial());
  const writer = f.app.session.writer; let fail = false;
  f.app.session.on('change', change => { if (change.ended) fail = true; });
  f.app.session.writer = (...args) => fail ? Promise.reject(new Error('fallo sintético')) : writer(...args);
  const first = await f.request('POST', '/api/session/end');
  assert.equal(first.status, 500); assert.match(first.body.error, /No se pudo guardar la sesión/);
  fail = false;
  const retry = await f.request('POST', '/api/session/end');
  assert.equal(retry.status, 200); assert.ok(retry.body.session.endedAt);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'session-current.json'), 'utf8')).endedAt, retry.body.session.endedAt);
});

test('S5: un cierre fallido antes del corte conserva el chat y las observaciones automáticas', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t); f.app.twitch.userId = 'streamer-1';
  f.app.meld.setStatus({ state: 'conectado', streaming: true }); await f.app.session.transitionChain;
  const chat = user => f.app.chat.emit('message', { id: `tw:${user}`, platform: 'twitch', user, text: 'hola', authorId: user, roomId: 'streamer-1' });
  chat('primero'); await f.app.session.transitionChain;
  const before = await f.get('/api/session/summary?format=json');
  assert.equal(before.chatMetrics.twitch.messages, 1);
  f.app.meld.setStatus({ state: 'reintentando' });
  const writer = f.app.session.writer; let fail = true;
  f.app.session.writer = (...args) => fail ? Promise.reject(new Error('fallo sintético')) : writer(...args);
  const rejected = await f.request('POST', '/api/session/end');
  assert.equal(rejected.status, 500); assert.match(rejected.body.error, /No se pudo guardar la sesión/);
  fail = false;
  assert.deepEqual(await f.get('/api/session/summary?format=json'), before);
  chat('segundo');
  f.app.viewers.emit('seriesObservation', 'twitch', { at: at(Date.now()), reason: 'offline', intervalSec: 60 }, f.app.viewers.identityEpoch('twitch'));
  await f.app.session.transitionChain;
  const after = await f.get('/api/session/summary?format=json');
  assert.equal(after.id, before.id); assert.equal(after.endedAt, undefined);
  assert.equal(after.chatMetrics.twitch.messages, 2); assert.equal(after.viewers.twitch.openGap, true);
  const ended = await f.request('POST', '/api/session/end'); assert.equal(ended.status, 200);
  assert.equal(ended.body.session.id, before.id); assert.equal(ended.body.session.chatMetrics.twitch.messages, 2);
});

test('S5: origen ajeno y emisión confirmada se rechazan sin cambiar sesión ni contabilidad automática', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t);
  f.app.twitch.userId = 'streamer-1';
  f.app.meld.setStatus({ state: 'conectado', streaming: true }); await f.app.session.transitionChain;
  const chat = user => f.app.chat.emit('message', { id: `tw:${user}`, platform: 'twitch', user, text: 'hola', authorId: user, roomId: 'streamer-1' });
  chat('antes'); await f.app.session.transitionChain;
  const before = await f.get('/api/session/summary?format=json');
  const origin = await f.request('POST', '/api/session/end', 'https://foreign.example');
  assert.deepEqual(origin, { status: 403, body: { error: 'Origen no permitido para acciones que cambian el directo.' } });
  const rejected = await f.request('POST', '/api/session/end');
  assert.equal(rejected.status, 409); assert.match(rejected.body.error, /Meld.*emitiendo/i);
  assert.deepEqual(await f.get('/api/session/summary?format=json'), before);
  chat('después'); await f.app.session.transitionChain;
  const after = await f.get('/api/session/summary?format=json');
  assert.equal(after.endedAt, undefined); assert.equal(after.chatMetrics.twitch.messages, 2);
});

test('S5/S6: cierre desconectado detiene métricas y no reabre con status parado; siguiente emisión crea otra sesión', async t => {
  const f = await fixture(t); f.app.twitch.userId = 'streamer-1';
  f.app.meld.setStatus({ state: 'conectado', streaming: true }); await f.app.session.transitionChain;
  const chat = user => f.app.chat.emit('message', { id: `tw:${user}`, platform: 'twitch', user, text: 'hola', authorId: user, roomId: 'streamer-1' });
  chat('antes'); await f.app.session.transitionChain;
  const started = await f.get('/api/session');
  f.app.meld.setStatus({ state: 'reintentando' });
  const ended = await f.request('POST', '/api/session/end');
  assert.equal(ended.status, 200); assert.equal(ended.body.session.id, started.id); assert.ok(ended.body.session.endedAt);
  const before = await f.get('/api/session/summary?format=json');
  f.app.meld.setStatus({ state: 'conectado', streaming: false });
  chat('tarde');
  f.app.viewers.emit('seriesObservation', 'twitch', { at: at(Date.now()), value: 99, streamId: 'stream-1', intervalSec: 60 }, f.app.viewers.identityEpoch('twitch'));
  await f.app.session.transitionChain;
  assert.deepEqual(await f.get('/api/session/summary?format=json'), before);
  f.app.meld.setStatus({ streaming: true }); await f.app.session.transitionChain;
  const next = await f.get('/api/session');
  assert.notEqual(next.id, started.id); assert.equal(next.meldAutoSession, true); assert.equal(next.endedAt, undefined);
  assert.equal((await f.get(`/api/session/summary?format=json&id=${started.id}`)).endedAt, ended.body.session.endedAt);
});

test('S5: un segundo cierre de A pendiente no puede cerrar la nueva sesión B', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t); f.app.meld.setStatus({ state: 'conectado', streaming: true }); await f.app.session.transitionChain;
  const old = await f.get('/api/session'); f.app.meld.setStatus({ state: 'reintentando' });
  t.mock.timers.tick(1000);
  let release, entered, secondEntered;
  const gate = new Promise(r => { release = r; }), waiting = new Promise(r => { entered = r; }), secondQueued = new Promise(r => { secondEntered = r; });
  t.after(() => release());
  const flush = f.app.session.flush.bind(f.app.session), endCurrent = f.app.session.endCurrent.bind(f.app.session);
  let held = false, calls = 0;
  f.app.session.flush = async () => { if (f.app.session.data.endedAt && !held) { held = true; entered(); await gate; } return flush(); };
  f.app.session.endCurrent = (...args) => { if (++calls === 2) secondEntered(); return endCurrent(...args); };
  const first = f.request('POST', '/api/session/end'); await waiting;
  const pending = await f.get('/api/session'); assert.equal(pending.id, old.id); assert.ok(pending.endedAt);
  f.app.meld.setStatus({ state: 'conectado', streaming: true });
  f.app.meld.setStatus({ state: 'reintentando' });
  const second = f.request('POST', '/api/session/end');
  await Promise.race([secondQueued, second.then(result => { if (result.status !== 409) throw new Error(`segundo cierre inesperado: ${result.status}`); })]);
  assert.equal((await f.get('/api/session')).id, old.id);
  t.mock.timers.tick(2000); release();
  const [a, b] = await Promise.all([first, second]); await f.app.session.transitionChain;
  assert.equal(a.status, 200); assert.equal(a.body.session.id, old.id);
  assert.equal(b.status, 409); assert.match(b.body.error, /sesión actual ha cambiado/i);
  const current = await f.get('/api/session');
  assert.notEqual(current.id, old.id); assert.equal(current.endedAt, undefined);
  assert.equal((await f.get(`/api/session/summary?format=json&id=${old.id}`)).endedAt, a.body.session.endedAt);
  const stale = await f.request('POST', '/api/session/end', undefined, { id: old.id });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /sesión actual ha cambiado/i);
  assert.deepEqual(await f.get('/api/session'), current);
  const endB = await f.request('POST', '/api/session/end', undefined, { id: current.id }); assert.equal(endB.status, 200);
  assert.ok(Date.parse(endB.body.session.endedAt) >= Date.parse(endB.body.session.startedAt));
  assert.equal((await f.request('GET', `/api/metrics/v1/sessions/${current.id}`)).status, 200);
});

test('S5: un id de cierre inválido se rechaza sin modificar la sesión', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, initial()), before = await f.get('/api/session/summary?format=json');
  for (const id of ['', 42, null]) {
    assert.deepEqual(await f.request('POST', '/api/session/end', undefined, { id }), { status: 400, body: { error: 'Identificador de sesión no válido.' } });
    assert.deepEqual(await f.get('/api/session/summary?format=json'), before);
  }
});

test('S5: la fecha de cierre no precede al inicio aunque el reloj retroceda', async t => {
  const start = at(Date.now() + 60000);
  const f = await fixture(t, { id: 'future-synthetic', title: '', startedAt: start, events: [], notes: [], goalOffsets: {}, meldAutoSession: true });
  const ended = await f.request('POST', '/api/session/end');
  assert.equal(ended.status, 200); assert.equal(ended.body.session.endedAt, start);
  assert.equal((await f.request('GET', '/api/metrics/v1/sessions/future-synthetic')).status, 200);
});

test('S5: reconectar durante inicio y cierre pendientes abre el siguiente directo una sola vez', async t => {
  const f = await fixture(t);
  let release, startEntered, endEntered;
  const gate = new Promise(r => { release = r; }), waitingStart = new Promise(r => { startEntered = r; }), waitingEnd = new Promise(r => { endEntered = r; });
  t.after(() => release());
  const flush = f.app.session.flush.bind(f.app.session), endCurrent = f.app.session.endCurrent.bind(f.app.session);
  let held = false;
  f.app.session.flush = async () => { if (f.app.session.data.meldAutoSession && !held) { held = true; startEntered(); await gate; } return flush(); };
  f.app.session.endCurrent = (...args) => { endEntered(); return endCurrent(...args); };
  f.app.meld.setStatus({ state: 'conectado', streaming: true }); await waitingStart;
  const old = await f.get('/api/session'); assert.equal(old.meldAutoSession, true);
  f.app.meld.setStatus({ state: 'reintentando' });
  const end = f.request('POST', '/api/session/end');
  await Promise.race([waitingEnd, end.then(result => { throw new Error(`el cierre no entró en la transición: ${result.status}`); })]);
  f.app.meld.setStatus({ state: 'conectado', streaming: true });
  f.app.meld.setStatus({ state: 'conectado', streaming: true });
  release(); const result = await end; await f.app.session.transitionChain;
  assert.equal(result.status, 200); assert.equal(result.body.session.id, old.id); assert.ok(result.body.session.endedAt);
  const next = await f.get('/api/session'); assert.notEqual(next.id, old.id); assert.equal(next.endedAt, undefined);
  assert.equal((await f.get('/api/sessions')).past.filter(item => item.id === old.id).length, 1);
});

test('S5: un inicio Meld durante el cierre pendiente espera el fin aceptado y devuelve la sesión cerrada', async t => {
  const f = await fixture(t); f.app.meld.setStatus({ state: 'conectado', streaming: true }); await f.app.session.transitionChain;
  const old = await f.get('/api/session'); f.app.meld.setStatus({ state: 'reintentando' });
  let release, entered; const gate = new Promise(r => { release = r; }); const waiting = new Promise(r => { entered = r; });
  t.after(() => release());
  const flush = f.app.session.flush.bind(f.app.session); let first = true;
  f.app.session.flush = async () => { if (first) { first = false; entered(); await gate; } return flush(); };
  const end = f.request('POST', '/api/session/end');
  await Promise.race([waiting, end.then(result => { throw new Error(`el cierre no entró en la transición: ${result.status}`); })]);
  f.app.meld.setStatus({ state: 'conectado', streaming: true }); release();
  const response = await end; await f.app.session.transitionChain;
  assert.equal(response.status, 200); assert.equal(response.body.session.id, old.id); assert.ok(response.body.session.endedAt);
  const current = await f.get('/api/session'); assert.notEqual(current.id, old.id); assert.equal(current.endedAt, undefined);
  assert.equal((await f.get(`/api/session/summary?format=json&id=${old.id}`)).endedAt, response.body.session.endedAt);
});
