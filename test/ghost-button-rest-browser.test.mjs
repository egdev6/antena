// #148: ghost controls remain identifiable without hover, across panel views and states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const button = text => `Array.from(document.querySelectorAll('main button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const ghost = button('Vaciar');
const style = element => `(() => {
  const el = ${element}, s = getComputedStyle(el);
  return { background: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow,
    color: s.color, opacity: s.opacity, pointerEvents: s.pointerEvents,
    hover: el.matches(':hover'), focus: el.matches(':focus-visible') };
})()`;
const tokenStyle = css => `(() => {
  const el = document.createElement('span'); el.style.cssText = ${JSON.stringify(css)};
  document.body.appendChild(el);
  const s = getComputedStyle(el), result = { background: s.backgroundColor, image: s.backgroundImage, shadow: s.boxShadow, color: s.color };
  el.remove(); return result;
})()`;

function assertVisibleSurface(actual, surrounding) {
  const alpha = actual.background.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
  assert.ok(actual.background !== 'transparent' && (!alpha || Number(alpha[1]) > 0), 'the resting surface is not transparent');
  assert.notEqual(actual.background, surrounding, 'the resting surface differs from its surrounding surface');
}

function assertHairline(shadow) {
  const edge = shadow.match(/rgba?\([^)]+\) 0px 0px 0px 1px(?:,|$)/);
  assert.ok(edge, `expected a 1px outer edge, got ${shadow}`);
  const alpha = edge[0].match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
  assert.ok(!alpha || Number(alpha[1]) > 0, `the edge must not be transparent: ${shadow}`);
}

test('S4: panel ghost buttons have an identifiable resting state without losing interaction states', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-ghost-rest-'));
  let app, chrome;
  t.after(async () => {
    try { if (chrome) await closeChrome(chrome); }
    finally {
      try { if (app) { app.timers.stop(); await app.closeHttp(); } }
      finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200, `${method} ${url}`);
    return response.json();
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true } });
  chrome = await openChromePage(bin, `${base}/#/sorteo`);
  const c = chrome.cdp;
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await waitDom(c, `!!${ghost} && !!${button('Abrir sorteo')} && !!${button('Sortear')}`, { timeoutMs: 15000 });
  const rest = await evaluateChrome(c, style(ghost));
  const surrounding = await evaluateChrome(c, `getComputedStyle(${ghost}.closest('.view-head')).backgroundColor`);

  await t.test('Vaciar has a visible surface at rest', () => {
    assert.equal(rest.hover, false);
    assert.equal(rest.focus, false);
    assertVisibleSurface(rest, surrounding);
  });
  await t.test('Vaciar has a visible 1px edge at rest', () => assertHairline(rest.shadow));

  await t.test('hover retains the stronger design-system appearance', async () => {
    const point = await evaluateChrome(c, `(() => { const r = ${ghost}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await waitDom(c, `${ghost}.matches(':hover')`);
    const hover = await evaluateChrome(c, style(ghost));
    const expected = await evaluateChrome(c, tokenStyle('background:var(--gradient-sheen),var(--color-surface-2);box-shadow:var(--shadow-edge),0 0 0 1px var(--color-border-hairline);color:var(--color-fg-default)'));
    assert.equal(hover.background, expected.background);
    assert.equal(hover.image, expected.image);
    assert.equal(hover.shadow, expected.shadow);
    assert.equal(hover.color, expected.color);
    assert.notEqual(hover.shadow, rest.shadow);
    assert.notEqual(hover.color, rest.color);
  });

  await t.test('keyboard focus retains its focus ring, even while hovered', async () => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await evaluateChrome(c, `${ghost}.focus(); true`);
    await waitDom(c, `${ghost}.matches(':focus-visible')`);
    const focus = await evaluateChrome(c, style(ghost));
    const expected = await evaluateChrome(c, tokenStyle('box-shadow:var(--shadow-focus)'));
    assert.equal(focus.shadow, expected.shadow);
    assert.notEqual(focus.shadow, rest.shadow);
    const point = await evaluateChrome(c, `(() => { const r = ${ghost}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await waitDom(c, `${ghost}.matches(':hover') && ${ghost}.matches(':focus-visible')`);
    assert.equal((await evaluateChrome(c, style(ghost))).shadow, expected.shadow);
  });

  await t.test('disabled ghost controls remain dim and non-interactive', async () => {
    await evaluateChrome(c, `location.hash = '#/preguntas'`);
    const disabled = button('Limpiar');
    await waitDom(c, `!!${disabled} && ${disabled}.disabled`);
    const state = await evaluateChrome(c, style(disabled));
    assert.equal(rest.opacity, '1');
    assert.equal(state.opacity, '0.45');
    assert.equal(state.pointerEvents, 'none');
    assert.equal(state.shadow, 'none');
  });

  await t.test('ghost links also have a surface and edge at rest', async () => {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
    await evaluateChrome(c, `location.hash = '#/tierlist/nueva'`);
    const link = `Array.from(document.querySelectorAll('.lv-slide a.eg-btn--ghost')).find(a => a.textContent.trim() === 'Cancelar')`;
    await waitDom(c, `!!${link}`);
    const state = await evaluateChrome(c, style(link));
    const parent = await evaluateChrome(c, `getComputedStyle(${link}.closest('.lv-sfoot')).backgroundColor`);
    assert.equal(state.hover, false);
    assert.equal(state.focus, false);
    assertVisibleSurface(state, parent);
    assertHairline(state.shadow);
  });

  await t.test('primary and secondary variants keep their existing appearance', async () => {
    await evaluateChrome(c, `location.hash = '#/sorteo'`);
    await waitDom(c, `!!${button('Abrir sorteo')} && !!${button('Sortear')}`);
    const secondary = await evaluateChrome(c, style(button('Abrir sorteo')));
    const primary = await evaluateChrome(c, style(button('Sortear')));
    const secondaryExpected = await evaluateChrome(c, tokenStyle('background:var(--gradient-btn-secondary),var(--color-surface-1);box-shadow:var(--shadow-edge-strong),var(--shadow-elev-1);color:var(--color-action-primary-fg)'));
    const primaryExpected = await evaluateChrome(c, tokenStyle('background:var(--gradient-btn-primary);color:var(--color-action-primary-solid-fg)'));
    assert.equal(secondary.background, secondaryExpected.background);
    assert.equal(secondary.image, secondaryExpected.image);
    assert.equal(secondary.shadow, secondaryExpected.shadow);
    assert.equal(secondary.color, secondaryExpected.color);
    assert.equal(primary.image, primaryExpected.image);
    assert.equal(primary.color, primaryExpected.color);
    assert.equal(primary.opacity, '0.45');
    assert.equal(primary.shadow, 'none');
  });

  await t.test('Vaciar still confirms and clears the giveaway', async () => {
    await api('POST', '/api/giveaway/open', {});
    await api('POST', '/api/giveaway/join', { user: 'Participante' });
    await waitDom(c, `document.querySelector('.eg-stat__value')?.textContent.trim() === '1'`);
    await evaluateChrome(c, `window.confirm = message => { window.lastConfirm = message; return true; }; ${ghost}.click(); true`);
    await waitDom(c, `document.querySelector('.eg-stat__value')?.textContent.trim() === '0'`);
    assert.equal(await evaluateChrome(c, 'window.lastConfirm'), '¿Vaciar participantes y ganadores?');
    const state = await api('GET', '/api/interactive');
    assert.equal(state.giveaway.count, 0);
    assert.deepEqual(state.giveaway.winners, []);
  });
});
