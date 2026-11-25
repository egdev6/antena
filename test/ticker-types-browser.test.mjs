// Ticker: it follows the «Últimos» types (widgets.latest.items) until it has its own (widgets.ticker.items).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('the ticker follows «Últimos» until it gets its own types', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-ticker-types-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.ok, true, url); return r.json(); };
  const users = `[...new Set([...document.querySelectorAll('#run .it b')].map(b => b.textContent))].sort()`;
  let chrome;
  try {
    for (const [type, user] of [['follow', 'u_follow'], ['resub', 'u_resub'], ['raid', 'u_raid'], ['cheer', 'u_cheer']])
      assert.equal((await call('POST', '/api/simulate', { type, vars: { user } })).ok, true, type);
    await call('PUT', '/api/widgets', { latest: { items: ['follow', 'sub'] } });
    chrome = await openChromePage(bin, base + '/widget/ticker');
    const c = chrome.cdp;
    // follow → follow/ytsub, sub → sub/resub/giftsub; raid and cheer are not selected.
    await waitDom(c, `JSON.stringify(${users}) === JSON.stringify(['u_follow', 'u_resub'])`, { timeoutMs: 10000 });

    await call('PUT', '/api/widgets', { latest: { items: ['any'] } });
    await waitDom(c, `JSON.stringify(${users}) === JSON.stringify(['u_cheer', 'u_follow', 'u_raid', 'u_resub'])`, { timeoutMs: 8000 });

    await call('PUT', '/api/widgets', { latest: { items: ['superchat'] } });   // nothing matches: the placeholder text
    await waitDom(c, `${users}.length === 1 && ${users}[0] === 'egdev.es'`, { timeoutMs: 8000 });
    assert.deepEqual(await evaluateChrome(c, users), ['egdev.es']);

    // Own selection: the ticker stops following «Últimos».
    await call('PUT', '/api/widgets', { ticker: { items: ['cheer', 'raid'] } });
    await waitDom(c, `JSON.stringify(${users}) === JSON.stringify(['u_cheer', 'u_raid'])`, { timeoutMs: 8000 });
    await call('PUT', '/api/widgets', { latest: { items: ['follow'] } });
    await new Promise(r => setTimeout(r, 600));
    assert.deepEqual(await evaluateChrome(c, users), ['u_cheer', 'u_raid']);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
