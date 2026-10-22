import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';

const windows = process.platform === 'win32';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const argument = 'synthetic 雪 "quoted" C:\\space directory\\tail\\';
const stderrBytes = Buffer.from([0x52, 0x45, 0x41, 0x44, 0x59, 0x00, 0xff, 0x0d, 0x0a]);

// A fixture, not an emulated signal transport: only OS-delivered handlers initiate shutdown.
// Atomic files are barriers/observations, never requests to execute a signal handler.
const drainingFixture = String.raw`
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = process.argv[2];
  const publish = (name, data) => {
    const file = path.join(directory, name + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  };
  const identity = { pid: process.pid, argument: process.argv[1],
    label: process.env.SIGNAL_CHILD_TEST_LABEL, cwd: process.cwd() };
  let input = Buffer.alloc(0), pending = null, shuttingDown = false;
  const counts = { SIGINT: 0, SIGTERM: 0 };
  const watchdog = setTimeout(() => process.exit(91), 20000);
  const finish = () => {
    if (!shuttingDown || pending) return;
    clearInterval(poll);
    clearTimeout(watchdog);
    process.exitCode = 0;
  };
  const poll = setInterval(() => {
    if (pending && fs.existsSync(path.join(directory, 'release'))) {
      process.stdout.write(pending);
      pending = null;
      publish('drained', { pid: process.pid });
      finish();
    }
  }, 10);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shuttingDown = true;
      publish(signal, { pid: process.pid, signal, calls: ++counts[signal] });
      finish();
    });
  }
  process.stdin.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    let newline;
    while ((newline = input.indexOf(10)) !== -1) {
      const frame = input.subarray(0, newline + 1);
      input = input.subarray(newline + 1);
      const request = JSON.parse(frame.toString('utf8'));
      const response = Buffer.from(JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: request.params,
      }) + '\r\n');
      if (request.method === 'pending') {
        pending = response;
        publish('pending', { pid: process.pid, id: request.id });
      } else {
        process.stdout.write(response);
      }
    }
  });
  process.stdin.on('end', () => {
    publish('eof', { pid: process.pid, trailingBytes: input.length });
    // EOF is not parent loss: pending work still belongs to this process.
    finish();
  });
  process.stderr.write(Buffer.from([0x52, 0x45, 0x41, 0x44, 0x59, 0x00, 0xff, 0x0d, 0x0a]));
  publish('ready', identity);
`;

async function observeFile(directory, name, child, predicate = () => true) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, `${name}.json`), 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.equal(child.exitCode, null, `Child exited before ${name}`);
    assert.equal(child.signalCode, null, `Child was killed before ${name}`);
    await pause(20);
  }
  assert.fail(`Timed out waiting for ${name}`);
}

function observeChild(child) {
  const stdout = [], stderr = [], events = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.on('exit', (code, signal) => events.push(['exit', code, signal]));
  child.on('close', (code, signal) => events.push(['close', code, signal]));
  const closed = once(child, 'close');
  // Observe early controller/spawn failures without an unhandled rejection.
  closed.catch(() => {});
  return { closed, events, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr) };
}

async function setup(t, script = drainingFixture) {
  const directory = await mkdtemp(path.join(tmpdir(), 'egdev-signal-child-'));
  let child, observation;
  t.after(async () => {
    try {
      if (child?.exitCode === null && child.signalCode === null) {
        assert.equal(child.kill('SIGKILL'), true, 'Cleanup must target the owned child');
      }
      if (observation) {
        let timer;
        try {
          await Promise.race([
            observation.closed,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Owned child cleanup timed out')), 10000);
            }),
          ]);
        } finally { clearTimeout(timer); }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  child = await launchSignalChild(process.execPath, ['-e', script, '--', argument, directory], {
    cwd: directory,
    env: { ...process.env, SIGNAL_CHILD_TEST_LABEL: 'synthetic-label' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  observation = observeChild(child);
  if (!windows) assert.ok(child instanceof ChildProcess, 'Unix must retain the native spawn result');
  assert.ok(Number.isInteger(child.pid) && child.pid > 0);
  assert.notEqual(child.pid, process.pid, 'Runner must never be the target');
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  return { child, directory, ...observation };
}

async function ready(f) {
  const identity = await observeFile(f.directory, 'ready', f.child);
  assert.deepEqual(identity, {
    pid: f.child.pid, argument, label: 'synthetic-label', cwd: f.directory,
  });
}

function assertNativeInterrupt(receipt, child, signal) {
  if (windows) {
    // API contract: interrupt returns private-control acknowledgement, not stdout metadata.
    assert.equal(receipt.event, 'CTRL_C_EVENT');
    assert.equal(receipt.targetPid, child.pid);
    assert.ok(Number.isInteger(receipt.controllerPid) && receipt.controllerPid > 0);
    assert.notEqual(receipt.controllerPid, child.pid);
    assert.notEqual(receipt.controllerPid, process.pid);
    assert.deepEqual([...receipt.consolePids].sort((a, b) => a - b),
      [child.pid, receipt.controllerPid].sort((a, b) => a - b));
  } else {
    assert.ok(['SIGINT', 'SIGTERM'].includes(signal));
    // Unix must use ChildProcess.kill; its handler marker observes delivery, not Windows proof.
  }
}

async function assertExited(f, expectedCode) {
  const [code, signal] = await f.closed;
  assert.equal(code, expectedCode);
  assert.equal(signal, null);
  assert.equal(f.child.exitCode, expectedCode);
  assert.equal(f.child.signalCode, null);
  assert.deepEqual(f.events, [['exit', expectedCode, null], ['close', expectedCode, null]]);
  assert.throws(() => process.kill(f.child.pid, 0), { code: 'ESRCH' });
}

const params = { text: 'synthetic 雪 \\ "quoted" \u0000' };
const frame = (id, method) => Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\r\n`);
const response = id => Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result: params })}\r\n`);

async function pending(f) {
  const request = frame(2, 'pending');
  f.child.stdin.write(request);
  assert.deepEqual(await observeFile(f.directory, 'pending', f.child), { pid: f.child.pid, id: 2 });
  return response(2);
}

async function noMarker(f, signal) {
  await assert.rejects(readFile(path.join(f.directory, `${signal}.json`)), { code: 'ENOENT' });
}

test('signal child preserves raw pipes and drains after repeated native Ctrl+C/SIGINT and stdin EOF',
  { timeout: 35000 }, async t => {
    const f = await setup(t);
    await ready(f);
    const echo = frame(1, 'echo');
    // Split inside a UTF-8 codepoint: transport must pump bytes, not independently decoded strings.
    const split = echo.indexOf(Buffer.from('雪')) + 1;
    f.child.stdin.write(echo.subarray(0, split));
    f.child.stdin.write(echo.subarray(split));
    const work = await pending(f);
    const receipt = await interruptSignalChild(f.child, 'SIGINT');
    assertNativeInterrupt(receipt, f.child, 'SIGINT');
    assert.deepEqual(await observeFile(f.directory, 'SIGINT', f.child),
      { pid: f.child.pid, signal: 'SIGINT', calls: 1 });
    assertNativeInterrupt(await interruptSignalChild(f.child, 'SIGINT'), f.child, 'SIGINT');
    assert.deepEqual(await observeFile(f.directory, 'SIGINT', f.child, value => value.calls === 2),
      { pid: f.child.pid, signal: 'SIGINT', calls: 2 });
    f.child.stdin.end();
    assert.deepEqual(await observeFile(f.directory, 'eof', f.child),
      { pid: f.child.pid, trailingBytes: 0 });
    assert.equal(f.child.exitCode, null, 'EOF/interrupt must not abandon pending work');
    assert.equal(f.child.signalCode, null);
    await noMarker(f, 'SIGTERM');
    await writeFile(path.join(f.directory, 'release'), 'release');
    await assertExited(f, 0);
    if (windows) assert.throws(() => process.kill(receipt.controllerPid, 0), { code: 'ESRCH' });
    assert.deepEqual(f.stdout(), Buffer.concat([response(1), work]));
    assert.deepEqual(f.stderr(), stderrBytes, 'No controller metadata may pollute stderr');
    assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'drained.json'), 'utf8')),
      { pid: f.child.pid });
  });

test('kill(SIGTERM) is forced native termination on Windows, but a real graceful OS signal on Unix',
  { timeout: 35000 }, async t => {
    const f = await setup(t);
    await ready(f);
    const work = await pending(f);
    f.child.stdin.end();
    await observeFile(f.directory, 'eof', f.child);
    if (windows) {
      await assert.rejects(interruptSignalChild(f.child, 'SIGTERM'), /unsupported|SIGTERM/i);
      assert.equal(f.child.exitCode, null, 'Unsupported interrupt must not kill the target');
      assert.equal(f.child.kill('SIGTERM'), true);
      const [code, signal] = await f.closed;
      assert.ok(Number.isInteger(code) && code > 0, 'Report actual native forced exit status');
      assert.equal(signal, null, 'A requested name is not an OS-delivered signal');
      assert.equal(f.child.exitCode, code);
      assert.equal(f.child.signalCode, null);
      assert.deepEqual(f.events, [['exit', code, null], ['close', code, null]]);
      assert.throws(() => process.kill(f.child.pid, 0), { code: 'ESRCH' });
      await noMarker(f, 'SIGTERM');
      await noMarker(f, 'SIGINT');
      await noMarker(f, 'drained');
      assert.deepEqual(f.stdout(), Buffer.alloc(0), 'Forced termination must not drain pending work');
    } else {
      assert.equal(f.child.kill('SIGTERM'), true);
      assert.deepEqual(await observeFile(f.directory, 'SIGTERM', f.child),
        { pid: f.child.pid, signal: 'SIGTERM', calls: 1 });
      assert.equal(f.child.exitCode, null);
      await noMarker(f, 'SIGINT');
      await writeFile(path.join(f.directory, 'release'), 'release');
      await assertExited(f, 0);
      assert.deepEqual(f.stdout(), work);
    }
    assert.deepEqual(f.stderr(), stderrBytes);
  });

// This exercises the real Windows controller, not a model of OpenProcess or
// GetProcessTimes. Native RED/GREEN remains pending until run on Windows.
async function assertMismatchedParentRejected(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'egdev-parent-identity-'));
  const launchId = randomUUID();
  const parentPid = process.pid;
  let host, observation, timedOut = false;
  async function waitForHost(onTimeout = () => {}) {
    let timer;
    try {
      return await Promise.race([
        observation.closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(new Error('Owned identity-test controller timed out'));
          }, 10000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  t.after(async () => {
    try {
      // Only the directly spawned, owned host may be killed, and only on timeout.
      // Never use a PID from reports/configuration as a cleanup kill target.
      if (timedOut && host?.exitCode === null && host.signalCode === null) {
        assert.equal(host.kill('SIGKILL'), true, 'Cleanup must target the owned controller');
        await waitForHost();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const controllerScript = fileURLToPath(new URL('./helpers/windows-signal-child.ps1', import.meta.url));
  host = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', controllerScript], {
    cwd: directory, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  observation = observeChild(host);
  // A startup/transport error is observed through the host's close/error promise.
  host.stdin.on('error', () => {});
  const script = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const watchdog = setTimeout(() => process.exit(91), 20000);
    const marker = path.join(process.argv[1], 'target-started.json');
    fs.writeFileSync(marker + '.tmp', JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    fs.renameSync(marker + '.tmp', marker);
    clearTimeout(watchdog);
    process.exitCode = 0;
  `;
  // Exactly one private configuration line, then ordinary EOF. '1' is a valid
  // FILETIME in 1601, but cannot identify this live Node harness's creation.
  host.stdin.end(`${JSON.stringify({
    executable: process.execPath, args: ['-e', script, '--', directory], cwd: directory,
    directory, launchId, parentPid, parentCreationTime: '1',
  })}\n`);
  const [code, signal] = await waitForHost(() => { timedOut = true; });
  assert.equal(code, 1, 'Mismatched parent identity must fail before launching a target');
  assert.equal(signal, null, 'Fail closed normally, not through an externally killed controller');
  assert.deepEqual(observation.events, [['exit', 1, null], ['close', 1, null]]);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'error.json'), 'utf8')),
    { launchId, code: 'NATIVE_CONTROLLER_FAILURE', phase: 'native-launch' });
  for (const name of ['target-started.json', 'ready.json', 'exit.json']) {
    await assert.rejects(readFile(path.join(directory, name)), { code: 'ENOENT' },
      `Wrong parent creation time must not publish ${name}`);
  }
  assert.deepEqual(observation.stdout(), Buffer.alloc(0));
  assert.deepEqual(observation.stderr(), Buffer.alloc(0));
  assert.equal(process.pid, parentPid);
  assert.equal(process.kill(parentPid, 0), true, 'The real harness parent must remain alive');
}

test('signal child reports normal native exit statuses 0 and 1 without treating stdin EOF as parent loss',
  { timeout: 35000 }, async t => {
    for (const code of [0, 1]) {
      const f = await setup(t, String.raw`
        const watchdog = setTimeout(() => process.exit(91), 20000);
        process.stdin.resume();
        process.stdin.on('end', () => {
          clearTimeout(watchdog);
          process.stdout.write(Buffer.from([0x00, 0xff, 0x0d, 0x0a]));
          process.stderr.write(Buffer.from([0xfe, 0x00]));
          process.exitCode = ${code};
        });
      `);
      f.child.stdin.end();
      await assertExited(f, code);
      assert.deepEqual(f.stdout(), Buffer.from([0x00, 0xff, 0x0d, 0x0a]));
      assert.deepEqual(f.stderr(), Buffer.from([0xfe, 0x00]));
    }
    // No skip and no Unix kernel claim: retain all normal-exit checks above on
    // every platform, then exercise native identity rejection only on Windows.
    if (windows) await assertMismatchedParentRejected(t);
  });
