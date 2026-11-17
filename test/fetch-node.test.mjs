import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fetch-node.mjs');
const payload = 'synthetic-node-executable';
const hash = createHash('sha256').update(payload).digest('hex');
const version = process.version;

function fixture({ ci = true, sums = `${hash}  win-x64/node.exe\n`, status = 200 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'antena-node-sidecar-'));
  mkdirSync(path.join(dir, 'scripts'));
  const script = path.join(dir, 'scripts', 'fetch-node.mjs');
  writeFileSync(script, readFileSync(SCRIPT));
  const executable = path.join(dir, 'node.exe');
  writeFileSync(executable, payload);
  const dest = path.join(dir, 'src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe');
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, 'original');
  const sumsFile = path.join(dir, 'SHASUMS256.txt');
  writeFileSync(sumsFile, sums);
  const log = path.join(dir, 'requests');
  const preload = path.join(dir, 'preload.mjs');
  writeFileSync(preload, `
import { appendFileSync, readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.defineProperty(process, 'arch', { value: 'x64' });
Object.defineProperty(process, 'execPath', { value: process.env.FAKE_EXECUTABLE });
childProcess.execFileSync = () => 'host: x86_64-pc-windows-msvc\\n';
syncBuiltinESMExports();
globalThis.fetch = async url => {
  appendFileSync(process.env.REQUEST_LOG, url + '\\n');
  return new Response(readFileSync(process.env.FAKE_SUMS), { status: Number(process.env.FAKE_STATUS) });
};
`);
  const run = () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...(ci ? { CI: 'true' } : {}),
      FAKE_EXECUTABLE: executable, FAKE_SUMS: sumsFile, FAKE_STATUS: String(status), REQUEST_LOG: log },
  });
  return { dir, dest, log, run };
}

test('desktop:node en CI verifica el ejecutable exacto antes de copiarlo', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `Node ${version} copiado a ${path.join('src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe')} (0 MB)\n`);
    assert.equal(readFileSync(f.dest, 'utf8'), payload);
    assert.equal(readFileSync(f.log, 'utf8'), `https://nodejs.org/dist/${version}/SHASUMS256.txt\n`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('desktop:node en CI rechaza un binario alterado sin cambiar el sidecar', () => {
  const wrong = createHash('sha256').update('different binary').digest('hex');
  const f = fixture({ sums: `${hash}  node-${version}-win-x64.zip\n${wrong}  win-x64/node.exe\n` });
  try {
    const r = f.run();
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `✗ SHA-256 de Node ${version} no coincide con SHASUMS256.txt (win-x64/node.exe).\n`);
    assert.equal(readFileSync(f.dest, 'utf8'), 'original');
    assert.equal(readFileSync(f.log, 'utf8'), `https://nodejs.org/dist/${version}/SHASUMS256.txt\n`);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('desktop:node en CI rechaza SHASUMS sin entrada única válida y un HTTP 503', () => {
  const cases = [
    { sums: `${hash}  node-${version}-win-x64.zip\n`, error: '✗ SHASUMS256.txt no contiene una única entrada válida para win-x64/node.exe.\n' },
    { sums: `${hash}  win-x64/node.exe\n${hash}  win-x64/node.exe\n`, error: '✗ SHASUMS256.txt no contiene una única entrada válida para win-x64/node.exe.\n' },
    { status: 503, error: `✗ No se pudo descargar SHASUMS256.txt de Node ${version} (503).\n` },
  ];
  for (const { error, ...options } of cases) {
    const f = fixture(options);
    try {
      const r = f.run();
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, error);
      assert.equal(readFileSync(f.dest, 'utf8'), 'original');
      assert.equal(readFileSync(f.log, 'utf8'), `https://nodejs.org/dist/${version}/SHASUMS256.txt\n`);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('desktop:node local conserva la copia sin red', () => {
  const f = fixture({ ci: false });
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `Node ${version} copiado a ${path.join('src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe')} (0 MB)\n`);
    assert.equal(readFileSync(f.dest, 'utf8'), payload);
    assert.throws(() => readFileSync(f.log), { code: 'ENOENT' });
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
