// #47: clickWhen must not report success for a click on a disabled element. A disabled
// button ignores .click(); reporting success there made react-shortcuts wait 9 s for a
// message the ignored click never produced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { clickWhen, openChromePage } from './helpers/react-browser.mjs';

// Fake CDP: evaluates the expression in Node against globalThis.__btn instead of a page.
const fakeCdp = () => ({
  send: async (method, { expression }) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: new Function(`return ${expression}`)() } };
  },
});

function button({ enabledAfter }) {
  let evaluations = 0;
  const btn = { clicks: 0, ignoredClicks: 0, click() { if (this.disabled) this.ignoredClicks++; else this.clicks++; } };
  Object.defineProperty(btn, 'disabled', { get: () => evaluations <= enabledAfter });
  return { btn, tick: () => { evaluations++; return btn; } };
}

test('clickWhen waits for a disabled element to become enabled before clicking', async t => {
  const { btn, tick } = button({ enabledAfter: 2 });
  globalThis.__tick = tick;
  t.after(() => { delete globalThis.__tick; });
  assert.equal(await clickWhen(fakeCdp(), 'globalThis.__tick()', { tries: 10, ms: 1 }), true);
  assert.equal(btn.ignoredClicks, 0, 'no click lands on the disabled button');
  assert.equal(btn.clicks, 1, 'exactly one click once enabled');
});

test('clickWhen fails when the element never becomes enabled', async t => {
  const { btn, tick } = button({ enabledAfter: Infinity });
  globalThis.__tick = tick;
  t.after(() => { delete globalThis.__tick; });
  await assert.rejects(clickWhen(fakeCdp(), 'globalThis.__tick()', { tries: 3, ms: 1 }), /no se pudo hacer clic en: globalThis\.__tick\(\)/);
  assert.equal(btn.clicks + btn.ignoredClicks, 0, 'never clicked');
});

test('clickWhen clicks an enabled element on the first try', async t => {
  const { btn, tick } = button({ enabledAfter: 0 });
  globalThis.__tick = tick;
  t.after(() => { delete globalThis.__tick; });
  assert.equal(await clickWhen(fakeCdp(), 'globalThis.__tick()', { tries: 3, ms: 1 }), true);
  assert.equal(btn.clicks, 1);
});

for (const [exitCode, signal] of [[73, null], [null, 'SIGABRT']]) {
  test(`Chrome startup reports a bounded, sanitized stderr tail (${signal || 'exit'})`, async t => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null, signalCode: null, connected: false, stderr: new PassThrough(),
      kill: () => assert.fail('an exited child must not be killed'),
    });
    child.stdio = [null, null, child.stderr];
    const originalMkdtemp = fs.mkdtemp;
    let profile;
    t.mock.method(fs, 'mkdtemp', async (...args) => { profile = await originalMkdtemp(...args); return profile; });
    t.mock.method(childProcess, 'spawn', (_bin, _args, options) => {
      setImmediate(() => {
        // The old line must fall out of the tail, including when chunks cross its limit.
        child.stderr.write('No usable sandbox!\n' + 'a'.repeat(5000));
        child.stderr.write('\nPRIVATE_CANARY /private/path?token=SECRET_CANARY\n');
        child.stderr.write('Failed to connect to the bus: /private/path?token=SECRET_CANARY\n');
        child.stderr.end('Failed to bind /private/socket: File name too long\n');
        child.exitCode = exitCode; child.signalCode = signal;
        child.emit('close', exitCode, signal);
      });
      assert.equal(options.stdio[2], 'pipe');
      return child;
    });
    syncBuiltinESMExports();
    t.after(async () => {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (profile) await fs.rm(profile, { recursive: true, force: true });
    });
    await assert.rejects(openChromePage('fake-chrome', 'about:blank'), error => {
      assert.equal(error.startup.exitCode, exitCode);
      assert.equal(error.startup.signal, signal);
      assert.equal(error.startup.stderrTruncated, true);
      assert.match(error.startup.stderrTail, /File name too long/);
      assert.match(error.startup.stderrTail, /D-Bus connection failed/);
      assert.doesNotMatch(JSON.stringify(error.startup), /PRIVATE_CANARY|SECRET_CANARY|\/private|No usable sandbox/);
      assert.ok(JSON.stringify(error.startup).length <= 2000);
      assert.match(error.message, /Chrome exited during startup/);
      assert.doesNotMatch(error.message, /PRIVATE_CANARY|SECRET_CANARY|\/private/);
      return true;
    });
    assert.ok(profile);
    await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
  });
}
