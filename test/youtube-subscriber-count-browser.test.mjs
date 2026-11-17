// Compile the real panel into temporary data, never the checkout's app/dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const label = 'Avisar de suscriptores sin nombre («+N suscriptores»)';
const checkbox = `([...document.querySelectorAll('#youtube label')].find(l => l.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input[type="checkbox"]'))`;
const save = `([...document.querySelectorAll('.lv-savebar button')].find(b => b.textContent.trim() === 'Guardar'))`;

test('S4/S5: the real Connections switch saves, persists, and appears in the alert catalog', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH');
  const root = await mkdtemp(path.join(tmpdir(), 'youtube-count-panel-'));
  let app, page;
  t.after(() => closeAll(() => page && closeChrome(page), async () => {
    if (app) {
      app.followers.halt(); app.channelTotals.halt();
      await app.session.flush(); await app.closeHttp();
    }
  }, () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  const dist = path.join(root, 'dist'), assets = path.join(dist, 'assets');
  const result = await build({ entryPoints: [fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url))],
    outfile: path.join(root, 'panel.js'), bundle: true, format: 'esm', write: false,
    target: ['chrome110'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/ds/*'], logLevel: 'silent' });
  await mkdir(assets, { recursive: true });
  await Promise.all(result.outputFiles.map(file => writeFile(path.join(assets, 'panel' + path.extname(file.path)), file.contents)));
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><html lang="es"><head><link rel="stylesheet" href="/assets/panel.css"></head><body><div id="root"></div><script type="module" src="/assets/panel.js"></script></body></html>');
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, body) => {
    const response = await fetch(base + '/api/config', { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  };
  await api('PUT', { panel: { onboardingDone: true } });
  page = await openChromePage(bin, `${base}/#/conexiones/youtube`);
  const c = page.cdp, dom = expr => evaluateChrome(c, expr, { timeoutMs: 8000 });
  await waitDom(c, `!!${checkbox}`, { timeoutMs: 8000 });
  assert.equal(await dom(`${checkbox}.checked`), true);
  assert.equal((await api('GET')).youtube.subscriberCountAlert, true);
  await clickWhen(c, checkbox);
  await waitDom(c, `!!document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await api('GET')).youtube.subscriberCountAlert, true, 'change is only a draft before save');
  await clickWhen(c, save);
  await waitDom(c, `!document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await api('GET')).youtube.subscriberCountAlert, false);
  await dom('window.__beforeSubscriberReload = true');
  await c.send('Page.reload');
  await waitDom(c, `!window.__beforeSubscriberReload && !!${checkbox} && !${checkbox}.checked`);
  // Existing YouTube interval edits still save via the same manual draft.
  await dom(`(() => { const e = document.querySelector('#youtube input[type="number"][min="0"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '180');
    e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitDom(c, `!!document.querySelector('.lv-savebar.is-open')`);
  await clickWhen(c, save); await waitDom(c, `!document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await api('GET')).youtube.subscriberPollSeconds, 180);
  assert.equal((await api('GET')).youtube.subscriberCountAlert, false);
  await dom(`location.hash = '#/alertas'`);
  await waitDom(c, `!!document.querySelector('a[href="#/alertas/ytsubcount"]')`);
  const card = await dom(`document.querySelector('a[href="#/alertas/ytsubcount"]').closest('article').textContent`);
  assert.match(card, /Suscriptores sin nombre/);
  assert.match(card, /Sistema/); assert.doesNotMatch(card, /Récord/);
  const viewerCard = await dom(`document.querySelector('a[href="#/alertas/ytviewers"]').closest('article').textContent`);
  assert.match(viewerCard, /Récord/, 'the existing viewer record badge is preserved');
});
