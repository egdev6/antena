#!/usr/bin/env node
// Performance baseline (#360): renders per component under a chat burst, and the production bundle size.
//   pnpm perf                    → both measurements (the renders one needs Chrome)
//   pnpm perf --only size        → the production bundle size only (no Chrome)
//   pnpm perf --only renders     → the burst renders only
//   pnpm perf --messages 200 --viewers-every 10 --ticks 10 --json
// It always builds into temp dirs (app/dist is untouched). How to read it: docs/rendimiento.md.
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);
const USAGE = 'uso: pnpm perf [--only size|renders] [--messages N] [--viewers-every N] [--ticks N] [--json]';

/** Builds the app into `dist` (new or empty) with the same script as `pnpm app:build`. */
export async function buildInto(dist, { renderCount = false } = {}) {
  const script = path.join(ROOT, 'scripts', 'build-app.mjs');
  await run(process.execPath, [script, '--dist', dist, ...(renderCount ? ['--render-count'] : [])], { cwd: ROOT, maxBuffer: 1 << 24 });
}

// ---------- bundle size ----------
const sumOf = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

/** Raw and gzip (level 9) bytes of every JS and CSS file in an assets directory. */
export async function bundleSizes(assetsDir) {
  const files = [];
  for (const file of (await readdir(assetsDir)).sort()) {
    const type = file.endsWith('.js') ? 'js' : file.endsWith('.css') ? 'css' : null;
    if (!type) continue;
    const bytes = await readFile(path.join(assetsDir, file));
    files.push({ file, type, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length });
  }
  const totals = {};
  for (const type of ['js', 'css']) {
    const rows = files.filter(f => f.type === type);
    totals[type] = { raw: sumOf(rows, 'raw'), gzip: sumOf(rows, 'gzip') };
  }
  return { files, totals };
}

// ---------- tables ----------
const table = (head, rows, left) => {
  const cells = [head, ...rows];
  const width = head.map((_, i) => Math.max(...cells.map(row => String(row[i]).length)));
  return cells.map(row => row.map((cell, i) => (i < left ? String(cell).padEnd(width[i]) : String(cell).padStart(width[i]))).join('  ').trimEnd()).join('\n') + '\n';
};

export function formatSizes({ files, totals }) {
  const rows = [...files].sort((a, b) => (a.type === b.type ? b.raw - a.raw : a.type === 'js' ? -1 : 1))
    .map(f => [f.file.replace(/-[A-Z0-9]{8}(?=\.)/, ''), f.raw, f.gzip]);
  return `Tamaño del bundle de producción (JS y CSS de app/dist/assets, en bytes; gzip nivel 9)\n\n${table(['Archivo', 'Bruto', 'gzip'], rows, 1)}\n`
    + table(['Total', 'Bruto', 'gzip'], [['JS', totals.js.raw, totals.js.gzip], ['CSS', totals.css.raw, totals.css.gzip]], 1);
}

export function formatRenders({ scenario, pages }) {
  const rows = pages.flatMap(({ page, components }) => Object.entries(components).map(([name, n]) => [page, name, n.burst, n.clock]));
  // Only chat and viewers events belong to the burst: any other event skews the comparison.
  const unexpected = pages.map(({ page, events }) => [page, Object.entries(events).filter(([type]) => !['chat', 'viewers'].includes(type))])
    .filter(([, extra]) => extra.length)
    .map(([page, extra]) => `aviso: ${page} recibió eventos ajenos a la ráfaga: ${extra.map(([type, n]) => `${type} ×${n}`).join(', ')}\n`);
  return `Renders por componente (ráfaga: ${scenario.messages} mensajes de chat y ${scenario.viewerReads} lecturas de espectadores;`
    + ` reloj: ${scenario.clockTicks} ticks de 1 s)\n\n${table(['Página', 'Componente', 'Ráfaga', 'Reloj'], rows, 2)}${unexpected.join('')}`;
}

// ---------- command line ----------
function parseArgs(argv) {
  const options = { only: null, messages: 100, viewersEvery: 10, ticks: 10, json: false };
  const numbers = { '--messages': 'messages', '--viewers-every': 'viewersEvery', '--ticks': 'ticks' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--only') {
      options.only = argv[++i];
      if (!['size', 'renders'].includes(options.only)) throw new Error(`--only admite size o renders\n${USAGE}`);
    } else if (Object.hasOwn(numbers, arg)) {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error(`${arg} necesita un entero entre 1 y 10000\n${USAGE}`);
      options[numbers[arg]] = value;
    } else throw new Error(`argumento desconocido: ${arg}\n${USAGE}`);
  }
  return options;
}

async function productionSizes() {
  const dist = await mkdtemp(path.join(tmpdir(), 'antena-perf-size-'));
  try {
    await buildInto(dist);
    return await bundleSizes(path.join(dist, 'assets'));
  } finally { await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

export async function main(argv = process.argv.slice(2), out = process.stdout, err = process.stderr) {
  try {
    const options = parseArgs(argv);
    const report = {};
    if (options.only !== 'size') {
      // Late import: the size report needs neither the server nor Chrome.
      const { runRenderScenario } = await import('../test/render-scenario.mjs');
      report.renders = await runRenderScenario({ messages: options.messages, viewersEvery: options.viewersEvery, ticks: options.ticks });
    }
    if (options.only !== 'renders') report.size = await productionSizes();
    out.write(options.json ? `${JSON.stringify(report, null, 2)}\n`
      : [report.renders && formatRenders(report.renders), report.size && formatSizes(report.size)].filter(Boolean).join('\n'));
    return 0;
  } catch (error) {
    err.write(`${error.message}\n`);
    return 1;
  }
}

// No top-level await: the scenario imports this module back, and awaiting here would deadlock that import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; });
