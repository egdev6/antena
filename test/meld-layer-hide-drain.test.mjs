import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const show = layer => ({ scene: { id: 'scene-1', name: 'Escena' }, layer: { id: String(layer), name: 'Capa' } });

// Nada de dormir un tiempo fijo como oráculo: se espera la condición observable y se cede el bucle
// de eventos (incluida la fase de temporizadores) hasta verla. El plazo de seguridad es acotado y
// FALLA la prueba en lugar de colgarse si la condición nunca llega.
const SAFETY_MS = 2000;
async function waitFor(predicate, label) {
  const deadline = Date.now() + SAFETY_MS;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`plazo de seguridad de ${SAFETY_MS} ms agotado sin observar: ${label}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}
// Barrera de microtareas (no es una espera por tiempo): deja asentar los registros ya resueltos.
const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));
const postLayer = (base, body) => fetch(`${base}/api/meld/layer`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// App real con listener loopback efímero; solo se sustituye meld.setLayer (sin Meld externo) y se
// conserva la ruta HTTP pública de admisión. El temporizador de horario NO se falsea en general:
// cada prueba decide su reloj y limpia al terminar.
async function startApp(t, impl, releasePending = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'meld-layer-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const logs = [];
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: m => logs.push(String(m)) });
  Object.defineProperty(app.meld, 'connected', { value: true });
  const calls = [];
  app.meld.setLayer = (...args) => { calls.push(args); return impl(...args); };
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    releasePending();
    await app.closeHttp().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { app, base, calls, logs };
}

test('conserva el retardo original, no adelanta y espera el setLayer en vuelo', { timeout: 10000 }, async t => {
  let resolveHide;
  const { app, base, calls } = await startApp(t, (scene, layer, visible) => {
    if (visible === false) return new Promise(resolve => { resolveHide = resolve; });
    return show(layer);
  });
  const scheduled = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    if (ms === 150) { scheduled.push(fn); return { unref() {} }; }
    return real(fn, ms, ...rest);
  };
  let res;
  try { res = await postLayer(base, { scene: 'Escena', layer: 'Capa', visible: true, seconds: 0.15 }); }
  finally { globalThis.setTimeout = real; }
  assert.equal(res.status, 200);
  assert.equal(scheduled.length, 1, 'el horario debe ser seconds*1000 (segundos fraccionarios)');
  app.beginLayerHideDrain();   // señal síncrona tras aceptar el handler
  assert.equal(app.beginLayerHideDrain(), true, 'begin idempotente');
  const drained = app.drainLayerHides();
  assert.equal(app.drainLayerHides(), drained, 'drenado cacheado y idempotente');
  let done = false;
  drained.then(() => { done = true; }, () => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false, 'el drenaje espera el temporizador todavía pendiente');
  assert.deepEqual(calls.filter(c => c[2] === false), [], 'el drenaje no debe adelantar el ocultado');
  scheduled[0](); // Solo el reloj de la prueba dispara el horario original.
  await new Promise(resolve => setImmediate(resolve));
  const hides = calls.filter(c => c[2] === false);
  assert.equal(hides.length, 1);
  assert.deepEqual(hides[0].slice(0, 2), ['scene-1', 'Capa']);
  assert.equal(done, false, 'debe esperar el meld.setLayer en vuelo, no solo el temporizador');
  resolveHide({ scene: { id: 'scene-1' }, layer: { id: 'Capa' } });
  assert.equal(await drained, undefined);
  assert.equal(app.drainLayerHides(), drained, 'mismo drenado tras sellar');
});

test('rechazo y throw capturados drenan todas las tareas y fallan sin filtrar el motivo', { timeout: 10000 }, async t => {
  const tried = [];
  const { app, base, logs } = await startApp(t, (scene, layer, visible) => {
    if (visible !== false) return show(layer);
    tried.push(layer);
    if (layer === 'CapaThrow') throw new Error('secreto-throw');
    return Promise.reject(new Error('secreto-reject'));
  });
  await postLayer(base, { scene: 'Escena', layer: 'CapaReject', visible: true, seconds: 0.03 });
  await postLayer(base, { scene: 'Escena', layer: 'CapaThrow', visible: true, seconds: 0.03 });
  app.beginLayerHideDrain();
  await waitFor(() => tried.length === 2, 'ambos ocultados programados se ejecutaron');
  assert.deepEqual([...tried].sort(), ['CapaReject', 'CapaThrow'], 'ambas tareas capturadas se ejecutaron');
  await assert.rejects(app.drainLayerHides(), /secreto/);
  assert.equal(app.drainLayerHides(), app.drainLayerHides(), 'el rechazo también se cachea');
  assert.doesNotMatch(logs.join('\n'), /secreto/);
});

test('un fallo terminado antes de la señal no envenena el drenado posterior', { timeout: 10000 }, async t => {
  const tried = [];
  const { app, base } = await startApp(t, (scene, layer, visible) => {
    if (visible !== false) return show(layer);
    tried.push(layer);
    if (layer === 'vieja') return Promise.reject(new Error('fallo-historico'));
    return Promise.resolve({ scene: { id: 'scene-1' }, layer: { id: 'nueva' } });
  });
  await postLayer(base, { scene: 'Escena', layer: 'vieja', visible: true, seconds: 0.02 });
  await waitFor(() => tried.includes('vieja'), 'el ocultado programado antes de la señal se ejecutó');
  await flushMicrotasks();   // el fallo termina ANTES de la señal: su registro sale del conjunto pendiente
  assert.deepEqual(tried, ['vieja']);
  app.beginLayerHideDrain();
  await postLayer(base, { scene: 'Escena', layer: 'nueva', visible: true, seconds: 0.02 });
  await waitFor(() => tried.includes('nueva'), 'el ocultado posterior a la señal se ejecutó');
  assert.deepEqual(tried, ['vieja', 'nueva']);
  assert.equal(await app.drainLayerHides(), undefined, 'el historial terminado antes de la señal queda excluido');
});

test('captura el ocultado que un handler ya admitido programa tras la señal', { timeout: 10000 }, async t => {
  let resolveShow;
  const hides = [];
  const { app, base, calls } = await startApp(t, (scene, layer, visible) => {
    if (visible !== false) return new Promise(resolve => { resolveShow = resolve; });
    hides.push(layer);
    return Promise.reject(new Error('tarde'));
  }, () => resolveShow?.(show('Capa')));
  const inflight = postLayer(base, { scene: 'Escena', layer: 'Capa', visible: true, seconds: 0.03 });
  // handler admitido y dentro, aún sin programar
  await waitFor(() => !!resolveShow, 'el handler admitido entró en meld.setLayer');
  app.beginLayerHideDrain();
  const admissionIdle = app.stopAdmission();
  assert.equal(calls.filter(c => c[2] === false).length, 0, 'todavía no ha programado');
  const idle = app.waitIdle();
  resolveShow(show('Capa'));
  assert.equal((await inflight).status, 200);
  await Promise.all([idle, admissionIdle]); // sello solo tras idle HTTP: el handler ya programó
  await waitFor(() => hides.length === 1, 'el ocultado programado tras la señal se ejecutó');
  assert.deepEqual(hides, ['Capa'], 'el ocultado programado tras la señal entra en la captura');
  assert.equal(calls.filter(c => c[2] === false).length, 1, 'una sola ejecución del ocultado capturado');
  await assert.rejects(app.drainLayerHides(), /tarde/);
});

test('visible=false o seconds<=0 no programan temporizador', { timeout: 10000 }, async t => {
  const { base } = await startApp(t, (scene, layer) => show(layer));
  const delays = [];
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return real(fn, ms, ...rest); };
  try {
    await postLayer(base, { scene: 'Escena', layer: 'Capa', visible: false, seconds: 5 });
    await postLayer(base, { scene: 'Escena', layer: 'Capa', visible: true, seconds: 0 });
  } finally { globalThis.setTimeout = real; }
  assert.equal(delays.filter(ms => ms === 5000).length, 0);
});
