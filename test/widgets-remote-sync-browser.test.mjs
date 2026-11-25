// #351: a widget change made outside the panel (MCP, another window) reaches an open form,
// a later save does not write the stale value back, and unsaved local edits survive it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const CSS = `[...document.querySelectorAll('main label')].find(l => l.textContent.trim().startsWith('CSS de «últimos»'))?.querySelector('textarea')`;
const LABEL = `document.querySelector('main input[placeholder^="Últimos"]')`;
const SAVE = `[...document.querySelectorAll('button')].find(b => /^Guardar/.test(b.textContent.trim()) && !b.disabled)`;
const SAVED = `document.querySelector('.lv-dirty')?.textContent === 'Todo guardado'`;
const type = (el, value) => `(() => { const el = ${el}; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-widgets-remote-sync-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const put = async (url, body) => { const r = await fetch(base + url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200, url); };
  await put('/api/config', { panel: { onboardingDone: true } });
  return { app, base, put, stop: () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

test('a remote widget change reaches the open form and a later save does not overwrite it', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const { app, base, put, stop } = await start(t);
  let chrome;
  try {
    chrome = await openChromePage(bin, base + '/#/widgets/latest');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    await waitDom(c, `!!(${CSS}) && !!(${LABEL})`, { timeoutMs: 15000 });
    assert.equal(await ev(`${CSS}.value`), '');

    await put('/api/widgets', { latest: { css: '.remote { color: red; }' } });   // MCP / another window
    await waitDom(c, `${CSS}.value === '.remote { color: red; }'`, { timeoutMs: 8000 });

    await ev(type(LABEL, 'Gracias por el apoyo'));
    await waitDom(c, `!!(${SAVE})`, { timeoutMs: 5000 });
    await ev(`${SAVE}.click(); true`);
    await waitDom(c, SAVED, { timeoutMs: 8000 });
    assert.equal(app.store.config.widgets.latest.label, 'Gracias por el apoyo');
    assert.equal(app.store.config.widgets.latest.css, '.remote { color: red; }', 'the remote change is kept');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), stop);
  }
});

test('an unsaved local edit survives a remote change to another field', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const { app, base, put, stop } = await start(t);
  let chrome;
  try {
    chrome = await openChromePage(bin, base + '/#/widgets/latest');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    await waitDom(c, `!!(${CSS}) && !!(${LABEL})`, { timeoutMs: 15000 });
    await ev(type(CSS, '.mine { color: blue; }'));
    await waitDom(c, `!!(${SAVE})`, { timeoutMs: 5000 });

    await put('/api/widgets', { latest: { label: 'Remoto' } });
    await waitDom(c, `${LABEL}.value === 'Remoto'`, { timeoutMs: 8000 });
    assert.equal(await ev(`${CSS}.value`), '.mine { color: blue; }', 'the local edit stays visible');

    await ev(`${SAVE}.click(); true`);
    await waitDom(c, SAVED, { timeoutMs: 8000 });
    assert.equal(app.store.config.widgets.latest.css, '.mine { color: blue; }');
    assert.equal(app.store.config.widgets.latest.label, 'Remoto', 'the remote change to another field is kept');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), stop);
  }
});

test('the global alert CSS changed outside the panel reaches the open alert editor (#351)', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const { app, base, put, stop } = await start(t);
  let chrome;
  try {
    chrome = await openChromePage(bin, base + '/#/alertas/follow/css');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    const tab = `[...document.querySelectorAll('main button, main [role=radio]')].find(b => b.textContent.trim() === 'Todas las alertas')`;
    const GLOBAL = `[...document.querySelectorAll('main textarea')].find(x => (x.placeholder || '').startsWith('/* Se aplica a TODAS las alertas'))`;
    await waitDom(c, `!!(${tab})`, { timeoutMs: 15000 });
    await ev(`${tab}.click(); true`);
    await waitDom(c, `!!(${GLOBAL})`, { timeoutMs: 5000 });
    await put('/api/config', { overlay: { css: '.alert { --accent: #00E0FF; }' } });   // MCP css_global / another window
    await waitDom(c, `${GLOBAL}.value === '.alert { --accent: #00E0FF; }'`, { timeoutMs: 8000 });
    assert.equal(app.store.config.overlay.css, '.alert { --accent: #00E0FF; }');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), stop);
  }
});

test('Discard after a remote change restores the latest saved values, not older ones (#351)', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const { app, base, put, stop } = await start(t);
  let chrome;
  try {
    await put('/api/widgets', { latest: { css: '.saved { color: green; }' } });
    chrome = await openChromePage(bin, base + '/#/widgets/latest');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    await waitDom(c, `!!(${CSS}) && ${CSS}.value === '.saved { color: green; }' && !!(${LABEL})`, { timeoutMs: 15000 });
    await ev(type(CSS, '.mine { color: blue; }'));
    await waitDom(c, `!!(${SAVE})`, { timeoutMs: 5000 });
    await put('/api/widgets', { latest: { label: 'Remoto' } });   // saved elsewhere while editing
    await waitDom(c, `${LABEL}.value === 'Remoto'`, { timeoutMs: 8000 });
    const discard = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Descartar' && !b.disabled)`;
    await ev(`${discard}.click(); true`);
    await waitDom(c, `${CSS}.value === '.saved { color: green; }'`, { timeoutMs: 5000 });
    assert.equal(await ev(`${LABEL}.value`), 'Remoto', 'the remote label is not rolled back to the value before it');
    assert.equal(app.store.config.widgets.latest.label, 'Remoto');
    assert.equal(app.store.config.widgets.latest.css, '.saved { color: green; }');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), stop);
  }
});

test('Discard in the alert editor restores the alert CSS saved elsewhere meanwhile (#351)', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const { app, base, put, stop } = await start(t);
  let chrome;
  try {
    await put('/api/alerts/follow', { css: '.alert { --accent: #111111; }' });
    chrome = await openChromePage(bin, base + '/#/alertas/follow/css');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    const OWN = `[...document.querySelectorAll('main textarea')].find(x => (x.placeholder || '').startsWith('/* Tu CSS gana'))`;
    await waitDom(c, `!!(${OWN}) && ${OWN}.value === '.alert { --accent: #111111; }'`, { timeoutMs: 15000 });
    await ev(type(OWN, '.alert { --accent: #222222; }'));
    await waitDom(c, `!!(${SAVE})`, { timeoutMs: 5000 });
    await put('/api/alerts/follow', { css: '.alert { --accent: #333333; }' });   // another window saves this alert
    await new Promise(r => setTimeout(r, 600));
    assert.equal(await ev(`${OWN}.value`), '.alert { --accent: #222222; }', 'the local edit stays while it is unsaved');
    const discard = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Descartar' && !b.disabled)`;
    await ev(`${discard}.click(); true`);
    await waitDom(c, `${OWN}.value === '.alert { --accent: #333333; }'`, { timeoutMs: 5000 });
    assert.equal(app.store.config.alerts.follow.css, '.alert { --accent: #333333; }');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), stop);
  }
});
