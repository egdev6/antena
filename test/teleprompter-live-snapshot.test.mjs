// Snapshot de /api/state en vuelo frente a cambios locales del teleprompter (fallo intermitente
// de «O3.2 teleprompter» en CI, Windows Node 22). El panel hace load() y luego connect(); el
// 'open' del SSE lanza una segunda load(). Si se pulsa la pestaña de otro guion mientras esa
// carga vuela, la respuesta de POST /select y el evento 'teleprompter' ya dejan «Guion B», pero
// el snapshot (generado antes del clic) resolvía después y devolvía el guion anterior: la
// pestaña y el título se quedaban revertidos aunque el servidor tuviera «Guion B» activo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

class FakeEventSource {
  constructor() { globalThis.__fakeEs = this; this._listeners = {}; }
  addEventListener(name, fn) { (this._listeners[name] ||= []).push(fn); }
  emit(name, data) { for (const fn of this._listeners[name] || []) fn({ data: JSON.stringify(data) }); }
}

// Mismo empaquetado que test/live-load-race.test.mjs: live.ts con stubs de react/api/events.
async function bundleLive() {
  const esbuild = await import('esbuild');
  const ts = await readFile(path.join(ROOT, 'app/src/lib/live.ts'), 'utf8');
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
  const dir = await mkdtemp(path.join(tmpdir(), 'egdev-tp-snapshot-'));
  const file = path.join(dir, 'live.test.mjs');
  await writeFile(file, bundled);
  return import(pathToFileURL(file).href);
}

const tp = (activeId, title) => ({ activeId, scripts: [{ id: 'a', title: 'Guion A' }, { id: 'b', title: 'Guion B' }], script: { id: activeId, title } });
const snap = extra => ({ config: {}, widgets: {}, teleprompter: tp('a', 'Guion A'), interactive: { active: 'x' }, timers: [{ id: 't0' }], ...extra });

// Carga inicial resuelta y segunda carga (la del 'open' del SSE) en vuelo con un snapshot viejo.
async function withSecondLoadInFlight(t) {
  globalThis.EventSource = FakeEventSource;
  const { live } = await bundleLive();
  t.after(() => { delete globalThis.EventSource; delete globalThis.__apiImpl; delete globalThis.__fakeEs; });
  const states = [], chats = [];
  globalThis.__apiImpl = (m, p) => {
    if (p === '/api/timeline' || p === '/api/prompter') return Promise.resolve({});
    if (p === '/api/chat?limit=200') return new Promise(r => chats.push(r));
    return new Promise(r => states.push(r));
  };
  live.connect('test');
  const first = live.load();
  states[0](snap());
  await new Promise(r => setImmediate(r));
  chats[0]([]);
  await first;
  const second = live.load();
  const resolveSecond = async state => { states[1](state); await new Promise(r => setImmediate(r)); chats[1]([]); await second; };
  return { live, resolveSecond };
}

test('un snapshot en vuelo no revierte el guion elegido (respuesta de /select y evento SSE)', async t => {
  const { live, resolveSecond } = await withSecondLoadInFlight(t);
  // clic en «Guion B»: pickScript aplica la respuesta de POST /select y llega el evento SSE
  live.update(() => ({ teleprompter: tp('b', 'Guion B') }));
  globalThis.__fakeEs.emit('teleprompter', tp('b', 'Guion B'));
  await resolveSecond(snap());   // generado antes del clic
  assert.equal(live.state.teleprompter.activeId, 'b', 'el guion elegido sigue activo');
  assert.equal(live.state.teleprompter.script.title, 'Guion B');
});

test('lo mismo con otras porciones que llegan completas por SSE (interactivos, mensajes)', async t => {
  const { live, resolveSecond } = await withSecondLoadInFlight(t);
  globalThis.__fakeEs.emit('interactive', { active: 'y' });
  globalThis.__fakeEs.emit('timers', [{ id: 't0' }, { id: 't1' }]);
  await resolveSecond(snap());
  assert.equal(live.state.interactive.active, 'y');
  assert.equal(live.state.timers.length, 2);
});

test('sin cambios locales durante el vuelo, el snapshot sí manda', async t => {
  const { live, resolveSecond } = await withSecondLoadInFlight(t);
  await resolveSecond(snap({ teleprompter: tp('b', 'Guion B'), interactive: { active: 'z' } }));
  assert.equal(live.state.teleprompter.activeId, 'b');
  assert.equal(live.state.interactive.active, 'z');
});

// meld llega por partes: el evento SSE solo trae la sesión. Si llega durante el vuelo se
// conserva esa sesión, pero el resto de meld (commands, events…) sigue viniendo del snapshot.
test('meld: un evento de sesión en vuelo conserva la sesión y el resto llega del snapshot', async t => {
  const { live, resolveSecond } = await withSecondLoadInFlight(t);
  globalThis.__fakeEs.emit('meld', { live: true });
  await resolveSecond(snap({ meld: { session: { live: false }, commands: ['nuevo'], events: ['e2'] } }));
  assert.deepEqual(live.state.meld.session, { live: true }, 'la sesión recibida durante el vuelo gana');
  assert.deepEqual(live.state.meld.commands, ['nuevo'], 'el resto de meld llega del snapshot');
  assert.deepEqual(live.state.meld.events, ['e2']);
});
