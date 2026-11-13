// Fuentes para Meld shows only the list of browser layers (no tabs), and the
// "Paneles" offers opening the dock from the floating windows section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-fuentes-dock-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); await rm(dataDir, { recursive: true, force: true }); } };
}
const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });

test('Fuentes para Meld lists the layers without tabs', { timeout: 60000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${ctx.base}/#/fuentes`);
    await waitDom(chrome.cdp, `document.querySelector('main h1')?.textContent.trim() === 'Fuentes para Meld' && !!document.querySelector('main .lv-list tbody tr')`, { timeoutMs: 15000 });
    assert.equal(await dom(chrome, `document.querySelectorAll('main [role=tab]').length`), 0, 'no tabs');
    const text = await dom(chrome, `document.querySelector('main').textContent`);
    assert.match(text, /Alertas/);
    assert.doesNotMatch(text, /Paneles dentro de Meld|Cómo añadirlas/);
    await dom(chrome, `location.hash = '#/fuentes/paneles'`);
    await waitDom(chrome.cdp, `!!document.querySelector('main .lv-list tbody tr')`, { timeoutMs: 12000 });
    assert.doesNotMatch(await dom(chrome, `document.querySelector('main').textContent`), /Paneles dentro de Meld/, 'old tab links fall back to the list');
  } finally { await closeAll(() => chrome && closeChrome(chrome), () => ctx.close()); }
});

test('Paneles offers opening the dock in ventanas flotantes', { timeout: 60000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${ctx.base}/#/prompter`);
    await waitDom(chrome.cdp, `document.querySelector('main h1')?.textContent.trim() === 'Paneles'`, { timeoutMs: 15000 });
    assert.equal(await dom(chrome, `document.querySelectorAll('main .view-head .actions button').length`), 0);
    assert.match(await dom(chrome, `document.querySelector('main').textContent`), /Ventanas flotantes/);
    await dom(chrome, `(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; return 'ok'; })()`);
    await dom(chrome, `Array.from(document.querySelectorAll('main .eg-btn')).find(b => b.textContent.trim() === 'Abrir el dock').click()`);
    await waitDom(chrome.cdp, `window.__opened.length === 1`, { timeoutMs: 5000 });
    assert.equal(await dom(chrome, `window.__opened[0][0]`), '/dock');
  } finally { await closeAll(() => chrome && closeChrome(chrome), () => ctx.close()); }
});
