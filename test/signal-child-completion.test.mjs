import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { controllerFailure } from './helpers/signal-child.mjs';

// Portable contract tests: actual class/poll/events, not Windows runtime proof.
const source = readFileSync(new URL('./helpers/signal-child.mjs', import.meta.url), 'utf8');
const start = source.indexOf('class WindowsSignalChild extends EventEmitter {');
const end = source.indexOf('export async function launchSignalChild(', start);
assert.ok(start >= 0 && end > start);
const requestName = runInNewContext(`(${source.match(/function requestName\([^]*?\n\}/)[0]})`);
const launchId = '01234567-89ab-cdef-0123-456789abcdef';
const identity = { launchId, targetPid: process.pid + 1000,
  controllerPid: process.pid + 2000, creationTime: '134000000000000001' };
const exit = (exitCode = 0, state = 'exiting') => ({ ...identity, exitCode, state });

function fixture(t, exitCode = 0) {
  const files = new Map([['ready.json', identity], ['exit.json', exit(exitCode)],
    ['complete.json', exit(exitCode, 'complete')]]);
  const reads = [], writes = [], removed = [], scheduled = [], timers = [], errors = [], events = [];
  const ActualChild = runInNewContext(`(${source.slice(start, end).trim()})`, {
    EventEmitter, PassThrough, process, controllers: new WeakMap(), limit: 10000,
    controllerFailure, requestName,
    signals: runInNewContext(`${source.match(/const signals = .*;/)[0]} signals`),
    fault: message => Object.assign(new Error(message), { code: 'ERR_SIGNAL_CONTROLLER' }),
    jsonFile: async (directory, name) => {
      assert.equal(directory, 'owned-directory');
      reads.push(name);
      const value = files.get(name);
      return typeof value === 'function' ? value() : value ?? null;
    },
    atomicJson: (directory, name, value) => writes.push({ directory, name, value }),
    rm: async (directory, options) => removed.push({ directory, options }),
    setTimeout: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
    setImmediate: callback => scheduled.push(callback),
  });
  const poll = ActualChild.prototype._poll;
  ActualChild.prototype._poll = async () => {}; // Constructor only: no native IO.
  const controller = new EventEmitter();
  controller.pid = identity.controllerPid;
  for (const name of ['stdin', 'stdout', 'stderr']) controller[name] = new PassThrough();
  const child = new ActualChild(controller, 'owned-directory', launchId);
  ActualChild.prototype._poll = poll;
  child._returned = true;
  const owner = error => errors.push(error);
  child.on('error', owner);
  for (const name of ['exit', 'close']) child.on(name, (code, signal) => events.push([name, code, signal]));
  t.after(() => {
    for (const stream of [controller.stdin, controller.stdout, controller.stderr, child.stdout, child.stderr]) stream.destroy();
  });
  const step = async () => {
    await child._poll();
    while (scheduled.length) scheduled.shift()();
  };
  const finish = async (code = 0, signal = null) => {
    controller.emit('close', code, signal);
    await step();
    assert.ok(!reads.includes('complete.json'), 'first closed poll only establishes stable reports');
    await step();
  };
  const failed = () => {
    assert.equal(errors.length, 1);
    assert.equal(errors[0], child._failure, 'original error identity reaches its owner');
    assert.equal(errors[0].code, 'ERR_SIGNAL_CONTROLLER');
    assert.deepEqual(child.listeners('error'), [owner]);
    const cancellations = writes.filter(write => write.name === 'cancel.json');
    assert.equal(cancellations.length, 1);
    assert.equal(cancellations[0].directory, 'owned-directory');
    assert.equal(cancellations[0].value.launchId, launchId);
  };
  return { child, files, reads, removed, timers, errors, events, step, finish, failed };
}

for (const code of [0, 1]) test(`immutable early exit ${code} precedes close; completion is read only when stable`, async t => {
  const f = fixture(t, code);
  await f.step();
  assert.deepEqual(f.events, [['exit', code, null]]);
  assert.equal(f.child.stdin.writableEnded, true);
  await f.step();
  assert.ok(!f.reads.includes('complete.json'));
  await f.finish();
  assert.equal(f.reads.filter(name => name === 'complete.json').length, 1);
  assert.deepEqual(f.events, [['exit', code, null], ['close', code, null]]);
  assert.equal(f.child.exitCode, code);
  assert.equal(f.child.signalCode, null);
  assert.deepEqual(f.errors, []);
  assert.equal(f.removed.length, 1);
  assert.equal(f.removed[0].directory, 'owned-directory');
  assert.equal(f.removed[0].options.recursive, true);
  assert.equal(f.removed[0].options.force, true);
  assert.deepEqual(f.timers.slice(1).map(timer => timer.delay), [10, 10, 10]);
  assert.equal(f.timers[0].cleared, true);
});

test('ready is reread when a short-lived target publishes identity between reads', async t => {
  const f = fixture(t);
  let count = 0;
  f.files.set('ready.json', () => ++count === 1 ? null : identity);
  await f.step();
  assert.equal(count, 2);
  assert.equal(f.child.pid, identity.targetPid);
  await f.finish();
  assert.deepEqual(f.errors, []);
});

const invalid = [
  ['missing completion, even with legacy complete exit', null, /exited unexpectedly/],
  ['wrong state', { state: 'exiting' }, /exited unexpectedly/],
  ['wrong launch', { launchId: 'other' }, /exit identity/],
  ['wrong target', { targetPid: identity.targetPid + 1 }, /exit identity/],
  ['wrong FILETIME', { creationTime: '134000000000000002' }, /exit identity/],
  ['changed code', { exitCode: 1 }, /status changed/],
  ['noninteger code', { exitCode: 0.5 }, /exit identity/],
];
for (const [name, patch, message] of invalid) test(`completion rejects ${name}`, async t => {
  const f = fixture(t);
  if (patch === null) f.files.set('exit.json', exit(0, 'complete'));
  f.files.set('complete.json', patch === null ? null : { ...exit(0, 'complete'), ...patch });
  await f.step();
  await f.finish();
  f.failed();
  assert.match(f.errors[0].message, message);
  assert.equal(f.child.exitCode, 0);
  assert.deepEqual(f.events, [['exit', 0, null], ['close', 0, null]]);
  assert.equal(f.removed.length, 1);
});

for (const [code, signal] of [[1, null], [0, 'SIGTERM']]) test(`completion cannot hide controller close ${code}/${signal}`, async t => {
  const f = fixture(t);
  await f.step();
  await f.finish(code, signal);
  f.failed();
});

test('recovery completion cannot erase the original bounded controller error', async t => {
  const f = fixture(t);
  f.files.set('error.json', { launchId, code: 'NATIVE_CONTROLLER_FAILURE', phase: 'complete-publish',
    publishFailure: { operation: 'replace', kind: 'win32', nativeCode: 5 } });
  await f.step();
  const original = f.child._failure;
  await f.finish(1);
  f.failed();
  assert.equal(f.errors[0], original);
  assert.equal(original.message, 'Native signal controller failed (phase: complete-publish); publish: replace/win32/5');
});

for (const kind of ['interrupt', 'missing', 'wrong identity', 'wrong operation']) test(`completion preserves ACK checks: ${kind}`, async t => {
  const f = fixture(t);
  f.files.delete('exit.json');
  await f.step();
  let receipt;
  if (kind === 'interrupt') receipt = f.child.interrupt();
  else assert.equal(f.child.kill('SIGTERM'), true);
  const ack = { ...identity, sequence: 1, ok: true, operation: kind === 'interrupt' ? 'interrupt' : 'terminate',
    nativeOperation: 'TerminateProcess', event: 'CTRL_C_EVENT', consolePids: [identity.targetPid, identity.controllerPid] };
  if (kind === 'wrong identity') ack.creationTime = '1';
  if (kind === 'wrong operation') ack.nativeOperation = 'other';
  if (kind !== 'missing') f.files.set('ack-0000000001.json', ack);
  f.files.set('exit.json', exit());
  await f.step();
  if (receipt) assert.equal((await receipt).event, 'CTRL_C_EVENT');
  await f.finish();
  if (kind === 'interrupt') {
    assert.deepEqual(f.errors, []);
    assert.equal(f.child._acknowledged, 1);
  } else f.failed();
});

test('PowerShell attempts each immutable exit/completion publication at most once across normal/finally', () => {
  const ps = readFileSync(new URL('./helpers/windows-signal-child.ps1', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const runtime = ps.slice(ps.indexOf('$hostTransport = $null'));
  for (const [flag, file] of [['exitPublicationAttempted', 'exit.json'], ['completionPublicationAttempted', 'complete.json']]) {
    const initialized = runtime.indexOf(`$${flag} = $false`);
    assert.ok(initialized >= 0 && initialized < runtime.indexOf('\ntry {'));
    assert.equal((runtime.match(new RegExp(`\\$${flag} = \\$false`, 'g')) ?? []).length, 1);
    assert.equal((runtime.match(new RegExp(`\\$${flag} = \\$true`, 'g')) ?? []).length, 2);
    assert.equal((runtime.match(new RegExp(`Publish '${file.replace('.', '\\.')}'`, 'g')) ?? []).length, 2);
    assert.match(runtime, new RegExp(`\\$${flag} = \\$true\\s+Publish '${file.replace('.', '\\.')}' \\$nativeExit`));
    assert.match(runtime, new RegExp(`if \\(!\\$${flag}\\) \\{\\s*\\$${flag} = \\$true\\s+Publish '${file.replace('.', '\\.')}' \\$cleanupExit\\s*\\}`));
  }
  assert.match(runtime, /Publish 'exit.json' \$nativeExit\s+\$phase = 'output-drain'\s+\$hostTransport.Drain\(\)\s+\$nativeExit.state = 'complete'/);
  assert.match(runtime, /\$hostTransport.StopAndWait\(\)/);
  assert.match(runtime, /\$hostTransport.Drain\(\)\s+\$cleanupExit.state = 'complete'/);
  assert.match(runtime, /\$hostTransport.Dispose\(\)/);
  assert.match(runtime, /if \(\$failed\) \{ exit 1 \}\s+exit 0/);
});
