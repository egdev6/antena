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
  let seq = 0; const pending = new Map(), delayed = [], imageRequests = [], errors = [], actions = new Set();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject, method, requestId: params.requestId }); ws.send(JSON.stringify({ id, method, params }));
  });
  const fulfill = (requestId, ok = true) => send('Fetch.fulfillRequest', { requestId, responseCode: ok ? 200 : 404,
    responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }, { name: 'Cache-Control', value: 'no-store' }],
    body: Buffer.from(ok ? svg : '').toString('base64') });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p?.reject(Object.assign(new Error(message.error.message), {
        code: message.error.code, method: p.method, requestId: p.requestId,
      })); else p?.resolve(message.result);
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
    const tracked = action.catch(error => errors.push({ method: error.method, requestId: error.requestId,
      code: error.code, message: error.message })).finally(() => actions.delete(tracked));
    actions.add(tracked);
  });
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  // A protocol round trip brackets each batch so already-delivered pauses are accounted for.
  const drain = async () => {
    do {
      await send('Runtime.evaluate', { expression: 'void 0' });
      await Promise.all([...actions]);
      await send('Runtime.evaluate', { expression: 'void 0' });
    } while (actions.size);
  };
  let closing;
  const close = () => closing ??= (async () => {
    for (const id of delayed.splice(0)) await fulfill(id).catch(() => {});
    await drain();
    await send('Fetch.disable');
    await drain();
    ws.close();
  })();
  return { imageRequests, delayed, errors, fulfill, drain, close };
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
  // Do not replace a fixture-controlled stylesheet or image while its request is in flight.
  // The deliberately delayed avatar is the one exception tested below.
  const settle = async () => {
    await waitDom(c, `(() => {
      const theme = document.querySelector('#eg-theme');
      return !!theme?.sheet && theme.sheet.href === theme.href &&
        [...document.querySelectorAll('#stage img, #bg img')].every(img => img.src === ${JSON.stringify(CDN + '/delayed.svg')} || img.complete);
    })()`);
    await gate.drain();
  };
  const theme = async (icons, version) => {
    await settle();
    app.bus.send('theme', { icons, version, sound: 'none' }, ['preview']);
    await waitDom(c, `(() => { const link = document.querySelector('#eg-theme');
      return link?.href.includes(${JSON.stringify('v=' + version)}) && link.sheet?.href === link.href; })()`);
    await gate.drain();
  };
  await theme({ ytsub: 'emoji:⭐', follow: 'emoji:💜' }, 'fixture-icons');
  const display = async (type, layout, user, avatar) => {
    await settle();
    const config = structuredClone(app.store.config);
    config.alerts[type] = { ...config.alerts[type], layout, media: layout === 'card' ? '' : 'background.svg',
      sound: 'none', animIn: 'none', textDelayMs: 0 };
    const vars = { user, ...(avatar === undefined ? {} : { avatar }) };
    app.engine.deliver(buildAlert(type, vars, config, { test: true }), { target: 'preview' });
  };
  const shown = user => waitDom(c, `document.querySelector('#stage .alert-name')?.textContent === ${JSON.stringify(user)}`, { timeoutMs: 5000 });
  return { app, c, gate, base, theme, display, shown, settle };
}

test('CDP automatic actions drain and retain method, request ID and exact error', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ytsub-cdp-'));
  await writeFile(path.join(dir, 'DevToolsActivePort'), '1234\n');
  const original = globalThis.WebSocket;
  let socket, gate;
  class FakeSocket {
    constructor() { socket = this; this.listeners = new Map(); this.actions = []; queueMicrotask(() => this.emit('open', {})); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, event) { this.listeners.get(name)?.(event); }
    message(value) { this.emit('message', { data: JSON.stringify(value) }); }
    send(raw) {
      const request = JSON.parse(raw);
      if (['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest'].includes(request.method)) this.actions.push(request);
      else queueMicrotask(() => this.message({ id: request.id, result: {} }));
    }
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  t.after(async () => {
    for (const request of socket?.actions || []) socket.message({ id: request.id, result: {} });
    if (gate) await gate.close();
    globalThis.WebSocket = original;
    await rm(dir, { recursive: true, force: true });
  });
  gate = await intercept({ profile: dir, cdp: { send: async () => ({ targetInfo: { targetId: 'fake' } }) } }, 'http://127.0.0.1:1');
  for (const [requestId, url] of [['local', 'http://127.0.0.1:1/x'], ['cdn', CDN + '/broken.svg'], ['external', 'https://example.invalid/x']]) {
    socket.message({ method: 'Fetch.requestPaused', params: { requestId, request: { url }, resourceType: 'Image' } });
  }
  assert.deepEqual(socket.actions.map(request => request.method), ['Fetch.continueRequest', 'Fetch.fulfillRequest', 'Fetch.failRequest']);
  let drained = false;
  const draining = gate.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'drain must wait for every automatic action');
  for (const request of socket.actions) socket.message({ id: request.id, error: { code: -32602, message: 'Invalid InterceptionId' } });
  await draining;
  assert.equal(drained, true);
  assert.deepEqual(gate.errors, socket.actions.map(request => ({ method: request.method, requestId: request.params.requestId,
    code: -32602, message: 'Invalid InterceptionId' })));
});

test('S2: YouTube subscriber alerts never show or request the viewer avatar, keeping icons and media', { timeout: 60000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome unavailable: set CHROME_PATH to run the real overlay proof');
  const f = await fixture(t, bin), { c, gate } = f;
  for (const layout of ['card', 'media', 'mixed']) await t.test(`${layout}: a safe CDN avatar is ignored; icon and media stay`, async () => {
    const user = `Avatar ${layout}`, url = `${CDN}/${layout}.svg`;
    await f.display('ytsub', layout, user, url); await f.shown(user);
    await evaluateChrome(c, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    const view = await evaluateChrome(c, `({ avatar: !!document.querySelector('#stage .ytsub-avatar'),
      icon: document.querySelector('#stage .tile .emoji')?.textContent || null,
      media: document.querySelector('#stage .alert-media')?.getAttribute('src') || document.querySelector('#bg .alert-media')?.getAttribute('src') || null })`);
    assert.equal(view.avatar, false);
    if (layout !== 'media') assert.equal(view.icon, '⭐');
    if (layout !== 'card') assert.equal(view.media, '/media/background.svg');
    assert.ok(!gate.imageRequests.includes(url), 'the avatar must not be requested');
  });
  await t.test('unsafe avatar URLs never create an image or request', async () => {
    const unsafe = ['http://ggpht.com/x', 'https://user:pass@ggpht.com/x', 'https://@ggpht.com/x', 'https://ggpht.com:444/x',
      'https://ggpht.com.evil.test/x', 'https://evilggpht.com/x', 'https://googleusercontent.com.evil.test/x',
      'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'javascript:alert(1)', 'data:image/svg+xml,AA==',
      '//ggpht.com/x', '/forbidden-avatar.svg', 'https:ggpht.com/x', 'https://ggpht.com/space here'];
    const before = gate.imageRequests.length;
    for (const [i, url] of unsafe.entries()) {
      const user = `Unsafe ${i}`; await f.display('ytsub', 'card', user, url); await f.shown(user);
      assert.equal(await evaluateChrome(c, `!!document.querySelector('#stage .ytsub-avatar')`), false, url);
      assert.equal(await evaluateChrome(c, `document.querySelector('#stage .tile .emoji')?.textContent`), '⭐');
      await evaluateChrome(c, `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    }
    assert.deepEqual(gate.imageRequests.slice(before), []);
  });
  await t.test('icons.ytsub=none hides the icon and still shows no avatar', async () => {
    await f.theme({ ytsub: 'none', follow: 'emoji:💜' }, 'fixture-none');
    const url = CDN + '/no-icon.svg';
    await f.display('ytsub', 'card', 'No icon', url); await f.shown('No icon');
    assert.equal(await evaluateChrome(c, `!!document.querySelector('#stage .tile')`), false);
    assert.equal(await evaluateChrome(c, `!!document.querySelector('#stage .ytsub-avatar')`), false);
    assert.ok(!gate.imageRequests.includes(url));
  });
  await t.test('PRESERVE: a non-ytsub alert keeps its local icon and ignores an avatar input', async () => {
    await f.theme({ ytsub: 'none', follow: 'media:background.svg' }, 'fixture-local-icon');
    const url = CDN + '/other.svg';
    await f.display('follow', 'card', 'Twitch follow', url); await f.shown('Twitch follow');
    await waitDom(c, `document.querySelector('#stage .tile img.pic')?.naturalWidth > 0`);
    assert.deepEqual(await evaluateChrome(c, `({ icon: document.querySelector('#stage .tile img.pic')?.getAttribute('src'),
      avatar: !!document.querySelector('#stage .ytsub-avatar') })`), { icon: '/media/background.svg', avatar: false });
    assert.ok(!gate.imageRequests.includes(url));
  });
  await f.settle();
  await gate.close();
  assert.deepEqual(gate.errors, []);
});
