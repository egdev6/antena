// #361: real panel, synthetic messages and viewer readings, and an isolated instrumented build.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInto } from '../scripts/perf.mjs';
import { createApp } from '../src/server.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { buttonByText, closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';

const scratch = prefix => mkdtemp(path.join(tmpdir(), `antena-panel-${prefix}-`));
const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
let build, buildDir;
after(() => buildDir && cleanup(buildDir));
async function instrumentedBuild() {
  buildDir = await scratch('build');
  await buildInto(buildDir, { renderCount: true });
  return buildDir;
}

function observePage() {
  const requests = [], frames = {}, clocks = new Map();
  let boot = 0, now = null;
  const fetch0 = window.fetch.bind(window), now0 = Date.now;
  window.fetch = (input, options) => {
    const route = new URL(input, location.href).pathname;
    if ((options?.method ?? 'GET') === 'GET') {
      if (route === '/api/session' || route === '/api/sessions') requests.push(route);
      if (route === '/api/interview-control') boot++;
    }
    return fetch0(input, options);
  };
  const WebSocket0 = window.WebSocket;
  window.WebSocket = class extends WebSocket0 {
    constructor(url, ...args) {
      super(url, ...args);
      if (new URL(url).pathname !== '/api/stream') return;
      this.addEventListener('message', ({ data }) => {
        const match = /^event: (\w+)\ndata: (.+)\n\n$/.exec(data);
        if (match) (frames[match[1]] ??= []).push(JSON.parse(match[2]));
      });
    }
  };
  Date.now = () => now ?? now0();
  const interval0 = window.setInterval.bind(window), clear0 = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...args) => {
    if (ms !== 1000 && ms !== 30000) return interval0(fn, ms, ...args);
    const id = interval0(() => {}, 2147483647);
    if (ms === 1000) clocks.set(id, () => fn(...args));
    return id;
  };
  window.clearInterval = id => { clocks.delete(id); clear0(id); };
  window.panelProbe = { get boot() { return boot; }, frames, requests, tickTo: at => {
    now = at;
    for (const tick of clocks.values()) tick();
  } };
}

async function fixture(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('no local Chrome; set CHROME_PATH'); return null; }
  const appDist = await (build ||= instrumentedBuild());
  const dir = await scratch('selectors');
  let app, chrome;
  t.after(() => closeAll(
    () => chrome && closeChrome(chrome),
    async () => {
      if (!app) return;
      app.viewers.halt(); app.timers.stop();
      await app.drainAutoSession(); await app.drainChatMetrics(); await app.session.flush();
    },
    () => app?.closeHttp(),
    () => cleanup(dir),
  ));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), appDist, push: {}, log: () => {} });
  app.viewers.stop();
  app.store.config.panel = { onboardingDone: true };
  app.store.config.viewers = { enabled: true, pollSec: 60, records: { twitch: 100000, youtube: 100000 } };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, route, body) => {
    const r = await fetch(base + route, { method, ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }) });
    assert.equal(r.status, 200, `${method} ${route}`);
    return r.json();
  };
  const ev = expression => evaluateChrome(chrome.cdp, expression, { timeoutMs: 12000 });
  const wait = expression => waitDom(chrome.cdp, expression, { timeoutMs: 12000 });
  // Let the browser paint and flush passive effects after delivering an observed frame.
  const settle = () => ev(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const open = async (hash = '#/directo', ready = '!!document.querySelector(\'[data-tour-view-ready="directo"]\')') => {
    chrome = await openChromePage(bin, 'about:blank');
    await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${observePage.toString()})()` });
    await chrome.cdp.send('Page.navigate', { url: `${base}/${hash}` });
    await wait(`panelProbe.boot >= 2 && (${ready})`);
    await settle();
  };
  const event = async (type, produce) => {
    const frames = `panelProbe.frames.${type}`;
    const before = await ev(`${frames}?.length ?? 0`);
    await produce();
    await wait(`${frames}?.length > ${before}`);
    await settle();
    return ev(`${frames}.at(-1)`);
  };
  const counts = (...labels) => ev(`${JSON.stringify(labels)}.map(label => window.__antenaRenderCounts[label] || 0)`);
  return { app, api, open, ev, wait, settle, event, counts, requests: () => ev('panelProbe.requests.slice()'),
    chat: text => api('POST', '/api/chat/simulate', { user: 'Synthetic', text }) };
}

const sessionGets = ['/api/session', '/api/sessions'];
const ready = { timeout: 60000 };
const rows = `Array.from(document.querySelectorAll('.dir-chat li'), li => li.textContent.match(/Msg [0-9]+/)?.[0])`;

test('Sidebar and Directo ignore chat; ChatBox only follows the five visible messages', ready, async t => {
  const f = await fixture(t); if (!f) return;
  for (let i = 1; i <= 6; i++) await f.chat(`Msg ${i}`);
  await f.open();
  assert.deepEqual(await f.ev(rows), ['Msg 2', 'Msg 3', 'Msg 4', 'Msg 5', 'Msg 6']);
  const labels = ['panel/Sidebar', 'panel/Directo', 'panel/ChatBox'];
  const before = await f.counts(...labels), requests = await f.requests();
  await f.event('chat', () => f.chat('Msg 7'));
  assert.deepEqual(await f.ev(rows), ['Msg 3', 'Msg 4', 'Msg 5', 'Msg 6', 'Msg 7']);
  const after = await f.counts(...labels);
  const [oldest] = await f.api('GET', '/api/chat');
  await f.event('chatDelete', () => f.app.chat.emit('delete', { id: oldest.id }));
  assert.ok(!(await f.api('GET', '/api/chat')).some(m => m.id === oldest.id));
  assert.deepEqual(await f.ev(rows), ['Msg 3', 'Msg 4', 'Msg 5', 'Msg 6', 'Msg 7']);
  const afterOldDelete = await f.counts(...labels);
  const latest = (await f.api('GET', '/api/chat')).at(-1);
  await f.event('chatDelete', () => f.app.chat.emit('delete', { id: latest.id }));
  assert.deepEqual(await f.ev(rows), ['Msg 2', 'Msg 3', 'Msg 4', 'Msg 5', 'Msg 6']);
  assert.deepEqual(await f.requests(), requests, 'chat does not fetch either session endpoint');
  assert.deepEqual(after, [before[0], before[1], before[2] + 1]);
  assert.deepEqual(afterOldDelete, after, 'deleting outside the visible window must not render ChatBox');
  assert.deepEqual(await f.counts(...labels), [after[0], after[1], after[2] + 1]);
});

test('Directo clocks update elapsed, idle age and sample expiry without ticking the view', ready, async t => {
  const f = await fixture(t); if (!f) return;
  const start = Date.parse((await f.api('GET', '/api/session')).startedAt);
  await f.open();
  const tick = async at => { await f.ev(`panelProbe.tickTo(${at})`); await f.settle(); };
  const clock = `document.querySelector('[data-tour="directo-head"] .crumb').textContent`;
  const idle = `document.querySelector('.dir-health-idle').textContent`;
  await tick(start + 120000);
  assert.match(await f.ev(clock), / · 2:00$/);
  assert.equal(await f.ev(idle), 'Sesión abierta sin emisión · empezó hace 2:00Cerrarla');
  const labels = ['panel/Sidebar', 'panel/Directo', 'panel/ChatBox'];
  const before = await f.counts(...labels), requests = await f.requests();
  await tick(start + 121000);
  assert.match(await f.ev(clock), / · 2:01$/);
  assert.equal(await f.ev(idle), 'Sesión abierta sin emisión · empezó hace 2:01Cerrarla');
  const afterClock = await f.counts(...labels);
  f.app.viewers.readers = { twitch: async () => ({ live: true, viewers: 42 }), youtube: async () => ({ live: false, off: true }) };
  const snapshot = await f.event('viewers', () => f.app.viewers.tick());
  const sampledAt = Date.parse(snapshot.platforms.twitch.updatedAt);
  const pulse = `document.querySelector('[data-platform-pulse="twitch"]')`;
  await tick(sampledAt + 1000);
  assert.equal(await f.ev(`${pulse}.querySelector('.dir-number.now b')?.textContent`), '42');
  await tick(sampledAt + 60000);
  assert.match(await f.ev(`${pulse}.textContent`), /Sin datos de espectadores ni de chat/);
  assert.deepEqual(await f.requests(), requests);
  assert.deepEqual(afterClock, before, 'only clock consumers render on a tick');
  assert.deepEqual(await f.counts('panel/Sidebar'), [before[0]], 'sidebar ignores viewer reads');
});

test('Directo refreshes for a new timeline item, not for an identical frame or goal adjustment', ready, async t => {
  const f = await fixture(t); if (!f) return;
  await f.api('POST', '/api/goals', { id: 'synth-goal', title: 'Synthetic goal', platform: 'twitch', metric: 'events', target: 10 });
  await f.open();
  const timeline = await f.api('GET', '/api/timeline');
  const before = await f.requests();
  await f.event('timeline', () => f.app.bus.send('timeline', timeline, ['panel']));
  const duplicate = await f.requests();
  const { marker } = await f.api('POST', '/api/markers', { label: 'Synthetic marker' });
  await f.wait(`document.querySelector('.dir-timeline').textContent.includes('Synthetic marker')`);
  await f.settle();
  const added = await f.requests();
  const goal = await f.event('timeline', () => f.api('POST', '/api/goals/synth-goal/set', { value: 3 }));
  await f.wait(`Array.from(document.querySelectorAll('.goals .goal')).some(card =>
    card.querySelector('.goal-title').textContent === 'Synthetic goal' && card.querySelector('.goal-top b').textContent === '3/10')`);
  await f.settle();
  assert.equal(goal.items.at(-1).id, marker.id);
  assert.deepEqual(duplicate, before, 'identical timeline frames do not fetch either endpoint');
  assert.deepEqual(added, [...duplicate, ...sessionGets], 'a new item refreshes both endpoints once');
  assert.deepEqual(await f.requests(), added, 'goal changes are rendered from widgets, not session downloads');
});

test('timeline HTTP and stream preserve their fields and report external close and restart', ready, async t => {
  const f = await fixture(t); if (!f) return;
  const live = (await f.api('GET', '/api/session'));
  const openTimeline = { items: [], pending: 0, startedAt: live.startedAt, title: live.title };
  assert.deepEqual(await f.api('GET', '/api/timeline'), openTimeline);
  await f.open();
  const before = await f.requests();
  assert.equal(await f.ev(`!!${buttonByText('Terminar directo')}`), true);
  let ended;
  const closedFrame = await f.event('timeline', async () => { ended = (await f.api('POST', '/api/session/end', { id: live.id })).session; });
  assert.equal(ended.id, live.id);
  assert.ok(ended.endedAt);
  const closedTimeline = { ...openTimeline, endedAt: ended.endedAt };
  assert.deepEqual(await f.api('GET', '/api/timeline'), closedTimeline);
  assert.deepEqual(closedFrame, closedTimeline);
  await f.wait(`!!${buttonByText('Empezar directo')}`);
  assert.equal(await f.ev(`!!document.querySelector('.dir-health-idle')`), false);
  assert.deepEqual(await f.requests(), [...before, ...sessionGets]);

  let next;
  const resumedFrame = await f.event('timeline', async () => { next = (await f.api('POST', '/api/session/new', { title: 'Synthetic restart' })).session; });
  const resumedTimeline = { ...openTimeline, startedAt: next.startedAt, title: next.title };
  assert.deepEqual(await f.api('GET', '/api/timeline'), resumedTimeline);
  assert.deepEqual(resumedFrame, resumedTimeline);
  await f.wait(`!!${buttonByText('Terminar directo')} && document.querySelector('.title-input').value === 'Synthetic restart'`);
  assert.deepEqual(await f.requests(), [...before, ...sessionGets, ...sessionGets]);
});

test('Alertas, Editor and Registro skip unrelated chat while alert edits still reach the UI', ready, async t => {
  const f = await fixture(t); if (!f) return;
  const archived = (await f.api('GET', '/api/session')).id;
  await f.api('POST', '/api/session/new', { title: 'New synthetic session' });
  await f.open('#/alertas/follow', `!!document.querySelector('.editor')`);
  const alertLabels = ['panel/Alertas', 'panel/Editor'];
  const alerts = await f.counts(...alertLabels);
  await f.event('chat', () => f.chat('While editing'));
  const afterChat = await f.counts(...alertLabels);
  await f.api('PUT', '/api/alerts/follow', { layout: 'media', media: 'synthetic-missing.webm' });
  await f.wait(`!!document.querySelector('a[href="#/alertas"] [aria-label="1 aviso"]')
    && !!document.querySelector('.editor [data-field="media"]')
    && document.querySelector('.lv-groups').textContent.includes('Falta synthetic-missing.webm')`);
  const afterEdit = await f.counts(...alertLabels);
  for (const [route, labels, ready] of [
    [`#/directos/${archived}/resumen`, ['panel/Directos', 'panel/DirectoSlide'], `document.querySelector('.lv-slide h2')?.textContent === 'Sin título'`],
    ['#/archivos', ['panel/Archivos'], `document.querySelector('main h1')?.textContent === 'Archivos'`],
  ]) {
    await f.ev(`location.hash = ${JSON.stringify(route)}`);
    await f.wait(ready);
    await f.settle();
    const before = await f.counts(...labels);
    await f.event('chat', () => f.chat('While reading the register'));
    assert.deepEqual(await f.counts(...labels), before);
    assert.ok(before.every(n => n > 0), 'the register components actually mounted');
  }
  assert.deepEqual(afterChat, alerts);
  assert.ok(afterEdit.every((n, i) => n > alerts[i]), 'the alert list and editor render changed alert data');
});
