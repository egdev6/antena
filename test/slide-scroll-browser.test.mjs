// Vertical slides own their scroll: while a slide is open, the wheel never scrolls the
// page behind it, whether the slide content fits or not, and the page is usable again
// once the slide closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const settle = c => evaluateChrome(c, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 150))))');

async function wheel(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 400 });
  await settle(c);
}

// A visible point inside the slide that is not the live preview iframe.
const slidePoint = `(() => {
  const s = document.querySelector('.lv-slide').getBoundingClientRect();
  for (let y = s.top + s.height * 0.75; y > s.top + 80; y -= 20) {
    const x = Math.round(s.left + 30), e = document.elementFromPoint(x, y);
    if (e && e.closest('.lv-slide') && !e.closest('iframe, .preview')) return { x, y: Math.round(y) };
  }
  return null;
})()`;

const tabByName = name => `[...document.querySelectorAll('.lv-slide .lv-stabs [role="tab"]')].find(t => t.textContent.trim() === ${JSON.stringify(name)})`;

test('slides: the wheel scrolls the slide, never the page behind it', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-slide-scroll-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/alertas`);
    const c = chrome.cdp;
    const ev = e => evaluateChrome(c, e);
    // The alert list behind the slide is taller than the window at both sizes used below.
    const viewport = height => c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height, deviceScaleFactor: 1, mobile: false });
    await viewport(900);
    await waitDom(c, `document.querySelectorAll('.lv-card').length > 0`, { timeoutMs: 15000 });
    await settle(c);
    assert.ok(await ev('document.documentElement.scrollHeight > innerHeight + 200'), 'precondition: the page behind can scroll');

    await ev(`location.hash = '#/alertas/follow'; true`);
    await waitDom(c, `!!document.querySelector('.lv-slide .lv-stabs [role="tab"]')`, { timeoutMs: 10000 });

    // Content that fits: the page behind must not move.
    await ev(`(${tabByName('Mensaje')}).click(); true`);
    await settle(c);
    const fits = await ev(`(s => ({ fits: s.scrollHeight <= s.clientHeight, sh: s.scrollHeight, ch: s.clientHeight, bar: String(s.querySelector('.lv-savebar')?.className), status: s.querySelector('.lv-savebar [role=status]')?.textContent }))(document.querySelector('.lv-slide'))`);
    assert.equal(fits.fits, true, `precondition: Mensaje fits in the slide ${JSON.stringify(fits)}`);
    const fit = await ev(slidePoint);
    assert.ok(fit, 'a non-preview point inside the slide');
    await wheel(c, fit.x, fit.y);
    assert.equal(await ev('scrollY'), 0, 'wheel over a slide whose content fits does not scroll the page behind');

    // Wheel over the live preview iframe: still no page scroll.
    const pv = await ev(`(p => { const r = p.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })(document.querySelector('.lv-slide .preview'))`);
    await wheel(c, pv.x, pv.y);
    assert.equal(await ev('scrollY'), 0, 'wheel over the slide preview does not scroll the page behind');

    // Content taller than the slide: a short window guarantees it regardless of platform
    // fonts (at 640px the CSS tab overflows on Linux but fits on Windows).
    await viewport(420);
    await ev(`(${tabByName('CSS')}).click(); true`);
    await settle(c);
    const tallBox = await ev(`(s => ({ sh: s.scrollHeight, ch: s.clientHeight }))(document.querySelector('.lv-slide'))`);
    assert.ok(tallBox.sh > tallBox.ch + 100, `precondition: CSS clearly overflows the slide ${JSON.stringify(tallBox)}`);
    const tall = await ev(slidePoint);
    await wheel(c, tall.x, tall.y);
    assert.ok(await ev(`document.querySelector('.lv-slide').scrollTop`) > 0, 'the slide scrolls its own content');
    await wheel(c, tall.x, tall.y);
    await wheel(c, tall.x, tall.y);
    assert.equal(await ev('scrollY'), 0, 'reaching the end of the slide does not chain to the page behind');

    // After closing the slide, the page scrolls normally again.
    await ev(`location.hash = '#/alertas'; true`);
    await waitDom(c, `!document.querySelector('.lv-slide')`, { timeoutMs: 10000 });
    await settle(c);
    const page = await ev(`(r => ({ x: Math.round(r.left + 40), y: Math.round(innerHeight / 2) }))(document.querySelector('main').getBoundingClientRect())`);
    await wheel(c, page.x, page.y);
    assert.ok(await ev('scrollY') > 0, 'the page scrolls again once the slide is closed');
  } finally {
    if (chrome) await closeChrome(chrome);
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
