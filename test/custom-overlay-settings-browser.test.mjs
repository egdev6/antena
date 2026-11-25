// Custom overlay settings in Chrome (#344): the sandboxed page reads antena.settings, gets value
// changes live without reloading, sees media as an absolute URL and reloads only when fields change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const JS = `const boot = String(Math.random());
let ready = 'no';
antena.ready.then(() => { ready = antena.settings ? 'yes' : 'no'; });
// Opaque sandbox: report the state to the shell (it ignores messages without antena: 1) so the test can read it.
setInterval(() => parent.postMessage({ probe: { boot, ready, title: antena.settings && antena.settings.title, image: antena.settings && antena.settings.image } }, '*'), 200);`;

test('the sandboxed page receives its settings, live value changes and a reload only for field changes', { timeout: 90000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-overlay-settings-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.ok, true, p); return (await r.json()).overlay; };
  const fields = [{ key: 'title', label: 'Título', type: 'text', default: 'Hola' }, { key: 'image', label: 'Imagen', type: 'media' }];
  const overlay = await call('POST', '/api/custom-overlays', { name: 'Ajustes', js: JS, fields, values: { image: 'logo y fondo.png' } });
  let chrome;
  try {
    chrome = await openChromePage(bin, base + '/custom/' + overlay.id);
    const c = chrome.cdp;
    // The page lives in an opaque sandbox: it reports its state to the shell, where the test listens.
    await evaluateChrome(c, `window.addEventListener('message', e => { if (e.data && e.data.probe) window.__probe = e.data.probe; }); true`);
    const frameData = () => evaluateChrome(c, 'window.__probe || null');
    const until = async (pred, what, timeoutMs = 10000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const d = await frameData().catch(() => null);
        if (d && pred(d)) return d;
        if (Date.now() > deadline) assert.fail(`${what}: ${JSON.stringify(d)}`);
        await new Promise(r => setTimeout(r, 100));
      }
    };
    const first = await until(d => d.title === 'Hola' && d.ready === 'yes', 'initial settings before ready');
    assert.equal(first.image, base + '/media/' + encodeURIComponent('logo y fondo.png'), 'media becomes an absolute URL');

    await call('PUT', '/api/custom-overlays/' + overlay.id, { values: { title: 'Nuevo' } });
    const live = await until(d => d.title === 'Nuevo', 'live value');
    assert.equal(live.boot, first.boot, 'a values change does not reload the page');

    await call('PUT', '/api/custom-overlays/' + overlay.id, { fields: [...fields, { key: 'extra', type: 'text' }] });
    const reloaded = await until(d => d.boot && d.boot !== first.boot && d.title === 'Nuevo', 'reload after a fields change');
    assert.equal(reloaded.ready, 'yes');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
