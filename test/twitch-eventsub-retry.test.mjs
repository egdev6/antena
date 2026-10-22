// Issue #64: `subscribeAll` debe reintentar de forma acotada una suscripción de
// EventSub que falla, sin reconectar. Si al agotarse los reintentos sigue
// fallando, el tipo afectado no debe figurar como suscrito y debe quedar
// reflejado en los errores del estado.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Twitch } from '../src/twitch.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));

class FakeWs extends EventTarget {
  constructor(url) { super(); this.url = url; this.readyState = 1; FakeWs.created.push(this); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
FakeWs.created = [];

const originalWs = globalThis.WebSocket;
globalThis.WebSocket = FakeWs;
process.once('beforeExit', () => { globalThis.WebSocket = originalWs; });

function makeTwitch(overrides = {}) {
  const store = {
    config: { twitch: { clientId: 'cid' }, chat: {} },
    secrets: { twitch: { access: 'a', refresh: 'r', expiresAt: Date.now() + 1e6 } },
    async setSecret(k, v) { this.secrets[k] = v; },
  };
  const twitch = Object.assign(new Twitch(store, () => {}), overrides);
  after(() => {
    twitch.stopped = true;
    clearTimeout(twitch.keepaliveTimer);
    clearTimeout(twitch.reconnectTimer);
  });
  return twitch;
}

function welcomeFrame(id) {
  return { metadata: { message_type: 'session_welcome' }, payload: { session: { id, keepalive_timeout_seconds: 30 } } };
}

// Helix simulado: tipos que fallan los primeros intentos y luego aceptan.
function failingHelix(failures) {
  // failures: Map de tipo -> intentos que deben fallar.
  const calls = [];
  const helix = async (method, pathname, body) => {
    if (method === 'POST' && pathname === '/eventsub/subscriptions') {
      calls.push(body.type);
      const remaining = failures.get(body.type) || 0;
      if (remaining > 0) {
        failures.set(body.type, remaining - 1);
        return { ok: false, status: 500, data: { message: 'fallo simulado' } };
      }
      return { ok: true, status: 202, data: {} };
    }
    return { ok: true, status: 200, data: {} };
  };
  helix.calls = calls;
  return helix;
}

test('una suscripción que falla una vez se reintenta y acaba creada sin reconectar', async () => {
  const twitch = makeTwitch({ retryDelayMs: 0 });
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  const failures = new Map([['channel.cheer', 1]]);
  twitch.helix = failingHelix(failures);
  await twitch.start();
  assert.equal(FakeWs.created.length, 1, 'debe abrir un único WebSocket');
  await twitch.onMessage(twitch.ws, welcomeFrame('sess'), { isReconnect: false });
  assert.ok(twitch.status.subscriptions.includes('channel.cheer'), 'cheer debe acabar suscrito tras el reintento');
  assert.deepEqual(twitch.status.errors, [], 'sin errores tras el reintento con éxito');
  assert.equal(twitch.status.state, 'conectado');
  assert.equal(FakeWs.created.length, 1, 'no debe reconectar para conseguir la suscripción');
  const cheerCalls = twitch.helix.calls.filter(t => t === 'channel.cheer');
  assert.equal(cheerCalls.length, 2, 'cheer se solicita dos veces (fallo + reintento)');
});

test('si los reintentos se agotan, el tipo afectado no consta como suscrito y aparece en errores', async () => {
  const twitch = makeTwitch({ retryDelayMs: 0 });
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  twitch.helix = failingHelix(new Map([['channel.raid', 999]]));
  await twitch.start();
  await twitch.onMessage(twitch.ws, welcomeFrame('sess'), { isReconnect: false });
  assert.equal(twitch.status.subscriptions.includes('channel.raid'), false, 'raid no debe constar como suscrito');
  assert.ok(twitch.status.errors.some(e => e.includes('channel.raid')), 'raid debe figurar en los errores');
  assert.ok(twitch.status.subscriptions.includes('channel.follow'), 'los demás tipos siguen suscritos');
  const raidCalls = twitch.helix.calls.filter(t => t === 'channel.raid');
  assert.ok(raidCalls.length > 1 && raidCalls.length <= 4, `reintento acotado de raid (intentos: ${raidCalls.length})`);
  assert.equal(twitch.status.state, 'conectado', 'la conexión sigue válida aunque un tipo falle');
  await delay(0);
});

test('un stop durante una espera de reintento resuelve enseguida y sin helix posterior', { timeout: 5000 }, async () => {
  const twitch = makeTwitch({ retryDelayMs: 60_000 });
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  const failures = new Map([['channel.follow', 1]]);
  twitch.helix = failingHelix(failures);
  await twitch.start();
  const inflight = twitch.onMessage(twitch.ws, welcomeFrame('sess'), { isReconnect: false });
  await delay(10); // primer intento de follow falla; la espera de reintento queda pendiente
  assert.equal(twitch.helix.calls.filter(t => t === 'channel.follow').length, 1);
  const base = twitch.helix;
  const t0 = Date.now();
  await twitch.stop();
  await inflight;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1000, `el stop no debe quedar colgado por la espera cancelada (${elapsed}ms)`);
  const calls = base.calls.length;
  await delay(50);
  assert.equal(base.calls.length, calls, 'sin intentos de helix tras el stop');
});

test('un 403 permanente se intenta una sola vez y no retrasa a los siguientes tipos', { timeout: 5000 }, async () => {
  const twitch = makeTwitch({ retryDelayMs: 0 });
  twitch.validate = async () => ({ user_id: 'u1', login: 'eg', scopes: [] });
  const failures = new Map([['channel.follow', 999]]);
  twitch.helix = failingHelix(failures);
  // Helix de este test: follow responde 403 permanente en vez de 500.
  const base = twitch.helix;
  twitch.helix = async (method, pathname, body) => {
    const r = await base(method, pathname, body);
    if (body?.type === 'channel.follow' && !r.ok) return { ok: false, status: 403, data: { message: 'sin scope' } };
    return r;
  };
  await twitch.start();
  await twitch.onMessage(twitch.ws, welcomeFrame('sess'), { isReconnect: false });
  const followCalls = base.calls.filter(t => t === 'channel.follow');
  assert.equal(followCalls.length, 1, `un 4xx permanente no se reintenta (intentos: ${followCalls.length})`);
  assert.ok(twitch.status.subscriptions.includes('channel.cheer'), 'el tipo siguiente no queda retrasado ni bloqueado');
  assert.ok(twitch.status.errors.some(e => e.includes('channel.follow')));
});
