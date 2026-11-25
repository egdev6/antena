// Panel: «Últimos» and «Ticker» are separate widgets; the ticker types start from «Últimos» and «Últimos» has its own label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('the ticker is its own widget and «Últimos» shows its own label', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-latest-ticker-panel-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const widgets = async () => (await (await fetch(base + '/api/widgets')).json()).widgets;
  const put = async body => { const r = await fetch(base + '/api/widgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200); };
  const until = async (fn, what) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(what); };
  const save = `[...document.querySelectorAll('button')].find(b => /^Guardar/.test(b.textContent.trim()) && !b.disabled)`;
  const box = label => `[...document.querySelectorAll('main label.check')].find(l => l.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input')`;
  let chrome;
  try {
    await put({ latest: { items: ['follow', 'sub'] } });
    chrome = await openChromePage(bin, base + '/#/widgets');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);

    // Catalog: a Ticker card of its own next to «Últimos».
    await waitDom(c, `!!document.querySelector('a[href="#/widgets/ticker"]') && !!document.querySelector('a[href="#/widgets/latest"]')`, { timeoutMs: 15000 });
    assert.match(await ev(`document.querySelector('a[href="#/widgets/ticker"]').closest('.lv-card, article, li, div').textContent`), /Ticker/);

    // Ticker page: the checkboxes start with the «Últimos» types; one click gives the ticker its own list.
    await ev(`location.hash = '#/widgets/ticker'; true`);
    await waitDom(c, `!!(${box('Bits')})`, { timeoutMs: 12000 });
    assert.deepEqual(await ev(`[...document.querySelectorAll('main label.check')].filter(l => l.querySelector('input').checked).map(l => l.textContent.trim())`), ['Seguidor', 'Suscripción']);
    await ev(`${box('Bits')}.click(); true`);
    await waitDom(c, `!!(${save})`, { timeoutMs: 5000 });
    await ev(`${save}.click(); true`);
    await until(async () => JSON.stringify((await widgets()).ticker?.items) === JSON.stringify(['follow', 'sub', 'cheer']), 'the ticker types were not saved');
    // The router blocks leaving while a save is in flight: wait until the panel itself finished saving.
    // (both buttons are disabled while saving too, so wait for the save bar status itself)
    await waitDom(c, `document.querySelector('.lv-dirty')?.textContent === 'Todo guardado'`, { timeoutMs: 8000 });
    assert.deepEqual((await widgets()).latest.items, ['follow', 'sub'], '«Últimos» keeps its own types');

    // «Últimos» page: its own label field.
    await ev(`location.hash = '#/widgets/latest'; true`);
    await waitDom(c, `location.hash === '#/widgets/latest' && !!document.querySelector('main input[placeholder^="Últimos"]')`, { timeoutMs: 15000 });
    await ev(`(() => { const i = document.querySelector('main input[placeholder^="Últimos"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Últimos apoyos'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitDom(c, `!!(${save})`, { timeoutMs: 5000 });
    await ev(`${save}.click(); true`);
    await until(async () => (await widgets()).latest.label === 'Últimos apoyos', 'the «Últimos» label was not saved');
    await closeChrome(chrome); chrome = null;

    // The widget shows the label, and nothing when it is empty.
    chrome = await openChromePage(bin, base + '/widget/latest');
    await waitDom(chrome.cdp, `document.querySelector('#root .label')?.textContent === 'Últimos apoyos'`, { timeoutMs: 10000 });
    await put({ latest: { label: '' } });
    await waitDom(chrome.cdp, `!document.querySelector('#root .label') && document.querySelectorAll('#root .item').length === 2`, { timeoutMs: 8000 });
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
