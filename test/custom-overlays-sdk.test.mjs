// SDK de los overlays propios (S6): public/custom/sdk.js es un script clásico que solo
// escucha los mensajes que le manda su shell. Aquí se ejecuta en un contexto de vm con un
// `window` de mentira: nada de navegador, pero el contrato real del script servido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_SOURCE = await readFile(path.join(ROOT, 'public', 'custom', 'sdk.js'), 'utf8');

/** Carga el SDK en un contexto aislado y devuelve `window`, el padre falso y cómo entregar mensajes. */
function loadSdk() {
  const delivered = [];   // lo que el SDK enviara hacia fuera (debe quedarse vacío siempre)
  const parent = { postMessage: (msg, origin) => delivered.push({ msg, origin }) };
  const listeners = [];
  const win = {
    parent,
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    removeEventListener(type, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  };
  win.window = win;
  const context = vm.createContext({ window: win, console, setTimeout, Promise });
  vm.runInContext(SDK_SOURCE, context, { filename: 'public/custom/sdk.js' });
  /** Entrega un mensaje como lo haría el navegador: del padre (por defecto) al marco. */
  const deliver = (data, source = parent) => { for (const fn of [...listeners]) fn({ source, data }); };
  return { win, antena: win.antena, parent, deliver, listeners, delivered };
}

const alertMsg = (user, extra = {}) => ({ antena: 1, event: 'alert', data: { type: 'follow', user, ...extra } });

test('el SDK expone on, off, state y ready, y solo acepta mensajes del padre con antena: 1', () => {
  const { antena, parent, deliver, delivered } = loadSdk();
  assert.equal(typeof antena.on, 'function');
  assert.equal(typeof antena.off, 'function');
  assert.equal(typeof antena.state, 'object');
  assert.equal(typeof antena.ready.then, 'function');

  const seen = [];
  antena.on('alert', a => seen.push(a));
  deliver(alertMsg('a'));
  deliver(alertMsg('b'), { noSoyElPadre: true });      // otro origen: se ignora
  deliver({ event: 'alert', data: { user: 'c' } });     // sin la marca antena: 1: se ignora
  deliver({ antena: 1, event: { nombre: 'alert' } });    // nombre de evento no textual: se ignora
  deliver({ antena: 1, event: 'exec', data: {} });      // evento no documentado: se ignora
  deliver(null);                                       // basura: no rompe
  deliver('texto');                                    // basura: no rompe

  assert.deepEqual(seen, [{ type: 'follow', user: 'a' }]);
  assert.deepEqual(antena.state.alert, { type: 'follow', user: 'a' });
  assert.equal('exec' in antena.state, false, 'un evento desconocido no entra en el estado');
  // Solo entrada: el SDK nunca publica nada (las acciones son de T5).
  assert.deepEqual(delivered, []);
});

test('on devuelve la baja, off da de baja por función y cada suscripción es independiente', () => {
  const { antena, deliver } = loadSdk();
  const calls = [];
  const fn = m => calls.push('fn:' + m.user);
  const other = m => calls.push('other:' + m.user);
  const offFirst = antena.on('chat', fn);
  const offSecond = antena.on('chat', fn);
  antena.on('chat', other);
  assert.equal(typeof offFirst, 'function');

  deliver({ antena: 1, event: 'chat', data: { user: 'x' } });
  assert.deepEqual(calls, ['fn:x', 'fn:x', 'other:x']);

  offFirst();
  calls.length = 0;
  deliver({ antena: 1, event: 'chat', data: { user: 'y' } });
  assert.deepEqual(calls, ['fn:y', 'other:y']);

  offSecond();
  antena.off('chat', other);
  calls.length = 0;
  deliver({ antena: 1, event: 'chat', data: { user: 'z' } });
  assert.deepEqual(calls, [], 'off desuscribe; repetir la baja no rompe nada');
  antena.off('chat', other);
  offFirst();
  assert.throws(() => antena.on('chat', 'no soy una función'), { name: 'TypeError' });
});

test('state guarda el último valor de cada evento y on entrega el snapshot actual al suscribirse', () => {
  const { antena, deliver } = loadSdk();
  assert.deepEqual(Object.keys(antena.state).sort(), ['alert', 'chat', 'interactive', 'theme', 'viewers', 'widgets']);
  for (const ev of Object.keys(antena.state)) assert.equal(antena.state[ev], null, `${ev} empieza a null`);

  deliver({ antena: 1, event: 'widgets', data: { totals: { follows: 3 } } });
  deliver({ antena: 1, event: 'widgets', data: { totals: { follows: 7 } } });
  assert.deepEqual(antena.state.widgets, { totals: { follows: 7 } }, 'el último snapshot manda');

  const late = [];
  antena.on('widgets', s => late.push(s.totals.follows));
  assert.deepEqual(late, [7], 'una suscripción tardía recibe el snapshot que ya había');
  deliver({ antena: 1, event: 'chat', data: { user: 'a' } });
  deliver({ antena: 1, event: 'chat', data: { user: 'b' } });
  assert.equal(antena.state.chat.user, 'b', 'chat guarda el último mensaje');
  assert.deepEqual(antena.state.viewers, null, 'un evento sin datos sigue a null');
});

test('ready se resuelve cuando la shell avisa de que ya está conectada, antes de cualquier evento', async () => {
  const { antena, deliver } = loadSdk();
  let resolved = false;
  antena.ready.then(() => { resolved = true; });
  deliver({ antena: 1, event: 'theme', data: { accent: '#FF0036' } });
  await Promise.resolve();
  assert.equal(resolved, false, 'un evento normal no resuelve ready');
  deliver({ antena: 1, ready: true });
  await antena.ready;
  assert.equal(resolved, true);
  assert.deepEqual(antena.state.theme, { accent: '#FF0036' }, 'los snapshots previos ya están en state');
});

test('los seis eventos de la especificación llegan al manejador con sus datos', () => {
  const { antena, deliver } = loadSdk();
  const got = [];
  for (const ev of ['alert', 'chat', 'viewers', 'widgets', 'interactive', 'theme']) antena.on(ev, d => got.push([ev, d]));
  deliver({ antena: 1, event: 'alert', data: { user: 'a' } });
  deliver({ antena: 1, event: 'chat', data: { user: 'b', text: 'hola' } });
  deliver({ antena: 1, event: 'viewers', data: { platforms: {} } });
  deliver({ antena: 1, event: 'widgets', data: { totals: {} } });
  deliver({ antena: 1, event: 'interactive', data: { questions: {} } });
  deliver({ antena: 1, event: 'theme', data: { accent: '#00D1FF' } });
  assert.deepEqual(got.map(([ev]) => ev), ['alert', 'chat', 'viewers', 'widgets', 'interactive', 'theme']);
});
