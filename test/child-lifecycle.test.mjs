import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { observeChildLifecycle } from './helpers/child-lifecycle.mjs';

function fixture() {
  let time = 100;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
    stdin: { destroyed: false, writableEnded: false, writableFinished: false },
    stdout: { destroyed: false, readableEnded: false }, stderr: { destroyed: false, readableEnded: false } });
  const ownedErrors = [];
  child.on('error', error => ownedErrors.push(error));
  const probe = observeChildLifecycle(child, { now: () => time });
  return { child, probe, ownedErrors, advance: ms => { time += ms; } };
}

// Ejecutar el awaitExit real sin importar el módulo que registra las pruebas de
// admisión. Son dobles de lifecycle, no ejecución del kernel/controlador Windows.
function awaitExitUnderTest() {
  const source = readFileSync(new URL('./server-admission.test.mjs', import.meta.url), 'utf8');
  const body = source.match(/async function awaitExit\(c, ms = 3000\) \{[\s\S]+?\n\}/)?.[0];
  assert.ok(body, 'debe encontrarse la función real con su deadline predeterminado intacto');
  return runInNewContext(`(${body})`, { setTimeout, clearTimeout, assert });
}

function timeoutMetadata(error) {
  const [before, after] = error.message.split('lifecycleAtWatchdog=')[1].split('; lifecycleAfterRescue=');
  return { before: JSON.parse(before), after: JSON.parse(after.split(': ')[0]) };
}

test('guardia real congela el estado antes del rescate y no convierte SIGKILL en salida graceful', async () => {
  const { child, probe, advance } = fixture();
  const closeInfo = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const requested = [];
  child.kill = signal => {
    requested.push(signal); advance(5); child.exitCode = 1;
    child.emit('exit', 1, null); advance(5); child.emit('close', 1, null);
    return true;
  };
  const c = { child, lifecycle: probe, closeInfo, stdout: () => '', stderr: () => '' };
  await assert.rejects(awaitExitUnderTest()(c, 1), error => {
    assert.match(error.message, /no completó close en 1ms/);
    const { before, after } = timeoutMetadata(error);
    assert.equal(before.exitCode, null);
    assert.equal(before.exitEvent, null);
    assert.equal(before.closeEvent, null);
    assert.equal(after.exitCode, 1);
    assert.deepEqual(after.exitEvent, { atMs: 5, code: 1, signal: null });
    assert.deepEqual(after.closeEvent, { atMs: 10, code: 1, signal: null });
    return true;
  });
  assert.deepEqual(requested, ['SIGKILL']);
});

test('guardia real distingue exit reportado cero de close todavía pendiente', async () => {
  const { child, probe, advance } = fixture();
  child.exitCode = 0; advance(2); child.emit('exit', 0, null);
  const closeInfo = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.kill = () => { advance(4); child.emit('close', 0, null); return false; };
  const c = { child, lifecycle: probe, closeInfo, stdout: () => '', stderr: () => '' };
  await assert.rejects(awaitExitUnderTest()(c, 1), error => {
    const { before, after } = timeoutMetadata(error);
    assert.equal(before.exitCode, 0);
    assert.deepEqual(before.exitEvent, { atMs: 2, code: 0, signal: null });
    assert.equal(before.closeEvent, null);
    assert.deepEqual(after.closeEvent, { atMs: 6, code: 0, signal: null });
    return true;
  });
});

test('cierre sano conserva resultado y no invoca rescate', async () => {
  const { child, probe } = fixture();
  child.kill = () => { assert.fail('un cierre sano no debe forzarse'); };
  const result = { code: 0, signal: null };
  const c = { child, lifecycle: probe, closeInfo: Promise.resolve(result), stdout: () => '', stderr: () => '' };
  assert.equal(await awaitExitUnderTest()(c, 1), result);
});

test('error del rescate conserva identidad y añade el estado anterior sin ocultar el fallo', async () => {
  const { child, probe } = fixture();
  const failure = Object.assign(new Error('rescate rechazado'), { code: 'EPERM' });
  child.kill = () => { child.emit('error', failure); throw failure; };
  const c = { child, lifecycle: probe, closeInfo: new Promise(() => {}), stdout: () => '', stderr: () => '' };
  await assert.rejects(awaitExitUnderTest()(c, 1), error => {
    assert.equal(error, failure);
    const { before, after } = timeoutMetadata(error);
    assert.deepEqual(before.errors, []);
    assert.deepEqual(after.errors, [{ atMs: 0, code: 'EPERM' }]);
    return true;
  });
});

test('lifecycle distingue falta de exit observado de exit reportado con close pendiente', () => {
  const { child, probe, advance } = fixture();
  const beforeRescue = probe.snapshot();
  assert.equal(beforeRescue.exitEvent, null);
  assert.equal(beforeRescue.closeEvent, null);
  assert.equal(beforeRescue.exitCode, null);
  advance(25);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  const pendingClose = probe.snapshot();
  assert.deepEqual(pendingClose.exitEvent, { atMs: 25, code: 0, signal: null });
  assert.equal(pendingClose.closeEvent, null);
  assert.equal(pendingClose.exitCode, 0);
  assert.equal(beforeRescue.exitEvent, null, 'un snapshot anterior no cambia tras un evento/rescate');
  advance(40);
  child.stdout.readableEnded = true;
  child.emit('close', 0, null);
  assert.deepEqual(probe.snapshot().closeEvent, { atMs: 65, code: 0, signal: null });
  assert.equal(probe.snapshot().stdout.readableEnded, true);
  assert.equal(pendingClose.closeEvent, null);
  pendingClose.exitEvent.code = 999;
  assert.equal(probe.snapshot().exitEvent.code, 0, 'el consumidor no muta el estado interno');
});

test('lifecycle acota errores y no expone mensajes, rutas, PIDs ni códigos privados', () => {
  const { child, probe, ownedErrors, advance } = fixture();
  child.pid = 12345;
  for (let i = 0; i < 8; i++) {
    advance(1);
    child.emit('error', Object.assign(new Error('PRIVATE_CANARY/path/token'), {
      code: i === 0 ? 'ERR_SIGNAL_CONTROLLER' : 'PRIVATE_CANARY',
    }));
  }
  const snapshot = probe.snapshot();
  assert.equal(ownedErrors.length, 8, 'el observador no sustituye el handler propietario');
  assert.equal(snapshot.errors.length, 4);
  assert.deepEqual(snapshot.errors[0], { atMs: 1, code: 'ERR_SIGNAL_CONTROLLER' });
  assert.equal(snapshot.errors[1].code, 'OTHER');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_CANARY|12345/);
  assert.ok(JSON.stringify(snapshot).length < 1500);
});

test('lifecycle captura estado de streams sin contenido y conserva señal real conocida', () => {
  const { child, probe, advance } = fixture();
  child.stdin.writableEnded = true;
  child.stdin.writableFinished = true;
  child.stderr.destroyed = true;
  child.signalCode = 'SIGTERM';
  advance(3);
  child.emit('exit', null, 'SIGTERM');
  const snapshot = probe.snapshot();
  assert.deepEqual(snapshot.stdin, { destroyed: false, writableEnded: true, writableFinished: true });
  assert.deepEqual(snapshot.stderr, { destroyed: true, readableEnded: false });
  assert.equal(snapshot.signalCode, 'SIGTERM');
  assert.deepEqual(snapshot.exitEvent, { atMs: 3, code: null, signal: 'SIGTERM' });
  assert.equal(snapshot.closeEvent, null);
});
