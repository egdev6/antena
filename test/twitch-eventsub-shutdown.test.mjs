// Contrato 08b.2b.1 (solo pruebas, fuente aún sin implementar): `Twitch.quiesceEventSub()`
// es un corte terminal síncrono e idempotente que espera el validate/welcome-subscribe ya en
// marcha, cierra el WS vigente y el pendiente, cancela keepalive/reconexión y deja el estado en
// desconectado. Tras el corte, welcome/validate/onclose obsoletos no reconectan ni resuscriben y
// un start posterior no revive el WS. Un stop/start ordinario sigue siendo reiniciable. La señal
// real de startServer espera este seam dinámico antes de la instantánea de Store y el flush.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';
import { Twitch } from '../src/twitch.mjs';

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;
const delay = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));

class FakeWs extends EventTarget {
  constructor(url) { super(); this.url = url; this.closed = false; this.readyState = 1; FakeWs.created.push(this); }
  close() { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
class DelayedWs extends FakeWs {
  close() { this.closeCalls = (this.closeCalls || 0) + 1; this.closeCalled = true; this.readyState = 2; }
  finishClose() { super.close(); }
}
FakeWs.created = [];
const instances = [];

function makeTwitch(overrides = {}) {
  const store = {
    config: { twitch: { clientId: 'cid' }, chat: {} },
    secrets: { twitch: { access: 'a', refresh: 'r', expiresAt: Date.now() + 1e6 } },
    async setSecret(k, v) { this.secrets[k] = v; },
  };
  const twitch = Object.assign(new Twitch(store, () => {}), overrides);
  instances.push(twitch);
  return twitch;
}

// El proceso de este archivo está aislado por node:test. Mantener los dobles hasta beforeExit
// cubre también timers heredados no registrados que sobreviven a una aserción RED fallida.
before(() => {
  const originalWs = globalThis.WebSocket, originalFetch = globalThis.fetch;
  globalThis.WebSocket = FakeWs;
  globalThis.fetch = () => { throw new Error('Red externa prohibida en este harness'); };
  process.once('beforeExit', () => { globalThis.WebSocket = originalWs; globalThis.fetch = originalFetch; });
});
after(() => {
  for (const twitch of instances) {
    twitch.stopped = true;
    clearTimeout(twitch.keepaliveTimer);
    clearTimeout(twitch.reconnectTimer);
  }
});

test('quiesceEventSub es terminal, idempotente y sin arrancar resuelve', async () => {
  const twitch = makeTwitch();
  assert.equal(typeof twitch.quiesceEventSub, 'function', 'falta quiesceEventSub (08b.2b.1): no existe todavía');
  const first = twitch.quiesceEventSub();
  assert.equal(twitch.quiesceEventSub(), first, 'las llamadas repetidas comparten la MISMA promesa');
  let timer;
  try {
    const settled = await Promise.race([first.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 1000); })]);
    assert.equal(settled, true, 'sin haber arrancado debe resolver');
  } finally { clearTimeout(timer); }
});

test('el corte espera el cierre físico de ambos WebSockets, también uno ya cerrándose', async t => {
  const twitch = makeTwitch(); twitch.stopped = false;
  const cur = new DelayedWs('cur'), pend = new DelayedWs('pend');
  twitch.ws = cur; twitch.pending = pend;
  cur.close();
  t.after(() => { cur.finishClose(); pend.finishClose(); });
  const q = twitch.quiesceEventSub();
  let settled = false; q.then(() => { settled = true; }, () => { settled = true; });
  assert.equal(twitch.quiesceEventSub(), q);
  assert.equal(pend.closeCalled, true, 'iniciar ambos cierres antes de esperar');
  await tick();
  assert.equal(settled, false, 'close() no es el fin físico del socket');
  cur.finishClose(); await tick();
  assert.equal(settled, false, 'el socket pendiente también debe cerrar');
  pend.finishClose(); await q;
  assert.equal(cur.readyState, 3); assert.equal(pend.readyState, 3);
});

test('el corte espera el socket histórico sustituido aunque vigente y pendiente ya cerraron', async t => {
  const originalWs = globalThis.WebSocket;
  globalThis.WebSocket = DelayedWs;
  const twitch = makeTwitch(); twitch.stopped = false;
  const sockets = [];
  t.after(() => { for (const ws of sockets) ws.finishClose(); globalThis.WebSocket = originalWs; });
  twitch.connect('wss://eventsub.example/old');
  const old = twitch.ws; sockets.push(old);
  old.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://eventsub.example/current' } } }) });
  const current = twitch.pending; sockets.push(current);
  current.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'replacement' } } }) });
  assert.equal(twitch.ws, current);
  assert.equal(old.readyState, 2, 'el handoff sólo inició el cierre histórico');
  twitch.connect('wss://eventsub.example/pending', { isReconnect: true });
  const pending = twitch.pending; sockets.push(pending);
  const q = twitch.quiesceEventSub();
  assert.equal(twitch.quiesceEventSub(), q, 'el cierre histórico comparte el corte idempotente');
  let settled = false; q.then(() => { settled = true; }, () => { settled = true; });
  current.finishClose(); pending.finishClose();
  await tick();
  assert.equal(settled, false, 'quiesce no debe resolver antes del close físico del socket histórico');
  old.finishClose();
  await q;
  assert.deepEqual(sockets.map(ws => ws.closeCalls), [1, 1, 1], 'un solo handshake por socket');
  const base = FakeWs.created.length;
  for (const ws of sockets) {
    ws.onclose(); ws.onerror(new Event('error'));
    ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://eventsub.example/stale' } } }) });
    ws.onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'stale' } } }) });
  }
  await twitch.start(); twitch.connect('wss://eventsub.example/terminal');
  assert.equal(FakeWs.created.length, base, 'callbacks stale y start/connect no reviven sockets');
  assert.equal(twitch.keepaliveTimer, null); assert.equal(twitch.reconnectTimer, null);
});

function delayedEventSub(t) {
  const originalWs = globalThis.WebSocket, base = FakeWs.created.length;
  globalThis.WebSocket = DelayedWs;
  const twitch = makeTwitch(); twitch.stopped = false;
  t.after(() => {
    twitch.stopped = true;
    for (const ws of FakeWs.created.slice(base)) if (ws.readyState !== 3) ws.finishClose();
    globalThis.WebSocket = originalWs;
  });
  return twitch;
}

const welcomeFrame = { metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'replacement' } } };

for (const nativeError of [false, true]) {
  test(`histórico cerrado antes del corte se retira sin repetir close (error nativo: ${nativeError})`, async t => {
    const twitch = delayedEventSub(t);
    twitch.connect('wss://eventsub.example/old');
    const old = twitch.ws;
    twitch.connect('wss://eventsub.example/current', { isReconnect: true });
    const current = twitch.pending;
    await twitch.onMessage(current, welcomeFrame, { isReconnect: true, old });
    if (nativeError) old.onerror(new Event('error'));
    old.finishClose(); old.onclose();
    assert.equal(twitch._sockets.has(old), false, 'close físico retira el ownership incluso si es stale');
    const q = twitch.quiesceEventSub();
    current.finishClose(); await q;
    assert.equal(old.closeCalls, 1, 'el histórico cerrado no se vuelve a cerrar');
    assert.equal(twitch._sockets.size, 0);
  });
}

test('errores no liberan sockets: el corte espera su close nativo incluso si ya se está cerrando', async t => {
  const twitch = delayedEventSub(t);
  twitch.connect('wss://eventsub.example/current');
  const current = twitch.ws;
  current.onerror(new Event('error'));
  current.readyState = 2; // El transporte inició el cierre, no EventSub.
  const q = twitch.quiesceEventSub();
  let settled = false; q.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  assert.equal(current.closeCalls || 0, 0, 'no repetir un cierre nativo en marcha');
  current.finishClose(); current.onclose(); await q;
  assert.equal(twitch._sockets.size, 0);
  assert.equal(twitch.reconnectTimer, null);
});

test('sustituciones múltiples conservan históricos y pendientes reemplazados hasta cada close', async t => {
  const twitch = delayedEventSub(t);
  twitch.connect('wss://eventsub.example/first');
  const first = twitch.ws;
  twitch.connect('wss://eventsub.example/second', { isReconnect: true });
  const second = twitch.pending;
  await twitch.onMessage(second, welcomeFrame, { isReconnect: true, old: first });
  twitch.connect('wss://eventsub.example/abandoned', { isReconnect: true });
  const abandoned = twitch.pending;
  twitch.connect('wss://eventsub.example/third', { isReconnect: true });
  const third = twitch.pending;
  await twitch.onMessage(third, welcomeFrame, { isReconnect: true, old: second });
  const base = FakeWs.created.length;
  for (const stale of [first, second, abandoned]) {
    stale.onclose(); stale.onerror(new Event('error'));
    await twitch.onMessage(stale, welcomeFrame, { isReconnect: true, old: third });
    await twitch.onMessage(stale, { metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://eventsub.example/stale' } } });
  }
  assert.equal(FakeWs.created.length, base, 'callbacks stale antes del corte no abren otros sockets');
  const q = twitch.quiesceEventSub();
  let settled = false; q.then(() => { settled = true; });
  third.finishClose(); first.finishClose(); second.finishClose();
  await tick(); assert.equal(settled, false, 'el pendiente sustituido también pertenece a EventSub');
  abandoned.finishClose(); await q;
  assert.deepEqual([first, second, abandoned, third].map(ws => ws.closeCalls), [1, 1, 1, 1]);
  assert.equal(twitch._sockets.size, 0);
});

test('stop/start ordinario conserva el ownership del cierre anterior sin duplicar close', async t => {
  const twitch = delayedEventSub(t);
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  await twitch.start();
  const old = twitch.ws;
  await twitch.stop(); await twitch.stop();
  assert.equal(old.closeCalls, 1);
  await twitch.start();
  const current = twitch.ws;
  assert.notEqual(current, old);
  const q = twitch.quiesceEventSub();
  let settled = false; q.then(() => { settled = true; });
  current.finishClose(); await tick();
  assert.equal(settled, false, 'stop no pierde el socket anterior aún cerrándose');
  old.finishClose(); await q;
  assert.equal(old.closeCalls, 1);
});

test('el rechazo de una tarea admitida rechaza el drenaje y queda cacheado', async () => {
  const twitch = makeTwitch(); twitch.stopped = false;
  const live = new FakeWs('live'); twitch.ws = live;
  let reject; const gate = new Promise((_, r) => { reject = r; });
  const failure = new Error('fallo helix ficticio');
  twitch.helix = () => gate;
  const welcome = { metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess' } } };
  const work = twitch.onMessage(live, welcome, { isReconnect: false });
  const failedWork = assert.rejects(work, e => e === failure);
  const q = twitch.quiesceEventSub(), result = q.then(() => null, e => e);
  reject(failure); await failedWork;
  const error = await result;
  assert.ok(error instanceof AggregateError, 'el drenaje no debe ocultar rechazos');
  assert.equal(error.message, 'No se pudo cerrar EventSub.');
  assert.ok(error.errors.includes(failure));
  assert.equal(twitch.quiesceEventSub(), q, 'también se reutiliza un rechazo');
  assert.equal(live.readyState, 3);
});

test('un close que lanza no salta el otro cierre ni informa éxito', async t => {
  const twitch = makeTwitch(); twitch.stopped = false;
  const cur = new FakeWs('cur'), pend = new DelayedWs('pend');
  const failure = new Error('fallo close ficticio');
  cur.close = () => { throw failure; };
  twitch.ws = cur; twitch.pending = pend;
  t.after(() => { FakeWs.prototype.close.call(cur); pend.finishClose(); });
  const q = twitch.quiesceEventSub(), result = q.then(() => null, e => e);
  let settled = false; result.then(() => { settled = true; });
  assert.equal(pend.closeCalled, true, 'un fallo no debe saltar el otro socket');
  await tick(); assert.equal(settled, false, 'drenar ambos antes de rechazar');
  pend.finishClose(); const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.ok(error.errors.includes(failure));
  assert.equal(pend.readyState, 3);
});

test('la terminal espera el validate en vuelo y evita la conexión tardía', async () => {
  const twitch = makeTwitch();
  let release; const gate = new Promise(r => { release = r; });
  twitch.validate = async () => { await gate; return { user_id: 'u1', login: 'eg', scopes: [] }; };
  const states = []; twitch.on('status', st => states.push(st.state));
  const base = FakeWs.created.length;
  const started = twitch.start();
  await tick();
  const q = typeof twitch.quiesceEventSub === 'function' ? twitch.quiesceEventSub() : twitch.stop();
  let done = false; q.then(() => { done = true; });
  await tick();
  assert.equal(done, false, 'no debe resolver con el validate en vuelo');
  assert.equal(FakeWs.created.length, base, 'aún no debe abrir WS');
  release();
  await started; await q;
  assert.equal(FakeWs.created.length, base, 'tras resolver no debe abrir WS: el corte es terminal');
  assert.notEqual(twitch.status.state, 'conectado');
  assert.equal(states.includes('conectando'), false, 'validate tardío no debe publicar conectando tras el corte');
});

test('un welcome en vuelo se corta sin resuscribir ni rearmar y cierra ambos WS', async t => {
  const twitch = makeTwitch();
  t.after(() => { clearTimeout(twitch.keepaliveTimer); clearTimeout(twitch.reconnectTimer); });
  twitch.stopped = false;
  const cur = new FakeWs('cur'); const pend = new FakeWs('pend');
  twitch.ws = cur; twitch.pending = pend;
  let release; const gate = new Promise(r => { release = r; });
  let subscriptions = 0;
  twitch.helix = async () => { subscriptions += 1; await gate; return { ok: true, status: 200, data: {} }; };
  const welcome = { metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'sess', keepalive_timeout_seconds: 30 } } };
  const inflight = twitch.onMessage(cur, welcome, { isReconnect: false, old: null });
  await tick();
  const q = typeof twitch.quiesceEventSub === 'function' ? twitch.quiesceEventSub() : twitch.stop();
  assert.equal(cur.closed, true, 'el corte cierra el WS vigente incluso antes de drenar helix');
  assert.equal(pend.closed, true, 'el corte cierra el WS pendiente incluso antes de drenar helix');
  release(); await inflight; await q;
  assert.equal(subscriptions, 1, 'tras el corte no se deben iniciar suscripciones adicionales');
  assert.equal(twitch.keepaliveTimer ?? null, null, 'no debe rearmar keepalive tras el corte');
  assert.notEqual(twitch.status.state, 'conectado', 'no debe completar el welcome tardío');
  assert.equal(cur.closed, true, 'el WS vigente debe cerrarse');
  assert.equal(pend.closed, true, 'el WS pendiente debe cerrarse');
});

test('el corte cancela la reconexión y un onclose obsoleto no revive el WS', async t => {
  const twitch = makeTwitch();
  t.after(() => { twitch.stopped = true; clearTimeout(twitch.reconnectTimer); });
  twitch.stopped = false;
  twitch.connect('wss://eventsub.example/ws');
  const live = twitch.ws;
  live.onclose();
  assert.ok(twitch.reconnectTimer, 'la reconexión debe registrarse para poder cancelarla');
  const q = typeof twitch.quiesceEventSub === 'function' ? twitch.quiesceEventSub() : twitch.stop();
  await q;
  assert.ok(!twitch.reconnectTimer, 'el timer de reconexión debe cancelarse');
  live.onclose();
  assert.notEqual(twitch.status.state, 'reconectando');
});

test('stop y start ordinarios siguen siendo reiniciables', async () => {
  const twitch = makeTwitch();
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  const base = FakeWs.created.length;
  await twitch.start();
  assert.equal(FakeWs.created.length, base + 1, 'start debe conectar');
  await twitch.stop();
  await twitch.start();
  assert.equal(FakeWs.created.length, base + 2, 'un start tras stop ordinario debe reconectar');
  await twitch.stop();
});

test('repetir start con WS vivo conserva la admisión financiera y no abre otro socket', async t => {
  const twitch = makeTwitch();
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  await twitch.start();
  const live = twitch.ws, base = FakeWs.created.length, seen = [];
  twitch.on('event', e => seen.push(e.externalId));
  let release; const gate = new Promise(r => { release = r; });
  twitch.validate = async () => { await gate; return { user_id: 'u1', login: 'eg', scopes: [] }; };
  const repeated = [twitch.start(), twitch.start()];
  t.after(async () => { release(); await Promise.all(repeated); await twitch.stop(); });
  const cheer = id => ({
    metadata: { message_type: 'notification', message_id: id },
    payload: { subscription: { type: 'channel.cheer' }, event: { user_name: 'ana', bits: 300, message: 'ana300' } },
  });
  await twitch.onMessage(live, cheer('during'));
  assert.deepEqual(seen, ['tw:during'], 'no descartar notificaciones del WS vigente');
  release(); await Promise.all(repeated);
  assert.equal(twitch.ws, live);
  assert.equal(FakeWs.created.length, base, 'start vivo es idempotente');
  await twitch.onMessage(live, cheer('after'));
  assert.deepEqual(seen, ['tw:during', 'tw:after']);
});

test('start no sustituye un WS conectando pero sí uno cerrado', async () => {
  const twitch = makeTwitch();
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  await twitch.start();
  const live = twitch.ws, base = FakeWs.created.length;
  live.readyState = 0;
  await twitch.start();
  assert.equal(twitch.ws, live);
  assert.equal(FakeWs.created.length, base);
  live.close();
  await twitch.start();
  assert.notEqual(twitch.ws, live);
  assert.equal(FakeWs.created.length, base + 1);
  await twitch.stop();
});

test('un start posterior al corte terminal no resucita el WS', async () => {
  const twitch = makeTwitch();
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  const q = typeof twitch.quiesceEventSub === 'function' ? twitch.quiesceEventSub() : twitch.stop();
  await q;
  const base = FakeWs.created.length;
  await twitch.start();
  assert.equal(FakeWs.created.length, base, 'el corte terminal debe impedir reconectar');
});

test('una notificación financiera aceptada antes del corte se emite exactamente una vez', async t => {
  const twitch = makeTwitch();
  t.after(() => { clearTimeout(twitch.keepaliveTimer); clearTimeout(twitch.reconnectTimer); });
  twitch.stopped = false;
  const live = new FakeWs('live'); twitch.ws = live;
  const seen = []; twitch.on('event', e => seen.push(e.externalId));
  const cheer = id => ({ metadata: { message_type: 'notification', message_id: id }, payload: { subscription: { type: 'channel.cheer' }, event: { user_name: 'ana', bits: 300, message: 'ana300' } } });
  await twitch.onMessage(live, cheer('m1'), { isReconnect: false, old: null });
  const q = typeof twitch.quiesceEventSub === 'function' ? twitch.quiesceEventSub() : twitch.stop();
  await q;
  await twitch.onMessage(live, cheer('m2'), { isReconnect: false, old: null });
  assert.deepEqual(seen, ['tw:m1'], 'lo aceptado antes del corte se conserva; lo tardío se ignora');
});

test('un frame malformado no lanza fuera del callback ni publica datos', async () => {
  const logs = [];
  const twitch = makeTwitch({ log: msg => logs.push(msg) }); twitch.stopped = false;
  twitch.connect('wss://eventsub.example/ws');
  assert.doesNotThrow(() => twitch.ws.onmessage({ data: '{invalid' }));
  assert.deepEqual(logs, ['[twitch] mensaje de Twitch no válido']);
  await twitch.stop();
});

const CHILD = `
import { startServer } from ${JSON.stringify(SERVER_MODULE_URL)};
const scenario = process.argv[1];
const opts = { quiet: true, log: m => console.log('LOG:' + String(m)) };
if (scenario === 'deadline') opts.shutdownTimeoutMs = 150;
const app = await startServer(opts);
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
const sessionFlush = app.session.flush.bind(app.session);
app.session.flush = async () => { console.log('FLUSH'); await sessionFlush(); };
let release = () => {};
const gate = new Promise(r => { release = r; });
if (scenario === 'persist-fail' || scenario === 'persist-sync-fail') {
  app.session.record({ id: 'accepted', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' });
  app.interactive.s.questions.push({ id: 'accepted-q', user: 'ana', text: 'hola', status: 'pending' });
  app.store.config.tts.rate = 1.75;
  app.store.chain = gate;
  app.store.write(app.store.cfgFile, app.store.config).then(() => console.log('STORE-DONE'), () => console.log('STORE-FAIL'));
}
let calls = 0;
app.twitch.quiesceEventSub = async () => {
  calls += 1; console.log('QUIESCE:' + calls);
  if (scenario === 'fail' || scenario === 'persist-fail') throw new Error('boom');
  await gate;
};
if (scenario === 'persist-sync-fail') app.twitch.quiesceEventSub = () => {
  calls += 1; console.log('QUIESCE:' + calls); throw new Error('sync-boom');
};
const realExit = process.exit.bind(process);
process.exit = code => { console.log('WILLEXIT:' + code); realExit(code); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { if (String(d).includes('release')) release(); });
console.log('READY');
`;


async function launchChild({ dataDir, port, scenario }) {
  const env = { ...process.env, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: String(port) };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  const child = await launchSignalChild(process.execPath, ['--input-type=module', '-e', CHILD, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exitInfo = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  const waitFor = async (needle, ms = 6000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (out.includes(needle)) return true;
      if (child.exitCode !== null || child.signalCode !== null) return out.includes(needle);
      await delay(20);
    }
    return out.includes(needle);
  };
  return { child, exitInfo, waitFor, send: m => { try { child.stdin.write(m + '\n'); } catch { /* hijo muerto */ } }, out: () => out };
}

async function awaitExit(c, ms = 3000) {
  let timer;
  const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const res = await Promise.race([c.exitInfo, watchdog]);
    if (!res) { c.child.kill('SIGKILL'); await c.exitInfo; assert.fail('el hijo no salió en ' + ms + 'ms: ' + c.out()); }
    return res;
  } finally { clearTimeout(timer); }
}

test('la señal real espera quiesceEventSub antes de persistir; bloqueo/error salen 1', { timeout: 40000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-EVENTSUB-'));
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.exitInfo));
    await rm(root, { recursive: true, force: true });
  });
  const start = async (name, scenario) => {
    const dataDir = path.join(root, name); await mkdir(dataDir, { recursive: true });
    const c = await launchChildOnFreePort({
      launch: port => launchChild({ dataDir, port, scenario }),
      ready: h => h.waitFor('READY'),
    });
    children.push(c);
    assert.ok(await c.waitFor('READY'), 'sin READY (' + name + '): ' + c.out());
    return c;
  };

  const g = await start('gate', 'gate');
  await interruptSignalChild(g.child); await interruptSignalChild(g.child);
  await delay(300);
  assert.ok(g.out().includes('QUIESCE:1'), 'el caller real debe invocar el seam dinámico quiesceEventSub: ' + g.out());
  assert.equal((g.out().match(/QUIESCE:/g) || []).length, 1, 'señales repetidas: una sola llamada');
  assert.equal(g.out().includes('FLUSH'), false, 'no debe persistir con quiesce bloqueado');
  assert.equal(g.child.exitCode, null, 'no debe salir con quiesce bloqueado');
  g.send('release');
  assert.deepEqual(await awaitExit(g), { code: 0, signal: null });
  assert.ok(g.out().indexOf('QUIESCE:1') < g.out().indexOf('FLUSH'), 'debe persistir solo tras quiesce: ' + g.out());

  const term = await start('term', 'gate');
  term.child.kill('SIGTERM');
  if (process.platform === 'win32') {
    // SIGTERM fuerza TerminateProcess en Windows: no ejecuta el cierre graceful.
    assert.deepEqual(await awaitExit(term), { code: 1, signal: null }, term.out());
    assert.equal(term.out().includes('QUIESCE:'), false, term.out());
    assert.equal(term.out().includes('FLUSH'), false, term.out());
    assert.equal(term.out().includes('WILLEXIT:'), false, term.out());
  } else {
    assert.ok(await term.waitFor('QUIESCE:1'), term.out());
    assert.equal(term.out().includes('FLUSH'), false, 'SIGTERM también espera el drenaje');
    term.send('release');
    assert.deepEqual(await awaitExit(term), { code: 0, signal: null });
    assert.ok(term.out().indexOf('QUIESCE:1') < term.out().indexOf('FLUSH'));
  }

  const f = await start('fail', 'fail');
  await interruptSignalChild(f.child);
  assert.deepEqual(await awaitExit(f), { code: 1, signal: null }, f.out());

  const d = await start('deadline', 'deadline');
  await interruptSignalChild(d.child);
  assert.deepEqual(await awaitExit(d, 2000), { code: 1, signal: null }, 'el deadline debe seguir activo durante quiesce: ' + d.out());
  assert.equal(d.out().includes('FLUSH'), false, 'quiesce colgado no admite persistencia prematura');
});

test('fallo asentado de EventSub guarda lo aceptado antes de salir 1, también con throw síncrono', { timeout: 40000 }, async t => {
  // El throw síncrono también debe drenar: Ctrl+C en Windows, SIGTERM real en Unix.
  for (const [scenario, signal] of [
    ['persist-fail', 'SIGINT'],
    ['persist-sync-fail', process.platform === 'win32' ? 'SIGINT' : 'SIGTERM'],
  ]) {
    await t.test(scenario, async st => {
      const dataDir = await mkdtemp(path.join(tmpdir(), 'EGDEV-EVENTSUB-PERSIST-'));
      const c = await launchChildOnFreePort({
        launch: port => launchChild({ dataDir, port, scenario }),
        ready: h => h.waitFor('READY'),
      });
      st.after(async () => {
        if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
        await c.exitInfo;
        await rm(dataDir, { recursive: true, force: true });
      });
      assert.ok(await c.waitFor('READY'), c.out());
      await interruptSignalChild(c.child, signal);
      assert.ok(await c.waitFor('QUIESCE:1'), c.out());
      assert.ok(await c.waitFor('FLUSH'), 'debe intentar persistir pese al fallo: ' + c.out());
      assert.equal(c.child.exitCode, null, 'debe esperar la escritura Store aceptada');
      c.send('release');
      assert.deepEqual(await awaitExit(c), { code: 1, signal: null }, c.out());
      const json = async file => JSON.parse(await readFile(path.join(dataDir, file), 'utf8'));
      assert.equal((await json('session-current.json')).events.some(e => e.id === 'accepted'), true);
      assert.equal((await json('interactive.json')).questions.some(q => q.id === 'accepted-q'), true);
      assert.equal((await json('config.json')).tts.rate, 1.75);
      assert.ok(c.out().includes('STORE-DONE'), 'Store llegó al disco antes de salir');
      assert.equal((c.out().match(/FLUSH/g) || []).length, 1, 'un único flush');
    });
  }
});
