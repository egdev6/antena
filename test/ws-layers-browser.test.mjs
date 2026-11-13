// S3: eight real widget documents in one Chrome connection pool, and native SSE fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { WsResponse } from '../src/ws-stream.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function withApp(t, run) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-ws-layers-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  let chrome;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    chrome = await openChromePage(bin, 'about:blank');
    await run({ app, base, c: chrome.cdp });
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => {
      for (const name of ['timers', 'teleprompter', 'viewers', 'meld', 'chat']) app[name].stop();
      app.server.closeAllConnections();
    }, () => app.closeHttp());
  }
}
const viewers = n => ({ twitch: { live: true, current: n, peak: n, record: n }, youtube: { live: false, current: 0, peak: 0, record: 0 } });

test('S3: eight widgets receive the same broadcast over eight WebSocket clients', { timeout: 60000 }, t => withApp(t, async ({ app, base, c }) => {
  await c.send('Page.navigate', { url: base + '/probe.html' });
  await waitDom(c, `document.querySelector('#list')?.textContent.includes('conectado')`);
  await evaluateChrome(c, `(() => {
    for (let i = 0; i < 8; i++) {
      const frame = document.createElement('iframe');
      frame.src = '/widget/viewers?platforms=twitch&total=0';
      document.body.append(frame);
    }
    return true;
  })()`);
  const frames = `[...document.querySelectorAll('iframe')]`;
  await waitDom(c, `${frames}.length === 8 && ${frames}.every(f => f.contentDocument?.querySelector('.item-twitch .big'))`, { timeoutMs: 7000 });
  const clients = [...app.bus.clients].filter(client => client.kind === 'widget');
  assert.equal(clients.length, 8);
  assert.ok(clients.every(client => client.res instanceof WsResponse), 'all eight server clients are WebSockets');
  app.bus.send('viewers', viewers(987), ['widget']);
  await waitDom(c, `${frames}.every(f => f.contentDocument?.querySelector('.item-twitch .big')?.textContent === '987')`, { timeoutMs: 7000 });
  assert.deepEqual(await evaluateChrome(c, `${frames}.map(f => f.contentDocument.querySelector('.item-twitch .big').textContent)`), Array(8).fill('987'));
}));

test('S4: the probe reports WebSocket or native SSE and closes its connection', { timeout: 60000 }, t => withApp(t, async ({ base, c }) => {
  await c.send('Page.navigate', { url: base + '/probe.html' });
  await waitDom(c, `document.querySelector('#list')?.textContent.includes('conectado (WebSocket)')`);
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.WebSocket = class { constructor() { throw new Error('disabled'); } };` });
  await c.send('Page.navigate', { url: base + '/probe.html?fallback' });
  await waitDom(c, `document.querySelector('#list')?.textContent.includes('conectado (SSE)')`);
}));

test('S4: same-origin WebSocket works with the React pages connect-src self policy', { timeout: 60000 }, t => withApp(t, async ({ app, base, c }) => {
  await c.send('Page.navigate', { url: base + '/probe.html' });
  await waitDom(c, `document.querySelector('#list')?.textContent.includes('conectado')`);
  await evaluateChrome(c, `(async () => {
    const policy = document.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "connect-src 'self'"; document.head.append(policy);
    const { AntenaStream } = await import('/stream-client.js');
    window.__cspStream = new AntenaStream('/api/stream?client=panel');
    window.__cspStream.onopen = () => { window.__cspTransport = window.__cspStream.transport; };
    return true;
  })()`);
  await waitDom(c, `!!window.__cspTransport`);
  assert.equal(await evaluateChrome(c, `window.__cspTransport`), 'websocket');
  assert.ok([...app.bus.clients].some(client => client.kind === 'panel' && client.res instanceof WsResponse));
}));

test('S4: alert overlay still sends its shown ACK; still thumbnails never connect', { timeout: 60000 }, t => withApp(t, async ({ app, base, c }) => {
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__acks = [];
    const fetch0 = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch0(...args);
      if (String(args[0]) === '/api/overlay/shown') window.__acks.push({ id: JSON.parse(args[1].body).id, status: response.status });
      return response;
    };
  })()` });
  await c.send('Page.navigate', { url: base + '/overlay?mute' });
  await waitDom(c, `document.querySelector('#eg-theme')?.href.includes('?v=')`);
  assert.ok([...app.bus.clients].some(client => client.kind === 'overlay' && client.res instanceof WsResponse));
  const dispatched = [];
  app.engine.runActions = async actions => { dispatched.push(actions); };
  app.engine.send({ id: 'ws-ack', type: 'follow', title: 'Follow', text: 'Alice', sub: '', icon: 'heart',
    vars: {}, durationMs: 2000, actions: [{ kind: 'say', text: 'hello' }] });
  await waitDom(c, `document.querySelector('.alert-name')?.textContent === 'Alice' && window.__acks.length === 1`);
  assert.deepEqual(await evaluateChrome(c, 'window.__acks'), [{ id: 'ws-ack', status: 200 }]);
  assert.equal(dispatched.length, 1);
  const before = new Set(app.bus.clients);
  await c.send('Page.navigate', { url: base + '/overlay?still=follow' });
  await waitDom(c, `document.body.classList.contains('still') && !!document.querySelector('.alert-card')`);
  // The previous page's socket closes asynchronously on the server; wait for it, then check
  // that the still thumbnail never opened a connection of its own.
  for (let i = 0; i < 100 && [...app.bus.clients].some(client => before.has(client)); i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual([...app.bus.clients].filter(client => !before.has(client)), [], 'the still thumbnail opens no stream');
  assert.equal(app.bus.overlayCount(), 0);
}));

test('S4: overlay preview draft snapshots and updates stay isolated from saved layers', { timeout: 60000 }, t => withApp(t, async ({ app, base, c }) => {
  const put = async (url, data) => {
    const response = await fetch(base + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.status, 200);
  };
  await put('/api/theme', { position: 'top' });
  await put('/api/theme/draft', { position: 'bottom' });
  await c.send('Page.navigate', { url: base + '/probe.html' });
  await waitDom(c, `document.querySelector('#list')?.textContent.includes('conectado')`);
  await evaluateChrome(c, `(() => {
    for (const query of ['preview&mute', 'preview&mute&themeDraft=1']) {
      const frame = document.createElement('iframe'); frame.src = '/overlay?' + query; document.body.append(frame);
    }
    return true;
  })()`);
  const stage = i => `document.querySelectorAll('iframe')[${i}]?.contentDocument?.querySelector('#stage')`;
  await waitDom(c, `${stage(0)}?.classList.contains('top') && ${stage(1)}?.classList.contains('bottom')`);
  assert.equal([...app.bus.clients].filter(client => client.kind === 'preview' && client.res instanceof WsResponse).length, 2);
  await put('/api/theme/draft', { position: 'center' });
  await waitDom(c, `${stage(1)}?.classList.contains('center')`);
  assert.equal(await evaluateChrome(c, `${stage(0)}.classList.contains('top')`), true);
}));

test('S4: a widget with unavailable WebSocket receives snapshots and broadcasts over native SSE', { timeout: 60000 }, t => withApp(t, async ({ app, base, c }) => {
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.WebSocket = class { constructor() { throw new Error('disabled'); } };` });
  await c.send('Page.navigate', { url: base + '/widget/viewers?platforms=twitch&total=0' });
  await waitDom(c, `!!document.querySelector('.item-twitch .big')`, { timeoutMs: 7000 });
  const clients = [...app.bus.clients].filter(client => client.kind === 'widget');
  assert.equal(clients.length, 1);
  assert.equal(clients[0].res instanceof WsResponse, false);
  app.bus.send('viewers', viewers(654), ['widget']);
  await waitDom(c, `document.querySelector('.item-twitch .big')?.textContent === '654'`);
  assert.equal(await evaluateChrome(c, `document.querySelector('.item-twitch .big').textContent`), '654');
}));

test('Chrome pagehide really closes the socket before bfcache resume', { timeout: 60000 }, t => withApp(t, async ({ app, base, c }) => {
  await c.send('Page.navigate', { url: base + '/widget/viewers?platforms=twitch&total=0' });
  await waitDom(c, `!!document.querySelector('.item-twitch .big')`);
  const widgets = () => [...app.bus.clients].filter(x => x.kind === 'widget');
  assert.equal(widgets().length, 1);
  const old = widgets()[0];
  await evaluateChrome(c, `dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); true`);
  for (let i = 0; i < 100 && app.bus.clients.has(old); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(app.bus.clients.has(old), false, 'pagehide must close the native WebSocket');
  await evaluateChrome(c, `dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); true`);
  for (let i = 0; i < 100 && widgets().length !== 1; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(widgets().length, 1);
}));
