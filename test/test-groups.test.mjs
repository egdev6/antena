import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const groupsPath = new URL('./groups.json', import.meta.url);
const names = ['unit', 'browser', 'platform'];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_TEST_WORKER_ID;
const run = (script, args, cwd = root) => spawnSync(process.execPath, [script, ...args], {
  cwd, env, encoding: 'utf8', timeout: 30000,
});

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-test-groups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'scripts')); await mkdir(path.join(dir, 'test'));
  for (const name of ['baseline.mjs', 'test-groups.mjs', 'ci-baseline.mjs']) {
    await copyFile(path.join(root, 'scripts', name), path.join(dir, 'scripts', name));
  }
  const manifest = Object.fromEntries(names.map(name => [name, [`test/${name}.test.mjs`]]));
  await writeFile(path.join(dir, 'test', 'groups.json'), JSON.stringify(manifest));
  for (const name of names) {
    await writeFile(path.join(dir, 'test', `${name}.test.mjs`),
      `import { test } from 'node:test';\nimport { appendFileSync } from 'node:fs';\ntest('${name}-probe', () => appendFileSync(${JSON.stringify(path.join(dir, 'marker'))}, ${JSON.stringify(name + '\n')}));\n`);
  }
  return { dir, manifest, marker: path.join(dir, 'marker'), groups: path.join(dir, 'test', 'groups.json'),
    cli: path.join(dir, 'scripts', 'test-groups.mjs'), baseline: path.join(dir, 'scripts', 'baseline.mjs') };
}

test('each test file belongs to exactly one explicit group, with no stale entries', async () => {
  const manifest = JSON.parse(await readFile(groupsPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), [...names].sort());
  const entries = names.flatMap(name => manifest[name]);
  assert.ok(names.every(name => Array.isArray(manifest[name]) && manifest[name].length > 0));
  assert.equal(new Set(entries).size, entries.length, 'duplicate classification');
  assert.deepEqual([...entries].sort(), (await readdir(new URL('.', import.meta.url), { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => `test/${entry.name}`).sort(), 'unclassified or missing test file');
  for (const file of ['test/close-chrome.test.mjs', 'test/redesign-regressions.test.mjs',
    'test/held-recovery-windows-storage.test.mjs', 'test/instance-id-lock.test.mjs',
    'test/config-transfer-media.test.mjs', 'test/release-workflow.test.mjs']) {
    assert.ok(manifest.platform.includes(file), `${file} must run on Windows`);
  }
  assert.ok(manifest.platform.includes('test/test-groups.test.mjs'));
  assert.ok(manifest.browser.includes('test/react-prompter.test.mjs'));
});

test('group runner selects exactly the requested files and propagates failures', async t => {
  const f = await fixture(t);
  for (const name of names) {
    const result = run(f.cli, [name], f.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${name}-probe`));
    for (const other of names.filter(item => item !== name)) assert.doesNotMatch(result.stdout, new RegExp(`${other}-probe`));
    assert.equal(result.stderr, '');
  }
  assert.equal(await readFile(f.marker, 'utf8'), 'unit\nbrowser\nplatform\n');
  await writeFile(path.join(f.dir, 'test', 'unit.test.mjs'), "import { test } from 'node:test';\ntest('fails', () => { throw Error('FAIL_PROBE'); });\n");
  const failed = run(f.cli, ['unit'], f.dir);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL_PROBE/);
  assert.equal(await readFile(f.marker, 'utf8'), 'unit\nbrowser\nplatform\n');
});

test('group and baseline reject duplicate, unclassified and missing files before running', async t => {
  const f = await fixture(t);
  for (const change of ['duplicate', 'unclassified', 'missing']) {
    const m = structuredClone(f.manifest);
    if (change === 'duplicate') m.unit.push(m.platform[0]);
    if (change === 'unclassified') m.unit = [];
    if (change === 'missing') m.unit.push('test/missing.test.mjs');
    await writeFile(f.groups, JSON.stringify(m));
    for (const [script, args] of [[f.cli, ['platform']], [f.baseline, ['--group', 'platform', '--output', 'report.json', '--tap', 'report.tap']]]) {
      const result = run(script, args, f.dir);
      assert.equal(result.status, 1, change);
      assert.equal(result.stdout, '', change);
      assert.match(result.stderr, /manifest|manifiesto/i, change);
      await assert.rejects(access(f.marker), { code: 'ENOENT' });
      await assert.rejects(access(path.join(f.dir, 'report.json')), { code: 'ENOENT' });
      await assert.rejects(access(path.join(f.dir, 'report.tap')), { code: 'ENOENT' });
    }
  }
});

test('baseline group keeps JSON, TAP and coverage and leaves full-suite default intact', async t => {
  const f = await fixture(t);
  const result = run(f.baseline, ['--group', 'platform', '--output', 'report.json', '--tap', 'report.tap'], f.dir);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.tests.group, 'platform');
  assert.deepEqual(report.tests.files, f.manifest.platform);
  assert.equal(report.tests.counts.pass, 1);
  assert.equal(report.coverage.available, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'report.json'), 'utf8')), report);
  const tap = await readFile(path.join(f.dir, 'report.tap'), 'utf8');
  assert.match(tap, /platform-probe/); assert.doesNotMatch(tap, /unit-probe|browser-probe/);
  assert.equal(await readFile(f.marker, 'utf8'), 'platform\n');
  const full = run(f.baseline, ['--no-coverage'], f.dir);
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout).tests.files, names.map(name => `test/${name}.test.mjs`).sort());
  assert.deepEqual((await readFile(f.marker, 'utf8')).trim().split('\n').sort(), ['browser', 'platform', 'platform', 'unit']);
});

test('the platform baseline still enforces browser and per-reason Windows skip gates', async t => {
  const f = await fixture(t);
  const first = 'prompter React: guardar una marca libera la cronología (Enter/blur, SSE y fallo)';
  const second = 'panel React: el aviso de configuración/secretos persiste, no finge guardado y se recupera sin recargar';
  const reason = 'POSIX process groups: Windows escalates the owned Chrome tree with taskkill instead of group signals';
  await writeFile(path.join(f.dir, 'test', 'platform.test.mjs'),
    `import { test } from 'node:test';\ntest(${JSON.stringify(first)}, () => {});\ntest(${JSON.stringify(second)}, () => {});\ntest('POSIX', { skip: ${JSON.stringify(reason)} }, () => {});\n`);
  const baseline = run(f.baseline, ['--group=platform', '--output', 'report.json', '--tap', 'report.tap'], f.dir);
  assert.equal(baseline.status, 0, baseline.stderr);
  const report = JSON.parse(baseline.stdout);
  assert.deepEqual({ group: report.tests.group, pass: report.tests.counts.pass, skipped: report.tests.counts.skipped },
    { group: 'platform', pass: 2, skipped: 1 });
  report.environment.platform = 'win32';
  const json = path.join(f.dir, 'report.json'), tap = path.join(f.dir, 'report.tap');
  await writeFile(json, JSON.stringify(report));
  const original = await readFile(tap, 'utf8');
  const gate = () => run(path.join(f.dir, 'scripts', 'ci-baseline.mjs'), [json, tap], f.dir);
  const good = gate();
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout).skips.map(skip => [skip.reason, skip.allowed]), [[reason, true]]);
  assert.equal(good.stderr, '');
  for (const changed of [original.replaceAll(reason, 'motivo desconocido'), original.replaceAll(first, 'regresión ausente')]) {
    await writeFile(tap, changed);
    const rejected = gate();
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stdout).ok, false);
    assert.equal(rejected.stderr, '');
  }
  await assert.rejects(access(f.marker), { code: 'ENOENT' });
});

test('invalid or missing groups fail closed and help documents the option', async t => {
  const f = await fixture(t);
  for (const args of [['--group'], ['--group', '--no-coverage'], ['--group', 'other'], ['--group=']]) {
    const result = run(f.baseline, args, f.dir);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /group/);
    await assert.rejects(access(f.marker), { code: 'ENOENT' });
  }
  const invalid = run(f.cli, ['other'], f.dir);
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /group|grupo/i);
  const help = run(f.baseline, ['--help'], f.dir);
  assert.equal(help.status, 0); assert.match(help.stdout, /--group.*unit.*browser.*platform/); assert.equal(help.stderr, '');
});

test('package scripts and opt-in POSIX pre-push hook run only the unit group', async t => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of names) assert.equal(pkg.scripts[`test:${name}`], `node scripts/test-groups.mjs ${name}`);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=300000 test/*.test.mjs');
  assert.equal(pkg.scripts['hooks:install'], 'git config core.hooksPath .githooks');
  assert.equal(pkg.scripts.prepare, undefined); assert.equal(pkg.scripts.postinstall, undefined);
  const hook = fileURLToPath(new URL('../.githooks/pre-push', import.meta.url));
  assert.match(await readFile(hook, 'utf8'), /^#!\/bin\/sh\n/);
  if (process.platform !== 'win32') assert.ok((await stat(hook)).mode & constants.S_IXUSR, 'hook must be executable');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-hook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'pnpm');
  await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$*"\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
  for (const code of [0, 23]) {
    const result = spawnSync('sh', [hook], { cwd: root, encoding: 'utf8', env: { ...env, PATH: `${dir}${path.delimiter}${env.PATH}`, FAKE_EXIT: String(code) } });
    assert.equal(result.status, code); assert.equal(result.stdout, 'test:unit\n'); assert.equal(result.stderr, '');
  }
});
