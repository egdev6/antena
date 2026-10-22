// ODD-08 · A/B (salida sana/fallo capturado, solo pruebas): caracteriza el recorrido real de
// `startServer({ handleSignals:false })` → `app.close()` con trabajo aceptado pendiente
// (envío público de chat bloqueado, cola REAL de Store encolada tras `store.chain` y debounce
// de Session/Interactive), persistencia real y SSE abierto. Tras resolver el cierre y liberar
// los recursos exclusivos del harness, el hijo debe terminar NATURALMENTE: código 0/1, sin señal.
//
// NO modifica runtime: observa las fuentes intactas. El cliente SSE vive en el PADRE (http
// loopback), nunca en el hijo. Los seams propios del harness son: puerto efímero pedido al
// kernel con el listen real, doble declarado del envío público `twitch.sendChat` y observadores
// que DELEGAN en `drainChat`/`flush` sin sustituir trabajo. No se copia ni reimplementa el cierre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;

// Hijo REAL: importa `startServer` por import dinámico DESPUÉS de la guardia offline. Solo usa
// APIs públicas y observadores delegantes. No hay `process.exit`, ni wrapper de `process.exit`,
// ni `beforeExit`, ni destrucción manual del SSE, ni keepalive artificial.
const CHILD_PROGRAM = `
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

// Guardia offline ANTES de importar/arrancar: con proveedores en datos temporales y sin tokens,
// ninguna ruta debe usar red externa. Un fetch o WebSocket inesperado se registra y falla.
globalThis.fetch = url => {
  console.log('OFFLINE:FETCH:' + String(url));
  throw new Error('fetch no permitido en el fixture de cierre natural');
};
globalThis.WebSocket = class UnexpectedWebSocket {
  constructor(url) { console.log('OFFLINE:WS:' + String(url)); throw new Error('WebSocket no permitido en el fixture de cierre natural'); }
};
process.on('unhandledRejection', reason => { console.log('UNHANDLED:' + (reason && reason.message ? reason.message : reason)); });

// Seam de listen ya usado por las suites existentes: pide puerto efímero al kernel en el socket
// real, sin reserva previa ni liberación en el padre. Se restaura justo tras startServer.
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) { return realListen.call(this, 0, '127.0.0.1', callback); };

const { startServer } = await import(${JSON.stringify(SERVER_MODULE_URL)});
const mode = process.argv[1];
if (mode !== 'healthy' && mode !== 'failure') throw new Error('modo de fixture inválido');
const failChat = mode === 'failure';
const app = await startServer({ quiet: true, log: (...args) => console.log('APPLOG:' + args.join(' ')), handleSignals: false });
net.Server.prototype.listen = realListen;
console.log('BOUND:' + app.server.address().port);

app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;

// Estado inicial EN DISCO (config 1.25) distinto del valor NUEVO aceptado en memoria (1.75).
await app.store.patchConfig({ tts: { rate: 1.25 } });
const diskConfig = JSON.parse(await readFile(path.join(app.store.dir, 'config.json'), 'utf8'));
console.log('DISK:CONFIG:' + diskConfig.tts.rate);

// Dominio real pendiente por la API pública; sus ficheros aún NO existen en disco.
app.session.record({ id: 'ev-natural', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' });
app.session.setThanked('ev-natural', true);
app.session.addNote({ kind: 'winner', user: 'bea', label: 'premio' });
app.session.addToGoal('bits', 7);
app.store.config.interactive.questions.confirmInChat = false; // precondición explícita, no default implícito
app.store.config.interactive.giveaway.announceInChat = true;
app.interactive.addQuestion({ user: 'ana', platform: 'twitch', text: 'Pregunta de prueba larga' });
const exists = async file => { try { await readFile(file); return true; } catch { return false; } };
console.log('DISK:SESSION:' + (await exists(app.session.file)));
console.log('DISK:INTERACTIVE:' + (await exists(app.interactive.file)));

// Gates independientes: envío público (chat) y cola REAL de Store (write encolado tras chain).
let releaseChat; const chatGate = new Promise(resolve => { releaseChat = resolve; });
let releaseStore; const storeGate = new Promise(resolve => { releaseStore = resolve; });

app.twitch.sendChat = async text => {
  console.log('CHAT:SEND:' + text);
  await chatGate;
  if (failChat) {
    console.log('CHAT:REJECTED');
    throw new Error('synthetic-natural-chat-failure');
  }
  console.log('CHAT:SENT');
  return { is_sent: true };
};
const saying = app.interactive.say('hola chat');   // raíz registrada antes del envío; el envío arranca ya
saying.then(() => { chatSettled = true; console.log('SAY:DONE'); }, () => { chatSettled = true; console.log('SAY:FAIL'); });

// Escritura REAL encolada: el valor aceptado (1.75) se persiste tras la puerta store.chain.
app.store.config.tts.rate = 1.75;
app.store.chain = storeGate;
app.store.write(app.store.cfgFile, app.store.config).then(
  () => console.log('GATE-WRITE-DONE'),
  () => console.log('GATE-WRITE-FAIL')
);
console.log('STORE:QUEUED');

// Observadores delegantes (no sustituyen trabajo): marcan la llegada real a cada fase.
const realDrainChat = app.interactive.drainChat.bind(app.interactive);
app.interactive.drainChat = (...args) => { console.log('CHAT:DRAIN'); return realDrainChat(...args); };
const realSessionFlush = app.session.flush.bind(app.session);
app.session.flush = (...args) => { persistEntered = true; console.log('PERSIST:SESSION'); return realSessionFlush(...args); };
const realInteractiveFlush = app.interactive.flush.bind(app.interactive);
app.interactive.flush = (...args) => { console.log('PERSIST:INTERACTIVE'); return realInteractiveFlush(...args); };

let settled = false, closed = false, probes = 0, chatSettled = false, persistEntered = false;
process.stdin.setEncoding('utf8');
let buf = '';
const onLine = line => {
  const cmd = line.trim();
  if (!cmd) return;
  if (cmd === 'close') {
    const p = app.close();
    const q = app.close();
    console.log('CLOSE:SAME:' + (p === q));           // promesa publicada y cacheada
    p.then(code => {
      settled = true;
      process.exitCode = code;                        // salida natural: sin process.exit ni señal
      console.log('CLOSED:' + code);
      closed = true;
    }, err => {
      settled = true;
      process.exitCode = 1;
      console.log('CLOSE:REJECTED:' + (err && err.message ? err.message : err));
      closed = true;
    });
    console.log('CLOSE:STARTED');
  } else if (cmd === 'probe') {
    probes += 1;
    console.log('PROBE:' + probes + ':PENDING:' + !settled + ':CLOSED:' + closed + ':PERSIST:' + persistEntered + ':CHATSETTLED:' + chatSettled);
  } else if (cmd === 'chat') releaseChat();
  else if (cmd === 'store') {
    releaseStore();
    process.stdin.destroy(); // retirar el control al liberar la última gate, no al resolver close
  }
};
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
});
process.stdin.resume();
console.log('READY');
`;

function launchChild({ dataDir, failChat }) {
  const env = { PATH: process.env.PATH, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: '0' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, failChat ? 'failure' : 'healthy'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w.check(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; notify(); });
  child.stderr.on('data', d => { err += d; notify(); });
  const exitInfo = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const all = () => out + err;
  // Waiter por evento/linea: sin sleeps ni polling. `from` es un cursor fresco sobre la salida.
  function waitFor(marker, ms = 8000, from = 0) {
    return new Promise((resolve, reject) => {
      const w = { check() { if (all().indexOf(marker, from) >= 0) { cleanup(); resolve(all()); } } };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`no llegó «${marker}» en ${ms}ms\n--- stdout ---\n${out}\n--- stderr ---\n${err}`)); }, ms);
      function cleanup() { clearTimeout(timer); waiters.delete(w); }
      waiters.add(w); w.check();
    });
  }
  return {
    child, exitInfo, waitFor,
    send: line => { try { child.stdin.write(`${line}\n`); } catch { /* el hijo pudo cerrar su stdin */ } },
    endStdin: () => { try { child.stdin.end(); } catch { /* ya cerrado */ } },
    stdout: () => out, stderr: () => err, all,
  };
}

// Watchdog de FALLO: si la promesa observada no termina en `ms`, se reporta el fallo observado.
async function within(promise, ms, label) {
  let timer;
  const watchdog = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout esperando ${label}`)), ms); });
  try { return await Promise.race([promise, watchdog]); } finally { clearTimeout(timer); }
}

// Cliente SSE del PADRE: consume bytes y observa el cierre iniciado por la aplicación.
function connectSse(port) {
  let readyResolve, closeResolve;
  const ready = new Promise(r => { readyResolve = r; });
  const closed = new Promise(r => { closeResolve = r; });
  const req = http.request({ host: '127.0.0.1', port, path: '/api/stream?client=overlay' });
  req.on('error', () => {});
  req.on('response', res => { res.resume(); readyResolve(res); });
  req.on('close', () => closeResolve(true));
  req.end();
  return { req, ready, closed };
}

async function characterizeClose(t, { failChat, expectedCode }) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-NATURAL-'));
  const dataDir = path.join(root, 'hijo');
  await mkdir(dataDir, { recursive: true });
  const c = launchChild({ dataDir, failChat });
  let sse, complete = false;
  t.after(async () => {
    if (!complete) sse?.req.destroy(); // sólo fracaso: nunca ayudar a que un caso termine
    if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await c.exitInfo;   // limpieza de FALLO; nunca cuenta como salida válida
    await rm(root, { recursive: true, force: true });
  });

  await c.waitFor('READY');
  const bound = /(?:^|\n)BOUND:(\d+)(?:\n|$)/.exec(c.all());
  assert.ok(bound, `el hijo debe anunciar el puerto real asignado por el kernel: ${c.all()}`);
  const port = Number(bound[1]);
  assert.ok(Number.isInteger(port) && port > 0, 'puerto efímero real del kernel');
  assert.match(c.all(), /DISK:CONFIG:1\.25/, 'el disco debe tener el valor viejo antes de aceptar el nuevo');
  assert.match(c.all(), /DISK:SESSION:false/, 'Session debe seguir pendiente, no guardada antes del cierre');
  assert.match(c.all(), /DISK:INTERACTIVE:false/, 'Interactive debe seguir pendiente, no guardado antes del cierre');
  assert.match(c.all(), /^CHAT:SEND:hola chat$/m, 'el envío real del fixture debe estar aceptado antes de cerrar');
  assert.match(c.all(), /^STORE:QUEUED$/m);

  // C2: SSE en el padre con respuesta observada antes del primer cierre.
  sse = connectSse(port);
  const res = await within(sse.ready, 5000, 'respuesta SSE');
  assert.equal(res.statusCode, 200, 'el SSE debe admitirse con 200 antes del cierre');

  // C3: cierre real publicado y cacheado; dos llamadas comparten la MISMA promesa.
  c.send('close');
  await c.waitFor('CLOSE:STARTED');
  await c.waitFor('CLOSE:SAME:true');

  // Llegada real al drenaje de chat con su gate bloqueado: primer probe candidato.
  // La puerta de Store también está bloqueada, así que `PENDING` por sí solo no prueba que se
  // espera al chat: el probe exige además que la fase de persistencia AÚN NO haya comenzado.
  await c.waitFor('CHAT:DRAIN');
  let cursor = c.all().length;
  c.send('probe');
  await c.waitFor('PROBE:1:PENDING:true:CLOSED:false:PERSIST:false:CHATSETTLED:false', 5000, cursor);
  assert.doesNotMatch(c.all(), /PERSIST:SESSION/, 'sin chat resuelto no puede haber entrado la persistencia');
  assert.doesNotMatch(c.all(), /^CLOSED:/m, 'no debe haber CLOSED con el chat bloqueado');
  assert.doesNotMatch(c.all(), /CLOSE:REJECTED/);

  // Liberar el envío público: settlement observable y llegada REAL a la fase de persistencia.
  c.send('chat');
  const chatResult = failChat ? 'CHAT:REJECTED' : 'CHAT:SENT';
  const chatWarning = 'APPLOG:[parada] No se pudieron completar los mensajes del chat.';
  await c.waitFor(chatResult);
  await c.waitFor('SAY:DONE'); // say normal absorbe el rechazo; no equivale a envío exitoso
  if (failChat) await c.waitFor(chatWarning);
  await c.waitFor('PERSIST:SESSION');
  // Presencia explícita antes de comparar índices: -1 nunca acredita precedencia.
  const trace = c.all();
  const ordered = ['CHAT:DRAIN', chatResult, 'SAY:DONE', 'PERSIST:SESSION'];
  for (const marker of ordered) assert.ok(trace.includes(marker), 'marcador ausente: ' + marker + '\n' + trace);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(trace.indexOf(ordered[i - 1]) < trace.indexOf(ordered[i]), 'orden causal incorrecto: ' + trace);
  }
  if (failChat) {
    assert.ok(trace.indexOf(chatResult) < trace.indexOf(chatWarning), 'el aviso debe capturar el rechazo real');
    assert.ok(trace.indexOf(chatWarning) < trace.indexOf('PERSIST:SESSION'), 'el fallo capturado no debe saltar la persistencia');
  }

  // Segundo probe con el Store aún bloqueado: confirma que sigue pendiente y sin CLOSED, ya en persistencia.
  cursor = c.all().length;
  c.send('probe');
  await c.waitFor('PROBE:2:PENDING:true:CLOSED:false:PERSIST:true:CHATSETTLED:true', 5000, cursor);
  assert.doesNotMatch(c.all(), /^CLOSED:/m);
  assert.doesNotMatch(c.all(), /GATE-WRITE-DONE/, 'la escritura encolada no puede completarse antes de liberar Store');

  // Liberar la cola real de Store y retirar el control del padre tras la última gate.
  c.send('store');
  c.endStdin();

  await c.waitFor('GATE-WRITE-DONE');
  await c.waitFor('CLOSED:' + expectedCode);
  assert.deepEqual(await within(c.exitInfo, 5000, 'salida natural del hijo'), { code: expectedCode, signal: null }, c.all());
  assert.match(c.stdout(), new RegExp('^CLOSED:' + expectedCode + '$', 'm')); // distinto del campo CLOSED del probe
  assert.match(c.stdout(), /^PERSIST:INTERACTIVE$/m, 'el flush independiente también debe intentarse');
  assert.equal(await within(sse.closed, 5000, 'cierre SSE observado por el padre'), true, 'el transporte SSE debe cerrarse sin ayuda manual');

  // C7: JSON reales leídos DESPUÉS del evento de cierre del hijo.
  const config = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.tts.rate, 1.75, 'la escritura encolada debe persistir el valor nuevo');
  const session = JSON.parse(await readFile(path.join(dataDir, 'session-current.json'), 'utf8'));
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].id, 'ev-natural');
  assert.equal(session.events[0].thanked, true);
  assert.ok(session.notes.some(n => n.kind === 'winner' && n.user === 'bea' && n.label === 'premio'), 'la nota aceptada debe persistir');
  assert.equal(session.goalOffsets.bits, 7);
  const interactive = JSON.parse(await readFile(path.join(dataDir, 'interactive.json'), 'utf8'));
  assert.equal(interactive.questions.length, 1);
  assert.equal(interactive.questions[0].user, 'ana');
  assert.equal(interactive.questions[0].platform, 'twitch');
  assert.equal(interactive.questions[0].text, 'Pregunta de prueba larga');

  // Guardas de la observación: sin IO externa, sin rechazos huérfanos, sin atajos de salida.
  assert.doesNotMatch(c.all(), /OFFLINE:|UNHANDLED:|WILLEXIT|beforeExit|CLOSE:REJECTED|SAY:FAIL|GATE-WRITE-FAIL/);
  assert.doesNotMatch(c.all(), /drenado agotado/, 'código 1 por deadline nunca acredita B');
  const shutdownLogs = c.stdout().split('\n').filter(line => line.startsWith('APPLOG:[parada]'));
  assert.deepEqual(shutdownLogs, failChat ? [chatWarning] : [], 'sin fallos ajenos que expliquen el resultado');
  if (failChat) {
    assert.match(c.stdout(), /^CHAT:REJECTED$/m);
    assert.match(c.stdout(), /^APPLOG:\[sorteo\] synthetic-natural-chat-failure$/m);
    assert.doesNotMatch(c.all(), /CHAT:SENT/);
  } else {
    assert.match(c.stdout(), /^CHAT:SENT$/m);
    assert.doesNotMatch(c.all(), /CHAT:REJECTED|synthetic-natural-chat-failure/);
  }
  assert.equal(c.stderr(), '');
  complete = true;
}

test('ODD-08 A: app.close real drena chat/Store y el hijo sale solo con 0, SSE cerrado y 3 JSON', { timeout: 30000 }, async t => {
  await characterizeClose(t, { failChat: false, expectedCode: 0 });
});

test('ODD-08 B: chat rechaza, say lo absorbe y app.close sale solo con 1 tras Store, SSE y 3 JSON', { timeout: 30000 }, async t => {
  await characterizeClose(t, { failChat: true, expectedCode: 1 });
});
