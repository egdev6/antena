// S3: hash tabs share an editing unit; leaving it (including changing entities)
// still goes through confirmLeave. Each fixture uses synthetic, temporary data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const dirty = `!!document.querySelector('main .lv-dirty.is-on')`;
const accent = `Array.from(document.querySelectorAll('main .ap-color')).find(l => l.textContent.trim() === 'Acento')?.querySelector('input.mono')`;
const pageTab = text => `Array.from(document.querySelectorAll('main .lv-pagetabs [role="tab"]')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;

async function fixture(t, hash, ready) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-manual-navigation-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  app.store.config.panel.onboardingDone = true;
  const writes = [];
  // Preview-only theme drafts are intentionally not persistence. All other PUTs
  // must stay absent, not merely leave the final config unchanged.
  app.server.prependListener('request', req => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'PUT' && pathname !== '/api/theme/draft') writes.push(pathname);
  });
  let chrome;
  t.after(async () => {
    if (chrome) await closeChrome(chrome);
    app.timers.stop();
    app.server.closeAllConnections();
    if (app.server.listening) await new Promise(r => app.server.close(r));
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  chrome = await openChromePage(bin, `http://127.0.0.1:${app.server.address().port}/${hash}`);
  const c = chrome.cdp;
  await waitDom(c, ready, { timeoutMs: 15000 });
  await evaluateChrome(c, `(() => {
    window.__nav = { confirms: [], accept: false, hashEvents: 0 };
    window.confirm = message => { window.__nav.confirms.push(message); return window.__nav.accept; };
    // Installed after useHash: the signal runs after the router has accepted or
    // cancelled the hash transition. DOM checks then await React's commit.
    window.addEventListener('hashchange', () => window.__nav.hashEvents++);
    return true;
  })()`);
  return { c, app, writes };
}

async function transition(c, action) {
  const before = await evaluateChrome(c, 'window.__nav.hashEvents');
  await evaluateChrome(c, action);
  await waitDom(c, `window.__nav.hashEvents > ${before}`);
}

async function type(c, input, text) {
  await waitDom(c, `!!(${input})`);
  await evaluateChrome(c, `(() => { const i = ${input}; i.focus(); i.select(); return true; })()`);
  await c.send('Input.insertText', { text });
  await waitDom(c, `${input}?.value === ${JSON.stringify(text)}`);
  await waitDom(c, dirty);
}

async function assertThemeDraft(c, expectedHash, section) {
  await waitDom(c, `location.hash === ${JSON.stringify(expectedHash)} && !!document.querySelector(${JSON.stringify(section)}) && ${dirty}`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 0, 'same-unit navigation must not ask to discard');
}

test('manual navigation: Apariencia tabs preserve accent, draft and history without persisting', { timeout: 90000 }, async t => {
  const ctx = await fixture(t, '#/apariencia/color', `!!(${accent})`);
  if (!ctx) return;
  const { c, writes } = ctx;
  const original = await evaluateChrome(c, `${accent}.value`);
  assert.notEqual(original, '#112233', 'fixture starts with a different accent');
  await type(c, accent, '#112233');

  await transition(c, `${pageTab('Tipografía')}.click()`);
  // This is the RED assertion: the old router calls confirmLeave for every hash.
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 0, 'Color → Tipografía must not ask to discard the theme draft');
  await assertThemeDraft(c, '#/apariencia/tipografia', '#ap-font');
  assert.deepEqual(writes, [], 'changing tabs must not persist');

  await transition(c, 'history.back()');
  await assertThemeDraft(c, '#/apariencia/color', '#ap-color');
  assert.equal(await evaluateChrome(c, `${accent}.value`), '#112233');
  await transition(c, 'history.forward()');
  await assertThemeDraft(c, '#/apariencia/tipografia', '#ap-font');
  // The base deep link resolves to the default tab in the same page.
  await transition(c, `location.hash = '#/apariencia'`);
  await assertThemeDraft(c, '#/apariencia', '#ap-color');
  assert.equal(await evaluateChrome(c, `${accent}.value`), '#112233');

  // A real exit asks; cancelling must restore both address and rendered page.
  await transition(c, `location.hash = '#/alertas'`);
  await waitDom(c, `location.hash === '#/apariencia' && !!(${accent}) && ${dirty}`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 1);
  assert.equal(await evaluateChrome(c, `${accent}.value`), '#112233');
  assert.equal((await fetch(`http://127.0.0.1:${ctx.app.server.address().port}/api/theme`).then(r => r.json())).theme.accent, original);
  assert.deepEqual(writes, [], 'cancelled exit must not persist');

  await evaluateChrome(c, 'window.__nav.accept = true');
  await transition(c, `location.hash = '#/alertas'`);
  await waitDom(c, `location.hash === '#/alertas' && document.querySelector('main h1')?.textContent === 'Alertas' && !(${dirty})`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 2);
  await transition(c, `location.hash = '#/apariencia/color'`);
  await waitDom(c, `!!(${accent}) && !(${dirty})`);
  assert.equal(await evaluateChrome(c, `${accent}.value`), original, 'confirmed exit discards the unsaved accent');
  assert.deepEqual(writes, [], 'confirmed exit discards, never saves implicitly');
});

test('manual navigation: normalized alert aliases preserve a draft but another entity asks', { timeout: 90000 }, async t => {
  const toggle = `document.querySelector('main .lv-shead input[type="checkbox"]')`;
  const ctx = await fixture(t, '#/alerta/follow', `!!(${toggle})`);
  if (!ctx) return;
  const { c, app, writes } = ctx;
  const original = await evaluateChrome(c, `${toggle}.checked`);
  const stored = structuredClone(app.store.config.alerts.follow);
  await evaluateChrome(c, `${toggle}.click()`);
  await waitDom(c, dirty);

  await transition(c, `location.hash = '#/alertas/follow'`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 0, 'legacy and canonical URLs resolve to the same alert');
  await waitDom(c, `location.hash === '#/alertas/follow' && ${dirty}`);
  assert.equal(await evaluateChrome(c, `${toggle}.checked`), !original);
  await transition(c, 'history.back()');
  await waitDom(c, `location.hash === '#/alerta/follow' && ${dirty}`);
  await transition(c, 'history.forward()');
  await waitDom(c, `location.hash === '#/alertas/follow' && ${dirty}`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 0);

  await transition(c, `location.hash = '#/alertas/sub'`);
  await waitDom(c, `location.hash === '#/alertas/follow' && ${dirty}`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 1, 'same catalogue is not the same editing entity');
  assert.equal(await evaluateChrome(c, `${toggle}.checked`), !original);
  assert.deepEqual(app.store.config.alerts.follow, stored);
  assert.deepEqual(writes, []);

  await evaluateChrome(c, 'window.__nav.accept = true');
  await transition(c, `location.hash = '#/alertas/sub'`);
  await waitDom(c, `location.hash === '#/alertas/sub' && !!(${toggle}) && !(${dirty})`);
  assert.equal(await evaluateChrome(c, 'window.__nav.confirms.length'), 2);
  assert.deepEqual(app.store.config.alerts.follow, stored);
  await transition(c, `location.hash = '#/alerta/follow'`);
  await waitDom(c, `location.hash === '#/alerta/follow' && !!(${toggle}) && !(${dirty})`);
  assert.equal(await evaluateChrome(c, `${toggle}.checked`), original);
  assert.deepEqual(writes, [], 'entity changes must not save implicitly');
});
