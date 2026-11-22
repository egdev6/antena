// S3/S6: real API and compiled panel/dock; the parent rebuilds before running this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function fixture(t) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-themes-browser-'));
  let app; const browsers = [];
  t.after(async () => {
    try { for (const browser of browsers) await closeChrome(browser); }
    finally { try { if (app) { app.timers.stop(); app.teleprompter.stop(); app.viewers.stop(); await app.closeHttp(); } } finally { await rm(dir, { recursive: true, force: true }); } }
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.ok, true, JSON.stringify(data)); return data;
  };
  await call('PUT', '/api/config', { panel: { onboardingDone: true } });
  const open = async (url, width = 1100) => {
    const browser = await openChromePage(bin, 'about:blank'); browsers.push(browser);
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await browser.cdp.send('Page.navigate', { url: base + url });
    return browser.cdp;
  };
  return { call, open };
}
const ev = (c, expr) => evaluateChrome(c, expr);
const active = async call => (await call('GET', '/api/themes')).themes.find(x => x.active).id;
const click = (c, selector) => ev(c, `document.querySelector(${JSON.stringify(selector)}).click(); true`);
const setValue = (c, selector, value) => ev(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); return true; })()`);

test('Apariencia: select without activating, activate, duplicate, rename and delete', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.call('PUT', '/api/theme', { accent: '#123456' });
  await f.call('PUT', '/api/config', { alerts: { follow: { title: 'Alerta de invierno' } }, widgets: { chat: { fontSize: 36 }, goals: [{ id: 'g', title: 'Meta de invierno', visible: true, showMetric: true, css: '', bars: [{ id: 'b', platform: 'twitch', metric: 'follows', target: 50, visible: true }] }] } });
  const copy = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Navidad' })).theme;
  await f.call('PUT', '/api/theme', { accent: '#FF0036' });
  await f.call('PUT', '/api/config', { alerts: { follow: { title: 'Actual' } }, widgets: { chat: { fontSize: 24 } } });
  const c = await f.open('/#/apariencia');
  await waitDom(c, `!!document.querySelector('[data-theme-row="${copy.id}"]') && !!document.querySelector('[data-theme-preview]')`, { timeoutMs: 20000 });
  assert.equal(await ev(c, `document.querySelector('.lv-pagetabs [aria-selected=true]').textContent.trim()`), 'Temas');
  await click(c, `[data-theme-row="${copy.id}"]`);
  await waitDom(c, `document.querySelector('[data-theme-preview]')?.dataset.lookAccent === '#123456'`);
  assert.equal(await active(f.call), 'normal');
  assert.equal(await ev(c, `document.querySelector('[data-theme-preview]').textContent.includes('aún no activo')`), true);
  await waitDom(c, `document.querySelector('[data-theme-alert] iframe')?.contentDocument?.querySelector('.alert-title')?.textContent.includes('Alerta de invierno')`);
  await waitDom(c, `document.querySelector('[data-theme-goal] iframe')?.contentDocument?.querySelector('#title')?.textContent.includes('Meta de invierno')`);
  await waitDom(c, `document.querySelector('[data-theme-chat] iframe')?.contentDocument?.querySelector('#root')?.style.getPropertyValue('--fs') === '36px'`);
  await click(c, '[data-theme-activate]');
  await waitDom(c, `document.querySelector('[data-theme-preview]').textContent.includes('Activo')`);
  assert.equal(await active(f.call), copy.id);
  assert.equal(await ev(c, `document.querySelector('[data-theme-delete]').disabled && document.body.textContent.includes('No se puede borrar el tema activo. Activa otro primero.')`), true);
  await click(c, '[data-theme-duplicate]'); await waitDom(c, `!!document.querySelector('[role=dialog] #theme-name')`);
  await setValue(c, '#theme-name', 'Copia de Navidad'); await click(c, '[data-theme-submit]');
  await waitDom(c, `document.body.textContent.includes('Copia de Navidad') && !document.querySelector('[role=dialog]')`);
  await click(c, '[data-theme-rename]'); await waitDom(c, `!!document.querySelector('[role=dialog] #theme-name')`);
  await setValue(c, '#theme-name', 'Invierno'); await click(c, '[data-theme-submit]');
  await waitDom(c, `document.querySelector('[data-theme-preview]').textContent.includes('Invierno')`);
  await ev(c, `window.confirm = () => true`); await click(c, '[data-theme-delete]');
  await waitDom(c, `!document.body.textContent.includes('Invierno')`);
  assert.equal(await active(f.call), copy.id);
});

test('new theme from default and the ten-theme limit', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open('/#/apariencia');
  await waitDom(c, `!!document.querySelector('[data-theme-new]')`, { timeoutMs: 20000 });
  await click(c, '[data-theme-new]');
  await waitDom(c, `!!document.querySelector('#theme-origin')`);
  await setValue(c, '#theme-origin', '__default'); await setValue(c, '#theme-name', 'Desde cero'); await click(c, '[data-theme-submit]');
  await waitDom(c, `document.body.textContent.includes('Desde cero') && !document.querySelector('[role=dialog]')`);
  const created = (await f.call('GET', '/api/themes')).themes.find(x => x.name === 'Desde cero');
  const look = (await f.call('GET', `/api/themes/${created.id}/look`)).look;
  assert.equal(look.theme.platformAccent, true); assert.equal(look.theme.platformBadge, 'logo');
  for (let i = 0; i < 8; i++) await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: `Tema ${i}` });
  await waitDom(c, `document.querySelector('[data-theme-new]')?.disabled && document.body.textContent.includes('10 / 10')`);
  assert.match(await ev(c, `document.querySelector('[data-theme-limit]').textContent`), /10/);
});

test('inactive preview uses the real renderers without changing the active overlay', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.call('PUT', '/api/config', { theme: { platformAccent: false, accent: '#123456' }, alerts: { follow: { title: 'Invierno', css: '.alert { --accent: #2468AC; }' } }, widgets: { chat: { css: '.msg { border-left-width: 11px; }' }, goals: [{ id: 'g', title: 'Meta invierno', visible: true, showMetric: true, css: '.goal { opacity: .8; }', bars: [{ id: 'b', platform: 'twitch', metric: 'follows', target: 50, visible: true }] }] } });
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).theme;
  await f.call('PUT', '/api/config', { theme: { accent: '#FF0036' }, alerts: { follow: { title: 'Activo', css: '', durationMs: 30000 } }, widgets: { chat: { css: '' }, goals: [{ id: 'g', title: 'Meta activa', visible: true, showMetric: true, css: '', bars: [{ id: 'b', platform: 'twitch', metric: 'follows', target: 50, visible: true }] }] } });
  const live = await f.open('/overlay');
  const deadline = Date.now() + 10000;
  while (!(await f.call('GET', '/api/status')).overlays) {
    assert.ok(Date.now() < deadline, 'live overlay connects');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await f.call('POST', '/api/test', { type: 'follow', target: 'live' });
  await waitDom(live, `document.querySelector('.alert.on') && getComputedStyle(document.querySelector('.alert')).getPropertyValue('--accent').trim().toUpperCase() === '#FF0036'`);
  const c = await f.open('/#/apariencia');
  await waitDom(c, `!!document.querySelector('[data-theme-row="${other.id}"]')`, { timeoutMs: 20000 });
  await click(c, `[data-theme-row="${other.id}"]`);
  const frame = `document.querySelector('[data-theme-alert] iframe')?.contentDocument`;
  await waitDom(c, `${frame}?.querySelector('.alert.on') && getComputedStyle(${frame}.querySelector('.alert')).getPropertyValue('--accent').trim().toUpperCase() === '#2468AC'`);
  await waitDom(c, `document.querySelector('[data-theme-goal] iframe')?.contentDocument?.querySelector('#title')?.textContent === 'Meta invierno'`);
  await waitDom(c, `document.querySelector('[data-theme-chat] iframe')?.contentDocument?.querySelector('.msg')`);
  assert.equal(await ev(c, `getComputedStyle(document.querySelector('[data-theme-chat] iframe').contentDocument.querySelector('.msg')).borderLeftWidth`), '11px');
  assert.equal(await active(f.call), 'normal');
  assert.equal(await ev(live, `document.querySelector('.alert-title').textContent.includes('Activo') && getComputedStyle(document.querySelector('.alert')).getPropertyValue('--accent').trim().toUpperCase() === '#FF0036'`), true);
});

test('external switch keeps a draft visible, blocks save and allows discard; stale header is rejected', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' })).theme;
  const c = await f.open('/#/apariencia/color');
  await waitDom(c, `!!document.querySelector('.ap-color input.mono')`, { timeoutMs: 20000 });
  // React's controlled color field accepts a complete hex value on its input event.
  await setValue(c, '.ap-color input.mono', '#123456');
  await waitDom(c, `document.querySelector('.ap-color input.mono').value === '#123456' && !!document.querySelector('.lv-dirty.is-on')`);
  await f.call('POST', `/api/themes/${other.id}/activate`);
  const error = 'El tema activo cambió mientras editabas; tus cambios no se guardaron';
  await waitDom(c, `document.querySelector('.lv-savebar')?.textContent.includes(${JSON.stringify(error)}) && document.querySelector('.lv-savebar .eg-btn--secondary').disabled`);
  assert.equal(await ev(c, `document.querySelector('.ap-color input.mono').value`), '#123456');
  const before = (await f.call('GET', '/api/theme')).theme.accent;
  const refused = await ev(c, `fetch('/api/theme', {method:'PUT', headers:{'Content-Type':'application/json', 'X-Antena-Theme':'normal'}, body:JSON.stringify({accent:'#123456'})}).then(async r => ({status:r.status, body:await r.json()}))`);
  assert.deepEqual(refused, { status: 409, body: { error } });
  assert.equal((await f.call('GET', '/api/theme')).theme.accent, before);
  await ev(c, `[...document.querySelectorAll('.lv-savebar button')].find(b => b.textContent.trim() === 'Descartar').click()`);
  await waitDom(c, `!document.querySelector('.lv-dirty.is-on') && document.querySelector('.ap-color input.mono').value === ${JSON.stringify(before)}`);
});

for (const kind of ['alerta', 'widget', 'comando']) {
  test(`external switch fences the ${kind} editor draft`, { timeout: 120000 }, async t => {
    const f = await fixture(t); if (!f) return;
    const command = kind === 'comando' ? (await f.call('POST', '/api/commands', { trigger: '!fence' })).command : null;
    const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' })).theme;
    const route = kind === 'widget' ? '/#/widgets/chat' : kind === 'comando' ? `/#/comandos/${command.id}` : '/#/alertas/follow';
    const field = kind === 'widget'
      ? `[...document.querySelectorAll('label')].find(x => x.textContent.trim().startsWith('Tamaño de letra (px)'))?.querySelector('input')`
      : `document.querySelector('[data-field="title"] input')`;
    const c = await f.open(route);
    await waitDom(c, `!!(${field})`, { timeoutMs: 20000 });
    if (kind !== 'widget') {
      await ev(c, `[...document.querySelectorAll('.lv-stabs button')].find(b => b.textContent.trim() === 'Mensaje').click()`);
      await waitDom(c, `document.querySelector('#tp-message')?.hidden === false`);
    }
    const original = await ev(c, `(${field}).value`), value = kind === 'widget' ? '37' : 'Borrador de prueba';
    await ev(c, `(() => { const input = ${field}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    await waitDom(c, `(${field}).value === ${JSON.stringify(value)} && !!document.querySelector('.lv-dirty.is-on')`);
    await f.call('POST', `/api/themes/${other.id}/activate`);
    const msg = 'El tema activo cambió mientras editabas; tus cambios no se guardaron';
    await waitDom(c, `document.querySelector('.lv-savebar')?.textContent.includes(${JSON.stringify(msg)}) && document.querySelector('.lv-savebar .eg-btn--secondary').disabled`);
    assert.equal(await ev(c, `(${field}).value`), value);
    const config = await f.call('GET', '/api/config');
    const stored = kind === 'widget' ? String(config.widgets.chat.fontSize) : kind === 'comando' ? config.commands.find(x => x.id === command.id).title : config.alerts.follow.title;
    assert.equal(stored, original);
    await ev(c, `[...document.querySelectorAll('.lv-savebar button')].find(b => b.textContent.trim() === 'Descartar').click()`);
    await waitDom(c, `!document.querySelector('.lv-dirty.is-on') && (${field})?.value === ${JSON.stringify(original)}`);
  });
}

test('sidebar and dock theme switchers synchronize across narrow and wide layouts', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' })).theme;
  const panel = await f.open('/#/apariencia'), narrow = await f.open('/dock', 360), wide = await f.open('/dock', 1100);
  await waitDom(panel, `!!document.querySelector('[data-theme-sidebar]')`, { timeoutMs: 20000 });
  for (const c of [narrow, wide]) await waitDom(c, `!!document.querySelector('[data-dock-theme-tab]') && !!document.querySelector('[data-dock-active-theme]')`, { timeoutMs: 20000 });
  await click(panel, '[data-theme-sidebar] summary');
  await waitDom(panel, `document.querySelector('[data-theme-sidebar]').textContent.includes('Se aplica al momento en pantalla.')`);
  await click(panel, `[data-theme-switch="${other.id}"]`);
  for (const c of [narrow, wide]) await waitDom(c, `document.querySelector('[data-dock-active-theme]').textContent.includes('Otro')`);
  assert.equal(await active(f.call), other.id);
  await click(narrow, '[data-dock-theme-tab]'); await waitDom(narrow, `!!document.querySelector('[data-dock-theme-list]')`);
  await click(narrow, '[data-dock-theme-switch="normal"]');
  await waitDom(panel, `document.querySelector('[data-theme-sidebar] summary').textContent.includes('Normal')`);
  await waitDom(wide, `document.querySelector('[data-dock-active-theme]').textContent.includes('Normal')`);
  await click(wide, '[data-dock-theme-tab]'); await waitDom(wide, `!!document.querySelector('[data-dock-theme-list]')`);
  assert.equal(await ev(wide, `document.querySelector('[data-dock-theme-list]').textContent.includes('Las alertas que ya están en pantalla terminan con su aspecto anterior. La cola continúa.')`), true);
  await click(wide, `[data-dock-theme-switch="${other.id}"]`);
  await waitDom(narrow, `document.querySelector('[data-dock-active-theme]').textContent.includes('Otro')`);
  await waitDom(panel, `document.querySelector('[data-theme-sidebar] summary').textContent.includes('Otro')`);
  assert.equal(await active(f.call), other.id);
});
