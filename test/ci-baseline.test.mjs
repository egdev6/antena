import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport, parseTap } from '../scripts/baseline.mjs';
import { checkCiBaseline, REQUIRED_BROWSER_TESTS } from '../scripts/ci-baseline.mjs';

const browserNames = [
  'prompter React: guardar una marca libera la cronología (Enter/blur, SSE y fallo)',
  'panel React: el aviso de configuración/secretos persiste, no finge guardado y se recupera sin recargar',
];
function fixture(extra = [], platform = 'linux') {
  const lines = browserNames.map((name, i) => `ok ${i + 1} - ${name}`);
  if (extra.some(line => /^\s/.test(line))) {
    lines.push('# Subtest: prueba de plataforma', ...extra, '    1..1', 'ok 3 - prueba de plataforma');
  } else lines.push(...extra);
  const skipped = lines.filter(line => /# SKIP/.test(line)).length;
  const total = lines.filter(line => /^\s*(?:ok|not ok) /.test(line)).length;
  const roots = lines.filter(line => /^(?:ok|not ok) /.test(line)).length;
  const tap = ['TAP version 13', ...lines, `1..${roots}`,
    `# tests ${total}`, '# suites 0', `# pass ${total - skipped}`, '# fail 0',
    '# cancelled 0', `# skipped ${skipped}`, '# todo 0', '# duration_ms 1', ''].join('\n');
  const report = buildReport({
    run: { stdout: tap, stderr: '', exitCode: 0, durationMs: 1 },
    testFiles: ['test/redesign-regressions.test.mjs'], repoRoot: '/fixture',
    command: [], parsed: parseTap(tap), coverageRequested: false,
  });
  report.environment.platform = platform;
  return { report, tap };
}

test('CI exige los nombres reales de las dos regresiones de navegador', () => {
  assert.deepEqual(REQUIRED_BROWSER_TESTS, browserNames);
  assert.equal(checkCiBaseline(fixture().report, fixture().tap).ok, true);
});

test('CI falla si navegador se omite, desaparece, falla o queda TODO', () => {
  for (const replacement of ['# SKIP sin Chrome local', '# TODO pendiente', 'missing', 'failed']) {
    const fx = fixture();
    if (replacement === 'missing') fx.tap = fx.tap.replace(browserNames[0], 'otra prueba');
    else if (replacement === 'failed') fx.tap = fx.tap.replace('ok 1 -', 'not ok 1 -');
    else fx.tap = fx.tap.replace(browserNames[0], `${browserNames[0]} ${replacement}`);
    assert.equal(checkCiBaseline(fx.report, fx.tap).ok, false, replacement);
  }
});

test('CI rechaza informe ausente, inválido, no OK, runner fallido y TAP truncado', () => {
  const fx = fixture();
  for (const report of [null, {}, { ...fx.report, schema: 'other' },
    { ...fx.report, ok: false }, { ...fx.report, runner: { exitCode: 1 } }]) {
    assert.equal(checkCiBaseline(report, fx.tap).ok, false);
  }
  assert.equal(checkCiBaseline(fx.report, 'TAP version 13').ok, false);
  fx.report.tests.counts.skipped = 1;
  assert.equal(checkCiBaseline(fx.report, fx.tap).ok, false, 'JSON y TAP incoherentes');
});

test('CI enumera skips anidados y solo permite excepciones explícitas de plataforma', () => {
  const cases = [
    ['linux', '    ok 1 - IPv6 # SKIP sin loopback IPv6 en este entorno', true],
    ['win32', '    ok 1 - symlink # SKIP alias symlink no soportado en esta plataforma (EPERM)', true],
    ['win32', '    ok 1 - relativo # SKIP symlink no soportado (ENOTSUP)', true],
    ['linux', '    ok 1 - symlink # SKIP symlink no soportado (EPERM)', false],
    ['win32', '    ok 1 - hardlink # SKIP alias hardlink no soportado en esta plataforma (EPERM)', false],
    ['linux', '    ok 1 - clock # SKIP reloj virtual no soportado (error)', false],
    ['win32', '    ok 1 - otro # SKIP motivo desconocido', false],
    ['linux', '    ok 1 - WinPS # SKIP Requires Windows PowerShell 5.1 and real NTFS ACLs; not established on Linux', true],
    ['linux', '    ok 1 - NTFS # SKIP Requires real Windows/NTFS/PowerShell ACLs; NOT validated on Linux', true],
    ['win32', '    ok 1 - nunca # SKIP Requires real Windows/NTFS/PowerShell ACLs; NOT validated on Linux', false],
    ...[
      'POSIX-only: real app boot with POSIX file modes; Windows ACL equivalent in held-recovery-windows-storage.test.mjs',
      'POSIX-only: real SIGINT shutdown with POSIX file modes; Windows ACL equivalent in held-recovery-windows-storage.test.mjs',
      'POSIX filesystem contract; native Windows ACL equivalent in held-recovery-windows-storage.test.mjs',
      'Linux-only platform guard',
      'Requires a non-elevated Windows user: an elevated process (hosted runner) does not own its files with the user SID',
    ].flatMap(reason => [['win32', `    ok 1 - POSIX # SKIP ${reason}`, true], ['linux', `    ok 1 - POSIX # SKIP ${reason}`, false],
      ['win32', `    ok 1 - POSIX # SKIP ${reason} extra`, false]]),
    ['win32', '    ok 1 - vacío # SKIP', false],
    ['win32', '    ok 1 - POSIX # SKIP POSIX-only', false],
  ];
  for (const [platform, line, ok] of cases) {
    const { report, tap } = fixture([line], platform);
    const result = checkCiBaseline(report, tap);
    assert.equal(result.ok, ok, line);
    assert.equal(result.skips.length, 1);
    assert.equal(result.skips[0].allowed, ok);
  }
});

test('CI no confunde una directiva escapada en el nombre con TODO real', () => {
  const fx = fixture(['ok 3 - nombre literal \\# TODO pendiente']);
  assert.equal(checkCiBaseline(fx.report, fx.tap).ok, true);
});

test('CI no permite resumen de skips que no pueda enumerar', () => {
  const fx = fixture();
  fx.tap = fx.tap.replace('# pass 2', '# pass 1').replace('# skipped 0', '# skipped 1');
  fx.report.tests.counts.pass = 1;
  fx.report.tests.counts.skipped = 1;
  assert.equal(checkCiBaseline(fx.report, fx.tap).ok, false);
});

test('CI rechaza plan raíz incoherente y fallos o TODO ocultos por un resumen verde', async t => {
  await t.test('plan raíz', () => {
    const fx = fixture();
    assert.equal(checkCiBaseline(fx.report, fx.tap.replace('1..2', '1..99')).ok, false);
  });
  for (const line of ['    not ok 1 - nested # TODO pending', 'not ok 3 - fallo oculto']) {
    await t.test(line.trim(), () => {
      const fx = fixture([line]);
      assert.equal(checkCiBaseline(fx.report, fx.tap).ok, false);
    });
  }
});

test('Los workflows reactivados no arrastran borrador y compilan la interfaz React', () => {
  const workflows = new URL('../.github/workflows/', import.meta.url);
  assert.equal(existsSync(new URL('baseline.yml.draft', workflows)), false, 'baseline.yml.draft debe borrarse');
  const baseline = readFileSync(new URL('baseline.yml', workflows), 'utf8');
  assert.doesNotMatch(baseline, /^# Borrador/m, 'la cabecera de borrador se elimina');
  // La regresión React se salta con un motivo no permitido si falta app/dist:
  // el workflow debe instalar con pnpm y compilar antes del baseline.
  for (const paso of ['corepack enable pnpm', 'pnpm install --frozen-lockfile', 'pnpm app:build']) {
    assert.ok(baseline.includes(paso), `paso ausente en baseline.yml: ${paso}`);
  }
  assert.match(baseline, /ubuntu-24\.04/, 'matriz de Linux intacta');
  assert.match(baseline, /windows-2022/, 'matriz de Windows intacta');
  assert.match(baseline, /node: \['22', '24'\]/, 'matriz de Node intacta');
  assert.ok(baseline.includes('node scripts/ci-baseline.mjs baseline.json baseline.tap'), 'verificación de CI intacta');
  // Los fallos de Windows preexistentes (#83) quedan como aviso: el job no bloquea
  // en windows-2022 mientras esa issue siga abierta.
  // #83 cerrada: Windows es obligatorio, ningún job de la matriz corre como aviso
  assert.doesNotMatch(baseline, /continue-on-error/, 'Windows no puede volver a correr como aviso');
  for (const name of ['code-safety.yml', 'secrets-scan.yml']) {
    const text = readFileSync(new URL(name, workflows), 'utf8');
    assert.ok(!/(?:pnpm|npm) install/.test(text), `${name} no debe instalar dependencias`);
    assert.match(text, /^name: /m, `${name} conserva su cabecera de workflow`);
    assert.match(text, /workflow_dispatch:/, `${name} conserva su disparo manual`);
  }
});

test('CLI devuelve 0/1 sin ocultar artefactos ausentes, JSON inválido o skips críticos', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'egdev-ci-'));
  const json = path.join(root, 'baseline.json'), raw = path.join(root, 'baseline.tap');
  const cli = new URL('../scripts/ci-baseline.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(cli), ...args], { encoding: 'utf8', timeout: 5000 });
  try {
    const fx = fixture();
    writeFileSync(json, JSON.stringify(fx.report)); writeFileSync(raw, fx.tap);
    const green = run([json, raw]);
    assert.equal(green.status, 0, green.stderr);
    assert.equal(JSON.parse(green.stdout).ok, true);
    assert.equal(run([]).status, 1);
    assert.equal(run([json, raw, 'extra']).status, 1);
    assert.equal(run([path.join(root, 'missing.json'), raw]).status, 1);
    writeFileSync(json, '{bad');
    assert.equal(run([json, raw]).status, 1);
    writeFileSync(json, JSON.stringify(fx.report));
    writeFileSync(raw, fx.tap.replace(browserNames[0], `${browserNames[0]} # SKIP sin Chrome`));
    assert.equal(run([json, raw]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
