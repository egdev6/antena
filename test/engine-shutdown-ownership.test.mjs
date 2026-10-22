// ODD-08 (#26): caracterización de los residuales #21, #22 y #23 del cierre del Engine.
// #22 (bus que lanza al aceptar) reproduce el bloqueo: RED real y corrección en `send`.
// #21 caracteriza limpieza de fallbacks vivos por ACK, además del vencimiento de escena/capa:
// estos vencimientos no prueban cancelación de #schedule (no hay caller de producción).
// #23 (envío duplicado durante el drenaje) ya cumple: regresión, sin RED inventado.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso:
// ninguna prueba abre red real ni hardware.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const FALLBACK_MS = 120_000;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Reloj físico falso: registra cada asa viva y su estado ref/unref.
function makeClock(t) {
  const active = new Map();
  const cleared = [];
  let seq = 1;
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const handle = { id: seq++, delay: Number(delay), hasRef: true,
      ref() { handle.hasRef = true; return handle; },
      unref() { handle.hasRef = false; return handle; } };
    active.set(handle, { fn, delay: Number(delay) });
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => { cleared.push(handle); active.delete(handle); });
  return {
    active, cleared,
    withDelay: (delay) => [...active.keys()].filter(h => active.get(h).delay === delay),
    fire(handle) { const entry = active.get(handle); active.delete(handle); entry.fn(); },
    referred: () => [...active.keys()].filter(h => h.hasRef),
    get size() { return active.size; },
  };
}

function makeMeld() {
  const calls = [];
  const waiting = [];
  const provider = (name) => (...args) => { const d = deferred(); calls.push({ name, args }); waiting.push(d); return d.promise; };
  return {
    calls, waiting,
    session: () => ({ scenes: [{ id: 's1', current: true }, { id: 's2', current: false }] }),
    showScene: provider('showScene'),
    setLayer: provider('setLayer'),
    command: provider('command'),
  };
}

function makeEngine({ meld = makeMeld(), overlay = 0 } = {}) {
  const logs = [];
  const sent = [];
  const engine = new Engine({
    store: { config: { paused: false }, patchConfig: async () => {} },
    bus: { history: [], historySize: 100, overlayCount: () => overlay, send(event, data, kinds) { sent.push({ event, data, kinds }); } },
    session: { record() {} },
    meld,
    twitch: { sendChat: () => Promise.resolve() },
    log: (...a) => logs.push(a.join(' ')),
  });
  return { engine, logs, sent };
}

const alertFor = (id, command = id) => ({ id, actions: [{ kind: 'command', command }], vars: {} });

// Estado observable del drenaje sin esperas reales: compite contra un centinela de setImmediate.
async function settledState(promise) {
  const SENTINEL = Symbol('pending');
  return Promise.race([promise.then(() => 'drained', e => e), flush().then(() => SENTINEL)])
    .then(r => (r === SENTINEL ? 'pending' : r));
}

// ---------- #22: el bus lanza al aceptar ----------

test('#22 A: overlayCount que lanza tras crear el ciclo no deja la propiedad colgada', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine, sent } = makeEngine({ meld, overlay: 1 });
  const boom = new Error('overlayCount roto');
  engine.bus.overlayCount = () => { throw boom; };
  assert.throws(() => engine.send(alertFor('b1')), boom, 'el fallo de aceptación llega al llamador');
  assert.equal(engine.pendingActions.has('b1'), false, 'no queda acción pendiente para el id');
  assert.equal(engine.hasPendingAck('b1'), false, 'no queda ticket privado de ACK');
  assert.equal(clock.size, 0, 'no se arma ningún fallback');
  assert.equal(await settledState(engine.drainSentActions()), 'drained', 'el drenaje de envíos resuelve');
  assert.equal(await settledState(engine.drainActions()), 'drained', 'el drenaje de raíces resuelve');
  assert.equal(meld.calls.length, 0, 'las acciones no se ejecutan');
  assert.equal(sent.some(s => s.event === 'alert'), false, 'la alerta no llega al overlay');

  // El id sigue siendo utilizable: un envío posterior sano abre su propio ciclo.
  engine.bus.overlayCount = () => 1;
  engine.send(alertFor('b1', 'sano'));
  assert.equal(engine.hasPendingAck('b1'), true, 'la generación posterior queda pendiente de ACK');
  const dq = engine.drainSentActions();
  assert.equal(await settledState(dq), 'pending', 'el drenaje espera la generación sana');
  engine.alertShown('b1');
  await flush();
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(dq), 'drained');
  assert.deepEqual(meld.calls.map(c => c.args[0]), ['sano'], 'solo se ejecuta la generación sana');
  assert.equal(clock.size, 0, 'sin asas');
});

test('#22 B: bus.send que lanza con el fallback armado lo destruye y libera el drenaje', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  const boom = new Error('bus.send roto');
  engine.bus.send = (event) => { if (event === 'alert') throw boom; };
  assert.throws(() => engine.send(alertFor('b2')), boom, 'el fallo de aceptación llega al llamador');
  assert.equal(engine.pendingActions.has('b2'), false, 'no queda acción pendiente para el id');
  assert.equal(engine.hasPendingAck('b2'), false, 'no queda ticket privado de ACK');
  assert.equal(engine.fallbackTimers.has('b2'), false, 'no queda propiedad del fallback');
  assert.equal(clock.withDelay(FALLBACK_MS).length, 0, 'el asa física de 120 s se destruye');
  const dq = engine.drainSentActions();
  assert.equal(await settledState(dq), 'drained', 'el drenaje no espera 120 s');
  assert.deepEqual(clock.referred(), [], 'ningún asa queda referida para el proceso');
  assert.equal(meld.calls.length, 0, 'las acciones de una alerta no emitida no se ejecutan');
});

test('#22 B duplicado: el reenvío que lanza solo retira su asa y conserva la aceptación previa', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  engine.send(alertFor('b3'));
  const [first] = clock.withDelay(FALLBACK_MS);
  const boom = new Error('bus.send roto');
  const send = engine.bus.send;
  engine.bus.send = (event, ...rest) => { if (event === 'alert') throw boom; return send.call(engine.bus, event, ...rest); };
  assert.throws(() => engine.send(alertFor('b3', 'dup')), boom);
  assert.deepEqual(clock.withDelay(FALLBACK_MS), [first], 'solo sobrevive el fallback original');
  assert.equal(engine.hasPendingAck('b3'), true, 'la aceptación previa sigue pendiente de ACK');
  const dq = engine.drainSentActions();
  assert.equal(await settledState(dq), 'pending', 'el drenaje sigue esperando la aceptación previa');
  assert.equal(first.hasRef, true, 'el fallback original queda referido por el drenaje');
  clock.fire(first);
  await flush();
  assert.deepEqual(meld.calls.map(c => c.args[0]), ['dup'], 'se conserva la política previa de payload vigente, incluso del duplicado fallido');
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(dq), 'drained');
  assert.equal(clock.size, 0, 'sin asas');
});

test('#22 reentrante: el envío interior exitoso del mismo ciclo sobrevive al fallo exterior', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine, sent } = makeEngine({ meld, overlay: 1 });
  const outer = alertFor('reentrant', 'exterior');
  const inner = alertFor('reentrant', 'interior');
  const boom = new Error('fallo exterior tras aceptar interior');
  const send = engine.bus.send;
  let generation;
  engine.bus.send = (event, data, kinds) => {
    if (event === 'alert' && data === outer) {
      generation = engine.capturePendingAcks();
      engine.send(inner);
      assert.equal(generation.isCurrent(inner.id), true, 'el interior reutiliza el MISMO ciclo sin ACK');
      throw boom;
    }
    return send.call(engine.bus, event, data, kinds);
  };
  assert.throws(() => engine.send(outer), e => e === boom, 'el error exterior no se oculta');
  assert.equal(sent.filter(s => s.event === 'alert' && s.data === inner).length, 1, 'el interior se emitió con éxito');
  assert.equal(engine.hasPendingAck(inner.id), true, 'la aceptación interior exitosa sigue pendiente');
  assert.equal(generation.isCurrent(inner.id), true, 'no se sustituye ni libera el ciclo compartido');
  assert.equal(engine.pendingActions.get(inner.id), inner, 'se conserva el payload vigente');
  const handles = clock.withDelay(FALLBACK_MS);
  assert.equal(handles.length, 1, 'solo se destruye el fallback exterior fallido');
  assert.deepEqual([...engine.fallbackTimers.get(inner.id)], handles, 'el fallback interior conserva dueño');
  const dq = engine.drainSentActions();
  assert.equal(await settledState(dq), 'pending', 'el drenaje espera la aceptación interior');
  assert.equal(handles[0].hasRef, true, 'el drenaje refiere el fallback superviviente');
  clock.fire(handles[0]);
  await flush();
  assert.deepEqual(meld.calls.map(c => c.args[0]), ['interior'], 'el fallback ejecuta una sola vez el payload interior');
  assert.equal(clock.size, 0, 'sin fallback huérfano');
  assert.equal(await settledState(dq), 'pending', 'se espera también al proveedor');
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(dq), 'drained');
  engine.alertShown(inner.id);
  assert.equal(meld.calls.length, 1, 'un ACK tardío no duplica acciones');
  assert.equal(engine.hasPendingAck(inner.id), false);
});

test('#22 reentrante con ACK síncrono: el fallo exterior no consume la nueva generación', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  const outer = alertFor('next-generation', 'exterior');
  const inner = alertFor('next-generation', 'nueva');
  const boom = new Error('fallo exterior tras ACK y nueva generación');
  const send = engine.bus.send;
  let dq, generation;
  engine.bus.send = (event, data, kinds) => {
    if (event === 'alert' && data === outer) {
      generation = engine.capturePendingAcks();
      dq = engine.drainSentActions();
      engine.alertShown(outer.id);
      engine.send(inner);
      throw boom;
    }
    return send.call(engine.bus, event, data, kinds);
  };
  assert.throws(() => engine.send(outer), e => e === boom);
  assert.equal(generation.isCurrent(inner.id), false, 'el ACK separó las generaciones');
  assert.equal(engine.hasPendingAck(inner.id), true, 'la nueva generación conserva su aceptación');
  assert.equal(engine.pendingActions.get(inner.id), inner);
  const [fallback] = clock.withDelay(FALLBACK_MS);
  assert.ok(fallback, 'el rollback exterior no destruye el fallback nuevo');
  assert.equal(fallback.hasRef, false, 'la nueva generación queda fuera del corte anterior');
  assert.equal(await settledState(dq), 'pending', 'las acciones ya despachadas siguen poseídas');
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(dq), 'drained', 'el corte anterior no espera la nueva generación');
  const next = engine.drainSentActions();
  assert.equal(await settledState(next), 'pending');
  engine.alertShown(inner.id);
  await flush();
  assert.deepEqual(meld.calls.map(c => c.args[0]), ['exterior', 'nueva']);
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(next), 'drained');
  assert.equal(clock.size, 0);
});

test('#22 sin overlay: si bus.send lanza tras despachar, el ciclo despachado sigue poseído', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 0 });
  const boom = new Error('bus.send roto');
  engine.bus.send = (event) => { if (event === 'alert') throw boom; };
  assert.throws(() => engine.send(alertFor('b4')), boom);
  await flush();
  assert.equal(meld.calls.length, 1, 'las acciones ya despachadas siguen en vuelo');
  const dq = engine.drainSentActions();
  assert.equal(await settledState(dq), 'pending', 'el drenaje espera las acciones en vuelo');
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(dq), 'drained');
  assert.equal(clock.size, 0, 'sin asas');
});

// ---------- #21: limpieza alcanzable y vencimientos (no cancelación de #schedule) ----------

for (const duplicate of [false, true]) {
  test(`#21: ACK durante drain limpia fallbacks VIVOS y libera el ticket (duplicado=${duplicate})`, async t => {
    const clock = makeClock(t);
    const meld = makeMeld();
    const { engine } = makeEngine({ meld, overlay: 1 });
    engine.send(alertFor('live-cleanup', 'original'));
    const dq = engine.drainSentActions();
    if (duplicate) engine.send(alertFor('live-cleanup', 'vigente'));
    const handles = clock.withDelay(FALLBACK_MS);
    const callbacks = handles.map(h => clock.active.get(h).fn);
    assert.equal(handles.length, duplicate ? 2 : 1);
    assert.equal(handles.every(h => clock.active.has(h) && h.hasRef), true, 'asas vivas referidas por el drenaje');
    assert.equal(await settledState(dq), 'pending');
    engine.alertShown('live-cleanup'); // caller real: POST /api/overlay/shown, no se dispara ningún timer
    assert.deepEqual(clock.cleared, handles, 'el ACK cancela cada asa física aún viva');
    assert.equal(clock.size, 0, 'la limpieza no depende de disparar el reloj');
    assert.equal(engine.fallbackTimers.has('live-cleanup'), false);
    assert.equal(engine.hasPendingAck('live-cleanup'), false);
    assert.equal(engine.pendingActions.has('live-cleanup'), false);
    await flush();
    assert.deepEqual(meld.calls.map(c => c.args[0]), [duplicate ? 'vigente' : 'original']);
    assert.equal(await settledState(dq), 'pending', 'la limpieza no abandona las acciones despachadas');
    meld.waiting.shift().resolve('ok');
    assert.equal(await settledState(dq), 'drained', 'el ticket se libera sin callback del fallback');
    assert.equal(await settledState(engine.drainActions()), 'drained');
    assert.equal(await settledState(engine.drainSentActions()), 'drained');
    for (const fn of callbacks) fn();
    engine.alertShown('live-cleanup');
    assert.equal(meld.calls.length, 1, 'callbacks obsoletos y ACK duplicado no reejecutan');
    assert.equal(clock.size, 0);
  });
}

test('#21: el retorno de escena y el ocultado de capa pendientes se esperan y no quedan referidos', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld });
  const ret = engine.runActions([
    { kind: 'scene', scene: 's2', returnAfterSec: 5 },
    { kind: 'layer', scene: 's1', layer: 'l1', seconds: 4 },
  ]);
  meld.waiting.shift().resolve('s2');
  await flush();
  meld.waiting.shift().resolve('l1');
  await ret;
  const [back] = clock.withDelay(5000);
  const [hide] = clock.withDelay(4000);
  assert.ok(back && hide, 'retorno y ocultado programados');
  assert.deepEqual(clock.referred(), [], 'fuera del drenaje los temporizadores no retienen el proceso');
  let done = 0;
  const dq = engine.drainActions().then(() => { done++; });
  assert.equal(await settledState(dq), 'pending', 'el drenaje espera los temporizadores pendientes');
  assert.equal(back.hasRef && hide.hasRef, true, 'el drenaje refiere ambos temporizadores');
  clock.fire(back);
  await flush();
  assert.deepEqual(meld.calls.at(-1), { name: 'showScene', args: ['s1'] }, 'vuelve a la escena previa');
  meld.waiting.shift().resolve('s1');
  await flush();
  assert.equal(done, 0, 'el ocultado sigue pendiente');
  assert.equal(hide.hasRef, true, 'el temporizador restante sigue referido');
  clock.fire(hide);
  await flush();
  assert.deepEqual(meld.calls.at(-1), { name: 'setLayer', args: ['s1', 'l1', false] }, 'oculta la capa');
  meld.waiting.shift().resolve();
  assert.equal(await settledState(dq), 'drained', 'el drenaje resuelve tras los temporizadores');
  assert.equal(done, 1, 'resuelve una sola vez');
  assert.equal(clock.size, 0, 'ningún asa sobrevive al drenaje');
  assert.deepEqual(clock.referred(), [], 'ningún asa queda referida');
});

test('#21: un temporizador de una raíz fuera del corte vuelve a unref al terminar el drenaje', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  engine.send({ id: 'c1', actions: [{ kind: 'scene', scene: 's2', returnAfterSec: 3 }], vars: {} });
  const dq = engine.drainSentActions();
  assert.equal(await settledState(dq), 'pending', 'el drenaje espera el ACK');
  engine.alertShown('c1');
  await flush();
  meld.waiting.shift().resolve('s2');
  await flush();
  const [back] = clock.withDelay(3000);
  assert.equal(back.hasRef, true, 'el retorno creado durante el drenaje nace referido');
  // Una raíz posterior al corte programa su propio retorno: no la posee este drenaje.
  const later = engine.runActions([{ kind: 'scene', scene: 's2', returnAfterSec: 7 }]);
  meld.waiting.shift().resolve('s2');
  await later;
  const [outside] = clock.withDelay(7000);
  assert.equal(outside.hasRef, false, 'la raíz fuera del corte queda unref');
  clock.fire(back);
  await flush();
  meld.waiting.shift().resolve('s1');
  assert.equal(await settledState(dq), 'drained', 'el drenaje resuelve tras el retorno capturado');
  assert.deepEqual(clock.referred(), [], 'tras el drenaje nada queda referido');
  clock.fire(outside);
  await flush();
  meld.waiting.shift().resolve('s1');
  await engine.drainActions();
  assert.equal(clock.size, 0, 'sin asas');
});

// ---------- #23: envío duplicado durante el drenaje ----------

for (const order of ['ack-then-fallback', 'fallback-then-ack']) {
  test(`#23: send duplicado durante el drenaje ejecuta una sola vez (${order})`, async t => {
    const clock = makeClock(t);
    const meld = makeMeld();
    const { engine, sent } = makeEngine({ meld, overlay: 1 });
    engine.send(alertFor('d1', 'primero'));
    let done = 0;
    const dq = engine.drainSentActions().then(() => { done++; });
    assert.equal(await settledState(dq), 'pending', 'el drenaje espera el ACK');
    engine.send(alertFor('d1', 'segundo'));
    const handles = clock.withDelay(FALLBACK_MS);
    assert.equal(handles.length, 2, 'el duplicado arma su asa en el mismo ciclo');
    assert.equal(handles.every(h => h.hasRef), true, 'ambas asas quedan referidas por el drenaje');
    assert.equal(sent.filter(s => s.event === 'alert').length, 2, 'el overlay recibe ambos envíos');
    const callbacks = handles.map(h => clock.active.get(h).fn);
    if (order === 'ack-then-fallback') { engine.alertShown('d1'); for (const fn of callbacks) fn(); }
    else { clock.fire(handles[0]); engine.alertShown('d1'); for (const fn of callbacks) fn(); }
    await flush();
    assert.deepEqual(meld.calls.map(c => c.args[0]), ['segundo'], 'una sola ejecución con el payload vigente');
    assert.equal(clock.size, 0, 'todas las asas físicas destruidas');
    assert.equal(done, 0, 'el drenaje espera la ejecución');
    meld.waiting.shift().resolve('ok');
    assert.equal(await settledState(dq), 'drained');
    await flush();
    assert.equal(done, 1, 'el drenaje resuelve una sola vez');
    assert.equal(engine.hasPendingAck('d1'), false, 'sin propiedad pendiente');
    assert.equal(await settledState(engine.drainSentActions()), 'drained', 'un drenaje posterior está vacío');
    assert.equal(meld.calls.length, 1, 'nada vuelve a ejecutarse');
  });
}

test('#23: un reenvío tras el ACK durante el drenaje es otra generación fuera del corte', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  engine.send(alertFor('d2', 'primero'));
  const dq = engine.drainSentActions();
  engine.alertShown('d2');
  await flush();
  engine.send(alertFor('d2', 'segundo'));
  assert.equal(engine.hasPendingAck('d2'), true, 'la generación nueva espera su propio ACK');
  meld.waiting.shift().resolve('ok');
  assert.equal(await settledState(dq), 'drained', 'el corte no espera la generación posterior');
  assert.deepEqual(meld.calls.map(c => c.args[0]), ['primero'], 'la primera generación una vez');
  engine.alertShown('d2');
  await flush();
  meld.waiting.shift().resolve('ok');
  assert.deepEqual(meld.calls.map(c => c.args[0]), ['primero', 'segundo'], 'cada generación una vez');
  assert.equal(clock.size, 0, 'sin asas');
});
