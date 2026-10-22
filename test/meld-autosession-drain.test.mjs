// ODD-08 · Cierre del inicio automático de sesión de Meld: los seams nuevos fallan sin colgarse. Tests-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createJsonWriter } from '../src/json-file.mjs';

const settle = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const alert = (id, user) => ({ id, type: 'follow', at: new Date().toISOString(), vars: { user }, text: user, sub: '' });
const requireSeams = app => {
  assert.equal(typeof app.beginAutoSessionDrain, 'function', 'seam público beginAutoSessionDrain');
  assert.equal(typeof app.drainAutoSession, 'function', 'seam público drainAutoSession');
};
// El rechazo del listener puede escapar en la base; se consume y en GREEN no debe quedar fuga.
function swallowUnhandled(t) {
  const seen = [];
  const on = e => { seen.push(e); };
  process.on('unhandledRejection', on);
  t.after(() => process.off('unhandledRejection', on));
  return seen;
}
// Writer real con puerta dentro del job encolado (`after`): conserva el FIFO por ruta y deja la transición en vuelo.
function gatedWriter({ entered, promise }, name = 'session-current.json') {
  const base = createJsonWriter();
  return (file, data, opts = {}) => base(file, JSON.parse(JSON.stringify(data)), {
    after: Promise.resolve(opts.after).then(async () => {
      if (path.basename(file) !== name) return;
      entered.resolve();
      await promise;
    }),
  });
}
// App real (sin Meld externo); cada test libera sus puertas ANTES de cerrar el transporte.
async function startApp(t, { writer, release } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'meld-autosession-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const logs = [];
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: m => logs.push(String(m)) });
  if (writer) app.session.writer = writer;
  app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
  const calls = [];
  const real = app.session.startNew.bind(app.session);
  let impl = (...args) => real(...args);
  app.session.startNew = (...args) => {
    const p = Promise.resolve().then(() => impl(...args));
    calls.push(p);
    return p;
  };
  t.after(async () => {
    try { release?.(); } catch { /* la limpieza no debe enmascarar el resultado */ }
    await app.closeHttp().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { app, dataDir, logs, calls, setStartNew: fn => { impl = fn; } };
}

test('filtros: solo live=true con meld.autoSession habilitado inicia la sesión automática', { timeout: 10000 }, async t => {
  const { app, calls } = await startApp(t);
  app.meld.emit('streaming', false);
  await settle();
  assert.equal(calls.length, 0, 'live=false no inicia');
  app.store.config.meld.autoSession = false;
  app.meld.emit('streaming', true);
  await settle();
  assert.equal(calls.length, 0, 'autoSession deshabilitado no inicia');
  app.store.config.meld.autoSession = true;
  app.meld.emit('streaming', true);
  await settle();
  assert.equal(calls.length, 1, 'live=true con autoSession habilita el inicio');
  await Promise.allSettled(calls);
});

test('beginAutoSessionDrain sella de forma síncrona, es idempotente y los inicios posteriores se ignoran', { timeout: 10000 }, async t => {
  const { app, calls } = await startApp(t);
  requireSeams(app);
  const first = app.beginAutoSessionDrain();
  assert.equal(app.beginAutoSessionDrain(), first, 'begin idempotente');
  app.meld.emit('streaming', true);
  await settle();
  assert.equal(calls.length, 0, 'tras el sello no se admite un inicio automático nuevo');
  assert.equal(await app.drainAutoSession(), undefined, 'sin pendientes el drenado resuelve');
  assert.equal(app.drainAutoSession(), app.drainAutoSession(), 'promesa de drenado cacheada');
});

test('espera el inicio aceptado con transición real y archivo pendiente antes de resolver', { timeout: 15000 }, async t => {
  const hold = deferred(); const entered = deferred();
  const { app, dataDir, calls } = await startApp(t, { writer: gatedWriter({ entered, promise: hold.promise }), release: hold.resolve });
  requireSeams(app);
  app.session.record(alert('e1', 'ana'));
  const oldId = app.session.data.id;
  app.meld.emit('streaming', true);
  await entered.promise;
  assert.equal(calls.length, 1, 'el listener aceptó el inicio automático');
  app.beginAutoSessionDrain();
  const drained = app.drainAutoSession();
  let settled = false;
  drained.then(() => { settled = true; }, () => { settled = true; });
  await settle();
  assert.equal(settled, false, 'el drenado espera la transición real pendiente');
  hold.resolve();
  await drained;
  assert.equal(settled, true);
  const archived = JSON.parse(await readFile(path.join(dataDir, 'sessions', oldId + '.json'), 'utf8'));
  assert.equal(archived.id, oldId);
  assert.equal(typeof archived.endedAt, 'string');
  assert.ok(archived.events.some(e => e.id === 'e1'), 'el directo anterior se archivó completo');
  const current = JSON.parse(await readFile(path.join(dataDir, 'session-current.json'), 'utf8'));
  assert.notEqual(current.id, oldId, 'el nuevo directo quedó como actual');
  assert.equal(current.events.length, 0);
});

test('un inicio fallido antes del corte queda excluido del drenado', { timeout: 10000 }, async t => {
  const seen = swallowUnhandled(t);
  const { app, calls, setStartNew } = await startApp(t);
  requireSeams(app);
  setStartNew(() => Promise.reject(new Error('historial-privado')));
  app.meld.emit('streaming', true);
  await Promise.allSettled(calls);
  assert.equal(calls.length, 1, 'el inicio se intentó y terminó antes de la señal');
  app.beginAutoSessionDrain();
  assert.equal(await app.drainAutoSession(), undefined, 'el fallo terminado antes de la señal no envenena');
  assert.equal(seen.length, 0, 'sin unhandledRejection del listener');
});

test('un rechazo capturado durante el drenado rechaza la misma promesa y no filtra el motivo', { timeout: 10000 }, async t => {
  const seen = swallowUnhandled(t);
  const failure = deferred();
  const { app, calls, logs, setStartNew } = await startApp(t);
  requireSeams(app);
  setStartNew(() => failure.promise);
  app.meld.emit('streaming', true);
  app.beginAutoSessionDrain();
  const drained = app.drainAutoSession();
  failure.reject(new Error('privado-reject'));
  await assert.rejects(drained, /privado-reject/);
  assert.equal(app.drainAutoSession(), drained, 'el rechazo también se cachea');
  await Promise.allSettled(calls);
  assert.doesNotMatch(logs.join('\n'), /privado-reject/);
  assert.equal(seen.length, 0, 'sin unhandledRejection del listener');
});

test('un throw síncrono de startNew se captura y rechaza el drenado cacheado sin escapar', { timeout: 10000 }, async t => {
  const seen = swallowUnhandled(t);
  const { app, logs } = await startApp(t);
  requireSeams(app);
  app.session.startNew = () => { throw new Error('privado-throw'); };
  app.meld.emit('streaming', true);
  app.beginAutoSessionDrain();
  const drained = app.drainAutoSession();
  await assert.rejects(drained, /privado-throw/);
  assert.equal(app.drainAutoSession(), drained, 'el rechazo también se cachea');
  assert.doesNotMatch(logs.join('\n'), /privado-throw/);
  assert.equal(seen.length, 0, 'sin unhandledRejection del listener');
});

test('retiene un fallo tras el corte y espera otros inicios antes de rechazar', async t => {
  const first = deferred(), second = deferred();
  const { app, setStartNew } = await startApp(t, { release: () => { first.resolve(); second.resolve(); } });
  let calls = 0;
  setStartNew(() => ++calls === 1 ? first.promise : second.promise);
  app.meld.emit('streaming', true);
  app.meld.emit('streaming', true);
  await settle();
  assert.equal(calls, 2);
  app.beginAutoSessionDrain();
  first.reject(new Error('capturado-antes-del-drain'));
  await settle(); // El fallo termina mientras otros drenajes del cierre podrían estar esperando.
  const drained = app.drainAutoSession();
  const rejected = assert.rejects(drained, /capturado-antes-del-drain/);
  let finished = false;
  drained.then(() => { finished = true; }, () => { finished = true; });
  await settle();
  assert.equal(finished, false, 'un fallo no omite los demás inicios capturados');
  second.resolve();
  await rejected;
  assert.equal(app.drainAutoSession(), drained);
});
