// ODD-08 (solo pruebas, test-first): propiedad de recursos de Meld. FakeWebSocket por instancia con
// open/message/close controlados y envíos capturados; reloj falso acotado para 8000/5000 ms. Cubre S1
// (cierre de todos los sockets), S2 (pendiente antes de enviar, respuesta síncrona, throw de send,
// aislamiento por socket), S3 (limpieza de timeouts y reintento con guarda de generación), S4 (init
// tardía no contamina, logger que lanza) y S5 (stop/start reiniciable, sin quiesceClose).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meld } from '../src/meld.mjs';

const T_INIT = 3, T_INVOKE = 6, T_CONNECT_SIGNAL = 7, T_RESPONSE = 10;
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
const tick = () => new Promise(r => setImmediate(r));
const settle = async (rounds = 4) => { for (let i = 0; i < rounds; i++) await tick(); };
// Carrera explícita: nunca se espera para siempre a un pendiente que la base no rechaza.
function race(promise, ms = 150) {
  let timer;
  const timeout = new Promise(resolve => { timer = realSetTimeout(() => resolve({ timedOut: true }), ms); });
  return Promise.race([promise.then(v => ({ ok: true, value: v }), error => ({ ok: false, error })), timeout]).finally(() => realClearTimeout(timer));
}

class FakeWebSocket {
  static created = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; this.closeCalls = 0; FakeWebSocket.created.push(this); }
  send(data) { this.sent.push(JSON.parse(String(data))); }
  close() { this.closeCalls += 1; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  remoteClose() { this.readyState = 3; this.onclose?.(); }
  sentOfType(type) { return this.sent.filter(m => m.type === type); }
}
// Responde de forma SÍNCRONA dentro de send: solo pasa si el pendiente se registra antes de enviar.
class SyncReplyWebSocket extends FakeWebSocket {
  send(data) { const msg = JSON.parse(String(data)); super.send(data); if (msg.type === T_INVOKE) this.onmessage?.({ data: JSON.stringify({ type: T_RESPONSE, id: msg.id, data: { echoed: msg.method } }) }); }
}
class ThrowingWebSocket extends FakeWebSocket { send() { throw new Error('send roto'); } }

function installWs(t, Ctor = FakeWebSocket) {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = Ctor; FakeWebSocket.created = [];
  t.after(() => { globalThis.WebSocket = previous; });
}
function installClock(t) {
  const timers = []; let seq = 0;
  globalThis.setTimeout = (fn, ms) => { const h = { id: ++seq, fn, ms, cleared: false, unref() { return h; } }; timers.push(h); return h; };
  globalThis.clearTimeout = handle => { if (handle && typeof handle === 'object') handle.cleared = true; else realClearTimeout(handle); };
  t.after(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; });
  return { at: ms => timers.filter(x => x.ms === ms), active: ms => timers.filter(x => x.ms === ms && !x.cleared) };
}
const initPayload = (signals = []) => ({ meld: { methods: [['showScene', 10]], signals, properties: [[1, 'session', [], {}]] } });
// Cierra y liquida todo lo emitido para no dejar pendientes ni temporizadores colgando.
function cleanup(meld) {
  try { meld.stop(); } catch { /* la limpieza no debe enmascarar el resultado */ }
  for (const ws of FakeWebSocket.created) { try { ws.remoteClose(); } catch { /* limpieza */ } }
}
const sendRpc = (meld, method) => meld.send({ type: T_INVOKE, object: 'meld', method }, true);

test('S1: stop solicita el cierre de todos los sockets propios, incluido el sustituido que aún conecta', async t => {
  installWs(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    const first = FakeWebSocket.created[0];
    meld.start('ws://b');
    const second = FakeWebSocket.created[1];
    assert.equal(first.readyState, 0, 'el primer socket quedó sustituido mientras conectaba');
    meld.stop();
    assert.equal(second.closeCalls, 1, 'el socket vigente recibe la orden de cierre');
    assert.equal(first.closeCalls, 1, 'el socket sustituido también se cierra y no se pierde el puntero');
  } finally { cleanup(meld); }
});
test('S2: send(..., true) registra el pendiente antes de enviar y liquida una respuesta síncrona', async t => {
  installWs(t, SyncReplyWebSocket); installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    FakeWebSocket.created[0].readyState = 1;
    const result = await race(sendRpc(meld, 10));
    assert.equal(result.ok, true, 'la respuesta síncrona debe resolver la llamada, no perderse');
    assert.deepEqual(result.value, { echoed: 10 });
  } finally { cleanup(meld); }
});
test('S2: un throw síncrono de ws.send se convierte en rechazo esperable y no deja el timeout armado', async t => {
  installWs(t, ThrowingWebSocket); const clock = installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    FakeWebSocket.created[0].readyState = 1;
    let outcome;
    try { outcome = sendRpc(meld, 10); } catch (error) { outcome = { syncThrow: error }; }
    assert.equal(outcome.syncThrow, undefined, 'send debe devolver promesa rechazada, no lanzar en síncrono');
    const result = await race(Promise.resolve(outcome));
    assert.equal(result.ok, false, 'la llamada rechaza con el fallo de envío');
    assert.match(result.error.message, /send roto/);
    assert.equal(clock.active(8000).length, 0, 'no queda armado el timeout ordinario tras fallar el envío');
  } finally { cleanup(meld); }
});
test('S2: una respuesta de otro socket no liquida la llamada y el socket anterior sí cierra la suya', async t => {
  installWs(t); installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    const first = FakeWebSocket.created[0]; first.readyState = 1;
    const aResult = sendRpc(meld, 'A').then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    const aId = first.sentOfType(T_INVOKE)[0].id;
    meld.start('ws://b');
    const second = FakeWebSocket.created[1]; second.readyState = 1;
    const bResult = sendRpc(meld, 'B').then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    let aDone = false; aResult.then(() => { aDone = true; });
    second.message({ type: T_RESPONSE, id: aId, data: { from: 'b' } });
    await settle();
    assert.equal(aDone, false, 'la respuesta del socket actual no puede liquidar un id de otro socket');
    first.message({ type: T_RESPONSE, id: aId, data: { from: 'a' } });
    assert.deepEqual(await aResult, { ok: true, value: { from: 'a' } }, 'el socket original sí cierra su propia llamada');
    const bId = second.sentOfType(T_INVOKE)[0].id;
    second.message({ type: T_RESPONSE, id: bId, data: { from: 'b' } });
    assert.deepEqual(await bResult, { ok: true, value: { from: 'b' } });
  } finally { cleanup(meld); }
});
test('S2: el cierre del socket anterior rechaza solo sus pendientes y no toca la llamada nueva', async t => {
  installWs(t); installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    const first = FakeWebSocket.created[0]; first.readyState = 1;
    const a = sendRpc(meld, 'A');
    meld.start('ws://b');
    const second = FakeWebSocket.created[1]; second.readyState = 1;
    const bResult = sendRpc(meld, 'B').then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    let bDone = false; bResult.then(() => { bDone = true; });
    first.remoteClose();
    const aOutcome = await race(a);
    assert.equal(aOutcome.ok, false, 'el cierre del socket anterior rechaza su propia llamada');
    await settle();
    assert.equal(bDone, false, 'el cierre del socket anterior no rechaza la llamada del socket actual');
    const bId = second.sentOfType(T_INVOKE)[0].id;
    second.message({ type: T_RESPONSE, id: bId, data: { from: 'b' } });
    assert.deepEqual(await bResult, { ok: true, value: { from: 'b' } });
  } finally { cleanup(meld); }
});
test('S3: el timeout ordinario de 8000 ms se limpia al resolver y al desconectar la llamada', async t => {
  installWs(t); const clock = installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    const ws = FakeWebSocket.created[0]; ws.readyState = 1;
    const call = sendRpc(meld, 10);
    const id = ws.sentOfType(T_INVOKE)[0].id;
    assert.equal(clock.active(8000).length, 1, 'un RPC ordinario arma su timeout de 8000 ms');
    ws.message({ type: T_RESPONSE, id, data: { ok: true } });
    assert.deepEqual((await race(call)).value, { ok: true });
    assert.equal(clock.active(8000).length, 0, 'al resolver no puede quedar el timeout armado');
    const pending = sendRpc(meld, 11);
    const outcome = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    ws.remoteClose();
    const result = await race(outcome);
    assert.equal(result.value.ok, false, 'la desconexión rechaza la llamada pendiente');
    assert.equal(clock.active(8000).length, 0, 'la desconexión limpia el timeout de la llamada rechazada');
  } finally { cleanup(meld); }
});
test('S3: el reintento de 5000 ms se cancela y un callback obsoleto no abre otra conexión', async t => {
  installWs(t); const clock = installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    FakeWebSocket.created[0].remoteClose();
    const retry = clock.at(5000);
    assert.equal(retry.length, 1, 'la desconexión programa el reintento ordinario de 5000 ms');
    meld.stop();
    assert.equal(clock.active(5000).length, 0, 'stop cancela físicamente el reintento');
    meld.start('ws://a');
    assert.equal(FakeWebSocket.created.length, 2, 'stop/start sigue siendo reiniciable sin abrir de más');
    retry[0].fn();
    assert.equal(FakeWebSocket.created.length, 2, 'un callback de reintento obsoleto no crea una conexión nueva');
  } finally { cleanup(meld); }
});
test('S4: una init tardía en un socket sustituido no suscribe ni cambia el estado', async t => {
  installWs(t); installClock(t);
  const meld = new Meld(() => {});
  const sessions = []; meld.on('session', s => sessions.push(s));
  try {
    meld.start('ws://a');
    const first = FakeWebSocket.created[0];
    first.open();
    const initId = first.sentOfType(T_INIT)[0].id;
    meld.start('ws://b');
    const second = FakeWebSocket.created[1]; second.readyState = 1;
    first.message({ type: T_RESPONSE, id: initId, data: initPayload([['sessionChanged', 5]]) });
    await settle();
    assert.notEqual(meld.status.state, 'conectado', 'la init obsoleta no reactiva el estado');
    assert.equal(second.sentOfType(T_CONNECT_SIGNAL).length, 0, 'la init obsoleta no suscribe en el socket actual');
    assert.equal(sessions.length, 0, 'la init obsoleta no emite sesión');
  } finally { cleanup(meld); }
});
test('S4: una init que llega tras stop no reactiva la conexión parada', async t => {
  installWs(t); installClock(t);
  const seen = []; const onUR = e => seen.push(e);
  process.on('unhandledRejection', onUR);
  const meld = new Meld(() => {});
  try {
    meld.start('ws://a');
    const ws = FakeWebSocket.created[0];
    ws.open();
    const initId = ws.sentOfType(T_INIT)[0].id;
    meld.stop();
    ws.message({ type: T_RESPONSE, id: initId, data: initPayload() });
    await settle();
    assert.equal(meld.status.state, 'desconectado', 'la init tras stop no vuelve a conectar el estado');
    assert.equal(ws.sentOfType(T_CONNECT_SIGNAL).length, 0, 'no se suscriben señales tras stop');
    assert.equal(seen.length, 0, 'la init tras stop no deja rechazos huérfanos');
  } finally { process.off('unhandledRejection', onUR); cleanup(meld); }
});
test('S4: un logger que lanza no produce rechazos huérfanos durante la init', async t => {
  installWs(t); installClock(t);
  const seen = []; const onUR = e => seen.push(e);
  process.on('unhandledRejection', onUR);
  const meld = new Meld(() => { throw new Error('logger roto'); });
  try {
    meld.start('ws://a');
    const ws = FakeWebSocket.created[0];
    ws.open();
    const initId = ws.sentOfType(T_INIT)[0].id;
    ws.message({ type: T_RESPONSE, id: initId, data: {} });
    await settle(8);
    assert.equal(seen.length, 0, 'el logger que lanza no debe escapar como rechazo no gestionado');
  } finally { process.off('unhandledRejection', onUR); cleanup(meld); }
});
test('S3: timeout ordinario rechaza y reintento vigente vuelve a conectar', async t => {
  installWs(t); const clock = installClock(t);
  const meld = new Meld(() => {});
  try {
    meld.start();
    const ws = FakeWebSocket.created[0]; ws.readyState = 1;
    const result = race(sendRpc(meld, 10));
    clock.at(8000)[0].fn();
    assert.equal((await result).error.message, 'Meld no responde');
    assert.equal(clock.active(8000).length, 0);
    ws.remoteClose();
    clock.at(5000)[0].fn();
    assert.equal(FakeWebSocket.created.length, 2);
    assert.equal(clock.active(5000).length, 0);
    assert.equal(meld.status.state, 'conectando');
  } finally { cleanup(meld); }
});
test('S4: open y notificaciones obsoletas no producen init, idle ni sesión', async t => {
  installWs(t); installClock(t);
  const meld = new Meld(() => {});
  const sessions = []; meld.on('session', value => sessions.push(value));
  try {
    meld.start();
    const old = FakeWebSocket.created[0];
    meld.start();
    const current = FakeWebSocket.created[1]; current.readyState = 1;
    const status = { ...meld.status };
    old.open();
    old.message({ type: 2, data: [{ object: 'meld', properties: { 1: true } }] });
    old.message({ type: 1, object: 'meld', signal: 5 });
    await settle();
    assert.deepEqual(old.sent, []);
    assert.deepEqual(current.sent, []);
    assert.deepEqual(sessions, []);
    assert.deepEqual(meld.status, status);
  } finally { cleanup(meld); }
});
test('S5: stop/start ordinario sigue siendo reiniciable', async t => {
  installWs(t);
  const meld = new Meld(() => {});
  try {
    meld.start();
    const first = FakeWebSocket.created[0];
    meld.stop();
    assert.equal(first.closeCalls, 1, 'stop ordinario cierra el socket vigente');
    assert.equal(meld.status.state, 'desconectado');
    meld.start();
    assert.equal(FakeWebSocket.created.length, 2, 'stop/start vuelve a conectar');
    assert.equal(meld.status.state, 'conectando');
  } finally { cleanup(meld); }
});
