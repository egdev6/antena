// #355: overlay pages opened in OBS/Meld reload themselves once when they reconnect to an
// Antena of a different version, so a stale page never misses widgets added by an update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function startApp(t, appVersion, port = 0) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-build-reload-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, appVersion });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
  return { app, port: app.server.address().port };
}

/** Reads the first frames of a stream until `ms` elapse. */
async function firstFrames(base, query, ms = 400) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream?${query}`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); } }
  catch {} finally { clearTimeout(timer); }
  return text;
}

test('the stream announces the app version only to clients that ask for it', async t => {
  const { app, port } = await startApp(t, '9.9.9');
  t.after(() => app.closeHttp());
  const base = `http://127.0.0.1:${port}`;
  const opted = await firstFrames(base, 'client=widget&themeInfo=1&build=1');
  assert.match(opted, /event: build\ndata: \{"version":"9\.9\.9"\}\n\n/);
  const legacy = await firstFrames(base, 'client=widget&themeInfo=1');
  assert.doesNotMatch(legacy, /event: build/);
  assert.match(legacy, /event: widgets\n/);
  const overlay = await firstFrames(base, 'client=overlay&build=1');
  assert.match(overlay, /event: build\ndata: \{"version":"9\.9\.9"\}\n\n/);
});

test('the stream defaults to the package version', async t => {
  const { app, port } = await startApp(t, undefined);
  t.after(() => app.closeHttp());
  const { version } = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const text = await firstFrames(`http://127.0.0.1:${port}`, 'client=widget&build=1');
  assert.ok(text.includes(`event: build\ndata: ${JSON.stringify({ version })}\n\n`));
});

test('widget, alert overlay and custom overlay pages reload once after an update, not after a plain restart', { timeout: 90000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local');
  let { app, port } = await startApp(t, '1.0.0');
  const base = `http://127.0.0.1:${port}`;
  const overlay = (await (await fetch(base + '/api/custom-overlays', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Reload', js: '' }) })).json()).overlay;
  const pages = ['/widget/latest', '/overlay', `/custom/${overlay.id}`];
  const chromes = [];
  try {
    for (const p of pages) {
      const chrome = await openChromePage(bin, base + p);
      chromes.push(chrome);
      await waitDom(chrome.cdp, `document.readyState === 'complete'`);
      await new Promise(r => setTimeout(r, 500));
      await evaluateChrome(chrome.cdp, `window.__stale = 1`);
    }
    const restart = async version => {
      await app.closeHttp();
      // A fresh data dir per app: the custom shell only checks its own reload (its frame may 404 after it).
      ({ app } = await startApp(t, version, port));
    };
    // Plain restart, same version: the pages reconnect and keep running.
    await restart('1.0.0');
    await new Promise(r => setTimeout(r, 4500));
    for (const [i, chrome] of chromes.entries()) assert.equal(await evaluateChrome(chrome.cdp, `window.__stale`), 1, `${pages[i]} reloaded without an update`);
    // Update: each page reloads once and drops its stale state.
    await restart('1.0.1');
    for (const chrome of chromes) await waitDom(chrome.cdp, `window.__stale === undefined && document.readyState === 'complete'`, { timeoutMs: 15000 });
    for (const chrome of chromes) await evaluateChrome(chrome.cdp, `window.__fresh = 1`);
    await new Promise(r => setTimeout(r, 3000));
    for (const [i, chrome] of chromes.entries()) assert.equal(await evaluateChrome(chrome.cdp, `window.__fresh`), 1, `${pages[i]} reloaded more than once`);
  } finally {
    await closeAll(...chromes.map(c => () => closeChrome(c)), () => app.closeHttp());
  }
});
