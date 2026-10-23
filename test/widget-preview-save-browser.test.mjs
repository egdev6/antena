// Changing a widget field FROM THE PANEL must reach the server (PUT /api/widgets) and the
// preview iframe. The other browser tests change the config through the API, so the panel path
// (WField → patchWidgets → patcher) had no coverage and never sent the PUT.
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
const previewFs = `document.querySelector('main iframe')?.contentDocument?.getElementById('root')?.style.getPropertyValue('--fs')`;

test('widget chat: a field changed from the panel is saved and reaches the preview', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-preview-save-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/widget/chat`);
    const c = chrome.cdp;
    await waitDom(c, `!!(${fontInput}) && ${previewFs} === '26px'`, { timeoutMs: 15000 });

    // real typing: focus and select the field, then insert the text as keyboard input
    await evaluateChrome(c, `(() => { const i = ${fontInput}; i.focus(); i.select(); return true; })()`);
    await c.send('Input.insertText', { text: '40' });
    assert.equal(await evaluateChrome(c, `${fontInput}.value`), '40');

    for (let i = 0; i < 50 && app.store.config.widgets?.chat?.fontSize !== 40; i++) await sleep(100);
    assert.equal(app.store.config.widgets?.chat?.fontSize, 40, 'the panel saves the change with PUT /api/widgets');
    await waitDom(c, `${previewFs} === '40px'`, { timeoutMs: 8000 });
  } finally {
    if (chrome) { chrome.child.kill(); await chrome.cdp.close(); }
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
