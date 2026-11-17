import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fonts.mjs');
const files = [
  ['barlow-condensed', 700], ['barlow-condensed', 800],
  ['barlow', 500], ['barlow', 600], ['jetbrains-mono', 500],
];
const name = ([family, weight]) => `${family}-latin-${weight}-normal.woff2`;
const payload = 'synthetic-font';
const hash = createHash('sha256').update(payload).digest('hex');

function fixture(mode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'antena-fonts-'));
  mkdirSync(path.join(dir, 'scripts'));
  // Only the hashes in the disposable copy are replaced: the real SHA-256 code runs on fake bytes.
  const source = readFileSync(SCRIPT, 'utf8').replace(/\b[0-9a-f]{64}\b/g, hash);
  const script = path.join(dir, 'scripts', 'fonts.mjs');
  writeFileSync(script, source);
  const preload = path.join(dir, 'preload.mjs');
  writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async url => {
  appendFileSync(process.env.REQUEST_LOG, url + '\\n');
  const target = url.includes('/barlow@') && url.endsWith('/latin-500-normal.woff2');
  if (target && process.env.MODE === 'http') return new Response('', { status: 404 });
  const body = target && process.env.MODE === 'mismatch' ? 'tampered-font' : 'synthetic-font';
  return new Response(body, { status: 200 });
};
`);
  const out = path.join(dir, 'public', 'fonts');
  mkdirSync(out, { recursive: true });
  for (const file of files) writeFileSync(path.join(out, name(file)), 'original');
  const log = path.join(dir, 'requests');
  const run = () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
    encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MODE: mode, REQUEST_LOG: log },
  });
  return { dir, out, log, run };
}

test('fonts descarga cinco versiones exactas, verifica SHA-256 y guarda las fuentes', () => {
  const f = fixture('ok');
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, files.map(file => `✓ ${name(file)}\n`).join(''));
    const urls = readFileSync(f.log, 'utf8').trim().split('\n');
    assert.deepEqual(urls, files.map(([family, weight]) => `https://cdn.jsdelivr.net/fontsource/fonts/${family}@5.3.0/latin-${weight}-normal.woff2`));
    for (const file of files) assert.equal(readFileSync(path.join(f.out, name(file)), 'utf8'), payload);
    const pins = readFileSync(SCRIPT, 'utf8').match(/\b[0-9a-f]{64}\b/g) || [];
    assert.equal(new Set(pins).size, 5, 'cinco hashes reales y distintos');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('fonts rechaza un hash incorrecto sin sobrescribir esa fuente', () => {
  const f = fixture('mismatch');
  try {
    const r = f.run();
    assert.equal(r.status, 1);
    assert.equal(r.stderr, '✗ barlow-latin-500-normal.woff2 (SHA-256 no coincide)\n');
    assert.equal(r.stdout, files.filter(file => name(file) !== 'barlow-latin-500-normal.woff2').map(file => `✓ ${name(file)}\n`).join(''));
    assert.equal(readFileSync(path.join(f.out, 'barlow-latin-500-normal.woff2'), 'utf8'), 'original');
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 5);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('fonts conserva el comportamiento ante un HTTP 404: informa y sigue con las demás', () => {
  const f = fixture('http');
  try {
    const r = f.run();
    assert.equal(r.status, 1);
    assert.equal(r.stderr, '✗ barlow-latin-500-normal.woff2 (404)\n');
    assert.equal(r.stdout, files.filter(file => name(file) !== 'barlow-latin-500-normal.woff2').map(file => `✓ ${name(file)}\n`).join(''));
    assert.equal(readFileSync(path.join(f.out, 'barlow-latin-500-normal.woff2'), 'utf8'), 'original');
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 5);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
