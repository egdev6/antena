import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { WINDOWS_STARTUP_STAGE_MS } from './helpers/signal-child.mjs';

// Clase y cola reales con EventEmitter real; sólo se sustituyen transporte y scheduling.
// No ejecuta PowerShell, procesos nativos ni el poll de archivos.
const source = readFileSync(new URL('./helpers/signal-child.mjs', import.meta.url), 'utf8');
const start = source.indexOf('class WindowsSignalChild extends EventEmitter {');
const end = source.indexOf('export async function launchSignalChild(', start);
assert.ok(start >= 0 && end > start);
const launcherTail = source.match(/  child\._returned = true;[\s\S]*?  return child;/)?.[0];
assert.ok(launcherTail);

function fixture(t, returned = true) {
  const scheduled = [];
  const ActualChild = runInNewContext(`(${source.slice(start, end).trim()})`, {
    EventEmitter, PassThrough, controllers: new WeakMap(), limit: 10000, WINDOWS_STARTUP_STAGE_MS,
    setTimeout: () => ({}), clearTimeout: () => {},
    setImmediate: callback => { scheduled.push(callback); },
  });
  ActualChild.prototype._poll = async () => {};
  const controller = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) controller[name] = new PassThrough();
  const child = new ActualChild(controller, 'unused-control-directory', 'unused-launch');
  child._returned = returned;
  t.after(() => {
    for (const stream of [controller.stdin, controller.stdout, controller.stderr, child.stdout, child.stderr]) stream.destroy();
  });
  const flush = () => {
    assert.equal(scheduled.length, 1, 'una entrega pendiente por turno');
    scheduled.shift()();
  };
  return { child, scheduled, flush };
}

test('quitar el último once(exit) no destruye la cola de close', t => {
  const { child, flush } = fixture(t);
  const observed = [];
  child.once('exit', (code, signal) => observed.push(['exit', code, signal]));
  child._event('exit', 0, null);
  flush();
  assert.equal(child.listenerCount('exit'), 0);
  child.once('close', (code, signal) => observed.push(['close', code, signal]));
  assert.doesNotThrow(() => child._event('close', 0, null));
  flush();
  assert.deepEqual(observed, [['exit', 0, null], ['close', 0, null]]);
});

test('removeAllListeners no borra los eventos encolados ni altera su orden', t => {
  const { child, flush } = fixture(t);
  const observed = [];
  child.once('unused', () => assert.fail('listener retirado'));
  child._event('exit', 1, null);
  child._event('close', 1, null);
  child.removeAllListeners();
  child.once('exit', (code, signal) => observed.push(['exit', code, signal]));
  child.once('close', (code, signal) => observed.push(['close', code, signal]));
  flush();
  assert.deepEqual(observed, [['exit', 1, null], ['close', 1, null]]);
});

test('el tail real del launcher entrega eventos tempranos sólo después de retornar', t => {
  const { child, scheduled, flush } = fixture(t, false);
  const observed = [];
  child._event('exit', 0, null);
  assert.equal(scheduled.length, 0);
  child.once('exit', (code, signal) => observed.push(['exit', code, signal]));
  assert.equal(runInNewContext(`(child => { ${launcherTail} })(child)`, { child }), child);
  assert.deepEqual(observed, []);
  flush();
  assert.deepEqual(observed, [['exit', 0, null]]);
});

test('el owner de error conserva la identidad original y su listener', t => {
  const { child, flush } = fixture(t);
  const error = Object.assign(new Error('bounded test failure'), { code: 'ERR_SIGNAL_CONTROLLER' });
  const observed = [];
  const owner = value => observed.push(value);
  child.on('error', owner);
  child._event('error', error);
  flush();
  assert.equal(observed.length, 1);
  assert.equal(observed[0], error);
  assert.deepEqual(child.listeners('error'), [owner]);
});

test('un error sin owner sigue lanzando el mismo error de EventEmitter', t => {
  const { child, flush } = fixture(t);
  const error = new Error('unowned test failure');
  child._event('error', error);
  assert.throws(flush, value => value === error);
});
