// Test del módulo src/routes/interactive.mjs (tercer corte de #119): preguntas,
// tier lists, votación y sorteo (/api/interactive*, /api/questions*, /api/tierlists*,
// /api/vote*, /api/giveaway*). No arranca la app: construye un ctx falso y llama a
// los handlers igual que el dispatcher de server.mjs (con vars si el patrón tiene
// :vars, y (body, null) si no).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerInteractiveRoutes } from '../src/routes/interactive.mjs';

// ctx falso con las mismas piezas que createApp pasa por ctx.
function fakeCtx() {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const calls = [];
  const I = {
    s: { tierlists: ['t1'] },
    snapshot: () => ({ questions: [], shown: null }),
    addQuestion: q => { calls.push(['addQuestion', q]); return q; },
    showQuestion: id => { calls.push(['showQuestion', id]); return { id: id ?? 'siguiente' }; },
    hideQuestion: () => calls.push(['hideQuestion']),
    clearQuestions: o => calls.push(['clearQuestions', o]),
    setQuestionStatus: (id, status) => { calls.push(['setQuestionStatus', id, status]); return { id, status }; },
    moveQuestion: (id, dir) => { calls.push(['moveQuestion', id, dir]); return { id, dir }; },
    createTierlist: body => { calls.push(['createTierlist', body]); return { id: 't-nueva', ...body }; },
    updateTierlist: (id, body) => { calls.push(['updateTierlist', id, body]); return { id, ...body }; },
    deleteTierlist: id => calls.push(['deleteTierlist', id]),
    addItem: (id, x) => { calls.push(['addItem', id, x]); return { id, ...x }; },
    updateItem: (id, item, body) => { calls.push(['updateItem', id, item, body]); return { id, item, ...body }; },
    removeItem: (id, item) => calls.push(['removeItem', id, item]),
    place: (id, item, tier) => calls.push(['place', id, item, tier]),
    resetPlacements: id => calls.push(['resetPlacements', id]),
    showTierlist: id => { calls.push(['showTierlist', id]); I.s.shownTierlist = id; },
    startVote: (id, item, seconds) => { calls.push(['startVote', id, item, seconds]); return { id, item, seconds }; },
    closeVote: o => { calls.push(['closeVote', o]); return { o }; },
    cancelVote: () => calls.push(['cancelVote']),
    giveawayState: () => ({ open: !!I._giveawayOpen }),
    openGiveaway: o => { calls.push(['openGiveaway', o]); I._giveawayOpen = true; return { opened: true, o }; },
    closeGiveaway: () => { calls.push(['closeGiveaway']); I._giveawayOpen = false; return { closed: true }; },
    draw: () => { calls.push(['draw']); return { winner: 'ana' }; },
    join: o => { calls.push(['join', o]); return true; },
    removeEntry: user => calls.push(['removeEntry', user]),
    resetGiveaway: () => { calls.push(['resetGiveaway']); I._giveawayOpen = false; },
    emit: (...a) => calls.push(['emit', ...a]),
  };
  const ctx = {
    route,
    store: { config: { interactive: { questions: { max: 5 }, keep: 1 } }, save: async k => calls.push(['save', k]) },
    interactive: I,
    _spies: { calls },
  };
  registerInteractiveRoutes(ctx);
  const find = (method, path) => {
    const r = routes.find(x => x.method === method && x.re.test(path));
    assert.ok(r, `${method} ${path} registrada`);
    return { vars: path.match(r.re).groups, fn: r.fn };
  };
  return { ctx, routes, find };
}

test('registra las rutas de interactivos en el orden original', () => {
  const { routes } = fakeCtx();
  assert.deepEqual(routes.map(r => `${r.method} ${r.pattern}`), [
    'GET /api/interactive', 'PUT /api/interactive/config',
    'POST /api/questions', 'POST /api/questions/show', 'POST /api/questions/next',
    'POST /api/questions/hide', 'POST /api/questions/clear',
    'POST /api/questions/:id/status', 'POST /api/questions/:id/move',
    'POST /api/tierlists', 'PUT /api/tierlists/:id', 'DELETE /api/tierlists/:id',
    'POST /api/tierlists/:id/items', 'PUT /api/tierlists/:id/items/:item',
    'DELETE /api/tierlists/:id/items/:item', 'POST /api/tierlists/:id/place',
    'POST /api/tierlists/:id/reset', 'POST /api/tierlists/:id/show',
    'POST /api/tierlists/hide', 'POST /api/tierlists/:id/vote',
    'POST /api/vote/close', 'POST /api/vote/cancel',
    'GET /api/giveaway', 'POST /api/giveaway/open', 'POST /api/giveaway/close',
    'POST /api/giveaway/draw', 'POST /api/giveaway/join',
    'POST /api/giveaway/remove', 'POST /api/giveaway/reset',
  ]);
});

test('GET /api/interactive y PUT /api/interactive/config: filtrado de claves y evento change', async () => {
  const { ctx, find } = fakeCtx();
  assert.deepEqual(await find('GET', '/api/interactive').fn(null, null, null, null), { questions: [], shown: null });
  const out = await find('PUT', '/api/interactive/config').fn({ questions: { max: 9 }, giveaway: { prize: 'x' }, intruso: 1 });
  assert.deepEqual(ctx.store.config.interactive, { questions: { max: 9 }, keep: 1, giveaway: { prize: 'x' } });
  assert.equal(out, ctx.store.config.interactive);
  assert.deepEqual(ctx._spies.calls.slice(-2), [['save', 'interactive'], ['emit', 'change', 'config']]);
});

test('preguntas: alta con usuario por defecto, show/next/hide/clear y estado/movimiento con :vars', async () => {
  const { find } = fakeCtx();
  assert.deepEqual((await find('POST', '/api/questions').fn({ text: 'hola' })).question, { user: 'Tú', text: 'hola', platform: 'manual' });
  assert.deepEqual((await find('POST', '/api/questions').fn({ user: 'ana', text: 'x', platform: 'twitch' })).question, { user: 'ana', text: 'x', platform: 'twitch' });
  assert.deepEqual((await find('POST', '/api/questions/show').fn({ id: 'q1' })).question, { id: 'q1' });
  assert.deepEqual((await find('POST', '/api/questions/next').fn()).question, { id: 'siguiente' });
  assert.deepEqual(await find('POST', '/api/questions/hide').fn(), { ok: true });
  assert.deepEqual(await find('POST', '/api/questions/clear').fn({ all: true }), []);
  assert.deepEqual((await find('POST', '/api/questions/q1/status').fn({ id: 'q1' }, { status: 'done' })).question, { id: 'q1', status: 'done' });
  assert.deepEqual((await find('POST', '/api/questions/q2/move').fn({ id: 'q2' }, {})).question, { id: 'q2', dir: -1 });
});

test('tier lists: CRUD, items en lote, place/reset/show/hide y votación', async () => {
  const { find } = fakeCtx();
  assert.deepEqual((await find('POST', '/api/tierlists').fn({ title: 'Juegos' })).tierlist, { id: 't-nueva', title: 'Juegos' });
  assert.deepEqual((await find('PUT', '/api/tierlists/t1').fn({ id: 't1' }, { title: 'Nueva' })).tierlist, { id: 't1', title: 'Nueva' });
  await find('DELETE', '/api/tierlists/t1').fn({ id: 't1' });
  assert.deepEqual((await find('POST', '/api/tierlists/t1/items').fn({ id: 't1' }, { items: ['a', { label: 'b' }] })).items, [{ id: 't1', label: 'a' }, { id: 't1', label: 'b' }]);
  assert.deepEqual((await find('POST', '/api/tierlists/t1/items').fn({ id: 't1' }, { label: 'solo' })).items, [{ id: 't1', label: 'solo' }]);
  assert.deepEqual((await find('PUT', '/api/tierlists/t1/items/i1').fn({ id: 't1', item: 'i1' }, { label: 'z' })).item, { id: 't1', item: 'i1', label: 'z' });
  await find('DELETE', '/api/tierlists/t1/items/i1').fn({ id: 't1', item: 'i1' });
  await find('POST', '/api/tierlists/t1/place').fn({ id: 't1' }, { item: 'i1', tier: 'S' });
  await find('POST', '/api/tierlists/t1/reset').fn({ id: 't1' });
  assert.deepEqual(await find('POST', '/api/tierlists/t1/show').fn({ id: 't1' }), { shown: 't1' });
  assert.deepEqual(await find('POST', '/api/tierlists/hide').fn(), { shown: null });
  assert.deepEqual((await find('POST', '/api/tierlists/t1/vote').fn({ id: 't1' }, { item: 'i1', seconds: 30 })).vote, { id: 't1', item: 'i1', seconds: 30 });
  assert.deepEqual((await find('POST', '/api/vote/close').fn({ apply: false })).result, { o: { apply: false } });
  assert.deepEqual((await find('POST', '/api/vote/close').fn()).result, { o: { apply: true } });
  assert.deepEqual(await find('POST', '/api/vote/cancel').fn(), { ok: true });
});

test('sorteo: estado, open/close/draw/join/remove/reset', async () => {
  const { find } = fakeCtx();
  assert.deepEqual(await find('GET', '/api/giveaway').fn(), { open: false });
  assert.deepEqual(await find('POST', '/api/giveaway/open').fn({ reset: true }), { opened: true, o: { reset: true } });
  assert.deepEqual(await find('GET', '/api/giveaway').fn(), { open: true });
  await find('POST', '/api/giveaway/close').fn();
  assert.deepEqual(await find('POST', '/api/giveaway/draw').fn(), { winner: 'ana' });
  assert.deepEqual(await find('POST', '/api/giveaway/join').fn({ user: 'ana', member: 1 }), { added: true });
  assert.deepEqual(await find('POST', '/api/giveaway/join').fn({ user: 'luis' }), { added: true });
  await find('POST', '/api/giveaway/remove').fn({ user: 'ana' });
  assert.deepEqual(await find('POST', '/api/giveaway/reset').fn(), { open: false });
});
