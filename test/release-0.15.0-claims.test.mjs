import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const notes = readFileSync(new URL('../docs/releases/v0.15.0.md', import.meta.url), 'utf8');
const recording = notes.split('\n').find(line => line.includes('Grabar al empezar el directo')) ?? '';
const viewers = notes.split('\n').find(line => line.includes('sin dato')) ?? '';

test('S1: el control y la grabación advierten de sus efectos reales', () => {
  assert.match(notes, /iniciar y detener el directo desde el dock controla la emisión pública real de Meld/i);
  assert.match(notes, /la grabación también es real/i);
});

test('S1: no se atribuyen pruebas reales a lo probado con datos sintéticos', () => {
  assert.match(notes, /el control del directo, la grabación y los contadores de espectadores se han probado con tests automáticos y datos sintéticos/i);
  assert.match(notes, /aún no con Meld y plataformas reales en la app instalada de Windows/i);
});

test('S1: la grabación opcional no interfiere con una grabación previa ni con el directo', () => {
  assert.match(recording, /viene desactivada de serie/i);
  assert.match(recording, /al iniciar el directo desde antena y cuando Meld confirme que emite/i);
  assert.match(recording, /si ya hay una grabación en marcha, antena no la toca/i);
  assert.match(recording, /solo intenta detener la grabación que inició antena/i);
  assert.match(recording, /si falla la grabación, te avisa sin detener la emisión/i);
});

test('S1: se explica la limitación del estado booleano de grabación', () => {
  assert.match(notes, /Meld solo informa de si la grabación está activada o desactivada/i);
  assert.match(notes, /si alguien empieza una grabación en Meld en el mismo instante que antena, antena no puede distinguirlas/i);
});

test('S1: la ausencia de espectadores no se confunde con cero', () => {
  assert.match(viewers, /espectadores por plataforma/i);
  assert.match(viewers, /«sin dato», nunca 0/i);
});

test('S1: el arreglo anterior de Windows sigue sin confirmarse en la app instalada', () => {
  assert.match(notes, /la corrección del arranque de la 0\.14\.1 \(#144\) sigue sin confirmarse en la app instalada de Windows/i);
});

test('S1: se avisa de la falta de firma y se enlazan créditos y cambios técnicos', () => {
  assert.match(notes, /no está firmado/);
  assert.match(notes, /### Agradecimientos/);
  assert.match(notes, /https:\/\/github\.com\/egdev6\/antena\/compare\/v0\.14\.1\.\.\./);
});
