// ODD-08b.2b.2b.2d: caller de cierre de Engine y continuaciones ACK estrechas.
// SOLO pruebas. Casos RED: sin ventana coordinada, un ACK legítimo durante la parada recibe 503
// y el trabajo aceptado se abandona; el caller tampoco invoca ambos drenajes de Engine ni espera
// el idle fresco de los handlers ACK. Las guardas que ya cumplen no se fuerzan a rojo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';

// Puerto libre con reintento: helpers/free-port.mjs (elimina la carrera de freePort, #78).

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;
const CLOSING = 'La app se está cerrando.';
const alertFor = (id, text = 'hola') => ({ id, actions: [{ kind: 'say', text }], vars: {} });

// Guardas de seguridad instaladas ANTES de importar el servidor de producción y mantenidas hasta
// el final del proceso: ninguna prueba abre WebSocket externo ni fetch real.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };
const { createApp } = await import('../src/server.mjs');

function request({ port, method = 'GET', path: p = '/', headers = {}, body, timeoutMs = 2500 }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', () => finish({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', e => finish({ status: 0, error: e.code || e.message }));
    const timer = setTimeout(() => { req.destroy(); finish({ status: 0, error: 'timeout' }); }, timeoutMs);
    if (body !== undefined) req.end(body); else req.end();
  });
}

// POST con cuerpo partido: el handler queda admitido esperando `readBody` hasta `finish()`.
function openPost({ port, path: p, fullBody, headers = {} }) {
  const cut = Math.floor(fullBody.length / 2);
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(fullBody)), ...headers } });
  req.on('error', () => {});
  const response = new Promise(resolve => {
    req.on('response', res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', e => resolve({ status: 0, error: e.code || e.message }));
  });
  req.write(fullBody.slice(0, cut));
  return { req, response, finish: () => req.end(fullBody.slice(cut)) };
}

async function makeApp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-ENGSHUT-'));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  t.after(async () => {
    try { app.server.closeAllConnections?.(); } catch { /* ya pudo cerrarse */ }
    await new Promise(r => { try { app.server.close(() => r()); } catch { r(); } });
    await rm(root, { recursive: true, force: true });
  });
  return { app, root };
}

async function listen(app) {
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return app.server.address().port;
}

// Barrera de admisión: resuelve cuando el servidor recibe la petición (antes de leer el cuerpo).
const admitted = app => new Promise(resolve => app.server.once('request', () => resolve()));
const settle = () => new Promise(resolve => setImmediate(resolve));

// Prepara un envío aceptado con ACK pendiente y un contador de despachos observable.
function pending(app) {
  app.bus.overlayCount = () => 1;
  const box = { ran: 0 };
  app.engine.runActions = async () => { box.ran += 1; };
  app.engine.send(alertFor('a1'));
  return box;
}

const openWindow = app => { if (typeof app.beginAckWindow === 'function') app.beginAckWindow(); };
const phaseOf = app => (typeof app.ackWindowPhase === 'function' ? app.ackWindowPhase() : 'sin-api');
const stillPending = (app, id) => (typeof app.engine.hasPendingAck === 'function' ? app.engine.hasPendingAck(id) : true);

test('sin coordinador, stopAdmission mantiene la misma promesa y el ACK real recibe 503', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  const port = await listen(app);
  const box = pending(app);
  const first = app.stopAdmission();
  const second = app.stopAdmission();
  assert.equal(typeof first?.then, 'function', 'stopAdmission devuelve una promesa de idle');
  assert.equal(first, second, 'las llamadas repetidas comparten la MISMA promesa');
  const res = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(res.status, 503, 'sin ventana, todo ACK es 503: ' + JSON.stringify(res));
  assert.ok(String(res.body).includes(CLOSING));
  assert.equal(res.headers['set-cookie'], undefined, 'el cierre no emite cookie');
  assert.equal(box.ran, 0, 'el ACK denegado no despacha');
  assert.equal(stillPending(app, 'a1'), true, 'el ACK denegado no consume la generación pendiente');
});

test('la ventana coordinada admite solo el ACK exacto y deja el resto en 503', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  const port = await listen(app);
  const box = pending(app);
  openWindow(app);
  app.stopAdmission();
  const other = await request({ port, path: '/api/state' });
  assert.equal(other.status, 503, 'otras rutas siguen 503 sin reapertura general');
  const unknown = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'desconocido' }) });
  assert.equal(unknown.status, 503, 'un id desconocido no inicia acciones');
  assert.ok(String(unknown.body).includes(CLOSING));
  const ok = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(ok.status, 200, 'el ACK de la generación pendiente debe admitirse: ' + JSON.stringify(ok));
  assert.equal(box.ran, 1, 'despacha exactamente una vez');
  const again = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(again.status, 503, 'un ACK repetido ya no es la generación pendiente');
});

test('la ruta ACK conserva Host/Origin dentro de la ventana', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  const port = await listen(app);
  const box = pending(app);
  openWindow(app);
  app.stopAdmission();
  const badOrigin = await request({ port, method: 'POST', path: '/api/overlay/shown', headers: { origin: 'http://evil.example' }, body: JSON.stringify({ id: 'a1' }) });
  assert.equal(badOrigin.status, 403, 'origen ajeno bloqueado en la ruta ACK: ' + JSON.stringify(badOrigin));
  const badHost = await request({ port, method: 'POST', path: '/api/overlay/shown', headers: { host: 'evil.example' }, body: JSON.stringify({ id: 'a1' }) });
  assert.equal(badHost.status, 403, 'host no confiable bloqueado en la ruta ACK: ' + JSON.stringify(badHost));
  const ok = await request({ port, method: 'POST', path: '/api/overlay/shown', headers: { origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ id: 'a1' }) });
  assert.equal(ok.status, 200, 'la petición legítima sigue pasando');
  assert.equal(box.ran, 1);
});

test('la generación posterior con el mismo id queda fuera aunque otro drenaje esté en vuelo', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  const port = await listen(app);
  const box = pending(app);
  openWindow(app);
  app.stopAdmission();
  const drain = typeof app.engine.drainSentActions === 'function' ? app.engine.drainSentActions() : Promise.resolve();
  // Un drenaje en vuelo refiere el fallback de 120 s: se libera siempre para no alargar la prueba.
  t.after(() => { try { app.engine.alertShown('a1'); } catch { /* ya liberado */ } });
  if (typeof app.captureAckWindow === 'function') app.captureAckWindow();
  const ok1 = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(ok1.status, 200, 'la generación capturada se admite tras el corte: ' + JSON.stringify(ok1));
  await drain;
  app.engine.send(alertFor('a1'));                    // generación nueva post-corte, mismo id
  const ok2 = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(ok2.status, 503, 'una generación posterior con el mismo id no es la capturada');
  assert.equal(box.ran, 1, 'no despacha la generación no capturada');
  assert.equal(stillPending(app, 'a1'), true, 'la nueva generación sigue pendiente pero no autorizada');
});

test('un cuerpo admitido que llega tras el corte usa la cápsula; cerrado antes de persistir no evade', { timeout: 15000 }, async t => {
  {
    const { app } = await makeApp(t);
    const port = await listen(app);
    const box = pending(app);
    openWindow(app);
    app.stopAdmission();
    const barrier = admitted(app);
    const post = openPost({ port, path: '/api/overlay/shown', fullBody: JSON.stringify({ id: 'a1' }) });
    await barrier;
    await settle();
    let early = null; post.response.then(r => { early = r; });
    await settle();
    assert.equal(early, null, 'el handler admitido en la ventana espera el cuerpo');
    if (typeof app.captureAckWindow === 'function') app.captureAckWindow();
    post.finish();
    const res = await post.response;
    assert.equal(res.status, 200, 'el cuerpo tras el corte sigue siendo la generación capturada: ' + JSON.stringify(res));
    assert.equal(box.ran, 1);
  }
  {
    const { app } = await makeApp(t);
    const port = await listen(app);
    const box = pending(app);
    openWindow(app);
    app.stopAdmission();
    const barrier = admitted(app);
    const post = openPost({ port, path: '/api/overlay/shown', fullBody: JSON.stringify({ id: 'a1' }) });
    await barrier;
    await settle();
    let early = null; post.response.then(r => { early = r; });
    await settle();
    assert.equal(early, null, 'el handler admitido espera el cuerpo antes de cerrar la ventana');
    if (typeof app.closeAckWindow === 'function') app.closeAckWindow();
    post.finish();
    const res = await post.response;
    assert.equal(res.status, 503, 'con la ventana cerrada el cuerpo no evade el cierre');
    assert.ok(String(res.body).includes(CLOSING));
    assert.equal(box.ran, 0, 'no despacha con la ventana cerrada');
  }
});

test('la ventana nace cerrada y una vez cerrada no revive', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  const port = await listen(app);
  const box = pending(app);
  assert.equal(phaseOf(app), 'closed', 'la ventana nace cerrada');
  openWindow(app);
  assert.equal(phaseOf(app), 'open', 'el coordinador la abre');
  if (typeof app.closeAckWindow === 'function') app.closeAckWindow();
  assert.equal(phaseOf(app), 'closed', 'cerrada antes de persistir');
  openWindow(app);
  assert.equal(phaseOf(app), 'closed', 'una ventana cerrada no revive');
  app.stopAdmission();
  const res = await request({ port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(res.status, 503, 'sin ventana el ACK queda denegado');
  assert.equal(box.ran, 0);
});

// Hijo REAL: importa `startServer` de producción y solo engancha seams públicos (stdin, `say`,
// drenajes por instancia, cola Store y flushes). Nunca reimplementa el shutdown.
const CHILD_PROGRAM = `
const scenario = process.argv[1];
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };
const { startServer } = await import(${JSON.stringify(SERVER_MODULE_URL)});
const opts = { quiet: true, log: () => {} };
if (scenario === 'deadline') opts.shutdownTimeoutMs = 400;
const app = await startServer(opts);
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
app.bus.overlayCount = () => 1;
let release = () => {};
const gate = new Promise(resolve => { release = resolve; });
if (scenario === 'ack-gate' || scenario === 'throw-healthy' || scenario === 'deadline') {
  app.engine.say = () => { console.log('ACTION-RAN'); return { id: 'say' }; };
  app.engine.send({ id: 'a1', actions: [{ kind: 'say', text: 'hola' }], vars: {} });
  console.log('ALERT-PENDING');
}
if (scenario === 'ack-gate') app.session.flush = () => { console.log('FLUSH'); return gate; };
if (scenario === 'throw-healthy') {
  app.engine.drainActions = () => { console.log('DRAIN-A'); throw new Error('fallo-sincrono'); };
  let chain = app.store.chain;
  Object.defineProperty(app.store, 'chain', { configurable: true, get() { console.log('CHAIN-SNAPSHOT'); return chain; }, set(v) { chain = v; } });
  app.session.flush = async () => { console.log('FLUSH'); };
}
if (scenario === 'throw-both') {
  app.engine.drainActions = () => { console.log('DRAIN-A'); throw new Error('fallo-sincrono'); };
  app.engine.drainSentActions = () => {
    console.log('DRAIN-B');
    if (process.platform === 'win32') {
      return gate.then(() => { throw new Error('fallo-asincrono'); });
    }
    return Promise.reject(new Error('fallo-asincrono'));
  };
}
process.on('SIGINT', () => console.log('SIGNAL'));
process.on('SIGTERM', () => console.log('SIGNAL'));
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { if (String(d).includes('release')) release(); });
process.stdin.resume();
console.log('READY');
`;

function has(text, needle, count = 1) {
  if (count === 1) return text.includes(needle);
  return text.split(needle).length - 1 >= count;
}

async function launchChild({ dataDir, port, scenario }) {
  const env = { ...process.env, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: String(port) };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  const child = process.platform === 'win32'
    ? await launchSignalChild(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  const waiters = new Set();
  const flushWaiters = () => {
    const all = out + err;
    for (const w of [...waiters]) {
      if (has(all, w.needle, w.count)) { clearTimeout(w.timer); waiters.delete(w); w.resolve(true); }
    }
  };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out = (out + d).slice(-40000); flushWaiters(); });
  child.stderr.on('data', d => { err = (err + d).slice(-40000); flushWaiters(); });
  const exitInfo = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  exitInfo.then(() => {
    const all = out + err;
    for (const w of [...waiters]) { clearTimeout(w.timer); waiters.delete(w); w.resolve(has(all, w.needle, w.count)); }
  });
  // Event-driven: cada trozo de stdout/stderr despierta a los esperadores; temporizador acotado.
  const waitFor = (needle, ms = 8000, count = 1) => {
    const all = out + err;
    if (has(all, needle, count)) return Promise.resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(false);
    return new Promise(resolve => {
      const w = { needle, count, resolve, timer: null };
      w.timer = setTimeout(() => { waiters.delete(w); resolve(has(out + err, needle, count)); }, ms);
      waiters.add(w);
    });
  };
  return { child, exitInfo, waitFor, port, send: m => { try { child.stdin.write(m + '\n'); } catch { /* el hijo pudo morir */ } }, stdout: () => out, stderr: () => err };
}

async function startChild(children, root, name, scenario) {
  const dataDir = path.join(root, name);
  await mkdir(dataDir, { recursive: true });
  const c = await launchChildOnFreePort({
    launch: port => launchChild({ dataDir, port, scenario }),
    ready: h => h.waitFor('READY'),
  });
  children.push(c);
  assert.ok(await c.waitFor('READY'), `el hijo no llegó a READY (${name}): ${c.stdout()}${c.stderr()}`);
  return c;
}

async function interruptChild(c) {
  if (process.platform === 'win32') return await interruptSignalChild(c.child, 'SIGINT');
  c.child.kill('SIGINT');
}

function ownChildren(t, children, root) {
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.exitInfo));
    await rm(root, { recursive: true, force: true });
  });
}

async function awaitExit(c, ms = 3000) {
  let timer;
  const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const res = await Promise.race([c.exitInfo, watchdog]);
    if (!res) { c.child.kill('SIGKILL'); await c.exitInfo; assert.fail(`el hijo no salió en ${ms}ms: ${c.stdout()}${c.stderr()}`); }
    return res;
  } finally { clearTimeout(timer); }
}

async function childRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-ENGSHUT-'));
  const children = [];
  ownChildren(t, children, root);
  return { root, children };
}

test('el caller real acepta el ACK de cierre y completa la acción aceptada antes de persistir', { timeout: 25000 }, async t => {
  const { root, children } = await childRoot(t);
  const c = await startChild(children, root, 'ack-gate', 'ack-gate');
  assert.ok(await c.waitFor('ALERT-PENDING'), `sin ACK pendiente: ${c.stdout()}${c.stderr()}`);
  await interruptChild(c);
  assert.ok(await c.waitFor('SIGNAL'), `sin señal: ${c.stdout()}${c.stderr()}`);
  const ack = await request({ port: c.port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(ack.status, 200, 'el ACK real durante la parada no debe ser 503: ' + JSON.stringify(ack));
  assert.ok(await c.waitFor('ACTION-RAN'), `la acción aceptada no se ejecutó: ${c.stdout()}${c.stderr()}`);
  c.send('release');
  assert.deepEqual(await awaitExit(c, 6000), { code: 0, signal: null }, c.stdout() + c.stderr());
  const out = c.stdout();
  assert.ok(out.indexOf('ACTION-RAN') < out.indexOf('FLUSH'), 'la acción ACKed precede al flush: ' + out);

  if (process.platform === 'win32') {
    // SIGTERM fuerza la salida nativa sin liberar el gate ni enviar otro Ctrl+C.
    const forced = await startChild(children, root, 'ack-gate-forced-term', 'ack-gate');
    assert.ok(await forced.waitFor('ALERT-PENDING'), `sin ACK pendiente: ${forced.stdout()}${forced.stderr()}`);
    await interruptChild(forced);
    assert.ok(await forced.waitFor('SIGNAL'), `sin señal: ${forced.stdout()}${forced.stderr()}`);
    const forcedAck = await request({ port: forced.port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
    assert.equal(forcedAck.status, 200, 'el ACK real se admite antes de forzar SIGTERM: ' + JSON.stringify(forcedAck));
    assert.ok(await forced.waitFor('ACTION-RAN'), `la acción aceptada no se ejecutó: ${forced.stdout()}${forced.stderr()}`);
    assert.ok(await forced.waitFor('FLUSH'), `no se llegó al flush: ${forced.stdout()}${forced.stderr()}`);
    assert.equal(forced.child.kill('SIGTERM'), true, 'SIGTERM acepta la terminación forzada');
    assert.deepEqual(await awaitExit(forced, 6000), { code: 1, signal: null }, forced.stdout() + forced.stderr());
    assert.equal(forced.stderr(), '', 'la terminación forzada no escribe stderr');
    const forcedOut = forced.stdout();
    assert.equal((forcedOut.match(/SIGNAL/g) || []).length, 1, 'SIGTERM no se traduce en otro Ctrl+C');
    assert.equal((forcedOut.match(/ACTION-RAN/g) || []).length, 1, 'la acción se ejecuta una sola vez');
    assert.equal((forcedOut.match(/FLUSH/g) || []).length, 1, 'el flush pendiente se inicia una sola vez');
    assert.ok(forcedOut.indexOf('ACTION-RAN') < forcedOut.indexOf('FLUSH'), 'la acción ACKed precede al flush pendiente: ' + forcedOut);
  }
});

test('ambos drenajes se intentan aunque uno lance; señales repetidas comparten la transición y sale 1', { timeout: 25000 }, async t => {
  const { root, children } = await childRoot(t);
  const c = await startChild(children, root, 'throw-both', 'throw-both');
  await interruptChild(c);
  assert.ok(await c.waitFor('DRAIN-A'), `drainActions no se invocó: ${c.stdout()}${c.stderr()}`);
  await interruptChild(c);
  assert.ok(await c.waitFor('DRAIN-B'), `drainSentActions no se invocó pese al throw del primero: ${c.stdout()}${c.stderr()}`);
  if (process.platform === 'win32') {
    // El gate mantiene vivo el drenaje hasta observar ambos Ctrl+C en el hijo real.
    assert.ok(await c.waitFor('SIGNAL', 8000, 2), `sin ambas señales: ${c.stdout()}${c.stderr()}`);
    assert.equal((c.stdout().match(/^SIGNAL$/gm) || []).length, 2, 'ambos Ctrl+C llegaron al hijo antes de liberar el drenaje');
    c.send('release');
  }
  assert.deepEqual(await awaitExit(c, 6000), { code: 1, signal: null }, c.stdout() + c.stderr());
  assert.equal((c.stdout().match(/DRAIN-A/g) || []).length, 1, 'una sola transición de drenaje');
  assert.equal((c.stdout().match(/DRAIN-B/g) || []).length, 1, 'una sola transición de drenaje');
});

test('con un drenaje fallido, el otro sano termina y no se persiste antes del idle ACK; sale 1', { timeout: 25000 }, async t => {
  const { root, children } = await childRoot(t);
  const c = await startChild(children, root, 'throw-healthy', 'throw-healthy');
  assert.ok(await c.waitFor('ALERT-PENDING'), `sin ACK pendiente: ${c.stdout()}${c.stderr()}`);
  await interruptChild(c);
  assert.ok(await c.waitFor('DRAIN-A'), `drainActions no se invocó: ${c.stdout()}${c.stderr()}`);
  assert.ok(await c.waitFor('SIGNAL'));
  const ack = await request({ port: c.port, method: 'POST', path: '/api/overlay/shown', body: JSON.stringify({ id: 'a1' }) });
  assert.equal(ack.status, 200, 'el ACK sano se admite pese al fallo del otro drenaje: ' + JSON.stringify(ack));
  assert.ok(await c.waitFor('FLUSH'), `no se llegó al flush: ${c.stdout()}${c.stderr()}`);
  assert.deepEqual(await awaitExit(c, 6000), { code: 1, signal: null }, c.stdout() + c.stderr());
  const out = c.stdout();
  assert.ok(out.indexOf('ACTION-RAN') < out.indexOf('CHAIN-SNAPSHOT'), 'no se captura Store antes del ACK sano: ' + out);
  assert.ok(out.indexOf('CHAIN-SNAPSHOT') < out.indexOf('FLUSH'), 'la captura precede al flush: ' + out);
});

test('un ACK que nunca llega agota el deadline visible y sale 1 sin esperar el fallback', { timeout: 25000 }, async t => {
  const { root, children } = await childRoot(t);
  const c = await startChild(children, root, 'deadline', 'deadline');
  assert.ok(await c.waitFor('ALERT-PENDING'), `sin ACK pendiente: ${c.stdout()}${c.stderr()}`);
  await interruptChild(c);
  assert.ok(await c.waitFor('SIGNAL'));
  assert.deepEqual(await awaitExit(c, 5000), { code: 1, signal: null }, c.stdout() + c.stderr());
  assert.equal(c.stdout().includes('ACTION-RAN'), false, 'no se fabrica ACK ni se ejecuta trabajo no confirmado');
});
