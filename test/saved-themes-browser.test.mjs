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
  return { call, open, base };
}
const ev = (c, expr) => evaluateChrome(c, expr);
const active = async call => (await call('GET', '/api/themes')).themes.find(x => x.active).id;
const click = (c, selector) => ev(c, `document.querySelector(${JSON.stringify(selector)}).click(); true`);
const setValue = (c, selector, value) => ev(c, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); return true; })()`);

test('Apariencia: export the selected theme and preview an import before creating it inactive', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).theme;
  const panel = await f.open('/#/apariencia');
  await waitDom(panel, `!!document.querySelector('[data-theme-row="${other.id}"]')`, { timeoutMs: 20000 });
  await click(panel, `[data-theme-row="${other.id}"]`);
  await waitDom(panel, `!!document.querySelector('[data-theme-export]')`);
  await ev(panel, `(() => { const old = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() { window.__themeExportUrl = this.href; }; window.__restoreThemeClick = () => { HTMLAnchorElement.prototype.click = old; }; return true; })()`);
  await click(panel, '[data-theme-export]');
  await waitDom(panel, `!!window.__themeExportUrl`);
  assert.equal(await ev(panel, `new URL(window.__themeExportUrl).pathname`), `/api/themes/${other.id}/export`);
  await ev(panel, `window.__restoreThemeClick(); true`);
  await ev(panel, `(async () => { const response = await fetch(window.__themeExportUrl); const blob = await response.blob(); const files = new DataTransfer(); files.items.add(new File([blob], 'tema.zip', {type:'application/zip'})); const input = document.querySelector('[data-theme-import-file]'); input.files = files.files; input.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  await waitDom(panel, `!!document.querySelector('[role=dialog] [data-theme-import-name]')`);
  assert.equal(await ev(panel, `document.querySelector('[data-theme-import-name]').value`), 'Invierno (2)');
  assert.equal(await ev(panel, `document.querySelector('[role=dialog]').textContent.includes('medios')`), true);
  await setValue(panel, '[data-theme-import-name]', 'Invierno importado');
  await click(panel, '[data-theme-import-submit]');
  await waitDom(panel, `!!document.querySelector('[data-theme-row="invierno-importado"]') && !document.querySelector('[role=dialog]')`);
  const list = (await f.call('GET', '/api/themes')).themes;
  assert.equal(list.find(item => item.name === 'Invierno importado').active, false); assert.equal(await active(f.call), 'normal');
});

test('imported relative CSS media resolves in the real overlay and chat after a collision', { timeout: 120000 }, async t => {
  const source = await fixture(t), target = await fixture(t); if (!source || !target) return;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  for (const [f, bytes] of [[source, png], [target, Buffer.from('local collision')]]) {
    const upload = await fetch(f.base + '/api/media/upload?name=css.png', { method: 'POST', body: bytes }); assert.equal(upload.status, 200);
  }
  await source.call('PUT', '/api/config', { overlay: { css: '.alert{background-image:url(media/css.png)}' }, widgets: { chat: { css: '.msg{background-image:url(../media/css.png)}' } } });
  const exported = await fetch(source.base + '/api/themes/normal/export'); assert.equal(exported.status, 200);
  const archive = Buffer.from(await exported.arrayBuffer()).toString('base64');
  const panel = await target.open('/#/apariencia');
  await waitDom(panel, `!!document.querySelector('[data-theme-import-file]')`, { timeoutMs: 20000 });
  await ev(panel, `(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(archive)}), c => c.charCodeAt(0)); const files = new DataTransfer(); files.items.add(new File([bytes], 'tema.zip', {type:'application/zip'})); const input = document.querySelector('[data-theme-import-file]'); input.files = files.files; input.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  await waitDom(panel, `!!document.querySelector('[data-theme-import-submit]')`);
  await click(panel, '[data-theme-import-submit]');
  await waitDom(panel, `!!document.querySelector('[data-theme-row="normal-2"]') && !document.querySelector('[role=dialog]')`);
  await target.call('POST', '/api/themes/normal-2/activate');
  const overlay = await target.open('/overlay?still=follow'), chat = await target.open('/widget/chat?demo');
  for (const [page, selector] of [[overlay, '.alert.on'], [chat, '.msg']]) {
    await waitDom(page, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return !!node && getComputedStyle(node).backgroundImage.includes('/media/css-1.png'); })()`);
  }
  const copied = await fetch(target.base + '/media/css-1.png'); assert.equal(copied.status, 200); assert.deepEqual(Buffer.from(await copied.arrayBuffer()), png);
});

test('Apariencia: select without activating, activate, duplicate, edit and delete', { timeout: 120000 }, async t => {
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
  await click(c, '[data-theme-edit]'); await waitDom(c, `!!document.querySelector('[role=dialog] #theme-name') && document.querySelector('[role=dialog]').textContent.includes('Editar tema')`);
  await setValue(c, '#theme-name', 'Invierno'); await click(c, '[data-theme-submit]');
  await waitDom(c, `document.querySelector('[data-theme-preview]').textContent.includes('Invierno')`);
  await ev(c, `window.confirm = () => true`); await click(c, '[data-theme-delete]');
  await waitDom(c, `!document.body.textContent.includes('Invierno')`);
  assert.equal(await active(f.call), copy.id);
});

test('theme marker switches live on overlay and widgets; previews keep their selected id', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).theme;
  const overlay = await f.open('/overlay');
  const widget = await f.open('/widget/chat');
  const previewOverlay = await f.open(`/overlay?still=follow&previewTheme=${other.id}`);
  const previewWidget = await f.open(`/widget/chat?demo&previewTheme=${other.id}`);
  for (const c of [overlay, widget]) await waitDom(c, `document.documentElement.dataset.tema === 'normal'`);
  for (const c of [previewOverlay, previewWidget]) await waitDom(c, `document.documentElement.dataset.tema === ${JSON.stringify(other.id)}`);
  for (const c of [overlay, widget]) await ev(c, `window.__markerPageIdentity = Math.random(); true`);
  const oldIds = await Promise.all([overlay, widget].map(c => ev(c, 'window.__markerPageIdentity')));
  await f.call('POST', `/api/themes/${other.id}/activate`);
  for (const c of [overlay, widget]) await waitDom(c, `document.documentElement.dataset.tema === ${JSON.stringify(other.id)}`);
  assert.deepEqual(await Promise.all([overlay, widget].map(c => ev(c, 'window.__markerPageIdentity'))), oldIds);
  await f.call('POST', '/api/themes/normal/activate');
  for (const c of [overlay, widget]) await waitDom(c, `document.documentElement.dataset.tema === 'normal'`);
  for (const c of [previewOverlay, previewWidget]) assert.equal(await ev(c, 'document.documentElement.dataset.tema'), other.id);
});

test('theme stylesheet updates immediately when no alert is visible', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const page = await f.open('/overlay');
  await waitDom(page, `document.documentElement.dataset.tema === 'normal' && !!document.querySelector('#eg-theme')?.sheet`);
  assert.equal(await ev(page, `!!document.querySelector('.alert')`), false);
  const before = await ev(page, `document.querySelector('#eg-theme').href`);
  const changed = await f.call('PUT', '/api/theme', { accent: '#123456' });
  const version = changed.theme.version;
  await waitDom(page, `(() => { const link = document.querySelector('#eg-theme'); return !!link && link.href.includes(${JSON.stringify('v=' + version)}) && !!link.sheet && link.sheet.href === link.href; })()`);
  assert.notEqual(await ev(page, `document.querySelector('#eg-theme').href`), before);
  assert.equal(await ev(page, `!!document.querySelector('.alert')`), false);
});

test('non-follow still preview uses the selected theme, CSS and alert without activating it', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await f.call('PUT', '/api/config', { theme: { accent: '#123456', platformAccent: false }, overlay: { css: '.alert { --preview-theme: invierno; }' }, alerts: { sub: { title: 'Sub de invierno', css: '.alert { --preview-sub: elegido; }' } } });
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).theme;
  await f.call('PUT', '/api/config', { theme: { accent: '#654321' }, overlay: { css: '' }, alerts: { sub: { title: 'Sub activa', css: '' } } });
  const page = await f.open(`/overlay?still=sub&previewTheme=${other.id}`);
  await waitDom(page, `document.documentElement.dataset.tema === ${JSON.stringify(other.id)} && !!document.querySelector('.alert.on') && document.querySelector('.alert-title')?.textContent.includes('Sub de invierno')`);
  assert.equal(await ev(page, `getComputedStyle(document.querySelector('.alert')).getPropertyValue('--preview-theme').trim()`), 'invierno');
  assert.equal(await ev(page, `getComputedStyle(document.querySelector('.alert')).getPropertyValue('--preview-sub').trim()`), 'elegido');
  assert.equal(await ev(page, `getComputedStyle(document.documentElement).getPropertyValue('--red').trim().toUpperCase()`), '#123456');
  assert.equal(await active(f.call), 'normal');
});

test('visible alert keeps its marker and look until exit while a widget switches immediately', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const css = 'html[data-tema="normal"] .alert{--marker-look:normal} html[data-tema="invierno"] .alert{--marker-look:invierno}';
  await f.call('PUT', '/api/config', { theme: { accent: '#123456', platformAccent: false }, overlay: { css }, alerts: { follow: { durationMs: 30000 } } });
  const other = (await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).theme;
  await f.call('PUT', '/api/theme', { accent: '#654321' });
  const overlay = await f.open('/overlay'), widget = await f.open('/widget/chat');
  await waitDom(overlay, `document.documentElement.dataset.tema === 'normal'`);
  await waitDom(widget, `document.documentElement.dataset.tema === 'normal'`);
  const until = Date.now() + 10000;
  while (!(await f.call('GET', '/api/status')).overlays) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 25)); }
  await f.call('POST', '/api/test', { type: 'follow', target: 'live' });
  await waitDom(overlay, `!!document.querySelector('.alert.on') && getComputedStyle(document.querySelector('.alert')).getPropertyValue('--marker-look').trim() === 'normal'`);
  const oldHref = await ev(overlay, `document.querySelector('#eg-theme').href`);
  await f.call('POST', `/api/themes/${other.id}/activate`);
  await waitDom(widget, `document.documentElement.dataset.tema === ${JSON.stringify(other.id)}`);
  assert.equal(await ev(overlay, `document.documentElement.dataset.tema`), 'normal');
  assert.equal(await ev(overlay, `document.querySelector('#eg-theme').href`), oldHref);
  assert.equal(await ev(overlay, `getComputedStyle(document.querySelector('.alert')).getPropertyValue('--marker-look').trim()`), 'normal');
  await f.call('POST', '/api/skip');
  await waitDom(overlay, `document.documentElement.dataset.tema === ${JSON.stringify(other.id)} && document.querySelector('#eg-theme').href !== ${JSON.stringify(oldHref)}`);
  assert.equal(await ev(widget, `document.documentElement.dataset.tema`), other.id);
});

test('new theme from default and the ten-theme limit', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open('/#/apariencia');
  await waitDom(c, `!!document.querySelector('[data-theme-new]')`, { timeoutMs: 20000 });
  await click(c, '[data-theme-new]');
  await waitDom(c, `!!document.querySelector('#theme-origin')`);
  await click(c, '[data-theme-origin="__default"]'); await setValue(c, '#theme-name', 'Desde cero'); await click(c, '[data-theme-submit]');
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
  // The chat demo renders its messages before the theme CSS arrives; wait for the projected CSS itself.
  await waitDom(c, `(() => { const m = document.querySelector('[data-theme-chat] iframe')?.contentDocument?.querySelector('.msg'); return !!m && getComputedStyle(m).borderLeftWidth === '11px'; })()`);
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

test('avatars appear in theme list, origins, sidebar and dock', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = await fetch(f.base + '/api/media/upload?name=imagen.png', { method: 'POST', body: png });
  assert.equal(upload.status, 200); const { name: image } = await upload.json();
  const imageTheme = (await f.call('POST', '/api/themes/from-default', { name: 'Imagen', avatar: { image, color: '#AA5500' } })).theme;
  const panel = await f.open('/#/apariencia');
  await waitDom(panel, `!!document.querySelector('[data-theme-new]')`, { timeoutMs: 20000 });
  await click(panel, '[data-theme-new]');
  await waitDom(panel, `!!document.querySelector('[data-theme-avatar-color]')`);
  await setValue(panel, '#theme-name', 'Color'); await setValue(panel, '[data-theme-avatar-color]', '#123456');
  await waitDom(panel, `document.querySelector('[role=dialog] [data-theme-avatar-preview] .theme-avatar__content')?.style.background === 'rgb(18, 52, 86)'`);
  await click(panel, '[data-theme-submit]');
  await waitDom(panel, `!!document.querySelector('[data-theme-row="color"] .theme-avatar') && !document.querySelector('[role=dialog]')`);
  const colorRow = '[data-theme-row="color"] .theme-avatar__content';
  const imageRow = `[data-theme-row="${imageTheme.id}"] .theme-avatar img`;
  assert.equal(await ev(panel, `document.querySelector(${JSON.stringify(colorRow)}).style.background`), 'rgb(18, 52, 86)');
  assert.equal(await ev(panel, `document.querySelector(${JSON.stringify(imageRow)}).getAttribute('src')`), '/media/' + encodeURIComponent(image));
  await click(panel, '[data-theme-new]');
  await waitDom(panel, `!!document.querySelector('[data-theme-origin="color"] .theme-avatar') && !!document.querySelector('[data-theme-origin="${imageTheme.id}"] .theme-avatar img') && !!document.querySelector('[data-theme-origin="__default"] .theme-avatar')`);
  await click(panel, '[role=dialog] [data-theme-cancel]');
  await click(panel, '[data-theme-sidebar] summary');
  await waitDom(panel, `!!document.querySelector('[data-theme-switch="color"] .theme-avatar') && !!document.querySelector('[data-theme-switch="${imageTheme.id}"] .theme-avatar img')`);
  const dock = await f.open('/dock', 360);
  await waitDom(dock, `!!document.querySelector('[data-dock-theme-tab]')`, { timeoutMs: 20000 });
  await click(dock, '[data-dock-theme-tab]');
  await waitDom(dock, `!!document.querySelector('[data-dock-theme-switch="color"] .theme-avatar') && !!document.querySelector('[data-dock-theme-switch="${imageTheme.id}"] .theme-avatar img')`);
  await click(dock, `[data-dock-theme-switch="${imageTheme.id}"]`);
  await waitDom(dock, `!!document.querySelector('[data-dock-active-theme] .theme-avatar img')`);
  await waitDom(panel, `!!document.querySelector('[data-theme-sidebar] summary .theme-avatar img')`);
  await click(dock, '[data-dock-theme-switch="color"]');
  await waitDom(dock, `document.querySelector('[data-dock-active-theme] .theme-avatar__content')?.style.background === 'rgb(18, 52, 86)'`);
  await waitDom(panel, `document.querySelector('[data-theme-sidebar] summary .theme-avatar__content')?.style.background === 'rgb(18, 52, 86)'`);
});

test('Editar uploads the returned media name, previews and removes avatar fields', { timeout: 120000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const first = await fetch(f.base + '/api/media/upload?name=avatar.png', { method: 'POST', body: Buffer.from(png, 'base64') });
  assert.equal(first.status, 200);
  const panel = await f.open('/#/apariencia');
  await waitDom(panel, `!!document.querySelector('[data-theme-edit]')`, { timeoutMs: 20000 });
  await click(panel, '[data-theme-edit]');
  await waitDom(panel, `!!document.querySelector('[data-theme-avatar-image]')`);
  assert.equal(await ev(panel, `document.querySelector('[data-theme-avatar-image]').getAttribute('accept')`), 'image/png,image/jpeg,image/webp,image/gif');
  await ev(panel, `(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), c => c.charCodeAt(0)); const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'avatar.png', {type:'image/png'})); const input = document.querySelector('[data-theme-avatar-image]'); input.files = transfer.files; input.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
  await waitDom(panel, `!!document.querySelector('[role=dialog] .theme-avatar img') && !document.querySelector('[data-theme-submit]').disabled`);
  const src = await ev(panel, `document.querySelector('[role=dialog] .theme-avatar img').getAttribute('src')`);
  const image = decodeURIComponent(src.slice('/media/'.length)); assert.notEqual(image, 'avatar.png');
  await setValue(panel, '[data-theme-avatar-color]', '#345678');
  await click(panel, '[data-theme-submit]');
  await waitDom(panel, `!document.querySelector('[role=dialog]') && !!document.querySelector('[data-theme-row="normal"] .theme-avatar img')`);
  assert.deepEqual((await f.call('GET', '/api/themes')).themes.find(x => x.id === 'normal').avatar, { image, color: '#345678' });
  await click(panel, '[data-theme-edit]'); await waitDom(panel, `!!document.querySelector('[data-theme-avatar-remove-image]')`);
  await click(panel, '[data-theme-avatar-remove-image]'); await click(panel, '[data-theme-avatar-remove-color]'); await click(panel, '[data-theme-submit]');
  await waitDom(panel, `!document.querySelector('[role=dialog]') && !document.querySelector('[data-theme-row="normal"] .theme-avatar img')`);
  assert.equal(Object.hasOwn((await f.call('GET', '/api/themes')).themes.find(x => x.id === 'normal'), 'avatar'), false);
  assert.equal((await fetch(f.base + '/media/' + encodeURIComponent(image))).status, 200);
});

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
