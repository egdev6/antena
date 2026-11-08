import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const controllerScript = fileURLToPath(new URL('./windows-signal-child.ps1', import.meta.url));
const controllers = new WeakMap();
const limit = 10000;
export const WINDOWS_STARTUP_STAGE_MS = 30_000;

// Preserve the existing scenario budget on POSIX. Each Windows launch also
// needs an identity query, native startup, and time for the app's READY marker.
export function windowsTimeout(launches, scenarioMs, platform = process.platform) {
  return platform === 'win32'
    ? launches * (2 * WINDOWS_STARTUP_STAGE_MS + 10_000) + scenarioMs
    : scenarioMs;
}

const signals = new Set(['SIGINT', 'SIGTERM', 'SIGKILL']);
const fault = message => Object.assign(new Error(message), { code: 'ERR_SIGNAL_CONTROLLER' });

const controllerPhases = new Set(['configuration', 'startup-check', 'native-launch', 'ready-publish',
  'running-check', 'owner-input-check', 'request-read', 'request-validate',
  'interrupt', 'terminate', 'ack-publish', 'rejected-ack-publish',
  'exit-status', 'exit-publish', 'output-drain', 'complete-publish', 'poll-wait']);

const publishNativeCodes = new Set([2, 3, 5, 6, 8, 14, 17, 19, 21, 32, 33, 80, 87, 112, 123, 145, 183, 206, 995]);
const publishWriteKinds = new Set(['io', 'access', 'security', 'argument', 'unsupported', 'unknown']);

function publishFailureSuffix(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      !['operation', 'kind', 'nativeCode'].every(key => Object.hasOwn(value, key))) return '';
  const { operation, kind, nativeCode } = value;
  const paired = (operation === 'replace' && kind === 'win32') ||
    (operation === 'write' && publishWriteKinds.has(kind) && (kind !== 'unknown' || nativeCode === null));
  if (!paired || (nativeCode !== null &&
      (!Number.isInteger(nativeCode) || !publishNativeCodes.has(nativeCode)))) return '';
  return `; publish: ${operation}/${kind}/${nativeCode ?? 'unknown'}`;
}

// Only fixed metadata for this launch reaches the error; never copy an exception.
export function controllerFailure(report, expectedLaunchId) {
  const valid = typeof expectedLaunchId === 'string' && expectedLaunchId.length > 0 &&
    report?.launchId === expectedLaunchId && report?.code === 'NATIVE_CONTROLLER_FAILURE';
  const phase = valid && controllerPhases.has(report.phase) ? report.phase : 'unknown';
  const suffix = phase === 'complete-publish' ? publishFailureSuffix(report.publishFailure) : '';
  return fault(`Native signal controller failed (phase: ${phase})${suffix}`);
}

export function parseParentCreationTime(value) {
  // Compare bounded decimal strings, never round FILETIME ticks through Number.
  if (typeof value !== 'string' || value.length === 0 || value.length > 20 ||
      value[0] === '0' || /[^0-9]/.test(value) ||
      (value.length === 20 && value > '18446744073709551615')) {
    throw new TypeError('Invalid parent creation time');
  }
  return value;
}

function queryParentCreationTime(options) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(fault('Parent identity query failed'));
    try {
      // A separate read-only process: its buffered metadata never touches app stdio.
      // execFile owns timeout/overflow termination; no native target exists yet.
      const query = execFile('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', controllerScript,
        '-ParentIdentityPid', String(process.pid),
      ], {
        cwd: options.cwd, env: options.env, windowsHide: true, shell: false,
        encoding: 'utf8', timeout: WINDOWS_STARTUP_STAGE_MS, maxBuffer: 128, killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        if (error || stderr.length !== 0) { failed(); return; }
        try { resolve(parseParentCreationTime(stdout)); }
        catch { failed(); }
      });
      query.stdin.on('error', () => {});
      query.stdin.end();
    } catch { failed(); }
  });
}

function atomicJson(directory, name, value) {
  const destination = path.join(directory, name);
  writeFileSync(`${destination}.tmp`, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  renameSync(`${destination}.tmp`, destination);
}

async function jsonFile(directory, name) {
  try { return JSON.parse(await readFile(path.join(directory, name), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw fault('Invalid controller report'); }
}

function requestName(sequence, prefix) {
  return `${prefix}-${String(sequence).padStart(10, '0')}.json`;
}

// A deliberately small ChildProcess-like surface. Signals and native status never come
// from the PowerShell process's exit fields; that process is just the owned controller.
class WindowsSignalChild extends EventEmitter {
  constructor(controller, directory, launchId) {
    super();
    this.stdin = controller.stdin;
    // Buffer early bytes until the async launcher returns, including a fast native exit.
    this.stdout = controller.stdout.pipe(new PassThrough());
    this.stderr = controller.stderr.pipe(new PassThrough());
    this.stdio = [this.stdin, this.stdout, this.stderr];
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this._controller = controller;
    this._directory = directory;
    this._launchId = launchId;
    this._sequence = 0;
    this._acknowledged = 0;
    this._pending = new Map();
    this._operations = new Map();
    this._eventQueue = [];
    this._startupObservations = 0;
    this._startupPhaseRank = -1;
    this._nextStartupObservation = 0;
    this._startupObservationInFlight = false;
    this._ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    controller.once('error', () => this._fail(fault('Signal controller could not start')));
    controller.stdout.on('error', () => this._fail(fault('Controller output transport failed')));
    controller.stderr.on('error', () => this._fail(fault('Controller error transport failed')));
    controller.once('close', (code, signal) => { this._controllerClosed = { code, signal }; });
    // A forced child exit can close the native input pipe before this writer finishes.
    // Other controller failures are observed through its private report/close event.
    this.stdin.on('error', () => {});
    controllers.set(this, this);
    this._startupTimer = setTimeout(() => this._fail(this._startupTimeout()), WINDOWS_STARTUP_STAGE_MS);
    void this._poll();
  }

  _startupTimeout() {
    // Re-whitelist even the cached value; no hint is evidence of completed work.
    const suffix = ['startup-check', 'native-launch', 'ready-publish'].includes(this._startupPhase)
      ? ` (phase: ${this._startupPhase})` : '';
    return fault(`Native startup timed out${suffix}`);
  }

  _observeStartup() {
    const now = Date.now();
    if (this._identity || this._failure || this._startupObservationInFlight ||
        this._startupObservations >= 100 || now < this._nextStartupObservation) return;
    this._startupObservationInFlight = true;
    this._startupObservations++;
    this._nextStartupObservation = now + 100;
    const phases = ['startup-check', 'native-launch', 'ready-publish'];
    // Separate best-effort parsing: never await diagnostic IO on the control path.
    void Promise.all(phases.map(async phase => {
      try {
        const value = JSON.parse(await readFile(path.join(this._directory, `startup-${phase}.json`), 'utf8'));
        if (this._identity || this._failure || !value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== 2 || !Object.hasOwn(value, 'launchId') || !Object.hasOwn(value, 'phase') ||
            value.launchId !== this._launchId || value.phase !== phase) return;
        const rank = phases.indexOf(phase);
        if (rank > this._startupPhaseRank) {
          this._startupPhaseRank = rank;
          this._startupPhase = phase;
        }
      } catch { /* Missing, partial, foreign or unreadable hints remain unknown. */ }
    })).finally(() => { this._startupObservationInFlight = false; }).catch(() => {});
  }

  _event(...event) {
    if (event.length) this._eventQueue.push(event);
    if (this._eventScheduled || !this._returned) return;
    this._eventScheduled = true;
    setImmediate(() => {
      this._eventScheduled = false;
      for (const args of this._eventQueue.splice(0)) this.emit(...args);
    });
  }

  _fail(error) {
    if (this._failure) return;
    this._failure = error;
    clearTimeout(this._startupTimer);
    for (const operation of this._operations.values()) clearTimeout(operation.timer);
    if (this._returned) this._event('error', error);
    else this._rejectReady(error);
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
    // Cancellation is control-plane only. EOF by itself is NEVER cancellation.
    try { atomicJson(this._directory, 'cancel.json', { launchId: this._launchId }); }
    catch { /* Controller close/report remains observable if the private directory failed. */ }
  }

  _recordExit(report) {
    if (!this._identity || report.launchId !== this._launchId ||
        report.targetPid !== this._identity.targetPid ||
        report.creationTime !== this._identity.creationTime ||
        !Number.isInteger(report.exitCode) || report.exitCode < 0 || report.exitCode > 0xffffffff) {
      throw fault('Invalid native exit identity');
    }
    if (this.exitCode !== null) {
      if (this.exitCode !== report.exitCode) throw fault('Native exit status changed');
      return;
    }
    this.exitCode = report.exitCode;
    this._event('exit', this.exitCode, null);
    // Unblock the controller's input pump even when the caller did not end stdin.
    if (!this.stdin.destroyed && !this.stdin.writableEnded) this.stdin.end();
  }

  _recordReady(ready) {
    if (!ready || this._identity) return;
    if (ready.launchId !== this._launchId || !Number.isInteger(ready.targetPid) ||
        ready.targetPid <= 0 || ready.targetPid === process.pid ||
        ready.controllerPid !== this._controller.pid || ready.targetPid === ready.controllerPid ||
        typeof ready.creationTime !== 'string' || !/^\d+$/.test(ready.creationTime)) {
      throw fault('Invalid native startup identity');
    }
    this._identity = Object.freeze(ready);
    this.pid = ready.targetPid;
    clearTimeout(this._startupTimer);
    this._resolveReady(this);
  }

  async _poll() {
    try {
      this._observeStartup?.();
      this._recordReady(await jsonFile(this._directory, 'ready.json'));
      const report = await jsonFile(this._directory, 'error.json');
      if (report) this._fail(controllerFailure(report, this._launchId));
      const exit = await jsonFile(this._directory, 'exit.json');
      if (exit) {
        // A short-lived target may publish READY between our first read and this exit read.
        if (!this._identity) this._recordReady(await jsonFile(this._directory, 'ready.json'));
        this._recordExit(exit);
      }
      while (this._acknowledged < this._sequence) {
        const sequence = this._acknowledged + 1;
        const ack = await jsonFile(this._directory, requestName(sequence, 'ack'));
        if (!ack) break;
        if (ack.launchId !== this._launchId || ack.sequence !== sequence ||
            ack.targetPid !== this._identity?.targetPid ||
            ack.creationTime !== this._identity?.creationTime) throw fault('Invalid control acknowledgement');
        const operation = this._operations.get(sequence);
        if (!operation || ack.operation !== operation.name ||
            (ack.ok && operation.name === 'terminate' && ack.nativeOperation !== 'TerminateProcess')) {
          throw fault('Invalid native operation acknowledgement');
        }
        clearTimeout(operation.timer);
        this._operations.delete(sequence);
        this._acknowledged = sequence;
        const pending = this._pending.get(sequence);
        this._pending.delete(sequence);
        if (pending) clearTimeout(pending.timer);
        if (!ack.ok) {
          const error = fault('Native signal request was rejected');
          if (pending) pending.reject(error);
          else this._fail(error);
        } else if (pending) {
          const expected = [this.pid, this._identity.controllerPid].sort((a, b) => a - b);
          if (ack.event !== 'CTRL_C_EVENT' || !Array.isArray(ack.consolePids) ||
              ack.consolePids.length !== 2 ||
              [...ack.consolePids].sort((a, b) => a - b).some((pid, index) => pid !== expected[index])) {
            pending.reject(fault('Unsafe console acknowledgement'));
            this._fail(fault('Unsafe console acknowledgement'));
          } else {
            pending.resolve({ event: ack.event, targetPid: ack.targetPid,
              controllerPid: this._identity.controllerPid, consolePids: ack.consolePids });
          }
        }
      }
      if (this._controllerClosed && !this._closedReportsStable) {
        // Controller close can arrive during any file read. One final poll starts with
        // all reports/acknowledgements immutable, avoiding mixed pre/post-close snapshots.
        this._closedReportsStable = true;
      } else if (this._controllerClosed) {
        clearTimeout(this._startupTimer);
        // Completion is separate from the immutable early exit snapshot, and is only
        // read after controller close makes every report stable.
        const finalExit = await jsonFile(this._directory, 'complete.json');
        if (finalExit) {
          if (!this._identity) this._recordReady(await jsonFile(this._directory, 'ready.json'));
          this._recordExit(finalExit);
        }
        if (this._acknowledged !== this._sequence) this._fail(fault('Unacknowledged native control request'));
        if (!finalExit || finalExit.state !== 'complete' || this._controllerClosed.code !== 0 ||
            this._controllerClosed.signal !== null) this._fail(fault('Signal controller exited unexpectedly'));
        for (const pending of this._pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(fault('Target exited before control acknowledgement'));
        }
        this._pending.clear();
        await rm(this._directory, { recursive: true, force: true });
        this._event('close', this.exitCode, null);
        return;
      }
    } catch (error) {
      this._fail(error.code === 'ERR_SIGNAL_CONTROLLER' ? error : fault('Signal controller transport failed'));
      if (this._controllerClosed) {
        try { await rm(this._directory, { recursive: true, force: true }); } catch { /* Already failed. */ }
        this._event('close', this.exitCode, null);
        return;
      }
    }
    this._timer = setTimeout(() => { void this._poll(); }, 10);
  }

  _request(operation) {
    if (this._failure || this.exitCode !== null || this._controllerClosed) return false;
    const sequence = this._sequence + 1;
    if (sequence > 0x7fffffff) throw fault('Native request sequence exhausted');
    atomicJson(this._directory, requestName(sequence, 'request'), {
      launchId: this._launchId, sequence, operation,
      targetPid: this._identity.targetPid, creationTime: this._identity.creationTime,
    });
    this._sequence = sequence;
    const timer = setTimeout(() => this._fail(fault('Native control acknowledgement timed out')), limit);
    this._operations.set(sequence, { name: operation, timer });
    return sequence;
  }

  kill(signal = 'SIGTERM') {
    if (!signals.has(signal)) throw new TypeError('Unsupported forced termination signal');
    const sequence = this._request('terminate');
    if (!sequence) return false;
    this.killed = true;
    // Only request acceptance is synchronous; native execution errors remain observable.
    return true;
  }

  interrupt() {
    let sequence;
    try { sequence = this._request('interrupt'); }
    catch { return Promise.reject(fault('Could not submit native interrupt')); }
    if (!sequence) return Promise.reject(fault('Native target is no longer available'));
    return new Promise((resolve, reject) => {
      this._pending.set(sequence, { resolve, reject });
    });
  }
}

export async function launchSignalChild(executable, args = [], options = {}) {
  if (process.platform !== 'win32') return spawn(executable, args, options);
  if (typeof executable !== 'string' || !executable || !Array.isArray(args) ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || executable.includes('\0')) {
    throw new TypeError('Expected executable and string arguments');
  }
  if (Object.keys(options).some(key => !['cwd', 'env', 'stdio', 'windowsHide'].includes(key)) ||
      (options.stdio !== undefined && (JSON.stringify(options.stdio) !== '["pipe","pipe","pipe"]'))) {
    throw new TypeError('Windows signal transport supports piped stdio, cwd and env only');
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const launchId = randomUUID();
  // Validate the byte limit before starting a controller that would otherwise wait for input.
  const launch = { executable, args, cwd, launchId, parentPid: process.pid };
  if (Buffer.byteLength(JSON.stringify(launch)) > 1040000) throw new TypeError('Launch configuration too large');
  // Only this still-running original Node can receive the result and proceed.
  // Capture identity BEFORE starting the controller, closing the PID-reuse gap.
  launch.parentCreationTime = await queryParentCreationTime(options);
  const directory = await mkdtemp(path.join(tmpdir(), 'egdev-signal-control-'));
  const config = JSON.stringify({ ...launch, directory });
  if (Buffer.byteLength(config) > 1048576) {
    await rm(directory, { recursive: true, force: true });
    throw new TypeError('Launch configuration too large');
  }
  let controller;
  try {
    controller = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', controllerScript], {
      cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw fault('Signal controller could not start');
  }
  const child = new WindowsSignalChild(controller, directory, launchId);
  controller.stdin.write(`${config}\n`);
  await child._ready;
  if (child._failure) throw child._failure;
  child._returned = true;
  child._eventScheduled = false;
  if (child._eventQueue.length) child._event();
  return child;
}

export async function interruptSignalChild(child, signal = 'SIGINT') {
  const controller = controllers.get(child);
  if (!controller) {
    if (process.platform === 'win32') throw new TypeError('Expected an owned Windows signal child');
    if (!['SIGINT', 'SIGTERM'].includes(signal)) throw new TypeError('Unsupported graceful signal');
    if (!child.kill(signal)) throw fault('OS signal target is no longer available');
    return;
  }
  if (signal !== 'SIGINT') {
    throw Object.assign(new Error('Unsupported Windows interrupt: only SIGINT uses native Ctrl+C'),
      { code: 'ERR_UNSUPPORTED_SIGNAL' });
  }
  return controller.interrupt();
}
