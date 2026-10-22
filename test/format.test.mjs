// #126 — helper de formato de fecha dd/MM/yyyy y hora HH:mm.
// No depende de la configuración regional del sistema.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fmtDate, fmtTime, fmtDateTime } from '../app/src/lib/format.mjs';

// Un Date de referencia construido en hora local: 20/10/2026 a las 15:22.
const at = new Date(2026, 9, 20, 15, 22, 9).getTime();

test('fmtDate: fecha en dd/MM/yyyy', () => {
  assert.equal(fmtDate(at), '20/10/2026');
});

test('fmtTime: hora en HH:mm de 24 horas', () => {
  assert.equal(fmtTime(at), '15:22');
});

test('días y meses de una cifra llevan cero delante', () => {
  const d = new Date(2026, 0, 3, 5, 7).getTime();
  assert.equal(fmtDate(d), '03/01/2026');
  assert.equal(fmtTime(d), '05:07');
});

test('medianoche es 00:00', () => {
  const d = new Date(2026, 9, 20, 0, 0).getTime();
  assert.equal(fmtTime(d), '00:00');
});

test('entrada inválida o vacía devuelve cadena vacía', () => {
  assert.equal(fmtDate(''), '');
  assert.equal(fmtTime(''), '');
  assert.equal(fmtDateTime(''), '');
  assert.equal(fmtDate('no-es-fecha'), '');
  assert.equal(fmtTime('no-es-fecha'), '');
  for (const value of [undefined, null, NaN, new Date(NaN)]) {
    assert.equal(fmtDate(value), '');
    assert.equal(fmtTime(value), '');
    assert.equal(fmtDateTime(value), '');
  }
});

test('fmtDateTime combina dd/MM/yyyy HH:mm', () => {
  assert.equal(fmtDateTime(at), '20/10/2026 15:22');
  assert.equal(fmtDateTime(new Date(at)), '20/10/2026 15:22');
  assert.equal(fmtDateTime(new Date(at).toISOString()), '20/10/2026 15:22');
  assert.notEqual(fmtDateTime(0), '', 'epoch 0 es válido');
});
