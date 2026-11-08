#!/usr/bin/env node
// ODD-01: baseline reproducible durable.
// Ejecuta la suite exactamente una vez con reporter TAP y cobertura usando
// spawn (sin shell), y emite un informe JSON estable en stdout. Sin dependencias
// externas: solo builtins de Node >= 24.
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SCHEMA = 'antena.baseline/1';
const MAX_STDERR = 4000;
const MAX_TAP = 5 * 1024 * 1024;
const MAX_LINK_HOPS = 40;

// --- Descubrimiento y comando ------------------------------------------------
export function resolveRepoRoot(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

/** Lista ordenada de test/*.test.mjs (sin helpers ni subdirectorios). */
export function discoverTestFiles(repoRoot) {
  const dir = path.join(repoRoot, 'test');
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.mjs'))
    .map(e => path.posix.join('test', e.name))
    .sort();
}

// #87: Node's default per-test timeout is Infinity, so one hung test used to block the whole run
// (and the CI job) until the suite watchdog. With a default, it fails with its own name; tests
// that set an explicit { timeout } keep their own budget. --test-force-exit ends each file once its
// tests are done even if a leaked handle (timer, socket) would keep the event loop alive.
export const DEFAULT_TEST_TIMEOUT_MS = 300_000;

export function testCommand(files, { coverage = true, timeoutMs = DEFAULT_TEST_TIMEOUT_MS } = {}) {
  return ['--test', '--test-reporter=tap', `--test-timeout=${timeoutMs}`, '--test-force-exit', ...(coverage ? ['--experimental-test-coverage'] : []), ...files];
}

// --- Parser TAP --------------------------------------------------------------
const TEST_RE = /^(ok|not ok) (\d+) - (.*)$/;
const DIRECTIVE_RE = /#\s*(SKIP|TODO)\b\s*(.*)$/i;
const SUMMARY_RE = /^#\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$/;
const PLAN_RE = /^1\.\.(\d+)\s*$/;
const SUMMARY_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

function toNum(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Extrae agregado y ficheros del bloque de cobertura (formato Node 22 y 24). */
export function parseCoverage(lines) {
  const start = lines.findIndex(l => /^#\s*start of coverage report/.test(l));
  if (start === -1) return null;
  const files = [];
  let aggregate = null;
  let folder = null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#\s*end of coverage report/.test(lines[i])) break;
    const row = /^#\s+(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/.exec(lines[i]);
    if (!row) continue;
    const name = row[1].trim();
    const metrics = { lines: toNum(row[2]), branches: toNum(row[3]), functions: toNum(row[4]) };
    if (metrics.lines === null && metrics.branches === null && metrics.functions === null) {
      if (name && name !== 'file' && !/^all files$/i.test(name)) folder = name;
      continue;
    }
    if (/^all files$/i.test(name)) { aggregate = { file: 'all files', ...metrics }; continue; }
    files.push({ file: name.includes('/') ? name : (folder ? `${folder}/${name}` : name), ...metrics });
  }
  return files.length || aggregate ? { available: true, aggregate, files } : null;
}

/** Parsea TAP de node:test. Cuenta desde el resumen completo (autoritativo para
 *  suites anidadas); si falta, deriva de directivas y marca el reporte incompleto. */
export function parseTap(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const tests = [];
  const summary = {};
  let plan = null;
  for (const line of lines) {
    const m = TEST_RE.exec(line);
    if (m) {
      let name = m[3];
      let directive = null;
      let reason = '';
      const d = DIRECTIVE_RE.exec(name);
      if (d) { directive = d[1].toUpperCase(); reason = d[2].trim(); name = name.slice(0, d.index).trim(); }
      tests.push({ number: Number(m[2]), ok: m[1] === 'ok', name, directive, reason });
      continue;
    }
    const s = SUMMARY_RE.exec(line);
    if (s) { summary[s[1]] = Number(s[2]); continue; }
    const p = PLAN_RE.exec(line);
    if (p) plan = Number(p[1]);
  }
  const directiveCounts = { total: tests.length, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  for (const t of tests) {
    if (t.directive === 'SKIP') directiveCounts.skipped++;
    else if (t.directive === 'TODO') directiveCounts.todo++;
    else if (t.ok) directiveCounts.pass++;
    else directiveCounts.fail++;
  }
  const missing = SUMMARY_KEYS.filter(k => !Number.isInteger(summary[k]));
  const hasSummary = missing.length === 0;
  const sum = hasSummary ? summary.pass + summary.fail + summary.cancelled + summary.skipped + summary.todo : null;
  const protocolErrors = [];
  if (plan === null) protocolErrors.push('falta el plan raíz 1..N');
  if (!hasSummary) protocolErrors.push(`falta el resumen de node:test (${missing.join(', ')})`);
  else if (summary.tests !== sum) protocolErrors.push(`resumen inconsistente: # tests ${summary.tests} ≠ pass+fail+cancelled+skipped+todo (${sum})`);
  const counts = hasSummary
    ? { total: summary.tests, pass: summary.pass, fail: summary.fail, skipped: summary.skipped, todo: summary.todo, cancelled: summary.cancelled }
    : directiveCounts;
  return { tests, summary, counts, directiveCounts, plan, complete: protocolErrors.length === 0, protocolErrors, coverage: parseCoverage(lines) };
}

// --- Runner inyectable -------------------------------------------------------
// Limpia el contexto de node:test del proceso padre: un `node --test` anidado
// hereda NODE_TEST_CONTEXT y saldría 0 sin ejecutar nada (false GREEN).
function childEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

export function runSuite({ cwd, execPath = process.execPath, args = [], timeoutMs = 20 * 60_000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let tapBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let timer = null;
    const finish = payload => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ execPath, timeoutMs, durationMs: Date.now() - started, stdout, stderr, timedOut, overflow, ...payload });
    };
    let child;
    try {
      child = spawn(execPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    } catch (err) {
      finish({ exitCode: null, signal: null, error: err.message });
      return;
    }
    child.stdout.on('data', chunk => {
      if (overflow) return;
      tapBytes += chunk.length;
      stdout += chunk;
      if (tapBytes > MAX_TAP) { overflow = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_STDERR) stderr += chunk; });
    child.on('error', err => finish({ exitCode: null, signal: null, error: err.message }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal, error: null }));
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  });
}

// --- Informe -----------------------------------------------------------------
export function readCommit(cwd) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

export function buildReport({ repoRoot, testFiles, command, run, parsed, coverageRequested, gitCommit }) {
  const warnings = [];
  if (run.error) warnings.push(`runner no pudo arrancar: ${run.error}`);
  if (run.timedOut) warnings.push(`runner excedió ${run.timeoutMs} ms y se terminó`);
  if (run.overflow) warnings.push(`la salida TAP superó ${MAX_TAP} bytes; se truncó y se terminó el runner`);
  if (!parsed.complete) warnings.push(`protocolo TAP incompleto: ${parsed.protocolErrors.join('; ')}; no se declara GREEN`);
  if (parsed.complete && parsed.counts.total === 0) warnings.push('la suite no ejecutó ningún test; no se declara GREEN');
  let coverage;
  if (!coverageRequested) {
    coverage = { available: false, reason: 'desactivada con --no-coverage' };
  } else if (parsed.coverage) {
    coverage = parsed.coverage;
  } else {
    coverage = { available: false, reason: 'el runner no emitió cobertura (Node sin --experimental-test-coverage o formato no reconocido)' };
    warnings.push('cobertura solicitada pero ausente; no se inventan porcentajes');
  }
  const skips = parsed.tests.filter(t => t.directive === 'SKIP').map(t => ({ name: t.name, reason: t.reason }));
  if (coverage.available) {
    const browser = coverage.files.filter(f => /^public[\\/]/.test(f.file));
    if (browser.length) warnings.push(`cobertura de navegador presente (no publicada): ${browser.map(f => f.file).join(', ')}`);
    const testsCovered = coverage.files.filter(f => /^(test|helpers)[\\/]/.test(f.file));
    if (testsCovered.length) warnings.push(`la cobertura de este Node incluye ${testsCovered.length} ficheros de test; el agregado es crudo y no comparable entre versiones de Node`);
  }
  const notes = [];
  const chromeSkips = skips.filter(s => /chrome|navegador|browser/i.test(`${s.name} ${s.reason}`));
  if (chromeSkips.length) notes.push({ kind: 'portability-unverified', defer: 'ODD-24', tests: chromeSkips.map(s => s.name) });
  const ok = run.exitCode === 0 && !run.error && !run.timedOut && !run.overflow && parsed.complete && parsed.counts.total > 0 && parsed.counts.fail === 0 && parsed.counts.cancelled === 0;
  return {
    schema: SCHEMA,
    ok,
    generatedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cwd: repoRoot, commit: gitCommit ?? null },
    command,
    runner: {
      execPath: run.execPath,
      exitCode: run.exitCode,
      signal: run.signal,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      stderr: String(run.stderr || '').slice(0, MAX_STDERR),
    },
    tests: { files: testFiles, counts: parsed.counts, durationMs: parsed.summary.duration_ms ?? null, skips },
    coverage,
    warnings,
    notes,
  };
}

// --- CLI ---------------------------------------------------------------------
// No ecoa valores tras '=' ni bytes fuera de ASCII imprimible: el mensaje de
// error no vuelca argumentos crudos (posibles rutas o secretos).
function safeArg(arg) {
  return String(arg).split('=')[0].replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
}

export function parseArgs(argv) {
  const opts = { output: null, tap: null, coverage: true, help: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-coverage') opts.coverage = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--output' || a === '--tap') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) { opts.errors.push(`${a} requiere una ruta`); i--; }
      else if (value === '') opts.errors.push(`${a} requiere una ruta`);
      else opts[a.slice(2)] = value;
    } else if (a.startsWith('--output=')) {
      const value = a.slice('--output='.length);
      if (value) opts.output = value; else opts.errors.push('--output= requiere una ruta');
    } else if (a.startsWith('--tap=')) {
      const value = a.slice('--tap='.length);
      if (value) opts.tap = value; else opts.errors.push('--tap= requiere una ruta');
    } else {
      opts.errors.push(a.startsWith('-') ? `argumento no reconocido: ${safeArg(a)}` : 'argumento posicional no soportado (se esperaban solo flags)');
    }
  }
  return opts;
}

const HELP = `Uso: pnpm baseline [opciones]

Ejecuta la suite una vez (sin shell) con reporter TAP y cobertura, y escribe un
informe JSON en stdout. Códigos de salida estables: 0 = suite completa sin fail,
cancel ni error de protocolo; 1 = fail, cancel, protocolo TAP incompleto, error
de runner/timeout/desbordamiento o flags inválidos.

  --output <ruta>   Guarda además el informe JSON en <ruta> (string).
  --tap <ruta>      Guarda la salida TAP cruda en <ruta> (string).
  --no-coverage     No pide cobertura al runner (booleano).
  -h, --help        Muestra esta ayuda.`;

function humanSummary(report) {
  const c = report.tests.counts;
  const cov = report.coverage.available ? ` · cobertura ${report.coverage.aggregate?.lines ?? '?'} % líneas` : ' · cobertura no disponible';
  return `baseline ${report.ok ? 'OK' : 'FALLO'}: ${c.pass} pass, ${c.fail} fail, ${c.skipped} skipped, ${c.cancelled} cancelled${cov}`;
}

/** Identidad física de dos destinos ya existentes (symlink o hardlink al mismo inodo). */
function sameExistingFile(a, b) {
  try {
    const fa = statSync(a, { bigint: true });
    const fb = statSync(b, { bigint: true });
    return fa.dev === fb.dev && fa.ino === fb.ino;
  } catch {
    return false;
  }
}

// La IO Win32 ordinaria colapsa dots antes de atravesar symlinks; Unix no.
// Excluir namespaces/device, incluso con separadores alternativos: no medidos.
function normalizeOrdinaryWin32Path(target, parent = '') {
  const namespace = /^[\\/]{2}[?.][\\/]/;
  if (process.platform !== 'win32' || namespace.test(target) || namespace.test(parent)) return target;
  const expanded = parent && !path.isAbsolute(target) ? `${parent}${path.sep}${target}` : target;
  return path.normalize(expanded);
}

/** Resuelve con semántica nativa: Unix expande symlinks ANTES de '..'; Win32
 *  ordinario normaliza antes de recorrer, también el readlink relativo al padre.
 *  En Unix, resolve/join del readlink cambiaría su significado. Permite colas
 *  aún ausentes, sin inventar padres para 'ausente/..' en el recorrido físico.
 *  Errores y enlaces cíclicos/no resolubles devuelven null; la E/S fallará después. */
function canonicalDestination(target) {
  const separator = process.platform === 'win32' ? /[\\/]/ : /\//;
  let absolute = target;
  if (!path.isAbsolute(absolute)) {
    // En Windows, C:ruta es relativa al cwd de esa unidad, no al cwd general.
    const drive = process.platform === 'win32' && /^[A-Za-z]:/.test(absolute);
    const parent = drive ? path.resolve(absolute.slice(0, 2)) : process.cwd();
    absolute = `${parent}${path.sep}${drive ? absolute.slice(2) : absolute}`;
  }
  absolute = normalizeOrdinaryWin32Path(absolute);
  let current = path.parse(absolute).root;
  let pending = absolute.slice(current.length).split(separator);
  let hops = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const next = path.join(current, part);
    let entry;
    try { entry = lstatSync(next); }
    catch (err) {
      if (err.code !== 'ENOENT' || pending.includes('..')) return null;
      return path.join(next, ...pending);
    }
    if (entry.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) return null;
      let link;
      try { link = readlinkSync(next); } catch { return null; }
      link = normalizeOrdinaryWin32Path(link, current);
      if (path.isAbsolute(link)) {
        current = path.parse(link).root;
        link = link.slice(current.length);
      }
      pending = [...link.split(separator), ...pending];
    } else {
      if (pending.length && !entry.isDirectory()) return null;
      // `next` contiene solo componentes ya recorridos: realpath recupera el
      // nombre canónico sin colapsar el '..' físico aún pendiente en Unix.
      try { current = realpathSync(next); } catch { return null; }
    }
  }
  return current;
}

/** Compara colas idénticas bajo ancestros físicamente iguales aunque realpath
 *  conserve grafías distintas. Solo recibe rutas ya recorridas por el resolver;
 *  no cambia mayúsculas de componentes ausentes ni reinterpreta enlaces/'..'. */
function sameMissingDestination(a, b) {
  while (path.basename(a) === path.basename(b)) {
    const parentA = path.dirname(a), parentB = path.dirname(b);
    if (parentA === a || parentB === b) return false;
    if (sameExistingFile(parentA, parentB)) return true;
    a = parentA;
    b = parentB;
  }
  return false;
}

/** Colisión física de ficheros existentes (incluidos hardlinks) o de destinos
 *  nuevos bajo padres aliaseados. La igualdad léxica con '..' no es evidencia. */
export function destinationCollision(tap, output) {
  if (!tap || !output) return false;
  if (sameExistingFile(tap, output)) return true;
  const canonTap = canonicalDestination(tap);
  const canonOutput = canonicalDestination(output);
  if (canonTap !== null && canonOutput !== null) {
    return canonTap === canonOutput || sameMissingDestination(canonTap, canonOutput);
  }
  // Mantener el rechazo conservador de rutas léxicamente iguales pero inválidas
  // (p. ej. padre-ausente/../out); nunca sustituye una resolución física válida.
  return path.resolve(tap) === path.resolve(output);
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, repoRoot = resolveRepoRoot(), execPath = process.execPath, runner = runSuite } = {}) {
  const opts = parseArgs(argv);
  if (opts.errors.length) { stderr.write(`baseline: ${opts.errors.join('; ')}\n`); return 1; }
  if (destinationCollision(opts.tap, opts.output)) { stderr.write('baseline: --tap y --output no pueden apuntar al mismo destino\n'); return 1; }
  if (opts.help) { stdout.write(HELP + '\n'); return 0; }
  const testFiles = discoverTestFiles(repoRoot);
  if (!testFiles.length) {
    stderr.write('baseline: no se encontraron test/*.test.mjs\n');
    return 1;
  }
  const args = testCommand(testFiles, { coverage: opts.coverage });
  const run = await runner({ cwd: repoRoot, execPath, args });
  const parsed = parseTap(run.stdout);
  const report = buildReport({ repoRoot, testFiles, command: [execPath, ...args], run, parsed, coverageRequested: opts.coverage, gitCommit: readCommit(repoRoot) });
  const json = JSON.stringify(report, null, 2);
  if (opts.tap) writeFileSync(opts.tap, run.stdout);
  if (opts.output) writeFileSync(opts.output, json + '\n');
  stdout.write(json + '\n');
  stderr.write(humanSummary(report) + '\n');
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => { process.stderr.write(`baseline: error inesperado: ${err?.stack || err}\n`); process.exitCode = 1; });
}
