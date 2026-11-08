import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeChrome, findChrome, openChromePage } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('Chrome opens a usable page and close removes its profile once', { timeout: 30000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome is not available');
  const chrome = await openChromePage(bin, 'about:blank');
  t.after(() => closeChrome(chrome));
  assert.equal(await evaluateChrome(chrome.cdp, '1 + 1'), 2);
  assert.equal((await fs.stat(chrome.profile)).isDirectory(), true);
  let closed = false;
  chrome.child.once('close', () => { closed = true; });
  await Promise.all([closeChrome(chrome), closeChrome(chrome)]);
  assert.equal(closed, true, 'process streams are closed before cleanup returns');
  assert.ok(chrome.child.exitCode !== null || chrome.child.signalCode !== null);
  await assert.rejects(fs.stat(chrome.profile), { code: 'ENOENT' });
  await closeChrome(chrome);
});

test('close escalates when a process ignores SIGTERM and closes CDP once', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  });
  await once(child, 'message');
  let cdpCloses = 0, closed = false;
  child.once('close', () => { closed = true; });
  const chrome = { child, cdp: { close: () => { cdpCloses++; } } };
  await Promise.all([closeChrome(chrome), closeChrome(chrome)]);
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal(closed, true);
  await closeChrome(chrome);
  assert.equal(cdpCloses, 1);
});

test('close waits for process streams when exit has already happened', async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: 0, signalCode: null, connected: false,
    stdio: [null, null, { closed: false }],
    kill: () => assert.fail('an exited process must not be killed again'),
  });
  let finished = false, cdpCloses = 0;
  const chrome = { child, cdp: { close: () => { cdpCloses++; } } };
  const closing = closeChrome(chrome).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(cdpCloses, 1);
    assert.equal(finished, false, 'exit alone does not mean the streams are closed');
  } finally {
    child.stdio[2].closed = true;
    child.emit('close');
    await closing;
  }
  assert.equal(finished, true);
});

test('close also handles a process that closed before tracking', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'close');
  await closeChrome({ child });
  assert.equal(child.exitCode, 0);
});

test('profile cleanup requests retries and never throws on ENOTEMPTY', async t => {
  const calls = [];
  t.mock.method(fs, 'rm', async (...args) => {
    calls.push(args);
    throw Object.assign(new Error('profile is still in use'), { code: 'ENOTEMPTY' });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const profile = path.join(tmpdir(), 'unused-chrome-profile');
  await closeChrome({ profile });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], profile);
  assert.equal(calls[0][1].recursive, true);
  assert.equal(calls[0][1].force, true);
  assert.ok(calls[0][1].maxRetries > 0);
  assert.ok(calls[0][1].retryDelay > 0);
});

test('failed Chrome startup removes the allocated profile', { timeout: 15000 }, async t => {
  const originalMkdtemp = fs.mkdtemp;
  let profile;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    profile = await originalMkdtemp(...args);
    return profile;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (profile) await fs.rm(profile, { recursive: true, force: true });
  });
  const missing = path.join(tmpdir(), `missing-chrome-${randomUUID()}`, 'chrome');
  await assert.rejects(openChromePage(missing, 'about:blank'), { code: 'ENOENT' });
  assert.ok(profile);
  await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
});

test('failed navigation closes an established Chrome and removes its profile', { timeout: 30000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome is not available');
  const originalMkdtemp = fs.mkdtemp;
  let profile;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    profile = await originalMkdtemp(...args);
    return profile;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (profile) await fs.rm(profile, { recursive: true, force: true });
  });
  await assert.rejects(openChromePage(bin, 'http://[invalid'));
  assert.ok(profile);
  await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
});
