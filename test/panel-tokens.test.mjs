import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Prueba acotada: panel.css consolida sombras y colores en tokens (issue #7).
// Lee app/src/styles/panel.css y verifica, sin navegador:
//   1) la sombra compuesta (brillo interior + glow rojo) aparece como máximo una vez en crudo,
//      y las 5 reglas la consumen vía var(), con valores resueltos byte-idénticos;
//   2) no queda ningún hex de color fuera del conjunto permitido declarado aquí;
//   3) .modal-backdrop no usa rgba(0,0,0,.6) literal, usa el scrim del sistema.
const cssPath = fileURLToPath(new URL('../app/src/styles/panel.css', import.meta.url));

// Hexes de color permitidos en panel.css. Vacío: todo color pasa por tokens o
// variables locales. (Los «#104» y «#127» del archivo son referencias a issues
// dentro de comentarios y se descartan al quitar los comentarios.)
const ALLOWED_HEX = new Set();

// Las dos recetas compuestas originales, byte a byte, tal y como estaban en las
// reglas antes de la consolidación. Si las definiciones de las variables las
// contienen literalmente, el valor resuelto de cada regla es idéntico.
const HIGHLIGHT = 'inset 0 1px 0 rgba(255,255,255,.35)';
const GLOW_10 = `${HIGHLIGHT},0 0 10px -2px var(--color-alpha-red-65)`;
const GLOW_12 = `${HIGHLIGHT},0 0 12px -2px var(--color-alpha-red-65)`;

const RULES_CON_SOMBRA = [
  '.switch input:checked+i',
  '.upbar b',
  '.check input:checked',
  '.gbar>i>b',
  '.tbtn.on',
];

const count = (haystack, needle) => haystack.split(needle).length - 1;

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

async function readPanelCss() {
  return readFile(cssPath, 'utf8');
}

test('la sombra compuesta aparece una sola vez en crudo y las reglas la consumen vía var()', async () => {
  const css = await readPanelCss();
  const sinComentarios = stripComments(css);

  // El brillo interior y cada glow existen exactamente una vez: en la
  // definición de la variable local, no repartidos por las reglas.
  assert.equal(count(sinComentarios, HIGHLIGHT), 1, 'el brillo interior debe definirse una sola vez');
  assert.equal(count(sinComentarios, '0 0 10px -2px var(--color-alpha-red-65)'), 1, 'el glow de 10px debe definirse una sola vez');
  assert.equal(count(sinComentarios, '0 0 12px -2px var(--color-alpha-red-65)'), 1, 'el glow de 12px debe definirse una sola vez');

  // Las definiciones componen byte-idénticamente las recetas originales.
  const defHighlight = sinComentarios.match(/--shadow-inset-highlight:(?!-)[^;]+/)?.[0] ?? '';
  const defGlow = sinComentarios.match(/--shadow-inset-highlight-glow:(?!-)[^;]+/)?.[0] ?? '';
  const defGlowWide = sinComentarios.match(/--shadow-inset-highlight-glow-wide:(?!-)[^;]+/)?.[0] ?? '';
  assert.ok(defHighlight.endsWith(`:${HIGHLIGHT}`), 'la definición del brillo interior cambia el valor original');
  assert.ok(defGlow.endsWith(`:var(--shadow-inset-highlight),0 0 10px -2px var(--color-alpha-red-65)`), 'la definición del glow de 10px cambia el valor original');
  assert.ok(defGlowWide.endsWith(`:var(--shadow-inset-highlight),0 0 12px -2px var(--color-alpha-red-65)`), 'la definición del glow de 12px cambia el valor original');

  // Cada regla afectada consume la receta vía var() y no repite sombra en crudo.
  for (const selector of RULES_CON_SOMBRA) {
    const regla = sinComentarios.split(selector).at(1)?.split('}').at(0) ?? '';
    assert.ok(regla.length > 0, `no se encuentra la regla ${selector}`);
    assert.ok(/box-shadow:[^;}]*var\(--shadow-inset-highlight/.test(regla), `${selector} debe consumir la sombra vía var()`);
    assert.ok(!regla.includes(HIGHLIGHT), `${selector} no debe repetir el brillo interior en crudo`);
  }
});

test('no queda ningún hex de color fuera del conjunto permitido', async () => {
  const css = await readPanelCss();
  const sinComentarios = stripComments(css);
  const hexes = [...sinComentarios.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  const fuera = hexes.filter(hex => !ALLOWED_HEX.has(hex));
  assert.deepEqual(fuera, [], `hexes fuera del sistema: ${[...new Set(fuera)].join(', ')}`);
});

test('.modal-backdrop usa el scrim del sistema y no rgba(0,0,0,.6) literal', async () => {
  const css = await readPanelCss();
  const sinComentarios = stripComments(css);

  const regla = sinComentarios.split('.modal-backdrop{').at(1)?.split('}').at(0) ?? '';
  assert.ok(regla.length > 0, 'no se encuentra la regla .modal-backdrop');
  assert.ok(!regla.includes('rgba(0,0,0,.6)'), '.modal-backdrop no debe usar rgba(0,0,0,.6) literal');
  assert.ok(regla.includes('background:var(--bg-scrim-backdrop)'), '.modal-backdrop debe usar la variable local del scrim');

  // La variable local deriva del token del sistema (scrim opaco + 60% de alfa),
  // sin inventar tokens nuevos en el sistema generado.
  const defScrim = sinComentarios.match(/--bg-scrim-backdrop:[^;]+/)?.[0] ?? '';
  assert.ok(defScrim.includes('var(--color-bg-scrim)'), '--bg-scrim-backdrop debe derivar de --color-bg-scrim');
});
