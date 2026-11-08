// #68: the giveaway preview shows demo data while the giveaway is closed, with the saved
// settings (title, prize), and switches to the real widget once the giveaway opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { findChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-giveaway-68-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async r => { if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`); return r.json(); });
  return { base, api, close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('giveaway widget demo uses the saved title and prize and creates no entries', { timeout: 90000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const { base, api, close } = await start();
  let chrome;
  try {
    await api('PUT', '/api/interactive/config', { giveaway: { title: 'Gran sorteo', prize: 'un teclado', command: '!entro' } });
    chrome = await openChromePage(bin, `${base}/widget/giveaway?demo`);
    const c = chrome.cdp;
    await waitDom(c, `document.getElementById('g').classList.contains('on') && document.getElementById('title').textContent === 'Gran sorteo'`, { timeoutMs: 12000 });
    const shown = JSON.parse(await evaluateChrome(c, `JSON.stringify({ prize: document.getElementById('prize').textContent, join: document.getElementById('join').textContent })`));
    assert.deepEqual(shown, { prize: 'un teclado', join: 'Escribe !entro en el chat para entrar' });
    const s = await api('GET', '/api/interactive');
    assert.equal(s.giveaway.open, false, 'the preview does not open the giveaway');
    assert.equal(s.giveaway.count, 0, 'the preview creates no entries');
    assert.deepEqual(s.giveaway.winners, [], 'the preview creates no winners');
  } finally { chrome?.child.kill(); chrome?.cdp.close(); await close(); }
});

test('panel giveaway preview: demo while closed, real widget once open', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const { base, api, close } = await start();
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/sorteo/ajustes`);
    const c = chrome.cdp;
    const src = `document.querySelector('main .preview-col .eg-stage iframe')?.getAttribute('src') || ''`;
    await waitDom(c, `(${src}).startsWith('/widget/giveaway?demo')`, { timeoutMs: 15000 });
    assert.match(await evaluateChrome(c, `document.querySelector('main .preview-col .eg-stage__bar').textContent`), /Datos de ejemplo/);
    await api('POST', '/api/giveaway/open', {});
    await waitDom(c, `(${src}) === '/widget/giveaway?debug'`, { timeoutMs: 10000 });
  } finally { chrome?.child.kill(); chrome?.cdp.close(); await close(); }
});
