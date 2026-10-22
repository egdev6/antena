// Objetivos por plataforma (#128): cajas con barras, conversión legacy idempotente,
// reparto del offset global de «events» por plataforma y aislamiento de contadores.
// Fixtures sintéticos en directorios temporales: nunca toca data/ real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { convertLegacyGoals, splitEventsOffsets, platformValue, EVENTS_SPLIT } from '../src/goals.mjs';
import { Store } from '../src/store.mjs';
import { Session } from '../src/session.mjs';

const tmp = async files => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goals-128-'));
  for (const [name, body] of Object.entries(files)) await writeFile(path.join(dir, name), JSON.stringify(body, null, 2));
  return dir;
};

// ---------- conversión de config legacy ----------

test('un goal legacy simple pasa a caja con una barra de su plataforma, sin pérdidas', () => {
  const out = convertLegacyGoals([
    { id: 'a', title: 'Seguidores', metric: 'follows', target: 30, css: '.title{color:#fff}' },
    { id: 'b', title: 'Super Chats', metric: 'superchats', target: 25 },
  ]);
  assert.deepEqual(out[0], {
    id: 'a', title: 'Seguidores', visible: true, showMetric: true, css: '.title{color:#fff}',
    bars: [{ id: 'a-1', platform: 'twitch', metric: 'follows', target: 30, visible: true }],
  });
  assert.equal(out[1].bars[0].platform, 'youtube');
  assert.equal(out[1].bars[0].target, 25);
  assert.equal(out[1].css, '');
});

test('un goal legacy de events se divide en DOS barras twitch+youtube, ambas con el target antiguo', () => {
  const out = convertLegacyGoals([{ id: 'ev', title: 'Eventos', metric: 'events', target: 1 }]);
  assert.equal(out[0].bars.length, 2);
  assert.deepEqual(out[0].bars.map(b => b.platform), ['twitch', 'youtube']);
  assert.deepEqual(out[0].bars.map(b => b.target), [1, 1]);   // T=1 válido en ambas
  assert.deepEqual(out[0].bars.map(b => b.metric), ['events', 'events']);
  assert.ok(out[0].bars[0].id !== out[0].bars[1].id);
});

test('la conversión es idempotente: cargar dos veces da el mismo resultado', () => {
  const legacy = [{ id: 'a', title: 'X', metric: 'events', target: 7, css: 'c' }, { id: 'b', title: 'Y', metric: 'subs', target: 3 }];
  const once = convertLegacyGoals(legacy);
  const twice = convertLegacyGoals(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(JSON.parse(JSON.stringify(once)), JSON.parse(JSON.stringify(twice)));
});

test('metas distintas por barra en la misma caja se conservan en la conversión', () => {
  const box = { id: 'c', title: 'Mixta', visible: true, showMetric: false, css: '',
    bars: [{ id: 'c-1', platform: 'twitch', metric: 'follows', target: 10, visible: true }, { id: 'c-2', platform: 'youtube', metric: 'superchats', target: 99, visible: false }] };
  const out = convertLegacyGoals([box]);
  assert.deepEqual(out[0].bars[0].target, 10);
  assert.deepEqual(out[0].bars[1].target, 99);
  assert.equal(out[0].showMetric, false);
  assert.equal(out[0].bars[1].visible, false);
});

// ---------- reparto del offset global de events ----------

test('offset legacy de events se reparte en mitades exactas (O/2 y O−O/2), suma conservada', () => {
  const d = { goalOffsets: { events: 10 } };
  const r = splitEventsOffsets(d);
  assert.ok(r.changed);
  assert.equal(d.goalOffsets['events@twitch'], 5);
  assert.equal(d.goalOffsets['events@youtube'], 5);
  assert.equal(d.goalOffsets.events, 10);                       // legacy conservada, inerte
  assert.equal(d[EVENTS_SPLIT].from, 10);                       // marcador registra la migración
});

test('offset fraccionario no inventa ajustes de signos opuestos', () => {
  const d = { goalOffsets: { events: 0.5 } };
  splitEventsOffsets(d);
  assert.equal(d.goalOffsets['events@twitch'], 0.25);
  assert.equal(d.goalOffsets['events@youtube'], 0.25);
  const neg = { goalOffsets: { events: -3 } };
  splitEventsOffsets(neg);
  assert.equal(neg.goalOffsets['events@twitch'], -1.5);
  assert.equal(neg.goalOffsets['events@youtube'], -1.5);
});

test('el reparto es una vez por sesión: marker presente con claves válidas no re-divide aunque la legacy cambie', () => {
  const d = { goalOffsets: { events: 10, 'events@twitch': 4, 'events@youtube': 6 }, [EVENTS_SPLIT]: { from: 10 } };
  d.goalOffsets.events = 999;                                   // edición manual posterior de la clave legacy
  const r = splitEventsOffsets(d);
  assert.ok(r, 'el reparto responde sin lanzar');
  assert.equal(r.changed, false);
  assert.equal(d.goalOffsets['events@twitch'], 4);              // no se toca nada
  assert.equal(d.goalOffsets['events@youtube'], 6);
});

test('claves @ preexistentes sin marker: no se sobreescriben; la que falta se completa como resto y no se pierde la legacy', () => {
  const d = { goalOffsets: { events: 10, 'events@twitch': 4 } };
  const r = splitEventsOffsets(d);
  assert.ok(r.changed && r.preexisting, 'completa el resto y marca preexisting');
  assert.equal(d.goalOffsets['events@twitch'], 4);              // preexistente intacto
  assert.equal(d.goalOffsets['events@youtube'], 6);             // resto conservador (10 − 4)
  assert.equal(d.goalOffsets.events, 10);
  assert.equal(d[EVENTS_SPLIT].preexisting, true);
  const both = { goalOffsets: { events: 10, 'events@twitch': 4, 'events@youtube': 6 } };
  splitEventsOffsets(both);
  assert.equal(both.goalOffsets['events@twitch'], 4);
  assert.equal(both.goalOffsets['events@youtube'], 6);
  assert.equal(both[EVENTS_SPLIT].preexisting, true);
});

test('sin offset de events no se reparte nada ni se crea marker espurio', () => {
  const d = { goalOffsets: { follows: 3 } };
  const r = splitEventsOffsets(d);
  assert.equal(r.changed, false);
  assert.equal(d[EVENTS_SPLIT], undefined);
});

// ---------- contrato con marcador presente: claves propias, números finitos o error ----------

const NUMEROS_VALIDOS = [0, -3, -1.5, 2.25, 1e9];
const NO_VALIDOS = [null, '', '5', true, false, NaN, Infinity, -Infinity, {}];

for (const [desc, keys] of [['falta una', { 'events@twitch': 5 }], ['faltan ambas', {}]]) {
  test(`marker presente con claves @ ${desc}: error explícito antes de servir, sin escribir ni reparar`, () => {
    const d = { goalOffsets: { events: 10, ...keys }, [EVENTS_SPLIT]: { from: 10 } };
    const antes = JSON.parse(JSON.stringify(d));
    assert.throws(() => splitEventsOffsets(d), err => /events@(twitch|youtube)/.test(err.message) && /marcador/i.test(err.message));
    assert.deepEqual(JSON.parse(JSON.stringify(d)), antes, 'nada inventado ni alterado');
  });
}

for (const v of NO_VALIDOS) {
  test(`marker presente con events@twitch inválido (${JSON.stringify(v)}): error explícito, sin tocar bytes`, () => {
    const d = { goalOffsets: { 'events@twitch': v, 'events@youtube': 4 }, [EVENTS_SPLIT]: { from: 10 } };
    const antes = JSON.parse(JSON.stringify(d));
    let msg = '';
    try { splitEventsOffsets(d); } catch (e) { msg = e.message; }
    assert.ok(msg.includes('events@twitch'));
    assert.ok(!/elimina (el )?marcador/i.test(msg), 'el mensaje no debe recomendar borrar el marcador: reaplicaría la legacy obsoleta');
    assert.ok(/manteniendo el marcador|backup/i.test(msg), 'el mensaje recomienda backup coherente o corregir las claves conservando el marcador');
    assert.deepEqual(JSON.parse(JSON.stringify(d)), antes, 'el rechazo no altera el estado');
  });
}

for (const v of NUMEROS_VALIDOS) {
  test(`marker presente con ajustes finitos válidos (${v}) carga sin error`, () => {
    const d = { goalOffsets: { 'events@twitch': v, 'events@youtube': v }, [EVENTS_SPLIT]: { from: 10 } };
    const r = splitEventsOffsets(d);
    assert.equal(r.changed, false);
    assert.equal(d.goalOffsets['events@twitch'], v);   // respetados tal cual
  });
}

test('marker presente con ajuste presente-pero-no-número en YouTube: error nombra la clave', () => {
  const d = { goalOffsets: { 'events@twitch': 5, 'events@youtube': 'x' }, [EVENTS_SPLIT]: { from: 10 } };
  assert.throws(() => splitEventsOffsets(d), /events@youtube/);
});

test('sesión persistida con marker y clave @ corrupta: Session.load rechaza y no altera el archivo', async () => {
  const dir = await tmp({
    'session-current.json': { id: '2026-01-01T00-00-00-000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', startedAt: '2026-01-01T00:00:00.000Z', events: [], notes: [], goalOffsets: { 'events@twitch': null, 'events@youtube': 4 }, [EVENTS_SPLIT]: { from: 10 } },
  });
  try {
    const antes = await readFile(path.join(dir, 'session-current.json'), 'utf8');
    await assert.rejects(new Session(dir).load(), /events@twitch/);
    assert.equal(await readFile(path.join(dir, 'session-current.json'), 'utf8'), antes, 'el rechazo no reescribe la sesión');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('primary corrupto + backup válido con offset legacy: recuperación y reparto en el mismo arranque', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'goals-128-recovery-'));
  const backup = { id: '2026-01-01T00-00-00-000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', startedAt: '2026-01-01T00:00:00.000Z', events: [], notes: [], goalOffsets: { events: 8 } };
  await writeFile(path.join(dir, 'session-current.backup.json'), JSON.stringify(backup));
  await writeFile(path.join(dir, 'session-current.json'), '{ esto no es json');
  try {
    const s = await new Session(dir).load();
    assert.equal(s.recovery.source, 'backup');
    assert.equal(s.data.goalOffsets['events@twitch'], 4);
    assert.equal(s.data.goalOffsets['events@youtube'], 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- aislamiento de contadores por plataforma ----------

test('una barra de Twitch no cuenta eventos de YouTube y al revés', () => {
  const events = [
    { id: '1', type: 'follow', vars: {} },          // twitch
    { id: '2', type: 'cheer', vars: { amount: 30 } }, // twitch
    { id: '3', type: 'superchat', vars: { amount: 5 } }, // youtube
    { id: '4', type: 'member', vars: {} },          // youtube
  ];
  assert.equal(platformValue('events', 'twitch', events), 2);
  assert.equal(platformValue('events', 'youtube', events), 2);
  assert.equal(platformValue('follows', 'twitch', events), 1);
  assert.equal(platformValue('follows', 'youtube', events), 0);
  assert.equal(platformValue('superchats', 'twitch', events), 0);
  assert.equal(platformValue('superchats', 'youtube', events), 5);
  assert.equal(platformValue('bits', 'twitch', events), 30);
  assert.equal(platformValue('members', 'youtube', events), 1);
});

// ---------- carga completa con restart y fallo parcial (dos archivos, sin transacción) ----------

test('Store convierte la config al cargar y persiste; recargar es estable (doble carga)', async () => {
  const dir = await tmp({ 'config.json': { widgets: { goals: [{ id: 'a', title: 'Ev', metric: 'events', target: 6, css: 'x' }] } } });
  try {
    const s1 = await new Store(dir).load();
    assert.equal(s1.config.widgets.goals[0].bars.length, 2);
    const onDisk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.widgets.goals[0].bars.length, 2);
    const s2 = await new Store(dir).load();      // segunda carga sobre config ya convertida
    assert.deepEqual(s2.config.widgets.goals, s1.config.widgets.goals);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restart entre conversiones: config convertida + sesión sin dividir se auto-completa al cargar la sesión', async () => {
  const dir = await tmp({
    'config.json': { widgets: { goals: [{ id: 'a', title: 'Ev', metric: 'events', target: 6 }] } },
    'session-current.json': { id: '2026-01-01T00-00-00-000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', startedAt: '2026-01-01T00:00:00.000Z', events: [], notes: [], goalOffsets: { events: 8 } },
  });
  try {
    await new Store(dir).load();                 // migración de config
    const session = await new Session(dir).load();   // fallo parcial simulado: sesión aún legacy
    assert.equal(session.data.goalOffsets['events@twitch'], 4);
    assert.equal(session.data.goalOffsets['events@youtube'], 4);
    await session.flush();                       // persiste antes de servir
    const again = await new Session(dir).load(); // restart posterior: no re-divide
    assert.equal(again.data.goalOffsets['events@twitch'], 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('doble carga de la sesión no re-divide ni duplica', async () => {
  const dir = await tmp({
    'session-current.json': { id: '2026-01-01T00-00-00-000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', startedAt: '2026-01-01T00:00:00.000Z', events: [], notes: [], goalOffsets: { events: 7 } },
  });
  try {
    const s = await new Session(dir).load();
    await s.flush();
    const s2 = await new Session(dir).load();
    assert.equal(s2.data.goalOffsets['events@twitch'], 3.5);
    assert.equal(s2.data.goalOffsets['events@youtube'], 3.5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('el valor de un goal de sesión usa offsets con plataforma: goalValue(metric, platform)', async () => {
  const dir = await tmp({
    'session-current.json': { id: '2026-01-01T00-00-00-000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', startedAt: '2026-01-01T00:00:00.000Z', notes: [], goalOffsets: { follows: 5 }, events: [
      { id: '1', type: 'follow', vars: {} },
      { id: '2', type: 'superchat', vars: { amount: 3 } },
    ] },
  });
  try {
    const s = await new Session(dir).load();
    assert.equal(s.goalValue('follows', 'twitch'), 6);            // 1 real + 5 legacy fallback (métrica single-platform)
    assert.equal(s.goalValue('follows', 'youtube'), 5);
    assert.equal(s.goalValue('superchats', 'youtube'), 3);
    assert.equal(s.goalValue('events', 'twitch'), 1);             // solo el follow (twitch)
    s.addToGoal('events', 2, 'twitch');
    assert.equal(s.goalValue('events', 'twitch'), 3);
    assert.equal(s.goalValue('events', 'youtube'), 1);            // twitch no contamina youtube
    s.setGoalValue('events', 9, 'youtube');
    assert.equal(s.goalValue('events', 'youtube'), 9);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- esquema y API ----------

test('el esquema valida cajas y barras y rechaza una plataforma inválida', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  const ok = validatePatch({ widgets: { goals: [{ id: 'a', title: 'T', visible: true, showMetric: true, css: '', bars: [{ id: 'a-1', platform: 'twitch', metric: 'follows', target: 5, visible: true }] }] } });
  assert.deepEqual(ok, []);
  const bad = validatePatch({ widgets: { goals: [{ id: 'a', title: 'T', bars: [{ id: 'a-1', platform: 'kick', metric: 'follows', target: 5 }] }] } });
  assert.ok(bad.length > 0);
  const badMetric = validatePatch({ widgets: { goals: [{ id: 'a', title: 'T', bars: [{ id: 'a-1', platform: 'twitch', metric: 'superchats', target: 5 }] }] } });
  assert.ok(badMetric.length > 0, 'superchats no es métrica de twitch');
});

test('API de cajas y barras: crear, editar, borrar, barra con meta distinta y 400 sin guardar en inválidos', async t => {
  const { registerGoalsRoutes } = await import('../src/routes/goals.mjs');
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const config = { widgets: { goals: [{ id: 'a', title: 'A', visible: true, showMetric: true, css: '', bars: [{ id: 'a-1', platform: 'twitch', metric: 'follows', target: 10, visible: true }] }] } };
  const saved = [];
  const store = {
    config,
    validateGoals: () => [],
    save: async k => saved.push(k),
  };
  const session = {
    goalValue: () => 0,
    addToGoal: (m, d, p) => saved.push(['add', m, d, p]),
    setGoalValue: (m, v, p) => saved.push(['set', m, v, p]),
  };
  registerGoalsRoutes({ route, store, session, id8: () => 'id000000' });
  const call = async (method, url, body) => {
    const r = routes.find(x => x.method === method && x.re.test(url));
    assert.ok(r, `${method} ${url}`);
    const m = url.match(r.re);
    // mismo convenio que el dispatcher de server.mjs: fn(params, body) con :vars; fn(body) sin ellos
    return m.groups ? r.fn(m.groups, body) : r.fn(body, null);
  };

  await t.test('crear conserva y valida CSS explícito', async () => {
    const css = '.title { color: red; }';
    const created = await call('POST', '/api/goals', { id: 'css', css });
    assert.equal(created.goal.css, css);
    assert.equal(config.widgets.goals.find(g => g.id === 'css').css, css);
    const before = structuredClone(config);
    const count = saved.length;
    await assert.rejects(call('POST', '/api/goals', { id: 'css-invalid', css: 42 }), err => err.status === 400);
    assert.deepEqual(config, before);
    assert.equal(saved.length, count);
  });
  await t.test('PUT legacy traduce campos en caja única y valida plataforma antes de mutar', async () => {
    const result = await call('PUT', '/api/goals/a', { metric: 'subs', target: 27 });
    assert.equal(result.goal.bars[0].metric, 'subs');
    assert.equal(result.goal.bars[0].target, 27);
    const before = structuredClone(config);
    const count = saved.length;
    await assert.rejects(call('PUT', '/api/goals/a', { metric: 'superchats', target: 5 }), err => err.status === 400);
    assert.deepEqual(config, before);
    assert.equal(saved.length, count);
  });

  await t.test('add legacy: amount omitido suma 1; cero y negativos explícitos se respetan', async () => {
    for (const [body, expected] of [[{}, 1], [{ amount: 0 }, 0], [{ amount: -2 }, -2]]) {
      await call('POST', '/api/goals/a/add', body);
      assert.deepEqual(saved.at(-1), ['add', 'subs', expected, 'twitch']);
    }
    // La ruta de barra tiene un handler independiente: conservar sus cantidades explícitas.
    for (const amount of [0, -2]) {
      await call('POST', '/api/goals/a/bars/a-1/add', { amount });
      assert.deepEqual(saved.at(-1), ['add', 'subs', amount, 'twitch']);
    }
  });

  // barra con meta distinta en la misma caja
  const d = await call('POST', '/api/goals/a/bars', { platform: 'youtube', metric: 'superchats', target: 99 });
  assert.equal(d.bar.target, 99);
  assert.ok(saved.includes('widgets'));
  assert.equal(config.widgets.goals[0].bars[1].target, 99);
  const multiple = structuredClone(config);
  const savesBefore = saved.length;
  await assert.rejects(call('PUT', '/api/goals/a', { title: 'No cambiar', target: 50 }), err => err.status === 400);
  assert.deepEqual(config, multiple);
  assert.equal(saved.length, savesBefore);
  const edit = await call('PUT', '/api/goals/a/bars/a-1', { target: 42 });
  assert.equal(edit.bar.target, 42);

  // caja: visible/showMetric y borrar
  const put = await call('PUT', '/api/goals/a', { visible: false, showMetric: false });
  assert.equal(put.goal.visible, false);
  assert.equal(put.goal.showMetric, false);
  const del = await call('DELETE', '/api/goals/a/bars/a-1');
  assert.equal(del.bars.length, 1);

  // inválido: 400 sin guardar nada
  saved.length = 0;
  await assert.rejects(call('POST', '/api/goals/a/bars', { platform: 'kick', metric: 'follows', target: 5 }), err => err.status === 400);
  assert.deepEqual(saved, [], 'un valor inválido no guarda nada');

  // F1: ids duplicados se rechazan ANTES de mutar; el id de caja no es editable por PUT
  const antes = JSON.parse(JSON.stringify(config.widgets.goals));
  await assert.rejects(call('POST', '/api/goals', { title: 'Dup', metric: 'follows', target: 5, id: 'a' }), err => err.status === 400);
  assert.deepEqual(JSON.parse(JSON.stringify(config.widgets.goals)), antes, 'un id de caja duplicado no guarda nada');
  await assert.rejects(call('POST', '/api/goals/a/bars', { platform: 'twitch', metric: 'follows', target: 5, id: 'id000000' }), err => err.status === 400);
  assert.deepEqual(JSON.parse(JSON.stringify(config.widgets.goals)), antes, 'un id de barra duplicado no guarda nada');
  const renom = await call('PUT', '/api/goals/a', { id: 'otro', title: 'A2' });
  assert.equal(renom.goal.id, 'a');
  assert.equal(renom.goal.title, 'A2');

  // add/set por barra usa (metric, platform); con una sola barra el add/set de caja sigue
  // funcionando (compat) y usa esa barra; con varias, la caja exige «barId» (400).
  await call('POST', '/api/goals/a/add', { amount: 1 });
  assert.deepEqual(saved.at(-1), ['add', 'superchats', 1, 'youtube']);   // única barra restante
  config.widgets.goals[0].bars.push({ id: 'a-2', platform: 'twitch', metric: 'follows', target: 5, visible: true });
  await call('POST', '/api/goals/a/bars/a-2/add', { amount: 3 });
  assert.deepEqual(saved.at(-1), ['add', 'follows', 3, 'twitch']);
  await call('POST', '/api/goals/a/bars/a-2/set', { value: 7 });
  assert.deepEqual(saved.at(-1), ['set', 'follows', 7, 'twitch']);
  await assert.rejects(call('POST', '/api/goals/a/set', { value: 1 }), err => err.status === 400);
  // F1: borrar una barra quita exactamente ESA barra, sin tocar la otra ni duplicar borros
  const delBar = await call('DELETE', '/api/goals/a/bars/a-2');
  assert.deepEqual(delBar.bars.map(x => x.id), ['id000000']);
  await assert.rejects(call('DELETE', '/api/goals/a/bars/id000000'), err => err.status === 400);   // última barra: 400

  // crear caja con una barra
  const box = await call('POST', '/api/goals', { title: 'Nueva', metric: 'follows', target: 20 });
  assert.equal(box.goal.bars.length, 1);
  assert.equal(box.goal.bars[0].platform, 'twitch');
});

// Corrección nativa: ajustes nuevos de events sin total legacy sobreviven a reinicios.
for (const platforms of [['twitch'], ['youtube'], ['twitch', 'youtube']]) {
  test(`events nuevos sin legacy: ${platforms.join('+')}, tres reinicios sin NaN`, async () => {
    const dir = await tmp({});
    try {
      let session = await new Session(dir).load();
      for (const platform of platforms) session.addToGoal('events', 2.5, platform);
      await session.flush();
      for (let restart = 0; restart < 3; restart++) {
        session = await new Session(dir).load();
        for (const platform of ['twitch', 'youtube']) {
          assert.equal(session.goalValue('events', platform), platforms.includes(platform) ? 2.5 : 0);
        }
        await session.flush();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

for (const action of ['add', 'set']) {
  test(`primer ${action} conserva offset legacy sin doble suma y persiste`, async () => {
    const dir = await tmp({});
    try {
      const session = await new Session(dir).load();
      session.data.events = [{ type: 'follow', vars: {} }];
      session.data.goalOffsets = { follows: 5 };
      assert.equal(session.goalValue('follows', 'twitch'), 6);
      if (action === 'add') session.addToGoal('follows', 1, 'twitch');
      else session.setGoalValue('follows', 7, 'twitch');
      assert.equal(session.goalValue('follows', 'twitch'), 7);
      assert.equal(session.data.goalOffsets.follows, 5);
      await session.flush();
      const again = await new Session(dir).load();
      assert.equal(again.goalValue('follows', 'twitch'), 7);
      again.addToGoal('follows', 1, 'twitch');
      assert.equal(again.goalValue('follows', 'twitch'), 8);
      await again.flush();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

// ---------- fallo real de persistencia: rechazo explícito y recuperación sin duplicar ----------

test('Store.load rechaza si la conversión no se puede persistir; al recuperarse convierte una sola vez', async () => {
  const dir = await tmp({ 'config.json': { widgets: { goals: [{ id: 'a', title: 'Ev', metric: 'events', target: 6 }] } } });
  const cfg = path.join(dir, 'config.json');
  // Bloquear la escritura igual en todos los sistemas: la carpeta r-x (POSIX: el rename falla con
  // EACCES) y config.json de solo lectura (Windows ignora el modo de la carpeta, pero no deja que un
  // rename reemplace un fichero de solo lectura: EPERM).
  await chmod(cfg, 0o444);
  await chmod(dir, 0o500);
  try {
    await assert.rejects(new Store(dir).load(), err => /persist|guardar|EACCES|EPERM|Permission/i.test(String(err.message + err.code)));
    await chmod(dir, 0o700);                    // recuperado: ahora sí convierte
    await chmod(cfg, 0o644);
    const s = await new Store(dir).load();
    assert.equal(s.config.widgets.goals[0].bars.length, 2);
    const s2 = await new Store(dir).load();     // y una tercera carga no duplica barras
    assert.equal(s2.config.widgets.goals[0].bars.length, 2);
  } finally { await chmod(dir, 0o700); await chmod(cfg, 0o644).catch(() => {}); await rm(dir, { recursive: true, force: true }); }
});

test('Session.load rechaza si el reparto no se puede persistir (writer inyectado que falla); luego recupera sin duplicar', async () => {
  const dir = await tmp({
    'session-current.json': { id: '2026-01-01T00-00-00-000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', startedAt: '2026-01-01T00:00:00.000Z', events: [], notes: [], goalOffsets: { events: 8 } },
  });
  try {
    const roto = async () => { throw new Error('EIO simulado'); };
    await assert.rejects(new Session(dir, { writer: roto }).load(),
      err => /guardar la sesión/.test(err.message) && /EIO simulado/.test(String(err.cause || err.message)));
    // recuperación: writer real, la sesión aún legacy → reparte UNA vez
    const s = await new Session(dir).load();
    assert.equal(s.data.goalOffsets['events@twitch'], 4);
    assert.equal(s.data.goalOffsets['events@youtube'], 4);
    const s2 = await new Session(dir).load();   // recarga: marker impide re-dividir
    assert.equal(s2.data.goalOffsets['events@twitch'], 4);
    assert.equal(Object.keys(s2.data.goalOffsets).filter(k => k.startsWith('events@')).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
