// #66: the tier list vote panel keeps its size when the vote data changes
// (vote count, item name, timer), so the overlay does not jump on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('tier list: the vote panel keeps its size when votes and texts change', { timeout: 90000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-tierlist-66-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/widget/tierlist?demo`);
    const c = chrome.cdp;
    await waitDom(c, `!document.getElementById('vote').hidden && document.querySelectorAll('#bars .bar').length === 5`, { timeoutMs: 12000 });
    const size = () => evaluateChrome(c, `JSON.stringify((() => {
      const r = el => { const b = document.querySelector(el).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
      return { vote: r('#vote'), bars: r('#bars') };
    })())`).then(JSON.parse);
    const before = await size();
    // what apply() writes when the data changes: a long item name, many votes and a running timer
    for (const [vitem, how, timer] of [
      ['A very long item name that takes much more room than the demo one', 'Escribe <b>S</b> <b>A</b> <b>B</b> <b>C</b> <b>D</b> o <b>!tier S</b> · 12345 votos', '· 120s'],
      ['X', 'Escribe <b>!tier S</b> · 1 voto', ''],
    ]) {
      await evaluateChrome(c, `(() => { document.getElementById('vitem').textContent = ${JSON.stringify(vitem)};
        document.getElementById('how').innerHTML = ${JSON.stringify(how)}; document.getElementById('timer').textContent = ${JSON.stringify(timer)}; return true; })()`);
      assert.deepEqual(await size(), before, `same size with "${vitem}" / "${how}"`);
    }
  } finally { if (chrome) await closeChrome(chrome); app.meld.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); }
});
