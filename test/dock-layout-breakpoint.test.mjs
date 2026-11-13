// The dock uses its viewport width, not orientation, to choose tabs or columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const html = `<!doctype html><html lang="es"><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/ds/tokens.css">
<link rel="stylesheet" href="/ds/bundle.css">
<link rel="stylesheet" href="/assets/dock.css">
</head><body><div id="root"></div><script type="module" src="/assets/dock.js"></script></body></html>`;

// Build the current source in the test's temporary directory; never overwrite app/dist.
async function buildDock(dist) {
  const assets = path.join(dist, 'assets');
  const result = await build({
    entryPoints: { dock: 'app/src/dock/main.tsx' },
    outdir: assets, bundle: true, format: 'esm', minify: true, write: false,
    target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, external: ['/fonts/*', '/ds/*'],
  });
  await mkdir(assets, { recursive: true });
  await Promise.all([
    ...result.outputFiles.map(file => writeFile(file.path, file.contents)),
    writeFile(path.join(dist, 'index.html'), html),
    writeFile(path.join(dist, 'dock.html'), html),
  ]);
}

const layout = chrome => evaluateChrome(chrome.cdp, `(() => {
  const cols = document.querySelector('.d-cols');
  return {
    viewport: [innerWidth, innerHeight],
    tabs: [...document.querySelectorAll('.d-tabs [role="tab"]')]
      .filter(tab => tab.getClientRects().length && getComputedStyle(tab).visibility === 'visible')
      .map(tab => tab.firstChild.textContent.trim()),
    selected: [...document.querySelectorAll('.d-tabs [role="tab"][aria-selected="true"]')]
      .map(tab => tab.firstChild.textContent.trim()),
    panels: [...document.querySelectorAll('.d-panels > [role="tabpanel"]')]
      .filter(panel => !panel.hidden && panel.getClientRects().length && getComputedStyle(panel).visibility === 'visible').map(panel => panel.id),
    grid: cols ? getComputedStyle(cols).display : null,
    columns: [...document.querySelectorAll('.d-cols > .d-col')].map(col => {
      const rect = col.getBoundingClientRect();
      return { label: col.querySelector('.d-col-h').firstChild.textContent.trim(),
        visible: getComputedStyle(col).visibility === 'visible',
        left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
    }),
  };
})()`, { timeoutMs: 12000 });

function assertLayout(actual, width, height, wide) {
  assert.deepEqual(actual.viewport, [width, height]);
  if (!wide) {
    assert.deepEqual(actual.tabs, ['Control', 'Audio', 'Interactivos']);
    assert.deepEqual(actual.selected, ['Control']);
    assert.deepEqual(actual.panels, ['d-p-control']);
    assert.deepEqual(actual.columns, []);
    assert.equal(actual.grid, null);
    return;
  }
  assert.deepEqual(actual.tabs, []);
  assert.deepEqual(actual.selected, []);
  assert.deepEqual(actual.panels, []);
  assert.equal(actual.grid, 'grid');
  assert.deepEqual(actual.columns.map(col => col.label), ['Control', 'Audio', 'Interactivos']);
  for (const [index, col] of actual.columns.entries()) {
    assert.ok(col.visible && col.width > 0 && col.height > 0 && col.left >= 0 && col.right <= width + 1);
    if (index) {
      assert.ok(col.left >= actual.columns[index - 1].right - 1, 'columns do not overlap');
      assert.equal(col.top, actual.columns[0].top, 'columns share a row');
    }
  }
}

const resize = (chrome, width, height) => chrome.cdp.send('Emulation.setDeviceMetricsOverride', {
  width, height, deviceScaleFactor: 1, mobile: false,
});

test('dock breakpoint: initial viewport and live resize', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');

  const dir = await mkdtemp(path.join(tmpdir(), 'dock-breakpoint-'));
  let chrome, app, meld;
  t.after(async () => {
    try {
      if (chrome) await closeChrome(chrome);
    } finally {
      try {
        if (app) {
          app.timers.stop();
          app.interactive.quiesceVoteTimer();
          await app.interactive.drainDraws().catch(() => {});
          await app.interactive.flush().catch(() => {});
          await new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
        }
      } finally {
        try { if (meld) await new Promise(r => meld.server.close(r)); }
        finally { await rm(dir, { recursive: true, force: true }); }
      }
    }
  });

  const dist = path.join(dir, 'dist');
  await buildDock(dist);
  meld = fakeMeld();
  await new Promise(r => meld.server.listen(0, '127.0.0.1', r));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), appDist: dist, push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/meld/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `ws://127.0.0.1:${meld.server.address().port}` }),
  });
  assert.equal(response.status, 200);
  chrome = await openChromePage(bin, 'about:blank');

  for (const [width, height, wide] of [
    [1000, 700, false],
    [1023, 700, false],
    [1024, 700, true],
    [1024, 1400, true],
    [900, 1400, false],
    [768, 1024, false],
    [1256, 780, true],
  ]) {
    await t.test(`${width}×${height}: ${wide ? 'three columns' : 'tabs'}`, async () => {
      await resize(chrome, width, height);
      const marker = `${width}x${height}`;
      await chrome.cdp.send('Page.navigate', { url: `${base}/dock?viewport=${marker}` });
      await waitDom(chrome.cdp, `location.search === '?viewport=${marker}' && !!document.querySelector('.dock')`, { timeoutMs: 20000 });
      assertLayout(await layout(chrome), width, height, wide);
    });
  }

  await t.test('resizing across 1024 preserves the selected section', async () => {
    await resize(chrome, 900, 1400);
    await waitDom(chrome.cdp, `!!document.querySelector('#d-t-audio')`);
    await evaluateChrome(chrome.cdp, `document.querySelector('#d-t-audio').click()`);
    await waitDom(chrome.cdp, `document.querySelector('#d-t-audio')?.getAttribute('aria-selected') === 'true' && !document.querySelector('#d-p-audio').hidden`);
    await resize(chrome, 1024, 1400);
    await waitDom(chrome.cdp, `document.querySelectorAll('.d-cols > .d-col').length === 3`, { timeoutMs: 2000 });
    assertLayout(await layout(chrome), 1024, 1400, true);
    await resize(chrome, 1023, 700);
    await waitDom(chrome.cdp, `document.querySelector('#d-t-audio')?.getAttribute('aria-selected') === 'true' && !document.querySelector('#d-p-audio').hidden`);
    const actual = await layout(chrome);
    assert.deepEqual(actual.viewport, [1023, 700]);
    assert.deepEqual(actual.tabs, ['Control', 'Audio', 'Interactivos']);
    assert.deepEqual(actual.selected, ['Audio']);
    assert.deepEqual(actual.panels, ['d-p-audio']);
    assert.deepEqual(actual.columns, []);
  });
});
