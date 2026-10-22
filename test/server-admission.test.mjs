// Contrato 08b.1: toda petición HTTP nueva tras `app.stopAdmission()` recibe 503 «La app se está cerrando.»;
// las admitidas antes del corte conservan seguridad y ruta, drenándose por el contador de handlers hasta el idle;
// el deadline sigue vigente y las llamadas repetidas comparten la misma promesa de idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { createApp } from '../src/server.mjs';
import { serverAdmissionChildProgram } from './helpers/server-admission-child.mjs';
import { observeChildLifecycle } from './helpers/child-lifecycle.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';

const CLOSING = 'La app se está cerrando.';
const delay = ms => new Promise(r => setTimeout(r, ms));

// Puerto libre con reintento: helpers/free-port.mjs (elimina la carrera de freePort, #78).

// Resuelve `true` si la promesa termina (o rechaza) antes del límite; limpia su temporizador siempre.
function raceTimer(promise, ms) {
  let timer;
  const guard = new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([Promise.resolve(promise).then(() => true, () => true), guard]).finally(() => clearTimeout(timer));
}

function assertClosing(res, label) {
  assert.equal(res.status, 503, `${label}: se esperaba 503 y llegó ${res.status} (${String(res.body).slice(0, 120)})`);
  assert.ok(String(res.body).includes(CLOSING), `${label}: falta el mensaje constante «${CLOSING}»`);
  assert.equal(res.headers?.['set-cookie'], undefined, `${label}: el cierre no debe emitir cookie de acceso`);
}

// Hijo REAL: importa `startServer` de producción (con sus handlers de señal) y solo engancha
// seams públicos: gate por stdin, `session.flush` y `youtube.finishAuth`. No copia el shutdown.
const CHILD_PROGRAM = serverAdmissionChildProgram();

async function launchChild({ dataDir, port, scenario, shutdownTimeoutMs }) {
  const env = { ...process.env, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: String(port) };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  if (shutdownTimeoutMs) env.CHILD_SHUTDOWN_TIMEOUT_MS = String(shutdownTimeoutMs);
  const child = await launchSignalChild(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out = (out + d).slice(-40000); });
  child.stderr.on('data', d => { err = (err + d).slice(-40000); });
  let childError;
  child.on('error', error => { childError ??= error; });
  // `close` incluye el drenaje de stdio y del controlador Windows, no solo la salida nativa.
  const closeInfo = new Promise((resolve, reject) => child.once('close', (code, signal) => {
    if (childError) reject(childError); else resolve({ code, signal });
  }));
  closeInfo.catch(() => {}); // Se observa de nuevo en waitFor, awaitExit y la limpieza.
  const lifecycle = observeChildLifecycle(child);
  const waitFor = async (needle, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (childError) throw childError;
      if ((out + err).includes(needle)) return true;
      if (child.exitCode !== null || child.signalCode !== null) {
        await closeInfo;
        return (out + err).includes(needle);
      }
      await delay(20);
    }
    if (childError) throw childError;
    return (out + err).includes(needle);
  };
  return {
    child, closeInfo, waitFor, lifecycle,
    release: () => { try { child.stdin.write('release\n'); } catch { /* el hijo pudo morir */ } },
    stdout: () => out, stderr: () => err,
  };
}

async function startChild(children, root, name, scenario, shutdownTimeoutMs) {
  const dataDir = path.join(root, name);
  await mkdir(dataDir, { recursive: true });
  const c = await launchChildOnFreePort({
    launch: port => launchChild({ dataDir, port, scenario, shutdownTimeoutMs }),
    ready: h => h.waitFor('READY'),
  });
  children.push(c);
  assert.ok(await c.waitFor('READY'), `el hijo no llegó a READY (${name}): ${c.stdout()}${c.stderr()}`);
  return { ...c, dataDir }; // `port` ya viene del helper
}

// Root propio + hijos propios: SIGKILL solo en la limpieza, esperando close antes de borrar.
async function makeRoot(t, children) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-ADMISSION-'));
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    const closed = await Promise.allSettled(children.map(c => c.closeInfo));
    await rm(root, { recursive: true, force: true });
    const failed = closed.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  });
  return root;
}

// Watchdog propio con temporizador limpiado en finally: un hijo sano no deja timers colgando.
async function awaitExit(c, ms = 3000) {
  let timer;
  const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const res = await Promise.race([c.closeInfo, watchdog]);
    if (!res) {
      // Congelar ANTES de SIGKILL: la salida del rescate no prueba salida graceful.
      const atWatchdog = c.lifecycle.snapshot();
      const diagnostic = () => `lifecycleAtWatchdog=${JSON.stringify(atWatchdog)}; lifecycleAfterRescue=${JSON.stringify(c.lifecycle.snapshot())}`;
      try { c.child.kill('SIGKILL'); await c.closeInfo; }
      catch (error) { error.message += `; ${diagnostic()}`; throw error; }
      assert.fail(`el hijo no completó close en ${ms}ms; ${diagnostic()}: ${c.stdout()}${c.stderr()}`);
    }
    return res;
  } finally { clearTimeout(timer); }
}

// Petición acotada: en SSE resuelve al ver las cabeceras y destruye; en el resto espera el fin.
function requestStatus({ port, method = 'GET', path: p = '/', headers = {}, body, timeoutMs = 2500 }) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      if (String(res.headers['content-type'] || '').includes('text/event-stream')) { res.destroy(); return finish({ status: res.statusCode, headers: res.headers, body: '' }); }
      let data = ''; res.setEncoding('utf8');
      res.on('data', d => { data = (data + d).slice(0, 4000); });
      res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', () => finish({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', e => finish({ status: 0, error: e.code || e.message }));
    const timer = setTimeout(() => { req.destroy(); finish({ status: 0, error: 'timeout' }); }, timeoutMs);
    if (body !== undefined) req.end(body); else req.end();
  });
}

// PUT con cuerpo partido: el handler queda esperando `readBody` hasta `finish()`.
function openPut({ port, fullBody }) {
  const cut = Math.floor(fullBody.length / 2);
  const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/config', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(fullBody)) } });
  req.on('error', () => {});
  const response = new Promise((resolve, reject) => {
    req.on('response', res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  response.catch(() => {});
  req.write(fullBody.slice(0, cut));
  return { req, response, finish: () => req.end(fullBody.slice(cut)) };
}

test('tras stopAdmission toda mutación nueva recibe 503 constante y no toca el disco', { timeout: 20000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'late-body', 'late');
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'), `sin marcador de señal: ${c.stdout()}${c.stderr()}`);
  await delay(120);
  assertClosing(await requestStatus({ port: c.port, method: 'PUT', path: '/api/config', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tts: { rate: 9.99 } }) }), 'PUT /api/config');
  assertClosing(await requestStatus({ port: c.port, method: 'POST', path: '/api/session/new', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'tarde' }) }), 'POST /api/session/new');
  c.release();
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
  const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, 1.5, 'la mutación posterior al corte no debe persistirse');
});

test('tras stopAdmission los caminos sin cuerpo (SD, OAuth, SSE, estáticos) reciben 503', { timeout: 20000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'late-other', 'late');
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'), `sin marcador de señal: ${c.stdout()}${c.stderr()}`);
  await delay(120);
  assertClosing(await requestStatus({ port: c.port, method: 'GET', path: '/sd/marca' }), 'GET /sd/marca');
  assertClosing(await requestStatus({ port: c.port, method: 'GET', path: '/oauth/youtube?code=tarde&state=s' }), 'GET /oauth/youtube');
  assertClosing(await requestStatus({ port: c.port, method: 'GET', path: '/api/stream?client=overlay' }), 'GET /api/stream');
  assertClosing(await requestStatus({ port: c.port, method: 'GET', path: '/' }), 'GET / estático');
  assert.equal(c.stdout().includes('OAUTH-IN'), false, 'un OAuth cerrado no debe llamar a finishAuth');
  c.release();
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
});

test('una petición admitida antes del corte completa el cuerpo, responde 200 y persiste', { timeout: 20000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'admitted-put', 'partial');
  const put = openPut({ port: c.port, fullBody: JSON.stringify({ tts: { rate: 1.75 } }) });
  assert.ok(await c.waitFor('IN'), `la petición admitida no entró: ${c.stdout()}${c.stderr()}`);
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'));
  await delay(200);
  assert.equal(c.child.exitCode, null, 'no debe salir con un handler admitido sin terminar: ' + c.stdout());
  put.finish();
  const res = await put.response.catch(e => ({ status: 0, error: e.code || e.message }));
  assert.equal(res.status, 200, 'la petición admitida antes del corte debe responder 200: ' + JSON.stringify(res));
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
  const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, 1.75, 'el cuerpo admitido debe persistirse después del corte');
});

test('SIGTERM drena el PUT admitido en Unix; en Windows fuerza la salida sin drenarlo', { timeout: 20000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'sigterm-partial', 'partial');
  const put = openPut({ port: c.port, fullBody: JSON.stringify({ tts: { rate: 1.75 } }) });
  t.after(() => put.req.destroy());
  const response = put.response.catch(e => ({ status: 0, error: e.code || e.message }));
  assert.ok(await c.waitFor('IN'), `la petición admitida no entró: ${c.stdout()}${c.stderr()}`);
  assert.equal(c.child.kill('SIGTERM'), true, 'el proceso propio debe aceptar la petición SIGTERM');
  if (process.platform === 'win32') {
    const status = await awaitExit(c);
    assert.ok(Number.isInteger(status.code) && status.code > 0, 'TerminateProcess debe devolver un código nativo no cero');
    assert.equal(status.signal, null, 'el nombre solicitado no es una señal entregada por Windows');
    assert.equal(c.stdout().includes('SIGNAL'), false, 'SIGTERM forzado no ejecuta el handler JS');
    assert.equal(await raceTimer(response, 2500), true, 'el PUT interrumpido debe cerrar su conexión');
    assert.notEqual((await response).status, 200, 'el cuerpo incompleto no debe drenarse ni responder 200');
  } else {
    assert.ok(await c.waitFor('SIGNAL'), `sin marcador SIGTERM: ${c.stdout()}${c.stderr()}`);
    await delay(200);
    assert.equal(c.child.exitCode, null, 'SIGTERM debe esperar al handler admitido');
    assert.equal(c.child.signalCode, null, 'el proceso debe seguir vivo durante el drenaje');
    put.finish();
    const res = await response;
    assert.equal(res.status, 200, 'SIGTERM debe drenar el PUT admitido: ' + JSON.stringify(res));
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
  }
  const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, process.platform === 'win32' ? 1.5 : 1.75, 'solo el drenaje Unix debe persistir el cuerpo completo');
});

test('OAuth admitido antes del corte espera a su handler, no hay flush prematuro y persiste una vez', { timeout: 20000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'admitted-oauth', 'oauth-gate');
  const admitted = requestStatus({ port: c.port, method: 'GET', path: '/oauth/youtube?code=admitido&state=s', timeoutMs: 8000 });
  assert.ok(await c.waitFor('OAUTH-IN:admitido:1'), `el OAuth admitido no entró: ${c.stdout()}${c.stderr()}`);
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'));
  await delay(200);
  assert.equal(c.child.exitCode, null, 'no debe salir con un OAuth admitido en curso');
  assert.equal(c.stdout().includes('FLUSH'), false, 'no debe empezar el flush antes de drenar la admisión');
  assertClosing(await requestStatus({ port: c.port, method: 'GET', path: '/oauth/youtube?code=tarde&state=s' }), 'OAuth nuevo tras el corte');
  c.release();
  const res = await admitted;
  assert.equal(res.status, 200, 'el OAuth admitido debe completar: ' + JSON.stringify(res));
  assert.ok(String(res.body).includes('cuenta-fake'));
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
  const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, 1.75, 'la persistencia posterior al await debe capturarse');
  assert.equal((c.stdout().match(/OAUTH-IN/g) || []).length, 1, 'finishAuth debe llamarse una sola vez');
});

test('un cuerpo bloqueado agota el deadline y sale 1 sin esperar los 5 s por defecto', { timeout: 15000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'blocked-body', 'blocked', 100);
  openPut({ port: c.port, fullBody: JSON.stringify({ tts: { rate: 1.75 } }) });
  assert.ok(await c.waitFor('IN'), `la petición bloqueada no entró: ${c.stdout()}${c.stderr()}`);
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'));
  assert.deepEqual(await awaitExit(c, 2500), { code: 1, signal: null });
});

test('abortar un cuerpo admitido cierra el idle y sale 0 antes del deadline', { timeout: 15000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'aborted-body', 'abort');
  const put = openPut({ port: c.port, fullBody: JSON.stringify({ tts: { rate: 1.75 } }) });
  assert.ok(await c.waitFor('IN'), `la petición abortada no entró: ${c.stdout()}${c.stderr()}`);
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'));
  put.req.destroy();
  assert.deepEqual(await awaitExit(c, 1500), { code: 0, signal: null });
});

test('un SSE admitido antes del corte no bloquea la salida sana', { timeout: 15000 }, async t => {
  const children = []; const root = await makeRoot(t, children);
  const c = await startChild(children, root, 'sse-admitted', 'sse-open');
  let sseStatus = 0;
  const sse = http.request({ host: '127.0.0.1', port: c.port, method: 'GET', path: '/api/stream?client=overlay' });
  sse.on('error', () => {});
  sse.on('response', res => { sseStatus = res.statusCode; res.resume(); });
  sse.end();
  assert.ok(await c.waitFor('IN'), `el SSE admitido no entró: ${c.stdout()}${c.stderr()}`);
  await delay(150);
  assert.equal(sseStatus, 200, 'el SSE previo al corte debe admitirse');
  await interruptSignalChild(c.child, 'SIGINT');
  assert.ok(await c.waitFor('SIGNAL'));
  assert.deepEqual(await awaitExit(c, 1500), { code: 0, signal: null });
});

test('stopAdmission es público, síncrono y reutiliza la misma promesa de idle', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-ADMISSION-'));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  t.after(async () => { await new Promise(r => { app.server.closeAllConnections?.(); app.server.close(r); }); await rm(root, { recursive: true, force: true }); });
  assert.equal(typeof app.stopAdmission, 'function', 'app.stopAdmission debe existir como método público');
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const body = JSON.stringify({ tts: { rate: 1.75 } });
  const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/config', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } });
  req.on('error', () => {});
  req.write(body.slice(0, Math.floor(body.length / 2)));
  await delay(120);
  const first = app.stopAdmission();
  const second = app.stopAdmission();
  assert.equal(typeof first?.then, 'function', 'stopAdmission debe devolver una promesa de idle');
  assert.equal(first, second, 'las llamadas repetidas comparten la misma promesa de idle');
  let settled = false; first.then(() => { settled = true; }, () => { settled = true; });
  await delay(100);
  assert.equal(settled, false, 'el idle no debe resolverse con un handler admitido en curso');
  req.destroy();
  assert.equal(await raceTimer(first, 2000), true, 'el idle debe resolverse al terminar el handler admitido');
  assertClosing(await requestStatus({ port, method: 'GET', path: '/api/state' }), 'GET tras stopAdmission');
});
