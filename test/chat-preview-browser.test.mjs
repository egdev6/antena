// Chat preview in Chrome: a real chat source plays the demo stream and then restores its real messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('a real chat source plays the preview and restores its messages', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-chat-preview-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.ok, true); return r.json(); };
  const texts = `[...document.querySelectorAll('#root .msg:not(.out) .text')].map(e => e.textContent)`;
  let chrome;
  try {
    await post('/api/chat/simulate', { user: 'real1', text: 'mensaje real uno', platform: 'twitch' });
    chrome = await openChromePage(bin, base + '/widget/chat');
    const c = chrome.cdp;
    await waitDom(c, `${texts}.includes('mensaje real uno')`, { timeoutMs: 10000 });

    await post('/api/chat/preview', { on: true });
    await waitDom(c, `${texts}.length >= 6 && !${texts}.includes('mensaje real uno')`, { timeoutMs: 8000 });
    // A real message during the preview is kept for later, not shown.
    await post('/api/chat/simulate', { user: 'real2', text: 'mensaje real dos', platform: 'twitch' });
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await evaluateChrome(c, texts)).includes('mensaje real dos'), false);

    await post('/api/chat/preview', { on: false });
    await waitDom(c, `JSON.stringify(${texts}) === JSON.stringify(['mensaje real uno', 'mensaje real dos'])`, { timeoutMs: 8000 });
    await new Promise(r => setTimeout(r, 2600));   // the demo interval is gone: no new demo messages
    assert.deepEqual(await evaluateChrome(c, texts), ['mensaje real uno', 'mensaje real dos']);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

function holdPreviewStartResponse() {
  const fetch0 = window.fetch.bind(window);
  const probe = window.previewStart = { initialStatus: null, startStatus: null, posts: [] };
  const gate = new Promise(resolve => { probe.release = resolve; });
  window.fetch = async (url, options) => {
    if (new URL(url, location.href).pathname !== '/api/chat/preview') return fetch0(url, options);
    if (options?.method === 'GET') {
      const response = await fetch0(url, options);
      probe.initialStatus = response.status;
      return response;
    }
    const { on } = JSON.parse(options.body);
    probe.posts.push(on);
    const response = await fetch0(url, options);
    // Hold the real response after the server has started the preview; the stream remains live.
    if (on) { probe.startStatus = response.status; await gate; }
    return response;
  };
}

test('the panel button starts and stops the preview in the sources with a countdown', { timeout: 60000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-chat-preview-panel-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const state = async () => (await fetch(base + '/api/chat/preview')).json();
  const button = `[...document.querySelectorAll('button')].find(b => /Simular mensajes en Meld|Parar simulación en Meld/.test(b.textContent))`;
  let chrome;
  try {
    chrome = await openChromePage(bin, 'about:blank');
    const c = chrome.cdp;
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${holdPreviewStartResponse.toString()})()` });
    const navigation = await c.send('Page.navigate', { url: base + '/#/widgets/chat' });
    assert.ok(!navigation.errorText, navigation.errorText);
    const countdown = `/^Parar simulación en Meld · [12]:[0-5]\\d$/.test(${button}?.textContent)`;
    await waitDom(c, `window.previewStart.initialStatus === 200 && ${button}?.textContent === 'Simular mensajes en Meld' && !${button}.disabled`, { timeoutMs: 15000 });
    await evaluateChrome(c, `${button}.click(); true`);
    await waitDom(c, `window.previewStart.startStatus === 200 && ${countdown}`, { timeoutMs: 5000 });
    assert.equal((await state()).on, true);
    assert.equal(await evaluateChrome(c, `${button}.disabled`), true, 'the stream updates the label while the start response is held');
    await evaluateChrome(c, 'window.previewStart.release()');
    await waitDom(c, `${countdown} && !${button}.disabled`, { timeoutMs: 5000 });
    await evaluateChrome(c, `${button}.click(); true`);
    await waitDom(c, `${button}.textContent === 'Simular mensajes en Meld'`, { timeoutMs: 5000 });
    assert.deepEqual(await state(), { on: false, until: null });
    assert.deepEqual(await evaluateChrome(c, 'window.previewStart.posts'), [true, false]);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
