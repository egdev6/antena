// ODD-08 (solo pruebas): `drainAuth()` no es terminal ni cachea una promesa global; captura
// saveToken, refresh, validate, helix y stop({forget:true}) con sus continuaciones, espera todas
// con allSettled y rechaza con AggregateError constante y causas originales. Las raíces posteriores
// quedan fuera del snapshot; el corte síncrono de stop y los retornos/errores públicos se conservan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const token = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 };
const reply = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
const tick = () => new Promise(r => setImmediate(r));
let fetchHandler = () => { throw new Error('fetch no previsto en el harness'); };
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido en este harness'); } };
globalThis.fetch = (...args) => fetchHandler(...args);
const { Twitch } = await import('../src/twitch.mjs');

function newTwitch(handler = () => { throw new Error('fetch no previsto en el harness'); }) {
  fetchHandler = handler;
  const store = { config: { twitch: { clientId: 'cid' } },
    secrets: { twitch: { access: 'old-access', refresh: 'old-refresh', expiresAt: Date.now() + 1e6 } },
    async setSecret(k, v) { this.secrets[k] = v; } };
  return { tw: new Twitch(store, () => {}), store };
}
const cleanup = (t, tw) => t.after(() => { tw.stopped = true; clearTimeout(tw.keepaliveTimer); clearTimeout(tw.reconnectTimer); });
const snapshot = tw => { assert.equal(typeof tw.drainAuth, 'function', 'falta drainAuth (ODD-08)'); return tw.drainAuth(); };
// Escritura de secretos retenida: la prueba decide cuándo termina. Devuelve las compuertas.
const gatedSecret = store => {
  const gates = [];
  store.setSecret = async (k, v) => {
    let release; const gate = new Promise(r => { release = r; });
    gates.push(release);
    await gate;
    store.secrets[k] = v;
  };
  return gates;
};

for (const name of ['saveToken', 'refresh', 'validate', 'helix', 'stop']) {
  test(`${name} separado de su instancia conserva el rechazo asíncrono`, { timeout: 10000 }, async () => {
    const { tw } = newTwitch();
    const detached = tw[name];
    let result;
    assert.doesNotThrow(() => { result = detached(); });
    assert.ok(result instanceof Promise);
    await assert.rejects(result, TypeError);
  });
}

test('sin trabajo pendiente drena a undefined y no comparte una promesa global', { timeout: 10000 }, async t => {
  const { tw } = newTwitch();
  cleanup(t, tw);
  const first = snapshot(tw), second = snapshot(tw);
  assert.notEqual(first, second, 'cada llamada toma su propia instantánea, no una caché global');
  assert.equal(await first, undefined);
  assert.equal(await second, undefined);
});

test('una escritura saveToken se registra antes de su IO y el drenaje no resuelve antes', { timeout: 10000 }, async t => {
  const { tw, store } = newTwitch();
  cleanup(t, tw);
  let release; const gate = new Promise(r => { release = r; });
  assert.equal(typeof tw.drainAuth, 'function', 'falta drainAuth (ODD-08)');
  let drain;
  store.setSecret = async (k, v) => { drain = snapshot(tw); await gate; store.secrets[k] = v; };
  const save = tw.saveToken(token);
  assert.ok(drain, 'saveToken debe registrar su trabajo antes de ejecutar la escritura');
  let settled = false; drain.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.equal(settled, false, 'no debe resolver con la escritura todavía en curso');
  release(); await save; await drain;
  assert.equal(store.secrets.twitch.access, token.access_token);
});

test('stop({forget:true}) corta de forma síncrona y su escritura queda dentro del drenaje', { timeout: 10000 }, async t => {
  const { tw, store } = newTwitch();
  cleanup(t, tw);
  const gates = gatedSecret(store);
  const ws = { closed: false, close() { this.closed = true; } };
  const pending = { close() {} };
  tw.stopped = false;
  tw.ws = ws; tw.pending = pending;
  tw.keepaliveTimer = setTimeout(() => {}, 1e6); tw.reconnectTimer = setTimeout(() => {}, 1e6);
  const stop = tw.stop({ forget: true });
  assert.equal(tw.stopped, true, 'la marca síncrona debe aplicarse antes del primer await');
  assert.equal(ws.closed, true, 'el cierre del WS vigente es síncrono');
  assert.equal(tw.ws, null); assert.equal(tw.pending, null);
  assert.equal(tw.keepaliveTimer, null); assert.equal(tw.reconnectTimer, null);
  const q = snapshot(tw);
  let settled = false; q.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'debe esperar la escritura de forget');
  gates[0](); await stop; await q;
  assert.equal(store.secrets.twitch, undefined);
});

test('validate 401 espera el refresh y su escritura anidada antes de resolver', { timeout: 10000 }, async t => {
  let validates = 0;
  let respond; const response = new Promise(r => { respond = r; });
  const { tw, store } = newTwitch(async url => {
    if (url.endsWith('/validate')) return ++validates === 1 ? response : reply({ user_id: 'u', login: 'eg' });
    if (url.endsWith('/token')) return reply(token);
    throw new Error('ruta no prevista: ' + url);
  });
  cleanup(t, tw);
  const gates = gatedSecret(store);
  const work = tw.validate();
  const q = snapshot(tw), result = q.then(() => 'ok', e => e);
  respond(reply({}, false, 401));
  let settled = false; result.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'debe esperar la escritura anidada del refresh');
  gates[0]();
  assert.deepEqual(await work, { user_id: 'u', login: 'eg' });
  assert.equal(await result, 'ok');
  assert.equal(validates, 2, 'debe revalidar tras refrescar');
});

test('helix 401 drena la escritura futura y reintenta con el token escrito', { timeout: 10000 }, async t => {
  const auths = [];
  let respond; const response = new Promise(r => { respond = r; });
  const { tw, store } = newTwitch(async (url, opts) => {
    if (url.includes('/helix/')) { auths.push(opts.headers.Authorization); return auths.length === 1 ? response : reply({ data: [{ id: 'x' }] }); }
    if (url.endsWith('/token')) return reply(token);
    throw new Error('ruta no prevista: ' + url);
  });
  cleanup(t, tw);
  const gates = gatedSecret(store);
  const work = tw.helix('GET', '/users');
  const q = snapshot(tw), result = q.then(() => 'ok', e => e);
  respond(reply({}, false, 401));
  let settled = false; result.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'debe esperar la escritura del refresh en vuelo');
  gates[0]();
  assert.deepEqual(await work, { ok: true, status: 200, data: { data: [{ id: 'x' }] } });
  assert.equal(await result, 'ok');
  assert.deepEqual(auths, ['Bearer old-access', 'Bearer new-access'], 'el reintento usa el token escrito');
});

test('un snapshot ignora raíces posteriores y otro snapshot las captura', { timeout: 10000 }, async t => {
  const { tw, store } = newTwitch();
  cleanup(t, tw);
  const gates = gatedSecret(store);
  const first = tw.saveToken(token);
  assert.equal(gates.length, 1);
  const q1 = snapshot(tw), r1 = q1.then(() => 'ok', e => e);
  const late = tw.saveToken(token);
  assert.equal(gates.length, 2);
  let s1 = false; r1.then(() => { s1 = true; });
  gates[0](); await first; await tick();
  assert.equal(s1, true, 'el primer snapshot no debe incluir la raíz iniciada después');
  const q2 = snapshot(tw);
  let s2 = false; q2.then(() => { s2 = true; }, () => { s2 = true; });
  await tick(); assert.equal(s2, false, 'el snapshot nuevo debe capturar la raíz tardía');
  gates[1](); await late; await q2;
});

test('con varios fallos espera a todos y rechaza con AggregateError y causas originales', { timeout: 10000 }, async t => {
  const { tw, store } = newTwitch();
  cleanup(t, tw);
  const failA = new Error('fallo A'), failB = new Error('');
  const releases = [];
  let writes = 0;
  store.setSecret = async () => {
    const i = writes++;
    let release; const gate = new Promise(r => { release = r; });
    releases.push(release);
    await gate;
    throw i === 0 ? failA : failB;
  };
  const a = tw.saveToken(token), b = tw.saveToken(token);
  assert.equal(releases.length, 2);
  const q = snapshot(tw), result = q.then(() => 'ok', e => e);
  releases[0](); await assert.rejects(a, e => e === failA);
  let settled = false; result.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'no debe rechazar hasta agotar las pendientes');
  releases[1](); await assert.rejects(b, e => e === failB);
  const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, 'No se pudo drenar la autenticación de Twitch.');
  assert.ok(error.errors.includes(failA));
  assert.ok(error.errors.includes(failB), 'se conserva la causa original aunque su mensaje sea vacío');
});

test('un fallo previo al snapshot no lo envenena y el rechazo capturado no queda huérfano', { timeout: 10000 }, async t => {
  const { tw, store } = newTwitch();
  cleanup(t, tw);
  const prev = new Error('fallo previo');
  store.setSecret = async () => { throw prev; };
  await assert.rejects(tw.saveToken(token), e => e === prev);
  assert.equal(await snapshot(tw), undefined, 'el historial previo no debe intoxicar el drenaje');
  const seen = [];
  const onUnhandled = r => seen.push(r);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const orphan = new Error('fallo huérfano');
  let release; const gate = new Promise(r => { release = r; });
  store.setSecret = async () => { await gate; throw orphan; };
  tw.saveToken(token);
  const q = snapshot(tw), result = q.then(() => 'ok', e => e);
  release();
  const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.ok(error.errors.includes(orphan));
  await tick(); await tick();
  assert.deepEqual(seen, [], 'los rechazos drenados no deben quedar como unhandledRejection');
});

test('un resultado HTTP no-ok de helix sigue siendo un resultado, no un rechazo', { timeout: 10000 }, async t => {
  let release; const gate = new Promise(r => { release = r; });
  const { tw } = newTwitch(async () => { await gate; return reply({ message: 'boom' }, false, 500); });
  cleanup(t, tw);
  const work = tw.helix('GET', '/fail');
  await tick();
  const q = snapshot(tw), result = q.then(() => 'ok', e => e);
  let settled = false; result.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'debe esperar la petición en vuelo');
  release();
  assert.deepEqual(await work, { ok: false, status: 500, data: { message: 'boom' } });
  assert.equal(await result, 'ok', 'un no-ok resuelto no debe rechazar el drenaje');
});

test('drenar no instala puertas y las APIs conservan retornos y errores públicos', { timeout: 10000 }, async t => {
  let calls = 0;
  const { tw, store } = newTwitch(async url => {
    calls += 1;
    if (url.endsWith('/validate')) return reply({ user_id: 'u', login: 'eg', scopes: [] });
    if (url.endsWith('/token')) return reply(token);
    if (url.includes('/helix/')) return reply({ data: [{ id: 'x' }] });
    throw new Error('ruta no prevista: ' + url);
  });
  cleanup(t, tw);
  assert.equal(await snapshot(tw), undefined);
  assert.deepEqual(await tw.helix('GET', '/users'), { ok: true, status: 200, data: { data: [{ id: 'x' }] } });
  assert.deepEqual(await tw.validate(), { user_id: 'u', login: 'eg', scopes: [] });
  assert.equal(await tw.refresh(), undefined);
  assert.equal(await tw.saveToken(token), undefined);
  assert.equal(store.secrets.twitch.access, token.access_token);
  assert.equal(calls, 3, 'las llamadas nuevas no deben ser rechazadas con 503');
  assert.equal(await tw.stop(), undefined);
});
