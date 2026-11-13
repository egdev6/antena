// #149 / S5: la cuenta se detiene fuera de directo y vuelve a empezar completa al emitir.
// Solo se observan /api/timers, los envíos y la interfaz pública del planificador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import { createApp } from '../src/server.mjs';

const MIN = 60_000;

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-timer-live-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  app.store.config.meld.autoSession = false;
  const sent = [];
  app.twitch.sendChat = async text => { sent.push(text); return { is_sent: true }; };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (method, url, body) => fetch(base + url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (method, url, body) => {
    const response = await request(method, url, body);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.after(async () => {
    await new Promise(resolve => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(resolve); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const advance = ms => t.mock.timers.tick(ms);
  const tick = () => app.timers.tick(Date.now());
  const timer = async fields => (await call('POST', '/api/timers', { message: 'Hola chat', intervalMin: 1, minChatLines: 0, ...fields })).timer;
  const row = async id => (await call('GET', '/api/timers')).find(timer => timer.id === id);
  const live = (streaming, state = 'conectado') => app.meld.setStatus({ state, streaming });
  return { app, sent, request, call, advance, tick, timer, row, live };
}

test('S5: sin directo ni Meld confirmado la cuenta del timer por defecto permanece congelada', async t => {
  const { sent, advance, tick, timer, row, live } = await start(t);
  const tm = await timer({ intervalMin: 5 });
  assert.equal(tm.onlyWhenLive, true);
  const first = await row(tm.id);
  assert.equal(first.runtime.pausedOffStream, true);
  assert.equal(first.runtime.nextInSec, 300);
  assert.equal(first.runtime.blockedBy, null, 'el campo anterior sigue indicando si un vencimiento está bloqueado');
  advance(10 * MIN);
  assert.deepEqual(await tick(), []);
  const later = await row(tm.id);
  assert.equal(later.runtime.pausedOffStream, true);
  assert.equal(later.runtime.nextInSec, 300);
  assert.equal(later.runtime.runs, 0);
  assert.deepEqual(sent, []);
  live(false);
  advance(2 * MIN);
  assert.equal((await row(tm.id)).runtime.nextInSec, 300, 'con Meld conectado pero sin emitir sigue en pausa');
});

test('S5: al volver al directo los mensajes esperan su propio intervalo completo y conservan las líneas', async t => {
  const { sent, call, advance, tick, timer, row, live } = await start(t);
  live(true);
  const a = await timer({ name: 'A', message: 'Mensaje A', minChatLines: 1 });
  const b = await timer({ name: 'B', message: 'Mensaje B', intervalMin: 2 });
  await row(a.id);
  await call('POST', '/api/chat/simulate', { user: 'ana', text: 'hola' });
  advance(30_000);
  live(false);
  const stopped = await row(a.id);
  assert.equal(stopped.runtime.pausedOffStream, true);
  assert.equal(stopped.runtime.nextInSec, 30);
  advance(10 * MIN);
  assert.deepEqual(await tick(), []);
  assert.equal((await row(a.id)).runtime.nextInSec, 30);
  live(true);
  assert.deepEqual(await tick(), [], 'lo vencido fuera del directo no se envía al volver');
  assert.equal((await row(a.id)).runtime.nextInSec, 60);
  assert.equal((await row(b.id)).runtime.nextInSec, 120);
  assert.equal((await row(a.id)).runtime.lines, 1);
  advance(MIN - 1000);
  assert.deepEqual(await tick(), []);
  assert.deepEqual(sent, []);
  advance(1000);
  assert.deepEqual(await tick(), [a.id]);
  assert.deepEqual(sent, ['Mensaje A']);
  assert.equal((await row(a.id)).runtime.runs, 1);
  advance(MIN);
  assert.deepEqual(await tick(), [b.id], 'A espera más líneas; B cumple su intervalo');
  assert.deepEqual(sent, ['Mensaje A', 'Mensaje B']);
});

test('S5: no envía de inmediato un timer vencido al iniciar el directo', async t => {
  const { sent, advance, tick, timer, row, live } = await start(t);
  const tm = await timer({});
  await row(tm.id);
  advance(10 * MIN);
  live(true);
  assert.deepEqual(await tick(), []);
  assert.deepEqual(sent, []);
  assert.equal((await row(tm.id)).runtime.runs, 0);
  advance(MIN);
  assert.deepEqual(await tick(), [tm.id]);
  assert.deepEqual(sent, ['Hola chat']);
});

test('S5: el instante de inicio se observa aunque no haya repasos ni consultas entre estados', async t => {
  const { sent, advance, tick, timer, row, live } = await start(t);
  live(true);
  const tm = await timer({});
  await row(tm.id);
  advance(20_000);
  live(false);
  advance(5 * MIN);
  live(true);
  advance(15_000);
  assert.equal((await row(tm.id)).runtime.nextInSec, 45, 'el intervalo empezó al recibir el estado, no en la consulta');
  assert.deepEqual(await tick(), []);
  advance(45_000);
  assert.deepEqual(await tick(), [tm.id]);
  assert.deepEqual(sent, ['Hola chat']);
});

test('S5: una desconexión de Meld congela y la reconexión emitiendo reinicia el intervalo', async t => {
  const { sent, advance, tick, timer, row, live } = await start(t);
  live(true);
  const tm = await timer({});
  await row(tm.id);
  advance(20_000);
  live(true, 'reintentando');
  assert.equal((await row(tm.id)).runtime.pausedOffStream, true);
  advance(3 * MIN);
  assert.equal((await row(tm.id)).runtime.nextInSec, 40);
  live(true);
  assert.deepEqual(await tick(), []);
  assert.equal((await row(tm.id)).runtime.nextInSec, 60);
  advance(MIN);
  assert.deepEqual(await tick(), [tm.id]);
  assert.deepEqual(sent, ['Hola chat']);
});

test('preserva: sin solo directo cuenta y envía fuera de directo, también al cambiar el estado de Meld', async t => {
  const { sent, advance, tick, timer, row, live } = await start(t);
  const tm = await timer({ onlyWhenLive: false });
  assert.equal((await row(tm.id)).runtime.nextInSec, 60);
  advance(20_000);
  assert.equal((await row(tm.id)).runtime.nextInSec, 40);
  live(true);
  assert.equal((await row(tm.id)).runtime.nextInSec, 40);
  live(false);
  advance(39_000);
  assert.deepEqual(await tick(), []);
  advance(1000);
  assert.deepEqual(await tick(), [tm.id]);
  assert.deepEqual(sent, ['Hola chat']);
  assert.equal((await row(tm.id)).runtime.runs, 1);
});

test('S5: al activar solo directo fuera de emisión se congela la cuenta existente', async t => {
  const { sent, call, advance, tick, timer, row, live } = await start(t);
  live(false);
  const tm = await timer({ onlyWhenLive: false });
  await row(tm.id);
  advance(20_000);
  await call('PUT', `/api/timers/${tm.id}`, { onlyWhenLive: true });
  assert.equal((await row(tm.id)).runtime.nextInSec, 40);
  advance(5 * MIN);
  assert.equal((await row(tm.id)).runtime.nextInSec, 40);
  assert.deepEqual(await tick(), []);
  assert.deepEqual(sent, []);
  live(true);
  assert.equal((await row(tm.id)).runtime.nextInSec, 60);
  advance(MIN);
  assert.deepEqual(await tick(), [tm.id]);
  assert.deepEqual(sent, ['Hola chat']);
});

test('preserva: Enviar ahora funciona en directo, se bloquea fuera y sigue permitido sin solo directo', async t => {
  const { sent, request, call, timer, row, live } = await start(t);
  live(true);
  const a = await timer({ name: 'Live', message: 'En directo' });
  const b = await timer({ message: 'Libre', onlyWhenLive: false });
  const first = await call('POST', `/api/timers/${a.id}/fire`);
  assert.equal(first.error, null);
  assert.deepEqual(sent, ['En directo']);
  live(false);
  const before = await row(a.id);
  const rejected = await request('POST', `/api/timers/${a.id}/fire`);
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'No se envía «Live»: no estás emitiendo.' });
  const after = await row(a.id);
  assert.equal(after.runtime.runs, before.runtime.runs);
  assert.equal(after.runtime.lastRunAt, before.runtime.lastRunAt);
  assert.equal(after.runtime.lines, before.runtime.lines);
  assert.deepEqual(sent, ['En directo']);
  const free = await call('POST', `/api/timers/${b.id}/fire`);
  assert.equal(free.error, null);
  assert.deepEqual(sent, ['En directo', 'Libre']);
  assert.equal((await row(b.id)).runtime.runs, 1);
});

// Mismo empaquetado en memoria usado por los tests de live.ts: se renderizan los componentes
// reales con el estado de la API, sin generar app/dist ni crear un arnés de navegador nuevo.
test('S5: lista y editor representan la pausa sin punto verde y conservan los otros estados', async t => {
  t.after(() => stop());
  const result = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { Mensajes } from './app/src/panel/views/Comandos';
      import { TimerState } from './app/src/panel/views/Editor';
      export function render(row) {
        globalThis.__timerRenderState = { timers: [row] };
        return [renderToStaticMarkup(React.createElement(Mensajes, { parts: [] })),
          renderToStaticMarkup(React.createElement(TimerState, { id: row.id }))];
      }
    ` },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'live-fixture', setup(b) {
      b.onResolve({ filter: /(^|\/)lib\/live$/ }, () => ({ path: 'live', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useLive = select => select(globalThis.__timerRenderState); export const live = { update() {} };' }));
    } }],
  });
  const oldLocation = globalThis.location;
  globalThis.location = { hash: '#/mensajes' };
  t.after(() => { globalThis.location = oldLocation; delete globalThis.__timerRenderState; });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
  const ui = module.exports;
  const row = { id: 'a', name: 'Prueba', message: 'Hola', intervalMin: 1, enabled: true,
    runtime: { pausedOffStream: true, nextInSec: 30, lines: 0, lastError: 'fallo anterior' } };
  const [list, editor] = ui.render(row);
  assert.match(list, /<span class="lv-dot is-off">En pausa: no estás en directo<\/span>/);
  assert.match(editor, /^En pausa: no estás en directo · 0 mensajes en el chat desde el último/);
  assert.doesNotMatch(list, /Sale en 30 s/);
  assert.doesNotMatch(editor, /Siguiente en 30 s/);
  const [runningList, runningEditor] = ui.render({ ...row, runtime: { nextInSec: 30 } });
  assert.match(runningList, /<span class="lv-dot is-ok">Sale en 30 s<\/span>/);
  assert.match(runningEditor, /^Siguiente en 30 s/);
  const [offList, offEditor] = ui.render({ ...row, enabled: false });
  assert.match(offList, /<span class="lv-dot is-off">Apagado<\/span>/);
  assert.match(offEditor, /^Desactivado/);
});

test('preserva: pausa global bloquea Enviar ahora y al reanudar ambos tipos esperan su intervalo', async t => {
  const { sent, request, call, advance, tick, timer, row, live } = await start(t);
  live(true);
  const a = await timer({ name: 'Live', message: 'Live' });
  const b = await timer({ name: 'Libre', message: 'Libre', onlyWhenLive: false });
  await row(a.id);
  await call('POST', '/api/pause');
  advance(3 * MIN);
  assert.deepEqual(await tick(), []);
  const rejected = await request('POST', `/api/timers/${a.id}/fire`);
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'No se envía «Live»: pausa activa.' });
  assert.equal((await row(a.id)).runtime.runs, 0);
  assert.deepEqual(sent, []);
  await call('POST', '/api/resume', {});
  assert.deepEqual(await tick(), []);
  advance(MIN - 1000);
  assert.deepEqual(await tick(), []);
  advance(1000);
  assert.deepEqual(await tick(), [a.id, b.id]);
  assert.deepEqual(sent, ['Live', 'Libre']);
});
