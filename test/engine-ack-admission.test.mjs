// ODD-08b.2b.2b.2d: consulta de lectura y cápsula de identidad de ACKs pendientes de Engine.
// SOLO pruebas. Los casos RED demuestran que hoy NO existen `hasPendingAck`/`capturePendingAcks`:
// la ausencia se trata como «sin generación actual» y el flujo real no puede autorizar el ACK.
// Las consultas son de solo lectura: no crean asas, no despachan y no alteran la generación.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const alertFor = (id, command = id) => ({ id, actions: [{ kind: 'command', command }], vars: {} });
const hasAck = (engine, id) => typeof engine.hasPendingAck === 'function' ? engine.hasPendingAck(id) : null;
const capsuleOf = engine => typeof engine.capturePendingAcks === 'function' ? engine.capturePendingAcks() : null;

function makeEngine({ overlay = 1 } = {}) {
  return new Engine({
    store: { config: { paused: false }, patchConfig: async () => {} },
    bus: { history: [], historySize: 100, overlayCount: () => overlay, send() {} },
    session: { record() {} },
    meld: { session: () => ({ scenes: [] }) },
    twitch: { sendChat: async () => ({}) },
    log: () => {},
  });
}

test('existen hasPendingAck/capturePendingAcks y una consulta vacía es falsa y segura', () => {
  assert.equal(typeof Engine.prototype.hasPendingAck, 'function', 'falta hasPendingAck (contrato 08b.2b.2b.2d)');
  assert.equal(typeof Engine.prototype.capturePendingAcks, 'function', 'falta capturePendingAcks (contrato 08b.2b.2b.2d)');
  const engine = makeEngine();
  assert.equal(hasAck(engine, 'nada'), false, 'un id desconocido no está pendiente');
  const cap = capsuleOf(engine);
  assert.ok(cap, 'capturePendingAcks debe devolver una cápsula');
  assert.equal(cap.isCurrent('nada'), false, 'una cápsula sin pendientes no reconoce ningún id');
});

test('la consulta exige pertenencia pública y ticket privado: desconocido, huérfano y stale son falsos', () => {
  const engine = makeEngine({ overlay: 1 });
  engine.runActions = async () => {};
  engine.send(alertFor('p1'));
  assert.equal(hasAck(engine, 'p1'), true, 'un envío aceptado con ACK pendiente está pendiente');
  assert.equal(hasAck(engine, 'p2'), false, 'un id desconocido no está pendiente');
  engine.pendingActions.delete('p1');                 // huérfano: público borrado, ticket privado queda
  assert.equal(hasAck(engine, 'p1'), false, 'huérfano no debe considerarse pendiente');
  engine.alertShown('p1');                            // limpia el ticket privado sin despachar acciones
  engine.pendingActions.set('p1', alertFor('p1'));    // stale: público puesto a mano, sin ticket privado
  assert.equal(hasAck(engine, 'p1'), false, 'stale sin ticket privado no es pendiente');
});

test('la cápsula expone solo un predicado inmutable de la generación capturada', () => {
  const engine = makeEngine();
  engine.runActions = async () => {};
  engine.send(alertFor('c1'));
  const cap = capsuleOf(engine);
  assert.ok(cap, 'falta capturePendingAcks');
  assert.equal(typeof cap.isCurrent, 'function', 'la cápsula expone un predicado booleano');
  assert.equal(Object.isFrozen(cap), true, 'la cápsula es inmutable');
  assert.equal(Object.keys(cap).length, 1, 'no expone raíces ni mapas mutables');
  assert.equal(cap.isCurrent('c1'), true, 'la generación capturada sigue siendo actual');
  assert.equal(cap.isCurrent('otro'), false, 'otro id no es actual');
});

test('un envío duplicado conserva la MISMA generación y el payload vigente; el ACK despacha una vez', async () => {
  const engine = makeEngine();
  const dispatched = [];
  engine.runActions = async actions => { dispatched.push(actions[0]?.command); };
  engine.send(alertFor('d1', 'primero'));
  const cap = capsuleOf(engine);
  assert.ok(cap, 'falta capturePendingAcks');
  engine.send(alertFor('d1', 'segundo'));             // mismo ciclo pendiente, payload vigente
  assert.equal(cap.isCurrent('d1'), true, 'el duplicado pre-ACK mantiene la misma generación');
  assert.equal(hasAck(engine, 'd1'), true, 'sigue pendiente antes del ACK');
  engine.alertShown('d1');
  await flush();
  assert.deepEqual(dispatched, ['segundo'], 'despacha el payload vigente una sola vez');
  assert.equal(cap.isCurrent('d1'), false, 'tras el ACK la generación capturada ya no es actual');
  assert.equal(hasAck(engine, 'd1'), false, 'deja de estar pendiente');
});

test('una generación posterior con el mismo id queda fuera aunque otro drenaje infle el refCount', async () => {
  const engine = makeEngine();
  engine.runActions = async () => {};
  engine.send(alertFor('e1'));
  const cap = capsuleOf(engine);
  assert.ok(cap, 'falta capturePendingAcks');
  const d1 = engine.drainSentActions();
  const d2 = engine.drainSentActions();               // drenadores independientes: refCount > 0
  await flush();
  assert.equal(cap.isCurrent('e1'), true, 'el refCount de otros drenajes no invalida la identidad capturada');
  engine.alertShown('e1');
  await Promise.all([d1, d2]);
  engine.send(alertFor('e1'));                        // generación nueva, mismo id
  assert.equal(cap.isCurrent('e1'), false, 'una generación nueva no es la capturada');
  assert.equal(hasAck(engine, 'e1'), true, 'la generación nueva sí está pendiente');
  const cap2 = capsuleOf(engine);
  assert.equal(cap2.isCurrent('e1'), true, 'la nueva captura sí reconoce la generación vigente');
  engine.alertShown('e1');
});

test('consultar y capturar son de solo lectura: no programan asas ni despachan acciones', async t => {
  let scheduled = 0;
  t.mock.method(globalThis, 'setTimeout', () => { scheduled += 1; return { unref() {}, ref() {} }; });
  const engine = makeEngine();
  let ran = 0;
  engine.runActions = async () => { ran += 1; };
  engine.send(alertFor('r1'));
  const baseline = scheduled;
  assert.equal(hasAck(engine, 'r1'), true);
  const cap = capsuleOf(engine);
  assert.equal(cap.isCurrent('r1'), true);
  assert.equal(scheduled, baseline, 'consultar/capturar no programan temporizadores');
  assert.equal(ran, 0, 'consultar/capturar no despachan acciones');
});
