import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import * as signalChild from './helpers/signal-child.mjs';

const source = readFileSync(new URL('./helpers/signal-child.mjs', import.meta.url), 'utf8');

test('Windows outer timeout accounts for two startup stages and app readiness per launch', () => {
  assert.equal(signalChild.WINDOWS_STARTUP_STAGE_MS, 30_000);
  assert.equal(typeof signalChild.windowsTimeout, 'function');
  for (const launches of [0, 1, 6]) {
    for (const scenarioMs of [4_000, 20_000]) {
      assert.equal(signalChild.windowsTimeout(launches, scenarioMs, 'win32'),
        launches * (2 * 30_000 + 10_000) + scenarioMs);
      for (const platform of ['linux', 'darwin']) {
        assert.equal(signalChild.windowsTimeout(launches, scenarioMs, platform), scenarioMs);
      }
    }
  }
  assert.equal(signalChild.windowsTimeout(1, 4_000),
    signalChild.windowsTimeout(1, 4_000, process.platform));
});

test('real parent identity query uses the Windows startup stage budget', async () => {
  const method = source.match(/function queryParentCreationTime\(options\) \{[^]*?\n\}/)?.[0];
  assert.ok(method);
  let captured;
  const query = runInNewContext(`(${method})`, {
    process, controllerScript: 'controller.ps1', limit: 10_000,
    WINDOWS_STARTUP_STAGE_MS: signalChild.WINDOWS_STARTUP_STAGE_MS,
    fault: message => new Error(message), parseParentCreationTime: signalChild.parseParentCreationTime,
    execFile: (executable, args, options, callback) => {
      captured = { executable, args, options };
      const stdin = new EventEmitter();
      stdin.end = () => queueMicrotask(() => callback(null, '123', ''));
      return { stdin };
    },
  });
  assert.equal(await query({ cwd: 'owned', env: {} }), '123');
  assert.equal(captured.executable, 'powershell.exe');
  assert.equal(captured.options.timeout, 30_000);
  assert.equal(captured.options.timeout, signalChild.WINDOWS_STARTUP_STAGE_MS);
  assert.equal(captured.options.maxBuffer, 128);
  assert.equal(captured.options.killSignal, 'SIGKILL');
});

test('real native startup timer uses the stage budget while control ACK remains 10 seconds', t => {
  const start = source.indexOf('class WindowsSignalChild extends EventEmitter {');
  const end = source.indexOf('export async function launchSignalChild(', start);
  assert.ok(start >= 0 && end > start);
  const timers = [];
  const ActualChild = runInNewContext(`(${source.slice(start, end).trim()})`, {
    EventEmitter, PassThrough, controllers: new WeakMap(), limit: 10_000,
    WINDOWS_STARTUP_STAGE_MS: signalChild.WINDOWS_STARTUP_STAGE_MS,
    signals: new Set(['SIGTERM']), atomicJson: () => {},
    requestName: runInNewContext(`(${source.match(/function requestName\([^]*?\n\}/)[0]})`),
    setTimeout: (_callback, delay) => { const timer = { delay }; timers.push(timer); return timer; },
    clearTimeout: () => {},
  });
  ActualChild.prototype._poll = async () => {};
  const controller = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) controller[name] = new PassThrough();
  const child = new ActualChild(controller, 'owned-directory', 'launch');
  t.after(() => {
    for (const stream of [controller.stdin, controller.stdout, controller.stderr, child.stdout, child.stderr]) stream.destroy();
  });
  assert.equal(timers[0].delay, 30_000);
  assert.equal(timers[0].delay, signalChild.WINDOWS_STARTUP_STAGE_MS);
  child._identity = { targetPid: 123, creationTime: '456' };
  assert.equal(child.kill('SIGTERM'), true);
  assert.equal(timers[1].delay, 10_000);
});
