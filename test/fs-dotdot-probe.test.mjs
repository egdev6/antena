import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readlink, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { destinationCollision } from '../scripts/baseline.mjs';

async function contentsOrMissing(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// El oráculo procede de IO nativa, no de destinationCollision ni de path.resolve.
// No cambia los tests de regresión existentes ni atribuye semántica Unix a Windows.
test('filesystem caracteriza symlink y dotdot mediante IO nativa', async t => {
  for (const kind of ['relative', 'absolute']) {
    await t.test(kind, async t => {
      const root = await mkdtemp(path.join(tmpdir(), 'egdev-dotdot-probe-'));
      try {
        const foreignChild = path.join(root, 'foreign', 'child');
        await mkdir(foreignChild, { recursive: true });
        await symlink(foreignChild, path.join(root, 'bridge'), 'dir');
        // No usar join/resolve: eliminarían `..` antes de observar el filesystem.
        const direct = `${root}/bridge/../out.json`;
        const requested = kind === 'absolute' ? direct : 'bridge/../out.json';
        const alias = path.join(root, 'alias.tap');
        await symlink(requested, alias, 'file');
        const stored = await readlink(alias);
        const candidates = {
          root: path.join(root, 'out.json'),
          foreign: path.join(root, 'foreign', 'out.json'),
        };
        for (const [via, target] of [['symlink', alias], ['direct', direct]]) {
          const before = Object.fromEntries(await Promise.all(Object.entries(candidates)
            .map(async ([name, file]) => [name, await contentsOrMissing(file)])));
          assert.deepEqual(before, { root: null, foreign: null });
          const missingCollisions = Object.fromEntries(Object.entries(candidates)
            .map(([name, file]) => [name, destinationCollision(target, file)]));
          const sentinel = `${kind}:${via}`;
          // `wx` rechazaría el propio symlink con EEXIST antes de seguirlo.
          await writeFile(target, sentinel);
          const after = Object.fromEntries(await Promise.all(Object.entries(candidates)
            .map(async ([name, file]) => [name, await contentsOrMissing(file)])));
          const matches = Object.keys(after).filter(name => after[name] === sentinel);
          t.diagnostic(JSON.stringify({
            platform: process.platform, node: process.version, kind, via,
            requested: requested.replace(root, '<fixture>'),
            stored: stored.replace(root, '<fixture>'),
            after, missingCollisions,
            existingCollisions: Object.fromEntries(Object.entries(candidates)
              .map(([name, file]) => [name, destinationCollision(target, file)])),
          }));
          // Comprueba la medición, no escoge anticipadamente el ganador por OS.
          assert.equal(matches.length, 1, 'la escritura alcanza exactamente uno de los dos destinos');
          assert.equal(after[matches[0] === 'root' ? 'foreign' : 'root'], null);
          await rm(candidates[matches[0]]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
