// ODD-08 (solo pruebas, test-first): `TwitchChat.quiesceChat()` es terminal y síncrono, cachea la
// MISMA promesa (también al rechazar), frena join/connect/open/message/reconnect obsoletos, cancela
// la reconexión propia y espera el cierre FÍSICO de todos los sockets propios, incluidos los
// sustituidos todavía cerrándose. Un close que lanza no salta los demás y el fallo no se oculta.
// Los mensajes ya emitidos se conservan; ninguno posterior se emite. La señal real espera este
// seam entre Device Flow y Timers; la persistencia real precede a Store/flush/HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { TwitchChat } from '../src/chat.mjs';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { withoutHeldRecoveryWarning } from './helpers/held-recovery-warning.mjs';

const SERVER_URL = new URL('../src/server.mjs', import.meta.url).href;
const delay = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));

class FakeWs extends EventTarget {
  constructor(url) { super(); this.url = url; this.sent = []; this.closed = false; this.readyState = 1; FakeWs.created.push(this); }
  send(data) { this.sent.push(String(data)); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); this.onclose?.(); }
  open() { this.onopen?.(); }
  frame(data) { this.onmessage?.({ data }); }
}
class DelayedWs extends FakeWs {
  close() { this.closeCalled = true; this.readyState = 2; }
  finishClose() { if (this.closed) return; this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); this.onclose?.(); }
}
FakeWs.created = [];
globalThis.WebSocket = FakeWs;
globalThis.fetch = () => { throw new Error('Red externa prohibida'); };
const makeChat = overrides => Object.assign(new TwitchChat(() => {}), overrides);
const cut = chat => typeof chat.quiesceChat === 'function' ? chat.quiesceChat() : (chat.stop(), Promise.resolve());
const useWs = (t, Ctor) => { const prev = globalThis.WebSocket; globalThis.WebSocket = Ctor; t.after(() => { globalThis.WebSocket = prev; }); };

test('quiesceChat es terminal, cachea la misma promesa y bloquea mensajes, join, connect y open obsoletos', async () => {
  const chat = makeChat();
  assert.equal(typeof chat.quiesceChat, 'function', 'falta TwitchChat.quiesceChat');
  const seen = []; chat.on('message', m => seen.push(m.text));
  const base = FakeWs.created.length;
  chat.join('Canal');
  const ws = FakeWs.created[base];
  ws.open();
  ws.frame(':ana!ana@ana PRIVMSG #canal :antes');
  const sentBefore = ws.sent.length;
  const q = chat.quiesceChat();
  assert.equal(chat.quiesceChat(), q, 'misma promesa terminal, no una transición nueva');
  ws.frame(':bea!bea@bea PRIVMSG #canal :despues');
  ws.onopen?.();
  assert.equal(ws.sent.length, sentBefore, 'un open obsoleto no vuelve a enviar');
  chat.join('otro'); chat.connect();
  assert.equal(FakeWs.created.length, base + 1, 'no debe abrir WS tras el corte');
  assert.deepEqual(seen, ['antes'], 'se conserva lo emitido antes del corte y se ignora lo tardío');
  await q;
});

test('si un listener corta en el primer mensaje, el resto del MISMO frame no se emite ni responde PING', async () => {
  const chat = makeChat();
  const seen = []; chat.on('message', m => { seen.push(m.text); cut(chat); });
  const base = FakeWs.created.length;
  chat.join('canal');
  const ws = FakeWs.created[base];
  ws.open(); ws.sent.length = 0;
  ws.frame(':ana!ana@ana PRIVMSG #canal :uno\r\n:bea!bea@bea PRIVMSG #canal :dos\r\nPING :tmi.twitch.tv\r\n');
  await tick();
  assert.deepEqual(seen, ['uno'], 'tras el corte no se emite el resto del frame');
  assert.equal(ws.sent.some(l => l.startsWith('PONG')), false, 'un PING post-corte no responde');
});

test('el corte espera el cierre físico de todos los sockets propios, incluido el sustituido en CLOSING', async t => {
  useWs(t, DelayedWs);
  const chat = makeChat();
  const base = FakeWs.created.length;
  chat.join('a');
  const w1 = FakeWs.created[base];
  chat.join('b');
  const w2 = FakeWs.created[base + 1];
  assert.equal(w1.closeCalled, true, 'join ordinario cierra el socket viejo');
  const q = cut(chat);
  assert.equal(cut(chat), q, 'misma promesa terminal');
  assert.equal(w2.closeCalled, true, 'el corte cierra el socket vigente');
  let settled = false; q.then(() => { settled = true; }, () => { settled = true; });
  w2.finishClose(); await tick();
  assert.equal(settled, false, 'falta el cierre físico del socket sustituido');
  w1.finishClose(); await q;
  assert.equal(settled, true, 'q resuelve al cerrar físicamente todos los sockets');
});

test('un close que lanza no salta los demás sockets y el error no se oculta', async t => {
  useWs(t, DelayedWs);
  const chat = makeChat();
  const base = FakeWs.created.length;
  chat.join('a');
  chat.connect();
  const w1 = FakeWs.created[base], w2 = FakeWs.created[base + 1];
  const failure = new Error('');
  w1.close = () => { throw failure; };
  const q = cut(chat), result = q.then(() => null, e => e);
  assert.equal(w2.closeCalled, true, 'un fallo no debe saltar el otro cierre');
  w2.finishClose();
  const error = await result;
  assert.ok(error instanceof AggregateError, 'el close que lanza no debe ocultarse');
  assert.equal(error.message, 'No se pudo cerrar el chat de Twitch.');
  assert.ok(error.errors.includes(failure), 'la causa interna se conserva');
  assert.equal(cut(chat), q, 'un rechazo también queda cacheado');
});

test('el corte cancela físicamente el timer de reconexión y un onclose obsoleto no rearma', async t => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const scheduled = new Set(), cleared = new Set();
  globalThis.setTimeout = (fn, ms, ...a) => { const h = realSet(fn, ms, ...a); scheduled.add(h); return h; };
  globalThis.clearTimeout = h => { cleared.add(h); return realClear(h); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; for (const h of scheduled) realClear(h); });
  const chat = makeChat();
  const base = FakeWs.created.length;
  chat.join('canal');
  const ws = FakeWs.created[base];
  ws.open();
  ws.onclose?.();
  assert.equal(scheduled.size, 1, 'onclose ordinario programa la reconexión');
  const handle = [...scheduled][0];
  await cut(chat);
  assert.ok(cleared.has(handle), 'el corte debe cancelar el timer físico de reconexión');
  ws.onclose?.();
  assert.equal(scheduled.size, 1, 'un onclose obsoleto no rearma');
  assert.equal(FakeWs.created.length, base + 1);
});

test('join/stop ordinarios siguen siendo reiniciables antes del corte', async () => {
  const chat = makeChat();
  const base = FakeWs.created.length;
  chat.join('a');
  assert.equal(FakeWs.created.length, base + 1);
  chat.stop(); chat.join('a');
  assert.equal(FakeWs.created.length, base + 2, 'stop+join ordinario reconecta');
  chat.stop();
});

const CHILD = `
import net from 'node:net';
const scenario = process.argv[1];
let finish = () => {};
class FakeWs extends EventTarget {
  constructor() { super(); this.readyState = 1; globalThis.__lastWs = this; }
  send() {}
  frame(data) { this.onmessage?.({ data }); }
  close() {
    console.log('IRC-CLOSE');
    if (scenario === 'fail') throw new Error('fallo IRC ficticio');
    this.readyState = 2;
    if (scenario === 'gate') { finish = () => { this.readyState = 3; this.dispatchEvent(new Event('close')); }; return; }
    if (scenario === 'deadline') return;
    this.readyState = 3; this.dispatchEvent(new Event('close'));
  }
}
globalThis.WebSocket = FakeWs;
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };
const pre = '@msg-id=highlighted-message;id=pre;display-name=Ana :ana!ana@ana PRIVMSG #canal :destacado-pre';
const post = '@msg-id=highlighted-message;id=post;display-name=Bea :bea!bea@bea PRIVMSG #canal :destacado-post';
const { startServer } = await import(${JSON.stringify(SERVER_URL)});
// Puerto asignado atómicamente por el socket real; PORT=0 solo activaría el fallback.
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  return realListen.call(this, 0, host, callback);
};
const app = await startServer({ quiet: true, log: m => console.error('LOG:' + String(m)), ...(scenario === 'deadline' ? { shutdownTimeoutMs: 200 } : {}) });
net.Server.prototype.listen = realListen;
console.log('BOUND:' + app.server.address().port);
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
app.chat.join('canal');
globalThis.__lastWs.frame(pre);
if (scenario === 'throw-sync') app.chat.quiesceChat = () => { throw new Error('fallo sincrono ficticio'); };
for (const name of ['quiesceEventSub', 'quiesceDeviceFlow']) {
  const real = app.twitch[name].bind(app.twitch);
  app.twitch[name] = () => { console.log(name === 'quiesceEventSub' ? 'EVENTSUB' : 'DEVICE'); return real(); };
}
const realTimers = app.timers.quiesceFires.bind(app.timers);
app.timers.quiesceFires = () => { console.log('TIMERS'); return realTimers(); };
const chain = app.store.chain;
Object.defineProperty(app.store, 'chain', { configurable: true, get() { console.log('CHAIN'); return chain; } });
const realSession = app.session.flush.bind(app.session);
app.session.flush = () => { console.log('FLUSH'); return realSession(); };
const realInteractive = app.interactive.flush.bind(app.interactive);
app.interactive.flush = () => { console.log('INTERACTIVE'); return realInteractive(); };
const realClose = app.closeHttp.bind(app);
app.closeHttp = () => { console.log('HTTP-CLOSE'); return realClose(); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  const line = String(d);
  if (line.includes('post')) { globalThis.__lastWs.frame(post); console.log('POST-INJECTED'); }
  if (line.includes('finish')) finish();
});
console.log('READY');
`;

async function child(t, root, scenario, observe = () => {}, { launch = (args, options) => process.platform === 'win32'
  ? launchSignalChild(process.execPath, args, options)
  : spawn(process.execPath, args, options), onCleanup = () => {} } = {}) {
  let setup, launchPromise, exit, close, cleanupPromise;
  let stopping = false;
  const cleanup = () => {
    if (!cleanupPromise) {
      stopping = true;
      cleanupPromise = (async () => {
        await setup?.catch(() => {});
        const proc = await launchPromise?.catch(() => null);
        if (!proc) return;
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
        await close;
      })();
    }
    return cleanupPromise;
  };
  t.after(cleanup);
  onCleanup(cleanup);
  observe('directory');
  const dir = path.join(root, scenario);
  setup = mkdir(dir, { recursive: true });
  await setup;
  if (stopping || t.signal.aborted) throw new Error('IRC child launch cancelled');
  const env = { ...process.env, ANTENA_DATA: dir, ANTENA_MEDIA: path.join(dir, 'media'), PORT: '0' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  const args = ['--input-type=module', '-e', CHILD, scenario];
  const options = { env, stdio: ['pipe', 'pipe', 'pipe'] };
  let out = '', err = '';
  const waiters = new Set();
  const resolveWaiters = force => { const all = out + err; for (const w of [...waiters]) if (force || all.includes(w.needle)) { clearTimeout(w.timer); waiters.delete(w); w.resolve(all.includes(w.needle)); } };
  observe('launch');
  launchPromise = Promise.resolve(launch(args, options)).then(proc => {
    proc.stdin.on('error', () => {});
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', d => { out += d; resolveWaiters(false); });
    proc.stderr.on('data', d => { err += d; resolveWaiters(false); });
    exit = new Promise(r => proc.once('exit', (code, signal) => r({ code, signal })));
    close = new Promise(r => proc.once('close', (code, signal) => r({ code, signal })));
    exit.then(() => resolveWaiters(true));
    return proc;
  });
  const proc = await launchPromise;
  if (stopping || t.signal.aborted) { await cleanup(); throw new Error('IRC child launch cancelled'); }
  observe('ready-wait');
  const wait = (needle, ms = 6000) => {
    if ((out + err).includes(needle)) return Promise.resolve(true);
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(false);
    return new Promise(resolve => { const w = { needle, resolve, timer: setTimeout(() => { waiters.delete(w); resolve((out + err).includes(needle)); }, ms) }; waiters.add(w); });
  };
  const ready = await wait('READY');
  if (stopping || t.signal.aborted) { await cleanup(); throw new Error('IRC child launch cancelled'); }
  assert.ok(ready, 'sin READY: ' + out + err);
  observe('ready');
  return { proc, exit, wait, out: () => out, err: () => err, send: m => { try { proc.stdin.write(m + '\n'); } catch { /* hijo muerto */ } }, dir };
}

function graceful(c, signal) {
  return process.platform === 'win32'
    ? interruptSignalChild(c.proc, 'SIGINT')
    : c.proc.kill(signal);
}

async function exited(c, ms = 4000) {
  let timer;
  try {
    const r = await Promise.race([c.exit, new Promise(res => { timer = setTimeout(() => res(null), ms); })]);
    assert.ok(r, 'el hijo no salió: ' + c.out() + c.err());
    return r;
  } finally { clearTimeout(timer); }
}

test('IRC cleanup prevents a launch after setup is aborted', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-CHAT-CANCEL-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const hooks = [];
  const fakeTest = { signal: controller.signal, after: hook => hooks.push(hook) };
  let launched = false;
  const result = child(fakeTest, root, 'cancelled', () => {}, {
    launch: () => { launched = true; throw new Error('unexpected launch'); },
  }).then(value => ({ value }), error => ({ error }));
  controller.abort();
  await Promise.all(hooks.map(hook => hook()));
  assert.equal(launched, false, 'aborted setup must not start a child or controller');
  assert.equal((await result).error?.message, 'IRC child launch cancelled');
});

test('IRC cleanup waits for and stops a late child launch', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-CHAT-LATE-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const hooks = [];
  const fakeTest = { signal: controller.signal, after: hook => hooks.push(hook) };
  let releaseLaunch, launchObserved;
  const launchGate = new Promise(resolve => { releaseLaunch = resolve; });
  const launching = new Promise(resolve => { launchObserved = resolve; });
  const proc = spawn(process.execPath, ['-e', "console.log('READY'); process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe'] });
  const controlled = Object.assign(new EventEmitter(), { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr });
  Object.defineProperties(controlled, {
    exitCode: { get: () => proc.exitCode }, signalCode: { get: () => proc.signalCode },
  });
  controlled.kill = signal => proc.kill(signal);
  proc.once('exit', (code, signal) => controlled.emit('exit', code, signal));
  let releaseController, controllerClosed = false;
  const controllerGate = new Promise(resolve => { releaseController = resolve; });
  const closed = new Promise(resolve => proc.once('close', (code, signal) => {
    resolve({ code, signal });
    void controllerGate.then(() => { controllerClosed = true; controlled.emit('close', code, signal); });
  }));
  const result = child(fakeTest, root, 'late', phase => {
    if (phase === 'launch') launchObserved();
  }, { launch: () => launchGate }).then(value => ({ value }), error => ({ error }));
  try {
    await launching;
    controller.abort();
    let cleaned = false;
    const cleanup = Promise.all(hooks.map(hook => hook())).then(() => { cleaned = true; });
    await tick();
    assert.equal(cleaned, false, 'teardown must wait for an in-flight launch');
    releaseLaunch(controlled);
    assert.notEqual((await closed).code, 0);
    await tick();
    assert.equal(cleaned, false, 'teardown must wait for controller close after target exit');
    releaseController();
    await cleanup;
    assert.equal(proc.killed, true, 'the late child must be terminated');
    assert.equal(controllerClosed, true, 'teardown must wait for the controller and its output to close');
    assert.ok((await result).error, 'an aborted launch must not continue to READY');
  } finally {
    releaseLaunch(controlled);
    releaseController();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await closed;
    await result;
  }
});

// Windows can spend 10 s each on parent identity, native launch and interrupt,
// plus READY, exit and controller output drain. Keep the original Linux budget.
test('fixture IRC asigna puerto en el hijo sin reserva previa del padre', { timeout: process.platform === 'win32' ? 60000 : 10000 }, async t => {
  const started = Date.now();
  let phase = 'setup';
  const phases = { setup: 0 };
  const observe = next => { phase = next; phases[next] = Date.now() - started; };
  // Tiempos del padre: el abort no identifica por sí solo la causa del timeout.
  const report = () => t.diagnostic('IRC_PHASE ' + JSON.stringify({ phase, elapsedMs: Date.now() - started, phases }));
  t.signal.addEventListener('abort', report, { once: true });
  const rootPromise = mkdtemp(path.join(tmpdir(), 'EGDEV-CHATPORT-'));
  let cleanupChild = async () => {};
  t.after(async () => {
    const root = await rootPromise;
    observe('cleanup');
    await cleanupChild();
    await rm(root, { recursive: true, force: true });
  });
  const root = await rootPromise;
  if (t.signal.aborted) throw new Error('IRC fixture setup cancelled');
  t.mock.method(net, 'createServer', () => { throw new Error('reserva previa de puerto prohibida'); });
  const c = await child(t, root, 'healthy', observe, { onCleanup: cleanup => { cleanupChild = cleanup; } });
  const port = Number(c.out().match(/^BOUND:(\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, 'puerto asignado por el socket real');
  observe('interrupt');
  await graceful(c, 'SIGTERM');
  observe('exit');
  assert.deepEqual(await exited(c), { code: 0, signal: null }, c.out() + c.err());
  observe('complete');
  // Se registra después de los cleanups: evita el abort normal sin tapar un cleanup retenido.
  t.after(() => t.signal.removeEventListener('abort', report));
});

test('la señal real espera el cierre IRC entre Device Flow y Timers; SIGINT/SIGTERM, repetida, post-corte y persistencia', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-CHATSHUT-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (scenario, signal) => { const c = await child(t, root, scenario); await graceful(c, signal); return c; };
  const gate = await run('gate', 'SIGINT');
  assert.ok(await gate.wait('IRC-CLOSE'), gate.out() + gate.err());
  await graceful(gate, 'SIGTERM');
  assert.equal((gate.out().match(/IRC-CLOSE/g) || []).length, 1, 'señales repetidas comparten la transición');
  assert.equal(/TIMERS|CHAIN|FLUSH/.test(gate.out()), false, 'no avanza con el cierre IRC pendiente');
  gate.send('post');
  assert.ok(await gate.wait('POST-INJECTED'), gate.out());
  gate.send('finish');
  assert.deepEqual(await exited(gate), { code: 0, signal: null }, gate.out() + gate.err());
  const out = gate.out();
  const order = ['EVENTSUB', 'DEVICE', 'IRC-CLOSE', 'TIMERS', 'CHAIN', 'FLUSH', 'HTTP-CLOSE'];
  for (let i = 1; i < order.length; i++) assert.ok(out.indexOf(order[i - 1]) < out.indexOf(order[i]), order[i] + ': ' + out);
  const saved = JSON.parse(await readFile(path.join(gate.dir, 'session-current.json'), 'utf8'));
  assert.deepEqual(saved.notes.map(n => n.text), ['destacado-pre'], 'persiste lo previo al corte y no la nota post-corte');
  if (process.platform === 'win32') {
    // SIGTERM literal termina el proceso nativo: no es un drenado mediante Ctrl+C.
    const forced = await child(t, path.join(root, 'forced-term'), 'gate');
    forced.send('post');
    assert.ok(await forced.wait('POST-INJECTED'), forced.out());
    const sessionFile = path.join(forced.dir, 'session-current.json');
    await assert.rejects(readFile(sessionFile, 'utf8'), { code: 'ENOENT' });
    await graceful(forced, 'SIGINT');
    assert.ok(await forced.wait('IRC-CLOSE'), forced.out() + forced.err());
    const assertHeld = async () => {
      const output = forced.out();
      const port = Number(output.match(/^BOUND:(\d+)$/m)?.[1]);
      assert.ok(Number.isInteger(port) && port > 0, 'puerto real antes del corte forzado');
      const observed = ['BOUND:', 'READY', 'POST-INJECTED', 'EVENTSUB', 'DEVICE', 'IRC-CLOSE'];
      for (const marker of observed) assert.ok(output.includes(marker), marker + ': ' + output);
      for (let i = 1; i < observed.length; i++) {
        assert.ok(output.indexOf(observed[i - 1]) < output.indexOf(observed[i]), observed[i] + ': ' + output);
      }
      assert.equal((output.match(/IRC-CLOSE/g) || []).length, 1, 'una sola transición IRC retenida');
      assert.equal(/TIMERS|CHAIN|FLUSH|INTERACTIVE|HTTP-CLOSE/.test(output), false, 'el corte forzado no drena');
      assert.equal(withoutHeldRecoveryWarning(forced.err(), { prefix: 'LOG:' }), '', 'sin errores ni datos privados');
      assert.equal(/destacado-pre|destacado-post/.test(output + forced.err()), false, 'no filtra destacados');
      await assert.rejects(readFile(sessionFile, 'utf8'), { code: 'ENOENT' });
    };
    await assertHeld();
    assert.equal(forced.proc.kill('SIGTERM'), true, 'terminación nativa aceptada');
    assert.deepEqual(await exited(forced), { code: 1, signal: null }, forced.out() + forced.err());
    await assertHeld();
  }
  const term = await run('gate', 'SIGTERM');
  assert.ok(await term.wait('IRC-CLOSE'), term.out() + term.err());
  term.send('finish');
  assert.deepEqual(await exited(term), { code: 0, signal: null }, term.out() + term.err());
  const fail = await run('fail', 'SIGINT');
  assert.deepEqual(await exited(fail), { code: 1, signal: null }, fail.out() + fail.err());
  const sync = await run('throw-sync', 'SIGINT');
  assert.deepEqual(await exited(sync), { code: 1, signal: null }, sync.out() + sync.err());
  const dead = await run('deadline', 'SIGINT');
  assert.ok(await dead.wait('IRC-CLOSE'), dead.out() + dead.err());
  assert.deepEqual(await exited(dead), { code: 1, signal: null }, dead.out() + dead.err());
  assert.ok(dead.err().split('\n').includes('LOG:[parada] drenado agotado'), 'deadline constante sin datos: ' + dead.err());
});
