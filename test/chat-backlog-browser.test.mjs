// Chat widget backlog: on load it shows the last maxMessages messages that are visible, so hidden
// messages (your own, commands, other platforms) do not use up the limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('the chat backlog fills the limit with visible messages only', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-chat-backlog-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (url, body, method = 'POST') => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.ok, true); };
  let chrome;
  try {
    await post('/api/widgets', { chat: { maxMessages: 4, hideOwner: true, hideCommands: true } }, 'PUT');
    for (let i = 1; i <= 6; i++) await post('/api/chat/simulate', { user: 'viewer' + i, text: 'visible ' + i, platform: 'twitch' });
    for (let i = 1; i <= 5; i++) await post('/api/chat/simulate', { user: 'egdev6', text: 'propio ' + i, platform: 'twitch', owner: true });
    await post('/api/chat/simulate', { user: 'viewer7', text: '!comando', platform: 'twitch' });

    chrome = await openChromePage(bin, base + '/widget/chat');
    await waitDom(chrome.cdp, `document.readyState === 'complete'`, { timeoutMs: 10000 });
    await new Promise(r => setTimeout(r, 1500));   // backlog rendered on the first widgets event
    const texts = await evaluateChrome(chrome.cdp, `[...document.querySelectorAll('#root .msg:not(.out) .text')].map(e => e.textContent)`);
    assert.deepEqual(texts, ['visible 3', 'visible 4', 'visible 5', 'visible 6'], 'the last 4 visible messages, in order');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
