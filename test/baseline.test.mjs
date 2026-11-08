// ODD-01: contrato del runner de baseline. Prueba primero el parser TAP y el
// arranque inyectable; el runner real (scripts/baseline.mjs) es nuevo, así que
// estos casos parten en RED (módulo ausente) y pasan a GREEN al implementarlo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, lstat, symlink, link, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseTap, parseCoverage, buildReport, discoverTestFiles, testCommand, runSuite, main, parseArgs, destinationCollision,
} from '../scripts/baseline.mjs';

// Modelo de FS case-insensitive aislado: solo traduce el padre aliasado;
// lstat/stat consultan el directorio físico; realpath conserva la grafía
// recibida del padre aliasado. La identidad no puede depender del texto de la ruta.
test('destinationCollision canonicaliza padres con alias de mayúsculas (modelo FS)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-case-alias-'));
  const real = path.join(root, 'Results');
  const alias = path.join(root, 'results');
  const other = path.join(root, 'Other');
  try {
    await mkdir(real);
    await mkdir(other);
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import assert from 'node:assert/strict';
      import { syncBuiltinESMExports } from 'node:module';
      const real = ${JSON.stringify(real)}, alias = ${JSON.stringify(alias)}, other = ${JSON.stringify(other)};
      const physical = p => typeof p === 'string' && (p === alias || p.startsWith(alias + path.sep))
        ? real + p.slice(alias.length) : p;
      for (const name of ['lstatSync', 'statSync']) {
        const original = fs[name];
        fs[name] = (p, ...args) => original(physical(p), ...args);
      }
      const realpath = fs.realpathSync;
      fs.realpathSync = (p, ...args) => {
        const canonical = realpath(physical(p), ...args);
        return typeof p === 'string' && (p === alias || p.startsWith(alias + path.sep))
          ? alias + canonical.slice(real.length) : canonical;
      };
      syncBuiltinESMExports();
      assert.equal(fs.statSync(alias).ino, fs.statSync(real).ino);
      assert.notEqual(fs.statSync(other).ino, fs.statSync(real).ino);
      assert.notEqual(fs.realpathSync(alias), fs.realpathSync(real));
      const { destinationCollision } = await import(${JSON.stringify(new URL('../scripts/baseline.mjs', import.meta.url).href)});
      for (const tail of ['out.json', path.join('missing', 'out.json'), path.join('missing', 'deep', 'out.json')]) {
        const a = path.join(real, tail), b = path.join(alias, tail);
        assert.equal(fs.existsSync(a), false);
        assert.equal(destinationCollision(a, b), true, 'mismo destino ausente');
        assert.equal(destinationCollision(b, a), true, 'orden inverso');
        assert.equal(destinationCollision(a, path.join(alias, 'other.json')), false);
        assert.equal(destinationCollision(a, path.join(other, tail)), false, 'padres físicos distintos');
        assert.equal(destinationCollision(a, path.join(alias, tail.toUpperCase())), false, 'cola ausente no casefold');
      }
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.signal, null);
    assert.equal(run.status, 0, run.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('destinationCollision respeta la sensibilidad real del FS del fixture', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-case-native-'));
  const real = path.join(root, 'Results'), alias = path.join(root, 'results');
  try {
    await mkdir(real);
    let same = false;
    try { same = (await stat(alias)).ino === (await stat(real)).ino; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    assert.equal(destinationCollision(path.join(real, 'out.json'), path.join(alias, 'out.json')), same);
    assert.equal(destinationCollision(path.join(real, 'out.json'), path.join(real, 'OUT.json')), false,
      'colas ausentes no se convierten indiscriminadamente a minúsculas');
  } finally { await rm(root, { recursive: true, force: true }); }
});

const TAP_FAIL = `TAP version 13
ok 1 - uno
not ok 2 - dos
ok 3 - tres # SKIP sin navegador
ok 4 - cuatro # TODO pendiente
1..4
# tests 4
# suites 0
# pass 1
# fail 1
# cancelled 0
# skipped 1
# todo 1
# duration_ms 12.5
`;

const COVERAGE_NODE24 = `# start of coverage report
# ------------------------------------------------------------------------------------------
# file             | line % | branch % | funcs % | uncovered lines
# ------------------------------------------------------------------------------------------
# src              |        |          |         | 
#  bus.mjs         | 100.00 |    88.89 |  100.00 | 
#  store.mjs       |  97.60 |    76.47 |   86.67 | 113-115
# ------------------------------------------------------------------------------------------
# all files        |  81.22 |    75.54 |   58.47 | 
# ------------------------------------------------------------------------------------------
# end of coverage report
`;

const COVERAGE_NODE22 = `# start of coverage report
# ------------------------------------------------------------------------------------------
# file                  | line % | branch % | funcs % | uncovered lines
# ------------------------------------------------------------------------------------------
# src/bus.mjs           | 100.00 |    88.89 |  100.00 | 
# src/store.mjs         |  97.60 |    76.47 |   86.67 | 113-115
# ------------------------------------------------------------------------------------------
# all files             |  81.22 |    75.54 |   58.47 | 
# ------------------------------------------------------------------------------------------
# end of coverage report
`;

const EMPTY_RUN = { execPath: 'node', exitCode: 0, signal: null, durationMs: 1, timedOut: false, error: null, stderr: '', overflow: false };
const BASE = { repoRoot: '/repo', testFiles: ['test/a.test.mjs'], command: ['node', 'x'], gitCommit: null };

// TAP completo con el resumen que emite node:test: plan raíz + contadores consistentes.
function completeTap(lines, { tests, pass, fail = 0, cancelled = 0, skipped = 0, todo = 0, suites = 0, plan = tests } = {}) {
  return ['TAP version 13', ...lines, `1..${plan}`, `# tests ${tests}`, `# suites ${suites}`, `# pass ${pass}`, `# fail ${fail}`, `# cancelled ${cancelled}`, `# skipped ${skipped}`, `# todo ${todo}`, '# duration_ms 1', ''].join('\n');
}

const TAP_ALLSKIP = completeTap(['ok 1 - uno # SKIP a', 'ok 2 - dos # SKIP b'], { tests: 2, pass: 0, skipped: 2 });
const TAP_CANCELLED = completeTap(['not ok 1 - c'], { tests: 1, pass: 0, cancelled: 1 });
const TAP_TRUNCATED = 'TAP version 13\nok 1 - uno\n';
const TAP_PLAN_ONLY = 'TAP version 13\nok 1 - uno\n1..1\n';
const TAP_GARBAGE = 'esto no es TAP\n';

test('parseTap valida el resumen completo de node:test y conserva los skips', () => {
  const p = parseTap(TAP_FAIL);
  assert.equal(p.complete, true);
  assert.deepEqual(p.counts, { total: 4, pass: 1, fail: 1, skipped: 1, todo: 1, cancelled: 0 });
  assert.equal(p.summary.duration_ms, 12.5);
  assert.deepEqual(
    p.tests.filter(t => t.directive === 'SKIP').map(t => [t.name, t.reason]),
    [['tres', 'sin navegador']],
  );
});

test('parseTap sin resumen deriva conteos pero marca el reporte incompleto', () => {
  const p = parseTap('ok 1 - uno\nnot ok 2 - dos\n');
  assert.equal(p.counts.total, 2);
  assert.equal(p.counts.pass, 1);
  assert.equal(p.counts.fail, 1);
  assert.equal(p.coverage, null);
  assert.equal(p.complete, false);
  assert.match(p.protocolErrors.join(' '), /plan|resumen/);
});

test('parseTap toma cancelled del resumen completo', () => {
  const p = parseTap(TAP_CANCELLED);
  assert.equal(p.complete, true);
  assert.equal(p.counts.cancelled, 1);
  assert.equal(p.counts.pass, 0);
});

test('parseCoverage reconoce tabla agrupada por carpeta (Node 24)', () => {
  const cov = parseCoverage(COVERAGE_NODE24.split('\n'));
  assert.equal(cov.aggregate.lines, 81.22);
  assert.equal(cov.aggregate.branches, 75.54);
  assert.deepEqual(cov.files.map(f => f.file), ['src/bus.mjs', 'src/store.mjs']);
  assert.equal(cov.files[0].functions, 100);
});

test('parseCoverage reconoce tabla con rutas completas (Node 22)', () => {
  const cov = parseCoverage(COVERAGE_NODE22.split('\n'));
  assert.deepEqual(cov.files.map(f => f.file), ['src/bus.mjs', 'src/store.mjs']);
  assert.equal(cov.aggregate.functions, 58.47);
});

test('parseTap integra cobertura y resumen en un solo modelo', () => {
  const p = parseTap(TAP_FAIL + COVERAGE_NODE24);
  assert.equal(p.counts.fail, 1);
  assert.equal(p.coverage.aggregate.lines, 81.22);
});

test('buildReport no marca GREEN con fail, cancel o error de runner', () => {
  const fail = buildReport({ ...BASE, coverageRequested: true, run: EMPTY_RUN, parsed: parseTap(TAP_FAIL) });
  assert.equal(fail.ok, false);
  assert.equal(fail.coverage.available, false);
  assert.match(fail.warnings.join(' '), /cobertura solicitada pero ausente/);

  const cancelled = buildReport({ ...BASE, coverageRequested: false, run: EMPTY_RUN, parsed: parseTap(TAP_CANCELLED) });
  assert.equal(cancelled.ok, false);

  const errored = buildReport({ ...BASE, coverageRequested: false, run: { ...EMPTY_RUN, exitCode: null, error: 'spawn ENOENT' }, parsed: parseTap(completeTap(['ok 1 - uno'], { tests: 1, pass: 1 })) });
  assert.equal(errored.ok, false);
  assert.match(errored.warnings.join(' '), /runner no pudo arrancar/);
});

test('buildReport rechaza como no-GREEN TAP vacío, basura o sin resumen terminal', () => {
  for (const [name, raw] of [['vacío', ''], ['basura', TAP_GARBAGE], ['truncado', TAP_TRUNCATED], ['solo plan', TAP_PLAN_ONLY]]) {
    const report = buildReport({ ...BASE, coverageRequested: true, run: EMPTY_RUN, parsed: parseTap(raw) });
    assert.equal(report.ok, false, `${name} no debe declararse GREEN`);
    assert.match(report.warnings.join(' '), /protocolo TAP incompleto/, `${name} debe avisar del protocolo`);
  }
});

test('buildReport rechaza un resumen inconsistente aunque haya tests', () => {
  const inconsistent = 'TAP version 13\nok 1 - uno\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  const report = buildReport({ ...BASE, coverageRequested: false, run: EMPTY_RUN, parsed: parseTap(inconsistent) });
  assert.equal(report.ok, false);
  assert.match(report.warnings.join(' '), /inconsistente/);
});

test('buildReport exige al menos un test ejecutado, pero no exige pass>0', () => {
  const zero = parseTap(completeTap([], { tests: 0, pass: 0, plan: 0 }));
  assert.equal(zero.complete, true, 'el TAP 1..0 es formalmente completo');
  const zeroReport = buildReport({ ...BASE, coverageRequested: true, run: EMPTY_RUN, parsed: zero });
  assert.equal(zeroReport.ok, false, 'sin tests ejecutados no puede declararse GREEN');
  assert.match(zeroReport.warnings.join(' '), /no ejecutó ningún test/);

  const skipReport = buildReport({ ...BASE, coverageRequested: false, run: EMPTY_RUN, parsed: parseTap(TAP_ALLSKIP) });
  assert.equal(skipReport.ok, true, 'all-skip con tests>0 sigue siendo GREEN');
  assert.equal(skipReport.tests.counts.total, 2);
});

test('controles válidos: all-skip es GREEN, cancelled y failed no lo son', () => {
  const skip = buildReport({ ...BASE, coverageRequested: true, run: EMPTY_RUN, parsed: parseTap(TAP_ALLSKIP) });
  assert.equal(skip.ok, true);
  assert.equal(skip.tests.counts.skipped, 2);
  assert.equal(skip.tests.counts.pass, 0);
  assert.equal(skip.coverage.available, false);

  const cancelled = buildReport({ ...BASE, coverageRequested: false, run: EMPTY_RUN, parsed: parseTap(TAP_CANCELLED) });
  assert.equal(cancelled.ok, false);

  const failed = buildReport({ ...BASE, coverageRequested: false, run: EMPTY_RUN, parsed: parseTap(TAP_FAIL) });
  assert.equal(failed.ok, false);
});

test('buildReport marca GREEN con un reporte completo y registra el skip crítico de Chrome', () => {
  const p = parseTap(completeTap(['ok 1 - uno', 'ok 2 - prompter Chrome # SKIP sin Chrome local'], { tests: 2, pass: 1, skipped: 1 }));
  const report = buildReport({ ...BASE, coverageRequested: false, run: EMPTY_RUN, parsed: p });
  assert.equal(report.ok, true);
  assert.equal(report.coverage.available, false);
  assert.equal(report.tests.skips.length, 1);
  assert.equal(report.notes[0].defer, 'ODD-24');
  assert.equal(report.environment.commit, null);
});

test('buildReport advierte si la cobertura incluye public/ (navegador)', () => {
  const tap = completeTap(['ok 1 - uno'], { tests: 1, pass: 1 }) + COVERAGE_NODE24.replace('src', 'public');
  const report = buildReport({ ...BASE, coverageRequested: true, run: EMPTY_RUN, parsed: parseTap(tap) });
  assert.deepEqual(report.coverage.files.map(f => f.file), ['public/bus.mjs', 'public/store.mjs']);
  assert.match(report.warnings.join(' '), /cobertura de navegador/);
  assert.equal(report.ok, true);
});

test('parseTap usa el resumen real de Node con suites anidadas', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-nested-'));
  try {
    await writeFile(path.join(root, 'nested.test.mjs'), "import { test, describe } from 'node:test';\ndescribe('grupo', () => { test('a', () => {}); test('b', () => {}); });\ntest('padre', async t => { await t.test('hijo', () => {}); });\n");
    const run = await runSuite({ cwd: root, execPath: process.execPath, args: ['--test', '--test-reporter=tap', 'nested.test.mjs'] });
    assert.equal(run.exitCode, 0);
    const p = parseTap(run.stdout);
    assert.equal(p.complete, true);
    assert.deepEqual(
      { total: p.counts.total, pass: p.counts.pass, suites: p.summary.suites },
      { total: 4, pass: 4, suites: 1 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseTap no cuenta el padre como fallo hoja en una suite anidada real', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-nestedfail-'));
  try {
    await writeFile(path.join(root, 'nestedfail.test.mjs'), "import { test, describe } from 'node:test';\ndescribe('grupo', () => { test('pasa', () => {}); test('falla', () => { throw new Error('boom'); }); });\n");
    const run = await runSuite({ cwd: root, execPath: process.execPath, args: ['--test', '--test-reporter=tap', 'nestedfail.test.mjs'] });
    assert.equal(run.exitCode, 1);
    const p = parseTap(run.stdout);
    assert.equal(p.complete, true);
    assert.equal(p.counts.total, 2);
    assert.equal(p.counts.pass, 1);
    assert.equal(p.counts.fail, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main rechaza --output/--tap sin valor', async () => {
  for (const flag of ['--output', '--tap', '--output=', '--tap=']) {
    const err = [];
    const code = await main([flag], { repoRoot: '/repo-inexistente', stdout: { write: () => {} }, stderr: { write: s => err.push(s) } });
    assert.equal(code, 1, `${flag} debe fallar`);
    assert.match(err.join(' '), /requiere una ruta/);
  }
});

test('parseArgs rechaza rutas vacías en ambas formas sin perder flags posteriores', () => {
  for (const flag of ['--output', '--tap']) {
    for (const argv of [[flag, '', '--no-coverage'], [`${flag}=`, '--no-coverage']]) {
      const opts = parseArgs(argv);
      assert.equal(opts.errors.length, 1, 'la ruta vacía debe producir un único error');
      assert.match(opts.errors[0], /requiere una ruta/);
      assert.equal(opts[flag.slice(2)], null);
      assert.equal(opts.coverage, false, 'el siguiente flag debe conservarse');
    }
    for (const argv of [[flag, ' ruta con espacios '], [`${flag}= ruta con espacios `]]) {
      const opts = parseArgs(argv);
      assert.deepEqual(opts.errors, []);
      assert.equal(opts[flag.slice(2)], ' ruta con espacios ', 'no debe recortar rutas válidas');
    }
  }
});

test('main rechaza rutas vacías antes de ejecutar un runner que devolvería GREEN', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-empty-main-'));
  try {
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'test', 'probe.test.mjs'), '');
    for (const flag of ['--output', '--tap']) {
      for (const argv of [[flag, ''], [`${flag}=`]]) {
        let calls = 0;
        const out = [];
        const err = [];
        const runner = async () => {
          calls++;
          return { ...EMPTY_RUN, stdout: completeTap(['ok 1 - probe'], { tests: 1, pass: 1 }) };
        };
        const code = await main(argv, {
          repoRoot: root, runner,
          stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) },
        });
        assert.equal(code, 1, 'una ruta vacía no debe declarar éxito');
        assert.equal(calls, 0, 'no debe ejecutar el runner');
        assert.equal(out.join(''), '', 'no debe publicar un informe GREEN');
        assert.match(err.join(''), /requiere una ruta/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rechaza rutas vacías sin ejecutar la suite ni escribir el otro artefacto', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-empty-cli-'));
  try {
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'scripts'));
    const cli = path.join(root, 'scripts', 'baseline.mjs');
    const marker = path.join(root, 'probe-ran.txt');
    const sentinel = path.join(root, 'private-destination.json');
    await writeFile(cli, await readFile(new URL('../scripts/baseline.mjs', import.meta.url)));
    await writeFile(sentinel, 'SENTINEL');
    await writeFile(path.join(root, 'test', 'probe.test.mjs'),
      `import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('probe', () => writeFileSync(${JSON.stringify(marker)}, 'RAN'));\n`);
    for (const flag of ['--output', '--tap']) {
      const other = flag === '--output' ? '--tap' : '--output';
      for (const empty of [[flag, ''], [`${flag}=`]]) {
        const r = spawnSync(process.execPath, [cli, ...empty, other, sentinel, '--no-coverage'], {
          cwd: root, encoding: 'utf8', timeout: 10_000,
        });
        assert.equal(r.error, undefined, 'el CLI debe terminar sin timeout ni error de spawn');
        assert.equal(r.signal, null);
        assert.equal(r.status, 1);
        assert.equal(r.stdout, '');
        assert.match(r.stderr, /requiere una ruta/);
        assert.doesNotMatch(r.stderr, /private-destination|egdev-baseline-empty-cli/, 'sin filtrar rutas');
        await assert.rejects(readFile(marker), /ENOENT/, 'la suite no debe ejecutarse');
        assert.equal(await readFile(sentinel, 'utf8'), 'SENTINEL');
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseArgs rechaza opciones desconocidas y argumentos posicionales', () => {
  assert.equal(parseArgs(['--outpt', 'foo']).errors.length, 2);
  assert.match(parseArgs(['--outputx=foo']).errors[0], /no reconocido/);
  assert.match(parseArgs(['--']).errors[0], /no reconocido/);
  assert.match(parseArgs(['fichero.mjs']).errors[0], /posicional/);
  assert.equal(parseArgs(['--output', '/tmp/x', '--no-coverage']).errors.length, 0);
  assert.equal(parseArgs(['--help']).errors.length, 0);
});

test('main aborta antes del runner y sin artefacto con args desconocidos', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-args-'));
  let calls = 0;
  const runner = async () => { calls++; return { execPath: 'node', exitCode: 0, signal: null, durationMs: 0, timedOut: false, overflow: false, error: null, stderr: '', stdout: '' }; };
  try {
    const outPath = path.join(root, 'blocked.json');
    const err = [];
    const code = await main(['--outpt', outPath], { repoRoot: root, execPath: process.execPath, runner, stdout: { write: () => {} }, stderr: { write: s => err.push(s) } });
    assert.equal(code, 1);
    assert.equal(calls, 0, 'no debe lanzar el runner');
    assert.match(err.join(' '), /no reconocido/);
    await assert.rejects(readFile(outPath), /ENOENT/);

    const helpErr = [];
    const helpCode = await main(['--help', '--bogus'], { repoRoot: root, runner, stdout: { write: () => {} }, stderr: { write: s => helpErr.push(s) } });
    assert.equal(helpCode, 1, 'help con args inválidos también falla');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main rechaza --tap y --output al mismo destino antes del runner y sin escribir', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-collide-'));
  let calls = 0;
  const runner = async () => { calls++; return { ...EMPTY_RUN, stdout: '' }; };
  try {
    const sentinel = path.join(root, 'out.json');
    await writeFile(sentinel, 'SENTINEL');
    const cases = [
      ['--tap', sentinel, '--output', sentinel],
      ['--output', sentinel, '--tap', sentinel],
      ['--tap', `${root}/sub/../out.json`, '--output', sentinel],
      ['--tap', path.relative(process.cwd(), sentinel), '--output', sentinel],
    ];
    for (const argv of cases) {
      const out = [];
      const err = [];
      const code = await main(argv, { repoRoot: root, execPath: process.execPath, runner, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) } });
      assert.equal(code, 1, `debe fallar: ${argv.join(' ')}`);
      assert.equal(out.length, 0, 'sin JSON en stdout');
      assert.match(err.join(' '), /mismo destino/);
      assert.doesNotMatch(err.join(' '), /out\.json/, 'no filtra rutas');
      assert.equal(await readFile(sentinel, 'utf8'), 'SENTINEL', 'preserva el fichero preexistente');
    }
    assert.equal(calls, 0, 'no debe lanzar el runner');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Fixture CLI aislado: copia binaria-idéntica de scripts/baseline.mjs dentro de
// <root>/scripts para que resolveRepoRoot() apunte al fixture y el runner
// descubra solo test/probe.test.mjs (nunca la suite completa del repo).
async function aliasFixture(kind) {
  const root = await mkdtemp(path.join(tmpdir(), `egdev-alias-${kind}-`));
  const fx = {
    root,
    target: path.join(root, 'sentinel.json'),
    alias: path.join(root, kind === 'symlink' ? 'alias.tap' : 'hard.tap'),
    marker: path.join(root, 'probe-ran.txt'),
  };
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts', 'baseline.mjs'), await readFile(new URL('../scripts/baseline.mjs', import.meta.url)));
  await writeFile(path.join(root, 'test', 'probe.test.mjs'), `import { test } from 'node:test';\nimport { writeFile } from 'node:fs/promises';\ntest('probe', async () => { await writeFile(${JSON.stringify(fx.marker)}, 'FROM_PROBE'); });\n`);
  await writeFile(fx.target, 'SENTINEL');
  try {
    if (kind === 'symlink') await symlink(fx.target, fx.alias, 'file');
    else await link(fx.target, fx.alias);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'ENOTSUP') fx.unsupported = err.code;
    else throw err;
  }
  return fx;
}

// Fixture para alias de directorio padre: <root>/link -> <root>/real. El fichero
// destino todavía no existe, así que stat() no revela la colisión; solo resolver
// el ancestro existente la detecta. `tail` permite añadir componentes ausentes.
async function parentAliasFixture(tail) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-parent-alias-'));
  const fx = {
    root,
    real: path.join(root, 'real'),
    link: path.join(root, 'link'),
    target: path.join(root, 'real', tail),
    alias: path.join(root, 'link', tail),
    marker: path.join(root, 'probe-ran.txt'),
  };
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(fx.real);
  await writeFile(path.join(root, 'scripts', 'baseline.mjs'), await readFile(new URL('../scripts/baseline.mjs', import.meta.url)));
  await writeFile(path.join(root, 'test', 'probe.test.mjs'), `import { test } from 'node:test';\nimport { writeFile } from 'node:fs/promises';\ntest('probe', async () => { await writeFile(${JSON.stringify(fx.marker)}, 'FROM_PROBE'); });\n`);
  try {
    await symlink(fx.real, fx.link, 'dir');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'ENOTSUP') fx.unsupported = err.code;
    else throw err;
  }
  return fx;
}

// Fixture para symlink colgante: el enlace apunta a un destino que todavía no
// existe, así que stat()/realpathSync() fallan con ENOENT y solo siguiendo el
// enlace se ve que --tap y --output acaban en el mismo fichero. `absolute` decide
// si el symlink guarda una ruta absoluta en vez de relativa.
async function danglingSymlinkFixture({ targetRel, absolute = false }) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-dangling-alias-'));
  const fx = { root, target: path.join(root, targetRel), link: path.join(root, 'alias.tap'), marker: path.join(root, 'probe-ran.txt') };
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts', 'baseline.mjs'), await readFile(new URL('../scripts/baseline.mjs', import.meta.url)));
  await writeFile(path.join(root, 'test', 'probe.test.mjs'), `import { test } from 'node:test';\nimport { writeFile } from 'node:fs/promises';\ntest('probe', async () => { await writeFile(${JSON.stringify(fx.marker)}, 'FROM_PROBE'); });\n`);
  const linkTarget = absolute ? fx.target : targetRel;
  try {
    await symlink(linkTarget, fx.link, 'file');
    fx.expectLinkTarget = linkTarget;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'ENOTSUP') fx.unsupported = err.code;
    else throw err;
  }
  return fx;
}

test('main rechaza destinos aliaseados por symlink o hardlink antes del runner', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    await t.test(kind, async t => {
      const fx = await aliasFixture(kind);
      try {
        if (fx.unsupported) { t.skip(`alias ${kind} no soportado en esta plataforma (${fx.unsupported})`); return; }
        const target = await stat(fx.target);
        const alias = await stat(fx.alias);
        assert.deepEqual([alias.dev, alias.ino], [target.dev, target.ino], 'el fixture debe compartir el mismo inodo');
        const cli = path.join(fx.root, 'scripts', 'baseline.mjs');
        const r = spawnSync(process.execPath, [cli, '--tap', fx.alias, '--output', fx.target, '--no-coverage'], { cwd: fx.root, encoding: 'utf8', timeout: 10_000 });
        assert.equal(r.status, 1, 'debe rechazar el alias con exit 1 antes de la suite');
        assert.equal(r.stdout, '', 'sin informe JSON en stdout');
        assert.equal(await readFile(fx.target, 'utf8'), 'SENTINEL', 'preserva el contenido preexistente');
        assert.equal(await readFile(fx.alias, 'utf8'), 'SENTINEL', 'el alias conserva el mismo contenido');
        assert.doesNotMatch(r.stderr, /alias\.tap|hard\.tap|sentinel\.json/, 'stderr genérico sin rutas');
        await assert.rejects(readFile(fx.marker), /ENOENT/, 'el runner no debe ejecutarse');
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    });
  }
});

test('main rechaza un destino nuevo bajo un padre aliaseado antes del runner', async t => {
  for (const [kind, tail] of [['directo', 'new.json'], ['anidado', path.join('one', 'two', 'new.json')]]) {
    await t.test(kind, async t => {
      const fx = await parentAliasFixture(tail);
      try {
        if (fx.unsupported) { t.skip(`symlink de directorio no soportado en esta plataforma (${fx.unsupported})`); return; }
        // El destino físico parte ausente: stat() no puede detectar la colisión.
        await assert.rejects(stat(fx.target), /ENOENT/, 'el destino físico parte ausente');
        await assert.rejects(stat(fx.alias), /ENOENT/, 'el alias parte ausente');
        const cli = path.join(fx.root, 'scripts', 'baseline.mjs');
        const r = spawnSync(process.execPath, [cli, '--tap', fx.alias, '--output', fx.target, '--no-coverage'], { cwd: fx.root, encoding: 'utf8', timeout: 10_000 });
        assert.equal(r.status, 1, 'debe rechazar la colisión con exit 1 antes de la suite');
        assert.equal(r.stdout, '', 'sin informe JSON en stdout');
        await assert.rejects(readFile(fx.marker), /ENOENT/, 'el runner no debe ejecutarse');
        assert.doesNotMatch(r.stderr, /new\.json/, 'stderr genérico sin filtrar rutas');
        await assert.rejects(stat(fx.target), /ENOENT/, 'no debe crear el destino físico');
        await assert.rejects(stat(fx.alias), /ENOENT/, 'no debe crear el destino vía alias');
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    });
  }
});

// Defecto: un symlink colgante cuyo destino coincide con el otro artefacto no se
// detecta (statSync/realpathSync dan ENOENT y el canónico del enlace acaba siendo
// su propio nombre), así que el CLI lanza la suite, escribe TAP siguiendo el
// enlace y luego pisa el JSON; debe abortar con exit 1 antes del runner.
test('main rechaza un symlink colgante que resuelve al otro artefacto antes del runner', async t => {
  const cases = [
    ['TAP symlink, destino relativo', { targetRel: 'out.json' }, fx => ['--tap', fx.link, '--output', fx.target, '--no-coverage']],
    ['JSON symlink, destino absoluto', { targetRel: 'out.json', absolute: true }, fx => ['--output', fx.link, '--tap', fx.target, '--no-coverage']],
    ['symlink colgante con padre de destino ausente', { targetRel: path.join('sub', 'out.json') }, fx => ['--tap', fx.link, '--output', fx.target, '--no-coverage']],
  ];
  for (const [name, spec, argv] of cases) {
    await t.test(name, async t => {
      const fx = await danglingSymlinkFixture(spec);
      try {
        if (fx.unsupported) { t.skip(`symlink no soportado en esta plataforma (${fx.unsupported})`); return; }
        await assert.rejects(stat(fx.target), /ENOENT/, 'el destino físico parte ausente');
        await assert.rejects(stat(fx.link), /ENOENT/, 'el symlink parte colgante');
        const cli = path.join(fx.root, 'scripts', 'baseline.mjs');
        const r = spawnSync(process.execPath, [cli, ...argv(fx)], { cwd: fx.root, encoding: 'utf8', timeout: 10_000 });
        assert.equal(r.status, 1, 'debe rechazar el solapamiento con exit 1 antes de la suite');
        assert.equal(r.stdout, '', 'sin informe JSON en stdout');
        await assert.rejects(readFile(fx.marker), /ENOENT/, 'el runner no debe ejecutarse');
        assert.match(r.stderr, /destino/, 'error genérico de destino');
        assert.doesNotMatch(r.stderr, /out\.json|alias\.tap/, 'stderr sin rutas del fixture');
        await assert.rejects(stat(fx.target), /ENOENT/, 'no debe crear el fichero destino');
        const link = await lstat(fx.link);
        assert.equal(link.isSymbolicLink(), true, 'el enlace debe seguir existiendo como symlink');
        assert.equal(await readlink(fx.link), fx.expectLinkTarget, 'el enlace no se muta (sin unlink)');
      } finally {
        await rm(fx.root, { recursive: true, force: true });
      }
    });
  }
});

// Modelo de la IO Win32 medida en run 38644974828 (Node 22.23.3/24.21.0):
// bridge -> foreign/child; el alias relativo conserva '..', el absoluto no.
// Solo la copia del módulo cambia fs/path/platform/cwd; nunca process global.
test('destinationCollision sigue la IO Win32 de symlink y dotdot (modelo aislado)', async t => {
  const root = 'C:\\fixture', win = path.win32;
  const original = await readFile(new URL('../scripts/baseline.mjs', import.meta.url), 'utf8');
  const fsImport = "import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';";
  assert.ok(original.includes(fsImport));
  assert.ok(original.includes("import path from 'node:path';"));
  const end = original.indexOf('\nconst isMain =');
  assert.ok(end > 0, 'copia sin entrypoint CLI');
  for (const existing of [false, true]) {
    await t.test(existing ? 'destino existente' : 'destino ausente', async t => {
      const modelFs = `
        const root = ${JSON.stringify(root)};
        const links = new Map([
          [path.join(root, 'bridge'), path.join(root, 'foreign', 'child')],
          [path.join(root, 'relative.tap'), ${JSON.stringify('bridge\\..\\out.json')}],
          [path.join(root, 'absolute.tap'), path.join(root, 'out.json')],
        ]);
        const directories = new Map([
          [${JSON.stringify(win.parse(root).root)}, 1n], [root, 2n],
          [path.join(root, 'foreign'), 3n], [path.join(root, 'foreign', 'child'), 4n],
        ]);
        const missing = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
        const physical = p => {
          p = path.resolve(root, p); // IO Win32 normaliza también entradas relativas.
          const stored = links.get(p);
          return stored ? path.resolve(path.dirname(p), stored) : p;
        };
        const entry = (p, follow) => {
          p = follow ? physical(p) : path.resolve(root, p);
          const link = !follow && links.has(p), dir = directories.has(p);
          const file = ${existing} && p === path.join(root, 'out.json');
          if (!link && !dir && !file) return missing();
          return { dev: 1n, ino: directories.get(p) ?? (file ? 5n : 6n),
            isSymbolicLink: () => link, isDirectory: () => dir };
        };
        const lstatSync = p => entry(p, false), statSync = p => entry(p, true);
        const readlinkSync = p => links.get(path.resolve(root, p)) ?? missing();
        const realpathSync = p => { entry(p, true); return physical(p); };
        const readdirSync = missing, writeFileSync = missing;
      `;
      const source = original.slice(0, end).replace(fsImport, modelFs)
        .replace("import path from 'node:path';", "import { win32 as path } from 'node:path';")
        .replaceAll('process.platform', "'win32'")
        .replaceAll('process.cwd()', JSON.stringify(root));
      const { destinationCollision: collision } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
      const candidates = [win.join(root, 'out.json'), win.join(root, 'foreign', 'out.json')];
      for (const [name, target] of [
        ['alias relativo', win.join(root, 'relative.tap')],
        ['directo relativo', 'bridge\\..\\out.json'],
        ['directo absoluto', `${root}\\bridge\\..\\out.json`],
        ['alias absoluto normalizado (control)', win.join(root, 'absolute.tap')],
      ]) {
        await t.test(name, () => {
          const actual = [candidates.map(p => collision(target, p)), candidates.map(p => collision(p, target))];
          assert.deepEqual(actual, [[true, false], [true, false]], 'IO Win32: root sí, foreign no, ambos órdenes');
        });
      }
    });
  }
});

// Mantener el texto con '..' hasta medir IO nativa: Unix sigue el symlink antes
// de subir; Win32 normaliza primero. No usar el detector como oráculo.
async function dotdotFixture(absolute) {
  const fx = await danglingSymlinkFixture({ targetRel: 'bridge/../out.json' });
  if (fx.unsupported) return fx;
  await mkdir(path.join(fx.root, 'foreign', 'child'), { recursive: true });
  await symlink(path.join(fx.root, 'foreign', 'child'), path.join(fx.root, 'bridge'), 'dir');
  fx.direct = `${fx.root}/bridge/../out.json`;
  if (absolute) {
    await rm(fx.link);
    await symlink(fx.direct, fx.link, 'file');
  }
  fx.expectLinkTarget = await readlink(fx.link); // Texto realmente almacenado por Node/OS.
  const candidates = [path.join(fx.root, 'out.json'), path.join(fx.root, 'foreign', 'out.json')];
  async function measure(via) {
    await Promise.all(candidates.map(file => assert.rejects(stat(file), /ENOENT/)));
    await writeFile(via, 'ORACLE');
    const after = await Promise.all(candidates.map(async file => {
      try { return await readFile(file, 'utf8'); }
      catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    }));
    const matches = after.flatMap((value, i) => value === 'ORACLE' ? [i] : []);
    for (const i of matches) await rm(candidates[i]);
    assert.equal(matches.length, 1, 'IO nativa alcanza exactamente un candidato');
    const winner = matches[0], loser = 1 - winner;
    assert.equal(after[loser], null, 'el otro candidato sigue ausente');
    assert.equal(winner, process.platform === 'win32' ? 0 : 1,
      'ganador físico medido: Windows root/out; Unix foreign/out');
    return { physical: candidates[winner], distinct: candidates[loser] };
  }
  Object.assign(fx, await measure(fx.link));
  const direct = await measure(fx.direct); // Medición independiente del alias.
  fx.directPhysical = direct.physical;
  fx.directDistinct = direct.distinct;
  return fx;
}

test('destinationCollision respeta symlink seguido de dotdot sin inventar ni omitir colisiones', async t => {
  for (const absolute of [false, true]) {
    await t.test(absolute ? 'absoluto' : 'relativo', async t => {
      const fx = await dotdotFixture(absolute);
      try {
        if (fx.unsupported) { t.skip(`symlink no soportado (${fx.unsupported})`); return; }
        for (const [via, physical, distinct] of [
          [fx.link, fx.physical, fx.distinct], [fx.direct, fx.directPhysical, fx.directDistinct],
        ]) {
          for (const existing of [false, true]) {
            if (existing) await writeFile(physical, 'SENTINEL');
            for (const [a, b] of [[via, physical], [physical, via]]) {
              assert.equal(destinationCollision(a, b), true, `colisión física ${existing ? 'existente' : 'ausente'}`);
            }
            for (const [a, b] of [[via, distinct], [distinct, via]]) {
              assert.equal(destinationCollision(a, b), false, 'no rechaza destinos físicos distintos');
            }
            if (existing) await rm(physical);
          }
        }
        assert.equal(await readlink(fx.link), fx.expectLinkTarget);
      } finally { await rm(fx.root, { recursive: true, force: true }); }
    });
  }
});

test('CLI respeta symlink seguido de dotdot antes de ejecutar o escribir artefactos', async t => {
  for (const absolute of [false, true]) {
    await t.test(absolute ? 'absoluto' : 'relativo', async t => {
      const fx = await dotdotFixture(absolute);
      try {
        if (fx.unsupported) { t.skip(`symlink no soportado (${fx.unsupported})`); return; }
        const cli = path.join(fx.root, 'scripts', 'baseline.mjs');
        for (const existing of [false, true]) {
          if (existing) await writeFile(fx.physical, 'SENTINEL');
          for (const flags of [['--tap', fx.link, '--output', fx.physical], ['--output', fx.link, '--tap', fx.physical]]) {
            const rejected = spawnSync(process.execPath, [cli, ...flags, '--no-coverage'], { cwd: fx.root, encoding: 'utf8', timeout: 10_000 });
            assert.equal(rejected.error, undefined);
            assert.equal(rejected.signal, null);
            assert.equal(rejected.status, 1, 'la colisión real debe abortar');
            assert.equal(rejected.stdout, '');
            assert.match(rejected.stderr, /mismo destino/);
            assert.doesNotMatch(rejected.stderr, /out\.json|alias\.tap|egdev-dangling/);
            if (existing) assert.equal(await readFile(fx.physical, 'utf8'), 'SENTINEL');
            else await assert.rejects(stat(fx.physical), /ENOENT/);
            await assert.rejects(stat(fx.marker), /ENOENT/, 'sin runner');
            assert.equal(await readlink(fx.link), fx.expectLinkTarget, 'enlace intacto tras rechazo');
          }
          if (existing) await rm(fx.physical);
        }
        const accepted = spawnSync(process.execPath, [cli, '--tap', fx.link, '--output', fx.distinct, '--no-coverage'], { cwd: fx.root, encoding: 'utf8', timeout: 10_000 });
        assert.equal(accepted.error, undefined);
        assert.equal(accepted.signal, null);
        assert.equal(accepted.status, 0, accepted.stderr);
        assert.equal(JSON.parse(accepted.stdout).ok, true);
        assert.equal(JSON.parse(await readFile(fx.distinct, 'utf8')).ok, true);
        const tap = await readFile(fx.physical, 'utf8');
        assert.match(tap, /TAP version 13/);
        assert.equal(parseTap(tap).complete, true, 'TAP no pisado por JSON');
        assert.equal(parseTap(tap).counts.fail, 0);
        assert.equal(await readFile(fx.marker, 'utf8'), 'FROM_PROBE');
        assert.equal(await readlink(fx.link), fx.expectLinkTarget, 'enlace intacto');
      } finally { await rm(fx.root, { recursive: true, force: true }); }
    });
  }
});

test('destinationCollision permite reutilizar un symlink y acota ciclos de enlaces', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-link-cycles-'));
  try {
    await mkdir(path.join(root, 'real'));
    await symlink('real', path.join(root, 'dir'), 'dir');
    await symlink('dir/../dir/new.json', path.join(root, 'reused'), 'file');
    assert.equal(destinationCollision(path.join(root, 'reused'), path.join(root, 'real', 'new.json')), true);
    await symlink('loop-b', path.join(root, 'loop-a'), 'file');
    await symlink('loop-a', path.join(root, 'loop-b'), 'file');
    assert.equal(destinationCollision(path.join(root, 'loop-a'), path.join(root, 'new.json')), false);
    for (let i = 0; i < 41; i++) await symlink(i === 40 ? 'new.json' : `hop-${i + 1}`, path.join(root, `hop-${i}`), 'file');
    assert.equal(destinationCollision(path.join(root, 'hop-1'), path.join(root, 'new.json')), true, '40 saltos permitidos');
    assert.equal(destinationCollision(path.join(root, 'hop-0'), path.join(root, 'new.json')), false, '41 saltos se rechazan');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('destinationCollision no colisiona dos ficheros distintos ya existentes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-alias-distinct-'));
  try {
    const a = path.join(root, 'a.json');
    const b = path.join(root, 'b.json');
    await writeFile(a, 'A');
    await writeFile(b, 'B');
    assert.equal(destinationCollision(a, a), true, 'el mismo fichero existente es colisión');
    assert.equal(destinationCollision(a, b), false, 'ficheros distintos en el mismo dispositivo no colisionan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main escribe TAP y JSON en destinos distintos y sale 0', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-ok-'));
  try {
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'test', 'x.test.mjs'), '');
    const tapPath = path.join(root, 'out.tap');
    const jsonPath = path.join(root, 'out.json');
    const tapRaw = completeTap(['ok 1 - uno'], { tests: 1, pass: 1 });
    const runner = async () => ({ ...EMPTY_RUN, stdout: tapRaw });
    const out = [];
    const err = [];
    const code = await main(['--tap', tapPath, '--output', jsonPath], { repoRoot: root, execPath: process.execPath, runner, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) } });
    assert.equal(code, 0);
    assert.equal(await readFile(tapPath, 'utf8'), tapRaw);
    assert.equal(JSON.parse(await readFile(jsonPath, 'utf8')).ok, true);
    assert.equal(JSON.parse(out.join('')).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverTestFiles lista y ordena test/*.test.mjs sin helpers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-'));
  try {
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'test', 'b.test.mjs'), '');
    await writeFile(path.join(root, 'test', 'a.test.mjs'), '');
    await writeFile(path.join(root, 'test', 'helper.mjs'), '');
    assert.deepEqual(discoverTestFiles(root), ['test/a.test.mjs', 'test/b.test.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('testCommand fija reporter TAP, timeout por test, cobertura opcional y orden de ficheros', () => {
  assert.deepEqual(testCommand(['test/a.test.mjs']), ['--test', '--test-reporter=tap', '--test-timeout=300000', '--experimental-test-coverage', 'test/a.test.mjs']);
  assert.deepEqual(testCommand(['test/a.test.mjs'], { coverage: false }), ['--test', '--test-reporter=tap', '--test-timeout=300000', 'test/a.test.mjs']);
  assert.deepEqual(testCommand(['test/a.test.mjs'], { coverage: false, timeoutMs: 500 }), ['--test', '--test-reporter=tap', '--test-timeout=500', 'test/a.test.mjs']);
});

// #87: a hung test must fail with its own name instead of blocking the whole run.
test('testCommand: un test colgado falla con su nombre por el timeout por defecto', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-hang-'));
  try {
    const file = path.join(root, 'hang.test.mjs');
    await writeFile(file, "import { test } from 'node:test';\ntest('se queda colgado', () => new Promise(() => {}));\ntest('termina', () => {});\n");
    const run = await runSuite({ cwd: root, execPath: process.execPath, args: testCommand([file], { coverage: false, timeoutMs: 500 }), timeoutMs: 20_000 });
    assert.equal(run.timedOut, false, 'the whole run must not hang');
    assert.match(run.stdout, /^not ok 1 - se queda colgado$/m);
    assert.match(run.stdout, /test timed out after 500ms/);
    assert.match(run.stdout, /^ok 2 - termina$/m);
    assert.notEqual(run.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #87 (independent verification): --test-force-exit dropped a failure thrown after the test
// returned and the run exited 0. The baseline command must keep such late failures.
test('testCommand: un fallo tardío tras terminar el test no se pierde (sin falso verde)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-late-'));
  try {
    const file = path.join(root, 'late.test.mjs');
    await writeFile(file, "import { test } from 'node:test';\ntest('late assertion', () => { setTimeout(() => { console.log('LATE_STDOUT'); throw new Error('LATE_FAILURE'); }, 100); });\n");
    const run = await runSuite({ cwd: root, execPath: process.execPath, args: testCommand([file], { coverage: false }), timeoutMs: 20_000 });
    assert.equal(run.timedOut, false, 'runner must terminate');
    assert.equal(run.exitCode, 1, `late failure lost:\n${run.stdout}`);
    assert.match(run.stdout, /LATE_STDOUT/);
    assert.match(run.stdout, /LATE_FAILURE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('testCommand: hooks esperados, stdout completo y cobertura conviven con el timeout', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-hooks-'));
  try {
    const file = path.join(root, 'hooks.test.mjs');
    await writeFile(file, "import { test, after } from 'node:test';\nafter(async () => { await new Promise(r => setTimeout(r, 20)); console.log('GLOBAL_HOOK_DONE'); });\ntest('last', async t => { t.after(async () => { await new Promise(r => setTimeout(r, 20)); console.log('TEST_HOOK_DONE'); }); process.stdout.write('BEGIN:' + 'X'.repeat(100000) + ':END\\n'); });\n");
    const run = await runSuite({ cwd: root, execPath: process.execPath, args: testCommand([file]), timeoutMs: 20_000 });
    assert.equal(run.timedOut, false);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /TEST_HOOK_DONE/);
    assert.match(run.stdout, /GLOBAL_HOOK_DONE/);
    // TAP wraps long stdout into several '# ' comment lines; rejoin before comparing.
    const begin = run.stdout.indexOf('BEGIN:'), end = run.stdout.indexOf(':END');
    assert.ok(begin >= 0 && end > begin, 'stdout of the last test is complete');
    assert.equal(run.stdout.slice(begin + 6, end).replaceAll('\n# ', ''), 'X'.repeat(100000));
    assert.match(run.stdout, /# end of coverage report/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pnpm test usa el mismo timeout por test que el baseline', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /--test-timeout=300000(\s|$)/);
  assert.doesNotMatch(pkg.scripts.test, /--test-force-exit/, 'force-exit hides late failures');
});

test('runSuite arranca un runner inyectable sin shell y captura su TAP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-run-'));
  try {
    const fixture = path.join(root, 'runner.fixture.mjs');
    await writeFile(fixture, "console.log('TAP version 13');\nconsole.log('ok 1 - uno');\nconsole.log('not ok 2 - dos');\nconsole.log('1..2');\nconsole.log('# tests 2');\nconsole.log('# pass 1');\nconsole.log('# fail 1');\nprocess.exitCode = 1;\n");
    const run = await runSuite({ cwd: root, execPath: process.execPath, args: [fixture] });
    assert.equal(run.error, null);
    assert.equal(run.exitCode, 1);
    assert.equal(run.signal, null);
    assert.equal(parseTap(run.stdout).counts.fail, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('main sale 1 y emite JSON no-GREEN cuando la suite falla', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-baseline-main-'));
  try {
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'test', 'x.test.mjs'), "import { test } from 'node:test';\ntest('falla', () => { throw new Error('boom'); });\n");
    const out = [];
    const err = [];
    const code = await main([], { repoRoot: root, execPath: process.execPath, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) } });
    assert.equal(code, 1);
    const report = JSON.parse(out.join(''));
    assert.equal(report.ok, false);
    assert.equal(report.tests.counts.fail, 1);
    assert.match(err.join(''), /FALLO/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
