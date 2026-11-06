// Fuentes para Meld shows only the list of browser layers (no tabs), and the
// "Prompter y dock" page offers opening the dock next to opening the prompter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-fuentes-dock-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
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
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await ctx.close(); }
});

test('Prompter y dock offers opening the dock and the prompter', { timeout: 60000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${ctx.base}/#/prompter`);
    await waitDom(chrome.cdp, `document.querySelector('main h1')?.textContent.trim() === 'Prompter y dock'`, { timeoutMs: 15000 });
    const actions = `Array.from(document.querySelectorAll('main .lv-head .eg-btn, main header .eg-btn')).map(b => b.textContent.trim())`;
    const labels = await dom(chrome, `${actions}.join('|')`);
    assert.match(labels, /Abrir la vista/);
    assert.match(labels, /Abrir el dock/);
    await dom(chrome, `(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; return 'ok'; })()`);
    await dom(chrome, `Array.from(document.querySelectorAll('main .eg-btn')).find(b => b.textContent.trim() === 'Abrir el dock').click()`);
    await waitDom(chrome.cdp, `window.__opened.length === 1`, { timeoutMs: 5000 });
    assert.equal(await dom(chrome, `window.__opened[0][0]`), '/dock');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await ctx.close(); }
});
