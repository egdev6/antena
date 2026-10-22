// API del récord de espectadores (#142) con la app de verdad, sin red de plataformas.
// Cubre las correcciones de revisión: ajustes vía store.patchConfig (CONFIG_SCHEMA), debounce
// de POST /api/viewers/check y récord a mano con validación de plataforma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { sanitizeConfig } from '../src/config-schema.mjs';
import { ViewerWatch, DEFAULT_VIEWERS } from '../src/viewers.mjs';
import { DEFAULT_CONFIG } from '../src/store.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-viewers-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
  };
  return { app, base, call, close: () => new Promise(r => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('PUT /api/viewers/settings persiste vía store.patchConfig (CONFIG_SCHEMA)', async () => {
  const { app, call, close } = await start();
  try {
    let patches = [];
    const orig = app.store.patchConfig.bind(app.store);
    app.store.patchConfig = async patch => { patches.push(patch); return orig(patch); };
    const s = await call('PUT', '/api/viewers/settings', { minStep: 5, cooldownMin: 999, enabled: true });
    assert.equal(s.settings.minStep, 5);
    assert.equal(s.settings.cooldownMin, 240);          // recortado al rango del schema
    assert.equal(app.store.config.viewers.enabled, true);
    assert.ok(patches.some(p => p.viewers), 'los ajustes tienen que pasar por patchConfig');
    // el config resultante no genera avisos de schema en la sección viewers
    const warnings = sanitizeConfig(structuredClone(app.store.config), DEFAULT_CONFIG);
    assert.ok(!warnings.some(w => w.path.startsWith('viewers')), JSON.stringify(warnings));
    // valor no numérico: 400
    await assert.rejects(call('PUT', '/api/viewers/settings', { pollSec: 'mucho' }), /tiene que ser un número/);
  } finally { await close(); }
});

test('POST /api/viewers/check se desfasea ~5 s', async () => {
  const { app, call, close } = await start();
  try {
    let ticks = 0;
    const orig = app.viewers.tick.bind(app.viewers);
    app.viewers.tick = () => { ticks++; return orig(); };
    const a = await call('POST', '/api/viewers/check');
    assert.equal(a.debounced, undefined);
    const b = await call('POST', '/api/viewers/check');
    assert.equal(b.debounced, true);
    assert.equal(ticks, 1, 'la segunda llamada seguida no vuelve a leer');
  } finally { await close(); }
});

test('espectadores: récord a mano con validación y tipo de sistema en el motor', async () => {
  const { call, close } = await start();
  try {
    const r = await call('PUT', '/api/viewers/records/youtube', { value: 77 });
    assert.equal(r.platforms.youtube.record, 77);
    await assert.rejects(call('PUT', '/api/viewers/records/kick', { value: 1 }), /Plataforma desconocida/);
    await assert.rejects(call('PUT', '/api/viewers/records/twitch', { value: 'alto' }), /número/);
    // la alerta de récord pasa por el motor normal y no cuenta como evento
    const sim = await call('POST', '/api/simulate', { type: 'viewers', vars: { amount: 50, previous: 40 } });
    assert.equal(sim.alert.title, 'Nuevo récord');
    assert.equal(sim.alert.text, '50 espectadores');
    const tl = await call('GET', '/api/timeline');
    assert.equal(tl.pending, 0);
    assert.equal((await call('GET', '/api/widgets')).totals.events, 0);
  } finally { await close(); }
});

test('el desfase de «Mirar ahora» es por app, no del módulo entero', async () => {
  const a = await start();
  const b = await start();
  try {
    let ticksA = 0, ticksB = 0;
    const origA = a.app.viewers.tick.bind(a.app.viewers);
    const origB = b.app.viewers.tick.bind(b.app.viewers);
    a.app.viewers.tick = () => { ticksA++; return origA(); };
    b.app.viewers.tick = () => { ticksB++; return origB(); };
    await a.call('POST', '/api/viewers/check');
    await b.call('POST', '/api/viewers/check');   // otra app: su primer check no va desfaseado
    assert.equal(ticksA, 1);
    assert.equal(ticksB, 1, 'cada app lleva su propio desfase');
  } finally { await a.close(); await b.close(); }
});

test('halt antes de la primera lectura: ni lectura, ni guardado, ni alerta', async () => {
  let reads = 0, saves = 0;
  const fired = [];
  const store = { config: { viewers: { ...DEFAULT_VIEWERS } }, save() { saves++; } };
  const w = new ViewerWatch({ store, engine: { handleEvent: e => fired.push(e) }, readers: {
    twitch: async () => { reads++; return { live: true, viewers: 30 }; },
    youtube: async () => { reads++; return { live: false }; },
  }, initialDelayMs: 10 });
  w.start();
  w.halt();
  await new Promise(r => setTimeout(r, 40));
  assert.equal(reads, 0, 'el temporizador inicial no dispara tras halt');
  assert.equal(saves, 0);
  assert.equal(fired.length, 0);
});
