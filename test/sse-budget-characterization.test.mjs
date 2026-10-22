// ODD-13 · SSE: límite de bytes por cliente, cliente lento y reconexión con snapshot.
// Caracterización con fake sink de bytes pequeño y configurable (no cargas grandes en memoria).
// RED reproducido antes del fix, por comportamiento y solo con la API pública de main
// ({ Bus } + fake sink): en main, ráfagas repetidas a un cliente que no leía acumulaban bytes
// sin límite, sin evento gap y sin cierre. Tras el fix estos tests son la regresión GREEN.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Bus } from '../src/bus.mjs';

// Fake sink configurable:
// - capacity: umbral a partir del cual write() devuelve false (contrapresión).
// - autoDrain: simula un lector rápido — el kernel acepta los bytes en el mismo write()
//   (como try_write real), así que writableLength no crece nunca.
function fakeSink({ capacity = 256, autoDrain = false } = {}) {
  let buffered = 0;
  const written = [];
  let drainCb = null;
  return {
    buffered: () => buffered,
    written,
    closed: false,
    get writableLength() { return buffered; },
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      if (this.closed) return false;
      written.push(chunk);
      if (autoDrain) return true; // el lector rápido consume al instante
      buffered += Buffer.byteLength(chunk);
      return buffered <= capacity;
    },
    on(ev, cb) { if (ev === 'drain') drainCb = cb; },
    once() { /* nunca close externo */ },
    end() { this.closed = true; },
    drain() { buffered = 0; drainCb?.(); },
  };
}

const kinds = chunks => chunks.filter(c => c.startsWith('event: '))
  .map(c => c.slice(7, c.indexOf('\n')));
// La decisión de corte es diferida (gracia de 100 ms): hay que esperar al menos la gracia.
const nextTick = () => new Promise(resolve => setTimeout(resolve, 150));

test('RED caracterizado en main: cliente que no lee acumulaba bytes sin límite', async () => {
  // En main este test falla por comportamiento: sin gap, sin cierre y backlog sin techo
  // (crece ráfaga tras ráfaga). Tras el fix, el primer backlog persistente corta al cliente.
  const bus = new Bus({ historySize: 10, byteBudget: 1024 }); // byteBudget se ignora en main
  const slow = fakeSink({ capacity: 256 });
  bus.addClient(slow, 'overlay');
  for (let i = 0; i < 400; i++) bus.send('alert', { id: i, text: `x${i}` }); // ~60 B/evento
  await nextTick();
  assert.ok(kinds(slow.written).includes('gap'), 'gap visible al persistir el backlog');
  assert.ok(slow.closed, 'el cliente lento se cierra para reconectar con snapshot');
  const afterGap = slow.written.length;
  for (let i = 0; i < 100; i++) bus.send('alert', { id: i, text: `y${i}` });
  await nextTick();
  assert.equal(slow.written.length, afterGap, 'nada más se entrega al cliente cortado');
});

test('un cliente que no lee no bloquea a los demás y su gap cuenta los efímeros exactos', async () => {
  const bus = new Bus({ historySize: 10, byteBudget: 256 });
  const slow = fakeSink({ capacity: 256 });
  const healthy = fakeSink({ autoDrain: true }); // lector rápido: nunca satura
  bus.addClient(slow, 'overlay');
  bus.addClient(healthy, 'overlay');
  const TOTAL = 20;
  let clean = null; // chats entregados antes de que el backlog cruzara el presupuesto
  for (let i = 0; i < TOTAL; i++) {
    bus.send('chat', { id: i, text: `x${i}` });
    if (clean === null && slow.buffered() > 256) clean = i;
  }
  await nextTick(); // el corte se decide tras la ráfaga, nunca dentro del tick
  const gap = slow.written.find(c => c.startsWith('event: gap'));
  assert.ok(gap, 'gap visible');
  const payload = JSON.parse(gap.slice(gap.indexOf('data: ') + 6));
  assert.equal(payload.reason, 'slow-client');
  assert.equal(payload.droppedEphemeral, TOTAL - clean, 'recuento exacto de efímeros en riesgo/perdidos');
  assert.equal(clean + payload.droppedEphemeral, TOTAL);
  assert.ok(clean > 0 && payload.droppedEphemeral > 0, 'el presupuesto corta a mitad de ráfaga');
  assert.equal(kinds(healthy.written).filter(k => k === 'chat').length, TOTAL);
  assert.ok(!healthy.closed, 'el cliente sano no se ve afectado');
});

test('un cliente que SÍ lee nunca se corta, aunque la ráfaga supere el presupuesto en un tick', async () => {
  const bus = new Bus({ historySize: 10, byteBudget: 64 * 1024 });
  const reader = fakeSink({ autoDrain: true }); // el backlog no persiste entre ticks
  bus.addClient(reader, 'panel');
  const TOTAL = 200, PAYLOAD = 'y'.repeat(8 * 1024); // 1.6 MB en ráfaga >> 64 KB
  for (let i = 0; i < TOTAL; i++) bus.send('chat', { id: i, text: PAYLOAD });
  await nextTick();
  assert.equal(kinds(reader.written).length, TOTAL, 'recibe todos los eventos');
  assert.ok(!reader.closed, 'el lector rápido no se corta ni entra en bucle de reconexión');
});

test('backlog transitorio seguido de drain: sin corte y con el último snapshot retenido', async () => {
  const bus = new Bus({ historySize: 10, byteBudget: 128 });
  const sink = fakeSink({ capacity: 64 });
  bus.addClient(sink, 'panel');
  bus.send('status', { n: 1 });            // backlog sobre presupuesto -> throttle
  bus.send('status', { n: 2 });            // coalesced (retiene el último)
  sink.drain();                            // el lector consume antes del tick de verificación
  bus.send('status', { n: 3 });            // pasa, pero deja contrapresión -> coalesced
  await nextTick();
  assert.ok(!sink.closed, 'sin corte: el backlog no persistió');
  sink.drain();                            // flush del último valor retenido
  const statuses = sink.written.filter(c => c.startsWith('event: status'));
  assert.ok(statuses.length >= 2);
  assert.match(statuses[statuses.length - 1], /"n":3/, 'el drain envía el último valor retenido');
});

test('snapshot sustituible: se retiene el ÚLTIMO valor solo con throttle real (write false)', () => {
  const bus = new Bus({ historySize: 10, byteBudget: 1 << 20 });
  const slow = fakeSink({ capacity: 8 }); // la write() devuelve false: drain pendiente
  bus.addClient(slow, 'panel');
  bus.send('status', { n: 1 });            // entra con contrapresión real -> throttle
  bus.send('status', { n: 2 });            // coalesced
  bus.send('status', { n: 3 });            // coalesced: se retiene el último
  const statuses = slow.written.filter(c => c.startsWith('event: status'));
  assert.equal(statuses.length, 1, 'con throttle activo solo pasa el primer snapshot');
  slow.drain();                            // el cliente consume su cola
  const after = slow.written.filter(c => c.startsWith('event: status'));
  assert.equal(after.length, 2);
  assert.match(after[1], /"n":3/, 'el drain envía el último valor retenido, no uno viejo');
});

test('R3/R4: backlog bajo highWaterMark (write true, sin drain) NO varaa el snapshot', () => {
  const bus = new Bus({ historySize: 10, byteBudget: 1 << 20 });
  const sink = fakeSink({ capacity: 1 << 20 }); // writableLength > 0 pero write() true
  bus.addClient(sink, 'panel');
  bus.send('status', { n: 1 });            // deja backlog residual bajo highWaterMark
  bus.send('status', { n: 2 });            // write() devolvió true: pasa inmediatamente
  bus.send('pause', { paused: false, held: 0 });
  const statuses = sink.written.filter(c => c.startsWith('event: status'));
  assert.equal(statuses.length, 2, 'el snapshot se escribe inmediatamente, sin esperar drain');
  const pauses = sink.written.filter(c => c.startsWith('event: pause'));
  assert.equal(pauses.length, 1, 'cada snapshot sustituible llega sin drain pendiente');
  assert.ok(!sink.closed && [...bus.clients].length === 1);
});

test('los efímeros no se coalescen: se entregan o se cuentan como perdidos', () => {
  const bus = new Bus({ historySize: 10, byteBudget: 1 << 20 });
  const slow = fakeSink({ capacity: 32 });
  bus.addClient(slow, 'panel');
  bus.send('status', { n: 1 });            // contrapresión
  bus.send('chat', { id: 1 });             // efímero: pasa igualmente
  bus.send('chat', { id: 2 });             // efímero: pasa igualmente
  assert.equal(kinds(slow.written).filter(k => k === 'chat').length, 2);
});

test('clasificación explícita: todo evento emitido por el servidor tiene clase', async () => {
  const { REPLACEABLE_EVENTS, EPHEMERAL_EVENTS, eventClass } = await import('../src/bus.mjs');
  for (const ev of ['status', 'persistence', 'interactive', 'widgets', 'pause', 'meld',
    'timeline', 'config', 'prompter', 'timers', 'history']) {
    assert.equal(eventClass(ev), 'replaceable', `${ev} es snapshot sustituible`);
  }
  for (const ev of ['alert', 'chat', 'chatDelete', 'chatClear', 'chatResult',
    'control', 'credits', 'say', 'gap']) {
    assert.equal(eventClass(ev), 'ephemeral', `${ev} es efímero`);
  }
  const declared = new Set([...REPLACEABLE_EVENTS, ...EPHEMERAL_EVENTS]);
  assert.equal(declared.size, REPLACEABLE_EVENTS.size + EPHEMERAL_EVENTS.size, 'sin solapes');
  // Todo bus.send / bus.alert del servidor usa un tipo declarado (fuente: src/*.mjs).
  const emitted = new Set();
  for (const f of ['src/server.mjs', 'src/engine.mjs', 'src/timers.mjs']) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/bus\.send\('([a-zA-Z]+)'/g)) emitted.add(m[1]);
    if (/bus\.alert\(/.test(src)) emitted.add('alert');
  }
  emitted.add('gap');
  for (const ev of emitted) {
    assert.ok(declared.has(ev), `${ev} (emitido en src) está clasificado`);
  }
});

test('tipo desconocido no rompe al productor: se trata como efímero con aviso', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const bus = new Bus();
    bus.addClient(fakeSink({ autoDrain: true }), 'panel');
    bus.send('tipoInventado', { id: 1 }); // no lanza: los emisores no tienen catch
    bus.send('tipoInventado', { id: 2 }); // aviso deduplicado
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.filter(w => w.includes('tipoInventado')).length, 1, 'aviso único');
});

test('res destruido o con error se elimina del bus sin lanzar', () => {
  const bus = new Bus();
  const dead = fakeSink();
  dead.writableEnded = true;
  bus.addClient(dead, 'panel');
  bus.send('chat', { id: 1 }); // no lanza; el cliente muerto sale del conjunto
  assert.equal([...bus.clients].length, 0);
});
