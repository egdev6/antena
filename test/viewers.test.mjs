// Récord de espectadores: el récord sube siempre en silencio y la alerta no se spamea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ViewerWatch, DEFAULT_VIEWERS, nextAnnounce } from '../src/viewers.mjs';
import { ALERT_TYPES, DEFAULT_ALERTS, SAMPLES, buildAlert } from '../src/alerts.mjs';
import { Session, METRICS } from '../src/session.mjs';
import { platformValue } from '../src/goals.mjs';

const MIN = 60000;
function setup(cfg = {}, records = { twitch: 0, youtube: 0 }) {
  let t = 1_000_000;
  const fired = [];
  const store = { config: { viewers: { ...DEFAULT_VIEWERS, ...cfg, records: { ...records } } }, saves: 0, save() { this.saves++; } };
  const engine = { handleEvent: e => fired.push(e) };
  const w = new ViewerWatch({ store, engine, now: () => t, readers: {} });
  const read = (p, v) => w.observe(p, v === null ? { live: false } : { live: true, viewers: v });
  const advance = ms => { t += ms; };
  return { w, store, fired, read, advance };
}

test('nextAnnounce: el mayor de minStep y minStepPct', () => {
  assert.equal(nextAnnounce(10, { minStep: 3, minStepPct: 10 }), 13);
  assert.equal(nextAnnounce(100, { minStep: 3, minStepPct: 10 }), 110);
  assert.equal(nextAnnounce(0, { minStep: 3, minStepPct: 10 }), 3);
});

test('sin récord previo: punto de partida en silencio (salvo alertFirst)', async () => {
  const { read, advance, fired, store } = setup({ warmupMin: 0 });
  read('twitch', 30); advance(MIN); read('twitch', 31);
  assert.equal(fired.length, 0);
  await new Promise(r => setImmediate(r));
  assert.equal(store.config.viewers.records.twitch, 30);   // mínimo de las 2 lecturas
  const b = setup({ warmupMin: 0, alertFirst: true });
  b.read('twitch', 30); b.advance(MIN); b.read('twitch', 31);
  assert.equal(b.fired.length, 1);
  assert.equal(b.fired[0].type, 'viewers');
  assert.equal(b.fired[0].vars.amount, 30);
});

test('un pico de una sola lectura no cuenta; hace falta confirmarlo', () => {
  const { read, advance, fired, store } = setup({ warmupMin: 0, cooldownMin: 0 }, { twitch: 40 });
  read('twitch', 38); advance(MIN); read('twitch', 60); advance(MIN); read('twitch', 39);
  assert.equal(fired.length, 0);
  assert.equal(store.config.viewers.records.twitch, 40);
  advance(MIN); read('twitch', 50); advance(MIN); read('twitch', 52);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].vars, { amount: 50, previous: 40, platform: 'twitch' });
});

test('salto pequeño: el récord sube pero no hay alerta hasta superar el umbral', () => {
  const { read, advance, fired, store } = setup({ warmupMin: 0, cooldownMin: 0, confirmPolls: 1 }, { twitch: 40 });
  read('twitch', 41); advance(MIN); read('twitch', 42); advance(MIN); read('twitch', 43);
  assert.equal(fired.length, 0);
  assert.equal(store.config.viewers.records.twitch, 43);
  advance(MIN); read('twitch', 44);   // 40 + max(3, 4) = 44
  assert.equal(fired.length, 1);
  assert.equal(fired[0].vars.previous, 40);
  assert.equal(fired[0].vars.amount, 44);
  advance(MIN); read('twitch', 46);   // 44 + max(3, 5) = 49: no
  assert.equal(fired.length, 1);
});

test('espera entre alertas: lo batido mientras tanto sale una vez, con la cifra más alta', () => {
  const { read, advance, fired } = setup({ warmupMin: 0, cooldownMin: 15, confirmPolls: 1 }, { youtube: 10 });
  read('youtube', 20);
  assert.equal(fired.length, 1);
  for (const v of [30, 40, 50, 60]) { advance(2 * MIN); read('youtube', v); }
  assert.equal(fired.length, 1);
  advance(8 * MIN); read('youtube', 55);   // 16 min después: pendiente, sale el récord (60)
  assert.equal(fired.length, 2);
  assert.equal(fired[1].type, 'ytviewers');
  assert.deepEqual(fired[1].vars, { amount: 60, previous: 20, platform: 'youtube' });
  advance(MIN); read('youtube', 58);
  assert.equal(fired.length, 2);
});

test('calentamiento y mínimo de espectadores', () => {
  const { read, advance, fired } = setup({ warmupMin: 5, cooldownMin: 0, confirmPolls: 1, minViewers: 25 }, { twitch: 10 });
  read('twitch', 20);                     // calentando y por debajo del mínimo
  advance(6 * MIN); read('twitch', 22);   // pasado el calentamiento, aún < 25
  assert.equal(fired.length, 0);
  advance(MIN); read('twitch', 26);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].vars.previous, 10);
});

test('plataformas independientes y el fin del directo reinicia el estado', () => {
  const { w, read, advance, fired } = setup({ warmupMin: 0, cooldownMin: 30, confirmPolls: 1 }, { twitch: 10, youtube: 10 });
  read('twitch', 20); read('youtube', 20);
  assert.deepEqual(fired.map(f => f.type), ['viewers', 'ytviewers']);
  read('twitch', null);
  assert.equal(w.snapshot().platforms.twitch.live, false);
  advance(MIN); read('twitch', 30);       // directo nuevo: sin espera heredada
  assert.equal(fired.length, 3);
  assert.equal(fired[2].vars.previous, 20);
});

test('fijar el récord a mano no lanza alerta y valida la plataforma', () => {
  const { w, read, fired } = setup({ warmupMin: 0, confirmPolls: 1 }, { twitch: 10 });
  w.setRecord('twitch', 100);
  read('twitch', 50);
  assert.equal(fired.length, 0);
  assert.equal(w.snapshot().platforms.twitch.record, 100);
  assert.throws(() => w.setRecord('kick', 3), /Plataforma desconocida/);
});

test('tick: lee las dos plataformas, tolera errores y desactivado no lee', async () => {
  let calls = 0;
  const store = { config: { viewers: { ...DEFAULT_VIEWERS, warmupMin: 0, confirmPolls: 1, records: { twitch: 5, youtube: 0 } } }, save() {} };
  const fired = [];
  const w = new ViewerWatch({ store, engine: { handleEvent: e => fired.push(e) }, readers: {
    twitch: async () => { calls++; return { live: true, viewers: 12 }; },
    youtube: async () => { calls++; throw new Error('cuota'); },
  } });
  const out = await w.tick();
  assert.equal(out.length, 1);
  assert.equal(w.snapshot().platforms.youtube.error, 'cuota');
  store.config.viewers.enabled = false;
  await w.tick();
  assert.equal(calls, 2);
});

test('las alertas de récord son de sistema: no cuentan como eventos ni piden gracias', async () => {
  for (const t of ['viewers', 'ytviewers']) {
    assert.ok(ALERT_TYPES[t].system);
    assert.ok(!METRICS.events.types.includes(t));
    const a = buildAlert(t, SAMPLES[t], { alerts: DEFAULT_ALERTS }, { test: true });
    assert.match(a.text, /espectadores/);
    assert.match(a.sub, /antes/);
    assert.equal(a.icon, 'eye');
  }
  const s = new Session('/nonexistent-egdev', { writer: async () => {} });
  s.data = { events: [], notes: [], goalOffsets: {}, startedAt: new Date().toISOString() };
  s.save = () => {};
  s.record({ id: '1', type: 'follow', at: new Date().toISOString(), vars: { user: 'ana' }, text: 'ana' });
  s.record({ id: '2', type: 'viewers', at: new Date().toISOString(), vars: { amount: 50, previous: 40 }, text: '50 espectadores' });
  assert.equal(s.pendingThanks(), 1);
  assert.equal(s.latest().any.id, '1');
  assert.equal(s.totals().events, 1);
  assert.equal(platformValue('events', 'twitch', s.data.events), 1);
});

test('refresh: reanuda un watcher iniciado que estaba parado (revisión #142)', () => {
  const store = { config: { viewers: { ...DEFAULT_VIEWERS, pollSec: 60 } }, save() {} };
  const w = new ViewerWatch({ store, readers: {} });
  w.start();
  assert.ok(w.handle);
  w.stop();
  assert.equal(w.handle, null);
  w.refresh();
  assert.ok(w.handle, 'refresh tiene que reprogramar un watcher iniciado aunque estuviera parado');
  w.stop();
});

test('halt (apagado de la app): refresh no reanuda y no salen más alertas', async () => {
  let t = 1_000_000;
  const fired = [];
  const store = { config: { viewers: { ...DEFAULT_VIEWERS, warmupMin: 0, cooldownMin: 0, confirmPolls: 1, records: { twitch: 10, youtube: 0 } } }, save() {} };
  const w = new ViewerWatch({ store, engine: { handleEvent: e => fired.push(e) }, now: () => t, readers: {} });
  w.start();
  w.halt();
  w.refresh();
  assert.equal(w.handle, null, 'tras el apagado, refresh no vuelve a arrancar el watcher');
  w.observe('twitch', { live: true, viewers: 30 });
  await new Promise(r => setImmediate(r));
  assert.equal(fired.length, 0, 'tras halt no hay alertas aunque se bata el récord');
});

test('lectores reales con clientes falsos: readTwitch y readYouTube', async () => {
  const store = { config: { viewers: { ...DEFAULT_VIEWERS } }, save() {} };
  const w = new ViewerWatch({ store, readers: {} });
  // Twitch: sin canal no se lee; con canal, viewer_count de la fila del directo
  assert.deepEqual(await w.readTwitch.call({ twitch: null }), { live: false, off: true });
  const twitchOk = { userId: '42', token: 't', helix: async () => ({ ok: true, data: { data: [{ viewer_count: '123' }] } }) };
  assert.deepEqual(await w.readTwitch.call({ twitch: twitchOk }), { live: true, viewers: 123 });
  const twitchRow = { userId: '42', token: 't', helix: async () => ({ ok: true, data: { data: [] } }) };
  assert.deepEqual(await w.readTwitch.call({ twitch: twitchRow }), { live: false });
  const twitchFail = { userId: '42', token: 't', helix: async () => ({ ok: false, status: 429 }) };
  await assert.rejects(w.readTwitch.call({ twitch: twitchFail }), /429/);
  // YouTube: solo en directo («escuchando»); concurrentViewers de videos.list
  const ytOff = { status: { videoId: 'v1', state: 'parado' }, api: async () => { throw new Error('no debe leer'); } };
  assert.deepEqual(await w.readYouTube.call({ youtube: ytOff }), { live: false, off: true });
  const ytOk = { status: { videoId: 'v1', state: 'escuchando' }, api: async () => ({ items: [{ liveStreamingDetails: { concurrentViewers: '7' } }] }) };
  assert.deepEqual(await w.readYouTube.call({ youtube: ytOk }), { live: true, viewers: 7 });
  const ytEnded = { status: { videoId: 'v1', state: 'escuchando' }, api: async () => ({ items: [{ liveStreamingDetails: { actualEndTime: '2026-01-01T00:00:00Z' } }] }) };
  assert.deepEqual(await w.readYouTube.call({ youtube: ytEnded }), { live: false });
  const ytGone = { status: { videoId: 'v1', state: 'escuchando' }, api: async () => ({ items: [] }) };
  assert.deepEqual(await w.readYouTube.call({ youtube: ytGone }), { live: false });
});

test('cifras ausentes o no numéricas son desconocidas en ambas plataformas; cero es válido', async () => {
  const { w } = setup();
  let count;
  w.twitch = { userId: 'synthetic', token: 'synthetic', helix: async () => ({ ok: true, data: { data: [{ viewer_count: count }] } }) };
  w.youtube = { status: { videoId: 'synthetic', state: 'escuchando' }, api: async () => ({ items: [{ liveStreamingDetails: { concurrentViewers: count } }] }) };
  for (const value of [undefined, null, '', '  ', 'no-numérico', false, [], {}, NaN, Infinity]) {
    count = value;
    assert.deepEqual(await w.readTwitch(), { live: true, viewers: null });
    assert.deepEqual(await w.readYouTube(), { live: true, viewers: null });
  }
  for (const value of [0, '0']) {
    count = value;
    assert.deepEqual(await w.readTwitch(), { live: true, viewers: 0 });
    assert.deepEqual(await w.readYouTube(), { live: true, viewers: 0 });
  }
});
