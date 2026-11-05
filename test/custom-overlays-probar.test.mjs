// S9/T3: probar_overlay — POST /api/custom-overlays/:id/test manda un evento de ejemplo a UNA
// capa abierta (cliente widget), como mensaje efímero `customOverlayTest`, sin tocar la cola de
// alertas, el directo, los totales ni el historial. La shell lo reenvía al marco solo si el id
// coincide (ver la prueba estructural de la shell y la de Chrome).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(dataDir) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'egdev-overlay-probar-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const raw = (method, p, body, headers = {}) => fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (method, p, body) => {
    const r = await raw(method, p, body);
    const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
  };
  return { app, base, raw, call, dataDir, close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

async function sse(url) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  async function next(name, pred = () => true, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = events.findIndex(e => e.event === name && pred(e.data));
      if (i >= 0) return events.splice(i, 1)[0].data;
      if (Date.now() > deadline) throw new Error(`no "${name}" event within ${timeoutMs} ms`);
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 100))]);
      if (done) throw new Error('stream closed');
      if (!value) continue;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  }
  return { next, close: () => ctrl.abort() };
}

const SAMPLE = { name: 'Marco cámara', html: '<div class="frame">hola</div>', css: '.frame{border:4px solid red}', js: 'document.body.dataset.ready = "1";', width: 1280, height: 720 };
const EVENTS = ['alert', 'chat', 'viewers', 'widgets'];

test('probar: un id desconocido o mal formado responde 404 y no emite nada', async () => {
  const { base, call, close } = await start();
  const widget = await sse(base + '/api/stream?client=widget');
  try {
    await call('POST', '/api/custom-overlays', SAMPLE);
    const before = await call('GET', '/api/custom-overlays');
    for (const id of ['nope', encodeURIComponent('A/b')]) {
      await assert.rejects(call('POST', `/api/custom-overlays/${id}/test`, { event: 'alert' }), e => e.status === 404, id);
    }
    await assert.rejects(widget.next('customOverlayTest', () => true, 300), /no "customOverlayTest"/, 'un 404 no manda prueba');
    assert.deepEqual(await call('GET', '/api/custom-overlays'), before);
    assert.equal((await call('POST', '/api/custom-overlays', { name: 'Después' })).overlay.name, 'Después', 'crear sigue funcionando tras los 404');
  } finally { widget.close(); await close(); }
});

test('probar: evento desconocido o datos que no son un objeto responden 400 sin emitir nada', async () => {
  const { base, call, close } = await start();
  const widget = await sse(base + '/api/stream?client=widget');
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const bad = [
      [{}, /evento/i],
      [{ event: 'alert!', data: { a: 1 } }, /evento/i],
      [{ event: 'theme', data: { a: 1 } }, /evento/i],
      [{ event: 42 }, /evento/i],
      [{ event: 'alert', data: 'hola' }, /objeto/i],
      [{ event: 'chat', data: null }, /objeto/i],
      [{ event: 'viewers', data: ['a'] }, /objeto/i],
    ];
    for (const [body, msg] of bad) {
      await assert.rejects(call('POST', `/api/custom-overlays/${overlay.id}/test`, body), e => e.status === 400 && msg.test(e.message), JSON.stringify(body));
    }
    await assert.rejects(widget.next('customOverlayTest', () => true, 300), /no "customOverlayTest"/);
    // Nada de lo anterior ha cambiado el overlay ni ha creado otro.
    assert.equal((await call('GET', '/api/custom-overlays/' + overlay.id)).overlay.css, SAMPLE.css);
  } finally { widget.close(); await close(); }
});

test('probar: el evento llega solo a los clientes widget, con el payload exacto', async () => {
  const { base, call, close } = await start();
  const widget = await sse(base + '/api/stream?client=widget');
  const panel = await sse(base + '/api/stream?client=panel');
  const overlayKind = await sse(base + '/api/stream?client=overlay');
  try {
    const a = (await call('POST', '/api/custom-overlays', { name: 'A' })).overlay;
    const b = (await call('POST', '/api/custom-overlays', { name: 'B' })).overlay;
    const data = { type: 'follow', title: 'Nuevo seguidor', text: 'ana', vars: { user: 'ana' } };
    assert.deepEqual(await call('POST', `/api/custom-overlays/${a.id}/test`, { event: 'alert', data }), { ok: true, test: { id: a.id, event: 'alert', data } });
    assert.deepEqual(await widget.next('customOverlayTest', d => d.id === a.id), { id: a.id, event: 'alert', data });
    // Va dirigido a una capa concreta: cada prueba lleva su id (la shell filtra por el suyo).
    await call('POST', `/api/custom-overlays/${b.id}/test`, { event: 'chat', data });
    assert.deepEqual(await widget.next('customOverlayTest', d => d.id === b.id), { id: b.id, event: 'chat', data });
    // Ni el panel ni el overlay de alertas reciben la prueba.
    await assert.rejects(panel.next('customOverlayTest', () => true, 300), /no "customOverlayTest"/);
    await assert.rejects(overlayKind.next('customOverlayTest', () => true, 300), /no "customOverlayTest"/);
    // Y es efímera: un cliente nuevo no la recibe al conectar (no hay snapshot ni replay).
    const late = await sse(base + '/api/stream?client=widget');
    try {
      await assert.rejects(late.next('customOverlayTest', () => true, 300), /no "customOverlayTest"/);
    } finally { late.close(); }
  } finally { widget.close(); panel.close(); overlayKind.close(); await close(); }
});

test('probar: sin datos usa un ejemplo realista del evento pedido', async () => {
  const { base, call, close } = await start();
  const widget = await sse(base + '/api/stream?client=widget');
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    for (const event of EVENTS) {
      const r = await call('POST', `/api/custom-overlays/${overlay.id}/test`, { event });
      assert.equal(r.ok, true, event);
      assert.equal(r.test.event, event);
      const { data } = r.test;
      assert.equal(typeof data, 'object', `${event}: los datos son un objeto`);
      assert.ok(data && !Array.isArray(data), `${event}: objeto, no lista`);
      // Lo que manda el servidor es exactamente lo que recibe la capa.
      assert.deepEqual(await widget.next('customOverlayTest', d => d.event === event), { id: overlay.id, event, data });
      if (event === 'alert') {
        // Mismo ejemplo que la app usa para una alerta de seguidor (src/alerts.mjs · SAMPLES.follow).
        assert.equal(data.type, 'follow');
        assert.equal(data.title, 'Nuevo seguidor');
        assert.equal(data.vars.user, 'devconcafe');
        assert.equal(data.platform, 'twitch');
        assert.equal(typeof data.at, 'string');
        assert.ok(Number.isFinite(data.durationMs));
      }
      if (event === 'chat') {
        assert.equal(typeof data.user, 'string');
        assert.equal(typeof data.text, 'string');
        assert.equal(data.platform, 'twitch');
        assert.equal(typeof data.at, 'string');
      }
      if (event === 'viewers') {
        for (const platform of ['twitch', 'youtube']) {
          assert.deepEqual(Object.keys(data[platform]).sort(), ['current', 'live', 'peak', 'record'], platform);
          assert.equal(typeof data[platform].current, 'number');
        }
      }
      if (event === 'widgets') {
        assert.equal(typeof data.totals.follows, 'number');
        assert.ok(data.latest && typeof data.latest === 'object');
        assert.ok(Array.isArray(data.goals));
        assert.ok(Array.isArray(data.recent));
      }
    }
  } finally { widget.close(); await close(); }
});

test('probar: no toca la cola de alertas, el directo, los totales ni el historial', async () => {
  const { app, base, call, close } = await start();
  const alertKind = await sse(base + '/api/stream?client=overlay');
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const before = {
      history: await call('GET', '/api/history'),
      session: await call('GET', '/api/session'),
      widgets: await call('GET', '/api/widgets'),
      pause: app.engine.pauseState(),
      events: app.session.data.events.length,
    };
    for (const event of EVENTS) await call('POST', `/api/custom-overlays/${overlay.id}/test`, { event });
    // Una prueba con datos propios de una alerta tampoco entra en el directo.
    await call('POST', `/api/custom-overlays/${overlay.id}/test`, { event: 'alert', data: { type: 'raid', vars: { user: 'midudev', amount: 120 } } });
    assert.deepEqual(await call('GET', '/api/history'), before.history, 'el historial de alertas no cambia');
    const session = await call('GET', '/api/session');
    assert.deepEqual(session.totals, before.session.totals, 'los totales no cambian');
    assert.equal(session.eventCount, before.session.eventCount, 'el directo no suma eventos');
    assert.equal(app.session.data.events.length, before.events);
    const widgets = await call('GET', '/api/widgets');
    assert.deepEqual(widgets.totals, before.widgets.totals);
    assert.deepEqual(widgets.goals, before.widgets.goals);
    assert.deepEqual(widgets.latest, before.widgets.latest);
    assert.deepEqual(app.engine.pauseState(), before.pause, 'ni se encola ni se pausa nada');
    // El overlay de alertas (la cola) no ve nada: la prueba es de las capas propias.
    await assert.rejects(alertKind.next('alert', () => true, 300), /no "alert"/);
  } finally { alertKind.close(); await close(); }
});

test('probar: la shell reenvía la prueba al marco solo si va dirigida a su capa', async () => {
  const { raw, call, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const html = await (await raw('GET', '/custom/' + overlay.id)).text();
    // Hay manejador del evento de prueba, con el mismo mensaje { antena: 1, event, data } del SDK.
    assert.match(html, /customOverlayTest:\s*test\s*=>\s*\{/);
    assert.match(html, /if\s*\(!test\s*\|\|\s*test\.id\s*!==\s*id\)\s*return;/);
    assert.match(html, /post\(test\.event, test\.data\)/);
    // Sigue sin escuchar nada del marco ni usar canales de vuelta (S5/S11).
    assert.doesNotMatch(html, /addEventListener\(\s*'message'/);
    assert.doesNotMatch(html, /client=overlay|'overlay'/);
  } finally { await close(); }
});

test('las rutas de siempre de los overlays siguen respondiendo igual (la nueva no las tapa)', async () => {
  const { raw, call, close } = await start();
  try {
    assert.deepEqual(await call('GET', '/api/custom-overlays'), { overlays: [] });
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    assert.equal((await call('GET', '/api/custom-overlays')).overlays.length, 1);
    assert.equal((await call('GET', '/api/custom-overlays/' + overlay.id)).overlay.html, SAMPLE.html);
    assert.equal((await call('PUT', '/api/custom-overlays/' + overlay.id, { css: '.x{}' })).overlay.css, '.x{}');
    await call('DELETE', '/api/custom-overlays/' + overlay.id);
    assert.deepEqual(await call('GET', '/api/custom-overlays'), { overlays: [] });
    // POST sobre un id concreto no existe (la ruta de prueba es /test, no /:id).
    const shadow = await raw('POST', '/api/custom-overlays/' + overlay.id, {});
    assert.equal(shadow.status, 404);
    assert.deepEqual(await shadow.json(), { error: 'No existe' });
  } finally { await close(); }
});
