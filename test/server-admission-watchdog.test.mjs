import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverAdmissionChildProgram } from './helpers/server-admission-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Puerto libre con reintento: helpers/free-port.mjs (elimina la carrera de freePort, #78).

// EOF-only regression against the real admission fixture, not a controller hard-kill
// or an OS-signal delivery test. The fixture watchdog must start before its imports.
test('el fixture de admisión sobrevive a EOF y su watchdog independiente lo termina con 86', { timeout: 12000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-ADMISSION-WATCHDOG-'));
  let handle, guardTimer;
  try {
    handle = await launchChildOnFreePort({
      launch: port => crearFixture(root, port),
      ready: f => f.ready(),
      output: f => f.diagnostics(),
    });
    const { child, closeInfo, assertHealthyTransport, diagnostics } = handle;
    const guard = new Promise((_, reject) => {
      guardTimer = setTimeout(() => reject(new Error(`el fixture excedió la guardia de 8000 ms\n${diagnostics()}`)), 8000);
    });
    const bounded = promise => Promise.race([promise, guard]);
    assertHealthyTransport();
    assert.equal(child.exitCode, null, `el fixture debe estar vivo en READY\n${diagnostics()}`);
    assert.equal(child.signalCode, null);

    // Close only the owner's stdin pipe: no release, shutdown message or signal.
    await bounded(new Promise((resolve, reject) => {
      child.stdin.end(error => { if (error) reject(error); else resolve(); });
    }));
    await bounded(delay(100));
    assertHealthyTransport();
    assert.equal(handle.cerrado(), false, `EOF no debe apagar el servidor\n${diagnostics()}`);
    assert.equal(child.exitCode, null, `el servidor debe sobrevivir brevemente a EOF\n${diagnostics()}`);
    assert.equal(child.signalCode, null);

    const status = await bounded(closeInfo);
    assertHealthyTransport();
    assert.deepEqual(status, { code: 86, signal: null }, `debe salir por su propio watchdog, no por limpieza\n${diagnostics()}`);
    assert.equal(/^(SIGNAL|RELEASE|FLUSH)\r?$/m.test(handle.salida()), false, `no debe entrar en el apagado graceful\n${diagnostics()}`);
  } finally {
    clearTimeout(guardTimer);
    // Forced termination is fallback only, through this owned ChildProcess handle.
    const hijo = handle?.child;
    if (hijo && hijo.exitCode === null && hijo.signalCode === null) hijo.kill('SIGKILL');
    if (handle?.closeInfo) await handle.closeInfo;
    await rm(root, { recursive: true, force: true });
  }
});

// Crea el fixture de admisión en un puerto ya elegido; el reintento ante EADDRINUSE
// lo decide launchChildOnFreePort (helpers/free-port.mjs, #78).
function crearFixture(root, port) {
  const env = { ...process.env, ANTENA_DATA: root, ANTENA_MEDIA: path.join(root, 'media'), PORT: String(port) };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
  // Trusted fixture option only: 3000 ms from program start, not from READY.
  const program = serverAdmissionChildProgram({ watchdogMs: 3000 });
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, 'late'], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let childError, transportError, closed = false;
  // Register immediately, including spawn failure and a very early native close.
  child.on('error', error => { childError ??= error; });
  const closeInfo = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal });
  }));
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-40000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-40000); });
  for (const stream of child.stdio) stream.on('error', error => { transportError ??= error; });
  const diagnostics = () => `stdout: ${stdout}\nstderr: ${stderr}`;
  const assertHealthyTransport = () => {
    if (childError) throw childError;
    if (transportError) throw transportError;
  };
  const ready = async () => {
    const fin = Date.now() + 8000;
    while (!/^READY\r?$/m.test(stdout)) {
      if (childError || transportError) throw (childError ?? transportError);
      if (closed) {
        if ((stdout + stderr).includes('EADDRINUSE')) return false; // reintento de helpers/free-port.mjs
        assert.fail(`el fixture salió antes de READY\n${diagnostics()}`);
      }
      if (Date.now() >= fin) assert.fail(`el fixture no llegó a READY en 8000 ms\n${diagnostics()}`);
      await delay(20);
    }
    return true;
  };
  return { child, closeInfo, assertHealthyTransport, diagnostics, ready, cerrado: () => closed, salida: () => stdout };
}
