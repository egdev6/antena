import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/', import.meta.url));

test('#179: only src/programs imports src/meld.mjs', async () => {
  const offenders = [];
  for (const entry of await readdir(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const file = path.join(entry.parentPath, entry.name);
    const rel = path.relative(src, file).split(path.sep).join('/');
    if (rel.startsWith('programs/')) continue;
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2];
      if (!spec.startsWith('.')) continue;
      if (path.resolve(path.dirname(file), spec) === path.join(src, 'meld.mjs')) offenders.push(`${rel} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});
