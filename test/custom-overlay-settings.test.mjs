// Custom overlay settings (#344): declared fields, validated values, live delivery without reloading the layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { LOOK_SECTIONS } from '../src/theme-looks.mjs';

const FIELDS = [
  { key: 'title', label: 'Título', type: 'text', default: 'Hola' },
  { key: 'size', label: 'Tamaño', type: 'number', min: 10, max: 80, step: 2, default: 24 },
  { key: 'show', label: 'Mostrar', type: 'toggle', default: true },
  { key: 'side', label: 'Lado', type: 'select', options: ['left', 'right'], default: 'left' },
  { key: 'accent', label: 'Color', type: 'color', default: '#ff0036' },
  { key: 'lines', label: 'Líneas', type: 'list' },
  { key: 'image', label: 'Imagen', type: 'media' },
];

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-overlay-settings-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { base, call };
}

/** Collects every SSE event of a widget client; `until` polls the collected list (no dangling reads). */
async function widgetEvents(base) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/stream?client=widget', { signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder(), events = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  const until = async (pred, what, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit.data;
      if (Date.now() > deadline) assert.fail(`no event: ${what}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  return { events, until, close: () => ctrl.abort() };
}

test('fields and values are validated per type and stored; invalid writes change nothing', async t => {
  const { call } = await start(t);
  const values = { title: 'Sígueme', size: 30, show: false, side: 'right', accent: '#0af', lines: ['uno', 'dos'], image: 'logo.png' };
  const made = await call('POST', '/api/custom-overlays', { name: 'Barra', fields: FIELDS, values });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.overlay.id;
  assert.deepEqual(made.body.overlay.fields.map(field => field.key), FIELDS.map(field => field.key));
  assert.deepEqual(made.body.overlay.values, values);

  const before = (await call('GET', '/api/custom-overlays/' + id)).body.overlay;
  const bad = [
    [{ fields: [{ key: 'Bad Key', type: 'text' }] }, /clave/],
    [{ fields: [{ key: 'a', type: 'video' }] }, /tipo/],
    [{ fields: [{ key: 'a', type: 'text' }, { key: 'a', type: 'text' }] }, /repetid/],
    [{ fields: [{ key: 'a', type: 'select', options: ['x'], default: 'y' }] }, /«a»/],
    [{ fields: Array.from({ length: 31 }, (_, i) => ({ key: 'f' + i, type: 'text' })) }, /30/],
    [{ values: { nope: 1 } }, /nope/],
    [{ values: { title: 'x'.repeat(2001) } }, /title/],
    [{ values: { size: 100 } }, /size/],
    [{ values: { show: 'yes' } }, /show/],
    [{ values: { side: 'top' } }, /side/],
    [{ values: { accent: 'red' } }, /accent/],
    [{ values: { lines: Array.from({ length: 51 }, () => 'x') } }, /lines/],
    [{ values: { image: '../secret.txt' } }, /image/],
  ];
  for (const [patch, message] of bad) {
    const r = await call('PUT', '/api/custom-overlays/' + id, patch);
    assert.equal(r.status, 400, JSON.stringify(patch).slice(0, 80));
    assert.match(r.body.error, message);
  }
  assert.deepEqual((await call('GET', '/api/custom-overlays/' + id)).body.overlay, before, 'rejected writes leave the overlay unchanged');
});

test('changing the fields keeps the values whose key still exists and drops the rest; null clears a value', async t => {
  const { call } = await start(t);
  const { overlay } = (await call('POST', '/api/custom-overlays', { name: 'Barra', fields: FIELDS, values: { title: 'Sígueme', side: 'right', size: 30 } })).body;
  const next = [FIELDS[0], { key: 'side', label: 'Lado', type: 'select', options: ['top', 'bottom'] }, { key: 'extra', type: 'text' }];
  const r = await call('PUT', '/api/custom-overlays/' + overlay.id, { fields: next });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.overlay.values, { title: 'Sígueme' }, 'size lost its field; side no longer matches its options');
  const cleared = await call('PUT', '/api/custom-overlays/' + overlay.id, { values: { title: null, extra: 'algo' } });
  assert.deepEqual(cleared.body.overlay.values, { extra: 'algo' }, 'values merge; null removes one');
});

test('a values-only change keeps the layer version and is pushed live; a fields change reloads the layer', async t => {
  const { base, call } = await start(t);
  const { overlay } = (await call('POST', '/api/custom-overlays', { name: 'Barra', fields: FIELDS, values: { title: 'Sígueme', image: 'logo.png' } })).body;
  const w = await widgetEvents(base);
  t.after(() => w.close());
  const first = await w.until(e => e.event === 'customOverlaySettings' && e.data[overlay.id], 'initial settings');
  assert.deepEqual(first[overlay.id], { title: 'Sígueme', size: 24, show: true, side: 'left', accent: '#ff0036', lines: [], image: { $media: 'logo.png' } }, 'defaults fill missing values; media goes as a file reference');

  const r = await call('PUT', '/api/custom-overlays/' + overlay.id, { values: { title: 'Nuevo' } });
  assert.equal(r.body.overlay.updatedAt, overlay.updatedAt, 'values do not version the overlay');
  await w.until(e => e.event === 'customOverlaySettings' && e.data[overlay.id]?.title === 'Nuevo', 'live settings');
  assert.equal(w.events.filter(e => e.event === 'customOverlayVersions' && e.data[overlay.id] !== overlay.updatedAt).length, 0, 'no reload for a values change');

  const f = await call('PUT', '/api/custom-overlays/' + overlay.id, { fields: [...FIELDS, { key: 'extra', type: 'text' }] });
  assert.ok(f.body.overlay.updatedAt > overlay.updatedAt, 'fields version the overlay');
  await w.until(e => e.event === 'customOverlayVersions' && e.data[overlay.id] === f.body.overlay.updatedAt, 'reload after a fields change');
});

test('fields and values never require approving the actions again', async t => {
  const { call } = await start(t);
  const { overlay } = (await call('POST', '/api/custom-overlays', { name: 'Con acción', js: 'antena.run("say", { text: "hola" })', requestedPermissions: ['say'] })).body;
  const approved = await call('PUT', '/api/custom-overlays/' + overlay.id + '/permissions', { permissions: ['say'] }, { 'sec-fetch-site': 'same-origin' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await call('PUT', '/api/custom-overlays/' + overlay.id, { fields: [{ key: 'title', type: 'text' }] });
  const after = (await call('PUT', '/api/custom-overlays/' + overlay.id, { values: { title: 'x' } })).body.overlay;
  assert.deepEqual(after.permissions, ['say']);
  assert.equal(after.reapprovalRequired, false);
});

test('values go through the generic config path with the same rules and stay out of saved themes', async t => {
  const { call } = await start(t);
  const { overlay } = (await call('POST', '/api/custom-overlays', { name: 'Barra', fields: FIELDS })).body;
  const list = (await call('GET', '/api/custom-overlays')).body.overlays;
  const ok = await call('PUT', '/api/config', { customOverlays: list.map(o => ({ ...o, values: { title: 'Importado' } })) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 200));
  assert.deepEqual((await call('GET', '/api/custom-overlays/' + overlay.id)).body.overlay.values, { title: 'Importado' });
  const bad = await call('PUT', '/api/config', { customOverlays: list.map(o => ({ ...o, values: { size: 'grande' } })) });
  assert.equal(bad.status, 400);
  assert.deepEqual((await call('GET', '/api/custom-overlays/' + overlay.id)).body.overlay.values, { title: 'Importado' });
  assert.equal(LOOK_SECTIONS.includes('customOverlays'), false, 'saved themes do not carry overlay values');
});

test('an overlay stored before settings existed reads as no fields and no values', async t => {
  const { call } = await start(t);
  const { overlay } = (await call('POST', '/api/custom-overlays', { name: 'Antiguo' })).body;
  assert.deepEqual([overlay.fields, overlay.values], [[], {}]);
});
