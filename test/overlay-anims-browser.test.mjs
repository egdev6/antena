// #364: goal, tier list and latest keep their look and run their animations on the
// compositor: the bar tips sit where the progress says, and no running animation or
// transition changes width, background-position or box-shadow. Everything is checked in
// the normal page and with ?slot=1 (the mode the widget slots of custom overlays use).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const REPAINT = new Set(['width', 'background-position', 'background-position-x', 'background-position-y', 'box-shadow']);
const COMPOSITED = new Set(['transform', 'translate', 'scale', 'rotate', 'opacity']);
const MODES = [['', 'normal page'], ['&slot=1', 'slot=1']];

async function start(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador'); return null; }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-overlay-anims-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal(res.ok, true, `${method} ${url} -> ${res.status}`);
    return res.json();
  };
  const close = async () => {
    app.timers.stop(); app.viewers.stop(); app.meld.stop();
    await app.channelTotals.flush();
    app.server.closeAllConnections();
    await new Promise(r => app.server.close(r));
    await app.interactive.flush();
  };
  return { bin, app, base, call, close };
}

/** Opens a page of the widget at a fixed viewport; the caller closes it with closeChrome. */
async function open(bin, url) {
  const chrome = await openChromePage(bin, url);
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 700, deviceScaleFactor: 1, mobile: false });
  return chrome;
}

const ev = (chrome, expression) => evaluateChrome(chrome.cdp, expression, { timeoutMs: 15000 });

/** Page expression: every running animation and transition, with the properties it changes (kebab-case). */
const ANIMATIONS = `JSON.stringify(document.getAnimations().map(a => ({
  kind: a.constructor.name, name: a.animationName || a.transitionProperty, pseudo: a.effect.pseudoElement || null,
  props: a instanceof CSSTransition ? [a.transitionProperty]
    : [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k)))].filter(k => !['offset', 'easing', 'composite', 'computedOffset'].includes(k)).map(k => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())),
})))`;
const animations = async chrome => JSON.parse(await ev(chrome, ANIMATIONS));

/** Polls until `condition` holds and returns the animations seen in that same page task, so a short transition cannot be missed. */
async function animationsWhen(chrome, condition, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await ev(chrome, `(() => (${condition}) ? ${ANIMATIONS} : null)()`);
    if (seen) return JSON.parse(seen);
    assert.ok(Date.now() < deadline, `timeout waiting for ${condition}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** Waits until every transition of the page has finished, so geometry is measured at rest. */
const settle = chrome => ev(chrome, `Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))).then(() => true)`);

const repainting = list => list.filter(a => a.props.some(p => REPAINT.has(p)));
const onCompositor = a => a.props.length > 0 && a.props.every(p => COMPOSITED.has(p));

/** How far each bar is filled, 0..1: the visible tip of the fill within its track. */
const fillRatios = (chrome, trackSelector, fillSelector, border) => ev(chrome, `JSON.stringify([...document.querySelectorAll(${JSON.stringify(trackSelector)})].map(track => {
  const t = track.getBoundingClientRect(), f = track.querySelector(${JSON.stringify(fillSelector)}).getBoundingClientRect();
  return Math.max(0, f.right - (t.left + ${border})) / (t.width - ${2 * border});
}))`).then(JSON.parse);

const assertRatios = (actual, expected, message) => {
  assert.equal(actual.length, expected.length, message);
  actual.forEach((ratio, i) => assert.ok(Math.abs(ratio - expected[i]) < 0.004, `${message}: bar ${i} is ${ratio.toFixed(4)}, expected ${expected[i]}`));
};

test('goal: bars keep their progress; stripes, bar changes and the done pulse stay off the paint path', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, call, base, close } = ctx;
  let chrome;
  try {
    app.store.config.widgets.goals = [{ id: 'anims', title: 'Anims', visible: true, showMetric: true, css: '', bars: [
      { id: 'b1', platform: 'twitch', metric: 'bits', target: 200, visible: true },
      { id: 'b2', platform: 'youtube', metric: 'superchats', target: 100, visible: true },
      { id: 'b3', platform: 'youtube', metric: 'members', target: 10, visible: true },
      { id: 'b4', platform: 'twitch', metric: 'raids', target: 4, visible: true },
    ] }];
    await app.store.save('widgets');
    const set = (id, value) => call('POST', `/api/goals/anims/bars/${id}/set`, { value });
    for (const [id, value] of [['b1', 50], ['b2', 100], ['b3', 0], ['b4', 3]]) await set(id, value);   // 25 %, 100 %, 0 %, 75 %
    const texts = `[...document.querySelectorAll('#bars .pct')].map(e => e.textContent).join()`;

    for (const [qs, mode] of MODES) {
      chrome = await open(bin, `${base}/widget/goal?id=anims${qs}`);
      await waitDom(chrome.cdp, `${texts} === '50/200,100/100,0/10,3/4'`, { timeoutMs: 15000 });
      assert.equal(await ev(chrome, `document.body.classList.contains('slot')`), qs !== '', `${mode}: slot class`);

      assertRatios(await fillRatios(chrome, '#bars .bar', '.fill', 1), [0.25, 1, 0, 0.75], `${mode}: bar progress`);
      const idle = await animations(chrome);
      assert.deepEqual(repainting(idle), [], `${mode}: idle animations repaint`);
      assert.ok(idle.some(a => a.kind === 'CSSAnimation' && a.pseudo === '::after' && onCompositor(a)), `${mode}: stripes still animate: ${JSON.stringify(idle)}`);

      await set('b1', 150);                                                    // 25 % -> 75 %
      const changing = await animationsWhen(chrome, `${texts} === '150/200,100/100,0/10,3/4'`);
      assert.deepEqual(repainting(changing), [], `${mode}: transitions repaint`);
      assert.ok(changing.some(a => a.kind === 'CSSTransition' && a.pseudo === null && onCompositor(a)), `${mode}: the bar change is still animated: ${JSON.stringify(changing)}`);
      await settle(chrome);
      assertRatios(await fillRatios(chrome, '#bars .bar', '.fill', 1), [0.75, 1, 0, 0.75], `${mode}: bar progress after the change`);

      await set('b1', 200); await set('b3', 10); await set('b4', 4);           // every bar complete
      await waitDom(chrome.cdp, `document.querySelector('.goal').classList.contains('done')`, { timeoutMs: 15000 });
      const done = await animations(chrome);
      assert.deepEqual(repainting(done), [], `${mode}: done pulse repaints`);
      const pulse = done.find(a => a.name === 'done');
      assert.ok(pulse, `${mode}: the done pulse runs: ${JSON.stringify(done)}`);
      assert.deepEqual([pulse.pseudo, pulse.props], ['::after', ['opacity']], `${mode}: the pulse fades a layer`);

      await closeChrome(chrome); chrome = null;
      await set('b1', 50); await set('b3', 0); await set('b4', 3);            // back to the start for the next mode
    }
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('tier list: vote bars keep their proportions and transition on a compositor property', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, call, base, close } = ctx;
  let chrome;
  try {
    const { tierlist } = await call('POST', '/api/tierlists', { title: 'Anims', items: ['One', 'Two'], tiers: [
      { id: 's', label: 'S', color: '#ff0036' }, { id: 'a', label: 'A', color: '#ff6a3d' }, { id: 'b', label: 'B', color: '#ffb547' }, { id: 'c', label: 'C', color: '#5ed17a' },
    ] });
    await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'One' });
    ['S', 'S', 'S', 'S', 'A'].forEach((label, i) => app.interactive.castVote({ user: 'viewer' + i }, label));   // S 4, A 1, B 0, C 0

    for (const [qs, mode] of MODES) {
      chrome = await open(bin, `${base}/widget/tierlist?id=${tierlist.id}${qs}`);
      await waitDom(chrome.cdp, `[...document.querySelectorAll('#bars .n')].map(e => e.textContent).join() === '4,1,0,0'`, { timeoutMs: 15000 });
      assert.equal(await ev(chrome, `document.body.classList.contains('slot')`), qs !== '', `${mode}: slot class`);
      assertRatios(await fillRatios(chrome, '#bars .bar i', 'b', 0), [1, 0.25, 0, 0], `${mode}: vote bars`);
      assert.deepEqual(repainting(await animations(chrome)), [], `${mode}: running animations repaint`);
      const property = await ev(chrome, `getComputedStyle(document.querySelector('#bars .bar i b')).transitionProperty`);
      assert.ok(COMPOSITED.has(property), `${mode}: vote bars transition ${property}`);
      await closeChrome(chrome); chrome = null;
    }
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('latest: the new-supporter flash fades a layer on the compositor and ends', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    for (const [qs, mode] of MODES) {
      chrome = await open(bin, `${base}/widget/latest?demo${qs}`);
      await waitDom(chrome.cdp, `document.querySelectorAll('.item').length >= 2`, { timeoutMs: 15000 });
      assert.equal(await ev(chrome, `document.body.classList.contains('slot')`), qs !== '', `${mode}: slot class`);
      assert.deepEqual(repainting(await animations(chrome)), [], `${mode}: idle animations repaint`);

      // what apply() does for a changed supporter: the card gets the flash class (read in the same task: the flash is short)
      const { list: flashing, opacity } = JSON.parse(await ev(chrome, `(() => {
        const item = document.querySelector('.item'); item.classList.add('flash');
        return JSON.stringify({ list: JSON.parse(${ANIMATIONS}), opacity: getComputedStyle(item, '::after').opacity });
      })()`));
      assert.deepEqual(repainting(flashing), [], `${mode}: flash repaints`);
      const flash = flashing.find(a => a.name === 'flash');
      assert.ok(flash, `${mode}: the flash runs: ${JSON.stringify(flashing)}`);
      assert.deepEqual([flash.pseudo, flash.props], ['::after', ['opacity']], `${mode}: the flash fades a layer`);
      assert.equal(opacity, '1', `${mode}: the flash is visible while it runs`);

      await ev(chrome, `Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))).then(() => true)`);
      assert.equal(await ev(chrome, `getComputedStyle(document.querySelector('.item'), '::after').opacity`), '0', `${mode}: the flash ends`);
      await closeChrome(chrome); chrome = null;
    }
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});
