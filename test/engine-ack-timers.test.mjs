// ODD-08b.2b.2b.2a: propiedad física del temporizador de reserva (fallback) del ACK de overlay.
// SOLO pruebas. Los casos RED demuestran que hoy el fallback de 120 s no está poseído: un ACK
// aceptado borra `pendingActions` pero deja el asa física viva, y un segundo `send` con el mismo
// id acumula asas que nadie limpia. Las guardas ya verdes no se fuerzan a rojo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES de importar el motor y mantenidas hasta el final del proceso:
// ninguna prueba de este fichero abre red real ni hardware.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const FALLBACK_MS = 120_000;
const flush = () => new Promise(r => setImmediate(r));

function makeEngine({ overlay = 1, log } = {}) {
  const bus = {
    overlay,
    sent: [],
    history: [],
    historySize: 100,
    overlayCount() { return bus.overlay; },
    send(event, data, kinds) { bus.sent.push({ event, data, kinds }); },
  };
  const engine = new Engine({
    store: { config: { paused: false } },
    bus,
    session: { record() {} },
    meld: { session: () => ({ scenes: [] }) },
    twitch: {},
    log: log || (() => {}),
  });
  return { engine, bus };
}

// Reloj físico falso: registra cada asa viva y permite avanzar SOLO el vencimiento original.
function makeFakeTimers(t, { firstHandle = 1, objectHandles = false } = {}) {
  const active = new Map();
  let seq = firstHandle;
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const handle = objectHandles ? { id: seq++, unref() { return undefined; } } : seq++;
    active.set(handle, { fn, delay: Number(delay) });
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => { active.delete(handle); });
  const fallbackEntries = () => [...active.entries()].filter(([, e]) => e.delay === FALLBACK_MS);
  const api = {
    active,
    fallbackHandles: () => fallbackEntries().map(([h]) => h),
    fallbackCount: () => fallbackEntries().length,
    // Dispara el fallback más antiguo (primer asa creada), como el reloj real.
    fireEarliest: () => {
      const entry = fallbackEntries()[0];
      if (!entry) return false;
      active.delete(entry[0]);
      entry[1].fn();
      return true;
    },
    advance: () => {
      let fired = 0;
      while (api.fireEarliest()) fired++;
      return fired;
    },
  };
  return api;
}

const alertFor = (id, command = id) => ({ id, actions: [{ kind: 'command', command }], vars: { tag: command } });
function stubDispatch(engine) {
  const calls = [];
  engine.runActions = async (actions = [], vars = {}) => { calls.push({ command: actions[0]?.command, tag: vars.tag }); };
  return calls;
}

test('ACK aceptado limpia el fallback físico ANTES de despachar la acción', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  let fallbacksAtDispatch = null;
  let dispatches = 0;
  engine.runActions = async () => { fallbacksAtDispatch = clock.fallbackCount(); dispatches++; };
  engine.send(alertFor('a1'));
  assert.equal(clock.fallbackCount(), 1, 'el envío con overlay arma un fallback físico de 120 s');
  engine.alertShown('a1');
  assert.equal(fallbacksAtDispatch, 0, 'la propiedad se limpia antes de despachar');
  assert.equal(clock.fallbackCount(), 0, 'el ACK limpia el asa física');
  assert.equal(dispatches, 1, 'la acción aceptada se despacha exactamente una vez');
  assert.equal(clock.advance(), 0, 'no queda ningún fallback vivo');
  await flush();
  assert.equal(dispatches, 1, 'sin doble despacho');
  assert.equal(clock.active.size, 0, 'sin asas físicas pendientes');
});

test('un callback de fallback ya encolado tras el ACK no reinvoca la acción', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);
  engine.send(alertFor('a2'));
  const queued = clock.fallbackHandles().map(h => clock.active.get(h).fn);
  engine.alertShown('a2');
  for (const fn of queued) fn(); // simula el callback ya disparado pero aún no ejecutado
  await flush();
  assert.equal(calls.length, 1, 'el callback obsoleto no repite la acción');
  assert.equal(clock.fallbackCount(), 0, 'no se rearma propiedad');
});

test('sin overlay se ejecuta ya y NO se crea fallback', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 0 });
  const calls = stubDispatch(engine);
  engine.send(alertFor('a3'));
  assert.equal(calls.length, 1, 'sin overlay la acción sale de inmediato');
  assert.equal(clock.fallbackCount(), 0, 'no se crea ningún temporizador de reserva');
  assert.equal(clock.active.size, 0, 'el camino inmediato no deja asas');
});

test('sin ACK, el vencimiento original de 120 s no se adelanta ni se pierde', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);
  engine.send(alertFor('a4'));
  assert.equal(clock.fallbackCount(), 1, 'programado a 120 s');
  assert.equal(clock.active.get(clock.fallbackHandles()[0]).delay, FALLBACK_MS, 'retardo original intacto');
  await flush();
  assert.equal(calls.length, 0, 'no dispara antes de tiempo');
  assert.equal(clock.advance(), 1, 'dispara en el vencimiento original');
  await flush();
  assert.deepEqual(calls, [{ command: 'a4', tag: 'a4' }], 'ejecuta el payload original una vez');
  assert.equal(clock.active.size, 0, 'el disparo natural consume y limpia la propiedad');
  engine.alertShown('a4'); // ACK tardío/desconocido
  await flush();
  assert.equal(calls.length, 1, 'ACK posterior desconocido es no-op');
});

test('ACK de un id limpia solo su fallback y nunca cancela otro id aceptado', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);
  engine.send(alertFor('a5a'));
  engine.send(alertFor('a5b'));
  assert.equal(clock.fallbackCount(), 2, 'cada id tiene su asa');
  engine.alertShown('a5a');
  await flush();
  assert.deepEqual(calls, [{ command: 'a5a', tag: 'a5a' }], 'solo se despacha el id aceptado');
  assert.equal(clock.fallbackCount(), 1, 'el fallback del otro id sigue vivo');
  assert.equal(clock.advance(), 1, 'el otro id dispara en su vencimiento');
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, 'a5b', 'el otro id aceptado conserva su acción');
  assert.equal(clock.active.size, 0);
});

test('ids duplicados: ACK manual limpia todas las asas del mismo id', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);
  engine.send(alertFor('a6', 'primero'));
  engine.send(alertFor('a6', 'segundo'));
  assert.equal(clock.fallbackCount(), 2, 'se retienen todas las asas del mismo id');
  engine.alertShown('a6');
  assert.equal(clock.fallbackCount(), 0, 'el ACK manual limpia las dos asas');
  await flush();
  assert.deepEqual(calls, [{ command: 'segundo', tag: 'segundo' }], 'despacha el payload vigente del mapa');
});

test('ids duplicados: el fallback más antiguo ejecuta el payload vigente y limpia las obsoletas', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);
  engine.send(alertFor('a6b', 'primero'));
  engine.send(alertFor('a6b', 'segundo'));
  assert.equal(clock.fireEarliest(), true, 'dispara el vencimiento original, no un deadline nuevo');
  await flush();
  assert.deepEqual(calls, [{ command: 'segundo', tag: 'segundo' }], 'ejecuta el payload vigente como el baseline');
  assert.equal(clock.fallbackCount(), 0, 'limpia las asas obsoletas del mismo id');
  assert.equal(clock.active.size, 0);
});

test('un callback de fallback viejo no consume el payload nuevo del mismo id tras ACK', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);

  engine.send(alertFor('agen', 'viejo')); // generación 1
  const oldCallback = clock.fallbackHandles().map(h => clock.active.get(h).fn);
  engine.alertShown('agen'); // ACK invalida la generación 1
  assert.equal(clock.fallbackCount(), 0, 'el ACK invalida la generación vieja');
  await flush();
  assert.equal(calls.length, 1, 'la generación vieja se despachó una vez');

  engine.send(alertFor('agen', 'nuevo')); // generación 2 con la misma id
  assert.equal(clock.fallbackCount(), 1, 'la generación nueva arma su propio fallback');
  for (const fn of oldCallback) fn(); // callback viejo ya encolado antes del ACK
  await flush();
  assert.equal(calls.length, 1, 'el callback viejo NO despacha el payload nuevo');
  assert.equal(clock.fallbackCount(), 1, 'el fallback nuevo sigue esperando sus 120 s');

  assert.equal(clock.advance(), 1, 'el fallback natural de la generación nueva dispara');
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { command: 'nuevo', tag: 'nuevo' }, 'el payload nuevo se ejecuta una sola vez');
  assert.equal(clock.active.size, 0);
});

test('unref que devuelve undefined: se limpia el asa original, no el retorno de unref', async t => {
  const clock = makeFakeTimers(t, { objectHandles: true });
  const { engine } = makeEngine({ overlay: 1 });
  stubDispatch(engine);
  engine.send(alertFor('a7'));
  const original = clock.fallbackHandles()[0];
  assert.equal(clock.fallbackCount(), 1);
  engine.alertShown('a7');
  assert.equal(clock.active.has(original), false, 'clearTimeout recibe el asa original guardada antes de unref');
  assert.equal(clock.fallbackCount(), 0);
});

test('un asa numérica 0 no se descarta por ser falsy', async t => {
  const clock = makeFakeTimers(t, { firstHandle: 0 });
  const { engine } = makeEngine({ overlay: 1 });
  stubDispatch(engine);
  engine.send(alertFor('a7zero'));
  assert.equal(clock.fallbackHandles()[0], 0, 'el asa física es 0');
  engine.alertShown('a7zero');
  assert.equal(clock.fallbackCount(), 0, 'se limpia aunque el asa sea 0');
});

test('el despacho que falla limpia la propiedad antes de ejecutar y la reentrada no duplica', async t => {
  const clock = makeFakeTimers(t);
  const logs = [];
  const { engine } = makeEngine({ overlay: 1, log: (...a) => logs.push(a.join(' ')) });
  let calls = 0;
  engine.runActions = async () => {
    calls++;
    engine.alertShown('a7err'); // ACK reentrante durante la ejecución
    throw new Error('boom');
  };
  engine.send(alertFor('a7err'));
  engine.alertShown('a7err');
  assert.equal(clock.fallbackCount(), 0, 'la propiedad se limpia antes de ejecutar acciones');
  await flush();
  assert.equal(calls, 1, 'la reentrada no reejecuta la acción aceptada');
  assert.ok(logs.some(l => l.includes('boom')), 'el error de la acción se sigue registrando');
});

test('ACK duplicado o de id desconocido es no-op y no dispara acciones', async t => {
  const clock = makeFakeTimers(t);
  const { engine } = makeEngine({ overlay: 1 });
  const calls = stubDispatch(engine);
  engine.alertShown('fantasma');
  engine.alertShown('fantasma');
  await flush();
  assert.equal(calls.length, 0, 'nunca se ejecuta una acción de un id sin acción aceptada');
  assert.equal(clock.active.size, 0);
});
