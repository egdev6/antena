// The save bar is fixed to the bottom of the window and only slides in when there is
// something to apply. While clean it stays mounted (status «Todo guardado») but sits
// below the viewport and is inert. Screen actions live in the header, and the bar
// carries no hint texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const q = JSON.stringify;
const btnByText = (scope, text) => `[...document.querySelectorAll(${q(scope + ' button, ' + scope + ' a')})].find(b => b.textContent.trim() === ${q(text)})`;
const bar = `[...document.querySelectorAll('.lv-sfoot')].find(f => [...f.querySelectorAll('button')].some(b => b.textContent.trim() === 'Guardar'))`;
const tabByName = name => `[...document.querySelectorAll('.lv-slide .lv-stabs [role="tab"]')].find(t => t.textContent.trim().startsWith(${q(name)}))`;
const status = `(${bar})?.querySelector('.lv-dirty[role="status"]')?.textContent.trim()`;
// Bar geometry and state, measured as the user sees it.
const barState = `(f => f && (r => ({
  top: r.top, bottom: r.bottom, vh: innerHeight, inert: f.inert === true,
  position: getComputedStyle(f).position, status: f.querySelector('.lv-dirty[role="status"]')?.textContent.trim(),
}))(f.getBoundingClientRect()))(${bar})`;
const hidden = `(s => !!s && s.top >= s.vh - 1 && s.inert && s.status === 'Todo guardado')(${barState})`;
const shown = `(s => !!s && s.position === 'fixed' && Math.abs(s.bottom - s.vh) <= 1 && s.top < s.vh && !s.inert)(${barState})`;

test('save bar: fixed at the bottom, only shown with pending changes', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-savebar-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/alertas/follow`);
    const c = chrome.cdp;
    const ev = e => evaluateChrome(c, e);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

    // 1. Clean alert slide: the bar is mounted but off-screen and inert.
    await waitDom(c, `!!document.querySelector('.lv-slide .lv-stabs [role="tab"]') && !!(${bar})`, { timeoutMs: 15000 });
    await waitDom(c, hidden, { timeoutMs: 5000 }).catch(() => {});
    const clean = await ev(barState);
    assert.ok(clean.top >= clean.vh - 1, `clean bar sits below the viewport (top ${clean.top}, innerHeight ${clean.vh})`);
    assert.equal(clean.inert, true, 'clean bar is inert');
    assert.equal(clean.status, 'Todo guardado');

    // 2. Screen actions live in the slide header and stay visible.
    for (const label of ['Restaurar de serie…', 'Probar en el directo']) {
      assert.ok(await ev(`!!(${btnByText('.lv-slide .lv-shead', label)})`), `«${label}» is in the slide header`);
      assert.equal(await ev(`!!(${btnByText('.lv-sfoot', label)})`), false, `«${label}» is not in the save bar`);
      assert.ok(await ev(`(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; })(${btnByText('.lv-slide .lv-shead', label)})`), `«${label}» is visible`);
    }

    // 3. Editing a field slides the bar in, fixed to the bottom.
    const value = 'Save bar title';
    await ev(`(${tabByName('Mensaje')}).click(); true`);
    await waitDom(c, `!!document.querySelector('[data-field="title"] input')`, { timeoutMs: 5000 });
    await ev(`(() => {
      const input = document.querySelector('[data-field="title"] input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${q(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitDom(c, `${status} === 'Cambios sin guardar'`, { timeoutMs: 5000 });
    await waitDom(c, shown, { timeoutMs: 5000 }).catch(() => {});
    const dirty = await ev(barState);
    assert.equal(dirty.position, 'fixed', 'dirty bar is position: fixed');
    assert.ok(Math.abs(dirty.bottom - dirty.vh) <= 1, `dirty bar touches the bottom (bottom ${dirty.bottom}, innerHeight ${dirty.vh})`);
    assert.ok(dirty.top < dirty.vh, 'dirty bar is on screen');
    assert.equal(dirty.inert, false, 'dirty bar is interactive');
    assert.equal(dirty.status, 'Cambios sin guardar');

    // 4. Saving slides it back out and persists the value.
    await ev(`(${btnByText('.lv-sfoot', 'Guardar')}).click(); true`);
    await waitDom(c, `${status} === 'Todo guardado'`, { timeoutMs: 10000 });
    await waitDom(c, hidden, { timeoutMs: 5000 }).catch(() => {});
    const saved = await ev(barState);
    assert.ok(saved.top >= saved.vh - 1, `saved bar is below the viewport again (top ${saved.top})`);
    assert.equal(saved.inert, true, 'saved bar is inert again');
    assert.equal(app.store.config.alerts.follow.title, value, 'server config has the saved value');

    // 5. Page-level bars behave the same and carry no hint texts.
    await ev(`location.hash = '#/apariencia'; true`);
    await waitDom(c, `!document.querySelector('.lv-slide') && !!(${bar})`, { timeoutMs: 10000 });
    await waitDom(c, hidden, { timeoutMs: 5000 }).catch(() => {});
    const page = await ev(barState);
    assert.ok(page.top >= page.vh - 1, `clean page bar is below the viewport (top ${page.top})`);
    assert.equal(page.inert, true, 'clean page bar is inert');
    assert.equal(page.status, 'Todo guardado');

    await ev(`location.hash = '#/sorteo'; true`);
    await waitDom(c, `!!(${bar}) && [...document.querySelectorAll('h1, h2')].some(h => h.textContent.trim() === 'Sorteo')`, { timeoutMs: 10000 });
    assert.equal(await ev(`document.body.textContent.includes('Abrir, sortear y quitar participantes se aplica al momento.')`), false, 'the giveaway hint is gone');
    assert.equal(await ev(`!!(${bar})?.querySelector('.hint')`), false, 'the save bar carries no hint');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); },
      () => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
});
