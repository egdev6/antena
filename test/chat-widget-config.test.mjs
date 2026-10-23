// #130 · chat del overlay: esquema/defaults nuevos (widgets.chat.reverse, animIn, animOut).
// Unit exclusivo de chat para reducir conflictos con el trabajo de #128 en config-schema.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('validatePath: widgets.chat.reverse es bool y animIn/animOut son enums de chat', async () => {
  const { validatePath } = await import('../src/config-schema.mjs');
  // reverse
  assert.deepEqual(validatePath('widgets.chat.reverse', true), []);
  assert.deepEqual(validatePath('widgets.chat.reverse', false), []);
  assert.ok(validatePath('widgets.chat.reverse', 'sí').length > 0);
  // animIn
  for (const v of ['slide', 'fade', 'pop', 'none']) assert.deepEqual(validatePath('widgets.chat.animIn', v), []);
  assert.ok(validatePath('widgets.chat.animIn', 'wobble').length > 0);
  assert.ok(validatePath('widgets.chat.animIn', true).length > 0);
  // animOut: las mismas que animIn
  for (const v of ['slide', 'fade', 'pop', 'none']) assert.deepEqual(validatePath('widgets.chat.animOut', v), []);
  assert.ok(validatePath('widgets.chat.animOut', 'wobble').length > 0);
});

test('validatePath: efectos nuevos de entrada/salida del chat (O2.2)', async () => {
  const { validatePath } = await import('../src/config-schema.mjs');
  // entrada y salida aceptan las mismas animaciones; lo desconocido sigue rechazado
  for (const v of ['bounce', 'zoom', 'flip', 'blur', 'drop']) {
    assert.deepEqual(validatePath('widgets.chat.animIn', v), [], `animIn ${v}`);
    assert.deepEqual(validatePath('widgets.chat.animOut', v), [], `animOut ${v}`);
  }
  assert.ok(validatePath('widgets.chat.animIn', 'spin').length > 0);
  assert.ok(validatePath('widgets.chat.animOut', 'spin').length > 0);
});

test('validatePatch: patch de chat con opciones nuevas válidas y rechazo de inválidas', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  assert.deepEqual(validatePatch({ widgets: { chat: { reverse: true, animIn: 'pop', animOut: 'fade' } } }), []);
  const errores = validatePatch({ widgets: { chat: { reverse: 'sí', animIn: 'wobble', animOut: 'spin' } } });
  const rutas = errores.map(e => e.path).sort();
  assert.deepEqual(rutas, ['widgets.chat.animIn', 'widgets.chat.animOut', 'widgets.chat.reverse'], JSON.stringify(errores));
});

test('DEFAULT_CONFIG: reverse false y animIn/animOut slide (apariencia actual intacta)', async () => {
  const { DEFAULT_CONFIG } = await import('../src/store.mjs');
  const chat = DEFAULT_CONFIG.widgets.chat;
  assert.equal(chat.reverse, false);
  assert.equal(chat.animIn, 'slide');
  assert.equal(chat.animOut, 'slide');
});

test('Store.load sanea chat inválido con default y aviso, y conserva lo válido', async () => {
  const { Store } = await import('../src/store.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'egdev-chat-cfg-'));
  const avisos = [];
  const originalWarn = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      widgets: { chat: { reverse: 'claro', animIn: 'wobble', animOut: 7, fontSize: 30 } },
    }));
    const s = await new Store(dir).load();
    const chat = s.config.widgets.chat;
    assert.equal(chat.reverse, false, 'default de reverse');
    assert.equal(chat.animIn, 'slide', 'default de animIn');
    assert.equal(chat.animOut, 'slide', 'default de animOut');
    assert.equal(chat.fontSize, 30, 'campo válido se conserva');
    const texto = avisos.join('\n');
    assert.match(texto, /widgets\.chat\.reverse/);
    assert.match(texto, /widgets\.chat\.animIn/);
    assert.match(texto, /widgets\.chat\.animOut/);
  } finally {
    console.warn = originalWarn;
    await rm(dir, { recursive: true, force: true });
  }
});
