import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(dataDir) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'egdev-custom-overlays-'));
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

test('custom overlays: create with defaults, read, list, edit and delete through the API', async () => {
  const { call, close } = await start();
  try {
    assert.deepEqual((await call('GET', '/api/custom-overlays')).overlays, []);
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'Vacío' });
    assert.match(overlay.id, /^[a-z0-9-]+$/);
    assert.deepEqual({ ...overlay, id: undefined, updatedAt: undefined }, { id: undefined, updatedAt: undefined, name: 'Vacío', html: '', css: '', js: '', width: 1920, height: 1080, transparent: true });
    assert.equal(typeof overlay.updatedAt, 'number');
    const full = (await call('POST', '/api/custom-overlays', SAMPLE)).overlay;
    assert.equal(full.js, SAMPLE.js);
    assert.deepEqual((await call('GET', '/api/custom-overlays')).overlays.map(o => o.name), ['Vacío', 'Marco cámara']);
    assert.equal((await call('GET', '/api/custom-overlays/' + full.id)).overlay.html, SAMPLE.html);
    const edited = (await call('PUT', '/api/custom-overlays/' + full.id, { css: '.frame{border:0}', transparent: false })).overlay;
    assert.equal(edited.css, '.frame{border:0}');
    assert.equal(edited.transparent, false);
    assert.equal(edited.html, SAMPLE.html);
    assert.ok(edited.updatedAt >= full.updatedAt);
    await call('DELETE', '/api/custom-overlays/' + overlay.id);
    assert.deepEqual((await call('GET', '/api/custom-overlays')).overlays.map(o => o.id), [full.id]);
    await assert.rejects(call('GET', '/api/custom-overlays/nope'), e => e.status === 404);
    await assert.rejects(call('PUT', '/api/custom-overlays/nope', { name: 'x' }), e => e.status === 404);
    await assert.rejects(call('DELETE', '/api/custom-overlays/nope'), e => e.status === 404);
  } finally { await close(); }
});

test('custom overlays: invalid input is rejected with 400 and leaves stored overlays unchanged', async () => {
  const { call, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const before = await call('GET', '/api/custom-overlays');
    const bad = [
      ['POST', '/api/custom-overlays', {}, /nombre/i],
      ['POST', '/api/custom-overlays', { name: '   ' }, /nombre/i],
      ['POST', '/api/custom-overlays', { name: 'x', width: 10 }, /ancho/i],
      ['POST', '/api/custom-overlays', { name: 'x', height: 99999 }, /alto/i],
      ['POST', '/api/custom-overlays', { name: 'x', html: 5 }, /html/i],
      ['POST', '/api/custom-overlays', { name: 'x', js: 'a'.repeat(600_000) }, /grande/i],
      ['PUT', '/api/custom-overlays/' + overlay.id, { width: 'ancho' }, /ancho/i],
      ['PUT', '/api/custom-overlays/' + overlay.id, { name: '' }, /nombre/i],
    ];
    for (const [m, p, body, msg] of bad) await assert.rejects(call(m, p, body), e => e.status === 400 && msg.test(e.message), `${m} ${JSON.stringify(body).slice(0, 60)}`);
    assert.deepEqual(await call('GET', '/api/custom-overlays'), before);
  } finally { await close(); }
});

test('custom overlays persist across restarts', async () => {
  const first = await start();
  let overlay;
  try {
    ({ overlay } = await first.call('POST', '/api/custom-overlays', SAMPLE));
    await first.app.store.chain;
  } finally { await first.close(); }   // a failing assertion must never leave the app (and its server) open
  const second = await start(first.dataDir);
  try {
    assert.equal((await second.call('GET', '/api/custom-overlays/' + overlay.id)).overlay.js, SAMPLE.js);
  } finally { await second.close(); }
});

test('the shell page embeds user code in a sandboxed iframe and never inlines it', async () => {
  const { raw, call, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const r = await raw('GET', '/custom/' + overlay.id);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /<iframe[^>]+sandbox="allow-scripts"/);
    assert.doesNotMatch(html, /allow-same-origin/);
    assert.equal(html.includes(SAMPLE.js), false);
    assert.equal((await raw('GET', '/custom/nope')).status, 404);
  } finally { await close(); }
});

test('the frame serves the user html, css and js under a CSP sandbox (opaque origin)', async () => {
  const { raw, call, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', { ...SAMPLE, html: '<p>a</p></body><script>x</script>' });
    const r = await raw('GET', `/custom/${overlay.id}/frame`);
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /(^|;)\s*sandbox allow-scripts\s*(;|$)/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    const html = await r.text();
    assert.ok(html.includes('<p>a</p></body><script>x</script>'));
    assert.ok(html.includes(SAMPLE.css));
    assert.ok(html.includes(SAMPLE.js));
    assert.equal((await raw('GET', '/custom/nope/frame')).status, 404);
  } finally { await close(); }
});

test('requests from the opaque sandbox origin cannot change anything', async () => {
  const { app, raw, close } = await start();
  try {
    const opaque = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
    const before = JSON.stringify(app.store.config.customOverlays);
    const paused = app.engine.pauseState().paused;
    for (const [m, p, body] of [['POST', '/api/pause'], ['POST', '/api/custom-overlays', { name: 'x' }], ['POST', '/api/config/set', { path: 'port', value: 1 }]]) {
      const r = await raw(m, p, body, opaque);
      assert.equal(r.status, 403, `${m} ${p}`);
    }
    assert.equal(app.engine.pauseState().paused, paused);
    assert.equal(JSON.stringify(app.store.config.customOverlays), before);
    const sd = await raw('GET', '/sd/pausa', undefined, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'image' });
    assert.equal(sd.status, 403);
    assert.equal(app.engine.pauseState().paused, paused);
  } finally { await close(); }
});

test('panel gets the full list and widget clients get only versions on every change', async () => {
  const { base, call, close } = await start();
  const panel = await sse(base + '/api/stream?client=panel');
  const widget = await sse(base + '/api/stream?client=widget');
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const list = await panel.next('customOverlays', d => d.some(o => o.id === overlay.id));
    assert.equal(list.find(o => o.id === overlay.id).js, SAMPLE.js);
    const v1 = await widget.next('customOverlayVersions', d => overlay.id in d);
    assert.deepEqual(Object.keys(v1), [overlay.id]);
    assert.equal(typeof v1[overlay.id], 'number');
    await new Promise(r => setTimeout(r, 5));
    await call('PUT', '/api/custom-overlays/' + overlay.id, { css: 'x{}' });
    const v2 = await widget.next('customOverlayVersions', d => d[overlay.id] > v1[overlay.id]);
    assert.ok(v2[overlay.id] > v1[overlay.id]);
    await call('DELETE', '/api/custom-overlays/' + overlay.id);
    await widget.next('customOverlayVersions', d => !(overlay.id in d));
    assert.deepEqual(await panel.next('customOverlays', d => d.length === 0), []);
  } finally { panel.close(); widget.close(); await close(); }
});

test('custom overlays appear in /api/sources and /api/state', async () => {
  const { call, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', SAMPLE);
    const { sources } = await call('GET', '/api/sources');
    const s = sources.find(x => x.id === 'custom-' + overlay.id);
    assert.ok(s, 'source listed');
    assert.equal(s.path, '/custom/' + overlay.id);
    assert.equal(s.width, 1280);
    assert.equal(s.height, 720);
    assert.match(s.name, /Marco cámara/);
    const state = await call('GET', '/api/state');
    assert.deepEqual(state.customOverlays.map(o => o.id), [overlay.id]);
  } finally { await close(); }
});
