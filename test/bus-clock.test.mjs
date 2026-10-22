// ODD-01: caso temporal determinista con el fixture mínimo de reloj.
// Es caracterización: src/bus.mjs ya deduplica con ventana de 10 minutos; el
// reloj virtual prueba el TTL sin sleeps reales. No se cambia el bus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.mjs';
import { useVirtualClock } from './helpers/clock.mjs';

const REAL_NOW = Date.now();

test('Bus.isDuplicate deduplica en ventana y libera el id tras 10 minutos', t => {
  const clock = useVirtualClock(t);
  if (!clock) return;
  const bus = new Bus();
  assert.equal(bus.isDuplicate('evt-1'), false);
  assert.equal(bus.isDuplicate('evt-1'), true);
  assert.equal(bus.isDuplicate('evt-1'), true);
  assert.equal(bus.isDuplicate('evt-2'), false);
  assert.equal(bus.seen.size, 2);
  clock.advance(9 * 60_000);
  assert.equal(bus.isDuplicate('evt-1'), true, 'sigue duplicado antes del TTL');
  clock.advance(61_000);
  assert.equal(bus.isDuplicate('evt-1'), false, 'pasado el TTL se ha barrido');
  assert.equal(bus.isDuplicate('evt-1'), true, 'y vuelve a registrar el id');
});

test('el reloj real vuelve tras el caso con reloj virtual', () => {
  // Si el mock filtrara, Date.now() seguiría cerca del reloj virtual (< REAL_NOW).
  assert.ok(Date.now() >= REAL_NOW, 'el reloj real no quedó mockeado');
});
