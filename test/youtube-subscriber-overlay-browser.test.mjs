// Real overlay and synthetic CDN replies only: no account or external network requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { buildAlert } from '../src/alerts.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const CDN = 'https://yt3.ggpht.com';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#ff0036"/></svg>';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let n = 0; n < 100; n++) { if (fn()) return; await sleep(20); }
  assert.fail(message);
}

// A second CDP connection intercepts every request. Loopback serves the app; the
// synthetic CDN is fulfilled locally; all other external requests are blocked.
async function intercept(chrome, base) {
  const port = (await readFile(path.join(chrome.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
  const { targetInfo } = await chrome.cdp.send('Target.getTargetInfo');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetInfo.targetId}`);
  let seq = 0; const pending = new Map(), delayed = [], imageRequests = [], errors = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  const fulfill = (requestId, ok = true) => send('Fetch.fulfillRequest', { requestId, responseCode: ok ? 200 : 404,
    responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(ok ? svg : '').toString('base64') });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p?.reject(new Error(`CDP ${message.error.code}`)); else p?.resolve(message.result);
      return;
    }
    if (message.method !== 'Fetch.requestPaused') return;
    const { requestId, request, resourceType } = message.params, url = request.url;
    if (resourceType === 'Image') imageRequests.push(url);
    let action;
    if (url.startsWith(base + '/')) action = send('Fetch.continueRequest', { requestId });
    else if (url === CDN + '/delayed.svg') { delayed.push(requestId); return; }
    else if (url.startsWith(CDN + '/')) action = fulfill(requestId, !url.endsWith('/broken.svg'));
    else action = send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    action.catch(error => errors.push(error));
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  return { imageRequests, delayed, errors, fulfill, async close() {
    for (const id of delayed.splice(0)) await fulfill(id).catch(() => {});
    await send('Fetch.disable').catch(() => {}); ws.close();
  } };
}

async function fixture(t, bin) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytsub-overlay-'));
  let app, chrome, gate;
  t.after(async () => {
    await closeAll(() => gate && gate.close(), () => chrome && closeChrome(chrome), async () => {
      if (app) { app.followers.halt(); app.channelTotals.halt(); await app.closeHttp(); }
    }, () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await writeFile(path.join(dir, 'media', 'background.svg'), svg);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  chrome = await openChromePage(bin, 'about:blank');
  gate = await intercept(chrome, base);
  const c = chrome.cdp;
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const navigation = await c.send('Page.navigate', { url: base + '/overlay?preview&mute' });
  assert.equal(navigation.errorText, undefined);
  await waitDom(c, '!!window.antenaPreviewReady', { timeoutMs: 10000 });
  await evaluateChrome(c, 'window.antenaPreviewReady.then(() => true)', { timeoutMs: 10000 });
  const theme = async (icons, version) => {
    app.bus.send('theme', { icons, version, sound: 'none' }, ['preview']);
    await waitDom(c, `document.querySelector('#eg-theme')?.href.includes(${JSON.stringify('v=' + version)})`);
  };
  await theme({ ytsub: 'emoji:⭐', follow: 'emoji:💜' }, 'fixture-icons');
  const display = (type, layout, user, avatar) => {
    const config = structuredClone(app.store.config);
    config.alerts[type] = { ...config.alerts[type], layout, media: layout === 'card' ? '' : 'background.svg',
      sound: 'none', animIn: 'none', textDelayMs: 0 };
    const vars = { user, ...(avatar === undefined ? {} : { avatar }) };
    app.engine.deliver(buildAlert(type, vars, config, { test: true }), { target: 'preview' });
  };
  const shown = user => waitDom(c, `document.querySelector('#stage .alert-name')?.textContent === ${JSON.stringify(user)}`, { timeoutMs: 5000 });
  return { app, c, gate, base, theme, display, shown };
}

const visibleAvatar = `(() => {
  const img = document.querySelector('#stage img.ytsub-avatar');
  if (!img || !img.complete || !img.naturalWidth || img.hidden) return false;
  const r = img.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
  for (let node = img; node instanceof Element; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
})()`;

test('S2: real overlay avatar, safe URL fallback and independent icons', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome unavailable: set CHROME_PATH to run the real overlay proof');
  const f = await fixture(t, bin), { c, gate } = f;
  for (const layout of ['card', 'media', 'mixed']) await t.test(`${layout}: synthetic CDN avatar decodes without replacing icon or media`, async () => {
    const user = `Avatar ${layout}`, url = `${CDN}/${layout}.svg`;
    f.display('ytsub', layout, user, url); await f.shown(user);
    await waitDom(c, visibleAvatar, { timeoutMs: 2500 });
    const view = await evaluateChrome(c, `(() => {
      const image = document.querySelector('#stage .ytsub-avatar');
      return { src: image.src, policy: image.referrerPolicy, naturalWidth: image.naturalWidth,
        separate: !image.closest('.tile'), icon: document.querySelector('#stage .tile .emoji')?.textContent || null,
        media: document.querySelector('#stage .alert-media')?.getAttribute('src') || document.querySelector('#bg .alert-media')?.getAttribute('src') || null };
    })()`);
    assert.equal(view.src, url); assert.equal(view.policy, 'no-referrer'); assert.ok(view.naturalWidth > 0); assert.equal(view.separate, true);
    assert.equal(await evaluateChrome(c, `document.querySelector('#stage .ytsub-avatar').decode().then(() => true)`, { timeoutMs: 2500 }), true);
    if (layout !== 'media') assert.equal(view.icon, '⭐');
    if (layout !== 'card') assert.equal(view.media, '/media/background.svg');
    assert.ok(gate.imageRequests.includes(url));
  });
  await t.test('broken avatar removes only the avatar, retaining the configured icon and name', async () => {
    const url = CDN + '/broken.svg'; f.display('ytsub', 'card', 'Broken avatar', url); await f.shown('Broken avatar');
    await until(() => gate.imageRequests.includes(url), 'missing broken-image request');
    await waitDom(c, `!document.querySelector('#stage .ytsub-avatar')`, { timeoutMs: 2500 });
    assert.equal(await evaluateChrome(c, `document.querySelector('#stage .tile .emoji')?.textContent`), '⭐');
    assert.equal(await evaluateChrome(c, `document.querySelector('#stage .alert-name')?.textContent`), 'Broken avatar');
  });
  await t.test('a delayed old response and late image events cannot alter its replacement', async () => {
    f.display('ytsub', 'card', 'Old delayed', CDN + '/delayed.svg'); await f.shown('Old delayed');
    await until(() => gate.delayed.length === 1, 'missing delayed avatar request');
    await waitDom(c, `!!document.querySelector('#stage .ytsub-avatar')`, { timeoutMs: 2500 });
    await evaluateChrome(c, `window.__oldSubscriberAvatar = document.querySelector('#stage .ytsub-avatar'); true`);
    f.display('follow', 'card', 'Replacement', CDN + '/ignored.svg'); await f.shown('Replacement');
    const requestId = gate.delayed.shift(); await gate.fulfill(requestId);
    await evaluateChrome(c, `window.__oldSubscriberAvatar.dispatchEvent(new Event('load')); window.__oldSubscriberAvatar.dispatchEvent(new Event('error')); true`);
    await evaluateChrome(c, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    assert.deepEqual(await evaluateChrome(c, `({ name: document.querySelector('#stage .alert-name')?.textContent,
      icon: document.querySelector('#stage .tile .emoji')?.textContent, avatar: !!document.querySelector('#stage .ytsub-avatar') })`),
      { name: 'Replacement', icon: '💜', avatar: false });
    assert.ok(!gate.imageRequests.includes(CDN + '/ignored.svg'));
  });
  await t.test('unsafe avatar URLs never create an image or request', async () => {
    const unsafe = ['http://ggpht.com/x', 'https://user:pass@ggpht.com/x', 'https://@ggpht.com/x', 'https://ggpht.com:444/x',
      'https://ggpht.com.evil.test/x', 'https://evilggpht.com/x', 'https://googleusercontent.com.evil.test/x',
      'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'javascript:alert(1)', 'data:image/svg+xml,AA==',
      '//ggpht.com/x', '/forbidden-avatar.svg', 'https:ggpht.com/x', 'https://ggpht.com/space here'];
    const before = gate.imageRequests.length;
    for (const [i, url] of unsafe.entries()) {
      const user = `Unsafe ${i}`; f.display('ytsub', 'card', user, url); await f.shown(user);
      assert.equal(await evaluateChrome(c, `!!document.querySelector('#stage .ytsub-avatar')`), false, url);
      assert.equal(await evaluateChrome(c, `document.querySelector('#stage .tile .emoji')?.textContent`), '⭐');
      await evaluateChrome(c, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    }
    assert.deepEqual(gate.imageRequests.slice(before), []);
  });
  await t.test('icons.ytsub=none hides the icon but leaves the separate avatar visible', async () => {
    await f.theme({ ytsub: 'none', follow: 'emoji:💜' }, 'fixture-none');
    f.display('ytsub', 'card', 'No icon', CDN + '/no-icon.svg'); await f.shown('No icon');
    await waitDom(c, visibleAvatar, { timeoutMs: 2500 });
    assert.equal(await evaluateChrome(c, `!!document.querySelector('#stage .tile')`), false);
  });
  await t.test('PRESERVE: a non-ytsub alert keeps its local icon and ignores an avatar input', async () => {
    await f.theme({ ytsub: 'none', follow: 'media:background.svg' }, 'fixture-local-icon');
    const url = CDN + '/other.svg';
    f.display('follow', 'card', 'Twitch follow', url); await f.shown('Twitch follow');
    await waitDom(c, `document.querySelector('#stage .tile img.pic')?.naturalWidth > 0`);
    assert.deepEqual(await evaluateChrome(c, `({ icon: document.querySelector('#stage .tile img.pic')?.getAttribute('src'),
      avatar: !!document.querySelector('#stage .ytsub-avatar') })`), { icon: '/media/background.svg', avatar: false });
    assert.ok(!gate.imageRequests.includes(url));
  });
  assert.deepEqual(gate.errors, []);
});
