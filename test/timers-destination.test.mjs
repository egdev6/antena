// MVP-BOT-01 (#44): destino por timer y resultado por plataforma (S1, S2, S5, S6, S7), de T3a.
// Los casos «regresión» protegen el comportamiento previo (sin destino = Twitch).
// Proveedores falsos y reloj `Date` simulado: sin red externa, cuentas reales ni esperas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const MIN = 60_000;

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-timers-mvp-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  // Twitch y YouTube falsos: guardan lo que se envía
  const sent = [], ytSent = [];
  app.twitch.sendChat = async text => { sent.push({ kind: 'chat', text }); return { is_sent: true }; };
  app.twitch.sendAnnouncement = async (text, color) => { sent.push({ kind: 'announce', text, color }); return { announced: true }; };
  app.twitch.status.user = 'egdev6';
  app.youtube.sendChat = async text => { ytSent.push({ text }); return { id: 'yt1', sent: true }; };
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  // Reloj simulado solo para `Date`: los temporizadores reales del servidor no se tocan.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(async () => {
    await new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const advance = ms => t.mock.timers.tick(ms);
  const tick = () => app.timers.tick(Date.now());
  // La cuenta atrás de un timer empieza la primera vez que se observa: el listado la arranca ya.
  const timer = async fields => {
    const { timer: tm } = await call('POST', '/api/timers', { message: 'Hola chat', intervalMin: 1, minChatLines: 0, onlyWhenLive: false, ...fields });
    await call('GET', '/api/timers');
    return tm;
  };
  return { app, sent, ytSent, call, advance, tick, timer };
}

// ---------- S1 · destino ----------

test('S1 RED: un timer con destino YouTube envía por YouTube y no por Twitch', async t => {
  const { app, sent, ytSent, advance, tick, timer } = await start(t);
  const tm = await timer({ destination: 'youtube', message: 'Hola YouTube' });
  await app.timers.fire(tm.id);
  assert.deepEqual(ytSent, [{ text: 'Hola YouTube' }], 'fire debe enviar por YouTube');
  assert.equal(sent.length, 0, 'fire no debe enviar por Twitch');
  advance(2 * MIN);
  assert.deepEqual(await tick(), [tm.id]);
  assert.equal(ytSent.length, 2, 'el envío automático también va a YouTube');
  assert.equal(sent.length, 0);
});

test('S1 regresión: un timer sin destino sigue enviando solo a Twitch', async t => {
  const { app, sent, ytSent, advance, tick, timer } = await start(t);
  const tm = await timer({ message: 'Hola Twitch' });
  assert.equal(tm.destination, undefined, 'precondición: sin destino explícito');
  await app.timers.fire(tm.id);
  advance(2 * MIN);
  assert.deepEqual(await tick(), [tm.id]);
  assert.deepEqual(sent, [{ kind: 'chat', text: 'Hola Twitch' }, { kind: 'chat', text: 'Hola Twitch' }]);
  assert.equal(ytSent.length, 0);
});


test('S1: un destino desconocido se rechaza con 400 al crear y al editar', async t => {
  const { app, call, timer } = await start(t);
  const base = `http://127.0.0.1:${app.server.address().port}/api/timers`;
  const send = (method, p, body) => fetch(base + p, { method, body: JSON.stringify(body) });
  const created = await send('POST', '', { message: 'Hola', destination: 'tiktok' });
  assert.equal(created.status, 400);
  assert.match((await created.json()).error, /twitch, youtube o both/);
  const tm = await timer({ destination: 'both' });
  const edited = await send('PUT', `/${tm.id}`, { destination: 'kick' });
  assert.equal(edited.status, 400);
  assert.equal((await call('GET', '/api/timers'))[0].destination, 'both', 'el destino guardado no cambia');
});

// ---------- S2 · resultado por plataforma ----------

test('S2: con «ambos», el fallo de Twitch no reenvía a YouTube ni cuenta como éxito', async t => {
  const { app, ytSent, call, timer } = await start(t);
  app.twitch.sendChat = async () => { throw new Error('Twitch caído'); };
  const tm = await timer({ destination: 'both', message: 'Hola a los dos' });
  const r = await app.timers.fire(tm.id);
  assert.deepEqual(ytSent, [{ text: 'Hola a los dos' }], 'YouTube lo recibe una sola vez');
  assert.equal(r.platforms.twitch.ok, false);
  assert.equal(r.platforms.twitch.error, 'Twitch caído');
  assert.equal(r.platforms.youtube.ok, true);
  assert.match(r.error, /Twitch caído/, 'el resultado global no es un éxito completo');
  const { runtime } = (await call('GET', '/api/timers'))[0];
  assert.equal(runtime.platforms.twitch.ok, false);
  assert.equal(runtime.platforms.youtube.ok, true);
  assert.match(runtime.lastError, /Twitch caído/);
});

test('S2 regresión: con «ambos» y todo bien, cada plataforma recibe una vez y no hay error', async t => {
  const { app, sent, ytSent, timer } = await start(t);
  const tm = await timer({ destination: 'both' });
  const r = await app.timers.fire(tm.id);
  assert.equal(sent.length, 1);
  assert.equal(ytSent.length, 1);
  assert.equal(r.error, null);
  assert.deepEqual(r.chat, { is_sent: true }, '«chat» sigue siendo la respuesta de Twitch');
});

// ---------- S3/S9 · pausa a mitad de un envío a «ambos» ----------

test('S3/S9: si la pausa llega con Twitch en vuelo, Twitch termina y YouTube no sale', async t => {
  const { app, sent, ytSent, call, timer } = await start(t);
  let release; const gate = new Promise(r => { release = r; });
  app.twitch.sendChat = async text => { sent.push({ kind: 'chat', text }); await gate; return { is_sent: true }; };
  const tm = await timer({ destination: 'both' });
  const run = app.timers.fire(tm.id);
  while (!sent.length) await new Promise(r => setImmediate(r));
  await call('POST', '/api/pause');
  release();
  const r = await run;
  assert.equal(sent.length, 1, 'Twitch, ya en vuelo, se envía una sola vez');
  assert.equal(r.platforms.twitch.ok, true, 'se registra según su resultado');
  assert.deepEqual(ytSent, [], 'YouTube no sale con la pausa activa');
  assert.equal(r.platforms.youtube.ok, false);
  assert.match(r.platforms.youtube.error, /pausa activa/);
  assert.notEqual(r.error, null, 'fallo parcial visible');
  const { runtime } = (await call('GET', '/api/timers'))[0];
  assert.equal(runtime.platforms.youtube.ok, false);
  assert.match(runtime.lastError, /pausa activa/);
});

// ---------- S5 · anuncio con «ambos» ----------

test('S5: anuncio con «ambos» = anuncio en Twitch + mismo texto normal en YouTube', async t => {
  const { app, sent, ytSent, timer } = await start(t);
  const tm = await timer({ destination: 'both', announce: true, announceColor: 'green', message: 'Aviso' });
  const r = await app.timers.fire(tm.id);
  assert.deepEqual(sent, [{ kind: 'announce', text: 'Aviso', color: 'green' }]);
  assert.deepEqual(ytSent, [{ text: 'Aviso' }]);
  assert.equal(r.platforms.twitch.kind, 'announcement');
  assert.equal(r.platforms.youtube.kind, 'message', 'YouTube recibe texto normal, no un anuncio');
});

test('S5: anuncio con destino YouTube sale como mensaje normal', async t => {
  const { app, sent, ytSent, timer } = await start(t);
  const tm = await timer({ destination: 'youtube', announce: true, message: 'Aviso' });
  const r = await app.timers.fire(tm.id);
  assert.equal(sent.length, 0);
  assert.deepEqual(ytSent, [{ text: 'Aviso' }]);
  assert.equal(r.platforms.youtube.kind, 'message');
});

// ---------- S6 · límites de longitud ----------

test('S6: un texto final de más de 200 no va a YouTube (sin cortar) y sí a Twitch', async t => {
  const { app, sent, ytSent, call, timer } = await start(t);
  app.twitch.status.user = 'x'.repeat(50);
  const message = 'a'.repeat(180) + ' {channel}';
  const tm = await timer({ destination: 'both', message });
  assert.deepEqual((await call('GET', '/api/timers'))[0].runtime.warnings, [], 'la plantilla cabe: sin aviso al guardar');
  const r = await app.timers.fire(tm.id);
  assert.equal(ytSent.length, 0, 'no se corta ni se envía a YouTube');
  assert.equal(sent[0].text.length, 231);
  assert.ok(r.platforms, 'el resultado trae una entrada por plataforma');
  assert.equal(r.platforms.youtube.ok, false);
  assert.match(r.platforms.youtube.error, /200/);
  assert.equal(r.platforms.twitch.ok, true);
  assert.match(r.error, /200/);
});

test('S6: más de 500 no va a Twitch y queda como fallo', async t => {
  const { app, sent, timer } = await start(t);
  const tm = await timer({ message: 'b'.repeat(501) });
  const r = await app.timers.fire(tm.id);
  assert.equal(sent.length, 0);
  assert.match(r.platforms.twitch.error, /500/);
  assert.match(r.error, /500/);
});

test('S6: al guardar, avisa si la plantilla ya supera el límite de un destino elegido', async t => {
  const { app, call } = await start(t);
  const { timer: tm, warnings } = await call('POST', '/api/timers', { message: 'c'.repeat(250), destination: 'both' });
  assert.ok(Array.isArray(warnings), 'la respuesta de guardado trae los avisos');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].platform, 'youtube');
  assert.equal(warnings[0].limit, 200);
  const twitchOnly = await call('PUT', `/api/timers/${tm.id}`, { destination: 'twitch' });
  assert.deepEqual(twitchOnly.warnings, []);
  await call('PUT', `/api/timers/${tm.id}`, { destination: 'youtube' });
  const [snap] = await call('GET', '/api/timers');
  assert.equal(snap.runtime.warnings[0].platform, 'youtube', 'el estado también lo muestra');
  assert.equal(app.store.config.timers[0].warnings, undefined, 'el aviso no se guarda en la config');
});

// ---------- S7 · plataforma no disponible ----------

test('S7: con «ambos» y YouTube sin directo, Twitch lo recibe y YouTube es un fallo visible', async t => {
  const { app, sent, timer } = await start(t);
  app.youtube.sendChat = Object.getPrototypeOf(app.youtube).sendChat; // proveedor real, sin chat en directo
  const tm = await timer({ destination: 'both' });
  const r = await app.timers.fire(tm.id);
  assert.equal(sent.length, 1);
  assert.ok(r.platforms, 'el resultado trae una entrada por plataforma');
  assert.equal(r.platforms.twitch.ok, true);
  assert.equal(r.platforms.youtube.ok, false);
  assert.match(r.platforms.youtube.error, /YouTube/);
  assert.match(r.error, /YouTube/);
});
