// Carrera de cargas solapadas en live.ts: la load() inicial del llamador y la del primer
// 'open' del SSE corren a la vez. Si registran el chat "en curso" en un único Set, la
// segunda reemplaza a la primera y un mensaje que llega en plena carga se pierde cuando
// la primera resuelve después con un snapshot más viejo. Aquí se reproduce con dos
// cargas que resuelven en orden inverso, igual que haría hardening-62 con live.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// EventSource falso: connect() registra los handlers y el test emite eventos a mano.
class FakeEventSource {
  constructor() { globalThis.__fakeEs = this; this._listeners = {}; }
  addEventListener(name, fn) { (this._listeners[name] ||= []).push(fn); }
  emit(name, data) { for (const fn of this._listeners[name] || []) fn({ data: JSON.stringify(data) }); }
}

// Empaqueta live.ts con esbuild y stubs de react/api/events: devuelve el módulo cargado.
async function bundleLive(withPatchers = false) {
  const esbuild = await import('esbuild');
  const ts = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'app/src/lib/live.ts'), 'utf8');
  const stub = 'export const useSyncExternalStore = () => () => {};\nexport const useEffect = () => {};\n' +
    'export const warnUnknownClientEvent = () => false;\n' +
    'export const api = (m, p, b) => globalThis.__apiImpl(m, p, b);\n' +
    'export const withKey = (u) => u; export const toast = () => {};';
  const bundled = await esbuild.build({
    stdin: { contents: withPatchers ? `export * from './live'; export * from './patch'; export * from './draft';` : ts,
      resolveDir: path.join(ROOT, 'app/src/lib'), loader: 'ts', sourcefile: withPatchers ? 'fixture.ts' : 'live.ts' },
    bundle: true, format: 'esm', write: false,
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /^(react|\.\/api|\.\/ui|.*events\.mjs)$/ }, a => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }));
      },
    }],
  }).then(r => r.outputFiles[0].text);
  const dir = await mkdtemp(path.join(tmpdir(), 'egdev-load-race-'));
  const file = path.join(dir, 'live.test.mjs');
  await writeFile(file, bundled);
  return import(pathToFileURL(file).href);   // en Windows, import() exige file://
}

for (const alreadySaving of [false, true]) {
  test(`flushAll espera las tres fuentes pendientes (ocupado=${alreadySaving})`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { live, patchWidgets, patchIx, flushAll, saveAll, discardAll, isDirty } = await bundleLive(true);
    t.after(() => { discardAll(); delete globalThis.__apiImpl; });
    live.state = { config: { widgets: {} }, interactive: { config: { questions: {} } } };
    const requests = [];
    globalThis.__apiImpl = (_method, url, body) => new Promise(resolve => requests.push({ url, body, resolve }));
    const turn = () => new Promise(resolve => setImmediate(resolve));
    live.patchConfig({ panel: { onboardingDone: true } });
    let prior;
    if (alreadySaving) {
      prior = saveAll();
      await turn();
      assert.equal(requests.length, 1);
    }
    patchWidgets({ chat: { enabled: true } });
    patchIx('questions', { enabled: true });
    if (alreadySaving) assert.equal(saveAll(), prior, 'doble clic manual no encola el nuevo borrador');
    let settled = false;
    const flushed = flushAll().then(() => { settled = true; });
    await turn();
    assert.deepEqual(requests.map(r => r.url), ['/api/config']);
    assert.equal(settled, false, 'config bloqueada mantiene flushAll pendiente');
    requests[0].resolve({ config: { widgets: {}, panel: { onboardingDone: true } } });
    await turn();
    assert.equal(settled, false, 'flushAll no resuelve dejando widgets/interactivos sin persistir');
    assert.equal(requests[1]?.url, '/api/widgets');
    assert.deepEqual(requests[1].body, { chat: { enabled: true } });
    requests[1].resolve({ widgets: requests[1].body });
    await turn();
    assert.equal(settled, false, 'también espera la persistencia interactiva');
    assert.equal(requests[2]?.url, '/api/interactive/config');
    assert.deepEqual(requests[2].body, { questions: { enabled: true } });
    requests[2].resolve(requests[2].body);
    await flushed;
    await prior;
    assert.equal(requests.length, 3);
    assert.equal(isDirty(), false);
    t.mock.timers.tick(30000);
    await turn();
    assert.equal(requests.length, 3, 'no quedan temporizadores duplicando las escrituras');
  });
}

test('flushAll propaga errores y conserva el borrador sin reintento automático', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { live, patchWidgets, patchIx, flushAll, discardAll, isDirty } = await bundleLive(true);
  t.after(() => { discardAll(); delete globalThis.__apiImpl; });
  live.state = { config: { widgets: {} }, interactive: { config: { questions: {} } } };
  const requests = [];
  const failure = new Error('persistencia rechazada');
  globalThis.__apiImpl = (_method, url) => { requests.push(url); return Promise.reject(failure); };
  live.patchConfig({ panel: { onboardingDone: true } });
  patchWidgets({ chat: { enabled: true } });
  patchIx('questions', { enabled: true });
  await assert.rejects(flushAll(), error => error === failure);
  assert.equal(isDirty(), true, 'la fuente fallida y las no enviadas conservan su intención');
  t.mock.timers.tick(30000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ['/api/config'], 'sin bucle de reintentos tras el fallo explícito');
});

test('cargas solapadas que resuelven en orden inverso no pierden el chat en curso', async t => {
  globalThis.EventSource = FakeEventSource;
  const { live } = await bundleLive();
  t.after(() => { delete globalThis.EventSource; delete globalThis.__apiImpl; delete globalThis.__fakeEs; });

  // cada GET /api/state y /api/chat?limit=200 (#115: ventana propia del panel) queda a la
  // espera de que el test lo resuelva; el orden es state y luego chat dentro de cada carga.
  const pendings = [], chats = [];
  globalThis.__apiImpl = (_m, p) => {
    if (p === '/api/timeline' || p === '/api/prompter') return Promise.resolve({});
    if (p === '/api/chat?limit=200') return new Promise(r => chats.push(r));
    return new Promise(r => pendings.push(r));
  };
  live.connect('test'); // registra el handler 'chat' (sin abrir el SSE falso)
  const snapshot = [{ id: 'a', user: 'u', text: 'a', platform: 'twitch', at: 0 }];

  const p1 = live.load(); // carga A (la del llamador)
  const p2 = live.load(); // carga B (la del primer open), misma ventana
  assert.equal(pendings.length, 2);
  assert.equal(chats.length, 0, 'el chat se pide después del snapshot, dentro de la misma carga');

  // B resuelve primero, con un snapshot que aún no contiene el mensaje
  pendings[1]([{ widgets: { chat: [] } }]);
  await new Promise(r => setImmediate(r)); // la carga B sigue con su petición de chat
  chats[0](snapshot);
  await p2;

  // el mensaje llega por SSE en plena carga (B resuelta, A aún en vuelo)
  globalThis.__fakeEs.emit('chat', { id: 'm1', user: 'Bot', text: 'hola', platform: 'twitch', at: 1 });

  // A resuelve después, con un snapshot más viejo que tampoco lo contiene
  pendings[0]([{ widgets: { chat: [] } }]);
  await new Promise(r => setImmediate(r));
  chats[1](snapshot);
  await p1;

  assert.ok(live.state.widgets.chat.some(m => m.id === 'm1'),
    'el mensaje recibido por SSE durante la carga A no se pierde al aplicar su snapshot');
});

// #116: si la carga más antigua resuelve la última, su instantánea pisa con valores viejos
// la configuración, el historial y el estado. Gana la más reciente.
test('la carga más antigua que resuelve al final no pisa config, history ni status', async t => {
  globalThis.EventSource = FakeEventSource;
  const { live } = await bundleLive();
  t.after(() => { delete globalThis.EventSource; delete globalThis.__apiImpl; delete globalThis.__fakeEs; });

  const pendings = [], chats = [];
  globalThis.__apiImpl = (_m, p) => {
    if (p === '/api/timeline' || p === '/api/prompter') return Promise.resolve({});
    if (p === '/api/chat?limit=200') return new Promise(r => chats.push(r));
    return new Promise(r => pendings.push(r));
  };
  live.connect('test');

  const p1 = live.load(); // carga antigua
  const p2 = live.load(); // carga reciente
  assert.equal(pendings.length, 2);

  // la reciente resuelve primero, con el estado bueno (y su chat, que también gana)
  pendings[1]({ config: { theme: 'nuevo' }, history: [{ id: 'h2' }], status: { live: true }, widgets: {} });
  await new Promise(r => setImmediate(r));
  chats[0]([{ id: 'nuevo', user: 'u', text: 'n', platform: 'twitch', at: 1 }]);
  await p2;

  // la antigua resuelve después, con una instantánea vieja que no debe aplicarse
  pendings[0]({ config: { theme: 'viejo' }, history: [{ id: 'h1' }], status: { live: false }, widgets: {} });
  await new Promise(r => setImmediate(r));
  chats[1]([{ id: 'viejo', user: 'u', text: 'v', platform: 'twitch', at: 0 }]);
  await p1;

  assert.equal(live.state.config.theme, 'nuevo', 'config: gana la carga más reciente');
  assert.deepEqual(live.state.history, [{ id: 'h2' }], 'history: gana la carga más reciente');
  assert.equal(live.state.status.live, true, 'status: gana la carga más reciente');
  assert.deepEqual(live.state.widgets.chat, [{ id: 'nuevo', user: 'u', text: 'n', platform: 'twitch', at: 1 }],
    'chat: gana la carga más reciente');
});

// Un snapshot en vuelo (gap/reconexión del SSE) que resuelve tarde no debe revertir un
// cambio optimista de config hecho durante la carga: el guard de generación (#116) solo
// ordena cargas entre sí y no ve las ediciones locales del panel (p. ej. añadir una barra
// a un objetivo). En CI esto devolvía el bloque Goals a 2 barras de forma intermitente
// hasta la siguiente carga.
test('un snapshot en vuelo que resuelve tarde no revierte un cambio optimista de config', async t => {
  globalThis.EventSource = FakeEventSource;
  const { live } = await bundleLive();
  t.after(() => { delete globalThis.EventSource; delete globalThis.__apiImpl; delete globalThis.__fakeEs; });

  const pendings = [], chats = [];
  globalThis.__apiImpl = (_m, p) => {
    if (p === '/api/timeline' || p === '/api/prompter') return Promise.resolve({});
    if (p === '/api/chat?limit=200') return new Promise(r => chats.push(r));
    return new Promise(r => pendings.push(r));
  };
  live.connect('test');

  // estado inicial: config base con dos barras
  const p0 = live.load();
  pendings[0]({ config: { widgets: { goals: [{ id: 'mixta', bars: [{ id: 'a' }, { id: 'b' }] }] } }, widgets: {} });
  await new Promise(r => setImmediate(r));
  chats[0]([]);
  await p0;

  // segunda carga en vuelo (gap/reconexión): su snapshot aún no incluye la edición
  const p1 = live.load();
  live.update(s => ({ config: { ...s.config, widgets: { ...s.config.widgets, goals: [{ id: 'mixta', bars: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }] } } }));

  // el snapshot (más viejo que la edición) resuelve después
  pendings[1]({ config: { widgets: { goals: [{ id: 'mixta', bars: [{ id: 'a' }, { id: 'b' }] }] } }, widgets: {} });
  await new Promise(r => setImmediate(r));
  chats[1]([]);
  await p1;

  assert.equal(live.state.config.widgets.goals[0].bars.length, 3,
    'la edición optimista local no se revierte con el snapshot en vuelo');
});

// #116 (cargas locales del chat, prompter y dock): una carga vieja que resuelve primero
// se aplica aunque la más nueva todavía no haya terminado — y aunque después falle.
test('chat local: la carga vieja que resuelve primero se aplica aunque la nueva luego falle', async t => {
  const { makeChatLoader } = await bundleLive();
  t.after(() => { delete globalThis.__apiImpl; });

  const resolvers = [];
  const applied = [];
  const loader = makeChatLoader(
    () => new Promise((res, rej) => resolvers.push({ res, rej })),
    (snap, ids) => applied.push({ snap, ids }),
  );

  const p1 = loader.load(); // carga antigua (arranque)
  const p2 = loader.load(); // carga nueva (primer open)
  assert.equal(resolvers.length, 2);

  resolvers[0].res([{ id: 'a', user: 'u', text: 'a', platform: 'twitch', at: 0 }]);
  await p1;

  // la carga nueva falla (red caída): lo ya aplicado debe quedarse
  resolvers[1].rej(new Error('red caída'));
  await p2;

  assert.equal(applied.length, 1, 'la carga antigua se aplicó exactamente una vez');
  assert.deepEqual(applied[0].snap, [{ id: 'a', user: 'u', text: 'a', platform: 'twitch', at: 0 }],
    'el chat muestra el snapshot de la carga vieja');
  assert.equal(loader.inflight.size, 0, 'los ids en vuelo se liberan al terminar');
});

// y en orden inverso sigue ganando la más reciente
test('chat local: la carga más antigua que resuelve al final no pisa el chat ya aplicado', async t => {
  const { makeChatLoader } = await bundleLive();
  t.after(() => { delete globalThis.__apiImpl; });

  const resolvers = [];
  const applied = [];
  const loader = makeChatLoader(
    () => new Promise((res, rej) => resolvers.push({ res, rej })),
    (snap, ids) => applied.push({ snap, ids }),
  );

  const p1 = loader.load(); // carga antigua
  const p2 = loader.load(); // carga nueva
  resolvers[1].res([{ id: 'nuevo', user: 'u', text: 'n', platform: 'twitch', at: 1 }]);
  await p2;
  resolvers[0].res([{ id: 'viejo', user: 'u', text: 'v', platform: 'twitch', at: 0 }]);
  await p1;

  assert.equal(applied.length, 1, 'solo se aplicó la carga más reciente');
  assert.deepEqual(applied[0].snap, [{ id: 'nuevo', user: 'u', text: 'n', platform: 'twitch', at: 1 }]);
});
