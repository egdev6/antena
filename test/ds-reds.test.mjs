import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');
const estilos = ['panel', 'prompter', 'dock', 'tour', 'acerca'].map(n => `app/src/styles/${n}.css`);
const sinComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
// Sin excepciones de marcas de plataformas: no hay logotipos que las necesiten.
const excepciones = new Set();

async function fuentes(dir) {
  const entradas = await readdir(new URL(`${dir}/`, root), { withFileTypes: true });
  return (await Promise.all(entradas.map(e => e.isDirectory() ? fuentes(`${dir}/${e.name}`) : /\.tsx?$/.test(e.name) ? [`${dir}/${e.name}`] : []))).flat();
}

// HSL distingue rojos y rosas de blancos, grises y tonos oscuros casi negros.
function esRojo(r, g, b) {
  [r, g, b] = [r, g, b].map(x => x / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const l = (max + min) / 2;
  if (!delta || l <= .1 || l >= .9) return false;
  const s = delta / (1 - Math.abs(2 * l - 1));
  const h = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return s > .35 && (h >= 330 || h <= 15);
}
function rojos(texto) {
  const encontrados = [];
  for (const m of texto.matchAll(/#[\da-fA-F]{3,8}\b|rgba?\(\s*\d+(?:\s*,\s*|\s+)\d+(?:\s*,\s*|\s+)\d+[^)]*\)/g)) {
    const valor = m[0];
    let rgb;
    if (valor[0] === '#') {
      let hex = valor.slice(1);
      if (![3, 4, 6, 8].includes(hex.length)) continue;
      if (hex.length <= 4) hex = [...hex].map(x => x + x).join('');
      rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    } else rgb = valor.match(/\d+/g).slice(0, 3).map(Number);
    if (esRojo(...rgb) && !excepciones.has(valor.toUpperCase())) encontrados.push(valor);
  }
  return encontrados;
}

const archivosFuente = async () => (await Promise.all(['app/src/panel', 'app/src/prompter', 'app/src/dock', 'app/src/lib'].map(fuentes))).flat();

test('los estilos no contienen rojos literales', async () => {
  const fallos = [];
  for (const file of estilos) for (const color of rojos(sinComentarios(await read(file)))) fallos.push(`${file}: ${color}`);
  assert.deepEqual(fallos, [], `rojos literales:\n${fallos.join('\n')}`);
});

test('los colores y ejemplos de las vistas usan primitivas del sistema', async () => {
  // Los datos de selectores y ejemplos necesitan hex: solo se admiten primitivas DS exactas.
  const tokens = await read('public/ds/tokens.css');
  const primitivas = new Set([...tokens.matchAll(/--color-primitive-[\w-]+:\s*(#[\da-f]{3,8})\s*;/gi)].map(m => m[1].toUpperCase()));
  const fallos = [];
  for (const file of await archivosFuente()) {
    const texto = sinComentarios(await read(file));
    // Revisar cadenas, no expresiones regulares ni comentarios de código.
    for (const cadena of texto.matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*?\1/g)) {
      for (const color of rojos(cadena[0])) if (!primitivas.has(color.toUpperCase()) || cadena[0].includes('var(')) fallos.push(`${file}: ${color}`);
    }
  }
  assert.deepEqual(fallos, [], `rojos fuera de primitivas DS:\n${fallos.join('\n')}`);
});

test('todas las variables usadas están declaradas o tienen fallback', async () => {
  const archivos = [...estilos, ...await archivosFuente()];
  const contenidos = await Promise.all(archivos.map(read));
  const defs = [await read('public/ds/tokens.css'), await read('public/fonts.css'), ...contenidos].map(sinComentarios).join('\n');
  const declaradas = new Set([...defs.matchAll(/(--[\w-]+)\s*['"]?\s*(?:as\s+\w+\s*\])?\s*:/g)].map(m => m[1]));
  const faltan = new Set();
  for (let i = 0; i < archivos.length; i++) {
    for (const m of sinComentarios(contenidos[i]).matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      if (m[2] !== ',' && !declaradas.has(m[1])) faltan.add(`${m[1]} (${archivos[i]})`);
    }
  }
  assert.deepEqual([...faltan], [], `variables sin declarar: ${[...faltan].join(', ')}`);
});

test('los alias locales de rojo y rosa derivan de tokens DS', async () => {
  const ds = await read('public/ds/tokens.css');
  const tokens = new Set([...ds.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const fallos = [];
  for (const file of estilos) {
    for (const m of sinComentarios(await read(file)).matchAll(/(--(?:pink|red)(?:-[\w-]+)?)\s*:\s*([^;}]+)/g)) {
      const ref = m[2].trim().match(/^var\((--[\w-]+)\)$/);
      if (!ref || !tokens.has(ref[1])) fallos.push(`${file}: ${m[1]}: ${m[2]}`);
    }
  }
  assert.deepEqual(fallos, [], `alias fuera del DS: ${fallos.join(', ')}`);
});
