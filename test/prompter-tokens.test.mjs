import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Prueba acotada: prompter.css consolida su sombra y sus colores en tokens (issue #14),
// con la misma receta que panel.css (#12). Lee los dos CSS y verifica, sin navegador:
//   1) el brillo interior aparece una sola vez en crudo (la variable local) y las dos
//      reglas que lo usaban lo consumen vía var();
//   2) la variable local es byte-idéntica a la de panel.css;
//   3) no queda ningún hex de color fuera del sistema (.pr-tierbtn usa --color-fg-on-status).
const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const count = (haystack, needle) => haystack.split(needle).length - 1;

const HIGHLIGHT = 'inset 0 1px 0 rgba(255,255,255,.35)';
const RULES_CON_SOMBRA = ['.eg-progress--tier .eg-progress__bar{', '.pr-tierbtn{'];
const defHighlight = (css) => css.match(/--shadow-inset-highlight:(?!-)[^;]+/)?.[0] ?? '';

test('el brillo interior se define una vez y las reglas lo consumen vía var()', async () => {
  const css = stripComments(await read('../app/src/styles/prompter.css'));
  assert.equal(count(css, HIGHLIGHT), 1, 'el brillo interior debe definirse una sola vez');
  assert.ok(defHighlight(css).endsWith(`:${HIGHLIGHT}`), 'la definición del brillo interior cambia el valor original');
  for (const selector of RULES_CON_SOMBRA) {
    const regla = css.split(selector).at(1)?.split('}').at(0) ?? '';
    assert.ok(regla.length > 0, `no se encuentra la regla ${selector}`);
    assert.ok(/box-shadow:[^;}]*var\(--shadow-inset-highlight\)/.test(regla), `${selector} debe consumir la sombra vía var()`);
  }
});

test('la variable local es byte-idéntica a la de panel.css', async () => {
  const prompter = defHighlight(stripComments(await read('../app/src/styles/prompter.css')));
  const panel = defHighlight(stripComments(await read('../app/src/styles/panel.css')));
  assert.ok(panel.length > 0, 'panel.css debe declarar --shadow-inset-highlight');
  assert.equal(prompter, panel);
});

test('no queda ningún hex de color y .pr-tierbtn usa el color on-status', async () => {
  const css = stripComments(await read('../app/src/styles/prompter.css'));
  const hexes = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  assert.deepEqual(hexes, [], `hexes fuera del sistema: ${[...new Set(hexes)].join(', ')}`);
  const regla = css.split('.pr-tierbtn{').at(1)?.split('}').at(0) ?? '';
  assert.ok(regla.includes('color:var(--color-fg-on-status)'), '.pr-tierbtn debe usar --color-fg-on-status');
});
