import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('baseline comprueba tipos después de compilar y antes de los tests en ambos sistemas', async () => {
  const workflow = await readFile(new URL('../.github/workflows/baseline.yml', import.meta.url), 'utf8');
  assert.match(workflow, /os:\s*\[ubuntu-24\.04,\s*windows-2022\]/);
  const steps = workflow.split(/^ {6}- name: /m).slice(1);
  const index = command => steps.findIndex(step => new RegExp(`^ {8}run: ${command}$`, 'm').test(step));
  const install = index('pnpm install --frozen-lockfile');
  const build = index('pnpm app:build');
  const typecheck = index('pnpm typecheck');
  const baseline = index('node scripts/baseline\\.mjs --output baseline\\.json --tap baseline\\.tap');
  assert.ok(install >= 0 && build > install && typecheck > build && baseline > typecheck, 'typecheck debe ejecutar tras instalar/compilar y antes de baseline');
  assert.doesNotMatch(steps[typecheck], /^ {8}(?:if|continue-on-error):/m, 'un fallo de tipos debe parar el job en ambos sistemas');
});

test('Ubuntu executes the full baseline and Windows the platform baseline without renaming checks', async () => {
  const workflow = await readFile(new URL('../.github/workflows/baseline.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: Baseline \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}\)/);
  const steps = workflow.split(/^ {6}- name: /m).slice(1);
  const ubuntu = steps.find(step => /run: node scripts\/baseline\.mjs --output baseline\.json --tap baseline\.tap$/m.test(step));
  const windows = steps.find(step => /run: node scripts\/baseline\.mjs --group platform --output baseline\.json --tap baseline\.tap$/m.test(step));
  assert.ok(ubuntu && windows);
  assert.match(ubuntu, /if: runner\.os == 'Linux'/);
  assert.match(windows, /if: runner\.os == 'Windows'/);
  assert.match(workflow, /node scripts\/ci-baseline\.mjs baseline\.json baseline\.tap/);
  assert.match(workflow, /name: baseline-\$\{\{ matrix\.os \}\}-node-\$\{\{ matrix\.node \}\}/);
});
