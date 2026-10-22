import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import * as signalChild from './helpers/signal-child.mjs';

const launchId = '01234567-89ab-cdef-0123-456789abcdef';
const phases = ['configuration', 'startup-check', 'native-launch', 'ready-publish',
  'running-check', 'owner-input-check', 'request-read', 'request-validate',
  'interrupt', 'terminate', 'ack-publish', 'rejected-ack-publish',
  'exit-status', 'exit-publish', 'output-drain', 'complete-publish', 'poll-wait'];
const report = phase => ({ launchId, code: 'NATIVE_CONTROLLER_FAILURE', phase });

const nativeCodes = [2, 3, 5, 6, 8, 14, 17, 19, 21, 32, 33, 80, 87, 112, 123, 145, 183, 206, 995];
const writeKinds = ['io', 'access', 'security', 'argument', 'unsupported', 'unknown'];
const withFailure = publishFailure => ({ ...report('complete-publish'), publishFailure });
const psSource = () => readFileSync(new URL('./helpers/windows-signal-child.ps1', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const csMethod = name => {
  const method = psSource().match(new RegExp(`    public static [^\\n]+ ${name}\\([^]*?\\n    \\}`))?.[0];
  assert.ok(method, `debe inspeccionarse el método C# real ${name}`);
  return method;
};

// Contrato del diagnóstico, no una reproducción de PowerShell/kernel Windows.
test('controller failure conserva código genérico y sólo muestra una fase fija del launch esperado', () => {
  assert.equal(typeof signalChild.controllerFailure, 'function');
  for (const phase of phases) {
    const error = signalChild.controllerFailure(report(phase), launchId);
    assert.ok(error instanceof Error);
    assert.equal(error.code, 'ERR_SIGNAL_CONTROLLER');
    assert.equal(error.message, `Native signal controller failed (phase: ${phase})`);
    assert.deepEqual(Object.keys(error), ['code']);
  }
});

test('controller failure trata metadatos ausentes, ajenos o no whitelisted como unknown', () => {
  const invalid = [null, undefined, false, 7, 'PRIVATE_CANARY', [], {},
    { launchId, code: 'NATIVE_CONTROLLER_FAILURE' },
    { ...report('output-drain'), launchId: 'otro-launch' },
    { ...report('output-drain'), code: 'PRIVATE_CANARY' },
    report('PRIVATE_CANARY'), report('toString'), report({ secret: 'PRIVATE_CANARY' })];
  for (const value of invalid) {
    const error = signalChild.controllerFailure(value, launchId);
    assert.equal(error.code, 'ERR_SIGNAL_CONTROLLER');
    assert.equal(error.message, 'Native signal controller failed (phase: unknown)');
  }
  assert.equal(signalChild.controllerFailure(report('output-drain'), '').message,
    'Native signal controller failed (phase: unknown)');
});

test('controller failure no copia excepciones, argumentos, entorno, PIDs ni rutas del reporte', () => {
  for (const base of [report('output-drain'),
    withFailure({ operation: 'replace', kind: 'win32', nativeCode: 32 })]) {
    const value = { ...base, message: 'PRIVATE_CANARY', error: 'PRIVATE_CANARY',
      exception: 'PRIVATE_CANARY', args: ['PRIVATE_CANARY'], env: { token: 'PRIVATE_CANARY' },
      pid: 987654, path: 'PRIVATE_CANARY', cause: 'PRIVATE_CANARY' };
    const error = signalChild.controllerFailure(value, launchId);
    assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, stack: error.stack }), /PRIVATE_CANARY|987654/);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), ['code']);
    assert.ok(error.message.length < 100);
  }
});

test('complete-publish admite únicamente operaciones, categorías y códigos acotados compatibles', () => {
  const valid = [
    ...[null, ...nativeCodes].map(nativeCode => ({ operation: 'replace', kind: 'win32', nativeCode })),
    ...writeKinds.flatMap(kind => (kind === 'unknown' ? [null] : [null, ...nativeCodes])
      .map(nativeCode => ({ operation: 'write', kind, nativeCode }))),
  ];
  for (const diagnostic of valid) {
    const error = signalChild.controllerFailure(withFailure(diagnostic), launchId);
    assert.equal(error.message, 'Native signal controller failed (phase: complete-publish)' +
      `; publish: ${diagnostic.operation}/${diagnostic.kind}/${diagnostic.nativeCode ?? 'unknown'}`);
    assert.equal(error.code, 'ERR_SIGNAL_CONTROLLER');
    assert.deepEqual(Object.keys(error), ['code']);
    assert.equal(error.cause, undefined);
  }
});

test('diagnóstico incompleto, incompatible o con campos ajenos conserva exactamente el mensaje previo', () => {
  const valid = { operation: 'replace', kind: 'win32', nativeCode: 32 };
  const invalid = [null, undefined, false, 7, 'PRIVATE_CANARY', [], [valid], {},
    { operation: 'replace', kind: 'win32' }, { ...valid, nativeCode: undefined },
    ...[-1, 0, 1, 34, 65568, 0x80070020, 32.5, NaN, Infinity, '32', {}, [], true]
      .map(nativeCode => ({ ...valid, nativeCode })),
    { ...valid, operation: 'PRIVATE_CANARY' }, { ...valid, operation: {} },
    { ...valid, kind: 'PRIVATE_CANARY' }, { ...valid, kind: [] },
    { ...valid, operation: 'write' }, { ...valid, kind: 'io' },
    { operation: 'write', kind: 'unknown', nativeCode: 32 },
    ...['message', 'exception', 'path', 'HResult', 'cause', 'error']
      .map(key => ({ ...valid, [key]: 'PRIVATE_CANARY' }))];
  for (const publishFailure of invalid) {
    const error = signalChild.controllerFailure(withFailure(publishFailure), launchId);
    assert.equal(error.message, 'Native signal controller failed (phase: complete-publish)');
    assert.deepEqual(Object.keys(error), ['code']);
    assert.doesNotMatch(error.stack, /PRIVATE_CANARY/);
  }
  for (const phase of phases.filter(phase => phase !== 'complete-publish')) {
    assert.equal(signalChild.controllerFailure({ ...report(phase), publishFailure: valid }, launchId).message,
      `Native signal controller failed (phase: ${phase})`);
  }
  for (const value of [{ ...withFailure(valid), launchId: 'otro-launch' },
    { ...withFailure(valid), code: 'PRIVATE_CANARY' }, { ...withFailure(valid), phase: 'PRIVATE_CANARY' }]) {
    assert.equal(signalChild.controllerFailure(value, launchId).message,
      'Native signal controller failed (phase: unknown)');
  }
});

test('AtomicJson reinicia el snapshot y captura GetLastWin32Error antes de construir el diagnóstico', () => {
  const method = csMethod('AtomicJson');
  assert.match(method, /ResetPublishFailure\(\);\s*string destination;/);
  assert.match(method, /try \{\s*destination = Path.Combine\(directory, name\);\s*File.WriteAllText\(destination \+ "\.tmp", json, new UTF8Encoding\(false\)\);/);
  assert.match(method, /catch \(Exception exception\) \{\s*LastPublishFailure = WriteFailure\(exception\);\s*throw;/);
  assert.match(method, /bool moved = MoveFileEx\(destination \+ "\.tmp", destination, 1 \| 8\);\s*if \(!moved\) \{\s*int nativeCode = Marshal.GetLastWin32Error\(\);\s*LastPublishFailure = new PublishFailure\("replace", "win32", AllowedNativeCode\(nativeCode\)\);\s*\}\s*Require\(moved\);/);
  assert.equal((method.match(/MoveFileEx\(/g) ?? []).length, 1);
  assert.equal((method.match(/File.WriteAllText\(/g) ?? []).length, 1);
  assert.match(psSource(), /static void Require\(bool ok\) \{ if \(!ok\) throw new InvalidOperationException\("Native operation failed"\); \}/);
  assert.match(psSource(), /public static PublishFailure LastPublishFailure \{ get; private set; \}/);
  assert.match(psSource(), /public static void ResetPublishFailure\(\) \{ LastPublishFailure = null; \}/);
  const snapshot = psSource().match(/public sealed class PublishFailure \{[^]*?\n    \}/)?.[0];
  assert.ok(snapshot);
  for (const property of ['Operation', 'Kind', 'NativeCode']) {
    assert.match(snapshot, new RegExp(`${property} \\{ get; private set; \\}`));
  }
});

test('C# limita códigos y categorías sin reenviar HRESULT completo ni texto de excepciones', () => {
  const method = csMethod('AllowedNativeCode');
  assert.deepEqual([...method.matchAll(/case (\d+):/g)].map(match => Number(match[1])), nativeCodes);
  assert.match(method, /default: return null;/);
  const write = csMethod('WriteFailure');
  for (const [type, kind] of [['IOException', 'io'], ['UnauthorizedAccessException', 'access'],
    ['System.Security.SecurityException', 'security'], ['ArgumentException', 'argument'],
    ['NotSupportedException', 'unsupported']]) {
    assert.ok(write.includes(`exception is ${type}`));
    assert.ok(write.includes(`"${kind}"`));
  }
  assert.match(write, /\(hresult & 0xFFFF0000u\) == 0x80070000u/);
  assert.match(write, /AllowedNativeCode\(\(int\)\(hresult & 0xFFFFu\)\)/);
  assert.match(write, /kind != "unknown"/);
  assert.doesNotMatch(write, /Message|ToString|GetLastWin32Error|Data|StackTrace/);
});

test('PowerShell captura el snapshot antes de publicar y deja intacto el payload FILETIME nativo', () => {
  const source = psSource();
  const publish = source.match(/function Publish\([^]*?\n    \}/)?.[0];
  assert.match(publish, /\[SignalHost\]::ResetPublishFailure\(\)\s*\[SignalHost\]::AtomicJson\(.*ConvertTo-Json/);
  const runtimeCatch = source.slice(source.indexOf('} catch {\n    $failed = $true'), source.indexOf('} finally {\n    if ($null -ne $hostTransport)'));
  assert.match(runtimeCatch, /\$publishFailure = \[SignalHost\]::LastPublishFailure/);
  assert.match(runtimeCatch, /if \(\$phase -eq 'complete-publish' -and \$null -ne \$publishFailure\) \{\s*\$errorReport.publishFailure = @\{ operation = \$publishFailure.Operation; kind = \$publishFailure.Kind;\s*nativeCode = \$publishFailure.NativeCode \}\s*\}/);
  assert.ok(runtimeCatch.indexOf('$publishFailure =') < runtimeCatch.indexOf("Publish 'error.json'"));
  assert.doesNotMatch(runtimeCatch, /\$_|\$Error\b|Exception|Message|HResult|GetLastWin32Error/i);
  assert.deepEqual([...runtimeCatch.matchAll(/\$errorReport\.([a-zA-Z]+) =/g)].map(match => match[1]), ['publishFailure']);
});

test('reporte PowerShell sólo serializa identidad, código fijo y fase literal acotada', () => {
  const source = readFileSync(new URL('./helpers/windows-signal-child.ps1', import.meta.url), 'utf8');
  const assigned = [...source.matchAll(/\$phase = '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(assigned)].sort(), [...phases].sort());
  const values = [...source.matchAll(/^\s*\$phase = (.+)$/gm)].map(match => match[1].trim());
  for (const value of values) {
    assert.ok(value === '$requestFailurePhase' || phases.some(phase => value === `'${phase}'`),
      'la fase no debe proceder de datos o excepciones');
  }
  const saved = [...source.matchAll(/^\s*\$requestFailurePhase = (.+)$/gm)].map(match => match[1].trim());
  assert.deepEqual(saved, ['$phase']);
  const payload = source.match(/\$errorReport = @\{([^\n]+)\}/)?.[1];
  assert.ok(payload);
  assert.equal(payload.trim(), "launchId = [string]$config.launchId; code = 'NATIVE_CONTROLLER_FAILURE'; phase = $phase");
  assert.match(source, /Publish 'error\.json' \$errorReport/);
  assert.doesNotMatch(payload, /\$_|\$Error|Exception|Message|args|\benv\b/i);
});

test('el poll real filtra fase de error.json sin cambiar el sondeo ni generar fallos si no hay reporte', async () => {
  const source = readFileSync(new URL('./helpers/signal-child.mjs', import.meta.url), 'utf8');
  const method = source.match(/  async _poll\(\) \{[\s\S]+?\n  \}/)?.[0];
  assert.ok(method, 'debe ejecutarse el método real, no una copia del relay');
  for (const [value, phase, suffix = ''] of [[report('output-drain'), 'output-drain'],
    [{ ...report('interrupt'), launchId: 'otro-launch' }, 'unknown'],
    [withFailure({ operation: 'replace', kind: 'win32', nativeCode: 32 }), 'complete-publish',
      '; publish: replace/win32/32'], [null, null]]) {
    const failures = [], delays = [];
    const poll = runInNewContext(`({${method}})._poll`, {
      jsonFile: async (_directory, file) => file === 'error.json' ? value : null,
      controllerFailure: signalChild.controllerFailure,
      fault: message => Object.assign(new Error(message), { code: 'ERR_SIGNAL_CONTROLLER' }),
      setTimeout: (_callback, ms) => { delays.push(ms); return null; },
    });
    await poll.call({ _directory: 'PRIVATE_CANARY', _launchId: launchId,
      _recordReady: () => {}, _fail: error => failures.push(error),
      _acknowledged: 0, _sequence: 0, _controllerClosed: false });
    assert.deepEqual(delays, [10], 'el intervalo existente no cambia');
    assert.equal(failures.length, phase === null ? 0 : 1);
    if (phase !== null) {
      assert.equal(failures[0].code, 'ERR_SIGNAL_CONTROLLER');
      assert.equal(failures[0].message, `Native signal controller failed (phase: ${phase})${suffix}`);
      assert.doesNotMatch(failures[0].message, /PRIVATE_CANARY|otro-launch/);
    }
  }
});

const startupPhases = ['startup-check', 'native-launch', 'ready-publish'];
const hintName = phase => `startup-${phase}.json`;
const hint = phase => JSON.stringify({ launchId, phase });
const startupIdentity = { launchId, targetPid: process.pid + 1000,
  controllerPid: process.pid + 2000, creationTime: '134000000000000001' };

// Execute the real preamble, parsers, constructor and class. Only transports and
// scheduling are substituted; this is neither PowerShell execution nor kernel proof.
function startupFixture(t, initialFiles = [], pathApi = path) {
  const ownedDirectory = pathApi.join(pathApi.sep, 'owned', 'PRIVATE_CANARY');
  const source = readFileSync(new URL('./helpers/signal-child.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const controllers =');
  const end = source.indexOf('export async function launchSignalChild(');
  assert.ok(start >= 0 && end > start);
  const files = new Map(initialFiles), reads = [], writes = [], removed = [], timers = new Map(), delays = [];
  const events = [], errors = [];
  let now = 0, outcome;
  const settle = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
  const ActualChild = runInNewContext(`${source.slice(start, end).replace(/^export /gm, '')}\nWindowsSignalChild`, {
    EventEmitter, PassThrough, process, path: pathApi, Date: class extends Date { static now() { return now; } },
    readFile: async (file, encoding) => {
      assert.equal(pathApi.dirname(file), ownedDirectory);
      assert.equal(encoding, 'utf8');
      const name = pathApi.basename(file);
      reads.push({ name, time: now });
      if (!files.has(name)) throw Object.assign(new Error('PRIVATE_CANARY'), { code: 'ENOENT' });
      const value = files.get(name);
      return typeof value === 'function' ? value() : value;
    },
    writeFileSync: (file, body) => writes.push({ file, value: JSON.parse(body), time: now }),
    renameSync: () => {}, rm: async directory => removed.push(directory),
    setTimeout: (callback, delay) => {
      const timer = { callback, time: now + delay, delay };
      timers.set(timer, timer); delays.push(delay); return timer;
    },
    clearTimeout: timer => timers.delete(timer),
    setImmediate: callback => { void Promise.resolve().then(callback); },
  });
  const controller = new EventEmitter();
  controller.pid = startupIdentity.controllerPid;
  for (const name of ['stdin', 'stdout', 'stderr']) controller[name] = new PassThrough();
  const child = new ActualChild(controller, ownedDirectory, launchId);
  child._ready.then(value => { outcome = value; }, error => { outcome = error; });
  child.on('error', error => errors.push(error));
  for (const name of ['exit', 'close']) child.on(name, () => events.push(name));
  t.after(() => {
    for (const stream of [controller.stdin, controller.stdout, controller.stderr, child.stdout, child.stderr]) stream.destroy();
  });
  const advance = async milliseconds => {
    const until = now + milliseconds;
    await settle();
    for (;;) {
      const next = [...timers.values()].filter(timer => timer.time <= until).sort((a, b) => a.time - b.time)[0];
      if (!next) break;
      now = next.time; timers.delete(next); next.callback(); await settle();
    }
    now = until; await settle();
  };
  const poll = async () => {
    let finished = false;
    child._poll().then(() => { finished = true; });
    await settle();
    assert.equal(finished, true, 'hint IO must never hold the original poll open');
  };
  const hints = () => reads.filter(read => read.name.startsWith('startup-'));
  const timeout = async expected => {
    await advance(10000 - now);
    assert.equal(child._failure?.message, expected);
    assert.equal(outcome, child._failure, 'original error identity rejects startup');
    assert.equal(child._failure.code, 'ERR_SIGNAL_CONTROLLER');
    assert.deepEqual(Object.keys(child._failure), ['code']);
    assert.doesNotMatch(child._failure.stack, /PRIVATE_CANARY|target exists|cleanup complete|no target/i);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].file, pathApi.join(ownedDirectory, 'cancel.json.tmp'));
    assert.equal(writes[0].time, 10000, 'cancellation is synchronous at the original deadline');
    assert.equal(writes[0].value.launchId, launchId);
    assert.equal(child.pid, undefined); assert.equal(child.exitCode, null);
    assert.deepEqual(events, []); assert.deepEqual(removed, []);
  };
  return { child, controller, files, reads, writes, errors, events, removed, timers, delays,
    settle, advance, poll, hints, timeout, outcome: () => outcome };
}

test('startup fixture preserves timeout oracles with both POSIX and Win32 paths', async t => {
  for (const pathApi of [path.posix, path.win32]) {
    const f = startupFixture(t, [], pathApi);
    f.files.set(hintName('native-launch'), hint('native-launch'));
    await f.timeout('Native startup timed out (phase: native-launch)');
    assert.ok(f.hints().length > 0);
  }
});

for (const phase of startupPhases) test(`startup timeout reports only the observed boundary: ${phase}`, async t => {
  const f = startupFixture(t);
  f.files.set(hintName(phase), hint(phase));
  await f.timeout(`Native startup timed out (phase: ${phase})`);
  assert.ok(f.hints().length > 0);
});

test('startup observations cannot regress when higher immutable hints disappear', async t => {
  for (const higher of ['native-launch', 'ready-publish']) {
    const initial = startupPhases.slice(0, startupPhases.indexOf(higher) + 1).map(phase => [hintName(phase), hint(phase)]);
    const f = startupFixture(t, initial);
    await f.advance(100);
    f.files.clear(); f.files.set(hintName('startup-check'), hint('startup-check'));
    await f.timeout(`Native startup timed out (phase: ${higher})`);
  }
});

test('missing, partial, foreign, mismatched and private hints preserve the exact generic timeout', async t => {
  const invalid = [undefined, '{', 'null', '[]', 'false', '7', '"PRIVATE_CANARY"', '{}',
    JSON.stringify({ launchId: 'foreign', phase: 'native-launch' }),
    JSON.stringify({ launchId, phase: 'startup-check' }),
    JSON.stringify({ launchId, phase: 'PRIVATE_CANARY' }),
    JSON.stringify({ launchId, phase: 'toString' }),
    JSON.stringify({ launchId, phase: { private: 'PRIVATE_CANARY' } }),
    ...['message', 'exception', 'pid', 'path', 'env', 'cause'].map(key =>
      JSON.stringify({ launchId, phase: 'native-launch', [key]: 'PRIVATE_CANARY' })),
    () => { throw Object.assign(new Error('PRIVATE_CANARY'), { code: 'EACCES' }); }];
  for (const value of invalid) {
    const f = startupFixture(t);
    if (value !== undefined) f.files.set(hintName('native-launch'), value);
    f.files.set('startup-foreign.json', hint('ready-publish'));
    await f.timeout('Native startup timed out');
    assert.ok(f.hints().every(read => startupPhases.some(phase => read.name === hintName(phase))));
  }
});

for (const boundary of ['ready', 'error', 'deadline']) test(`pending diagnostic IO cannot delay ${boundary}`, async t => {
  const pending = new Promise(() => {});
  const f = startupFixture(t, startupPhases.map(phase => [hintName(phase), () => pending]));
  await f.advance(10);
  assert.ok(f.hints().length > 0 && f.hints().length <= 3);
  await f.poll();
  if (boundary === 'deadline') await f.timeout('Native startup timed out');
  else {
    f.files.set(`${boundary}.json`, JSON.stringify(boundary === 'ready' ? startupIdentity : report('native-launch')));
    await f.poll();
    if (boundary === 'ready') {
      assert.equal(f.outcome(), f.child); assert.equal(f.child.pid, startupIdentity.targetPid);
      assert.equal(f.timers.has(f.child._startupTimer), false);
    } else assert.equal(f.child._failure?.message, 'Native signal controller failed (phase: native-launch)');
  }
  const count = f.hints().length;
  await f.advance(200);
  assert.equal(f.hints().length, count, 'at most one batch can remain in flight');
});

test('startup sampling uses only existing polls, at most three reads per 100ms and 100 batches', async t => {
  const f = startupFixture(t);
  await f.advance(9999);
  const batches = Map.groupBy(f.hints(), read => read.time);
  assert.equal(batches.size, 100);
  const times = [...batches.keys()];
  for (let i = 0; i < times.length; i++) {
    assert.ok(batches.get(times[i]).length <= 3);
    assert.equal(new Set(batches.get(times[i]).map(read => read.name)).size, batches.get(times[i]).length);
    if (i) assert.ok(times[i] - times[i - 1] >= 100);
  }
  assert.ok(f.delays.every(delay => delay === 10 || delay === 10000), 'no diagnostic timer stack');
  await f.timeout('Native startup timed out');
  await f.advance(200);
  assert.equal(f.hints().length, 300);
});

for (const terminal of ['ready', 'failure']) test(`late hints after ${terminal} cannot mutate state or reject unhandled`, async t => {
  const f = startupFixture(t, [[hintName('native-launch'), hint('native-launch')]]), unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  f.files.set(hintName('native-launch'), hint('native-launch'));
  await f.advance(90);
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Own the transport root even on RED; derived read/observer rejections must still be handled.
  void pending.catch(() => {});
  for (const phase of startupPhases) f.files.set(hintName(phase), () => pending);
  await f.advance(10);
  const count = f.hints().length;
  if (terminal === 'ready') f.files.set('ready.json', JSON.stringify(startupIdentity));
  else f.controller.emit('error', new Error('PRIVATE_CANARY'));
  await f.poll();
  const phaseBefore = f.child._startupPhase, failureBefore = f.child._failure;
  if (terminal === 'ready') resolve(hint('ready-publish'));
  else reject(new Error('PRIVATE_CANARY'));
  await f.advance(200);
  await new Promise(done => setImmediate(done));
  assert.equal(f.child._startupPhase, phaseBefore);
  assert.equal(f.child._failure, failureBefore);
  assert.equal(f.hints().length, count);
  assert.deepEqual(unhandled, []); assert.deepEqual(f.events, []); assert.deepEqual(f.removed, []);
  assert.equal(f.outcome(), terminal === 'ready' ? f.child : failureBefore);
});

test('cached hints cannot alter control failures, ready ownership or inject arbitrary phase text', async t => {
  for (const mode of ['tampered', 'controller-error', 'invalid-ready', 'unowned-exit']) {
    const f = startupFixture(t);
    f.files.set(hintName('native-launch'), hint('native-launch'));
    await f.advance(100);
    if (mode === 'tampered') {
      f.child._startupPhase = 'PRIVATE_CANARY';
      await f.timeout('Native startup timed out');
    } else {
      if (mode === 'controller-error') f.files.set('error.json', JSON.stringify(report('output-drain')));
      if (mode === 'invalid-ready') f.files.set('ready.json', JSON.stringify({ ...startupIdentity, launchId: 'foreign' }));
      if (mode === 'unowned-exit') f.files.set('exit.json', JSON.stringify({ ...startupIdentity, exitCode: 0 }));
      await f.poll();
      assert.equal(f.child._failure?.message, mode === 'controller-error' ?
        'Native signal controller failed (phase: output-drain)' :
        mode === 'invalid-ready' ? 'Invalid native startup identity' : 'Invalid native exit identity');
      assert.deepEqual(Object.keys(f.child._failure), ['code']);
      assert.equal(f.child.pid, undefined); assert.equal(f.child._acknowledged, 0);
    }
  }
});

test('PowerShell startup hints are post-ownership, exclusive, once-only and isolated from real publication', () => {
  const source = psSource();
  const writer = source.match(/    function Write-StartupHint\([^]*?\n    \}/)?.[0];
  assert.ok(writer, 'the actual best-effort startup writer must exist after validated ownership');
  assert.ok(source.indexOf(writer) > source.indexOf("throw 'Invalid control ownership'"));
  assert.ok(source.indexOf(writer) > source.indexOf("'@"));
  assert.match(writer, /switch -Exact/);
  for (const phase of startupPhases) {
    assert.ok(writer.includes(`'${phase}' { 'startup-${phase}.json' }`));
    assert.match(source, new RegExp(`\\$phase = '${phase}'\\s+Write-StartupHint \\$phase`));
  }
  assert.equal((source.match(/Write-StartupHint \$phase/g) ?? []).length, 3);
  assert.deepEqual([...writer.matchAll(/'(startup-[a-z-]+\.json)'/g)].map(match => match[1]), startupPhases.map(hintName));
  assert.match(source.slice(0, source.indexOf(writer)), /\$startupHintAttempted = @\{\}/);
  assert.equal((source.match(/\$startupHintAttempted = @\{\}/g) ?? []).length, 1);
  assert.match(writer, /default\s*\{ return \}/);
  assert.match(writer, /ContainsKey\(\$boundary\)/);
  assert.match(writer, /\$startupHintAttempted\[\$boundary\] = \$true/);
  assert.ok(writer.indexOf('= $true') < writer.indexOf('[IO.File]::Open'));
  assert.match(writer, /\[IO.FileMode\]::CreateNew/);
  assert.match(writer, /\[IO.FileAccess\]::Write,\s*\[IO.FileShare\]::None/);
  assert.match(writer, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(writer, /@\{ launchId = \[string\]\$config.launchId; phase = \$boundary \}/);
  assert.match(writer, /try \{[^]*try \{[^]*\} finally \{[^]*\.Dispose\(\)[^]*\}\s*\} catch \{\s*\}/);
  assert.doesNotMatch(writer, /SignalHost|AtomicJson|PublishFailure|\bPublish\b|Console|Write-(?:Host|Output|Error)|WriteAll|Move|Rename|Flush|Retry|Start-Sleep|\bwhile\b|\bfor\b/);
  assert.doesNotMatch(source.slice(source.indexOf('} finally {\n    if ($null -ne $hostTransport)')), /Write-StartupHint/);
});
