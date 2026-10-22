// 08b.2b.2a: solo Device Flow. Cancelar esperas sin un nuevo POST/token y drenar
// solicitudes/escrituras ya admitidas; HELIX-refresh y acciones salientes quedan fuera.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { launchChildOnFreePort } from './helpers/free-port.mjs';
import { Twitch } from '../src/twitch.mjs';

const TWITCH_URL = new URL('../src/twitch.mjs', import.meta.url).href;
const SERVER_URL = new URL('../src/server.mjs', import.meta.url).href;
const device = { user_code: 'FAKE-CODE', verification_uri: 'https://example.invalid', device_code: 'fake-device', expires_in: 300, interval: 1 };
const token = { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600 };
const reply = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const tick = () => new Promise(r => setImmediate(r));
const delay = ms => new Promise(r => setTimeout(r, ms));
let fetchHandler = () => { throw new Error('fetch no previsto en el harness'); };

// Mantener ambos dobles hasta que se haya agotado el event loop del proceso aislado.
before(() => {
  const ws = globalThis.WebSocket, fetch = globalThis.fetch;
  globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
  globalThis.fetch = (...args) => fetchHandler(...args);
  process.once('beforeExit', () => { globalThis.WebSocket = ws; globalThis.fetch = fetch; });
});
after(() => { fetchHandler = () => { throw new Error('fetch después del cleanup'); }; });

function context(t, handler) {
  fetchHandler = handler;
  const store = { config: { twitch: { clientId: 'fake-client' } }, secrets: {}, async setSecret(k, v) { this.secrets[k] = v; } };
  const tw = new Twitch(store, () => {});
  t.after(() => {
    tw.stopped = true;
    clearTimeout(tw.keepaliveTimer); clearTimeout(tw.reconnectTimer);
    tw.quiesceDeviceFlow?.().catch(() => {});
  });
  return { tw, store };
}

function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
}
const cut = tw => typeof tw.quiesceDeviceFlow === 'function' ? tw.quiesceDeviceFlow() : tw.quiesceEventSub();

test('Device Flow tiene corte público terminal, misma promesa y rechaza nuevos logins sin red', async t => {
  const { tw } = context(t, () => { throw new Error('no debe abrir una solicitud'); });
  assert.equal(typeof tw.quiesceDeviceFlow, 'function', 'falta quiesceDeviceFlow');
  const q = tw.quiesceDeviceFlow();
  assert.equal(tw.quiesceDeviceFlow(), q);
  await q;
  const closing = e => e.code === 'TWITCH_DEVICE_CLOSING' && e.status === 503 && e.message === 'La autorización de Twitch se está cerrando.';
  await assert.rejects(tw.startDeviceLogin(), closing);
  await assert.rejects(tw.pollDevice(device), closing);
});

test('cancelar una espera de polling no inicia otro POST/token', async t => {
  clock(t);
  let posts = 0;
  const { tw } = context(t, async url => {
    if (url.endsWith('/device')) return reply(device);
    assert.ok(url.endsWith('/token')); posts += 1;
    return reply({ message: 'authorization_pending' }, false, 400);
  });
  await tw.startDeviceLogin();
  await cut(tw);
  t.mock.timers.tick(1000); await tick();
  assert.equal(posts, 0, 'el timer cancelado no puede hacer POST/token');
});

test('un token solicitado antes del corte termina su escritura antes de resolver', async t => {
  clock(t);
  let entered; const inPost = new Promise(r => { entered = r; });
  let releasePost, releaseWrite;
  const post = new Promise(r => { releasePost = () => r(reply(token)); });
  const write = new Promise(r => { releaseWrite = r; });
  const { tw, store } = context(t, async url => {
    if (url.endsWith('/device')) return reply(device);
    assert.ok(url.endsWith('/token')); entered(); return post;
  });
  let writing; const inWrite = new Promise(r => { writing = r; });
  store.setSecret = async (k, v) => { writing(); await write; store.secrets[k] = v; };
  t.after(() => { releasePost(); releaseWrite(); });
  await tw.startDeviceLogin(); t.mock.timers.tick(1000); await inPost;
  const q = cut(tw); let settled = false;
  q.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(settled, false, 'esperar la respuesta ya admitida');
  releasePost(); await inWrite; await tick();
  assert.equal(settled, false, 'esperar también setSecret');
  releaseWrite(); await q;
  assert.equal(store.secrets.twitch.access, token.access_token);
  assert.equal(store.secrets.twitch.refresh, token.refresh_token);
});

test('una escritura admitida fallida rechaza el drenaje con error público constante', async t => {
  clock(t);
  let entering; const entered = new Promise(r => { entering = r; });
  let release; const gate = new Promise(r => { release = r; });
  const failure = new Error('fallo de IO ficticio');
  const { tw, store } = context(t, async url => reply(url.endsWith('/device') ? device : token));
  store.setSecret = async () => { entering(); await gate; throw failure; };
  t.after(() => release());
  await tw.startDeviceLogin(); t.mock.timers.tick(1000); await entered;
  const q = cut(tw), result = q.then(() => null, e => e);
  release(); const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'No se pudo cerrar la autorización de Twitch.');
  assert.ok(error.errors.includes(failure));
  assert.equal(cut(tw), q, 'un rechazo también queda cacheado');
});

test('el POST/device admitido se drena sin publicar otro polling después del corte', async t => {
  let entering, release;
  const entered = new Promise(r => { entering = r; });
  const gate = new Promise(r => { release = () => r(reply(device)); });
  let tokens = 0;
  const { tw } = context(t, async url => {
    if (url.endsWith('/device')) { entering(); return gate; }
    tokens += 1; throw new Error('no se debe iniciar polling');
  });
  t.after(() => release());
  const login = tw.startDeviceLogin(); await entered;
  const q = cut(tw); let settled = false;
  q.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(settled, false);
  release(); assert.equal((await login).code, device.user_code); await q;
  assert.equal(tokens, 0);
  assert.equal(tw.status.device, null);
});

test('un POST/token admitido que falla no se convierte en cancelación saludable', async t => {
  clock(t);
  let entering, release;
  const entered = new Promise(r => { entering = r; });
  const gate = new Promise(r => { release = () => r(reply({ message: 'error ficticio del proveedor' }, false, 503)); });
  const { tw } = context(t, async url => {
    if (url.endsWith('/device')) return reply(device);
    entering(); return gate;
  });
  t.after(() => release());
  await tw.startDeviceLogin(); t.mock.timers.tick(1000); await entered;
  const q = cut(tw), result = q.then(() => null, e => e);
  release(); const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'No se pudo cerrar la autorización de Twitch.');
});

test('polling ordinario conserva pending, slow_down y token; HELIX queda fuera del corte', async t => {
  clock(t);
  let posts = 0, starts = 0, helix = 0;
  const { tw, store } = context(t, async url => {
    if (url.endsWith('/device')) return reply(device);
    if (url.includes('/helix/')) { helix += 1; return reply({}); }
    posts += 1;
    if (posts < 3) return reply({ message: posts === 1 ? 'authorization_pending' : 'slow_down' }, false, 400);
    return reply(token);
  });
  tw.start = async () => { starts += 1; };
  await tw.startDeviceLogin(); await tick();
  t.mock.timers.tick(1000); await tick(); assert.equal(posts, 1);
  t.mock.timers.tick(1000); await tick(); assert.equal(posts, 2);
  t.mock.timers.tick(5999); await tick(); assert.equal(posts, 2);
  t.mock.timers.tick(1); await tick();
  assert.equal(posts, 3); assert.equal(starts, 1);
  assert.equal(store.secrets.twitch.access, token.access_token);
  await cut(tw);
  assert.equal((await tw.helix('GET', '/users')).ok, true);
  assert.equal(helix, 1, 'este corte no bloquea salidas');
});

const CHILD = `
const scenario = process.argv[1];
if (scenario === 'natural') {
  const { Twitch } = await import(${JSON.stringify(TWITCH_URL)});
  globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
  globalThis.fetch = async url => ({ ok: url.endsWith('/device'), status: url.endsWith('/device') ? 200 : 400,
    json: async () => url.endsWith('/device') ? ${JSON.stringify({ ...device, interval: 5 })} : { message: 'authorization_pending' } });
  const store = { config: { twitch: { clientId: 'fake-client' } }, secrets: {}, async setSecret(k,v) { this.secrets[k]=v; } };
  const tw = new Twitch(store, () => {});
  await tw.startDeviceLogin(); console.log('READY');
  await (typeof tw.quiesceDeviceFlow === 'function' ? tw.quiesceDeviceFlow() : tw.quiesceEventSub());
  console.log('CLOSED'); process.stdin.destroy();
} else {
  const { startServer } = await import(${JSON.stringify(SERVER_URL)});
  const app = await startServer({ quiet: true, log: () => {}, ...(scenario === 'deadline' ? { shutdownTimeoutMs: 150 } : {}) });
  app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
  app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
  const eventSub = app.twitch.quiesceEventSub.bind(app.twitch);
  app.twitch.quiesceEventSub = () => eventSub().then(() => console.log('EVENTSUB-DONE'));
  const chain = app.store.chain;
  Object.defineProperty(app.store, 'chain', { get: () => { console.log('CHAIN-SNAPSHOT'); return chain; } });
  app.session.flush = async () => console.log('FLUSH');
  let release; const gate = new Promise(r => { release = r; });
  let calls = 0;
  app.twitch.quiesceDeviceFlow = async () => {
    console.log('DEVICE:' + ++calls);
    if (scenario === 'fail') throw new Error('fallo ficticio');
    await gate;
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { if (String(d).includes('release')) release(); });
  console.log('READY');
}
`;


async function child(t, scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-DEVICE-'));
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
  const args = ['--input-type=module', '-e', CHILD, scenario];
  const options = { env, stdio: ['pipe', 'pipe', 'pipe'] };
  const proc = scenario === 'natural'
    ? spawn(process.execPath, args, options)
    : await launchSignalChild(process.execPath, args, options);
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
    assert.ok(result, 'el hijo no salió naturalmente: ' + c.out());
    return result;
  } finally { clearTimeout(timer); }
}

test('SIGINT/SIGTERM esperan Device Flow después de EventSub y antes del snapshot; error/deadline salen 1', { timeout: 20000 }, async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    // Solo los positivos usan Ctrl+C en Windows; SIGTERM forzado se prueba aparte.
    const actualGracefulSignal = process.platform === 'win32' && signal === 'SIGTERM' ? 'SIGINT' : signal;
    const c = await child(t, 'gate'); await interruptSignalChild(c.proc, actualGracefulSignal);
    await c.wait('DEVICE:1');
    assert.equal(c.out().includes('CHAIN-SNAPSHOT'), false);
    assert.equal(c.out().includes('FLUSH'), false);
    await interruptSignalChild(c.proc, actualGracefulSignal); await tick();
    assert.equal((c.out().match(/DEVICE:/g) || []).length, 1);
    c.proc.stdin.write('release\n');
    assert.deepEqual(await exited(c), { code: 0, signal: null });
    assert.ok(c.out().indexOf('EVENTSUB-DONE') < c.out().indexOf('DEVICE:1'));
    assert.ok(c.out().indexOf('DEVICE:1') < c.out().indexOf('CHAIN-SNAPSHOT'));
    assert.ok(c.out().indexOf('CHAIN-SNAPSHOT') < c.out().indexOf('FLUSH'));
  }
  for (const scenario of ['fail', 'deadline']) {
    const c = await child(t, scenario); await interruptSignalChild(c.proc, 'SIGINT');
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
  }
  if (process.platform === 'win32') {
    const c = await child(t, 'gate');
    assert.equal(c.proc.kill('SIGTERM'), true);
    assert.deepEqual(await exited(c), { code: 1, signal: null }, c.out());
    assert.doesNotMatch(c.out(), /DEVICE:|CHAIN-SNAPSHOT|FLUSH/, 'SIGTERM forzado no promete drenaje');
  }
});

test('cerrar Device Flow cancela su timer: un hijo termina sin process.exit', { timeout: 10000 }, async t => {
  const c = await child(t, 'natural');
  await c.wait('CLOSED');
  assert.deepEqual(await exited(c, 1500), { code: 0, signal: null });
});
