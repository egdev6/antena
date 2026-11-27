// Chat-burst scenario of the render baseline (#360). Serves an instrumented build of the app (the render
// counter is compiled in only there) to a throwaway server and drives every page with synthetic traffic:
// chat messages through engine.handleChat and viewer reads through injected readers, so no platform,
// account or program is involved. The renders come from the counter in each page (app/src/lib/render-count.ts).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInto } from '../scripts/perf.mjs';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { SURFACES } from './render-surfaces.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs in every page before its own code. It freezes the 1 s clocks (the scenario ticks them by hand, so
// wall-clock time never adds renders) and counts the stream frames the page receives, by event type.
// The counts are the delivery barrier: the burst is over for the page once its frames have all arrived.
const PAGE_HOOKS = `(() => {
  const clocks = new Map();
  const setInterval0 = window.setInterval.bind(window), clearInterval0 = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    if (ms !== 1000 || typeof fn !== 'function') return setInterval0(fn, ms, ...args);
    const id = setInterval0(() => {}, 2147483647);
    clocks.set(id, () => fn(...args));
    return id;
  };
  window.clearInterval = id => { clocks.delete(id); clearInterval0(id); };
  // One tick at a time: the next one waits until the render counts have stopped changing, so a loaded
  // machine can never batch two ticks into a single render.
  const stable = async () => {
    let last = JSON.stringify(globalThis.__antenaRenderCounts || {}), quiet = 0;
    while (quiet < 3) {
      await new Promise(r => setTimeout(r, 15));
      const now = JSON.stringify(globalThis.__antenaRenderCounts || {});
      if (now === last) quiet++; else { last = now; quiet = 0; }
    }
  };
  window.__antenaTickClocks = async n => {
    for (let i = 0; i < n; i++) { for (const tick of [...clocks.values()]) tick(); await stable(); }
    return clocks.size;
  };
  window.__antenaFrames = {};
  const Socket = window.WebSocket;
  window.WebSocket = class extends Socket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', e => {
        const type = typeof e.data === 'string' ? /^event: (\\S+)/m.exec(e.data)?.[1] : undefined;
        if (type) window.__antenaFrames[type] = (window.__antenaFrames[type] || 0) + 1;
      });
    }
  };
})()`;

const read = async cdp => JSON.parse(await evaluateChrome(cdp,
  'JSON.stringify({ renders: globalThis.__antenaRenderCounts || {}, frames: window.__antenaFrames || {} })'));
const count = (counts, key) => counts[key] || 0;

/** Waits until neither the render counts nor the received frames change for `quietMs` and `idle()` holds. */
async function settle(cdp, quietMs, idle = () => true) {
  const deadline = Date.now() + 20000;
  let last = JSON.stringify(await read(cdp)), since = Date.now();
  while (Date.now() - since < quietMs || !idle()) {
    if (Date.now() > deadline) throw new Error('the page never settled');
    await sleep(50);
    const now = JSON.stringify(await read(cdp));
    if (now !== last) { last = now; since = Date.now(); }
  }
}

async function until(condition, what) {
  for (let i = 0; i < 600; i++) {
    if (condition()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function measurePage(surface, { bin, dist, messages, viewersEvery, ticks, gapMs }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-render-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, appDist: dist });
  let chrome;
  try {
    // Only the scenario's reads reach the page. The records sit far above the synthetic counts, so a read
    // never saves config or fires an alert in the middle of the burst.
    app.viewers.stop();
    app.store.config.viewers = { records: { twitch: 100000, youtube: 100000 } };
    let reads = 0;
    app.viewers.readers = { twitch: async () => ({ live: true, viewers: 40 + (reads++ % 7) }), youtube: async () => ({ live: false, off: true }) };
    // The page loads its state over HTTP right after connecting (twice: on start and on the stream's open).
    // It is quiet once the server has nothing in flight and has been idle for a moment.
    let inflight = 0, lastHttp = Date.now();
    app.server.on('request', (req, res) => { inflight++; res.once('close', () => { inflight--; lastHttp = Date.now(); }); });
    const idle = () => inflight === 0 && Date.now() - lastHttp > 300;
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    chrome = await openChromePage(bin, 'about:blank');
    const cdp = chrome.cdp;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_HOOKS });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${app.server.address().port}${surface.url}` });
    await waitDom(cdp, surface.ready, { timeoutMs: 20000 });
    await until(() => [...app.bus.clients].some(client => client.kind === 'panel'), 'the page to open its stream');
    await settle(cdp, 600, idle);

    // Burst: chat messages with a viewers read every `viewersEvery`, paced so the stream never backs up.
    const start = await read(cdp);
    const viewerReads = Math.floor(messages / viewersEvery);
    const lastText = `burst message ${messages}`;
    for (let i = 1; i <= messages; i++) {
      const user = `viewer${i % 12}`;
      app.engine.handleChat({ id: `burst-${i}`, user, login: user, platform: i % 4 ? 'twitch' : 'youtube', text: `burst message ${i}`, at: new Date().toISOString() });
      if (i % viewersEvery === 0) await app.viewers.tick();
      await sleep(gapMs);
    }
    await waitDom(cdp, `(window.__antenaFrames.chat || 0) >= ${count(start.frames, 'chat') + messages} && (window.__antenaFrames.viewers || 0) >= ${count(start.frames, 'viewers') + viewerReads}`, { timeoutMs: 20000 });
    if (surface.shows) await waitDom(cdp, `!!document.querySelector(${JSON.stringify(surface.shows)})?.textContent.includes(${JSON.stringify(lastText)})`, { timeoutMs: 20000 });
    await settle(cdp, 300, idle);
    const burst = await read(cdp);

    // Clock: the frozen 1 s intervals ticked by hand, with no traffic.
    await evaluateChrome(cdp, `window.__antenaTickClocks(${ticks})`);
    await settle(cdp, 300, idle);
    const clock = await read(cdp);

    return {
      page: surface.page,
      events: Object.fromEntries(Object.keys(burst.frames).map(type => [type, count(burst.frames, type) - count(start.frames, type)]).filter(([, n]) => n)),
      components: Object.fromEntries(surface.components.map(label => [label, {
        burst: count(burst.renders, label) - count(start.renders, label),
        clock: count(clock.renders, label) - count(burst.renders, label),
      }])),
    };
  } finally {
    await closeAll(
      () => chrome && closeChrome(chrome),
      () => { app.viewers.stop(); app.meld.stop(); app.timers.stop(); app.server.closeAllConnections(); },
      () => new Promise(resolve => app.server.close(resolve)),
      () => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    );
  }
}

/**
 * Renders per key component for one burst of `messages` chat messages (with a viewers read every
 * `viewersEvery`) and for `ticks` manual ticks of the 1 s clocks. Every page gets a fresh server.
 */
export async function runRenderScenario({ messages = 100, viewersEvery = 10, ticks = 10, gapMs = 5, surfaces = SURFACES } = {}) {
  const bin = await findChrome();
  if (!bin) throw new Error('No se encontró Chrome: instálalo o define CHROME_PATH');
  const dist = await mkdtemp(path.join(tmpdir(), 'antena-render-dist-'));
  try {
    await buildInto(dist, { renderCount: true });
    const pages = [];
    for (const surface of surfaces) pages.push(await measurePage(surface, { bin, dist, messages, viewersEvery, ticks, gapMs }));
    return { scenario: { messages, viewerReads: Math.floor(messages / viewersEvery), clockTicks: ticks }, pages };
  } finally { await rm(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
