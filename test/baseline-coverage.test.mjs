import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseCoverage } from '../scripts/baseline.mjs';

// Filas del formato agrupado de node:test, con varios niveles y vuelta a una carpeta padre.
const grouped = `# start of coverage report
# ------------------------------------------------------------
# file                         | line % | branch % | funcs % | uncovered lines
# ------------------------------------------------------------
# src                          |        |          |         |
#  routes                      |        |          |         |
#   shortcuts.mjs              |  95.00 |    90.00 |  80.00  |
#   nested                      |        |          |         |
#    child.mjs                 |  50.00 |    60.00 |  70.00  |
#  server.mjs                  |  98.00 |    88.00 |  78.00  |
#  programs                    |        |          |         |
#   obs.mjs                    |  99.00 |    89.00 |  79.00  |
# test                         |        |          |         |
#  helpers                     |        |          |         |
#   fixture.mjs                | 100.00 |   100.00 | 100.00  |
# var                          |        |          |         |
#  tmp                         |        |          |         |
#   antena-stub-abc            |        |          |         |
#    server.mjs                |  10.00 |    20.00 |  30.00  |
# src2                         |        |          |         |
#  other.mjs                   |  60.00 |    70.00 |  80.00  |
# all files                    |  82.00 |    72.00 |  62.00  |
# end of coverage report`;

test('cobertura agrupada reconstruye niveles y excluye tests y temporales sin tocar el agregado', () => {
  const result = parseCoverage(grouped.split('\n'));
  assert.deepEqual(result, { available: true, aggregate: { file: 'all files', lines: 82, branches: 72, functions: 62 }, files: [
    { file: 'src/routes/shortcuts.mjs', lines: 95, branches: 90, functions: 80 },
    { file: 'src/routes/nested/child.mjs', lines: 50, branches: 60, functions: 70 },
    { file: 'src/server.mjs', lines: 98, branches: 88, functions: 78 },
    { file: 'src/programs/obs.mjs', lines: 99, branches: 89, functions: 79 },
    { file: 'src2/other.mjs', lines: 60, branches: 70, functions: 80 },
  ] });
});

test('la tabla real de node:test conserva src/routes y vuelve a src', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-coverage-table-'));
  const external = await mkdtemp(path.join(tmpdir(), 'antena-stub-coverage-'));
  try {
    await writeFile(path.join(external, 'stub.mjs'), 'export const stub = 3;\n');
    await mkdir(path.join(root, 'src', 'routes'), { recursive: true });
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'src', 'routes', 'shortcuts.mjs'), 'export const shortcut = 1;\n');
    await writeFile(path.join(root, 'src', 'server.mjs'), 'export const server = 2;\n');
    await writeFile(path.join(root, 'test', 'sample.test.mjs'), `import { test } from 'node:test';\nimport { shortcut } from '../src/routes/shortcuts.mjs';\nimport { server } from '../src/server.mjs';\nimport { stub } from ${JSON.stringify(pathToFileURL(path.join(external, 'stub.mjs')).href)};\ntest('fixture', () => { if (shortcut + server + stub !== 6) throw Error('fixture'); });\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--experimental-test-coverage', 'test/sample.test.mjs'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const coverage = parseCoverage(result.stdout.split(/\r?\n/));
    assert.ok(coverage?.aggregate);
    assert.deepEqual(coverage.files.map(f => f.file).sort(), ['src/routes/shortcuts.mjs', 'src/server.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('cobertura de rutas completas excluye tmpdir, /var/tmp, prefijos de fixtures y test, no nombres parecidos', () => {
  const temp = path.join(tmpdir(), 'other-fixture', 'x.mjs').replaceAll('\\', '/');
  const table = `# start of coverage report
# file | line % | branch % | funcs % | uncovered lines
# ${temp} | 1 | 2 | 3 |
# /var/tmp/unrelated/file.mjs | 1 | 2 | 3 |
# antena-stub-123/src/server.mjs | 1 | 2 | 3 |
# odd09-config-123/config.mjs | 1 | 2 | 3 |
# test/fixture.mjs | 1 | 2 | 3 |
# src/routes/server.mjs | 98 | 97 | 96 |
# src/antena-stub-guide.mjs | 80 | 90 | 100 |
# testsupport/helper.mjs | 40 | 50 | 60 |
# all files | 50 | 60 | 70 |
# end of coverage report`;
  const result = parseCoverage(table.split('\n'));
  assert.deepEqual(result.files.map(f => f.file), ['src/routes/server.mjs', 'src/antena-stub-guide.mjs', 'testsupport/helper.mjs']);
  assert.deepEqual(result.aggregate, { file: 'all files', lines: 50, branches: 60, functions: 70 });
});
