// Test del módulo src/routes/shortcuts.mjs (primer corte de #71): fuentes de Meld,
// atajos personalizados y atajos /sd/*. No arranca la app: construye un ctx falso y
// llama a los handlers igual que el dispatcher de server.mjs (con vars si el patrón
// tiene :vars, y (body, null) si no).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerShortcutRoutes } from '../src/routes/shortcuts.mjs';

// S10: el prompter ofrece dos pestañas; las retiradas (tierlist, sorteo) se siguen aceptando
// en los atajos guardados y se ejecutan como no-op.
const PROMPTER_TABS = ['cronologia', 'preguntas'];
const PROMPTER_LEGACY_TABS = ['tierlist', 'sorteo'];
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ctx falso con las mismas piezas que createApp pasa por ctx.
function fakeCtx() {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const said = [], prompts = [], markers = [], sent = [];
  const engineActions = [];
  const ctx = {
    route,
    store: { config: { shortcuts: [], widgets: { goals: [{ id: 'principal', title: 'Seguidores' }] }, prompter: { theme: 'claro' } }, patchConfig: async p => { Object.assign(ctx.store.config, p); } },
    engine: {
      pauseState: () => ({ paused: !!ctx.engine.paused }),
      paused: false,
      pause: async () => { ctx.engine.paused = true; },
      resume: async () => { ctx.engine.paused = false; return { ok: true }; },
      runActions: async actions => { for (const st of actions) { if (st.kind === 'say') said.push(st.text); else if (st.kind === 'chat') throw new Error('chat apagado'); else engineActions.push(st); } },
      say: t => { said.push(t); return { ok: true }; },
    },
    session: { data: { events: [{ id: 'e1', user: 'ana', thanked: false }], }, setThanked: (id, v) => ({ id, thanked: v }), pendingThanks: () => 0 },
    interactive: {
      showQuestion: () => ({ q: 1 }), hideQuestion: () => {}, closeVote: o => ({ r: 'vote', o }),
      openGiveaway: o => ({ g: 'open', o }), closeGiveaway: () => ({ g: 'closed' }), draw: () => ({ g: 'winner' }),
    },
    bus: { send: (ch, m, to) => sent.push([ch, m, to]) },
    setPrompterTab: t => {
      if (PROMPTER_LEGACY_TABS.includes(t)) { prompts.push(t); return ctx._spies.prompter; }
      if (!PROMPTER_TABS.includes(t)) throw httpError(400, `Pestaña desconocida: ${t}. Pestañas: ${PROMPTER_TABS.join(', ')}`);
      ctx._spies.prompter = { tab: t }; prompts.push(t); return ctx._spies.prompter;
    },
    addMarker: async label => { markers.push(label); return { marker: label }; },
    id8: (() => { let n = 0; return () => 'id' + (++n); })(),
    checkActions: actions => { for (const a of actions) if (!(a.kind === 'say' && a.text) && !(a.kind === 'chat' && a.text)) throw httpError(400, 'Acción no válida'); },
    httpError,
    PROMPTER_TABS,
    _spies: { said, prompts, markers, sent, engineActions, prompter: { tab: 'cronologia' } },
  };
  registerShortcutRoutes(ctx);
  const find = (method, path) => {
    const r = routes.find(x => x.method === method && x.re.test(path));
    assert.ok(r, `${method} ${path} registrada`);
    return { vars: path.match(r.re).groups, fn: r.fn };
  };
  return { ctx, find };
}

const fakeReq = port => ({ socket: { localPort: port } });

test('GET /api/sources: capas con URL, objetivos intercalados y paneles', async () => {
  const { find } = fakeCtx();
  const out = await find('GET', '/api/sources').fn(null, null, null, fakeReq(4500));
  assert.equal(out.base, 'http://127.0.0.1:4500');
  const ids = out.sources.map(x => x.id);
  // los objetivos van entre chat y latest, como en el original
  assert.deepEqual(ids, ['overlay', 'chat', 'goal-principal', 'latest', 'ticker', 'credits', 'question', 'tierlist', 'giveaway', 'viewers']);
  const ov = out.sources.find(x => x.id === 'overlay');
  assert.deepEqual([ov.url, ov.width, ov.height], ['http://127.0.0.1:4500/overlay', 1920, 1080]);
  const goal = out.sources.find(x => x.id === 'goal-principal');
  assert.deepEqual([goal.name, goal.width, goal.height], ['Objetivo · Seguidores', 1000, 210]);
  assert.deepEqual(out.panels.map(p => p.id), ['dock', 'prompter', 'teleprompter']);
  assert.equal(out.panels[1].width, 1024);
});

test('#129: fuentes recomienda altura por barras visibles, sin alterar otras fuentes', async () => {
  const { ctx, find } = fakeCtx();
  const sources = () => find('GET', '/api/sources').fn(null, null, null, fakeReq(4500));
  const original = await sources();
  for (const [visible, bars, height] of [
    [true, [], 210],
    [true, [{}], 270],
    [true, [{}, {}, {}], 390],
    [true, [{}, { visible: false }, { visible: true }], 330],
    [true, [{ visible: false }], 210],
    [false, [{}, {}], 210],
  ]) {
    ctx.store.config.widgets.goals = [{ id: 'a b', title: 'Caja', visible, bars }];
    const out = await sources();
    const goal = out.sources.find(s => s.id === 'goal-a b');
    assert.deepEqual(goal, {
      id: 'goal-a b', name: 'Objetivo · Caja', path: '/widget/goal?id=a%20b',
      width: 1000, height, url: 'http://127.0.0.1:4500/widget/goal?id=a%20b',
    });
    assert.deepEqual(out.sources.filter(s => !s.id.startsWith('goal-')), original.sources.filter(s => !s.id.startsWith('goal-')));
    assert.deepEqual(out.panels, original.panels);
  }
});

test('POST /api/shortcuts: crea atajo, valida steps y genera id', async () => {
  const { ctx, find } = fakeCtx();
  const out = await find('POST', '/api/shortcuts').fn({ name: '  Momento top  ', color: '#ff0000', steps: [{ kind: 'builtin', action: 'prompter', arg: 'preguntas' }, { kind: 'say', text: 'hola' }] });
  assert.ok(ctx.store.config.shortcuts[0].id.startsWith('id'));
  assert.equal(ctx.store.config.shortcuts[0].name, 'Momento top');
  assert.deepEqual(ctx.store.config.shortcuts[0].steps, [{ kind: 'builtin', action: 'prompter', arg: 'preguntas' }, { kind: 'say', text: 'hola' }]);
  assert.equal(out.shortcut.id, ctx.store.config.shortcuts[0].id);
  await assert.rejects(find('POST', '/api/shortcuts').fn({}), /Falta el nombre/);
  await assert.rejects(find('POST', '/api/shortcuts').fn({ name: 'x', steps: 'no' }), /lista/);
  await assert.rejects(find('POST', '/api/shortcuts').fn({ name: 'x', steps: Array.from({ length: 21 }, () => ({ kind: 'chat', text: 'a' })) }), /20 pasos/);
  await assert.rejects(find('POST', '/api/shortcuts').fn({ name: 'x', steps: [{ kind: 'builtin', action: 'no-existe' }] }), /Acción desconocida/);
  await assert.rejects(find('POST', '/api/shortcuts').fn({ name: 'x', steps: [{ kind: 'builtin', action: 'prompter', arg: 'no' }] }), /Pestaña del prompter no válida/);
  // S10: una pestaña retirada en un atajo guardado sigue siendo válida al guardar
  const legado = await find('POST', '/api/shortcuts').fn({ name: 'legado', steps: [{ kind: 'builtin', action: 'prompter', arg: 'sorteo' }] });
  assert.deepEqual(legado.shortcut.steps, [{ kind: 'builtin', action: 'prompter', arg: 'sorteo' }]);
  await assert.rejects(find('POST', '/api/shortcuts').fn({ name: 'x', steps: [{ kind: 'otro' }] }), /Tipo de paso desconocido/);
  await assert.rejects(find('POST', '/api/shortcuts').fn({ name: 'x', steps: [{ kind: 'scene', scene: 'x' }] }), /Acción no válida/); // checkActions del ctx
});

test('shortcutOf por id y por nombre, 404 si no existe', async () => {
  const { ctx, find } = fakeCtx();
  const sc = { id: 'abc', name: 'Marca rápida', steps: [{ kind: 'builtin', action: 'marca' }] };
  ctx.store.config.shortcuts = [sc];
  const out = await find('POST', '/api/shortcuts/abc/run').fn({ id: 'abc' });
  assert.deepEqual(out, { ok: true, shortcut: 'abc', results: [{ marker: '' }], errors: [] });
  await find('POST', '/api/shortcuts/marca%20r%C3%A1pida/run').fn({ id: 'marca rápida' }); // por nombre, sin error
  await assert.rejects(find('POST', '/api/shortcuts/zzz/run').fn({ id: 'zzz' }), /No existe el atajo «zzz»/);
});

test('PUT y DELETE /api/shortcuts/:id', async () => {
  const { ctx, find } = fakeCtx();
  ctx.store.config.shortcuts = [{ id: 'abc', name: 'A', color: '', steps: [] }];
  const put = await find('PUT', '/api/shortcuts/abc').fn({ id: 'abc' }, { name: 'B', steps: [{ kind: 'builtin', action: 'marca' }] });
  assert.deepEqual([put.shortcut.name, put.shortcut.steps], ['B', [{ kind: 'builtin', action: 'marca' }]]);
  await find('PUT', '/api/shortcuts/abc').fn({ id: 'abc' }, { color: '#123' });
  assert.equal(ctx.store.config.shortcuts[0].color, '#123');
  await assert.rejects(find('PUT', '/api/shortcuts/abc').fn({ id: 'abc' }, { steps: [{ kind: 'builtin', action: 'nada' }] }), /Acción desconocida/);
  await find('DELETE', '/api/shortcuts/abc').fn({ id: 'abc' });
  assert.deepEqual(ctx.store.config.shortcuts, []);
});

test('runShortcut: errores por paso, 400 solo si no hubo resultados', async () => {
  const { ctx, find } = fakeCtx();
  ctx.store.config.shortcuts = [{ id: 'mix', name: 'mix', steps: [
    { kind: 'builtin', action: 'prompter', arg: 'sorteo' },
    { kind: 'builtin', action: 'sortear' },
    { kind: 'say', text: 'hola' },
    { kind: 'builtin', action: 'saltar' },
  ] }];
  ctx.interactive.draw = () => { throw new Error('sin sorteo'); };
  const out = await find('POST', '/api/shortcuts/mix/run').fn({ id: 'mix' });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors, ['sortear: sin sorteo']);
  assert.deepEqual(ctx._spies.prompts, ['sorteo']);
  assert.deepEqual(ctx._spies.said, ['hola']);
  assert.deepEqual(ctx._spies.sent, [['control', { action: 'skip' }, ['overlay']]]);
  // todos los pasos fallan → 400
  ctx.store.config.shortcuts.push({ id: 'mal', name: 'mal', steps: [{ kind: 'chat', text: 'x' }, { kind: 'chat', text: 'y' }] });
  await assert.rejects(find('POST', '/api/shortcuts/mal/run').fn({ id: 'mal' }), e => { assert.match(e.message, /chat: chat apagado · chat: chat apagado/); return true; });
});

test('/sd/:action: atajos de Stream Deck, prompter, custom y 404', async () => {
  const { ctx, find } = fakeCtx();
  ctx.store.config.shortcuts = [{ id: 'c1', name: 'c', steps: [] }];
  assert.deepEqual(await find('GET', '/sd/marca').fn({ action: 'marca' }), { marker: '' });
  assert.deepEqual(ctx._spies.markers, ['']);
  const pausa = await find('POST', '/sd/pausa').fn({ action: 'pausa' });
  assert.equal(pausa.paused, true);
  assert.equal((await find('POST', '/sd/pausa').fn({ action: 'pausa' })).paused, false);
  assert.deepEqual(await find('GET', '/sd/siguiente-pregunta').fn({ action: 'siguiente-pregunta' }), { question: { q: 1 } });
  await find('GET', '/sd/ocultar-pregunta').fn({ action: 'ocultar-pregunta' });
  assert.deepEqual(await find('POST', '/sd/cerrar-votacion').fn({ action: 'cerrar-votacion' }), { result: { r: 'vote', o: { apply: true } } });
  assert.deepEqual(await find('GET', '/sd/abrir-sorteo').fn({ action: 'abrir-sorteo' }), { g: 'open', o: { reset: true } });
  assert.deepEqual(await find('GET', '/sd/cerrar-sorteo').fn({ action: 'cerrar-sorteo' }), { g: 'closed' });
  assert.deepEqual(await find('GET', '/sd/agradecido').fn({ action: 'agradecido' }), { id: 'e1', user: 'ana', pending: 0 });
  assert.deepEqual(await find('GET', '/sd/prompter/tierlist').fn({ action: 'prompter', arg: 'tierlist' }), { tab: 'cronologia' });
  assert.deepEqual(await find('GET', '/sd/prompter/cronologia').fn({ action: 'prompter', arg: 'cronologia' }), { tab: 'cronologia' });
  assert.deepEqual(await find('GET', '/sd/custom/c1').fn({ action: 'custom', arg: 'c1' }), { ok: true, shortcut: 'c1', results: [], errors: [] });
  await assert.rejects(find('GET', '/sd/nada').fn({ action: 'nada' }), e => {
    assert.match(e.message, /Atajo desconocido: nada\. Atajos: marca, pausa, saltar, siguiente-pregunta, ocultar-pregunta, cerrar-votacion, abrir-sorteo, cerrar-sorteo, sortear, agradecido, prompter\/<pestaña>, custom\/<id>/);
    return true;
  });
  await assert.rejects(find('GET', '/sd/prompter/mal').fn({ action: 'prompter', arg: 'mal' }), /Pestaña desconocida/);
});

test('GET /api/shortcuts: listado de acciones, custom y tipos de paso', async () => {
  const { ctx, find } = fakeCtx();
  ctx.store.config.shortcuts = [{ id: 'c1', name: 'c', color: '#fff', steps: [] }];
  const out = await find('GET', '/api/shortcuts').fn({});
  assert.deepEqual(out.actions, ['marca', 'pausa', 'saltar', 'siguiente-pregunta', 'ocultar-pregunta', 'cerrar-votacion', 'abrir-sorteo', 'cerrar-sorteo', 'sortear', 'agradecido', ...PROMPTER_TABS.map(t => 'prompter/' + t)]);
  assert.deepEqual(out.custom, [{ id: 'c1', name: 'c', color: '#fff', steps: [], path: '/sd/custom/c1' }]);
  assert.deepEqual(out.stepKinds, ['builtin', 'scene', 'layer', 'hideLayer', 'toggleLayer', 'effect', 'command', 'streamEvent', 'chat', 'say']);
  assert.deepEqual(out.builtins, ['marca', 'pausa', 'saltar', 'siguiente-pregunta', 'ocultar-pregunta', 'cerrar-votacion', 'abrir-sorteo', 'cerrar-sorteo', 'sortear', 'agradecido']);
  assert.deepEqual(out.prompterTabs, PROMPTER_TABS);
});
