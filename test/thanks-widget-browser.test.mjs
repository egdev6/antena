// Browser behavior of the public thanks layer; never reads the panel build or real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'thanks-browser-'));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });

test('S1/S2: escaped names rotate one card at a time, unchanged events do not restart, reduced motion and empty state', { timeout: 90000 }, async t => {
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bin = await findChrome(); if (!bin) return t.skip('sin Chrome local');
  const twitch = blank(), youtube = blank();
  twitch.entries = [
    { id: 'a', name: '<img src=x onerror=alert(1)>', followedAt: '2026-01-01T00:00:00Z', source: 'offline', thanked: false },
    { id: 'b', name: 'Second', followedAt: '2026-01-02T00:00:00Z', source: 'offline', thanked: false },
  ];
  youtube.anonymous = [{ at: '2026-01-03T00:00:00Z', count: 2, thanked: false }];
  await writeFile(path.join(root, 'followers.json'), JSON.stringify({ version: 1, platforms: { twitch, youtube } }));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, route, body) => fetch(base + route, { method, body: JSON.stringify(body) });
  let chrome;
  try {
    assert.equal((await call('PUT', '/api/widgets', { thanks: { window: 'all', intervalSec: 1, showAnonymous: true } })).status, 200);
    chrome = await openChromePage(bin, base + '/widget/thanks'); const c = chrome.cdp;
    await waitDom(c, `document.querySelector('.big')?.textContent === '<img src=x onerror=alert(1)>'`, { timeoutMs: 5000 });
    assert.equal(await evaluateChrome(c, `document.querySelectorAll('.item').length`), 1);
    assert.equal(await evaluateChrome(c, `document.querySelectorAll('img').length`), 0);
    assert.equal(await evaluateChrome(c, `!!document.querySelector('.item svg')`), true);
    await evaluateChrome(c, `window.savedThanksCard = document.querySelector('.item')`);
    assert.equal((await call('PUT', '/api/widgets', { ticker: { label: 'unchanged thanks' } })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await evaluateChrome(c, `window.savedThanksCard === document.querySelector('.item')`), true);
    await waitDom(c, `document.querySelector('.big')?.textContent === 'Second'`, { timeoutMs: 4000 });
    await waitDom(c, `document.querySelector('.big')?.textContent.includes('2')`, { timeoutMs: 4000 });
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await waitDom(c, `document.querySelector('.big')?.textContent === '<img src=x onerror=alert(1)>'`, { timeoutMs: 4000 });
    assert.equal(await evaluateChrome(c, `getComputedStyle(document.querySelector('.item')).transform`), 'none');
    assert.equal((await call('POST', '/api/followers/thank', { all: true })).status, 200);
    await waitDom(c, `document.querySelectorAll('.item').length === 0`, { timeoutMs: 4000 });
    assert.equal(await evaluateChrome(c, `getComputedStyle(document.body).backgroundColor`), 'rgba(0, 0, 0, 0)');
  } finally { if (chrome) await closeChrome(chrome); app.timers.stop(); await app.closeHttp(); }
});

test('S2: demo uses synthetic names with saved widget settings', { timeout: 90000 }, async t => {
  const bin = await findChrome(); if (!bin) return t.skip('sin Chrome local');
  const dir = await mkdtemp(path.join(tmpdir(), 'thanks-demo-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; let chrome;
  try {
    const response = await fetch(base + '/api/widgets', { method: 'PUT', body: JSON.stringify({ thanks: { title: 'Gracias de prueba', window: 'all' } }) });
    assert.equal(response.status, 200);
    chrome = await openChromePage(bin, base + '/widget/thanks?demo');
    await waitDom(chrome.cdp, `document.querySelector('.kick')?.textContent.includes('Gracias de prueba') && !!document.querySelector('.big')?.textContent`, { timeoutMs: 5000 });
  } finally { if (chrome) await closeChrome(chrome); app.timers.stop(); await app.closeHttp(); }
});
