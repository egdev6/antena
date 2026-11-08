// Real compiled panel + createApp. Transport gates retain actual HTTP responses, never SSE.
// Run this file sequentially: each test owns one Chrome and releases every paused request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const q = JSON.stringify;
const options = { timeout: 90000, concurrency: false };
const frame = `document.querySelector('.lv-still iframe[src*="still=follow&"]')`;
const title = `${frame}?.contentDocument?.querySelector('.alert.on .alert-title .t')?.textContent`;
const rows = `document.querySelectorAll('#tp-vars tbody tr')`;
const tab = name => `[...document.querySelectorAll('.lv-stabs [role="tab"]')].find(b => b.textContent.trim().startsWith(${q(name)}))`;
const rendered = c => evaluateChrome(c, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))', { timeoutMs: 3000 });

async function within(promise, label, ms = 6000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Observe real boot/SSE delivery. Only the response-first experiment queues config
// listeners; release invokes the original listeners with the original MessageEvent.
const observer = `(() => {
  if (window !== top) return;
  const state = window.__previewRace = { loads: 0, hold: false, held: [] };
  state.release = () => { state.hold = false; state.held.splice(0).forEach(fn => fn()); };
  const fetch0 = window.fetch;
  window.fetch = async (...args) => {
    const response = await fetch0(...args);
    if (new URL(String(args[0]), location.href).pathname === '/api/prompter') {
      const json = response.json.bind(response);
      response.json = async () => { const value = await json(); state.loads++; return value; };
    }
    return response;
  };
  const ES = window.EventSource;
  window.EventSource = class extends ES {
    addEventListener(name, listener, options) {
      if (name !== 'config') return super.addEventListener(name, listener, options);
      return super.addEventListener(name, event => {
        const deliver = () => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
        if (state.hold) state.held.push(deliver); else deliver();
      }, options);
    }
  };
})()`;

// Intent-only probe: synthetic, deliberately undecodable upload; no codecs, devices,
// autoplay policy or user media required. React/overlay still create all DOM themselves.
// STILL captures this stub as realPlay: the counter advances only when its allow gate
// actually forwards a play, not when the renderer attempts a frozen first frame.
const mediaProbe = `(() => {
  // These are test-owned subframes. Chrome can reuse their initial about:blank
  // context for /overlay without rerunning this hook: install before the final URL
  // is known, and validate that URL in the post-navigation precondition instead.
  if (window === top) return;
  const p = window.__mediaIntent = { plays: 0, messages: 0, settled: false };
  HTMLMediaElement.prototype.play = function () { if (this instanceof HTMLVideoElement) p.plays++; return Promise.resolve(); };
  addEventListener('message', e => {
    if (e.source === parent && e.origin === location.origin && e.data?.still === 'play') p.messages++;
  });
  // Window capture survives replacement of the initial about:blank Document.
  window.addEventListener('error', e => {
    if (e.target instanceof HTMLVideoElement) requestAnimationFrame(() => requestAnimationFrame(() => { p.settled = true; }));
  }, true);
})()`;

// Existing helper intentionally exposes commands only. Attach a second CDP socket to
// the SAME page for Fetch events; do not replace its command handler or start Chrome.
async function responseGate(chrome, urlPattern, method, cleanups) {
  const port = (await readFile(path.join(chrome.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim();
  const { targetInfo } = await within(chrome.cdp.send('Target.getTargetInfo'), 'CDP target lookup did not complete');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetInfo.targetId}`);
  let seq = 0, waiter, closing = false;
  const pending = new Map(), paused = new Set(), queue = [];
  const send = async (name, params = {}) => {
    const id = ++seq;
    try {
      return await within(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method: name, params }));
      }), `CDP ${name} did not complete`);
    } finally { pending.delete(id); }
  };
  const release = async requestId => {
    if (!paused.has(requestId)) return;
    await send('Fetch.continueRequest', { requestId });
    paused.delete(requestId);
  };
  const gate = {
    async next() {
      if (queue.length) return queue.shift();
      assert.equal(waiter, undefined, 'one gate consumer at a time');
      try { return await within(new Promise(resolve => { waiter = resolve; }), `missing ${method} response pause: ${urlPattern}`); }
      finally { waiter = undefined; }
    },
    release: event => release(event.requestId),
    async body(event) {
      const body = await send('Fetch.getResponseBody', { requestId: event.requestId });
      return JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
    },
    async close() {
      if (closing) return;
      closing = true;
      try {
        await Promise.all([...paused].map(release));
        if (ws.readyState === WebSocket.OPEN) await send('Fetch.disable');
      } finally { ws.close(); }
      assert.ifError(gate.error);
    },
  };
  cleanups.push(() => gate.close());
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const p = pending.get(message.id);
      if (message.error) p?.reject(new Error(`CDP error ${message.error.code}`)); else p?.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') {
      const event = message.params;
      paused.add(event.requestId);
      if (closing || event.request.method !== method) {
        // These patterns never include /api/stream. Do not hold unrelated methods.
        release(event.requestId).catch(error => { gate.error = error; });
      } else if (waiter) { const resolve = waiter; waiter = undefined; resolve(event); }
      else queue.push(event);
    }
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('Fetch CDP socket closed'));
  });
  await within(new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  }), 'Fetch CDP socket did not open');
  await send('Fetch.enable', { patterns: [{ urlPattern, requestStage: 'Response' }] });
  return gate;
}

async function withPanel(run) {
  // Missing prerequisites are failures, not a skipped/green regression harness.
  await stat(new URL('../app/dist/index.html', import.meta.url));
  const bin = await findChrome();
  assert.ok(bin, 'Chrome required; set CHROME_PATH');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-preview-races-'));
  let app, chrome, primaryError;
  const cleanups = [];
  try {
    app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
    app.store.config.panel = { onboardingDone: true };
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const api = async (method, endpoint, body) => {
      const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
      assert.equal(response.ok, true, `${method} ${endpoint}: ${response.status}`);
      return response.json();
    };
    chrome = await openChromePage(bin, 'about:blank');
    const c = { ...chrome.cdp, send: (method, params) => within(chrome.cdp.send(method, params), `CDP ${method} did not complete`) };
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    // Independent registrations isolate observer exceptions from the media probe.
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: observer + ';' });
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: mediaProbe + ';' });
    const navigate = async route => {
      await c.send('Page.navigate', { url: base + '/' + route });
      await waitDom(c, 'window.__previewRace?.loads >= 2 && !!document.querySelector(".lv-card")', { timeoutMs: 20000 });
      await rendered(c);
    };
    await run({ c, chrome, api, base, navigate, gate: (url, method) => responseGate(chrome, url, method, cleanups) });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // Finish all cleanup even if a paused response or CDP command cannot be resumed.
    const failures = [];
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
    if (chrome) {
      try { await closeChrome(chrome); } catch (error) { failures.push(error); }
    }
    if (app) {
      for (const name of ['timers', 'teleprompter', 'viewers', 'meld', 'chat']) {
        try { app[name].stop(); } catch (error) { failures.push(error); }
      }
      app.server.closeAllConnections();
      try { await within(app.closeHttp(), 'app HTTP cleanup did not complete'); } catch (error) { failures.push(error); }
    }
    try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failures.push(error); }
    if (failures.length) {
      // Keep the semantic assertion/transport error at the top of the test report.
      if (primaryError) primaryError.cleanupErrors = failures;
      else throw new AggregateError(failures, 'preview race cleanup failed');
    }
  }
}

async function click(c, expression) {
  await waitDom(c, `!!(${expression}) && !(${expression}).disabled`);
  assert.equal(await evaluateChrome(c, `(${expression}).click(); true`), true);
  await rendered(c);
}

async function variationIds(c) {
  return evaluateChrome(c, `[...document.querySelectorAll('#tp-vars tbody .lv-name a')].map(a => a.getAttribute('href').split('/').pop())`);
}

test('preview races: variation creation is unique for SSE-first and response-first delivery', options, () => withPanel(async ({ c, api, navigate, gate }) => {
  await navigate('#/alertas');
  // Separate types give each order a clean, empty variation list in the same Chrome.
  for (const [type, sseFirst] of [['follow', true], ['raid', false]]) {
    await evaluateChrome(c, `location.hash = ${q('#/alertas/' + type)}; true`);
    await click(c, tab('Variaciones'));
    assert.deepEqual(await variationIds(c), []);
    await evaluateChrome(c, `window.__previewRace.hold = ${!sseFirst}; true`);
    const held = await gate('*/api/alerts/*/variations', 'POST');
    await click(c, buttonByText('Nueva variación'));
    const response = await held.next();
    assert.equal(response.responseStatusCode, 200);
    const { variation } = await held.body(response);
    const latestName = sseFirst ? 'Variation updated after POST by SSE' : variation.name;
    if (sseFirst) {
      // A rendered row proves the actual SSE snapshot has been applied before await POST resolves.
      await waitDom(c, `${rows}.length === 1`);
      assert.deepEqual(await variationIds(c), [variation.id]);
      await api('PUT', `/api/alerts/${type}/variations/${variation.id}`, { name: latestName });
      await waitDom(c, `document.querySelector('#tp-vars tbody .lv-name a')?.textContent === ${q(latestName)}`);
    }
    await held.release(response);
    await waitDom(c, `!!document.querySelector('input[aria-label="Nombre de la variación"]')`);
    assert.equal(await evaluateChrome(c, `document.querySelector('input[aria-label="Nombre de la variación"]').value`), latestName,
      'held POST must not replace a more recent SSE variation');
    if (!sseFirst) {
      await waitDom(c, 'window.__previewRace.held.length > 0');
      await evaluateChrome(c, 'window.__previewRace.release(); true');
    }
    await click(c, `document.querySelector('.lv-shead a[aria-label="Volver"]')`);
    await click(c, tab('Variaciones'));
    const ids = await variationIds(c);
    const serverIds = (await api('GET', '/api/config')).alerts[type].variations.map(v => v.id);
    assert.deepEqual(serverIds, [variation.id], 'server created exactly one variation');
    assert.equal(new Set(ids).size, ids.length, `${sseFirst ? 'SSE' : 'POST'}-first must not duplicate IDs`);
    assert.deepEqual(ids, serverIds, 'one visible row per saved variation');
    await held.close();
  }
}));

test('preview races: saving UI title B refreshes a thumbnail that already fetched saved A', options, () => withPanel(async ({ c, api, navigate, gate }) => {
  const a = 'Preview saved title A', b = 'Preview UI title B';
  await api('PUT', '/api/alerts/follow', { title: a, layout: 'card' });
  await navigate('#/alertas');
  await evaluateChrome(c, `${frame}.scrollIntoView(); true`);
  await waitDom(c, `${title} === ${q(a)}`);
  await evaluateChrome(c, 'location.hash = "#/alertas/follow"; true');
  await click(c, tab('Mensaje'));
  const src = await evaluateChrome(c, `${frame}.src`);
  const held = await gate('*/api/alerts/follow/sample', 'GET');
  await evaluateChrome(c, `(() => {
    const input = document.querySelector('[data-field="title"] input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${q(b)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitDom(c, `document.querySelector('[data-field="title"] input')?.value === ${q(b)} && document.querySelector('.lv-sfoot .lv-dirty')?.classList.contains('is-on')`);
  await rendered(c);
  if (await evaluateChrome(c, `${frame}.src !== ${q(src)}`)) {
    // Buggy optimistic stamp: force its sample of A to finish BEFORE pressing Save.
    const response = await held.next();
    assert.equal((await held.body(response)).alert.title, a);
    await held.release(response);
    await waitDom(c, `${title} === ${q(a)}`);
  } // A fixed saved-only stamp need not navigate at all while B is merely a draft.
  await held.close();
  assert.equal((await api('GET', '/api/config')).alerts.follow.title, a, 'B is still an unsaved UI edit');
  await click(c, `[...document.querySelectorAll('.lv-sfoot button')].find(b => b.textContent.trim() === 'Guardar')`);
  await waitDom(c, `document.querySelector('.lv-sfoot .lv-dirty')?.textContent === 'Todo guardado' && document.querySelector('.toast.on:not(.err)')?.textContent.includes('Guardado')`);
  assert.equal((await api('GET', '/api/config')).alerts.follow.title, b);
  // src/hash alone is not evidence: inspect the actual rendered iframe content.
  await waitDom(c, `${title} === ${q(b)}`, { timeoutMs: 6000 });
  assert.equal(await evaluateChrome(c, title), b, 'thumbnail shows the acknowledged saved title B');
}));

test('preview races: hover play intent survives slow sample and iframe reload without re-entry', options, () => withPanel(async ({ c, api, base, navigate, gate }) => {
  const upload = await fetch(base + '/api/media/upload?name=preview-intent.webm', {
    method: 'POST', body: Buffer.alloc(8, 3), signal: AbortSignal.timeout(6000),
  });
  assert.equal(upload.ok, true);
  const { name } = await upload.json();
  await api('PUT', '/api/alerts/follow', { layout: 'media', media: name, sound: 'none' });
  const held = await gate('*/api/alerts/follow/sample', 'GET');
  await navigate('#/alertas');
  // Exercise the promised mouse hover, not keyboard focus or synthetic DOM events.
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1, buttons: 0 });
  await evaluateChrome(c, `${frame}.scrollIntoView({ block: 'center' }); true`);
  await rendered(c);
  const first = await held.next();
  assert.equal(first.responseStatusCode, 200, 'sample response is held before creating video');
  assert.equal((await held.body(first)).alert.look.mediaKind, 'video', 'real sample selects a video renderer');
  const probe = `${frame}?.contentWindow?.__mediaIntent`;
  const card = `document.querySelector('a.lv-hit[href="#/alertas/follow"]')?.closest('.lv-card')`;
  const before = await evaluateChrome(c, `({ href: ${frame}?.contentWindow?.location.href, ready: !!${probe}, video: !!${frame}?.contentDocument?.querySelector('video'), hovered: ${card}?.matches(':hover') })`);
  const { href, ...beforeState } = before;
  const url = new URL(href);
  assert.deepEqual([url.origin, url.pathname, url.searchParams.get('still')], [base, '/overlay', 'follow'], `HARNESS current iframe URL: ${JSON.stringify(before)}`);
  assert.deepEqual(beforeState, { ready: true, video: false, hovered: false }, `HARNESS probe ready before hover: ${JSON.stringify(before)}`);
  const point = await evaluateChrome(c, `(() => {
    const card = ${card};
    const r = card.querySelector('.lv-ctitle').getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, visible: x > 0 && x < innerWidth && y > 0 && y < innerHeight,
      hit: document.elementFromPoint(x, y)?.closest('.lv-card') === card };
  })()`);
  assert.equal(point.visible && point.hit, true, 'real visible card coordinates hit the intended card');
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
  await waitDom(c, `${card}?.matches(':hover') && ${card}?.querySelector('.badge')?.textContent.includes('vista previa')`);
  await waitDom(c, `${probe}?.messages > 0`, { timeoutMs: 6000 });
  assert.equal(await evaluateChrome(c, `!!${frame}.contentDocument.querySelector('video')`), false, 'real play message arrives before video creation');
  for (const [phase, response] of [['slow sample', first], ['reload', null]]) {
    let paused = response;
    if (!paused) {
      await api('PUT', '/api/alerts/follow', { title: 'Reload while still hovered' });
      paused = await held.next();
      const reload = await evaluateChrome(c, `({ href: ${frame}?.contentWindow?.location.href, ready: !!${probe}, video: !!${frame}?.contentDocument?.querySelector('video'), hovered: ${card}?.matches(':hover'),
        hit: document.elementFromPoint(${point.x}, ${point.y})?.closest('.lv-card') === ${card} })`);
      const { href: reloadHref, ...reloadState } = reload;
      const reloadUrl = new URL(reloadHref);
      assert.deepEqual([reloadUrl.origin, reloadUrl.pathname, reloadUrl.searchParams.get('still')], [base, '/overlay', 'follow'], `HARNESS reloaded iframe URL: ${JSON.stringify(reload)}`);
      assert.deepEqual(reloadState, { ready: true, video: false, hovered: true, hit: true }, `HARNESS reload retains hover and probe: ${JSON.stringify(reload)}`);
    }
    await held.release(paused);
    await waitDom(c, `${probe}?.settled && !!${frame}?.contentDocument?.querySelector('video')`);
    await rendered(c);
    const intent = await evaluateChrome(c, `({ plays: ${probe}.plays, muted: ${frame}.contentDocument.querySelector('video').muted })`);
    assert.ok(intent.plays > 0, `${phase}: pending hover must reach play() after video creation (intent only, not real playback)`);
    assert.equal(intent.muted, true, 'thumbnail remains silent');
  }
}));
