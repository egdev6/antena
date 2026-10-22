// #67 · Coste de guardado de la sesión.
// Una sola serialización por checkpoint y formato compacto en los ficheros de sesión
// (el writer compartido conserva su formato indentado por defecto para config.json).
// Decisión del humano: SIN tope de eventos — los eventos son alertas, no mensajes de
// chat, y el recorte perdía cronología e inflaba el contador de pendientes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';

async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-session-cost-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

const syntheticAlert = (i) => ({
  id: `ev:${i}`,
  type: i % 2 === 0 ? 'cheer' : 'follow',
  at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
  vars: { user: `user${i % 50}`, amount: i % 2 === 0 ? 10 : undefined },
  text: `user${i % 50}`,
  sub: '',
});

test('con 5.000 eventos, cada checkpoint serializa el objeto una sola vez', async t => {
  const dir = await ownDir(t);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000 }).load();
  for (let i = 0; i < 5000; i++) s.data.events.push(syntheticAlert(i));

  const realStringify = JSON.stringify;
  let serializations = 0;
  JSON.stringify = function (value, ...rest) {
    if (value && typeof value === 'object' && Array.isArray(value.events)) serializations++;
    return realStringify.call(JSON, value, ...rest);
  };
  try {
    await s.flush();
  } finally {
    JSON.stringify = realStringify;
  }
  assert.equal(serializations, 1, 'el checkpoint completo (backup + primary) serializa una sola vez');
});

test('el guardado escribe formato compacto, sin indentación', async t => {
  const dir = await ownDir(t);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000 }).load();
  s.data.events.push(syntheticAlert(0));
  await s.flush();
  const text = await fsp.readFile(path.join(dir, 'session-current.json'), 'utf8');
  assert.ok(!text.includes('\n  '), 'el JSON persistido no debe llevar indentación');
  assert.deepEqual(JSON.parse(text).events, [syntheticAlert(0)]);
});
