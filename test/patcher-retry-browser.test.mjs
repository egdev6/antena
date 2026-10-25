// A failed save from the panel must not lose the change. With manual save (v2) the widget editor
// keeps the change as a draft: the first «Guardar» hits a failing PUT /api/widgets (500), shows an
// error toast and the draft stays; pressing «Guardar» again stores it. (Outside manual save the
// patcher in app/src/lib/patch.ts retries on its own with backoff.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fontInput = `Array.from(document.querySelectorAll('main label')).find(l => l.textContent.startsWith('Tamaño de letra'))?.querySelector('input')`;

test('widget chat: a «Guardar» that fails keeps the draft and the next one stores it', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-patcher-retry-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  // the first PUT /api/widgets answers 500 without reaching the app; the rest go through
  const handlers = app.server.listeners('request');
  app.server.removeAllListeners('request');
  const puts = [];
  app.server.on('request', (req, res) => {
    if (req.method === 'PUT' && req.url.startsWith('/api/widgets')) {
      puts.push(Date.now());
      if (puts.length === 1) {
        req.resume();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'fallo simulado' }));
      }
    }
    for (const h of handlers) h.call(app.server, req, res);
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/widgets/chat`);
    const c = chrome.cdp;
    await waitDom(c, `!!(${fontInput})`, { timeoutMs: 15000 });
    // counts the error toasts shown (each toast() call bumps the text, even if it is the same)
    await evaluateChrome(c, `(() => { window.__errToasts = 0; const t = document.querySelector('.toast'); new MutationObserver(() => { if (t.classList.contains('err') && t.classList.contains('on')) window.__errToasts++; }).observe(t, { attributes: true, childList: true, characterData: true, subtree: true }); return true; })()`);

    await evaluateChrome(c, `(() => { const i = ${fontInput}; i.focus(); i.select(); return true; })()`);
    await c.send('Input.insertText', { text: '40' });
    assert.equal(await evaluateChrome(c, `${fontInput}.value`), '40');

    const saveBtn = `document.querySelector('.lv-sfoot .eg-btn--secondary')`;
    await waitDom(c, `!!${saveBtn} && !${saveBtn}.disabled`, { timeoutMs: 9000 });
    await sleep(600);
    assert.equal(puts.length, 0, 'nothing is sent before «Guardar»');
    await evaluateChrome(c, `${saveBtn}.click()`);
    await waitDom(c, `window.__errToasts >= 1`, { timeoutMs: 9000 });
    assert.equal(puts.length, 1, 'the first save hits the failing PUT');
    assert.notEqual(app.store.config.widgets?.chat?.fontSize, 40, 'the failed save stores nothing');
    assert.equal(await evaluateChrome(c, `${fontInput}.value`), '40', 'the draft is kept');
    await evaluateChrome(c, `${saveBtn}.click()`);
    for (let i = 0; i < 100 && app.store.config.widgets?.chat?.fontSize !== 40; i++) await sleep(100);
    assert.equal(puts.length, 2, 'the second «Guardar» sends again');
    assert.equal(app.store.config.widgets?.chat?.fontSize, 40, 'the change survives the failed PUT and is stored');
    assert.equal(await evaluateChrome(c, `${fontInput}.value`), '40');
  } finally {
    if (chrome) { chrome.child.kill(); await chrome.cdp.close(); }
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
