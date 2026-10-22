// #66: cola del overlay con tope y política para ráfagas.
// Política (diseño aprobado): el tope vive en el motor (overlay.queueMax, 0 = sin tope).
// Al superar el tope: primero se agrupan los regalos del mismo tipo y mismo «de» pendientes
// en cola (nunca una alerta ya mostrada), y después se descartan las más antiguas sin mostrar,
// cancelando sus acciones y fallback, con nota en la cronología y aviso para el panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');
const { DEFAULT_CONFIG } = await import('../src/store.mjs');

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function makeEngine({ overlay = 1, config = {} } = {}) {
  const sent = [];                       // eventos 'alert' enviados al overlay
  const controls = [];                   // eventos 'control' enviados al overlay
  const notes = [];                      // notas de cronología
  const engine = new Engine({
    store: {
      config: {
        paused: false,
        overlay: { queueMax: 20 },
        alerts: {
          giftsub: { text: '{user}', sub: 'regala {amount} subs' },
          giftmember: { text: '{user}', sub: 'regala {amount} membresías' },
        },
        ...config,
      }, patchConfig: async () => {} },
    bus: {
      history: [], historySize: 100, overlayCount: () => overlay,
      send(event, data) {
        if (event === 'alert' && data?.id) sent.push(data);
        if (event === 'control') controls.push(data);
      },
    },
    session: { record() {}, addNote(n) { notes.push(n); return n; } },
    meld: { session: () => ({ scenes: [] }) },
    twitch: { sendChat: async () => ({}) },
    log: () => {},
  });
  return { engine, sent, controls, notes };
}

const follow = (id, user) => ({ id, type: 'follow', text: user, sub: '', vars: { user }, actions: [] });
const gift = (id, user, amount, tier = 1) => ({
  id, type: 'giftsub', text: user, sub: `regala ${amount} subs`,
  vars: { user, amount, tier }, actions: [{ kind: 'meld', command: `scene:${user}` }],
});

test('el tope por defecto existe y es 20; 0 significa sin tope', () => {
  assert.equal(DEFAULT_CONFIG.overlay.queueMax, 20, 'falta overlay.queueMax en DEFAULT_CONFIG');
});

test('sin tope (0) el comportamiento no cambia: la cola crece sin descartes ni notas', async () => {
  const { engine, controls, notes } = makeEngine({ config: { overlay: { queueMax: 0 } } });
  for (let i = 0; i < 30; i++) engine.send(follow('f' + i, 'u' + i));
  assert.equal(engine.queuedAlerts.size, 30, 'sin tope la cola no se recorta');
  assert.equal(controls.filter(c => c.action === 'drop').length, 0, 'sin tope no hay descartes');
  assert.equal(notes.length, 0, 'sin tope no hay notas de política');
});

test('con 120 alertas y tope 20, la cola nunca pasa del tope y las más antiguas se descartan', async () => {
  const { engine, controls, notes } = makeEngine({ config: { overlay: { queueMax: 20 } } });
  for (let i = 0; i < 120; i++) engine.send(follow('f' + i, 'u' + i));
  await engine.flushQueueNotes();
  assert.equal(engine.queuedAlerts.size, 20, 'la cola excede el tope');
  assert.ok(!engine.queuedAlerts.has('f0') && engine.queuedAlerts.has('f119'), 'no se conservan las más nuevas y se descartan las antiguas');
  const drops = controls.filter(c => c.action === 'drop');
  assert.ok(drops.length, 'el overlay no recibe el control de descarte');
  const droppedIds = drops.flatMap(c => c.ids);
  assert.equal(droppedIds.length, 100, 'el recuento de descartadas no cuadra');
  assert.ok(droppedIds.includes('f0') && droppedIds.includes('f99') && !droppedIds.includes('f119'), 'las descartadas no son las más antiguas');
  // las descartadas no dejan acciones ni fallback pendientes
  for (const id of droppedIds) {
    assert.ok(!engine.pendingActions.has(id), 'queda una acción pendiente de una alerta descartada');
    assert.ok(!engine.fallbackTimers.has(id), 'queda un fallback de una alerta descartada');
  }
  const note = notes.find(n => n.kind === 'queue');
  assert.ok(note, 'el descarte no queda registrado en la cronología');
  assert.equal(note.dropped, 100, 'la nota no recuenta las descartadas');
});

test('los regalos del mismo tipo y mismo «de» pendientes se agrupan sumando el amount', async () => {
  const { engine, sent } = makeEngine({ config: { overlay: { queueMax: 20 } } });
  engine.send(gift('g1', 'ana', 5));
  engine.send(gift('g2', 'ana', 3));
  assert.equal(engine.queuedAlerts.size, 1, 'la ráfaga de regalos no se agrupó');
  const merged = sent.find(a => a.merged);
  assert.ok(merged, 'el overlay no recibe la actualización de la alerta agrupada');
  assert.equal(merged.id, 'g1', 'la fusión debe actualizar la alerta ya en cola');
  assert.equal(merged.vars.amount, 8, 'el amount no se suma');
  assert.equal(merged.sub, 'regala 8 subs', 'el texto agrupado no se vuelve a calcular');
  assert.ok(!engine.queuedAlerts.has('g2'), 'la alerta fusionada no debe quedar en cola');
});

test('la acción del lote se ejecuta una sola vez al mostrarse la agrupada', async () => {
  const { engine } = makeEngine({ config: { overlay: { queueMax: 20 } } });
  const runs = [];
  engine.runActions = async actions => { for (const a of actions) runs.push(a.command); };
  engine.send(gift('g1', 'ana', 5));
  engine.send(gift('g2', 'ana', 3));      // misma acción idéntica: no se duplica
  engine.send(gift('g3', 'ana', 2));
  engine.alertShown('g1');
  await flush();
  assert.deepEqual(runs, ['scene:ana'], 'la acción del lote no se ejecuta exactamente una vez');
  assert.ok(!engine.pendingActions.has('g2') && !engine.pendingActions.has('g3'), 'las alertas fusionadas no dejan ciclo pendiente');
});

test('una alerta ya mostrada (ACK) nunca se fusiona ni se descarta', async () => {
  const { engine, sent } = makeEngine({ config: { overlay: { queueMax: 20 } } });
  engine.send(gift('g1', 'ana', 5));
  engine.alertShown('g1');                // el overlay la está viendo: ACK recibido
  engine.send(gift('g2', 'ana', 3));
  assert.equal(engine.queuedAlerts.size, 1, 'la segunda debe entrar como alerta propia');
  assert.ok(!sent.some(a => a.merged), 'se fusionó con una alerta ya mostrada');
  // tampoco se descarta: con tope 1 y dos pendientes, la descartada es la primera en cola, no la mostrada
  const { engine: e2 } = makeEngine({ config: { overlay: { queueMax: 1 } } });
  e2.send(follow('f0', 'a0'));
  e2.send(follow('f1', 'a1'));
  assert.deepEqual([...e2.queuedAlerts.keys()], ['f1'], 'el descarte no respeta el orden de la cola');
});

test('distinto donante, tipo o tier no se agrupan', () => {
  const { engine } = makeEngine({ config: { overlay: { queueMax: 20 } } });
  engine.send(gift('g1', 'ana', 5));
  engine.send(gift('g2', 'beto', 3));
  engine.send(gift('g3', 'ana', 2, 2));
  assert.equal(engine.queuedAlerts.size, 3, 'se agruparon alertas que no son del mismo lote');
});

test('sin overlay conectado el ACK es inmediato (alertas con acciones) y no hay descartes', () => {
  const { engine, controls } = makeEngine({ overlay: 0, config: { overlay: { queueMax: 20 } } });
  engine.runActions = async () => {};
  for (let i = 0; i < 40; i++) engine.send({ ...follow('f' + i, 'u' + i), actions: [{ kind: 'meld', command: 'x' }] });
  assert.equal(engine.queuedAlerts.size, 0, 'con ACK inmediato la cola de entrega no retiene nada');
  assert.equal(controls.filter(c => c.action === 'drop').length, 0, 'sin overlay no puede haber descartes');
});
