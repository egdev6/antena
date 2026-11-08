// Contrato 08b.2a (solo pruebas, fuente aún sin implementar): `createApp().closeHttp()` cierra el
// transporte HTTP. Al invocarlo corta la admisión de forma SÍNCRONA, devuelve una única promesa
// idempotente que espera a los handlers admitidos y DESPUÉS cierra listener, SSE, raw idle y
// keepalive (incluido el ping propio de SSE). Un relisten nuevo o ya encolado no debe revivir el
// servidor. El llamador de señal debe esperar la clausura del transporte DESPUÉS de persistir, sin
// soltar el deadline, y salir 1 ante cualquier error. Este corte NO reclama `app.close` global ni
// propiedad de productores ni de MCP. Se conservan intactas las suites 08a (server-shutdown) y
// 08b.1 (server-admission).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { launchSignalChild, interruptSignalChild, windowsTimeout } from './helpers/signal-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';
import { createApp } from '../src/server.mjs';

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;
const CLOSING = 'La app se está cerrando.';
const delay = ms => new Promise(r => setTimeout(r, ms));

// Puerto libre con reintento: helpers/free-port.mjs (elimina la carrera de freePort, #78).

// Resuelve `true` si la promesa termina antes del límite; limpia su temporizador SIEMPRE.
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise(r => { timer = setTimeout(() => r(false), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

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
    req.end(body);
  });
}

// PUT con cuerpo partido: el handler queda admitido esperando `readBody` hasta `finish()`.
function openPut({ port, fullBody }) {
  const cut = Math.floor(fullBody.length / 2);
  const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/config', headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(fullBody)) } });
  req.on('error', () => {});
  const response = new Promise(resolve => {
    req.on('response', res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', () => resolve({ status: res.statusCode, body: data }));
    });
  });
  req.write(fullBody.slice(0, cut));
  return { req, response, finish: () => req.end(fullBody.slice(cut)) };
}

function openSse(port) {
  const req = http.request({ host: '127.0.0.1', port, path: '/api/stream?client=overlay' });
  req.on('error', () => {});
  let ready; const readyP = new Promise(r => { ready = r; });
  const closed = new Promise(resolve => {
    req.on('response', res => {
      if (res.statusCode === 200) ready();
      res.resume();
      res.on('end', () => resolve('end'));
      res.on('close', () => resolve('close'));
    });
    req.on('error', () => resolve('error'));
  });
  req.end();
  return { req, ready: readyP, closed };
}

function rawIdle(port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  return {
    socket,
    connected: new Promise(r => socket.once('connect', r)),
    closed: new Promise(r => socket.once('close', () => r(true))),
  };
}

// Cliente keepalive real: una vez termina la respuesta, el socket queda vivo en el pool del agente.
function keepAliveSocket(port) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', agent }, res => {
      const socket = res.socket;   // capturado ANTES de `end`: después Node lo libera y queda null
      res.resume();
      res.on('end', () => resolve({ agent, socket, closed: new Promise(r => socket.once('close', () => r(true))) }));
    });
    req.on('error', reject);
  });
}

async function makeApp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-CLOSEHTTP-'));
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

test('closeHttp es público, idempotente (misma promesa) y cierra sin haberse escuchado', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  assert.equal(typeof app.closeHttp, 'function', 'createApp debe exponer closeHttp (contrato 08b.2a): no existe todavía');
  const first = app.closeHttp();
  assert.equal(typeof first?.then, 'function', 'closeHttp debe devolver una promesa');
  assert.equal(app.closeHttp(), first, 'las llamadas repetidas comparten la MISMA promesa');
  assert.equal(await within(first, 2000), true, 'cerrar sin haber escuchado debe resolverse con éxito');
});

test('closeHttp corta la admisión al instante, drena un PUT admitido y cierra el listener', { timeout: 15000 }, async t => {
  const { app, root } = await makeApp(t);
  const port = await listen(app);
  let admit; const admitted = new Promise(r => { admit = r; });
  app.server.on('request', () => admit());
  const put = openPut({ port, fullBody: JSON.stringify({ tts: { rate: 1.75 } }) });
  await admitted;
  const closing = typeof app.closeHttp === 'function' ? app.closeHttp() : Promise.resolve();
  const late = await request({ port, method: 'PUT', path: '/api/config', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tts: { rate: 9.99 } }) });
  assert.equal(late.status, 503, 'una petición nueva tras el cierre debe recibir 503: ' + JSON.stringify(late));
  assert.ok(String(late.body).includes(CLOSING), 'falta el mensaje constante de cierre');
  assert.equal(app.server.listening, true, 'el listener no debe cerrarse antes de drenar lo admitido');
  put.finish();
  const res = await put.response;
  assert.equal(res.status, 200, 'el PUT admitido antes del cierre debe terminar 200: ' + JSON.stringify(res));
  assert.equal(await within(closing, 2000), true, 'closeHttp debe resolver tras drenar lo admitido');
  assert.equal(app.server.listening, false, 'el listener debe quedar cerrado');
  const cfg = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, 1.75, 'lo admitido debe persistir antes del cierre, no el 9.99 tardío');
});

test('un OAuth admitido termina 200 y persiste antes del cierre; lo nuevo recibe 503', { timeout: 15000 }, async t => {
  const { app, root } = await makeApp(t);
  const port = await listen(app);
  let enter; const entered = new Promise(r => { enter = r; });
  let release; const gate = new Promise(r => { release = r; });
  app.youtube.finishAuth = async () => { enter(); await gate; await app.store.patchConfig({ tts: { rate: 1.75 } }); return 'cuenta-fake'; };
  const admitted = request({ port, path: '/oauth/youtube?code=admitido&state=s', timeoutMs: 8000 });
  await entered;
  const closing = typeof app.closeHttp === 'function' ? app.closeHttp() : Promise.resolve();
  const late = await request({ port, path: '/oauth/youtube?code=tarde&state=s', timeoutMs: 1500 });
  assert.equal(late.status, 503, 'un OAuth nuevo tras el cierre debe recibir 503, no ejecutarse: ' + JSON.stringify(late));
  assert.equal(app.server.listening, true, 'no debe cerrar el listener con el OAuth admitido en curso');
  release();
  const res = await admitted;
  assert.equal(res.status, 200, 'el OAuth admitido debe completar 200: ' + JSON.stringify(res));
  assert.ok(res.body.includes('cuenta-fake'));
  assert.equal(await within(closing, 2000), true, 'closeHttp debe resolver tras el OAuth admitido');
  assert.equal(app.server.listening, false);
  const cfg = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, 1.75, 'la persistencia posterior al await debe quedar antes del cierre');
});

test('closeHttp cierra SSE (sin ping colgado), raw idle y keepalive', { timeout: 15000 }, async t => {
  const { app } = await makeApp(t);
  const port = await listen(app);
  const sse = openSse(port);
  assert.equal(await within(sse.ready, 2000), true, 'el SSE debe admitirse antes del cierre');
  const idle = rawIdle(port);
  await idle.connected;
  const keep = await keepAliveSocket(port);
  const closing = typeof app.closeHttp === 'function' ? app.closeHttp() : Promise.resolve();
  assert.equal(await within(sse.closed, 2000), true, 'el SSE debe terminar con el cierre, no quedar colgado');
  assert.equal(await within(idle.closed, 2000), true, 'el socket raw idle debe cerrarse');
  assert.equal(await within(keep.closed, 2000), true, 'el socket keepalive debe cerrarse');
  keep.agent.destroy();
  assert.equal(await within(closing, 2000), true, 'closeHttp debe resolver con todo cerrado');
  assert.equal(app.server.listening, false);
});

// Hijo REAL: importa `startServer` de producción y solo engancha seams públicos (stdin, flush por
// instancia y el método nuevo). Nunca reimplementa el shutdown; observa el evento real de cierre.
const CHILD_START = `
import { startServer } from ${JSON.stringify(SERVER_MODULE_URL)};
const scenario = process.argv[1] || 'signal';
const timeout = Number(process.env.CHILD_TIMEOUT_MS || 0);
const app = await startServer({ quiet: true, log: () => {}, ...(timeout ? { shutdownTimeoutMs: timeout } : {}) });
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
app.server.on('close', () => console.log('SERVER-CLOSE'));
app.session.flush = async () => { console.log('FLUSH'); };
if (scenario === 'close-fail') app.closeHttp = () => { console.log('CLOSE-FAIL'); return Promise.reject(new Error('boom')); };
if (scenario === 'close-hang') app.closeHttp = () => { console.log('CLOSE-HANG'); return new Promise(() => {}); };
if (scenario === 'relisten') app.store.config.access.lan = true;
const realExit = process.exit.bind(process);
process.exit = code => { process.stdout.write('WILLEXIT:' + code + '\\n', () => realExit(code)); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  if (scenario === 'flush-output' && String(chunk).includes('go')) {
    process.stderr.write('BACKPRESSURE\\n', () => {
      process.stdout.write('x'.repeat(4 * 1024 * 1024) + 'FLUSH-END\\n');
      process.exit(0);
    });
  }
  if (scenario === 'relisten' && String(chunk).includes('go')) {
    app.emit('relisten');
    if (typeof app.closeHttp === 'function') await app.closeHttp(); else console.log('NOCLOSE');
    console.log('CLOSED');
    setTimeout(() => {
      console.log('LISTEN-QUEUED:' + app.server.listening);
      app.emit('relisten');
      setTimeout(() => { console.log('LISTEN-AFTER:' + app.server.listening); process.exit(0); }, 150);
    }, 250);
  }
});
if (scenario === 'relisten' || scenario === 'flush-output') process.stdin.resume(); else process.stdin.destroy();
console.log('READY');
`;

// Hijo de `createApp` sin signal handlers ni deadline: solo el SSE, su ping y los sockets deben
// decidir si el proceso termina SOLO. No se limpia el ping a mano: si closeHttp lo filtra, cuelga.
const CHILD_CREATE = `
import { createApp } from ${JSON.stringify(SERVER_MODULE_URL)};
import http from 'node:http';
const app = await createApp({ dataDir: process.env.CHILD_DATA, mediaDir: process.env.ANTENA_MEDIA, log: () => {} });
app.twitch.stop?.(); app.youtube.stop?.(); app.chat.stop?.(); app.meld.stop?.(); app.timers.stop?.();
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const req = http.request({ host: '127.0.0.1', port: app.server.address().port, path: '/api/stream?client=overlay' });
req.on('error', () => {});
req.on('response', async res => {
  res.resume();
  console.log('SSE-READY');
  if (typeof app.closeHttp === 'function') await app.closeHttp(); else console.log('NOCLOSE');
  console.log('CLOSED');
});
req.end();
process.stdin.destroy();
console.log('READY');
`;

async function launchChild({ dataDir, port, scenario, timeoutMs, program }) {
  const env = { ...process.env, CHILD_DATA: dataDir, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: String(port) };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  if (timeoutMs) env.CHILD_TIMEOUT_MS = String(timeoutMs);
  const child = await launchSignalChild(process.execPath, ['--input-type=module', '-e', program, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out = (out + d).slice(-40000); });
  child.stderr.on('data', d => { err = (err + d).slice(-40000); });
  const exitInfo = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  const closeInfo = new Promise(res => child.once('close', (code, signal) => res({ code, signal })));
  const waitFor = async (needle, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((out + err).includes(needle)) return true;
      if (child.exitCode !== null || child.signalCode !== null) return false;
      await delay(20);
    }
    return (out + err).includes(needle);
  };
  return { child, exitInfo, closeInfo, waitFor, send: m => { try { child.stdin.write(m + '\n'); } catch { /* el hijo pudo morir */ } }, stdout: () => out, stderr: () => err };
}

async function awaitExit(c, ms = 3000) {
  let timer;
  const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  let res;
  try {
    res = await Promise.race([c.exitInfo, watchdog]);
    if (!res) { c.child.kill('SIGKILL'); await c.exitInfo; assert.fail(`el hijo no salió en ${ms}ms: ${c.stdout()}${c.stderr()}`); }
  } finally { clearTimeout(timer); }

  // Windows publishes exit before the controller has drained the output pipes.
  const closeDeadlineMs = 15000;
  const closeWatchdog = new Promise(resolve => { timer = setTimeout(() => resolve(false), closeDeadlineMs); });
  try {
    const closed = await Promise.race([c.closeInfo.then(() => true), closeWatchdog]);
    assert.ok(closed, `child output did not close within ${closeDeadlineMs}ms: ${c.stdout()}${c.stderr()}`);
    return res;
  } finally { clearTimeout(timer); }
}

async function makeChildRoot(t, children) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-CLOSEHTTP-'));
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.closeInfo));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function startChild(children, root, name, scenario, timeoutMs, program = CHILD_START) {
  const dataDir = path.join(root, name);
  await mkdir(dataDir, { recursive: true });
  const c = await launchChildOnFreePort({
    launch: port => launchChild({ dataDir, port, scenario, timeoutMs, program }),
    ready: h => h.waitFor('READY', 8000),
  });
  children.push(c);
  assert.ok(await c.waitFor('READY'), `el hijo no llegó a READY (${name}): ${c.stdout()}${c.stderr()}`);
  return c;
}

test('fixture flushes buffered stdout before process exit', { timeout: windowsTimeout(1, 45000) }, async t => {
  const children = []; const root = await makeChildRoot(t, children);
  const c = await startChild(children, root, 'flush-output', 'flush-output');
  c.child.stdout.pause();
  try {
    c.send('go');
    assert.ok(await c.waitFor('BACKPRESSURE'), c.stderr());
    let exited = false;
    c.exitInfo.then(() => { exited = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exited, false, 'the child must wait for stdout backpressure to clear');
  } finally {
    c.child.stdout.resume();
  }
  assert.deepEqual(await awaitExit(c, 5000), { code: 0, signal: null });
  assert.ok(c.stdout().endsWith('FLUSH-END\nWILLEXIT:0\n'), 'the final buffered markers must reach stdout');
});

// POSIX only: a grandchild that inherits stdout keeps the pipe open after the child exits. On
// Windows the native signal controller does not relay a grandchild's output after the child
// exits, so the scenario this regression pins does not exist there.
test('child exit does not complete the wait before inherited stdout closes', {
  timeout: 15000,
  skip: process.platform === 'win32' && 'POSIX inherited-stdout scenario; the Windows signal controller does not relay grandchild output after exit',
}, async t => {
  const children = [];
  let accept;
  const connected = new Promise(resolve => { accept = resolve; });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    accept(socket);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const root = await makeChildRoot(t, children);
  const descendant = `
import net from 'node:net';
const socket = net.connect(Number(process.argv[1]), '127.0.0.1');
socket.once('connect', () => process.send('connected'));
socket.once('data', () => process.stdout.write('AFTER-EXIT\\n', () => socket.end()));
socket.once('error', () => { process.exitCode = 1; });
`;
  const program = `
import { spawn } from 'node:child_process';
const descendant = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(descendant)}, ${JSON.stringify(String(server.address().port))}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
descendant.once('error', () => process.exit(1));
descendant.once('message', () => process.exit(0));
`;
  const c = await launchChild({ dataDir: root, port: 0, scenario: 'drain', program });
  children.push(c);
  const drained = new Promise(resolve => c.child.stdout.once('end', resolve));
  const socket = await connected;
  let completed = false;
  const finished = awaitExit(c, 5000).then(result => { completed = true; return result; });
  try {
    assert.deepEqual(await c.exitInfo, { code: 0, signal: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'exit must not stand in for drained stdout');
    socket.write('release');
    assert.deepEqual(await finished, { code: 0, signal: null });
    assert.match(c.stdout(), /AFTER-EXIT/);
  } finally {
    if (!socket.destroyed) socket.write('release');
    await drained;
    await finished.catch(() => {});
  }
});

test('tras closeHttp, ni un relisten nuevo ni el callback ya encolado reviven el servidor', { timeout: windowsTimeout(1, 20000) }, async t => {
  const children = []; const root = await makeChildRoot(t, children);
  const c = await startChild(children, root, 'relisten', 'relisten');
  c.send('go');
  assert.ok(await c.waitFor('CLOSED'), `closeHttp no terminó: ${c.stdout()}${c.stderr()}`);
  assert.ok(await c.waitFor('LISTEN-QUEUED:'), `sin marcador LISTEN-QUEUED: ${c.stdout()}`);
  assert.match(c.stdout(), /LISTEN-QUEUED:false/, 'el callback de relisten ya encolado no debe revivir el listener: ' + c.stdout());
  assert.ok(await c.waitFor('LISTEN-AFTER:'), `sin marcador LISTEN-AFTER: ${c.stdout()}`);
  assert.match(c.stdout(), /LISTEN-AFTER:false/, 'un relisten posterior al cierre no debe escuchar: ' + c.stdout());
  assert.deepEqual(await awaitExit(c, 3000), { code: 0, signal: null });
});

test('la señal espera la clausura real del transporte; cierre fallido o colgado sale 1', { timeout: windowsTimeout(3, 30000) }, async t => {
  const children = []; const root = await makeChildRoot(t, children);
  {
    const c = await startChild(children, root, 'signal', 'signal', 5000);
    await interruptSignalChild(c.child);
    assert.deepEqual(await awaitExit(c, 5000), { code: 0, signal: null }, c.stdout() + c.stderr());
    const out = c.stdout();
    assert.ok(out.includes('SERVER-CLOSE'), 'la señal debe cerrar el servidor real antes de salir 0: ' + out);
    assert.ok(out.includes('FLUSH'), 'debe persistir antes de cerrar: ' + out);
    assert.ok(out.indexOf('FLUSH') < out.indexOf('SERVER-CLOSE'), 'la persistencia debe completarse ANTES del cierre del transporte: ' + out);
  }
  {
    const c = await startChild(children, root, 'fail', 'close-fail', 5000);
    await interruptSignalChild(c.child);
    assert.deepEqual(await awaitExit(c, 5000), { code: 1, signal: null }, c.stdout() + c.stderr());
    assert.ok(c.stdout().includes('CLOSE-FAIL'), 'el cierre debe intentarse y su error propagar exit 1: ' + c.stdout());
  }
  {
    const c = await startChild(children, root, 'hang', 'close-hang', 150);
    await interruptSignalChild(c.child);
    assert.deepEqual(await awaitExit(c, 3000), { code: 1, signal: null }, c.stdout() + c.stderr());
    assert.ok(c.stdout().includes('CLOSE-HANG'), 'el deadline debe seguir vigente durante el cierre del transporte: ' + c.stdout());
  }
});

test('SSE + closeHttp no deja el ping: el hijo de createApp termina solo', { timeout: windowsTimeout(1, 20000) }, async t => {
  const children = []; const root = await makeChildRoot(t, children);
  const c = await startChild(children, root, 'natural', 'natural', 0, CHILD_CREATE);
  assert.ok(await c.waitFor('CLOSED'), `closeHttp no terminó: ${c.stdout()}${c.stderr()}`);
  assert.deepEqual(await awaitExit(c, 4000), { code: 0, signal: null }, 'con el ping y los sockets cerrados, el proceso debe salir solo (sin process.exit): ' + c.stdout() + c.stderr());
});
