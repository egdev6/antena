import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/code-safety.yml', import.meta.url), 'utf8');
const steps = workflow.split(/^ {6}- name: /m).slice(1);
const step = name => {
  const value = steps.find(item => item.startsWith(`${name}\n`));
  assert.ok(value, `missing step: ${name}`);
  return value;
};

test('pull requests use only the base commit as trusted controls', () => {
  const checkout = step('Fetch pull request base controls');
  assert.match(checkout, /if: github\.event_name == 'pull_request'/);
  assert.match(checkout, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(checkout, /path: trusted/);
  assert.doesNotMatch(workflow, /TRUSTED_BASELINE|repository: egdev6\/quorb|pull_request_target/);
});

test('push and manual runs use the event commit as trusted controls', () => {
  const checkout = step('Fetch event commit controls');
  assert.match(checkout, /if: github\.event_name != 'pull_request'/);
  assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(checkout, /path: trusted/);
});

test('target remains a separate data-only checkout of github.sha', () => {
  const checkout = step('Fetch target as data only');
  assert.match(workflow, /^  TARGET_COMMIT: \$\{\{ github\.sha \}\}$/m);
  assert.match(checkout, /ref: \$\{\{ env\.TARGET_COMMIT \}\}/);
  assert.match(checkout, /path: target/);
  assert.doesNotMatch(workflow, /node target\/|uses: \.\/target\//);
});

test('both identities fail closed before scanner or policy execution', () => {
  const check = step('Verify checkout identities');
  assert.match(workflow, /^  PR_BASE_COMMIT: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/m);
  assert.match(check, /\[\[ "\$TARGET_COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(check, /git -C target rev-parse HEAD\)" = "\$TARGET_COMMIT"/);
  assert.match(check, /if \[\[ "\$GITHUB_EVENT_NAME" == pull_request \]\]; then[\s\S]*\[\[ "\$PR_BASE_COMMIT" =~ \^\[0-9a-f\]\{40\}\$ \]\][\s\S]*git -C trusted rev-parse HEAD\)" = "\$PR_BASE_COMMIT"[\s\S]*else[\s\S]*git -C trusted rev-parse HEAD\)" = "\$TARGET_COMMIT"/);
  for (const name of ['Verify objective repository policy', 'Provision exact verified wheels and runtime', 'Analyze inert Git blobs offline']) {
    assert.ok(steps.indexOf(check) < steps.indexOf(step(name)), `${name} must follow identity checks`);
  }
});

test('scanner and optional policy execute only from trusted vendored controls', () => {
  assert.match(workflow, /^  REPOSITORY_POLICY_BASE64: ""$/m);
  assert.match(step('Verify objective repository policy'), /node trusted\/tools\/code-safety\/check-repository\.mjs/);
  assert.match(step('Provision exact verified wheels and runtime'), /node trusted\/tools\/code-safety\/code-safety\.mjs provision/);
  assert.match(step('Analyze inert Git blobs offline'), /node trusted\/tools\/code-safety\/code-safety\.mjs scan[\s\S]*"\$GITHUB_WORKSPACE\/target" "\$TARGET_COMMIT"/);
  assert.match(workflow, /docker\.io\/library\/python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d/);
});

test('retains triggers, locked actions, read-only permissions, Node, concurrency and cleanup', () => {
  assert.match(workflow, /^on:\n  pull_request:\n  push:\n    branches: \[main\]\n  workflow_dispatch:/m);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(step('Prepare trusted Node runtime'), /node-version: '24'/);
  assert.match(step('Remove temporary downloaded tools'), /if: always\(\)/);
  for (const checkout of [step('Fetch pull request base controls'), step('Fetch event commit controls'), step('Fetch target as data only')]) {
    assert.match(checkout, /uses: actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
    for (const flag of ['persist-credentials: false', 'submodules: false', 'lfs: false']) assert.ok(checkout.includes(flag));
  }
  assert.match(step('Prepare trusted Node runtime'), /uses: actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
});

// Commands of every `run:` step, with backslash continuations joined.
const runCommands = () => {
  const commands = [];
  const lines = workflow.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    if (m[2] === '|' || m[2] === '>') {
      const indent = m[1].length;
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent)) body.push(lines[++i].trim());
    } else body.push(m[2].trim());
    commands.push(...body.join('\n').replace(/\\\n\s*/g, ' ').split('\n').map(s => s.trim()).filter(Boolean));
  }
  return commands;
};

test('no step executes code from the target checkout', () => {
  const commands = runCommands();
  assert.ok(commands.length > 0);
  const identity = /^test "\$\(git -C target rev-parse HEAD\)" = "\$TARGET_COMMIT"$/;
  for (const command of commands) {
    assert.doesNotMatch(command, /\b(npm|npx|pnpm|yarn|corepack)\b/, `no package manager: ${command}`);
    if (!/target/i.test(command.replace(/\$TARGET_COMMIT|TARGET_COMMIT/g, ''))) continue;
    if (identity.test(command)) continue;
    assert.match(command, /^node trusted\/tools\/code-safety\/[a-z-]+\.mjs /, `target only as trusted-scanner data: ${command}`);
    const mentions = command.replace(/\$TARGET_COMMIT/g, '').match(/[^\s"]*target[^\s"]*/gi) ?? [];
    assert.deepEqual([...new Set(mentions)], ['$GITHUB_WORKSPACE/target'], `target passed only as a data path: ${command}`);
  }
  assert.doesNotMatch(workflow, /^\s*working-directory:/m, 'no working-directory');
  assert.doesNotMatch(workflow, /^\s*uses:\s*\.\//m, 'no local actions');
});
