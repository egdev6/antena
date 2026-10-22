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
async function bundleLive() {
  const esbuild = await import('esbuild');
  const ts = await (await import('node:fs/promises')).readFile(path.join(ROOT, 'app/src/lib/live.ts'), 'utf8');
  const stub = 'export const useSyncExternalStore = () => () => {};\n' +
    'export const warnUnknownClientEvent = () => false;\n' +
    'export const api = (m, p, b) => globalThis.__apiImpl(m, p, b);\n' +
    'export const withKey = (u) => u;';
  const bundled = await esbuild.build({
    stdin: { contents: ts, resolveDir: path.join(ROOT, 'app/src/lib'), loader: 'ts', sourcefile: 'live.ts' },
    bundle: true, format: 'esm', write: false,
    plugins: [{
      name: 'stub',
      setup(b) {
        b.onResolve({ filter: /^(react|\.\/api|.*events\.mjs)$/ }, a => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: stub, loader: 'js' }));
      },
    }],
  }).then(r => r.outputFiles[0].text);
  const dir = await mkdtemp(path.join(tmpdir(), 'egdev-load-race-'));
  const file = path.join(dir, 'live.test.mjs');
  await writeFile(file, bundled);
  return import(pathToFileURL(file).href);   // en Windows, import() exige file://
}

test('cargas solapadas que resuelven en orden inverso no pierden el chat en curso', async t => {
  globalThis.EventSource = FakeEventSource;
  const { live } = await bundleLive();
  t.after(() => { delete globalThis.EventSource; delete globalThis.__apiImpl; delete globalThis.__fakeEs; });

  // cada GET /api/state y /api/chat?limit=200 (#115: ventana propia del panel) queda a la
  // espera de que el test lo resuelva; el orden es state y luego chat dentro de cada carga.
  const pendings = [], chats = [];
  globalThis.__apiImpl = (m, p) => {
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
  globalThis.__apiImpl = (m, p) => {
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
