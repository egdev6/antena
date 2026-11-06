// S10 · El volumen real de cada pista de Meld: observadores por pista (registerTrackObserver),
// señal gainUpdated y el volumen dentro de la sesión. Se prueba por las interfaces públicas:
// GET /api/meld, el evento SSE «meld» del panel y POST /api/meld/track {action:'gain'}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, tries = 80) => {
  for (let i = 0; i < tries; i++) { if (fn()) return; await wait(10); }
  assert.fail(`no llegó a tiempo: ${label}`);
};

async function start(t, { meldOptions } = {}) {
  const meldSrv = fakeMeld(undefined, meldOptions);
  await new Promise(r => meldSrv.server.listen(0, '127.0.0.1', r));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'meld-gain-'));
  const logs = [];
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: m => logs.push(String(m)) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || String(r.status)), { status: r.status });
    return d;
  };
  t.after(async () => {
    await new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await new Promise(r => meldSrv.server.close(r));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  const connect = async () => {
    await call('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meldSrv.server.address().port}` });
    await until(() => app.meld.status.state === 'conectado', 'Meld conectado');
    // la sesión y sus observadores se resuelven en el mismo tick de la conexión
    await until(() => meldSrv.state.observers.has('t1') || meldOptions?.trackObservers === false, 'observador de t1');
  };
  return { app, base, call, meldSrv, logs, connect };
}

/** SSE del panel con los eventos ya parseados; se cierra con stop(). */
function openSse(base, client = 'panel') {
  const ctrl = new AbortController();
  const events = [];
  const ready = (async () => {
    const res = await fetch(`${base}/api/stream?client=${client}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const raw = /^data: (.*)$/m.exec(chunk)?.[1];
            if (!ev) continue;
            let data = null;
            try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
            events.push({ event: ev, data });
          }
        }
      } catch { /* abort al cerrar */ }
    })();
    return events;
  })();
  return { events, ready, stop: () => ctrl.abort() };
}

test('registra un observador por pista al conectar y para las pistas que aparecen después', async t => {
  const { call, meldSrv, connect } = await start(t);
  await connect();
  assert.equal(meldSrv.state.observers.get('t1'), 'antena', 'la pista t1 queda observada con un contexto estable');
  assert.deepEqual(meldSrv.state.observerCalls.filter(c => c[0] === 'register').map(c => c[2]), ['t1']);
  const st = await call('GET', '/api/meld');
  const micro = st.tracks.find(x => x.id === 't1');
  assert.equal(micro.gain, null, 'sin noticias de Meld el volumen es desconocido, no 0');
  assert.equal(micro.muted, false);

  meldSrv.addTrack('t2', { name: 'Música' });
  await until(() => meldSrv.state.observers.has('t2'), 'observador de la pista nueva');
  assert.equal(meldSrv.state.observers.get('t2'), 'antena');
  assert.deepEqual((await call('GET', '/api/meld')).tracks.map(x => x.id).sort(), ['t1', 't2']);
});

test('gainUpdated deja el volumen real de la pista en GET /api/meld', async t => {
  const { call, meldSrv, connect } = await start(t);
  await connect();
  assert.equal(meldSrv.emitGain('t1', 0.42, false), true, 'Meld solo avisa de las pistas observadas');
  await wait(150);   // el volumen llega por la señal y se agrupa antes de emitir la sesión
  const track = (await call('GET', '/api/meld')).tracks.find(x => x.id === 't1');
  assert.equal(track.gain, 0.42);

  meldSrv.emitGain('t1', 0.1, true);
  await wait(150);
  const muted = (await call('GET', '/api/meld')).tracks.find(x => x.id === 't1');
  assert.equal(muted.gain, 0.1);
  assert.equal(muted.muted, true, 'el mute que informa Meld también viaja con la señal');
});

test('mover el volumen en Meld empuja un evento «meld» por SSE con el volumen nuevo', async t => {
  const { base, meldSrv, connect } = await start(t);
  await connect();
  const sse = openSse(base, 'panel');
  await sse.ready;
  await wait(100);
  for (let i = 1; i <= 20; i++) meldSrv.emitGain('t1', i / 20, false);   // ráfaga: como al arrastrar el fader
  await wait(250);
  sse.stop();
  const melds = sse.events.filter(e => e.event === 'meld');
  assert.ok(melds.length >= 1, 'el volumen llega al panel por SSE');
  assert.ok(melds.length <= 4, `la ráfaga se agrupa en pocos eventos (llegaron ${melds.length})`);
  const last = melds.at(-1).data.tracks.find(x => x.id === 't1');
  assert.equal(last.gain, 1, 'el último evento lleva el volumen final');
});

test('poner el volumen desde POST /api/meld/track termina con ese volumen en la sesión', async t => {
  const { call, meldSrv, connect } = await start(t);
  await connect();
  await call('POST', '/api/meld/track', { track: 'micro', action: 'gain', gain: 0.25 });
  assert.deepEqual(meldSrv.state.calls.at(-1), [16, 't1', 0.25], 'se pide a Meld por id de pista');
  await wait(120);
  const track = (await call('GET', '/api/meld')).tracks.find(x => x.id === 't1');
  assert.equal(track.gain, 0.25);
});

test('una pista que desaparece de Meld se deja de observar', async t => {
  const { call, meldSrv, connect } = await start(t);
  await connect();
  meldSrv.removeTrack('t1');
  await until(() => !meldSrv.state.observers.has('t1'), 'baja del observador');
  assert.ok(meldSrv.state.observerCalls.some(c => c[0] === 'unregister' && c[1] === 'antena' && c[2] === 't1'), 'se da de baja con el mismo contexto');
  assert.deepEqual((await call('GET', '/api/meld')).tracks, []);
});

test('un Meld sin registerTrackObserver sigue funcionando con el volumen desconocido', async t => {
  const { call, logs, connect } = await start(t, { meldOptions: { trackObservers: false } });
  await connect();
  const st = await call('GET', '/api/meld');
  assert.equal(st.status.state, 'conectado');
  const micro = st.tracks.find(x => x.id === 't1');
  assert.equal(micro.gain, null);
  assert.equal(micro.muted, false);
  const avisos = logs.filter(l => /no informa del volumen de las pistas/i.test(l));
  assert.equal(avisos.length, 1, 'avisa una sola vez de que esa versión de Meld no da el volumen');
  assert.equal((await call('POST', '/api/meld/track', { track: 'micro' })).ok, true, 'el mute sigue funcionando');
});

test('alternar el mute sigue funcionando con los observadores activos', async t => {
  const { call, meldSrv, connect } = await start(t);
  await connect();
  await call('POST', '/api/meld/track', { track: 'micro' });   // acción por defecto: mute
  assert.deepEqual(meldSrv.state.calls.at(-1), [14, 't1']);
  await wait(120);
  assert.equal((await call('GET', '/api/meld')).tracks.find(x => x.id === 't1').muted, true);
});

test('el mute alternado desde antena no se queda en el valor que dijo la señal', async t => {
  const { call, meldSrv, connect } = await start(t);
  await connect();
  meldSrv.emitGain('t1', 0.6, false);
  await wait(120);
  await call('POST', '/api/meld/track', { track: 'micro' });
  await wait(120);
  const track = (await call('GET', '/api/meld')).tracks.find(x => x.id === 't1');
  assert.equal(track.muted, true, 'la sesión manda: el mute acaba de cambiar');
  assert.equal(track.gain, 0.6, 'el volumen sigue siendo el que informó Meld');
});
