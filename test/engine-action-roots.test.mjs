// ODD-08b.2b.2b.2b: propiedad de las raíces de acciones de Engine.
// SOLO pruebas. Los casos RED demuestran que hoy no existe `drainActions` ni registro de raíces:
// el drenaje ausente resuelve de inmediato con trabajo aceptado en vuelo. Las guardas que ya
// cumplen (drenaje vacío sano) no se fuerzan a rojo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso:
// ninguna prueba abre red real ni hardware.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const AGG = 'No se pudieron drenar las acciones de Engine.';
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Reloj físico falso: registra cada asa viva y su estado ref/unref.
function makeClock(t) {
  const active = new Map();
  let seq = 1;
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const handle = { id: seq++, delay: Number(delay), hasRef: true,
      ref() { handle.hasRef = true; return handle; },
      unref() { handle.hasRef = false; return handle; } };
    active.set(handle, { fn, delay: Number(delay) });
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => { active.delete(handle); });
  return {
    active,
    withDelay: (delay) => [...active.keys()].filter(h => active.get(h).delay === delay),
    fire(handle) { const entry = active.get(handle); active.delete(handle); entry.fn(); },
    get size() { return active.size; },
  };
}

function makeMeld() {
  const calls = [];
  const waiting = [];
  const provider = (name) => (...args) => { const d = deferred(); calls.push({ name, args, deferred: d }); waiting.push(d); return d.promise; };
  return {
    calls, waiting,
    session: () => ({ scenes: [{ id: 's1', current: true }, { id: 's2', current: false }] }),
    showScene: provider('showScene'),
    setLayer: provider('setLayer'),
    command: provider('command'),
  };
}

function makeEngine({ meld = makeMeld(), log } = {}) {
  const logs = [];
  const events = [];
  const engine = new Engine({
    store: { config: { paused: false } },
    bus: { history: [], historySize: 100, overlayCount: () => 0, send() {} },
    session: { record() {} },
    meld,
    twitch: { sendChat: () => Promise.resolve() },
    log: log || ((...a) => logs.push(a.join(' '))),
  });
  engine.on('actionError', e => events.push(e));
  return { engine, logs, events };
}

// Fallback del API ausente: sin `drainActions` el OLD resuelve de inmediato.
const drainOf = (engine) => (typeof engine.drainActions === 'function' ? engine.drainActions() : Promise.resolve());

test('la API de drenaje existe y un drenaje vacío es sano', async () => {
  assert.equal(typeof Engine.prototype.drainActions, 'function', 'drainActions debe existir');
  const { engine } = makeEngine();
  await drainOf(engine);
  assert.equal(engine.sceneTimers.length, 0);
});

test('un drenaje espera la operación aceptada que sigue en vuelo', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const p = engine.runActions([{ kind: 'command', command: 'saludo' }]);
  await flush();
  assert.equal(meld.waiting.length, 1, 'el proveedor está en vuelo');
  let drained = false;
  const d = drainOf(engine).then(() => { drained = true; });
  await flush();
  assert.equal(drained, false, 'el drenaje no resuelve con trabajo aceptado pendiente');
  meld.waiting.shift().resolve('ok');
  await p;
  await d;
  assert.equal(drained, true, 'el drenaje resuelve cuando la operación termina');
  assert.equal(clock.size, 0, 'sin asas físicas');
});

test('un retraso devuelve pronto pero el drenaje espera su vencimiento original', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const p = engine.runActions([{ kind: 'command', command: 'tarde', delaySec: 3 }]);
  await p;
  assert.equal(meld.calls.length, 0, 'la acción diferida aún no se ejecutó');
  const timers = clock.withDelay(3000);
  assert.equal(timers.length, 1, 'se programa el retraso original de 3 s');
  assert.equal(timers[0].hasRef, true, 'un retraso normal sigue referido');
  let drained = false;
  const d = drainOf(engine).then(() => { drained = true; });
  await flush();
  assert.equal(drained, false, 'el drenaje espera el retraso original');
  assert.equal(clock.size, 1, 'no se adelanta ni se cancela el retraso');
  clock.fire(timers[0]);
  await flush();
  assert.equal(meld.waiting.length, 1, 'el proveedor diferido arrancó');
  meld.waiting.shift().resolve('ok');
  await d;
  assert.equal(drained, true);
});

test('una acción programada después del corte sigue perteneciendo a la raíz capturada', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const p = engine.runActions([
    { kind: 'command', command: 'primera' },
    { kind: 'command', command: 'segunda', delaySec: 2 },
  ]);
  await flush();
  assert.equal(meld.waiting.length, 1, 'la primera acción ya está en vuelo');
  let drained = false;
  const d = drainOf(engine).then(() => { drained = true; });
  meld.waiting.shift().resolve('1');
  await flush();
  const delayed = clock.withDelay(2000);
  assert.equal(delayed.length, 1, 'la segunda se programó después del corte');
  assert.equal(drained, false, 'el drenaje sigue esperando a la raíz capturada');
  clock.fire(delayed[0]);
  await flush();
  meld.waiting.shift().resolve('2');
  await d;
  assert.equal(drained, true);
  await p;
});

test('retorno de escena y ocultado de capa son descendientes referidos durante el drenaje', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const p = engine.runActions([
    { kind: 'scene', scene: 's2', returnAfterSec: 5, delaySec: 1 },
    { kind: 'layer', scene: 's1', layer: 'l1', seconds: 4, delaySec: 2 },
  ]);
  await p;
  assert.equal(clock.size, 2, 'dos retrasos originales');
  let drained = false;
  const d = drainOf(engine).then(() => { drained = true; });
  await flush();
  assert.equal(drained, false, 'drena los descendientes futuros');

  clock.fire(clock.withDelay(1000)[0]);
  await flush();
  meld.waiting.shift().resolve('s2');
  await flush();
  const ret = clock.withDelay(5000);
  assert.equal(ret.length, 1, 'retorno de escena programado');
  assert.equal(ret[0].hasRef, true, 'el descendiente queda referido mientras se drena');
  assert.equal(engine.sceneTimers.at(-1), ret[0], 'sceneTimers conserva el asa');

  clock.fire(clock.withDelay(2000)[0]);
  await flush();
  meld.waiting.shift().resolve();
  await flush();
  const hide = clock.withDelay(4000);
  assert.equal(hide.length, 1, 'ocultado de capa programado');
  assert.equal(hide[0].hasRef, true, 'el ocultado queda referido mientras se drena');

  clock.fire(ret[0]);
  clock.fire(hide[0]);
  await flush();
  meld.waiting.shift().resolve('s1');
  meld.waiting.shift().resolve();
  await d;
  assert.equal(drained, true);
  assert.equal(clock.size, 0, 'todas las asas consumidas');
});

test('un fallo silencioso no se pierde: drena todas las raíces y agrega la causa original', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine, logs, events } = makeEngine({ meld });
  const boom = new Error('');
  const bad = engine.runActions([{ kind: 'command', command: 'malo' }]);
  const good = engine.runActions([{ kind: 'command', command: 'bueno', delaySec: 2 }]);
  await flush();
  let drained;
  const d = drainOf(engine).then(() => { drained = 'ok'; return 'ok'; }, e => { drained = e; return e; });
  await flush();
  meld.waiting.shift().reject(boom);
  await bad;
  assert.ok(logs.some(l => l.startsWith('[acción]')), 'se conserva el log ordinario');
  assert.equal(events.length, 1, 'se conserva el evento actionError');
  assert.equal(events[0].error, '', 'el mensaje original vacío se conserva');
  assert.equal(drained, undefined, 'aún no drena: la otra raíz sigue sana');
  clock.fire(clock.withDelay(2000)[0]);
  await flush();
  meld.waiting.shift().resolve('ok');
  await good;
  const agg = await d;
  assert.ok(agg instanceof AggregateError, 'rechaza con AggregateError');
  assert.equal(agg.message, AGG, 'mensaje constante');
  assert.deepEqual(agg.errors, [boom], 'incluye la causa original');
  assert.equal(clock.size, 0);
});

test('una raíz iniciada después del corte queda fuera y no envenena drenajes posteriores', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const first = engine.runActions([{ kind: 'command', command: 'uno' }]);
  await flush();
  let seen = null;
  const d1 = drainOf(engine).then(() => { seen = 'd1'; }, e => { seen = e; });
  await flush();
  const second = engine.runActions([{ kind: 'command', command: 'dos' }]);
  await flush();
  assert.equal(meld.waiting.length, 2, 'dos raíces independientes');
  meld.waiting.shift().resolve('1');
  await first;
  await d1;
  assert.equal(seen, 'd1', 'el drenaje solo esperó la raíz capturada');
  assert.equal(meld.waiting.length, 1, 'la raíz posterior sigue en vuelo');

  const d2 = drainOf(engine).then(() => { seen = 'd2'; });
  await flush();
  assert.equal(seen, 'd1', 'el segundo drenaje espera la raíz no capturada antes');
  meld.waiting.shift().resolve('2');
  await second;
  await d2;
  assert.equal(seen, 'd2');
  await drainOf(engine);
  assert.equal(clock.size, 0);
});

test('drenajes concurrentes ven el fallo y el fallo completado no envenena', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const boom = new Error('fallo-pasado');
  const bad = engine.runActions([{ kind: 'command', command: 'malo' }]);
  await flush();
  const da = drainOf(engine).then(() => 'ok', e => e);
  const db = drainOf(engine).then(() => 'ok', e => e);
  await flush();
  meld.waiting.shift().reject(boom);
  await bad;
  const [ra, rb] = await Promise.all([da, db]);
  assert.ok(ra instanceof AggregateError && rb instanceof AggregateError, 'ambos drenajes ven el fallo');
  assert.equal(ra.errors[0], boom);
  await drainOf(engine);
  const healthy = engine.runActions([{ kind: 'command', command: 'sano' }]);
  await flush();
  const dh = drainOf(engine).then(() => 'ok', e => e);
  meld.waiting.shift().resolve('s');
  await healthy;
  assert.equal(await dh, 'ok', 'el fallo completado no envenena');
  assert.equal(clock.size, 0);
});

test('runAction directo conserva retorno/rechazo del proveedor y posee su propio retorno', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const value = engine.runAction({ kind: 'command', command: 'directo' });
  await flush();
  meld.waiting.shift().resolve('valor');
  assert.equal(await value, 'valor', 'retorno del proveedor preservado');

  const boom = new Error('rechazo-directo');
  const rej = engine.runAction({ kind: 'command', command: 'falla' });
  await flush();
  const d = drainOf(engine).then(() => 'ok', e => e);
  meld.waiting.shift().reject(boom);
  await assert.rejects(rej, boom);
  const agg = await d;
  assert.ok(agg instanceof AggregateError, 'la causa del directo se drena');
  assert.equal(agg.errors[0], boom);

  const sc = engine.runAction({ kind: 'scene', scene: 's2', returnAfterSec: 3 });
  await flush();
  meld.waiting.shift().resolve('s2');
  await sc;
  assert.equal(clock.withDelay(3000).length, 1, 'la raíz directa posee su retorno de escena');
  const d2 = drainOf(engine).then(() => 'ok');
  await flush();
  clock.fire(clock.withDelay(3000)[0]);
  await flush();
  meld.waiting.shift().resolve('s1');
  assert.equal(await d2, 'ok', 'el drenaje esperó el retorno del directo');
  assert.equal(clock.size, 0);
});

test('un error de acción se registra y la raíz sana continúa', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine, logs, events } = makeEngine({ meld });
  const unknown = engine.runActions([{ kind: 'desconocida' }]);
  const healthy = engine.runActions([{ kind: 'command', command: 'sana' }]);
  const d = drainOf(engine).then(() => 'ok', e => e);
  await unknown;
  assert.ok(logs.some(l => l.includes('desconocida')), 'log ordinario conservado');
  assert.equal(events.length, 1, 'evento actionError conservado');
  meld.waiting.shift().resolve('s');
  await healthy;
  const agg = await d;
  assert.ok(agg instanceof AggregateError, 'error de acción observable en el drenaje');
  assert.ok(agg.errors[0].message.includes('desconocida'), 'causa original');
  assert.equal(clock.size, 0);
});

test('el registro del error sobrevive aunque el logger lance', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, log: () => { throw new Error('logger-roto'); } });
  const boom = new Error('fallo-accion');
  const p = engine.runActions([{ kind: 'command', command: 'x' }]);
  await flush();
  const d = drainOf(engine).then(() => 'ok', e => e);
  meld.waiting.shift().reject(boom);
  await p.catch(() => {});
  const agg = await d;
  assert.ok(agg instanceof AggregateError && agg.errors[0] === boom, 'la causa original no se pierde');
  assert.equal(clock.size, 0);
});

test('un fallo diferido con logger roto no queda sin dueño y se agrega', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const loggerError = new Error('logger-roto');
  const { engine } = makeEngine({ meld, log: () => { throw loggerError; } });
  const unhandled = [];
  const onUnhandled = (e) => { unhandled.push(e); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const boom = new Error('fallo-diferido');
  const healthy = engine.runActions([{ kind: 'command', command: 'sano', delaySec: 1 }]);
  const bad = engine.runActions([{ kind: 'command', command: 'malo', delaySec: 1 }]);
  const d = drainOf(engine).then(() => 'ok', e => e);
  await healthy;
  await bad;
  const timers = clock.withDelay(1000);
  assert.equal(timers.length, 2, 'dos raíces diferidas capturadas');
  clock.fire(timers[0]);
  clock.fire(timers[1]);
  await flush();
  meld.waiting[0].resolve('s');
  meld.waiting[1].reject(boom);
  await flush(6);
  const agg = await d;
  assert.ok(agg instanceof AggregateError, 'drena el fallo diferido');
  assert.ok(agg.errors.includes(boom), 'causa original del proveedor');
  assert.ok(agg.errors.includes(loggerError), 'causa secundaria real');
  assert.equal(unhandled.length, 0, 'ningún rechazo sin dueño');
  assert.equal(clock.size, 0, 'todas las asas consumidas');
});
