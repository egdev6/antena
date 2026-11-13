import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const notes = readFileSync(new URL('../docs/releases/v0.14.1.md', import.meta.url), 'utf8');

test('S3: no se garantiza el arranque de la app instalada sin probarla', () => {
  assert.doesNotMatch(notes, /la app de escritorio (?:vuelve a arrancar|arranca de nuevo) en Windows/i);
  assert.match(notes, /aún no abriendo la app instalada/i);
});

test('S3: un timeout solo implica intentar arrancar, no garantiza que arranque', () => {
  assert.doesNotMatch(notes, /si nadie contesta[^\n]*antena arranca su servidor/i);
});

test('S3: la explicación de la actualización manual se limita a quien no puede abrir el panel', () => {
  const important = notes.split('### Importante')[1]?.split('### ')[0] ?? '';
  const advice = important.split('\n').find(line => line.includes('0.14.0') && /actualizaciones/i) ?? '';
  assert.match(advice, /si[^:\n]{0,120}(?:no puedes abrir el panel|el panel no se abre)/i);
});
