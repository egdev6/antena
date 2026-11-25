// #357 in Chrome: the «Mostrar» selector of «Últimos» switches the widget between this stream and all streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('«Mostrar» switches «Últimos» between this stream and the historical record', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-latest-history-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200, url); };
  const widgets = async () => (await (await fetch(base + '/api/widgets')).json()).widgets;
  const until = async (fn, what) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } assert.fail(what); };
  const big = `document.querySelector('#root .item-follow .big')?.textContent`;
  const chromes = [];
  try {
    await call('PUT', '/api/config', { panel: { onboardingDone: true } });
    app.engine.handleEvent({ externalId: 'real:follow:Ana', type: 'follow', vars: { user: 'Ana' } });
    await call('POST', '/api/session/new', { title: 'Nuevo directo' });

    // The widget follows the saved scope: this stream starts empty, the record keeps Ana.
    const widget = await openChromePage(bin, base + '/widget/latest');
    chromes.push(widget);
    await waitDom(widget.cdp, `${big} === '—'`, { timeoutMs: 10000 });

    // Panel: «Mostrar» starts on «Este directo»; choosing «Histórico» and saving stores scope «all».
    const panel = await openChromePage(bin, base + '/#/widgets/latest');
    chromes.push(panel);
    const c = panel.cdp, ev = s => evaluateChrome(c, s);
    const select = `[...document.querySelectorAll('main label')].find(l => l.textContent.trim().startsWith('Mostrar'))?.querySelector('select')`;
    await waitDom(c, `!!(${select})`, { timeoutMs: 15000 });
    assert.equal(await ev(`${select}.value`), 'stream');
    assert.deepEqual(await ev(`[...${select}.options].map(o => o.textContent)`), ['Este directo', 'Histórico']);
    await ev(`(() => { const s = ${select}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'all'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const save = `[...document.querySelectorAll('button')].find(b => /^Guardar/.test(b.textContent.trim()) && !b.disabled)`;
    await waitDom(c, `!!(${save})`, { timeoutMs: 5000 });
    await ev(`${save}.click(); true`);
    await until(async () => (await widgets()).latest.scope === 'all', 'the scope was not saved');
    await waitDom(widget.cdp, `${big} === 'Ana'`, { timeoutMs: 10000 });

    // Back to this stream: the card is empty again.
    await call('PUT', '/api/widgets', { latest: { scope: 'stream' } });
    await waitDom(widget.cdp, `${big} === '—'`, { timeoutMs: 10000 });
  } finally {
    await closeAll(...chromes.map(ch => () => closeChrome(ch)), () => new Promise(r => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }));
  }
});
