// #363: drive the real panel with synthetic chat and #360's test-only render counter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInto } from '../scripts/perf.mjs';
import { createApp } from '../src/server.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { runRenderScenario } from './render-scenario.mjs';
import { SURFACES } from './render-surfaces.mjs';

const PANEL = SURFACES.find(surface => surface.page === 'panel/chat');
const LABEL = 'panel/ChatRow';
const count = `(globalThis.__antenaRenderCounts?.['${LABEL}'] ?? 0)`;
const log = `document.querySelector('.chatlog')`;
const rows = `[...${log}.querySelectorAll('li')]`;
const text = n => n === 2 ? '!marca 2' : `fila ${n}`;
const at = '2026-11-28T12:34:00.000Z';
const message = n => ({ id: `memo-${n}`, at, text: text(n), platform: n % 2 ? 'youtube' : 'twitch',
  user: n === 2 ? 'Autora' : n === 3 ? 'Moderadora' : 'Espectadora', owner: n === 2, mod: n === 3 });

async function openPanel(t, backlog = 0) {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const root = await mkdtemp(path.join(tmpdir(), 'antena-chat-memo-'));
  let app, chrome;
  t.after(() => closeAll(
    () => chrome && closeChrome(chrome),
    () => app?.closeHttp(),
    () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  ));
  const appDist = path.join(root, 'dist');
  await buildInto(appDist, { renderCount: true });
  app = await createApp({ appDist, dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await app.store.patchConfig({ panel: { onboardingDone: true } });
  for (let n = 1; n <= backlog; n++) app.engine.handleChat(message(n));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  chrome = await openChromePage(bin, base + PANEL.url);
  const { cdp } = chrome;
  const wait = expr => waitDom(cdp, expr, { timeoutMs: 15000 });
  // The optional interview request follows the publication of each snapshot (on boot and
  // again on stream open). Wait for both so a fresh snapshot can't inflate the one-message count.
  await wait(`${PANEL.ready} && ${rows}.length === ${backlog} &&
    performance.getEntriesByName(location.origin + '/api/interview-control').length >= 2`);
  return { app, dom: expr => evaluateChrome(cdp, expr), wait };
}

test('panel chat: appending to 200 messages renders only the new row and keeps the reading position', { timeout: 60000 }, async t => {
  const panel = await openPanel(t, 200);
  if (!panel) return;
  const { app, dom, wait } = panel;
  const top = row => `${row}.getBoundingClientRect().top - ${log}.getBoundingClientRect().top`;
  const before = await dom(`new Promise(resolve => {
    const old = window.__chatMemoRows = ${rows};
    ${log}.scrollTop = old[70].offsetTop - old[0].offsetTop;
    const range = document.createRange();
    range.selectNodeContents(old[70].lastElementChild);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    // Let Chrome lay out the scrolled view and choose its anchor before appending.
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({ renders: ${count}, top: ${top('old[70]')} })));
  })`);
  app.engine.handleChat(message(201));
  await wait(`${log}.lastElementChild.lastElementChild.textContent === 'fila 201'`);
  const after = await dom(`(() => {
    const old = window.__chatMemoRows, current = ${rows};
    return {
      renders: ${count},
      texts: current.map(row => row.lastElementChild.textContent),
      removed: !old[0].isConnected,
      kept: current.slice(0, -1).every((row, i) => row === old[i + 1]),
      top: ${top('old[70]')}, selection: String(getSelection()),
      markers: current.slice(0, 2).map(row => [row.className, row.querySelector('b').textContent,
        row.querySelector('.pf svg').getAttribute('aria-label'), row.querySelector('time').textContent]),
      time: new Date(${JSON.stringify(at)}).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    };
  })()`);
  const rendered = after.renders - before.renders;
  t.diagnostic(`one appended message with 200 rows already visible: ${rendered} row renders`);
  assert.deepEqual(after.texts, Array.from({ length: 200 }, (_, i) => text(i + 2)), 'only the oldest row is evicted');
  assert.equal(after.removed, true);
  assert.equal(after.kept, true, 'surviving messages keep their DOM nodes when their indices shift');
  assert.equal(after.selection, 'fila 71');
  assert.ok(Math.abs(after.top - before.top) <= 4, 'the reading position stays anchored');
  assert.deepEqual(after.markers, [['cmd own', 'Autora Tú', 'Twitch', after.time], ['', 'Moderadora ◆', 'YouTube', after.time]]);
  assert.equal(rendered, 1, 'existing rows must not render for a single incoming message');
});

test('panel chat: an incoming message preserves the selected destination and draft for Enviar', { timeout: 60000 }, async t => {
  const panel = await openPanel(t);
  if (!panel) return;
  const { app, dom, wait } = panel;
  const sent = [];
  for (const platform of ['twitch', 'youtube']) app[platform].sendChat = async text => {
    sent.push({ platform, text });
    return { ok: true };
  };
  const youtube = `document.querySelector('.send-to [aria-label="Solo YouTube"]')`;
  const input = `document.querySelector('.chat-send input')`;
  await dom(`${youtube}.click()`);
  await wait(`${youtube}.getAttribute('aria-checked') === 'true'`);
  await dom(`(() => {
    const input = ${input};
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '  Hola de prueba  ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  app.engine.handleChat(message(1));
  await wait(`${log}.lastElementChild.lastElementChild.textContent === 'fila 1'`);
  assert.deepEqual(await dom(`[${youtube}.getAttribute('aria-checked'), ${input}.value]`), ['true', '  Hola de prueba  ']);
  await dom(`document.querySelector('.chat-send button.eg-btn--primary').click()`);
  await wait(`${input}.value === '' && document.querySelector('.toast').textContent === 'Enviado a YouTube'`);
  assert.deepEqual(sent, [{ platform: 'youtube', text: 'Hola de prueba' }]);
});

test('panel chat: #360 burst does not redraw the existing rows', { timeout: 60000 }, async t => {
  if (!await findChrome()) return t.skip('sin Chrome local; define CHROME_PATH para medir los renders');
  const { scenario, pages: [page] } = await runRenderScenario({
    surfaces: [{ ...PANEL, components: [...PANEL.components, LABEL] }],
  });
  const burst = page.components[LABEL].burst;
  t.diagnostic(`${page.events.chat} chat messages and ${page.events.viewers} viewer reads: ${JSON.stringify(page.components)}`);
  assert.deepEqual(page.events, { chat: scenario.messages, viewers: scenario.viewerReads });
  assert.ok(burst > 0 && burst <= scenario.messages, `expected at most ${scenario.messages} row renders, got ${burst}`);
});
