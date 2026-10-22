// #65 · Agrupar los envíos de historial, widgets y votos en ráfagas.
// Test primero: cuenta envíos del bus con reloj falso durante una ráfaga y comprueba
// que el estado final es idéntico al de enviar sin agrupar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Engine, burstCoalesce } = await import('../src/engine.mjs');

// Reloj falso: captura los setTimeout/clearTimeout para dispararlos de forma determinista.
function makeClock(t) {
  const active = new Map();
  let seq = 1;
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const handle = { id: seq++, delay: Number(delay) };
    active.set(handle, fn);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => { if (handle) active.delete(handle); });
  return {
    active,
    withDelay: delay => [...active.keys()].filter(h => h.delay === delay),
    fire(handle) { const fn = active.get(handle); active.delete(handle); fn(); },
    fireAll() { for (const h of [...active.keys()]) { const fn = active.get(h); if (active.has(h)) { active.delete(h); fn(); } } },
    get size() { return active.size; },
  };
}

function makeEngine({ historySize = 100 } = {}) {
  const sent = [];
  const counters = { totals: 0 };
  const session = {
    record() {},
    totals() { counters.totals++; return {}; },
    latest() { return []; },
    goalValue() { return 0; },
    credits() { return {}; },
    data: { events: [], id: 's1', title: 't', startedAt: 0 },
  };
  const bus = {
    history: [], historySize,
    overlayCount: () => 0,
    send(event, data, kinds) { sent.push({ event, data, kinds }); },
  };
  const engine = new Engine({
    store: { config: { paused: false } }, bus, session,
    meld: {}, twitch: {}, youtube: {}, log: () => {},
  });
  return { engine, sent, counters, bus };
}

const ALERTS = 100;
const alerts = () => Array.from({ length: ALERTS }, (_, i) => ({ id: `a${i + 1}`, test: false }));

// Umbral fijado en el test: 100 alertas en ráfaga producen pocos envíos de history/widgets.
const MAX_SENDS = 5;

test('100 alertas en ráfaga generan pocos envíos de history', async t => {
  const clock = makeClock(t);
  const { engine, sent } = makeEngine();
  for (const a of alerts()) engine.deliver(a);
  const immediate = sent.filter(s => s.event === 'history').length;
  clock.fireAll();
  const total = sent.filter(s => s.event === 'history').length;
  assert.ok(total <= MAX_SENDS, `history se envía ${total} veces, umbral ${MAX_SENDS}`);
  assert.ok(immediate < total, 'el envío se agrupa, no sale síncrono en cada alerta');
  assert.equal(sent.filter(s => s.event === 'alert').length, ALERTS, 'cada alerta sigue saliendo');
});

test('el estado final de history es el mismo que sin agrupar', async t => {
  const clock = makeClock(t);
  const { engine, sent, bus } = makeEngine();
  for (const a of alerts()) engine.deliver(a);
  clock.fireAll();
  const payload = sent.filter(s => s.event === 'history').at(-1).data;
  assert.equal(bus.history.length, ALERTS);
  // Sin agrupar, el envío toma bus.history en el mismo punto: los 50 más recientes, el último primero.
  assert.deepEqual(payload.map(x => x.id), bus.history.slice(0, 50).map(x => x.id));
});

test('pushWidgets agrupa y evita recalcular totales en cada alerta', async t => {
  const clock = makeClock(t);
  const { engine, sent, counters } = makeEngine();
  for (let i = 0; i < ALERTS; i++) engine.pushWidgets();
  clock.fireAll();
  const widgets = sent.filter(s => s.event === 'widgets').length;
  assert.ok(widgets <= MAX_SENDS, `widgets se envía ${widgets} veces, umbral ${MAX_SENDS}`);
  assert.ok(counters.totals <= MAX_SENDS, `totals se recalcula ${counters.totals} veces, umbral ${MAX_SENDS}`);
});

test('flushScheduledSends vacía lo pendiente de forma síncrona', async t => {
  const clock = makeClock(t);
  const { engine, sent } = makeEngine();
  engine.pushWidgets();
  engine.pushHistory();
  assert.equal(sent.filter(s => s.event === 'widgets').length, 0);
  engine.flushScheduledSends();
  assert.equal(sent.filter(s => s.event === 'widgets').length, 1);
  assert.equal(sent.filter(s => s.event === 'history').length, 1);
  assert.equal(clock.size, 0, 'no quedan asas pendientes');
});

test('2000 votos (cambios de interactive) no generan 2000 snapshots', async t => {
  const clock = makeClock(t);
  let snapshots = 0;
  const push = burstCoalesce(120, () => { snapshots++; });
  for (let i = 0; i < 2000; i++) push();
  clock.fireAll();
  assert.ok(snapshots <= MAX_SENDS, `snapshot se calcula ${snapshots} veces, umbral ${MAX_SENDS}`);
});

// Reloj con tiempo virtual: setTimeout registra plazos y advance() hace pasar el tiempo.
function makeClockWithNow(t) {
  const timers = new Map();
  let seq = 1, now = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, delay = 0) => {
    const id = seq++;
    timers.set(id, { fn, at: now + Number(delay) });
    return { id, delay: Number(delay) };
  });
  t.mock.method(globalThis, 'clearTimeout', h => { if (h) timers.delete(h.id); });
  return {
    get now() { return now; },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= now).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, v] = due[0];
        timers.delete(id);
        v.fn();
      }
    },
    get size() { return timers.size; },
  };
}

// Inanición: llamadas cada 100 ms durante 3 s con debounce de 120 ms y espera máxima de 500 ms.
// Sin máximo, fn no llegaría a ejecutarse mientras dure el flujo (el panel quedaria congelado).
test('burstCoalesce con maxWaitMs no se inanice: llama ~cada 500 ms y entrega el último estado', async t => {
  const clock = makeClockWithNow(t);
  const entregas = [];
  let ultimo = 0;
  const push = burstCoalesce(120, () => entregas.push(ultimo), 500);
  for (let i = 1; i <= 30; i++) { ultimo = i; push(); clock.advance(100); }
  clock.advance(200);
  assert.ok(entregas.length >= 6, `esperaba al menos 6 envíos en 3 s, hubo ${entregas.length}`);
  assert.equal(entregas.at(-1), 30, 'el último estado llego al panel');
  assert.equal(clock.size, 0, 'sin asas pendientes');
});

test('sin maxWaitMs el comportamiento de debounce puro se mantiene (agrupa todo el silencio corto)', async t => {
  const clock = makeClockWithNow(t);
  const entregas = [];
  let ultimo = 0;
  const push = burstCoalesce(120, () => entregas.push(ultimo), 0);
  for (let i = 1; i <= 30; i++) { ultimo = i; push(); clock.advance(100); }
  assert.equal(entregas.length, 0, 'sin espera máxima no hay envío mientras el flujo no para');
  clock.advance(200);
  assert.deepEqual(entregas, [30], 'al cesar el flujo sale el último valor');
});

test('flush sin envíos pendientes no llama a fn', async t => {
  const clock = makeClockWithNow(t);
  const seen = [];
  const push = burstCoalesce(120, () => seen.push('enviado'));
  push.flush();
  push.flush();
  assert.deepEqual(seen, [], 'flush sin pendiente no envía');
  assert.equal(clock.size, 0, 'sin asas pendientes');
});

test('burstCoalesce: flush vacía y la última llamada manda', async t => {
  const clock = makeClock(t);
  const seen = [];
  const push = burstCoalesce(120, () => seen.push('enviado'));
  push(); push();
  push.flush();
  assert.deepEqual(seen, ['enviado']);
  push();
  clock.fireAll();
  assert.deepEqual(seen, ['enviado', 'enviado']);
  assert.equal(clock.size, 0, 'sin asas pendientes tras el disparo');
});
