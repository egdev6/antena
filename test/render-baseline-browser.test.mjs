// #360: `pnpm perf` runs one synthetic chat burst against a throwaway server and reports how many
// times each key component rendered, plus the production bundle size. Chrome drives the real pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { findChrome } from './helpers/react-browser.mjs';
import { runRenderScenario } from './render-scenario.mjs';
import { SURFACES } from './render-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

test('pnpm perf reports renders per component for a chat burst and the bundle size', { timeout: 180000 }, async t => {
  if (!await findChrome()) return t.skip('sin Chrome local; define CHROME_PATH para medir los renders');
  const { stdout, stderr } = await run(process.execPath,
    [path.join(ROOT, 'scripts', 'perf.mjs'), '--messages', '20', '--viewers-every', '5', '--ticks', '3'],
    { cwd: ROOT, maxBuffer: 1 << 24, timeout: 170000 });
  assert.equal(stderr, '');
  assert.match(stdout, /Renders por componente/);
  assert.match(stdout, /20 mensajes de chat/);
  assert.match(stdout, /4 lecturas de espectadores/);
  assert.match(stdout, /3 ticks/);
  // rows: <page> <component> <burst renders> <clock renders>
  const rows = new Map();
  for (const line of stdout.split('\n')) {
    const cells = line.trim().split(/\s+/);
    if (cells.length === 4 && /^\d+$/.test(cells[2]) && /^\d+$/.test(cells[3])) rows.set(`${cells[0]} ${cells[1]}`, { burst: Number(cells[2]), clock: Number(cells[3]) });
  }
  for (const { page, components } of SURFACES) {
    for (const component of components) assert.ok(rows.has(`${page} ${component}`), `${page} ${component} is reported`);
  }
  // The chat views must render to show the burst, whatever later issues optimize elsewhere.
  assert.ok(rows.get('panel/chat panel/Chat').burst >= 1, 'the panel chat rendered during the burst');
  assert.ok(rows.get('prompter prompter/Chat').burst >= 1, 'the prompter chat rendered during the burst');
  assert.match(stdout, /Tamaño del bundle/);
  assert.match(stdout, /^JS\s+\d+\s+\d+$/m);
  assert.match(stdout, /^CSS\s+\d+\s+\d+$/m);
});

test('replaying the burst preserves traffic, chat rows and manual clock renders', { timeout: 180000 }, async t => {
  if (!await findChrome()) return t.skip('sin Chrome local; define CHROME_PATH para medir los renders');
  const surfaces = SURFACES.filter(s => ['panel/chat', 'dock', 'prompter'].includes(s.page));
  const options = { messages: 10, viewersEvery: 5, ticks: 2, surfaces, captureChatRows: true };
  const expectedRows = Array.from({ length: 10 }, (_, i) => `burst message ${i + 1}`);
  const first = await runRenderScenario(options);
  const second = await runRenderScenario(options);

  for (const report of [first, second]) {
    assert.deepEqual(report.scenario, { messages: 10, viewerReads: 2, clockTicks: 2 });
    assert.deepEqual(report.pages.map(p => p.page), ['panel/chat', 'dock', 'prompter']);
    for (const [i, page] of report.pages.entries()) {
      assert.deepEqual(page.events, { chat: 10, viewers: 2 }, `${page.page} saw only the scenario's events`);
      if (surfaces[i].shows) assert.deepEqual(page.chatRows, expectedRows, `${page.page} shows all 10 messages once, in order`);
      assert.deepEqual(Object.keys(page.components), surfaces[i].components);
      for (const [label, { burst, clock }] of Object.entries(page.components)) {
        assert.ok(Number.isSafeInteger(burst) && burst >= 0, `${label} burst count: ${burst}`);
        assert.ok(Number.isSafeInteger(clock) && clock >= 0, `${label} clock count: ${clock}`);
      }
    }
  }
  // React may batch the live burst differently. Only the separately driven clock counts must repeat.
  const clocks = report => report.pages.map(p => Object.values(p.components).map(count => count.clock));
  assert.deepEqual(clocks(second), clocks(first));
});
