import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

// The ticker loops one block of items. When the items are narrower than the track, one block must be
// repeated until it covers the track, otherwise the loop restart cuts the last item in half.
const LOOP = `(() => {
  const run = document.getElementById('run'), track = run.parentElement, a = run.getAnimations()[0];
  if (!a) return null;
  const to = a.effect.getKeyframes().at(-1).transform;
  return { block: run.scrollWidth / 2, track: track.clientWidth, distance: -parseFloat(to.match(/-?[\\d.]+/)[0]), items: run.querySelectorAll('.it').length };
})()`;

test('the ticker loop is seamless with short and long item lists', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-ticker-loop-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    for (const url of ['/widget/ticker', '/widget/ticker?demo']) {   // default short text, then the demo events
      chrome = await openChromePage(bin, 'about:blank');
      await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 200, deviceScaleFactor: 1, mobile: false });
      await chrome.cdp.send('Page.navigate', { url: base + url });
      await waitDom(chrome.cdp, `document.getElementById('run')?.getAnimations().length > 0`);
      const loop = await evaluateChrome(chrome.cdp, LOOP);
      assert.ok(loop.block >= loop.track, `${url}: one loop block (${loop.block}px) covers the track (${loop.track}px)`);
      assert.ok(Math.abs(loop.distance - loop.block) < 1, `${url}: the animation moves exactly one block`);
      assert.equal(loop.items % 2, 0, `${url}: two identical blocks`);
      await closeChrome(chrome); chrome = null;
    }
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
