import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';

globalThis.WebSocket = class { constructor() { throw new Error('External WebSocket forbidden'); } };
globalThis.fetch = () => { throw new Error('External fetch forbidden'); };
const SERVER_URL = new URL('../src/server.mjs', import.meta.url).href;
const NOTICE = '[parada] alertas retenidas';
const PROGRAM = `
import readline from 'node:readline';
const scenario = process.argv[1];
globalThis.WebSocket = class { constructor() { throw new Error('External WebSocket forbidden'); } };
globalThis.fetch = () => { throw new Error('External fetch forbidden'); };
const { startServer } = await import(${JSON.stringify(SERVER_URL)});
const app = await startServer({ quiet: true, log: message => {
  if (scenario === 'logger-throws' && String(message).startsWith('[parada]')) throw new Error('SECRET-LOGGER');
} });
app.engine.pause();
const alert = { id: 'SECRET-HELD-ID', text: 'SECRET-PAYLOAD', actions: [], vars: {} };
const counts = { first: 0, second: 0, session: 0, interactive: 0, close: 0 };
const first = app.engine.drainActions.bind(app.engine);
const second = app.engine.drainSentActions.bind(app.engine);
let release;
const gate = new Promise(resolve => { release = resolve; });
app.engine.drainActions = () => {
  counts.first++;
  if (scenario === 'held-error') throw new Error('SECRET-ENGINE');
  return first();
};
app.engine.drainSentActions = () => {
  counts.second++;
  const work = second();
  if (scenario === 'late-held') {
    console.log('DRAINING');
    return Promise.all([work, gate]);
  }
  return work;
};
const idle = app.waitIdle.bind(app);
app.waitIdle = () => { console.log('FRESH-IDLE'); return idle(); };
const close = app.closeHttp.bind(app);
app.closeHttp = async () => {
  counts.close++;
  console.log('STATE:' + JSON.stringify({ ...app.engine.pauseState(), ...counts }));
  await close();
  console.log('PHYSICAL-CLOSE');
};
const session = app.session.flush.bind(app.session);
app.session.flush = async () => { counts.session++; console.log('SESSION-FLUSH'); await session(); };
const interactive = app.interactive.flush.bind(app.interactive);
app.interactive.flush = async () => { counts.interactive++; console.log('INTERACTIVE-FLUSH'); await interactive(); };
app.engine.runActions = () => { console.log('UNEXPECTED-ACTION'); throw new Error('Unexpected held dispatch'); };
if (scenario === 'preview') app.engine.deliver(alert, { target: 'preview' });
else if (scenario === 'test') app.engine.deliver({ ...alert, test: true });
else if (scenario === 'held-actions') app.engine.deliver({ ...alert, actions: [{ kind: 'say', text: 'SECRET-ACTION' }] });
else if (scenario !== 'empty' && scenario !== 'late-held') app.engine.deliver(alert);
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'release') { app.engine.deliver(alert); release(); }
});
console.log('READY');
`;


async function runScenario(t, scenario, forceTerminate = false) {
  assert.ok(!forceTerminate || (process.platform === 'win32' && scenario === 'late-held'));
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-held-shutdown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const h = await launchChildOnFreePort({
    launch: port => crearHijo(t, root, scenario, port),
    ready: h => h.ready(),
    output: h => h.stdout + h.stderr, // aquí son cadenas, no funciones
  });
  return await ejecutarEscenario(h, scenario, forceTerminate);
}

// Crea el hijo con su cableado en un puerto ya elegido; el reintento ante EADDRINUSE
// lo decide launchChildOnFreePort (helpers/free-port.mjs, #78).
async function crearHijo(t, root, scenario, port) {
  const env = { ...process.env, ANTENA_DATA: root, ANTENA_MEDIA: path.join(root, 'media'), PORT: String(port) };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  delete env.NODE_OPTIONS;
  const args = ['--input-type=module', '-e', PROGRAM, scenario];
  const options = { env, stdio: ['pipe', 'pipe', 'pipe'] };
  const child = process.platform === 'win32'
    ? await launchSignalChild(process.execPath, args, options)
    : spawn(process.execPath, args, options);
  let stdout = '', stderr = '', ended = false;
  const waiters = new Set();
  const flush = () => {
    for (const waiter of [...waiters]) {
      if (stdout.includes(waiter.marker) || ended) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(stdout.includes(waiter.marker));
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; flush(); });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const exit = new Promise(resolve => child.once('exit', (code, signal) => { ended = true; flush(); resolve({ code, signal }); }));
  const waitFor = marker => {
    if (stdout.includes(marker)) return Promise.resolve(true);
    if (ended) return Promise.resolve(false);
    return new Promise(resolve => {
      const waiter = { marker, resolve, timer: setTimeout(() => { waiters.delete(waiter); resolve(false); }, 3000) };
      waiters.add(waiter);
    });
  };
  let watchdog;
  const boundedExit = Promise.race([
    exit,
    new Promise(resolve => { watchdog = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'WATCHDOG' }); }, 4000); })
  ]);
  t.after(async () => {
    clearTimeout(watchdog);
    for (const waiter of waiters) clearTimeout(waiter.timer);
    if (!ended) child.kill('SIGKILL');
    await exit;
  });
  const ready = async () => {
    const fin = Date.now() + 8000;
    while (!stdout.includes('READY') && Date.now() < fin && child.exitCode === null && child.signalCode === null) await new Promise(r => setTimeout(r, 10));
    return stdout.includes('READY');
  };
  return { child, exit, waitFor, boundedExit, ready, stdout: () => stdout, stderr: () => stderr, salida: () => stdout + stderr };
}

// Ejecuta un escenario completo sobre el hijo ya arrancado y listo.
async function ejecutarEscenario(h, scenario, forceTerminate) {
  const { child, exit, waitFor, boundedExit, salida } = h;
  assert.ok(await h.ready(), salida());
  if (process.platform === 'win32') await interruptSignalChild(child, 'SIGINT');
  else child.kill(scenario === 'held-actions' ? 'SIGTERM' : 'SIGINT');
  if (scenario === 'late-held') {
    assert.ok(await waitFor('DRAINING'), salida());
    assert.equal(salida().includes('SESSION-FLUSH'), false);
    if (forceTerminate) child.kill('SIGTERM');
    else child.stdin.write('release\n');
  }
  const result = await boundedExit;
  return { result, stdout: h.stdout(), stderr: h.stderr() };
}

const cases = [
  ['held', 1, 1],
  ['held-actions', 1, 1],
  ['late-held', 1, 1],
  ['held-error', 1, 1],
  ['logger-throws', 1, 1],
  ['empty', 0, 0],
  ['preview', 0, 0],
  ['test', 0, 0]
];
for (const [scenario, code, held] of cases) {
  test(`shutdown ${scenario}: preserves retained state and accepted persistence`, async t => {
    const { result, stdout, stderr } = await runScenario(t, scenario);
    assert.deepEqual(result, { code, signal: null }, stdout + stderr);
    assert.equal(stderr, held ? NOTICE + '\n' : '', 'constant notice without payload or duplicate');
    const stateLine = stdout.split('\n').find(line => line.startsWith('STATE:'));
    assert.ok(stateLine, stdout);
    assert.deepEqual(JSON.parse(stateLine.slice(6)), {
      paused: true, held, first: 1, second: 1, session: 1, interactive: 1, close: 1
    });
    assert.equal(stdout.includes('UNEXPECTED-ACTION'), false);
    assert.equal((stdout + stderr).includes('SECRET-'), false);
    assert.ok(stdout.indexOf('FRESH-IDLE') < stdout.indexOf('SESSION-FLUSH'));
    assert.ok(stdout.indexOf('SESSION-FLUSH') < stdout.indexOf('STATE:'));
    assert.ok(stdout.indexOf('INTERACTIVE-FLUSH') < stdout.indexOf('STATE:'));
    assert.ok(stdout.indexOf('STATE:') < stdout.indexOf('PHYSICAL-CLOSE'));
    if (process.platform === 'win32' && scenario === 'late-held') {
      const forced = await runScenario(t, scenario, true);
      assert.deepEqual(forced.result, { code: 1, signal: null }, forced.stdout + forced.stderr);
      assert.equal(forced.stderr, '');
      for (const marker of ['SESSION-FLUSH', 'INTERACTIVE-FLUSH', 'STATE:', 'PHYSICAL-CLOSE', 'UNEXPECTED-ACTION', 'SECRET-']) {
        assert.equal((forced.stdout + forced.stderr).includes(marker), false, marker);
      }
    }
  });
}
