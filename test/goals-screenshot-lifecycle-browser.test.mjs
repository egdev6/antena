import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './helpers/react-browser.mjs';

const fixture = fileURLToPath(new URL('./goals-browser.test.mjs', import.meta.url));

async function probe(root, browser, temporaryRoot = tmpdir()) {
  // Keep screenshot isolation independent from the browser's inherited temporary root.
  const env = { ...process.env, CHROME_PATH: browser, ANTENA_GOAL_SCREENSHOTS_ROOT: root,
    TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot };
  // A nested test runner is a separate fixture, not a recursive run in this worker.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    '--test', '--test-concurrency=1', '--test-timeout=300000', '--test-reporter=tap',
    '--test-name-pattern=^overlay goal\\.html:', fixture,
  ], { env });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { stdout += text; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output: stdout + stderr }));
  });
}

const screenshots = async root => (await readdir(root)).filter(name => name.startsWith('egdev-128-shots-'));

test('goal screenshots use a fresh directory that is removed after a passing browser test', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome is not available');
  const root = await mkdtemp(path.join(tmpdir(), 'antena-goal-shots-success-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = await probe(root, bin);
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ok 1 - overlay goal\.html:/);
  assert.deepEqual(await screenshots(root), [], 'successful run removes its screenshot directory');
});

test('goal screenshots are removed with an isolated nested screenshot path', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome is not available');
  // Nest only the screenshot root. Chrome keeps the inherited temporary root: its
  // Crashpad/singleton Unix sockets live there and fail (SIGTRAP, ENOENT) once the
  // path exceeds the ~107-byte socket limit, which deep sandbox paths can reach.
  const parent = await mkdtemp(path.join(tmpdir(), 'antena-recording-baseline-corrected-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = await mkdtemp(path.join(parent, 'antena-goal-shots-success-'));
  const result = await probe(root, bin);
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ok 1 - overlay goal\.html:/);
  assert.deepEqual(await screenshots(root), [], 'successful run removes its screenshot directory');
});

test('goal screenshots are retained and reported when a browser test fails', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-goal-shots-failure-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  // Node rejects Chrome's command-line flags, deterministically failing browser startup.
  const result = await probe(root, process.execPath);
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /not ok 1 - overlay goal\.html:/);
  const match = /Screenshots retained at ([^\r\n]+)/.exec(result.output);
  assert.ok(match, result.output);
  // The path reaches TAP inside a serialized error: on Windows its backslashes arrive escaped
  // and with a trailing separator, so normalize before comparing.
  const retained = path.resolve(match[1].trim().replaceAll('\\\\', '\\').replace(/[\\/]+$/, ''));
  assert.equal(path.dirname(retained), path.resolve(root));
  assert.equal((await stat(retained)).isDirectory(), true);
  assert.deepEqual(await screenshots(root), [path.basename(retained)]);
});
