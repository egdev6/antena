// ODD-08b.2b.2b.1: propiedad de los mensajes programados (`Timers.quiesceFires`).
// SOLO pruebas. Si `quiesceFires` no existe, los casos de comportamiento usan el corte
// ordinario (`stop`) para exponer el fallo real, no un `TypeError` sin contexto.
// Política humana `odd08b2b2b_wait_accepted_with_deadline`: se respetan las acciones/retardos
// YA aceptados dentro de los 5 s vigentes; un fallo real sale 1, nunca un 0 falso.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';
import { Timers } from '../src/timers.mjs';

const SERVER_URL = new URL('../src/server.mjs', import.meta.url).href;
const CLOSING = { code: 'TIMERS_CLOSING', status: 503, message: 'Los mensajes programados se están cerrando.' };
const AGG = 'No se pudieron cerrar los mensajes programados.';
const flush = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
const gate = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };
const fixture = (id, extra = {}) => ({ id, name: 'Mensaje ' + id, enabled: true, message: 'Hola {channel}', intervalMin: 1, minChatLines: 0, announce: false, announceColor: 'primary', onlyWhenLive: false, showAlert: false, ...extra });

// Ninguna prueba de este fichero abre red real: dobles locales y un hijo aislado que refuerza
// sus propios `WebSocket`/`fetch` rotos antes de importar el servidor. No se restauran.
before(() => {
  globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
  globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };
});

function makeTimers(t, { store, engine, twitch, session, meld, tickMs = 1000 } = {}) {
  const st = store || { config: { timers: [], paused: false } };
  const tw = twitch || { status: { user: 'egdev6' }, sendChat: async () => ({ is_sent: true }), sendAnnouncement: async () => ({ announced: true }) };
  const en = engine || { custom: () => ({ id: 'a1' }), bus: { send: () => {} } };
  const se = session || { data: { title: 'Directo', startedAt: new Date().toISOString() }, totals: () => ({ follows: 0 }) };
  const timers = new Timers({ store: st, engine: en, twitch: tw, meld: meld ?? { connected: false }, session: se, log: () => {}, tickMs });
  t.after(() => { try { timers.stop(); } catch { /* ya parado */ } });
  return { timers, store: st, engine: en, twitch: tw, session: se };
}

const cut = ts => typeof ts.quiesceFires === 'function' ? ts.quiesceFires() : (ts.stop(), Promise.resolve());

test('quiesceFires es terminal, cachea la misma promesa y bloquea nuevos fire/tick/start', async t => {
  const ctx = makeTimers(t);
  assert.equal(typeof ctx.timers.quiesceFires, 'function', 'falta Timers.quiesceFires');
  ctx.store.config.timers = [fixture('t1')];
  const q = ctx.timers.quiesceFires();
  assert.equal(ctx.timers.quiesceFires(), q, 'misma promesa terminal, no una transición nueva');
  await q;
  const closing = e => e.code === CLOSING.code && e.status === CLOSING.status && e.message === CLOSING.message;
  await assert.rejects(ctx.timers.fire('t1'), closing, 'un fire nuevo debe rechazar tipado');
  await assert.rejects(ctx.timers.tick(), closing, 'un tick nuevo debe rechazar tipado');
  assert.doesNotThrow(() => ctx.timers.start(), 'start tras el cierre no debe lanzar');
});

test('el corte cancela el intervalo físico; start no lo rearma y stop/start ordinario sigue vivo', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => t.mock.timers.reset());
  const ctx = makeTimers(t, { tickMs: 1000 });
  let ticks = 0;
  const real = ctx.timers.tick.bind(ctx.timers);
  ctx.timers.tick = async (...a) => { ticks += 1; return real(...a); };
  // sin corte, el ciclo ordinario sigue funcionando
  ctx.timers.start();
  t.mock.timers.tick(3000); await flush(); assert.equal(ticks, 3, 'el intervalo ordinario dispara');
  ctx.timers.stop();
  t.mock.timers.tick(3000); await flush(); assert.equal(ticks, 3, 'stop detiene el intervalo');
  ctx.timers.start();
  t.mock.timers.tick(1000); await flush(); assert.equal(ticks, 4, 'start rearma el intervalo ordinario');
  // corte terminal: cancela ya y frena el rearme
  await cut(ctx.timers);
  t.mock.timers.tick(10_000); await flush(); assert.equal(ticks, 4, 'el corte cancela el intervalo físico');
  assert.doesNotThrow(() => ctx.timers.start());
  t.mock.timers.tick(10_000); await flush(); assert.equal(ticks, 4, 'start tras el corte no rearma');
});

test('un fire manual admitido no deja resolver q hasta respuesta, engine.custom y bus', async t => {
  const ctx = makeTimers(t);
  const order = [];
  const g = gate(); t.after(() => g.resolve());
  ctx.twitch.sendChat = async () => { order.push('chat-await'); const r = await g.p; order.push('chat'); return r; };
  ctx.engine.custom = () => { order.push('custom'); return { id: 'a1' }; };
  ctx.engine.bus = { send: () => { order.push('bus'); } };
  ctx.store.config.timers = [fixture('t1', { showAlert: true })];
  const fireP = ctx.timers.fire('t1');
  const q = cut(ctx.timers);
  let settled = false;
  q.then(() => { settled = true; order.push('q'); }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'q no puede resolver con el envío en vuelo');
  g.resolve({ is_sent: true });
  const out = await fireP; await q;
  assert.deepEqual(out, { id: 't1', chat: { is_sent: true }, alert: 'a1', error: null, platforms: { twitch: { ok: true, kind: 'message', result: { is_sent: true } } } });
  assert.ok(order.indexOf('chat') < order.indexOf('custom'), 'custom va tras la respuesta');
  assert.ok(order.indexOf('custom') < order.indexOf('bus'), 'bus va tras custom');
  assert.ok(order.indexOf('bus') < order.indexOf('q'), 'q espera también la publicación');
});

test('un tick admitido completa sus dos fires aunque el corte entre en el primero', async t => {
  const ctx = makeTimers(t);
  const gates = [gate(), gate()];
  t.after(() => gates.forEach(g => g.resolve()));
  const started = [];
  ctx.twitch.sendChat = () => { const i = started.length; started.push(i); return gates[i].p.then(() => ({ is_sent: true, n: i })); };
  ctx.engine.bus = { send: () => {} };
  ctx.store.config.timers = [fixture('a'), fixture('b')];
  ctx.timers.st('a'); ctx.timers.st('b');           // semilla pública de estado, sin tocar campos privados
  const now = Date.now() + 60_001;
  const tickP = ctx.timers.tick(now);
  await flush();
  assert.equal(started.length, 1, 'el primer fire arranca y espera');
  const q = cut(ctx.timers);
  let settled = false; q.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'q espera el tick admitido completo');
  gates[0].resolve();
  await flush();
  assert.equal(started.length, 2, 'el segundo due del mismo tick sigue aceptado como continuación');
  assert.equal(settled, false, 'q espera el segundo fire de su propio gate');
  gates[1].resolve();
  const fired = await tickP; await flush();
  assert.deepEqual(fired, ['a', 'b'], 'el tick devuelve los dos ids disparados');
  assert.equal(settled, true, 'q resuelve al cerrar el ciclo aceptado');
});

test('dos fires directos: el sano completa antes del AggregateError y q queda cacheada', async t => {
  const ctx = makeTimers(t);
  const order = [];
  const failure = new Error('');                 // mensaje vacío: no debe colarse como éxito
  const healthy = gate(); t.after(() => healthy.resolve());
  let call = 0;
  ctx.twitch.sendChat = () => { call += 1; return call === 1 ? Promise.reject(failure) : healthy.p.then(() => ({ is_sent: true })); };
  ctx.engine.custom = () => { order.push('custom'); return { id: 'a1' }; };
  ctx.engine.bus = { send: () => { order.push('bus'); } };
  ctx.store.config.timers = [fixture('fail'), fixture('ok', { showAlert: true })];
  assert.equal(typeof ctx.timers.quiesceFires, 'function', 'falta Timers.quiesceFires');
  const pf = ctx.timers.fire('fail');
  const ph = ctx.timers.fire('ok');
  const q = ctx.timers.quiesceFires();
  const qr = q.then(() => null, e => e);
  let settled = false; q.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, 'q espera el fire sano gated');
  const outFail = await pf;
  assert.equal(outFail.error, '', 'el error ordinario visible sigue en out.error');
  assert.equal(ctx.timers.snapshot()[0].runtime.lastError, '', 'runtime.lastError visible en el panel');
  healthy.resolve();
  const outOk = await ph;
  assert.deepEqual(outOk, { id: 'ok', chat: { is_sent: true }, alert: 'a1', error: null, platforms: { twitch: { ok: true, kind: 'message', result: { is_sent: true } } } });
  const err = await qr;
  assert.ok(err instanceof AggregateError, 'q rechaza con AggregateError constante');
  assert.equal(err.message, AGG);
  assert.ok(err.errors.includes(failure), 'la causa original se conserva');
  assert.equal(ctx.timers.quiesceFires(), q, 'un rechazo también queda cacheado');
  assert.ok(order.indexOf('custom') < order.lastIndexOf('bus'), 'custom precede al bus del fire sano');
  assert.deepEqual(order, ['bus', 'custom', 'bus'], 'ambos fires publican; el sano no se salta');
});

test('guardia ordinaria: fire sano conserva la forma pública y el 404 de id inexistente', async t => {
  const ctx = makeTimers(t);
  const sent = [];
  ctx.twitch.sendChat = async text => { sent.push(text); return { is_sent: true }; };
  let busData = null;
  ctx.engine.bus = { send: (event, data) => { if (event === 'timers') busData = data; } };
  ctx.store.config.timers = [fixture('ok')];
  const out = await ctx.timers.fire('ok');
  assert.deepEqual(Object.keys(out).sort(), ['alert', 'chat', 'error', 'id', 'platforms']);
  assert.equal(out.id, 'ok'); assert.equal(out.error, null); assert.equal(out.alert, null);
  assert.deepEqual(out.chat, { is_sent: true });
  assert.match(sent[0], /Hola egdev6/);
  assert.equal(ctx.timers.snapshot()[0].runtime.runs, 1);
  assert.equal(busData[0].runtime.runs, 1);
  await assert.rejects(ctx.timers.fire('nope'), e => e.status === 404 && /No existe/.test(e.message));
});

const CHILD = `
const scenario = process.argv[1];
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };
const { startServer } = await import(${JSON.stringify(SERVER_URL)});
const log = process.env.ANTENA_TEST_VERBOSE ? console.log : () => {};
const app = await startServer({ quiet: true, log, ...(['deadline', 'fail-drain-deadline'].includes(scenario) ? { shutdownTimeoutMs: 150 } : {}) });
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
app.store.config.timers = [{ id: 'fake1', name: 'Fake', enabled: true, message: 'Hola {channel}', intervalMin: 1, minChatLines: 0, announce: false, announceColor: 'primary', onlyWhenLive: false, showAlert: true }];
let release = () => {};
if (scenario.startsWith('throw')) {
  if (scenario === 'throw-held') {
    app.engine.pause();
    app.engine.deliver({ id: 'held-test', actions: [], vars: {} });
  }
  app.timers.quiesceFires = () => { throw new Error('fallo sincrono ficticio'); };
} else {
  const realQuiesce = app.timers.quiesceFires;
  let timerCalls = 0;
  app.timers.quiesceFires = new Proxy(realQuiesce || (() => Promise.resolve()), {
    apply(target, thisArg, args) { console.log('TIMERS:' + (++timerCalls)); return Reflect.apply(target, thisArg, args); },
  });
  app.twitch.sendChat = () => scenario === 'deadline' ? new Promise(() => {}) : new Promise((resolve, reject) => {
    release = () => { if (scenario.startsWith('fail')) reject(new Error('fallo ficticio de Twitch')); else resolve({ is_sent: true }); };
  });
  const realCustom = app.engine.custom.bind(app.engine);
  app.engine.custom = (fields, vars) => { console.log('CUSTOM'); return realCustom(fields, vars); };
  const realBusSend = app.engine.bus.send.bind(app.engine.bus);
  app.engine.bus.send = (event, data, kinds) => { if (event === 'timers') console.log('BUS'); return realBusSend(event, data, kinds); };
  app.timers.fire('fake1').then(out => console.log('FIRE-DONE:' + JSON.stringify(out.error ?? null)), e => console.log('FIRE-FAIL:' + e.message));
}
let httpLogged = false;
const realStop = app.stopAdmission.bind(app);
app.stopAdmission = () => { const p = realStop(); Promise.resolve(p).then(() => { if (!httpLogged) { httpLogged = true; console.log('HTTP-IDLE'); } }, () => {}); return p; };
const realES = app.twitch.quiesceEventSub.bind(app.twitch);
app.twitch.quiesceEventSub = () => { console.log('EVENTSUB'); return realES(); };
let deviceCalls = 0;
const realDevice = app.twitch.quiesceDeviceFlow.bind(app.twitch);
app.twitch.quiesceDeviceFlow = () => { console.log('DEVICE:' + (++deviceCalls)); return realDevice(); };
let chain = app.store.chain;
Object.defineProperty(app.store, 'chain', { configurable: true, get() { console.log('CHAIN-SNAPSHOT'); return chain; }, set(v) { chain = v; } });
app.session.flush = async () => { console.log('FLUSH'); if (scenario === 'fail-drain-deadline') await new Promise(() => {}); };
app.interactive.flush = async () => { console.log('INTERACTIVE-FLUSH'); };
const realCloseHttp = app.closeHttp.bind(app);
app.closeHttp = () => { console.log('HTTP-CLOSE'); return realCloseHttp(); };
for (const name of ['drainActions', 'drainSentActions']) {
  const original = app.engine[name].bind(app.engine);
  app.engine[name] = () => { console.log('ENGINE:' + name); return original(); };
}
for (const name of ['captureAckWindow', 'closeAckWindow', 'waitIdle']) {
  const original = app[name].bind(app);
  app[name] = () => { console.log('ACK:' + name); return original(); };
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { if (String(d).includes('release')) release(); });
console.log('READY');
`;


async function child(t, scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-TIMERS-'));
  return await launchChildOnFreePort({
    launch: port => crearHijo(t, root, scenario, port),
    ready: h => h.ready(),
    output: h => h.out(),
  });
}

// Crea el hijo de un escenario en un puerto ya elegido; el reintento ante EADDRINUSE
// lo decide launchChildOnFreePort (helpers/free-port.mjs, #78).
async function crearHijo(t, root, scenario, port) {
  const env = { ...process.env, ANTENA_DATA: root, ANTENA_MEDIA: path.join(root, 'media'), PORT: String(port) };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  const proc = await launchSignalChild(process.execPath, ['--input-type=module', '-e', CHILD, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.on('error', () => {});
  let out = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', d => { out += d; }); proc.stderr.on('data', d => { out += d; });
  const exit = new Promise(r => proc.once('exit', (code, signal) => r({ code, signal })));
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await exit; await rm(root, { recursive: true, force: true });
  });
  const wait = async (needle, ms = 3000) => {
    const end = Date.now() + ms;
    while (!out.includes(needle) && Date.now() < end && proc.exitCode === null && proc.signalCode === null) await delay(10);
    assert.ok(out.includes(needle), 'falta ' + needle + ': ' + out);
  };
  const ready = async () => {
    const fin = Date.now() + 8000;
    while (!out.includes('READY') && Date.now() < fin && proc.exitCode === null && proc.signalCode === null) await delay(10);
    return out.includes('READY');
  };
  await wait('READY');
  return { proc, exit, wait, ready, out: () => out };
}

async function exited(c, ms = 2000) {
  let timer;
  try {
    const result = await Promise.race([c.exit, new Promise(r => { timer = setTimeout(() => r(null), ms); })]);
    assert.ok(result, 'el hijo no salió: ' + c.out());
    return result;
  } finally { clearTimeout(timer); }
}

test('SIGINT/SIGTERM: HTTP idle → EventSub → Device → Timers real → snapshot/flush; fallo/deadline/throw salen 1', { timeout: 25000 }, async t => {
  // Windows: ambos positivos usan Ctrl+C; SIGTERM nativo es forzado y se prueba aparte abajo.
  const gracefulSignal = signal => process.platform === 'win32' && signal === 'SIGTERM' ? 'SIGINT' : signal;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await child(t, 'gate');
    await interruptSignalChild(c.proc, gracefulSignal(signal));
    await c.wait('TIMERS:1');
    await interruptSignalChild(c.proc, gracefulSignal(signal)); // repetida: una sola transición
    await flush();
    const blocked = c.out();
    assert.equal((blocked.match(/TIMERS:/g) || []).length, 1, 'una sola transición de timers');
    assert.ok(blocked.indexOf('HTTP-IDLE') < blocked.indexOf('EVENTSUB'));
    assert.ok(blocked.indexOf('EVENTSUB') < blocked.indexOf('DEVICE:1'));
    assert.ok(blocked.indexOf('DEVICE:1') < blocked.indexOf('TIMERS:1'));
    assert.equal(blocked.includes('CHAIN-SNAPSHOT'), false, 'no captura Store antes de drenar timers');
    c.proc.stdin.write('release\n');
    assert.deepEqual(await exited(c), { code: 0, signal: null }, blocked);
    const done = c.out();
    assert.ok(done.includes('FIRE-DONE:null'), 'fire sano sin error oculto');
    assert.ok(done.indexOf('TIMERS:1') < done.indexOf('CUSTOM'), 'el fire admitido corre tras entrar q');
    assert.ok(done.indexOf('CUSTOM') < done.indexOf('CHAIN-SNAPSHOT'), 'custom antes de la instantánea');
    assert.ok(done.indexOf('CHAIN-SNAPSHOT') < done.indexOf('FLUSH'));
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await child(t, 'fail');
    await interruptSignalChild(c.proc, gracefulSignal(signal));
    await c.wait('TIMERS:1');                  // el error Twitch se libera SOLO tras entrar q
    assert.equal(c.out().includes('CHAIN-SNAPSHOT'), false);
    c.proc.stdin.write('release\n');
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
    assert.ok(c.out().includes('FIRE-DONE:"fallo ficticio de Twitch"'), 'fallo visible, no falso éxito');
    assertFailureDrain(c.out());
  }
  {
    const c = await child(t, 'fail-drain-deadline');
    await interruptSignalChild(c.proc, gracefulSignal('SIGTERM'));
    await c.wait('TIMERS:1');
    c.proc.stdin.write('release\n');
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
    assert.ok(c.out().includes('FLUSH'));
    assert.ok(c.out().includes('INTERACTIVE-FLUSH'));
    assert.equal(c.out().includes('HTTP-CLOSE'), false, 'deadline termina flush colgado');
  }
  {
    const c = await child(t, 'deadline');
    await interruptSignalChild(c.proc, 'SIGINT');
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
  }
  for (const scenario of ['throw', 'throw-held']) {
    const c = await child(t, scenario);
    await interruptSignalChild(c.proc, 'SIGINT');
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
    assertFailureDrain(c.out());
    if (scenario === 'throw-held') assert.match(c.out(), /\[parada\] alertas retenidas/);
  }
  if (process.platform === 'win32') {
    const c = await child(t, 'gate');
    assert.equal(c.proc.kill('SIGTERM'), true, 'SIGTERM nativo solicita terminación forzada');
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
    assert.doesNotMatch(c.out(), /TIMERS:|CHAIN-SNAPSHOT|FLUSH/, 'SIGTERM forzado no ejecuta el cierre ordenado');
  }
});

function assertFailureDrain(out) {
  const ordered = ['ACK:captureAckWindow', 'ENGINE:drainActions', 'ENGINE:drainSentActions',
    'ACK:closeAckWindow', 'ACK:waitIdle', 'CHAIN-SNAPSHOT', 'FLUSH'];
  let previous = -1;
  for (const marker of ordered) {
    const at = out.indexOf(marker);
    assert.ok(at > previous, marker + ': ' + out);
    previous = at;
  }
  assert.ok(out.includes('INTERACTIVE-FLUSH'));
  assert.ok(out.indexOf('HTTP-CLOSE') > out.indexOf('INTERACTIVE-FLUSH'));
}
