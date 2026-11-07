// The Rust tests of the desktop app (navigation guard, new-window policy, sidecar paths) only ran
// locally: no workflow compiled src-tauri. This pins the CI job that runs them on every PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const WORKFLOW = new URL('../.github/workflows/rust.yml', import.meta.url);

test('rust: cargo test runs on every pull request and push to main', () => {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/rust.yml must exist');
  const yml = readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]/m, 'every PR and every push to main, without path filters');
  assert.doesNotMatch(yml, /^\s+paths(?:-ignore)?:/m, 'no path filters on any trigger');
  assert.match(yml, /^permissions:\n {2}contents: read$/m, 'read-only token');
  assert.match(yml, /runs-on: windows-2022/, 'runs on the platform the app ships for');
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /node-version: '24'/, 'same Node as the supported minimum');
});

test('rust: prepares the sidecar and app/dist before cargo test --locked', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const order = ['pnpm install --frozen-lockfile', 'pnpm app:build', 'pnpm desktop:node', 'cargo test --locked'];
  const at = order.map(step => yml.indexOf(step));
  for (const [i, step] of order.entries()) assert.ok(at[i] >= 0, `missing step: ${step}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps run in this order');
  assert.match(yml, /^ {8}working-directory: src-tauri\n {8}run: cargo test --locked$/m, 'cargo runs in src-tauri');
  for (const uses of yml.match(/uses: \S+/g) || []) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} pinned by SHA`);
  assert.doesNotMatch(yml, /secrets\./, 'no secrets');
});
