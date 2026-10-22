// ODD-08b.2b.2b.2c: propiedad de la vida útil de los envíos aceptados por `send`.
// SOLO pruebas. Los casos RED demuestran que hoy no existe `drainSentActions`: un envío con
// acciones esperando ACK/fallback no está poseído y el drenaje ausente resuelve de inmediato.
// Las guardas que ya cumplen (duplicados, held, preview) no se fuerzan a rojo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso:
// ninguna prueba abre red real ni hardware.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const AGG = 'No se pudieron drenar las acciones de Engine.';
const FALLBACK_MS = 120_000;
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Reloj físico falso: registra cada asa viva y su estado ref/unref. `unref` devuelve undefined
// para cubrir el caso de retorno no-asa.
function makeClock(t) {
  const active = new Map();
  let seq = 1;
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const handle = { id: seq++, delay: Number(delay), hasRef: true,
      ref() { handle.hasRef = true; return handle; },
      unref() { handle.hasRef = false; return undefined; } };
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
  const provider = (name) => (...args) => { const d = deferred(); calls.push({ name, args }); waiting.push(d); return d.promise; };
  return {
    calls, waiting,
    session: () => ({ scenes: [{ id: 's1', current: true }, { id: 's2', current: false }] }),
    showScene: provider('showScene'),
    setLayer: provider('setLayer'),
    command: provider('command'),
  };
}

function makeEngine({ meld = makeMeld(), overlay = 0, log } = {}) {
  const logs = [];
  const events = [];
  const sent = [];
  const engine = new Engine({
    store: { config: { paused: false }, patchConfig: async () => {} },
    bus: { history: [], historySize: 100, overlayCount: () => overlay, send(event, data, kinds) { sent.push({ event, data, kinds }); } },
    session: { record() {} },
    meld,
    twitch: { sendChat: () => Promise.resolve() },
    log: log || ((...a) => logs.push(a.join(' '))),
  });
  engine.on('actionError', e => events.push(e));
  return { engine, logs, events, sent };
}

// Fallback del API ausente: sin `drainSentActions` el OLD resuelve de inmediato.
const drainSentOf = (engine) => (typeof engine.drainSentActions === 'function' ? engine.drainSentActions() : Promise.resolve());
const alertFor = (id, command = id) => ({ id, actions: [{ kind: 'command', command }], vars: {} });

test('la API drainSentActions existe y un drenaje vacío es sano', async () => {
  assert.equal(typeof Engine.prototype.drainSentActions, 'function', 'drainSentActions debe existir');
  const { engine } = makeEngine();
  await engine.drainSentActions();
});

test('un envío esperando ACK bloquea el drenaje de envíos pero no el de raíces', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  await engine.drainActions(); // vacío
  engine.send(alertFor('s1'));
  assert.equal(clock.withDelay(FALLBACK_MS).length, 1, 'fallback original de 120 s');
  let sent = false, roots = false;
  const dq = drainSentOf(engine).then(() => { sent = true; });
  const dOld = engine.drainActions().then(() => { roots = true; });
  await flush();
  assert.equal(roots, true, 'drainActions no captura el ACK pendiente');
  assert.equal(sent, false, 'drainSentActions espera el ACK');
  engine.alertShown('s1');
  await flush();
  assert.equal(sent, false, 'el ACK abre la ejecución pero el ciclo sigue vivo');
  meld.waiting.shift().resolve('ok');
  await dq;
  assert.equal(sent, true, 'drena cuando termina la vida causal');
  await dOld;
  assert.equal(clock.size, 0, 'sin asas físicas');
});

test('el fallback de 120 s queda referido mientras el drenaje lo espera', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  engine.send({ id: 's2', actions: [{ kind: 'command', command: 'x' }], vars: {} });
  const [fallback] = clock.withDelay(FALLBACK_MS);
  assert.equal(fallback.delay, FALLBACK_MS, 'vencimiento original exacto');
  assert.equal(fallback.hasRef, false, 'ordinario queda unref');
  const dq = drainSentOf(engine);
  await flush();
  assert.equal(fallback.hasRef, true, 'el drenaje refiere el asa de reserva');
  engine.alertShown('s2');
  assert.equal(clock.size, 0, 'el ACK destruye físicamente el asa antes de despachar');
  await flush();
  meld.waiting.shift().resolve('ok');
  await dq;
});

test('drena el fallo original y toda la descendencia de escena y capa', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine, logs, events } = makeEngine({ meld, overlay: 1 });
  const boom = new Error('');
  engine.send({ id: 's3', actions: [
    { kind: 'command', command: 'malo' },
    { kind: 'scene', scene: 's2', returnAfterSec: 5 },
    { kind: 'layer', scene: 's1', layer: 'l1', seconds: 4 },
  ], vars: {} });
  let drained;
  const dq = drainSentOf(engine).then(() => { drained = 'ok'; return 'ok'; }, e => { drained = e; return e; });
  await flush();
  assert.equal(drained, undefined, 'espera el ACK');
  engine.alertShown('s3');
  await flush();
  meld.waiting.shift().reject(boom);
  await flush();
  assert.equal(events[0].error, '', 'el evento conserva el mensaje vacío');
  assert.equal(meld.waiting.length, 1, 'showScene en vuelo');
  meld.waiting.shift().resolve('s2');
  await flush();
  const ret = clock.withDelay(5000);
  assert.equal(ret.length, 1, 'retorno de escena programado');
  meld.waiting.shift().resolve('l1');
  await flush();
  const hide = clock.withDelay(4000);
  assert.equal(hide.length, 1, 'ocultado de capa programado');
  assert.equal(drained, undefined, 'no agrega antes de los descendientes');
  assert.equal(ret[0].hasRef, true, 'el descendiente queda referido por el drenaje');
  clock.fire(ret[0]);
  await flush();
  meld.waiting.shift().resolve('s1');
  await flush();
  clock.fire(hide[0]);
  await flush();
  meld.waiting.shift().resolve();
  const agg = await dq;
  assert.ok(agg instanceof AggregateError, 'rechaza con AggregateError');
  assert.equal(agg.message, AGG, 'mensaje constante');
  assert.deepEqual(agg.errors, [boom], 'solo la causa original vacía');
  assert.ok(logs.some(l => l.startsWith('[acción]')), 'log ordinario conservado');
  assert.equal(clock.size, 0, 'todas las asas consumidas');
});

test('envíos duplicados conservan payload vigente y la generación vieja no consume el id', async t => {
  const clock = makeClock(t);
  const { engine } = makeEngine({ overlay: 1 });
  const dispatched = [];
  engine.runActions = async (actions) => { dispatched.push(actions[0]?.command); };
  engine.send(alertFor('d1', 'primero'));
  engine.send(alertFor('d1', 'segundo'));
  const handles = clock.withDelay(FALLBACK_MS);
  assert.equal(handles.length, 2, 'dos asas del mismo id antes del ACK');
  const oldCallbacks = handles.map(h => clock.active.get(h).fn);
  engine.alertShown('d1');
  assert.equal(clock.size, 0, 'el ACK limpia todas las asas físicas');
  await flush();
  assert.deepEqual(dispatched, ['segundo'], 'despacha el payload vigente');
  for (const fn of oldCallbacks) fn();
  await flush();
  assert.deepEqual(dispatched, ['segundo'], 'el callback viejo no reconsume la id');
  engine.send(alertFor('d1', 'tercero'));
  assert.equal(clock.withDelay(FALLBACK_MS).length, 1, 'la generación posterior arma su propio fallback');
  engine.alertShown('d1');
  await flush();
  assert.deepEqual(dispatched, ['segundo', 'tercero'], 'la generación nueva es independiente');
});

test('un envío posterior al corte queda fuera y el ciclo ya ACK-despachado sigue capturado', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  engine.send(alertFor('e1'));
  let drained = false;
  const d1 = drainSentOf(engine).then(() => { drained = true; });
  await flush();
  engine.send(alertFor('e2'));
  assert.equal(clock.withDelay(FALLBACK_MS).length, 2, 'dos ciclos independientes');
  engine.alertShown('e1');
  await flush();
  assert.equal(drained, false, 'el ciclo capturado aún no terminó');
  meld.waiting.shift().resolve('1');
  await d1;
  assert.equal(drained, true, 'solo esperó el ciclo capturado');
  assert.equal(clock.withDelay(FALLBACK_MS).length, 1, 'el ciclo posterior sigue esperando ACK');
  // El ciclo posterior e2 queda fuera de este corte; se liquida explícitamente antes del próximo.
  engine.alertShown('e2');
  await flush();
  meld.waiting.shift().resolve('2');
  await flush();
  assert.equal(clock.withDelay(FALLBACK_MS).length, 0, 'e2 se liquidó con su propio ACK');

  // El ciclo ACK-despachado con proveedor en vuelo y descendiente sigue capturado.
  engine.send({ id: 'f1', actions: [{ kind: 'command', command: 'x' }, { kind: 'scene', scene: 's2', returnAfterSec: 3 }], vars: {} });
  engine.alertShown('f1');
  await flush();
  assert.equal(meld.waiting.length, 1, 'proveedor inicial en vuelo');
  drained = false;
  const dq = drainSentOf(engine).then(() => { drained = true; });
  await flush();
  assert.equal(drained, false, 'el ciclo sigue vivo tras el ACK');
  meld.waiting.shift().resolve('x');
  await flush();
  meld.waiting.shift().resolve('s2');
  await flush();
  const ret = clock.withDelay(3000);
  assert.equal(ret.length, 1, 'hijo de escena de la misma raíz');
  assert.equal(drained, false, 'espera el descendiente');
  clock.fire(ret[0]);
  await flush();
  meld.waiting.shift().resolve('s1');
  await dq;
  assert.equal(drained, true);
  await drainSentOf(engine);
  assert.equal(clock.size, 0, 'sin asas');
});

test('held y preview no crean ticket; un test con acciones sí pertenece al envío', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine, sent } = makeEngine({ meld, overlay: 1 });
  engine.config.paused = true;
  engine.deliver({ id: 'h1', actions: [{ kind: 'command', command: 'pausado' }], vars: {} });
  assert.equal(engine.held.length, 1, 'queda retenido sin aceptar envío');
  let drained = false;
  await drainSentOf(engine).then(() => { drained = true; });
  assert.equal(drained, true, 'held no bloquea el drenaje');
  // #65: el envío agrupado de history deja sus propias asas (120 ms y techo de 500 ms); lo que
  // aquí se comprueba es que el held no crea un fallback de 120 s de ACK.
  assert.equal(clock.withDelay(FALLBACK_MS).length, 0, 'sin fallback para el held');

  engine.deliver({ id: 'p1', actions: [{ kind: 'command', command: 'preview' }], vars: {} }, { target: 'preview' });
  engine.deliver({ id: 'n1' }); // sin acciones: en pausa no crea ticket
  drained = false;
  await drainSentOf(engine).then(() => { drained = true; });
  assert.equal(drained, true, 'preview y sin acciones no bloquean');
  const heldAt = engine.held.length;

  engine.deliver({ id: 't1', test: true, actions: [{ kind: 'command', command: 'test' }], vars: {} });
  assert.equal(engine.held.length, heldAt, 'a.test no pasa por held ni altera el held');
  drained = false;
  const dq = drainSentOf(engine).then(() => { drained = true; });
  await flush();
  assert.equal(drained, false, 'un test con acciones es un envío aceptado');
  engine.alertShown('t1');
  await flush();
  meld.waiting.shift().resolve('ok');
  await dq;
  assert.equal(drained, true);
  assert.ok(sent.some(s => s.event === 'alert'), 'el bus recibió la alerta');
});

test('resume explícito acepta el envío al llamar send y discard no crea ticket', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  engine.config.paused = true;
  engine.deliver(alertFor('r1', 'retenido'));
  assert.equal(engine.held.length, 1);
  let drained = false;
  await drainSentOf(engine).then(() => { drained = true; });
  assert.equal(drained, true, 'antes de reanudar no hay ticket');
  await engine.resume({ discard: false });
  assert.equal(engine.held.length, 0, 'reanudar libera el held');
  assert.equal(clock.withDelay(FALLBACK_MS).length, 1, 'el held pasa a envío aceptado al llamar send');
  drained = false;
  const dq = drainSentOf(engine).then(() => { drained = true; });
  await flush();
  assert.equal(drained, false, 'ahora el envío retenido bloquea');
  engine.alertShown('r1');
  await flush();
  meld.waiting.shift().resolve('ok');
  await dq;
  assert.equal(drained, true);

  engine.config.paused = true;
  engine.deliver(alertFor('x1'));
  const res = await engine.resume({ discard: true });
  assert.equal(res.discarded, 1, 'discard explícito descarta el held');
  assert.equal(clock.withDelay(FALLBACK_MS).length, 0, 'discard no crea ticket ni fallback');
  drained = false;
  await drainSentOf(engine).then(() => { drained = true; });
  assert.equal(drained, true);
});

test('un fallo de ciclo se agrega una vez y no envenena ciclos posteriores', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  const boom = new Error('fallo-ciclo');
  engine.send(alertFor('g1', 'malo'));
  const da = drainSentOf(engine).then(() => 'ok', e => e);
  const db = drainSentOf(engine).then(() => 'ok', e => e);
  await flush();
  engine.alertShown('g1');
  await flush();
  meld.waiting.shift().reject(boom);
  await flush();
  const [ra, rb] = await Promise.all([da, db]);
  assert.ok(ra instanceof AggregateError && rb instanceof AggregateError, 'ambos drenajes ven el fallo');
  assert.deepEqual(ra.errors, [boom], 'una sola causa original');
  engine.send(alertFor('g2', 'sano'));
  const dc = drainSentOf(engine).then(() => 'ok', e => e);
  await flush();
  engine.alertShown('g2');
  await flush();
  meld.waiting.shift().resolve('ok');
  assert.equal(await dc, 'ok', 'el ciclo completado no envenena');
  assert.equal(clock.size, 0, 'sin asas');
});
