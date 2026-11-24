// Rotating messages widget in Chrome: the page shows the saved messages and the panel edits the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('the rotator page shows the saved messages and the panel adds one', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-rotator-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const put = async body => { const r = await fetch(base + '/api/widgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); };
  let chrome;
  try {
    await put({ rotator: { label: 'Aviso', messages: [{ id: 'm1', text: 'Primero' }, { id: 'm2', text: 'Segundo' }] } });
    chrome = await openChromePage(bin, base + '/widget/rotator');
    await waitDom(chrome.cdp, `document.getElementById('item').classList.contains('on') && document.getElementById('text').textContent === 'Primero'`, { timeoutMs: 10000 });
    assert.equal(await evaluateChrome(chrome.cdp, `document.getElementById('label').textContent`), 'Aviso');
    await closeChrome(chrome); chrome = null;

    chrome = await openChromePage(bin, base + '/#/widgets/rotator');
    const c = chrome.cdp;
    await waitDom(c, `document.querySelectorAll('input[aria-label^="Mensaje "]').length === 2`, { timeoutMs: 15000 });
    await evaluateChrome(c, `[...document.querySelectorAll('button')].find(b => b.textContent.includes('Añadir mensaje')).click(); true`);
    await waitDom(c, `document.querySelectorAll('input[aria-label^="Mensaje "]').length === 3`, { timeoutMs: 5000 });
    await evaluateChrome(c, `(() => { const i = document.querySelector('input[aria-label="Mensaje 3"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Tercero'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitDom(c, `[...document.querySelectorAll('button')].some(b => /^Guardar/.test(b.textContent.trim()) && !b.disabled)`, { timeoutMs: 5000 });
    await evaluateChrome(c, `[...document.querySelectorAll('button')].find(b => /^Guardar/.test(b.textContent.trim())).click(); true`);
    for (let i = 0; i < 50; i++) {
      const saved = (await (await fetch(base + '/api/widgets')).json()).widgets.rotator.messages.map(m => m.text);
      if (saved.length === 3) { assert.deepEqual(saved, ['Primero', 'Segundo', 'Tercero']); return; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.fail('the panel did not save the new message');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
