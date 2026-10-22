import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as startup from './helpers/chrome-startup.mjs';
const { observeChromeStartup } = startup;

test('archivo DevTools distingue lectura vacía, puerto válido y errores sin mostrar contenido privado', () => {
  const valid = '43121\n/devtools/browser/PRIVATE_CANARY\n';
  assert.deepEqual(startup.chromePortFileDiagnostic(valid), {
    exists: true, readable: true, errorCode: null, bytes: Buffer.byteLength(valid), port: 43121, browserPath: true,
  });
  for (const content of ['', 'PRIVATE_CANARY', '99999\nPRIVATE_CANARY']) {
    const result = startup.chromePortFileDiagnostic(content);
    assert.equal(result.exists, true);
    assert.equal(result.readable, true);
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.port, null);
    assert.equal(result.browserPath, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY/);
  }
  for (const code of ['ENOENT', 'EACCES', 'PRIVATE_CANARY']) {
    const result = startup.chromePortFileDiagnostic(null, { code, message: 'PRIVATE_CANARY' });
    assert.equal(result.exists, code === 'ENOENT' ? false : null);
    assert.equal(result.readable, false);
    assert.equal(result.errorCode, code === 'PRIVATE_CANARY' ? 'READ_ERROR' : code);
    assert.equal(result.bytes, null);
    assert.equal(result.port, null);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY/);
  }
});

test('descriptor Chrome conserva sólo localización clasificada sin títulos, IDs ni query privados', () => {
  assert.deepEqual(startup.chromeTargetDiagnostic(undefined), { available: false });
  for (const [url, location] of [
    ['about:blank', 'about:blank'], ['chrome-error://chromewebdata/', 'chrome-error'],
    ['http://user:PRIVATE_CANARY@127.0.0.1:4321/panel.html?token=PRIVATE_CANARY#PRIVATE_CANARY', 'http://127.0.0.1:4321/panel.html'],
    ['http://localhost:4321/PRIVATE_CANARY', 'http://localhost:4321/[other]'],
    ['https://example.test/PRIVATE_CANARY', '[non-loopback]'], ['PRIVATE_CANARY', '[invalid]'],
  ]) {
    const result = startup.chromeTargetDiagnostic({ url, title: 'PRIVATE_CANARY', id: 'PRIVATE_CANARY' });
    assert.deepEqual(result, { available: true, location });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY/);
  }
});

// Evalúa el constructor REAL del fallo con colector deshabilitado; no cambia
// el modo de lanzamiento de Chrome ni afirma reproducir un fallo nativo Windows.
test('discovery sin colector conserva el error Chrome y sus metadatos, no TypeError', () => {
  const source = readFileSync(new URL('./redesign-regressions.test.mjs', import.meta.url), 'utf8');
  const statement = source.match(/throw new Error\('Chrome no expuso la página del prompter'[\s\S]+?\)\);/)?.[0];
  assert.ok(statement, 'el constructor de fallo debe seguir presente en openPrompter');
  const probe = {
    binary: { source: 'fallback', identity: '/usr/bin/google-chrome' }, failurePhase: 'port-discovery',
    portDiscovery: { attempts: 150, firstReadMs: 0, lastReadMs: 14900, endMs: 15000 },
    targetDiscovery: { attempts: 100, startMs: 15000, lastPollMs: 24900, endMs: 25000 }, observationMs: 25000,
  };
  const context = { startup: null, port: undefined, page: undefined, probe,
    discovery: { exists: false }, atFailure: { exists: true }, targets: [] };
  let failure;
  try { runInNewContext(statement, context); } catch (error) { failure = error; }
  assert.equal(failure?.name, 'Error');
  assert.match(failure.message, /^Chrome no expuso la página del prompter; Chrome startup: /);
  const metadata = JSON.parse(failure.message.split('; Chrome startup: ')[1]);
  assert.equal(metadata.portAvailable, false);
  assert.equal(metadata.pageAvailable, false);
  assert.deepEqual(metadata.probe, probe);
  assert.equal(metadata.devTools.discovery.exists, false);
  assert.equal(metadata.devTools.atFailure.exists, true);
  assert.equal(metadata.unavailable, true);
});

function fixture() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  return { child, probe: observeChromeStartup(child, '/tmp/private-profile') };
}

test('Chrome startup probe no afirma salida antes de close', () => {
  const { probe } = fixture();
  assert.deepEqual(probe.snapshot(), { closed: false, exitCode: null, signal: null, spawnError: null, stderr: '', stderrTruncated: false });
});

test('Chrome startup probe conserva stderr y salida fallida sin cerrar el proceso', () => {
  const { child, probe } = fixture();
  child.stderr.emit('data', Buffer.from('No usable sandbox! /tmp/private-profile'));
  child.emit('close', 1, null);
  assert.deepEqual(probe.snapshot(), { closed: true, exitCode: 1, signal: null, spawnError: null,
    stderr: 'No usable sandbox! [profile]', stderrTruncated: false });
});

test('Chrome startup probe acota bytes de stderr, registra truncamiento y no acumula después', () => {
  const { child, probe } = fixture();
  child.stderr.emit('data', Buffer.alloc(3000, 97));
  child.stderr.emit('data', Buffer.from('tail'));
  const snapshot = probe.snapshot();
  assert.equal(snapshot.stderr.length, 2000);
  assert.equal(snapshot.stderrTruncated, true);
  assert.equal(snapshot.stderr.includes('tail'), false);
});

test('Chrome startup probe conserva señal y error de spawn sin ecoar mensaje privado', () => {
  const { child, probe } = fixture();
  child.emit('error', Object.assign(new Error('PRIVATE/path/token'), { code: 'ENOENT' }));
  child.emit('close', null, 'SIGABRT');
  const result = probe.snapshot();
  assert.equal(result.spawnError, 'ENOENT');
  assert.equal(result.signal, 'SIGABRT');
  assert.equal(result.exitCode, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token/);
});
