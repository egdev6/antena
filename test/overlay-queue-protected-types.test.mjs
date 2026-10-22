// #94: los raids y los Super Chats (y Super Stickers) nunca se descartan ni se fusionan
// en la cola del overlay. Decisión del mantenedor sobre la política de #66.
// Si la cola solo tiene alertas protegidas por encima del tope, se muestran todas
// (se supera el tope) y el panel lo indica con una nota de cronología kind «queue».
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guardas instaladas ANTES del import dinámico y mantenidas hasta el final del proceso.
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket externo prohibido'); } };
globalThis.fetch = () => { throw new Error('fetch externo prohibido'); };

const { Engine } = await import('../src/engine.mjs');

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function makeEngine({ overlay = 1, config = {} } = {}) {
  const sent = [];
  const controls = [];
  const notes = [];
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
      }, patchConfig: async () => {},
    },
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

const raid = (id, user, viewers) => ({ id, type: 'raid', text: user, sub: `llega con ${viewers} personas`, vars: { user, amount: viewers }, actions: [] });
const superchat = (id, user, amountText, message) => ({ id, type: 'superchat', text: user, sub: `${amountText} · ${message}`, vars: { user, amount: 500, amountText, message }, actions: [] });
const supersticker = (id, user, amountText) => ({ id, type: 'supersticker', text: user, sub: amountText, vars: { user, amountText }, actions: [] });
const follow = (id, user) => ({ id, type: 'follow', text: user, sub: '', vars: { user }, actions: [] });

test('RED (#94): con la política de #66 un raid entra en el descarte por tope', () => {
  const { engine, controls } = makeEngine({ config: { overlay: { queueMax: 3 } } });
  engine.send(follow('f0', 'a0'));
  engine.send(follow('f1', 'a1'));
  engine.send(follow('f2', 'a2'));
  engine.send(raid('r0', 'midudev', 120));   // el tope 3 obliga a descartar: hoy elige f0, el más antiguo
  const dropped = controls.filter(c => c.action === 'drop').flatMap(c => c.ids);
  // RED esperado tras #94: r0 nunca puede ser descartado. Hoy (solo #66) r0 entra en la cola
  // y el descarte recae en f0; este test fija el comportamiento nuevo, así que falla si algún
  // día un raid vuelve a ser descartable.
  assert.ok(!dropped.includes('r0'), 'un raid no puede descartarse nunca');
  assert.deepEqual([...engine.queuedAlerts.keys()].sort(), ['f1', 'f2', 'r0'], 'la cola tras el descarte no es la esperada');
});

test('los raid, superchat y supersticker nunca se descartan: se descartan otros tipos', async () => {
  const { engine, controls, notes } = makeEngine({ config: { overlay: { queueMax: 5 } } });
  engine.send(follow('f0', 'a0'));
  engine.send(follow('f1', 'a1'));
  engine.send(follow('f2', 'a2'));
  engine.send(raid('r0', 'midudev', 120));
  engine.send(superchat('sc0', 'Carlos', '5,00 €', '¡Gracias!'));
  engine.send(supersticker('ss0', 'Marta', '2,00 €'));
  engine.send(follow('f3', 'a3'));
  engine.send(follow('f4', 'a4'));
  await engine.flushQueueNotes();
  const dropped = controls.filter(c => c.action === 'drop').flatMap(c => c.ids);
  const keys = [...engine.queuedAlerts.keys()];
  assert.ok(!dropped.includes('r0') && !dropped.includes('sc0') && !dropped.includes('ss0'), 'una alerta protegida fue descartada');
  for (const id of ['r0', 'sc0', 'ss0']) assert.ok(keys.includes(id), `falta la protegida ${id} en la cola`);
  assert.equal(keys.length, 5, 'el tope se respeta con las protegidas dentro de la cola');
  assert.deepEqual(dropped, ['f0', 'f1', 'f2'], 'el recorte no recae en las más antiguas normales');
  // las descartadas limpian sus acciones y fallback igual que en #66
  for (const id of dropped) {
    assert.ok(!engine.pendingActions.has(id), 'queda una acción pendiente de una descartada');
    assert.ok(!engine.fallbackTimers.has(id), 'queda un fallback de una descartada');
  }
  const note = notes.find(n => n.kind === 'queue');
  assert.ok(note, 'el descarte no quedó registrado en la cronología');
});

test('solo hay alertas protegidas por encima del tope: se muestran todas y el panel lo indica', async () => {
  const { engine, controls, notes } = makeEngine({ config: { overlay: { queueMax: 2 } } });
  for (let i = 0; i < 5; i++) engine.send(raid('r' + i, 'u' + i, 10));
  await engine.flushQueueNotes();
  assert.equal(engine.queuedAlerts.size, 5, 'las protegidas no pueden recortarse aunque se supere el tope');
  assert.equal(controls.filter(c => c.action === 'drop').length, 0, 'no puede haber descarte de protegidas');
  const note = notes.find(n => n.kind === 'queue');
  assert.ok(note, 'superar el tope sin recorte debe avisar al panel');
  assert.ok(note.text.includes('tope'), 'la nota no explica la causa');
});

test('un raid o un Super Chat nunca se fusiona (y los regalos siguen agrupándose)', () => {
  const { engine, sent } = makeEngine({ config: { overlay: { queueMax: 20 } } });
  engine.send(raid('r0', 'ana', 10));
  engine.send(raid('r1', 'ana', 5));            // mismo donante: no se fusiona
  engine.send(superchat('sc0', 'ana', '5,00 €', 'hola'));
  engine.send(superchat('sc1', 'ana', '3,00 €', 'otra'));
  assert.ok(!sent.some(a => a.merged), 'una alerta protegida se fusionó');
  assert.equal(engine.queuedAlerts.size, 4, 'las protegidas deben entrar como alertas propias');
  engine.send({ id: 'g1', type: 'giftsub', text: 'beto', sub: 'regala 5 subs', vars: { user: 'beto', amount: 5, tier: 1 }, actions: [{ kind: 'meld', command: 'x' }] });
  engine.send({ id: 'g2', type: 'giftsub', text: 'beto', sub: 'regala 3 subs', vars: { user: 'beto', amount: 3, tier: 1 }, actions: [{ kind: 'meld', command: 'x' }] });
  assert.ok(sent.some(a => a.merged), 'la agrupación de regalos de #66 dejó de funcionar');
  assert.equal(engine.queuedAlerts.size, 5, 'el regalo no se agrupó');
});

test('sin ráfaga el comportamiento de #66 no cambia: tipos normales se descartan igual', async () => {
  const { engine, controls, notes } = makeEngine({ config: { overlay: { queueMax: 3 } } });
  for (let i = 0; i < 30; i++) engine.send(follow('f' + i, 'u' + i));
  await engine.flushQueueNotes();
  const dropped = controls.filter(c => c.action === 'drop').flatMap(c => c.ids);
  assert.equal(engine.queuedAlerts.size, 3, 'el tope se aplica igual a los tipos normales');
  assert.equal(dropped.length, 27, 'el recuento de descartes cambió respecto a #66');
  assert.ok(dropped.includes('f0') && dropped.includes('f26') && !dropped.includes('f29'), 'ya no se descartan las más antiguas');
  assert.ok(notes.find(n => n.kind === 'queue'), 'la nota de cronología de #66 desapareció');
});

test('el flush de la nota de tope superado no deja recuento huérfano', async () => {
  const { engine, notes } = makeEngine({ config: { overlay: { queueMax: 2 } } });
  for (let i = 0; i < 4; i++) engine.send(raid('r' + i, 'u' + i, 10));
  await engine.flushQueueNotes();
  await engine.flushQueueNotes();               // segundo flush: no debe crear notas vacías
  assert.equal(notes.filter(n => n.kind === 'queue').length, 1, 'cada flush crea notas repetidas');
});

test('el exceso de protegidas se volca como máximo de la ventana, no como suma acumulada (#94)', async () => {
  const { engine, notes } = makeEngine({ config: { overlay: { queueMax: 2 } } });
  // 5 protegidas una a una: el exceso real es 3 al volcarse, nunca 1+2+3 = 6
  for (let i = 0; i < 5; i++) engine.send(raid('r' + i, 'u' + i, 10));
  await engine.flushQueueNotes();
  const note = notes.find(n => n.kind === 'queue');
  assert.equal(note.overflow, 3, 'el overflow acumulado no es el exceso real');
});
