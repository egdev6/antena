import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meld } from '../src/meld.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
class Socket extends EventTarget {
  static all = [];
  constructor() { super(); this.readyState = 0; this.sent = []; this.closes = 0; Socket.all.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  reply(id, data = {}) { this.onmessage?.({ data: JSON.stringify({ type: 10, id, data }) }); }
  close() { this.closes++; this.readyState = 2; }
  finish() {
    this.readyState = 3;
    this.onclose?.();
    this.dispatchEvent(new Event('close'));
  }
}
function setup(t) {
  const original = { WebSocket: globalThis.WebSocket, setTimeout, clearTimeout };
  const timers = [];
  globalThis.WebSocket = Socket; Socket.all = [];
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false, unref() {} };
    timers.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
  const meld = new Meld(() => {});
  t.after(() => {
    meld.removeAllListeners();
    meld.stopped = true;
    for (const ws of Socket.all) ws.finish();
    Object.assign(globalThis, original);
  });
  const socket = () => { meld.start(); return Socket.all.at(-1); };
  const rpc = ws => {
    ws.readyState = 1;
    const result = outcome(meld.send({ type: 6, method: 10 }, true));
    return { result, id: ws.sent.at(-1).id };
  };
  return { meld, socket, rpc, timers };
}

test('S1: corte terminal síncrono, promesa única y reentrada de estado', async t => {
  const { meld, socket, timers } = setup(t);
  const ws = socket(); ws.readyState = 1;
  const close = meld.quiesceClose();
  assert.equal(meld.quiesceClose(), close);
  await assert.rejects(meld.send({ type: 4 }), /cerrando/);
  meld.methods.action = 10;
  await assert.rejects(meld.call('action'), /cerrando/);
  meld.start(); meld.connect(); meld.retry(new Error('retry'));
  assert.equal(Socket.all.length, 1);
  assert.equal(ws.sent.length, 0);
  assert.equal(timers.length, 0);
  meld.on('status', () => { assert.equal(meld.quiesceClose(), close); meld.start(); });
  await tick();
  assert.equal(ws.closes, 1);
  ws.finish(); await close;
  assert.equal(Socket.all.length, 1);
  assert.equal(meld.status.state, 'desconectado');
  assert.equal(meld.quiesceClose(), close);
});

test('S2: RPC de todos los sockets antes del cierre; stop no las cancela', async t => {
  const { meld, socket, rpc } = setup(t);
  const a = socket(), first = rpc(a);
  const b = socket(), second = rpc(b);
  const close = meld.quiesceClose();
  let done = false; close.then(() => { done = true; });
  meld.stop(); await tick();
  assert.deepEqual([a.closes, b.closes], [0, 0]);
  a.reply(first.id, 'primera');
  assert.deepEqual(await first.result, { value: 'primera' });
  await tick(); assert.equal(b.closes, 0);
  b.reply(second.id, 'segunda');
  assert.deepEqual(await second.result, { value: 'segunda' });
  await tick(); assert.deepEqual([a.closes, b.closes], [1, 1]);
  a.finish(); await tick(); assert.equal(done, false);
  b.finish(); await close; assert.equal(done, true);
});

test('S2/S4: desconexión fallida retenida mientras otra RPC y socket terminan', async t => {
  const { meld, socket, rpc } = setup(t);
  const a = socket(), first = rpc(a);
  const b = socket(), second = rpc(b);
  const close = meld.quiesceClose(), result = outcome(close);
  let done = false; result.then(() => { done = true; });
  a.finish();
  assert.match((await first.result).error.message, /desconectado/);
  await tick(); assert.equal(b.closes, 0); assert.equal(done, false);
  b.reply(second.id); await second.result;
  await tick(); assert.equal(b.closes, 1); assert.equal(done, false);
  b.finish(); assert.ok((await result).error instanceof AggregateError);
  assert.equal(meld.quiesceClose(), close);
});

test('S2/S5: timeout RPC existente, sin nuevo deadline ni historial reabierto', async t => {
  const { meld, socket, rpc, timers } = setup(t);
  const ws = socket(), accepted = rpc(ws);
  const close = outcome(meld.quiesceClose());
  assert.deepEqual(timers.map(timer => timer.ms), [8000]);
  timers[0].fn();
  assert.equal((await accepted.result).error.message, 'Meld no responde');
  await tick(); assert.equal(ws.closes, 1);
  ws.finish(); assert.ok((await close).error instanceof AggregateError);
});

test('S3: CONNECTING, CLOSING y CLOSED; no confundir solicitud con cierre físico', async t => {
  const { meld, socket } = setup(t);
  const connecting = socket();
  const closing = socket(); closing.readyState = 2;
  const closed = socket(); closed.readyState = 3;
  const close = meld.quiesceClose();
  let done = false; close.then(() => { done = true; });
  await tick(); assert.equal(connecting.closes, 1); assert.equal(closed.closes, 0);
  assert.equal(done, false);
  connecting.finish(); await tick(); assert.equal(done, false);
  closing.finish(); await close;
});

test('S3: cierre síncrono y close que lanza no impiden esperar los otros sockets', async t => {
  const { meld, socket } = setup(t);
  const bad = socket(); bad.close = () => { throw new Error('close roto'); };
  const sync = socket(); sync.close = () => { sync.closes++; sync.finish(); };
  const delayed = socket();
  const result = outcome(meld.quiesceClose());
  let done = false; result.then(() => { done = true; });
  await tick();
  assert.equal(sync.closes, 1); assert.equal(delayed.closes, 1); assert.equal(done, false);
  delayed.finish();
  assert.equal((await result).error.errors[0].message, 'close roto');
});

test('S4: init tardía no suscribe ni emite sesión; listener fallido no evita cierres', async t => {
  const { meld, socket } = setup(t);
  const ws = socket(); ws.open();
  const init = ws.sent[0]; let sessions = 0;
  meld.on('session', () => sessions++);
  const result = outcome(meld.quiesceClose());
  meld.on('status', () => { throw new Error('listener roto'); });
  ws.reply(init.id, { meld: { signals: [['sessionChanged', 5]], properties: [] } });
  await tick();
  assert.deepEqual(ws.sent, [init]); assert.equal(sessions, 0);
  assert.equal(ws.closes, 1);
  ws.finish(); assert.ok((await result).error);
});

test('S4: retry cancelado, callback obsoleto y fallo anterior al corte ignorado', async t => {
  const { meld, socket, rpc, timers } = setup(t);
  const ws = socket(), accepted = rpc(ws);
  ws.finish(); await accepted.result;
  const retry = timers.find(timer => timer.ms === 5000);
  const close = meld.quiesceClose();
  assert.equal(retry.cleared, true);
  retry.fn(); await close;
  assert.equal(Socket.all.length, 1);
});
