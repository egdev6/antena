// Test de src/routes/sessions.mjs (#107): rutas /api/session*, /api/sessions y
// /api/timeline* extraídas de server.mjs sin cambio de comportamiento. No arranca
// la app: construye un ctx falso y llama a los handlers igual que el dispatcher
// (con vars si el patrón tiene :vars, y (body, null, url) si no).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSessionRoutes } from '../src/routes/sessions.mjs';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ctx falso con las mismas piezas que createApp pasa por ctx.
function fakeCtx() {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const notes = [
    { id: 'n1', kind: 'saved', text: 'sub de ana', user: 'ana' },
    { id: 'n2', kind: 'marker', label: 'm' },
    { id: 'n3', kind: 'event', type: 'raid' },
  ];
  const session = {
    data: { id: 's1', title: 'Directo', startedAt: '2026-01-01T00:00:00Z', events: [{ id: 'e1' }, { id: 'e2' }] },
    timeline: () => [...notes],
    pendingThanks: () => 2,
    addNote: n => { const note = { id: 'n' + (notes.length + 1), ...n }; notes.push(note); return note; },
    updateNote: (id, patch) => { const n = notes.find(x => x.id === id); if (!n) throw httpError(404, 'No existe'); return Object.assign(n, patch); },
    removeNote: id => { const i = notes.findIndex(x => x.id === id); if (i < 0) throw httpError(404, 'No existe'); notes.splice(i, 1); },
    setThanked: (id, v) => ({ id, thanked: v }),
    startNew: async title => ({ id: 's2', title }),
    list: async () => [{ id: 's0' }],
    get: async id => { if (id === 's0') return { id }; throw httpError(404, 'No existe ese directo'); },
    totals: () => ({ follows: 3 }),
    credits: () => ({ follows: 1 }),
    summaryMarkdown: () => '# resumen',
    latest: () => ({ last: true }),
    save: () => { session.saved = (session.saved || 0) + 1; },
  };
  const ctx = {
    route,
    session,
    timelinePayload: () => ({ items: session.timeline(), pending: session.pendingThanks(), startedAt: session.data.startedAt, title: session.data.title }),
    addMarker: async label => { ctx._spies.markers.push(label); return { id: 'mk', kind: 'marker', label }; },
    _spies: { notes, session, markers: [] },
  };
  registerSessionRoutes(ctx);
  const find = (method, p) => {
    const r = routes.find(x => x.method === method && x.re.test(p));
    assert.ok(r, `${method} ${p} registrada`);
    return { vars: p.match(r.re).groups, fn: r.fn };
  };
  const url = q => new URL('http://x/' + (q || ''));
  return { ctx, find, url };
}

test('GET /api/session: datos sin events, con eventCount, totals y latest', async () => {
  const { find } = fakeCtx();
  const out = await find('GET', '/api/session').fn({}, null, null, {});
  assert.equal(out.id, 's1');
  assert.equal(out.events, undefined);
  assert.equal(out.eventCount, 2);
  assert.deepEqual(out.totals, { follows: 3 });
});

test('GET /api/session/events: límite por defecto 500, acotado a 1000 y capped', async () => {
  const { find, url } = fakeCtx();
  const porDefecto = await find('GET', '/api/session/events').fn({}, null, url('api/session/events'), {});
  assert.deepEqual([porDefecto.limit, porDefecto.total, porDefecto.capped], [500, 2, false]);
  const acotada = await find('GET', '/api/session/events').fn({}, null, url('api/session/events?limit=3'), {});
  assert.equal(acotada.limit, 3);
  const cero = await find('GET', '/api/session/events').fn({}, null, url('api/session/events?limit=0'), {});
  assert.deepEqual([cero.limit, cero.capped], [500, false]);
  const mucha = await find('GET', '/api/session/events').fn({}, null, url('api/session/events?limit=9999'), {});
  assert.deepEqual([mucha.limit, mucha.capped], [1000, true]);
});

test('GET /api/session/summary: json con totals y credits, texto con markdown; 404 si no existe', async () => {
  const { find, url } = fakeCtx();
  const json = await find('GET', '/api/session/summary').fn({}, null, url('api/session/summary?format=json&id=s0'), {});
  assert.deepEqual(json, { id: 's0', totals: { follows: 3 }, credits: { follows: 1 } });
  const md = await find('GET', '/api/session/summary').fn({}, null, url('api/session/summary?id=s0'), {});
  assert.deepEqual(md, { markdown: '# resumen' });
  await assert.rejects(find('GET', '/api/session/summary').fn({}, null, url('api/session/summary?id=zz'), {}), /No existe ese directo/);
});

test('POST /api/session/new y PUT /api/session', async () => {
  const { ctx, find } = fakeCtx();
  const nueva = await find('POST', '/api/session/new').fn({ title: 'Nuevo' });
  assert.deepEqual(nueva, { session: { id: 's2', title: 'Nuevo' } });
  await find('PUT', '/api/session').fn({ title: 'Otro' });
  assert.equal(ctx.session.data.title, 'Otro');
  // sin título: cadena vacía, no undefined
  await find('PUT', '/api/session').fn({});
  assert.equal(ctx.session.data.title, '');
  assert.ok(ctx.session.saved >= 2); // PUT guarda siempre
});

test('GET /api/sessions: actual y pasadas', async () => {
  const { find } = fakeCtx();
  const out = await find('GET', '/api/sessions').fn();
  assert.deepEqual(out.current, { id: 's1', title: 'Directo', startedAt: '2026-01-01T00:00:00Z', events: 2 });
  assert.deepEqual(out.past, [{ id: 's0' }]);
});

test('GET /api/timeline: payload completo; con kinds filtra y respeta el tope', async () => {
  const { find, url } = fakeCtx();
  const todo = await find('GET', '/api/timeline').fn({}, null, url('api/timeline'), {});
  assert.equal(todo.pending, 2);
  assert.equal(todo.items.length, 3);
  const filtrada = await find('GET', '/api/timeline').fn({}, null, url('api/timeline?kinds=marker,raid'), {});
  assert.deepEqual(filtrada.items.map(i => i.id), ['n2', 'n3']);
  assert.deepEqual([filtrada.limit, filtrada.capped], [300, false]);
});

test('POST /api/timeline: addNote; marker pasa por addMarker; kind desconocido 400', async () => {
  const { ctx, find } = fakeCtx();
  const nota = await find('POST', '/api/timeline').fn({ kind: 'saved', text: 'hola', user: 'ana' });
  assert.equal(nota.note.text, 'hola');
  const marca = await find('POST', '/api/timeline').fn({ kind: 'marker', label: 'punto' });
  assert.deepEqual(marca, { note: { id: 'mk', kind: 'marker', label: 'punto' } });
  // marker sin label usa el texto
  await find('POST', '/api/timeline').fn({ kind: 'marker', text: 'desde texto' });
  await assert.rejects(find('POST', '/api/timeline').fn({ kind: 'raro' }), /Tipo desconocido\. Tipos: /);
  assert.deepEqual(ctx._spies.markers, ['punto', 'desde texto']);
});

test('PUT, POST done y DELETE /api/timeline/:id', async () => {
  const { ctx, find } = fakeCtx();
  const editada = await find('PUT', '/api/timeline/n1').fn({ id: 'n1' }, { text: 'editada' });
  assert.equal(editada.note.text, 'editada');
  const done = await find('POST', '/api/timeline/n1/done').fn({ id: 'n1' }, {});
  assert.deepEqual(done, { id: 'n1', done: true });
  await find('DELETE', '/api/timeline/n1').fn({ id: 'n1' });
  assert.ok(!ctx._spies.notes.some(n => n.id === 'n1'));
  await assert.rejects(find('PUT', '/api/timeline/zz').fn({ id: 'zz' }, {}), /No existe/);
  // done:false se refleja como done:false
  const undone = await find('POST', '/api/timeline/n2/done').fn({ id: 'n2' }, { value: false });
  assert.equal(undone.done, false);
});

test('POST /api/markers', async () => {
  const { find } = fakeCtx();
  const out = await find('POST', '/api/markers').fn({ label: 'inicio' });
  assert.deepEqual(out, { marker: { id: 'mk', kind: 'marker', label: 'inicio' } });
  const vacio = await find('POST', '/api/markers').fn({});
  assert.deepEqual(vacio, { marker: { id: 'mk', kind: 'marker', label: '' } });
});
