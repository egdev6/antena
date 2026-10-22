// ODD-08 (solo pruebas, test-first): `drainChat()` es la raíz propia de confirmaciones
// `addQuestion` y envíos `say`, separada de `drawWork`. Snapshot no terminal; registra antes de
// invocar el envío/callback; observa el rechazo real antes del catch normal; vacío resuelve; un
// fallo previo no envenena y las raíces tardías quedan fuera. La validación HELIX usa el código
// real `Twitch.sendChat`/`_helix` con un doble de `fetch` (is_sent:false); no es un proveedor físico
// ni un servidor HTTP local, así que no se presenta como fallo real del proveedor remoto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interactive, DEFAULT_INTERACTIVE_CONFIG } from '../src/interactive.mjs';

const tick = () => new Promise(r => setImmediate(r));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

function fixture(confirmInChat = true) {
  const calls = [], sends = [], logs = [];
  const store = { dir: '.', config: { interactive: structuredClone(DEFAULT_INTERACTIVE_CONFIG) } };
  store.config.interactive.questions.confirmInChat = confirmInChat;
  const twitch = { sendChat: text => { calls.push(text); const d = deferred(); sends.push(d); return d.promise; } };
  const i = new Interactive({ store, twitch, log: (...a) => logs.push(a), writer: async () => {} });
  return { i, store, twitch, calls, sends, logs };
}
const chatText = (i, text = 'Pregunta de prueba') => i.addQuestion({ user: 'ana', platform: 'twitch', text });

test('confirmación pendiente: el snapshot espera el envío completo sin alterar item ni estado', async () => {
  const { i, sends } = fixture();
  const item = chatText(i);
  assert.equal(typeof i.drainChat, 'function', 'falta Interactive.drainChat (ODD-08)');
  assert.equal(sends.length, 1, 'la confirmación arranca tras registrar la raíz');
  const drain = i.drainChat();
  let settled = false; drain.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'no debe resolver con el envío en curso');
  sends[0].resolve({ is_sent: true });
  await drain;
  assert.equal(item.status, 'pending');
  assert.equal(i.s.questions[0].id, item.id, 'el payload/estado público no cambia');
});

test('reentrancia desde change y desde el propio sender: raíz registrada antes del efecto', async () => {
  const { i, sends } = fixture();
  let drain;
  i.once('change', () => { drain = i.drainChat(); });
  chatText(i);
  assert.ok(drain, 'el listener obtiene una captura');
  assert.equal(sends.length, 1, 'el envío arranca después del callback');
  let settled = false; drain.then(() => { settled = true; });
  await tick(); assert.equal(settled, false, 'la raíz ya debía estar registrada antes del envío');
  sends[0].resolve(null);
  await drain;

  // El sender mismo captura durante su invocación: la raíz de `say` ya existe antes de llamarlo.
  const { i: j, twitch: jTwitch } = fixture();
  let senderDrain, release;
  jTwitch.sendChat = () => { senderDrain = j.drainChat(); return new Promise(r => { release = r; }); };
  const sending = j.say('reentrante');
  assert.ok(senderDrain, 'el sender puede capturar su propia raíz');
  let done = false; senderDrain.then(() => { done = true; });
  await tick(); assert.equal(done, false, 'no resuelve antes del envío causal');
  release(null); await sending; await senderDrain;
});

test('say directo: el snapshot espera el envío; propagate y el catch normal conservan su contrato', async () => {
  const { i, sends, logs } = fixture();
  const normal = i.say('mensaje normal');
  const drain = i.drainChat();
  let settled = false; drain.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(settled, false);
  const absorbed = new Error('absorbido');
  sends[0].reject(absorbed);
  await normal;
  assert.equal(logs.length, 1, 'el catch normal loggea sin propagar');
  await assert.rejects(drain, e => e instanceof AggregateError && e.errors.includes(absorbed));

  const strict = i.say('mensaje estricto', {}, { propagate: true });
  const strictDrain = i.drainChat();
  const propagated = new Error('propagado');
  sends[1].reject(propagated);
  await assert.rejects(strict, e => e === propagated);
  await assert.rejects(strictDrain, e => e instanceof AggregateError && e.errors.includes(propagated));
});

test('rechazos absorbidos: espera la raíz pendiente restante y no queda unhandledRejection', async t => {
  const { i, sends } = fixture();
  const seen = [];
  const onUnhandled = reason => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  chatText(i, 'Primera pregunta larga');
  i.say('segundo envío');
  assert.equal(sends.length, 2);
  const drain = i.drainChat();
  let settled = false; drain.then(() => { settled = true; }, () => { settled = true; });
  const a = new Error('A'), b = new Error('B');
  sends[0].reject(a);
  await tick();
  assert.equal(settled, false, 'no debe rechazar hasta agotar la raíz aún pendiente');
  sends[1].reject(b);
  await assert.rejects(drain, e => e instanceof AggregateError && e.errors.includes(a) && e.errors.includes(b));
  assert.equal(settled, true);
  await tick(); await tick();
  assert.deepEqual(seen, []);
});

test('throws síncronos del sender y del callback conservan la firma y la raíz queda observada', async () => {
  const { i, twitch } = fixture();
  const senderBoom = new Error('sender');
  twitch.sendChat = () => { throw senderBoom; };
  assert.throws(() => chatText(i), e => e === senderBoom, 'el throw del sender se conserva');
  await assert.rejects(i.drainChat(), e => e instanceof AggregateError && e.errors.includes(senderBoom));

  const { i: j } = fixture();
  const callbackBoom = new Error('callback');
  j.once('change', () => { throw callbackBoom; });
  assert.throws(() => chatText(j), e => e === callbackBoom, 'el throw del callback se conserva');
  await assert.rejects(j.drainChat(), e => e instanceof AggregateError && e.errors.includes(callbackBoom));
  const { i: k, twitch: kt, logs } = fixture(); kt.sendChat = () => { throw senderBoom; };
  const normal = k.say('sync'); const captured = assert.rejects(k.drainChat(), e => e.errors.includes(senderBoom));
  assert.equal(logs.length, 1); await normal; await captured;
});

test('sin trabajo inventado: vacío, manual, confirmación desactivada, template y anuncio off', async () => {
  const { i, store, sends } = fixture();
  assert.equal(await i.drainChat(), undefined);
  i.addQuestion({ user: 'ana', platform: 'manual', text: 'Pregunta manual larga' });
  assert.equal(sends.length, 0, 'manual no confirma en chat');
  const { i: off, sends: offSends } = fixture(false);
  off.addQuestion({ user: 'ana', platform: 'twitch', text: 'Confirmación desactivada' });
  assert.equal(offSends.length, 0, 'confirmación desactivada no envía');
  off.cfg.giveaway.announceInChat = false;
  await off.say('tampoco desde say');
  await i.say('');
  assert.equal(sends.length, 0, 'template vacío no envía');
  store.config.interactive.giveaway.announceInChat = false;
  await i.say('texto no enviado');
  assert.equal(sends.length, 0, 'anuncio desactivado no envía');
  assert.equal(await i.drainChat(), undefined);
});

test('fallo previo no envenena; snapshots concurrentes y raíz tardía quedan fuera', async () => {
  const { i, sends } = fixture();
  const previous = new Error('previo');
  const failed = i.say('falla previa');
  sends[0].reject(previous);
  await failed;
  assert.equal(await i.drainChat(), undefined, 'un fallo ya terminado no envenena');

  i.say('primera');
  const snap1 = i.drainChat();
  i.say('segunda');
  const snap2 = i.drainChat();
  assert.notEqual(snap1, snap2);
  let done1 = false, done2 = false;
  snap1.then(() => { done1 = true; }); snap2.then(() => { done2 = true; });
  sends[1].resolve(null);
  await snap1; await tick();
  assert.equal(done1, true);
  assert.equal(done2, false, 'la raíz tardía no entra en el primer snapshot');
  sends[2].resolve(null);
  await snap2;
  assert.equal(done2, true);
  assert.equal(await i.drainChat(), undefined);
});

test('Twitch.sendChat real con doble de fetch: is_sent=false rechaza y drainChat lo observa', async t => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (!String(url).includes('/helix/')) throw new Error('ruta no prevista: ' + url);
    return { ok: true, status: 200, json: async () => ({ data: [{ is_sent: false, drop_reason: { message: 'rechazado' } }] }) };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const { Twitch } = await import('../src/twitch.mjs');
  const store = {
    dir: '.', config: { twitch: { clientId: 'cid' }, interactive: structuredClone(DEFAULT_INTERACTIVE_CONFIG) },
    secrets: { twitch: { access: 'a', refresh: 'r', expiresAt: Date.now() + 1e6 } },
    setSecret: async (k, v) => { store.secrets[k] = v; },
  };
  const tw = new Twitch(store, () => {});
  tw.userId = 'u';
  const i = new Interactive({ store, twitch: tw, log: () => {}, writer: async () => {} });
  const sending = i.say('hola');
  const drain = i.drainChat();
  await sending;
  await assert.rejects(drain, e => e instanceof AggregateError && /rechazado/.test(e.errors[0]?.message));
});

for (const initial of [true, false]) test(`change reevalúa confirmInChat inicialmente ${initial}`, async () => {
  const { i, sends } = fixture(initial);
  i.once('change', () => { i.cfg.questions.confirmInChat = !initial; });
  chatText(i);
  try { assert.equal(sends.length, Number(!initial)); }
  finally { for (const send of sends) send.resolve(null); await i.drainChat(); }
});
