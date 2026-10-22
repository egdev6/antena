// Test de src/http-util.mjs (#107): helpers puros compartidos httpError, id8,
// safePath, cleanName y freeName, extraídos de server.mjs sin cambio de comportamiento.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { httpError, id8, safePath, cleanName, freeName } from '../src/http-util.mjs';

test('httpError: Error con status y mensaje', () => {
  const e = httpError(418, 'Soy una tetera');
  assert.ok(e instanceof Error);
  assert.equal(e.status, 418);
  assert.equal(e.message, 'Soy una tetera');
});

test('id8: 8 caracteres hexadecimales', () => {
  for (let i = 0; i < 20; i++) assert.match(id8(), /^[0-9a-f]{8}$/);
});

test('safePath: resuelve dentro del directorio y rechaza salirse', () => {
  assert.equal(safePath('/tmp/base', 'a/b.png'), path.resolve('/tmp/base/a/b.png'));
  // %2e%2e se decodifica antes de resolver: el traversal se bloquea
  assert.throws(() => safePath('/tmp/base', '..%2Fetc%2Fpasswd'), e => e.status === 403 && e.message === 'Prohibido');
  assert.throws(() => safePath('/tmp/base', '/etc/passwd'), e => e.status === 403);
  assert.throws(() => safePath('/tmp/base', ''), e => e.status === 403);
});

test('cleanName: basename, sin separadores ni caracteres raros, NFC y tope de 120', () => {
  assert.equal(cleanName('mí face.png'), 'mí face.png');
  assert.equal(cleanName('C:\\dir\\foto.png'), 'foto.png');
  assert.equal(cleanName('/a/b/idea.webm'), 'idea.webm');
  assert.equal(cleanName('café.txt'), 'café.txt'); // NFC
  assert.equal(cleanName('a*b?c.png'), 'a_b_c.png');
  assert.equal(cleanName('..oculto.png'), 'oculto.png');
  assert.equal(cleanName('x'.repeat(300) + '.png'), 'x'.repeat(120));
  assert.equal(cleanName(''), '');
  assert.equal(cleanName(undefined), '');
});

test('freeName: nombre libre tal cual; ocupado, sufijo -1, -2…', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'egdev-freename-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await freeName(dir, 'a.png'), path.join(dir, 'a.png'));
  await writeFile(path.join(dir, 'a.png'), 'x');
  assert.equal(await freeName(dir, 'a.png'), path.join(dir, 'a-1.png'));
  await writeFile(path.join(dir, 'a-1.png'), 'x');
  const libre = await freeName(dir, 'a.png');
  assert.equal(libre, path.join(dir, 'a-2.png'));
  await assert.rejects(stat(libre)); // y no existe todavía
});
