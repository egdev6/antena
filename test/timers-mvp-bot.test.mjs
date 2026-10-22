// MVP-BOT-01 (#44): pausa global, Meld desconocido, reanudación y envío en curso de los mensajes
// programados (T1 caracterizó, T2 implementa). Los casos «regresión» protegen lo que no debe cambiar.
// El destino por timer (S1) vive en timers-destination.test.mjs (T3).
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

// Un «Enviar ahora» bloqueado puede rechazar o resolver con el motivo; ambos valen si lo explican.
async function outcome(p) {
  try { return { value: await p }; } catch (error) { return { error }; }
}
const reasonOf = o => o.error ? o.error.message : (o.value?.blocked || o.value?.reason || o.value?.error);

// ---------- S3 · pausa global ----------

test('S3 RED: con la pausa global, un timer sin alerta en pantalla no sale al chat', async t => {
  const { app, sent, call, advance, tick, timer } = await start(t);
  const tm = await timer({ showAlert: false });
  await call('POST', '/api/pause');
  advance(2 * MIN);
  assert.equal(typeof app.timers.due(tm, Date.now()), 'string', 'due debe dar un motivo mientras está en pausa');
  assert.deepEqual(await tick(), [], 'ningún timer debe dispararse en pausa');
  assert.equal(sent.length, 0, 'nada debe llegar al chat en pausa');
});

test('S3 RED: «Enviar ahora» queda bloqueado en pausa e informa del motivo', async t => {
  const { sent, ytSent, call, app, timer } = await start(t);
  const tm = await timer({ showAlert: false });
  await call('POST', '/api/pause');
  const o = await outcome(app.timers.fire(tm.id));
  assert.equal(sent.length + ytSent.length, 0, 'fire no debe enviar nada en pausa');
  assert.ok(typeof reasonOf(o) === 'string' && reasonOf(o).length > 0, 'fire bloqueado debe informar del motivo');
});

test('S3: la ruta de «Enviar ahora» responde 409 con el motivo y no toca el estado del timer', async t => {
  const { app, sent, call, timer } = await start(t);
  const tm = await timer({ showAlert: true });
  await call('POST', '/api/pause');
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/timers/${tm.id}/fire`, { method: 'POST' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /pausa/);
  assert.equal(sent.length, 0);
  assert.equal(app.engine.pauseState().held, 0, 'tampoco deja una alerta en cola');
  assert.equal((await call('GET', '/api/timers'))[0].runtime.runs, 0);
});

test('S3 regresión: la pausa no afecta al chat que escribes tú', async t => {
  const { sent, call } = await start(t);
  await call('POST', '/api/pause');
  const r = await call('POST', '/api/chat/send', { text: 'hola desde el panel', to: 'twitch' });
  assert.equal(r.to, 'twitch');
  assert.deepEqual(sent, [{ kind: 'chat', text: 'hola desde el panel' }]);
});

// ---------- S4 · Meld desconocido ----------

test('S4 RED: «solo mientras emito» con Meld sin conectar no sale automáticamente', async t => {
  const { app, sent, advance, tick, timer } = await start(t);
  assert.equal(app.meld.connected, false, 'precondición: Meld sin conectar (estado desconocido)');
  const tm = await timer({ onlyWhenLive: true });
  advance(2 * MIN);
  assert.equal(typeof app.timers.due(tm, Date.now()), 'string', 'due debe dar un motivo con Meld desconocido');
  assert.deepEqual(await tick(), [], 'no debe dispararse con Meld desconocido');
  assert.equal(sent.length, 0);
});

test('S4 RED: «solo mientras emito» con Meld sin conectar bloquea «Enviar ahora» con motivo', async t => {
  const { app, sent, ytSent, timer } = await start(t);
  assert.equal(app.meld.connected, false, 'precondición: Meld sin conectar (estado desconocido)');
  const tm = await timer({ onlyWhenLive: true });
  const o = await outcome(app.timers.fire(tm.id));
  assert.equal(sent.length + ytSent.length, 0, 'fire no debe enviar nada con Meld desconocido');
  assert.ok(typeof reasonOf(o) === 'string' && reasonOf(o).length > 0, 'fire bloqueado debe informar del motivo');
});

test('S4 regresión: sin «solo mientras emito», sale aunque Meld sea desconocido', async t => {
  const { app, sent, advance, tick, timer } = await start(t);
  assert.equal(app.meld.connected, false);
  const tm = await timer({ onlyWhenLive: false });
  advance(2 * MIN);
  assert.equal(app.timers.due(tm, Date.now()), null);
  assert.deepEqual(await tick(), [tm.id]);
  assert.equal(sent.length, 1);
  await app.timers.fire(tm.id);
  assert.equal(sent.length, 2);
});

// ---------- S8 · reanudar ----------

test('S8 RED: al reanudar no hay ráfaga; cada timer cuenta su intervalo completo desde la reanudación', async t => {
  const { sent, call, advance, tick, timer } = await start(t);
  const a = await timer({ name: 'A', intervalMin: 1 });
  const b = await timer({ name: 'B', intervalMin: 2 });
  await call('POST', '/api/pause');
  advance(10 * MIN); // ambos vencen durante la pausa
  await call('POST', '/api/resume', {});
  assert.deepEqual(await tick(), [], 'lo vencido en pausa no se recupera al reanudar');
  advance(MIN - 1000);
  assert.deepEqual(await tick(), [], 'aún no ha pasado el intervalo de A desde la reanudación');
  advance(1000);
  assert.deepEqual(await tick(), [a.id], 'A sale a 1 min de la reanudación');
  advance(MIN);
  assert.deepEqual(await tick(), [a.id, b.id], 'B sale a 2 min de la reanudación');
  assert.equal(sent.length, 3);
});

// Las otras vías de reanudar comparten el mismo punto: tras ellas, el intervalo vuelve a contar entero.
for (const [via, resume] of [
  ['PUT /api/config', call => call('PUT', '/api/config', { paused: false })],
  ['/sd/pausa', call => call('POST', '/sd/pausa')],
]) {
  test(`S8: reanudar con ${via} tampoco provoca ráfaga`, async t => {
    const { app, sent, call, advance, tick, timer } = await start(t);
    const tm = await timer({ intervalMin: 1 });
    await call('POST', '/api/pause');
    advance(10 * MIN);
    await resume(call);
    assert.equal(app.engine.paused, false, 'precondición: la pausa se ha quitado');
    assert.deepEqual(await tick(), [], 'lo vencido en pausa no se recupera al reanudar');
    advance(MIN - 1000);
    assert.deepEqual(await tick(), []);
    advance(1000);
    assert.deepEqual(await tick(), [tm.id], 'sale a 1 min de la reanudación');
    assert.equal(sent.length, 1);
  });
}

test('S8: un timer que no venció en pausa también cuenta su intervalo completo desde la reanudación', async t => {
  const { call, advance, tick, timer } = await start(t);
  const tm = await timer({ intervalMin: 5 });
  advance(2 * MIN);
  await call('POST', '/api/pause');
  advance(MIN);
  await call('POST', '/api/resume', {});
  advance(2 * MIN);
  assert.deepEqual(await tick(), [], 'no sale a los 5 min de su cuenta anterior');
  advance(3 * MIN - 1000);
  assert.deepEqual(await tick(), []);
  advance(1000);
  assert.deepEqual(await tick(), [tm.id], 'sale a los 5 min de la reanudación');
});

// ---------- S9 · envío en curso ----------

for (const ok of [true, false]) {
  test(`S9: pausar no cancela un envío en curso; se registra como ${ok ? 'enviado' : 'fallido'}`, async t => {
    const { app, call, timer } = await start(t);
    let settle;
    app.twitch.sendChat = () => new Promise((resolve, reject) => {
      settle = () => ok ? resolve({ is_sent: true }) : reject(new Error('Twitch caído'));
    });
    const tm = await timer();
    const p = app.timers.fire(tm.id);
    await new Promise(r => setImmediate(r)); // la petición ya está en el proveedor
    assert.equal(typeof settle, 'function', 'precondición: envío en vuelo');
    await call('POST', '/api/pause');
    settle();
    const out = await p;
    const [row] = await call('GET', '/api/timers');
    assert.equal(row.runtime.runs, 1);
    if (ok) { assert.deepEqual(out.chat, { is_sent: true }); assert.equal(row.runtime.lastError, null); }
    else { assert.equal(out.error, 'Twitch caído'); assert.equal(row.runtime.lastError, 'Twitch caído'); }
  });
}

test('S10 regresión: un envío fallido no se reintenta antes del siguiente intervalo', async t => {
  const { app, advance, tick, timer } = await start(t);
  let attempts = 0;
  app.twitch.sendChat = async () => { attempts++; throw new Error('Twitch caído'); };
  const tm = await timer({ intervalMin: 1 });
  advance(MIN);
  assert.deepEqual(await tick(), [tm.id]);
  assert.equal(attempts, 1);
  advance(MIN / 2);
  assert.deepEqual(await tick(), [], 'no se reintenta antes del intervalo');
  assert.equal(attempts, 1);
  advance(MIN / 2);
  assert.deepEqual(await tick(), [tm.id], 'se vuelve a intentar al cumplirse el intervalo desde el intento');
  assert.equal(attempts, 2);
});

test('S10 regresión: la cuenta atrás empieza tras el intento, haya salido bien o mal', async t => {
  const { app, advance, tick, timer } = await start(t);
  let fail = false, attempts = 0;
  app.twitch.sendChat = async () => { attempts++; if (fail) throw new Error('Twitch caído'); return { is_sent: true }; };
  const ok = await timer({ name: 'Bien', intervalMin: 1 });
  advance(90_000); // intento tardío: el siguiente cuenta desde aquí, no desde el minuto 1
  assert.deepEqual(await tick(), [ok.id]);
  advance(30_000);
  assert.deepEqual(await tick(), [], 'éxito: no vuelve a salir hasta 1 min tras el intento');
  fail = true;
  advance(30_000);
  assert.deepEqual(await tick(), [ok.id], 'éxito: sale a 1 min del intento');
  advance(59_000);
  assert.deepEqual(await tick(), [], 'fallo: no vuelve a salir hasta 1 min tras el intento');
  advance(1000);
  assert.deepEqual(await tick(), [ok.id], 'fallo: sale a 1 min del intento');
  assert.equal(attempts, 3);
});

// La reanudación no depende de cuándo termina (o falla) la escritura de la configuración en disco.
test('S8: reanudar con PUT /api/config mientras la escritura tarda no provoca ráfaga', async t => {
  const { app, sent, call, advance, tick, timer } = await start(t);
  const tm = await timer({ intervalMin: 1 });
  await call('POST', '/api/pause');
  advance(10 * MIN);
  const write = app.store.write.bind(app.store);
  let release; const gate = new Promise(r => { release = r; });
  app.store.write = async (...a) => { await gate; return write(...a); };
  const resumed = call('PUT', '/api/config', { paused: false });
  await new Promise(r => setTimeout(r, 50)); // la pausa ya se ha quitado en memoria; el disco aún no
  assert.equal(app.engine.paused, false, 'precondición: la pausa se ha quitado en memoria');
  assert.deepEqual(await tick(), [], 'una comprobación durante la escritura no envía lo vencido en pausa');
  release(); await resumed;
  app.store.write = write;
  advance(MIN - 1000);
  assert.deepEqual(await tick(), []);
  advance(1000);
  assert.deepEqual(await tick(), [tm.id], 'sale a 1 min de la reanudación');
  assert.equal(sent.length, 1);
});

test('S8: reanudar con PUT /api/config cuya escritura falla no provoca ráfaga', async t => {
  const { app, sent, call, advance, tick, timer } = await start(t);
  const tm = await timer({ intervalMin: 1 });
  await call('POST', '/api/pause');
  advance(10 * MIN);
  const write = app.store.write;
  app.store.write = async () => { throw new Error('disco lleno'); };
  await assert.rejects(call('PUT', '/api/config', { paused: false }));
  app.store.write = write;
  assert.equal(app.engine.paused, false, 'precondición: la pausa se ha quitado en memoria');
  assert.deepEqual(await tick(), [], 'lo vencido en pausa no se recupera aunque falle la escritura');
  advance(MIN - 1000);
  assert.deepEqual(await tick(), []);
  advance(1000);
  assert.deepEqual(await tick(), [tm.id], 'sale a 1 min de la reanudación');
  assert.equal(sent.length, 1);
});
