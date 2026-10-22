// Residual #21 (ODD-08, gate G1): «si la limpieza espera a un temporizador que ya no se va a
// resolver, el drenaje del Engine podría no terminar y solo lo cortaría el deadline (salida 1)».
// SOLO pruebas. Este fichero caracteriza el residual y demuestra su límite de alcanzabilidad:
//
// - El ticket de una raíz (`#hold`) solo se libera al vencer el temporizador o al llegar el ACK.
//   `#schedule` (retorno de escena, ocultado de capa) no tiene cancelación: su liberación vive
//   únicamente dentro del callback.
// - Por tanto, cancelar ese asa desde fuera deja el ticket retenido y el drenaje sin resolver
//   para siempre: ningún otro camino público lo libera. Eso se caracteriza en la prueba 1, con un
//   ciclo de vida que termina (nada queda esperando) y sin dormir como oráculo.
// - Ningún caller de producción cancela asas de raíz: los únicos `clearTimeout` del motor los
//   ejecuta el propio Engine sobre el fallback de 120 s (`src/engine.mjs:103`, `src/engine.mjs:163`),
//   y ese camino sí libera el ticket (ya cubierto en `test/engine-shutdown-ownership.test.mjs:253`
//   y `:285`, no se duplica aquí). Por eso el bloqueo queda caracterizado como no alcanzable desde
//   la interfaz pública: la prueba 2 demuestra que, sin esa cancelación externa, el mismo
//   temporizador resuelve el ticket y el drenaje termina.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso:
// ninguna prueba abre red real ni hardware.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const FALLBACK_MS = 120_000;
const RETURN_SEC = 5;
const SETTLE_TICKS = 64;

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// Reloj físico falso: registra cada asa viva, su estado ref/unref y cada cancelación.
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

// Meld que resuelve de inmediato: el temporizador de retorno se arma de forma determinista.
function makeMeld() {
  const calls = [];
  return {
    calls,
    session: () => ({ scenes: [{ id: 's1', current: true }, { id: 's2', current: false }] }),
    showScene: async (id) => { calls.push({ name: 'showScene', id }); return id; },
    setLayer: async (scene, layer, on) => { calls.push({ name: 'setLayer', scene, layer, on }); return true; },
    command: async (command) => { calls.push({ name: 'command', command }); return command; },
  };
}

function makeEngine({ meld = makeMeld(), overlay = 1 } = {}) {
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

// Estado observable de una promesa sin dormir ni esperar sin límite: compite contra un centinela
// de `setImmediate` un número ACOTADO de veces. Si el límite se agota, el test FALLA con el estado
// observado en vez de quedarse colgado esperando una promesa que quizá nunca resuelve.
async function observe(promise) {
  const PENDING = Symbol('pending');
  const tracker = promise.then(
    value => ({ state: 'drained', value }),
    error => ({ state: 'rejected', error }),
  );
  for (let i = 0; i < SETTLE_TICKS; i++) {
    const outcome = await Promise.race([tracker, new Promise(r => setImmediate(() => r(PENDING)))]);
    if (outcome !== PENDING) return outcome;
  }
  return { state: 'pending' };
}

// Un envío con acciones que programa un vencimiento propio de la raíz (`#schedule`).
const sceneAlert = id => ({ id, actions: [{ kind: 'scene', scene: 's2', returnAfterSec: RETURN_SEC }], vars: {} });

// Deja el envío ACEPTADO y su temporizador de retorno armado, sin drenar todavía.
async function armedReturn(engine, clock, id) {
  engine.send(sceneAlert(id));
  assert.equal(clock.withDelay(FALLBACK_MS).length, 1, 'el envío con overlay arma su fallback de 120 s');
  engine.alertShown(id); // caller real: POST /api/overlay/shown
  assert.equal(clock.withDelay(FALLBACK_MS).length, 0, 'el ACK destruye el fallback antes de despachar');
  await flush();
  const handles = clock.withDelay(RETURN_SEC * 1000);
  assert.equal(handles.length, 1, 'el retorno de escena queda programado');
  assert.equal(engine.sceneTimers.length, 1, 'la raíz conserva el asa del vencimiento');
  assert.equal(handles[0], engine.sceneTimers[0], 'el asa programada es la que expone la raíz');
  return handles[0];
}

test('#21: cancelar el temporizador de la raíz deja el ticket retenido y el drenaje sin resolver', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  const handle = await armedReturn(engine, clock, 'hang1');
  assert.deepEqual(meld.calls, [{ name: 'showScene', id: 's2' }], 'la escena ya se mostró; solo falta el retorno');

  const drain = engine.drainActions();
  const sentDrain = engine.drainSentActions();
  assert.equal((await observe(drain)).state, 'pending', 'el drenaje espera el vencimiento pendiente');
  assert.equal(handle.hasRef, true, 'el drenaje refiere el asa mientras la espera');

  // Cancelación desde FUERA del Engine: ningún caller de producción lo hace (ver prueba 2).
  const cancelledBefore = clock.cleared.filter(h => h === handle).length;
  clearTimeout(handle);
  assert.equal(cancelledBefore, 0, 'el Engine nunca canceló el asa del vencimiento');
  assert.equal(clock.cleared.filter(h => h === handle).length, 1, 'el reloj físico cancela el asa de la raíz');
  assert.equal(clock.size, 0, 'ya no queda ningún temporizador armado que pueda resolver la raíz');
  assert.equal(handle.hasRef, true, 'el asa cancelada sigue contada como pendiente por la raíz');

  // Nada puede ya liberar el ticket: la promesa de la raíz no se resuelve ni se rechaza.
  assert.equal((await observe(drain)).state, 'pending', 'el ticket sigue retenido tras la cancelación externa');
  assert.equal((await observe(sentDrain)).state, 'pending', 'el drenaje de envíos ve el mismo ticket colgado');
  assert.equal((await observe(engine.drainActions())).state, 'pending', 'una captura posterior tampoco termina');
  assert.deepEqual(clock.referred(), [], 'ningún asa queda referida');
  assert.equal(clock.cleared.filter(h => h === handle).length, 1, 'no se vuelve a cancelar nada');

  // El único caller real de limpieza (ACK) ya no tiene nada que liberar: no rescata el ticket.
  assert.equal(engine.hasPendingAck('hang1'), false, 'no queda ACK pendiente que pueda liberar la raíz');
  assert.equal(engine.fallbackTimers.size, 0, 'no queda fallback propietario del id');
  engine.alertShown('hang1');
  await flush();
  assert.equal((await observe(drain)).state, 'pending', 'el ACK tardío no rescata un ticket huérfano');
  assert.equal(engine.sceneTimers.length, 1, 'la lista pública conserva el asa cancelada (fuga conocida)');
  assert.deepEqual(meld.calls, [{ name: 'showScene', id: 's2' }], 'no se ejecuta trabajo no confirmado');

  // Caracterización del corte: sin temporizadores vivos, el proceso solo saldría por un deadline
  // externo (server `shutdownTimeoutMs`), que es lo que el residual #21 describe.
  assert.equal(clock.size, 0, 'nada del Engine puede ya cortar la espera por sí mismo');
});

test('#21: sin esa cancelación externa, el mismo temporizador resuelve el ticket y el drenaje termina', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 1 });
  const handle = await armedReturn(engine, clock, 'ok1');

  const drain = engine.drainActions();
  const sentDrain = engine.drainSentActions();
  assert.equal((await observe(drain)).state, 'pending', 'espera el vencimiento antes de drenar');

  clock.fire(handle); // vencimiento original: único desenlace sin cancelación
  assert.equal((await observe(drain)).state, 'drained', 'el vencimiento libera el ticket y el drenaje termina');
  assert.equal((await observe(sentDrain)).state, 'drained', 'el drenaje de envíos también termina');
  assert.equal(clock.size, 0, 'sin asas vivas');
  assert.equal(clock.cleared.includes(handle), false, 'nadie canceló el asa del vencimiento: el camino es el vencimiento');
  assert.deepEqual(meld.calls, [{ name: 'showScene', id: 's2' }, { name: 'showScene', id: 's1' }], 'el retorno vuelve a la escena previa');
  assert.equal(engine.sceneTimers.length, 1, 'la lista pública conserva el asa consumida (fuga conocida)');
  assert.equal((await observe(engine.drainActions())).state, 'drained', 'un drenaje posterior está vacío');
});

test('#21: una raíz sin ningún temporizador ni ACK pendiente drena sin esperar un reloj', async t => {
  const clock = makeClock(t);
  const meld = makeMeld();
  const { engine } = makeEngine({ meld, overlay: 0 });
  engine.send({ id: 'plain1', actions: [{ kind: 'command', command: 'x' }], vars: {} });
  assert.equal(clock.size, 0, 'sin overlay ni retraso no se arma ningún asa');
  assert.equal((await observe(engine.drainActions())).state, 'drained', 'nada que esperar: el drenaje termina');
  assert.equal((await observe(engine.drainSentActions())).state, 'drained', 'tampoco retiene el envío aceptado');
  assert.deepEqual(meld.calls, [{ name: 'command', command: 'x' }], 'la acción se ejecutó una sola vez');
});
