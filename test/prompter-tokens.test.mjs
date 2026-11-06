import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Prueba acotada: prompter.css consume solo tokens del sistema (issue #14).
//   1) el brillo interior vive en panel.css y el prompter no lo reimplementa: ya no tiene
//      botones de tier list (S7) que lo necesitaran, así que usa --shadow-edge/-strong;
//   2) no queda ningún hex de color: todo sale de los tokens del sistema.
const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const count = (haystack, needle) => haystack.split(needle).length - 1;

const HIGHLIGHT = 'inset 0 1px 0 rgba(255,255,255,.35)';

test('el prompter no reimplementa la receta del brillo interior', async () => {
  const css = stripComments(await read('../app/src/styles/prompter.css'));
  const panel = stripComments(await read('../app/src/styles/panel.css'));
  assert.ok(count(panel, HIGHLIGHT) >= 1, 'panel.css conserva la receta del brillo interior');
  assert.equal(count(css, HIGHLIGHT), 0, 'prompter.css no debe redefinir sombras del sistema: usa --shadow-edge/-strong');
});

test('no queda ningún hex de color en el prompter', async () => {
  const css = stripComments(await read('../app/src/styles/prompter.css'));
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  assert.deepEqual(hexes, [], `hexes fuera del sistema: ${[...new Set(hexes)].join(', ')}`);
});
