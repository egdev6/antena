// #360: the render counter exists only in the instrumented build, and the bundle size report is exact.
// Builds go to temp dirs (never app/dist) through the same script `pnpm app:build` runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { bundleSizes, formatRenders, formatSizes } from '../scripts/perf.mjs';
import { RENDER_COMPONENTS } from './render-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'scripts', 'build-app.mjs');
const run = promisify(execFile);
const sum = rows => rows.reduce((total, n) => total + n, 0);

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-render-build-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function buildTo(t, ...flags) {
  const dist = await tempDir(t);
  await run(process.execPath, [BUILD, '--dist', dist, ...flags], { cwd: ROOT, maxBuffer: 1 << 24 });
  return dist;
}

async function scriptsOf(dist) {
  const dir = path.join(dist, 'assets');
  const files = (await readdir(dir)).filter(file => file.endsWith('.js'));
  return (await Promise.all(files.map(file => readFile(path.join(dir, file), 'utf8')))).join('\n');
}

test('the production bundle carries no render counter', async t => {
  const text = await scriptsOf(await buildTo(t));
  assert.equal(text.includes('__antenaRenderCounts'), false, 'the counter store is not in the bundle');
  for (const label of RENDER_COMPONENTS) assert.equal(text.includes(label), false, `${label} call site is not in the bundle`);
});

test('the instrumented bundle counts every key component', async t => {
  const text = await scriptsOf(await buildTo(t, '--render-count'));
  assert.equal(text.includes('__antenaRenderCounts'), true, 'the counter store is in the bundle');
  for (const label of RENDER_COMPONENTS) assert.equal(text.includes(label), true, `${label} is counted`);
});

test('a build that does not define the flag still runs and counts nothing', async () => {
  // Several browser tests bundle app/src with their own esbuild call, which knows nothing of __RENDER_COUNT__.
  const { outputFiles } = await build({
    stdin: { contents: `import { countRender } from './render-count'; countRender('panel/Sidebar'); globalThis.ran = true;`,
      resolveDir: path.join(ROOT, 'app', 'src', 'lib'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', logLevel: 'silent',
  });
  const page = vm.createContext({});
  vm.runInContext(outputFiles[0].text, page);
  assert.equal(page.ran, true, 'the code after countRender ran');
  assert.equal(page.__antenaRenderCounts, undefined, 'nothing was counted');
});

test('the default build still writes the three pages and the assets they load', async t => {
  const dist = await buildTo(t);
  for (const page of ['index', 'prompter', 'dock']) {
    const html = await readFile(path.join(dist, `${page}.html`), 'utf8');
    const script = /<script type="module" src="\/assets\/([^"]+)"/.exec(html)?.[1];
    assert.ok(script, `${page}.html loads a script`);
    assert.ok((await stat(path.join(dist, 'assets', script))).size > 0, `${page}.html script exists`);
    const css = /<link rel="stylesheet" href="\/assets\/([^"]+)"/.exec(html)?.[1];
    assert.ok(css, `${page}.html loads a stylesheet`);
    assert.ok((await stat(path.join(dist, 'assets', css))).size > 0, `${page}.html stylesheet exists`);
  }
});

async function rejectionBuild(t) {
  // Run the real CLI from a throwaway root in case it falls back to rebuilding app/dist.
  const root = await tempDir(t);
  const script = path.join(root, 'scripts', 'build-app.mjs');
  const defaultDist = path.join(root, 'app', 'dist');
  await mkdir(path.dirname(script));
  await copyFile(BUILD, script);
  await symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  await mkdir(defaultDist, { recursive: true });
  await writeFile(path.join(defaultDist, 'keep.txt'), 'original build');
  return { defaultDist, invoke: args => run(process.execPath, [script, ...args], { cwd: root }) };
}

async function assertPreserved(dir, contents) {
  assert.deepEqual(await readdir(dir), ['keep.txt'], `${dir}: nothing was written or removed`);
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), contents);
}

test('--dist never wipes a directory that already holds files', async t => {
  const { defaultDist, invoke } = await rejectionBuild(t);
  const dist = await tempDir(t);
  await writeFile(path.join(dist, 'keep.txt'), 'mine');
  await assert.rejects(invoke(['--dist', dist]), { code: 1, stdout: '', stderr: `--dist ${path.resolve(dist)} no está vacío\n` });
  await assertPreserved(dist, 'mine');
  await assertPreserved(defaultDist, 'original build');
});

test('--dist without a directory is an error, not a rebuild of app/dist', async t => {
  const { defaultDist, invoke } = await rejectionBuild(t);
  for (const args of [['--dist'], ['--dist', '--render-count']]) {
    await assert.rejects(invoke(args), { code: 1, stdout: '', stderr: '--dist necesita un directorio\n' });
    await assertPreserved(defaultDist, 'original build');
  }
});

test('bundleSizes reports raw and gzip bytes of every JS and CSS asset', async t => {
  const dir = path.join(await buildTo(t), 'assets');
  const report = await bundleSizes(dir);
  assert.deepEqual(report.files.map(f => f.file).sort(), (await readdir(dir)).filter(f => /\.(js|css)$/.test(f)).sort(), 'one row per emitted JS and CSS asset');
  for (const row of report.files) {
    const bytes = await readFile(path.join(dir, row.file));
    assert.equal(row.type, row.file.endsWith('.css') ? 'css' : 'js', `${row.file} type`);
    assert.equal(row.raw, bytes.length, `${row.file} raw bytes`);
    assert.equal(row.gzip, gzipSync(bytes, { level: 9 }).length, `${row.file} gzip bytes (level 9)`);
  }
  for (const type of ['js', 'css']) {
    const rows = report.files.filter(f => f.type === type);
    assert.ok(rows.length > 0, `there are ${type} assets`);
    assert.deepEqual(report.totals[type], { raw: sum(rows.map(r => r.raw)), gzip: sum(rows.map(r => r.gzip)) }, `${type} totals`);
  }
});

test('pnpm perf --only size prints the bundle size of a fresh production build', { timeout: 60000 }, async t => {
  const dir = path.join(await buildTo(t), 'assets');
  const expected = await bundleSizes(dir);
  const script = path.join(ROOT, 'scripts', 'perf.mjs');
  const json = await run(process.execPath, [script, '--only', 'size', '--json'], { cwd: ROOT, maxBuffer: 1 << 24 });
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.renders, undefined, 'no render section with --only size');
  assert.deepEqual(parsed.size.totals, expected.totals, 'same totals as the default build');
  const table = await run(process.execPath, [script, '--only', 'size'], { cwd: ROOT, maxBuffer: 1 << 24 });
  assert.equal(table.stderr, '');
  assert.match(table.stdout, /Tamaño del bundle/);
  assert.match(table.stdout, new RegExp(`JS\\s+${expected.totals.js.raw}\\s+${expected.totals.js.gzip}`), 'JS totals row');
  assert.match(table.stdout, new RegExp(`CSS\\s+${expected.totals.css.raw}\\s+${expected.totals.css.gzip}`), 'CSS totals row');
  assert.doesNotMatch(table.stdout, /Renders por componente/);
});

test('the render and size tables name every component and total', () => {
  const renders = formatRenders({
    scenario: { messages: 100, viewerReads: 10, clockTicks: 10 },
    pages: [
      { page: 'panel/chat', events: { chat: 100, viewers: 10 }, components: { 'panel/Sidebar': { burst: 110, clock: 0 }, 'panel/Chat': { burst: 100, clock: 0 } } },
      { page: 'dock', events: { chat: 100, viewers: 10 }, components: { 'dock/Status': { burst: 110, clock: 10 } } },
    ],
  });
  assert.match(renders, /Renders por componente/);
  assert.match(renders, /100 mensajes de chat/);
  assert.match(renders, /panel\/chat\s+panel\/Sidebar\s+110\s+0\n/);
  assert.match(renders, /panel\/chat\s+panel\/Chat\s+100\s+0\n/);
  assert.match(renders, /dock\s+dock\/Status\s+110\s+10\n/);
  assert.doesNotMatch(renders, /aviso/i, 'no warning when only chat and viewers events arrived');
  const unexpected = formatRenders({
    scenario: { messages: 5, viewerReads: 1, clockTicks: 1 },
    pages: [{ page: 'dock', events: { chat: 5, viewers: 1, timeline: 2 }, components: { 'dock/Status': { burst: 8, clock: 1 } } }],
  });
  assert.match(unexpected, /aviso.*dock.*timeline/i, 'unexpected events are named');
  const sizes = formatSizes({
    files: [{ file: 'panel-AAAAAAAA.js', type: 'js', raw: 2048, gzip: 1024 }, { file: 'panel-BBBBBBBB.css', type: 'css', raw: 512, gzip: 256 }],
    totals: { js: { raw: 2048, gzip: 1024 }, css: { raw: 512, gzip: 256 } },
  });
  assert.match(sizes, /panel\.js\s+2048\s+1024/, 'file names are shown without their content hash');
  assert.match(sizes, /panel\.css\s+512\s+256/);
  assert.match(sizes, /JS\s+2048\s+1024/);
  assert.match(sizes, /CSS\s+512\s+256/);
});

test('the documented command exists and the docs name it', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.perf, 'node scripts/perf.mjs');
  const docs = await readFile(path.join(ROOT, 'docs', 'rendimiento.md'), 'utf8');
  assert.match(docs, /pnpm perf/, 'docs/rendimiento.md documents the command');
  assert.match(docs, /Línea base/, 'docs/rendimiento.md publishes the baseline numbers');
});
