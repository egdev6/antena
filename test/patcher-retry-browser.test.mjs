// A failed save from the panel must not lose the change: the patcher puts the patch back in the
// queue and retries with backoff. Here the first PUT /api/widgets fails (500) and the value typed
// in the panel still has to end up stored, with a single error toast for the failure streak.
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

test('widget chat: a PUT that fails once is retried and the panel change is stored', { timeout: 90000 }, async t => {
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
    chrome = await openChromePage(bin, `${base}/#/widget/chat`);
    const c = chrome.cdp;
    await waitDom(c, `!!(${fontInput})`, { timeoutMs: 15000 });
    // counts the error toasts shown (each toast() call bumps the text, even if it is the same)
    await evaluateChrome(c, `(() => { window.__errToasts = 0; const t = document.querySelector('.toast'); new MutationObserver(() => { if (t.classList.contains('err') && t.classList.contains('on')) window.__errToasts++; }).observe(t, { attributes: true, childList: true, characterData: true, subtree: true }); return true; })()`);

    await evaluateChrome(c, `(() => { const i = ${fontInput}; i.focus(); i.select(); return true; })()`);
    await c.send('Input.insertText', { text: '40' });
    assert.equal(await evaluateChrome(c, `${fontInput}.value`), '40');

    for (let i = 0; i < 100 && app.store.config.widgets?.chat?.fontSize !== 40; i++) await sleep(100);
    assert.ok(puts.length >= 2, `the failed PUT is retried (PUTs seen: ${puts.length})`);
    assert.equal(app.store.config.widgets?.chat?.fontSize, 40, 'the change survives the failed PUT and is stored by the retry');
    assert.ok(await evaluateChrome(c, `window.__errToasts >= 1`), 'the failure is reported with an error toast');
    assert.equal(await evaluateChrome(c, `${fontInput}.value`), '40');
  } finally {
    if (chrome) { chrome.child.kill(); await chrome.cdp.close(); }
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
