// S6/S9: exercise the built React panel, the public HTTP API and the actual widget iframe.
// Each test owns an isolated server and Chrome profile; no production config or mock panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { CHAT_ANIMS } from '../public/widgets/chat-anims.js';

const route = '/api/widgets/chat/variants';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = x => JSON.stringify(x);
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const label = text => `Array.from(document.querySelectorAll('main label')).find(l => l.textContent.trim().startsWith(${q(text)}))`;
const field = text => `${label(text)}?.querySelector('input,select,textarea')`;
const button = text => `Array.from(document.querySelectorAll('main button')).find(b => b.textContent.trim() === ${q(text)})`;
const selected = field('Variante de chat');
const frame = `document.querySelector('main .preview-col iframe')`;

async function fixture(t) {
  await access(new URL('../app/dist/index.html', import.meta.url)); // absence is failure, never a source fallback/skip
  const bin = await findChrome();
  assert.ok(bin, 'Chrome is required for the real panel test');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-panel-variants-'));
  let app, chrome;
  t.after(async () => {
    await closeAll(() => chrome && closeChrome(chrome), async () => {
      if (app) {
        app.teleprompter.stop(); app.viewers.stop(); app.meld.stop(); app.timers.stop();
        app.engine.flushScheduledSends(); app.server.closeAllConnections();
        await new Promise(resolve => app.server.close(resolve));
      }
    }, () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const port = app.server.address().port;
  assert.notEqual(port, 4500);
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const ok = async (method, url, body) => {
    const r = await request(method, url, body); assert.equal(r.status, 200, `${method} ${url}: ${JSON.stringify(r.body)}`); return r.body;
  };
  const open = async () => {
    // Use the public config API to complete onboarding in this isolated fixture; otherwise the
    // welcome dialog obscures the editor and screenshots even though DOM .click() can reach it.
    await ok('PUT', '/api/config', { panel: { onboardingDone: true } });
    chrome = await openChromePage(bin, `${base}/#/widgets/chat`);
    const c = chrome.cdp;
    await waitDom(c, `!!(${field('Tamaño de letra')})`, { timeoutMs: 15000 });
    await dom(c, `(() => {
      window.__requests = []; window.__copied = []; window.__confirms = []; window.__confirmAnswer = true;
      const original = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const response = await original(url, options);
        if (String(url).startsWith('/api/widgets') && options.method && options.method !== 'GET')
          window.__requests.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null, status: response.status });
        return response;
      };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: value => { window.__copied.push(value); return Promise.resolve(); } } });
      window.confirm = message => { window.__confirms.push(message); return window.__confirmAnswer; };
      return true;
    })()`);
    // Wait a short bounded interval so RED identifies the absent selector rather than an unrelated panel load.
    await waitDom(c, `!!(${selected}) && !(${selected}).disabled`, { timeoutMs: 4000 });
    return c;
  };
  return { base, ok, request, open };
}

async function setValue(c, name, value) {
  await dom(c, `(() => {
    const el = ${field(name)}; if (!el) throw Error('missing field');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(String(value))});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true;
  })()`);
}
async function check(c, name, value) {
  await dom(c, `(() => { const el = ${field(name)}; if (!el) throw Error('missing check'); if (el.checked !== ${value}) el.click(); return true; })()`);
}
async function click(c, name) {
  await waitDom(c, `!!(${button(name)}) && !(${button(name)}).disabled`, { timeoutMs: 6000 });
  await dom(c, `${button(name)}.click()`);
}
async function choose(c, id) {
  await setValue(c, 'Variante de chat', id);
  await waitDom(c, `${selected}?.value === ${q(id)} && !(${selected}).disabled`, { timeoutMs: 10000 });
}
async function save(c) {
  await click(c, 'Guardar');
  await waitDom(c, `document.querySelector('.lv-savebar')?.textContent.includes('Todo guardado')`, { timeoutMs: 10000 });
}
async function screenshot(c, name) {
  if (!process.env.ANTENA_CHAT_PANEL_ARTIFACTS) return;
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(process.env.ANTENA_CHAT_PANEL_ARTIFACTS, name), Buffer.from(data, 'base64'));
}

const baseline = {
  platforms: ['youtube'], maxMessages: 17, fadeAfterSec: 12, fontSize: 32,
  hideCommands: false, hideOwner: false, showPlatform: false, reverse: true,
  animIn: 'bounce', animOut: 'zoom', layout: 'vertical', css: '.msg { color: red; }',
};

test('panel creates a saved-default snapshot, edits one variant manually and previews its exact URL', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await f.ok('PUT', '/api/widgets', { chat: baseline });
  const c = await f.open();
  assert.equal(await dom(c, `${selected}.value`), 'default');
  assert.equal(await dom(c, `!!(${button('Borrar variante…')})`), false, 'the default has no delete action');
  assert.equal(await dom(c, `!!(${button('Renombrar')})`), false, 'the default cannot be renamed');
  assert.equal(await dom(c, `document.querySelector('main .browser-source code').textContent`), f.base + '/widget/chat');
  assert.equal(await dom(c, `${frame}.getAttribute('src')`), '/widget/chat?demo');
  assert.equal(await dom(c, `document.querySelector('main .browser-source .overlay-url .hint').textContent`), '600×900');
  assert.deepEqual(await dom(c, `[${frame}.style.width, ${frame}.style.height]`), ['600px', '900px']);
  // A new variant must never copy an unsaved default draft.
  await setValue(c, 'Tamaño de letra', 38);
  assert.equal(await dom(c, `${selected}.disabled`), true);
  assert.equal(await dom(c, `${button('+ Nueva variante')}.disabled`), true);
  await dom(c, `${button('+ Nueva variante')}.click()`);
  assert.deepEqual(await f.ok('GET', route), []);
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, baseline);
  await click(c, 'Descartar');
  assert.equal(await dom(c, `${field('Tamaño de letra')}.value`), '32');
  await click(c, '+ Nueva variante');
  await setValue(c, 'Nombre de la variante', '   ');
  await click(c, 'Crear variante');
  assert.equal(await dom(c, `document.querySelector('[role="alert"]')?.textContent`), 'La variante necesita un nombre');
  assert.deepEqual(await f.ok('GET', route), []);
  assert.equal(await dom(c, `window.__requests.filter(r => r.method === 'POST').length`), 0);
  await setValue(c, 'Nombre de la variante', 'Programa');
  await click(c, 'Crear variante');
  await waitDom(c, `${selected}?.value === 'programa' && !(${selected}).disabled`, { timeoutMs: 10000 });
  assert.deepEqual(await f.ok('GET', route), [{ ...baseline, id: 'programa', name: 'Programa' }]);
  assert.deepEqual((await dom(c, `window.__requests.filter(r => r.method === 'POST')`)).at(-1), { url: route, method: 'POST', body: { name: 'Programa' }, status: 200 });
  assert.equal(await dom(c, `document.querySelector('main .browser-source code').textContent`), f.base + '/widget/chat?variant=programa');
  assert.equal(await dom(c, `${frame}.getAttribute('src')`), '/widget/chat?variant=programa&demo');
  await dom(c, `document.querySelector('main .browser-source .overlay-url button').click()`);
  await waitDom(c, `window.__copied.length === 1`);
  assert.equal(await dom(c, `window.__copied[0]`), f.base + '/widget/chat?variant=programa');
  for (const name of ['Animación de entrada', 'Animación al desaparecer']) {
    assert.deepEqual(await dom(c, `Array.from(${field(name)}.options, o => o.value)`), [...CHAT_ANIMS]);
  }
  await setValue(c, 'Disposición', 'horizontal');
  assert.ok(await dom(c, `Array.from(document.querySelectorAll('main label')).some(l => l.textContent.includes('mensajes nuevos aparecen a la izquierda'))`));
  assert.equal(await dom(c, `document.querySelector('main .browser-source .overlay-url .hint').textContent`), '600×900', 'draft does not change the saved preview size');
  await setValue(c, 'Mensajes en pantalla', 7);
  await setValue(c, 'Tamaño de letra', 41);
  await setValue(c, 'Desaparecen tras', 5);
  await check(c, 'Twitch', true); await check(c, 'YouTube', false);
  await check(c, 'Ocultar los comandos', true);
  await check(c, 'Ocultar mis mensajes', true);
  await check(c, 'Mostrar el icono', true);
  await check(c, 'Chat invertido', false);
  await setValue(c, 'Animación de entrada', 'flip'); await setValue(c, 'Animación al desaparecer', 'fade');
  await setValue(c, 'CSS personalizado', '.msg { color: lime; }');
  assert.deepEqual(await f.ok('GET', route), [{ ...baseline, id: 'programa', name: 'Programa' }], 'no autosave');
  await save(c);
  const expected = { ...baseline, id: 'programa', name: 'Programa', layout: 'horizontal', maxMessages: 7, fontSize: 41, fadeAfterSec: 5,
    platforms: ['twitch'], hideCommands: true, hideOwner: true, showPlatform: true, reverse: false, animIn: 'flip', animOut: 'fade', css: '.msg { color: lime; }' };
  assert.deepEqual(await f.ok('GET', route), [expected]);
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, baseline, 'default untouched');
  const writes = await dom(c, `window.__requests.filter(r => r.method === 'PUT')`);
  assert.equal(writes.length, 1); assert.equal(writes[0].url, route + '/programa'); assert.equal(writes[0].status, 200);
  assert.equal(Object.hasOwn(writes[0].body, 'id'), false);
  await waitDom(c, `${frame}?.contentDocument?.getElementById('root')?.style.getPropertyValue('--fs') === '41px'`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `document.querySelector('main .browser-source .overlay-url .hint').textContent`), '1832×160', 'horizontal Meld source recommendation');
  assert.deepEqual(await dom(c, `[${frame}.style.width, ${frame}.style.height]`), ['1832px', '160px'], 'horizontal preview displays a row');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await dom(c, `document.querySelector('.lv-slide').scrollTo(0, 0)`);
  await sleep(200); await screenshot(c, 'panel-desktop-top.png');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await dom(c, `document.querySelector('.lv-slide').scrollTo(0, 0)`);
  await sleep(200); await screenshot(c, 'panel-narrow-top.png');
  await c.send('Emulation.clearDeviceMetricsOverride');
  await choose(c, 'default');
  assert.equal(await dom(c, `${field('Tamaño de letra')}.value`), '32');
  assert.equal(await dom(c, `document.querySelector('main .browser-source .overlay-url .hint').textContent`), '600×900');
  assert.deepEqual(await dom(c, `[${frame}.style.width, ${frame}.style.height]`), ['600px', '900px']);
  await choose(c, 'programa');
  assert.equal(await dom(c, `${field('Tamaño de letra')}.value`), '41');
  await dom(c, `location.reload()`);
  await waitDom(c, `!!(${selected}) && !(${selected}).disabled`, { timeoutMs: 15000 });
  await choose(c, 'programa');
  assert.equal(await dom(c, `${field('Disposición')}.value`), 'horizontal');
  assert.equal(await dom(c, `${field('CSS personalizado')}.value`), expected.css);
});

test('panel renames without changing URL and confirms deletion of only the chosen variant', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const a = (await f.ok('POST', route, { name: 'Primera' })).variant;
  const b = (await f.ok('POST', route, { name: 'Segunda' })).variant;
  const initialDefault = (await f.ok('GET', '/api/widgets')).widgets.chat;
  const c = await f.open();
  await choose(c, a.id);
  await click(c, 'Renombrar');
  await setValue(c, 'Nombre de la variante', 'Renombrada');
  await click(c, 'Guardar nombre');
  await waitDom(c, `${selected}?.selectedOptions[0]?.textContent.includes('Renombrada')`, { timeoutMs: 10000 });
  assert.equal(await dom(c, `document.querySelector('main .browser-source code').textContent`), f.base + '/widget/chat?variant=primera');
  assert.deepEqual(await f.ok('GET', route), [{ ...a, name: 'Renombrada' }, b]);
  assert.deepEqual((await dom(c, `window.__requests.filter(r => r.method === 'PUT')`)).at(-1), { url: route + '/primera', method: 'PUT', body: { name: 'Renombrada' }, status: 200 });
  await dom(c, `window.__confirmAnswer = false`);
  await click(c, 'Borrar variante…');
  assert.deepEqual(await f.ok('GET', route), [{ ...a, name: 'Renombrada' }, b]);
  assert.equal(await dom(c, `window.__confirms.at(-1)`), '¿Borrar «Renombrada»?');
  assert.equal(await dom(c, `window.__requests.filter(r => r.method === 'DELETE').length`), 0);
  await dom(c, `window.__confirmAnswer = true`);
  await click(c, 'Borrar variante…');
  await waitDom(c, `${selected}?.value === 'default' && !(${selected}).disabled`, { timeoutMs: 10000 });
  assert.deepEqual(await f.ok('GET', route), [b]);
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, initialDefault);
  assert.deepEqual((await dom(c, `window.__requests.filter(r => r.method === 'DELETE')`)).at(-1), { url: route + '/primera', method: 'DELETE', body: null, status: 200 });
  await choose(c, b.id);
  assert.equal(await dom(c, `${field('Tamaño de letra')}.value`), String(b.fontSize));
});

test('dirty selection and CRUD are blocked; failed save keeps the draft and server unchanged', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const a = (await f.ok('POST', route, { name: 'Primera' })).variant;
  const b = (await f.ok('POST', route, { name: 'Segunda' })).variant;
  const c = await f.open();
  await choose(c, a.id);
  await sleep(400);
  const before = (await f.ok('GET', '/api/widgets')).widgets;
  const counters = (await f.ok('GET', '/api/status')).persistence;
  await setValue(c, 'Mensajes en pantalla', 0); // variant API rejects this value
  assert.equal(await dom(c, `${selected}.disabled`), true);
  for (const name of ['+ Nueva variante', 'Renombrar', 'Borrar variante…']) {
    assert.equal(await dom(c, `${button(name)}.disabled`), true, name);
    await dom(c, `${button(name)}.click()`);
  }
  assert.equal(await dom(c, `window.__requests.filter(r => r.method === 'POST' || r.method === 'DELETE').length`), 0);
  assert.match(await dom(c, `document.querySelector('main').textContent`), /Guarda o descarta/);
  await click(c, 'Guardar');
  await waitDom(c, `window.__requests.some(r => r.method === 'PUT' && r.status === 400)`, { timeoutMs: 10000 });
  await waitDom(c, `document.querySelector('.toast')?.textContent.includes('maxMessages')`, { timeoutMs: 5000 });
  assert.equal(await dom(c, `${field('Mensajes en pantalla')}.value`), '0');
  assert.equal(await dom(c, `${selected}.value`), a.id);
  assert.equal(await dom(c, `${selected}.disabled`), true);
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets, before);
  assert.deepEqual((await f.ok('GET', '/api/status')).persistence, counters);
  await setValue(c, 'Mensajes en pantalla', 9);
  await save(c);
  assert.equal((await f.ok('GET', route))[0].maxMessages, 9);
  assert.deepEqual((await f.ok('GET', route))[1], b);
  await choose(c, b.id);
  assert.equal(await dom(c, `${field('Mensajes en pantalla')}.value`), String(b.maxMessages));
});

test('default horizontal preview changes size only after saving and keeps the default URL', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const c = await f.open();
  await setValue(c, 'Disposición', 'horizontal');
  assert.equal(await dom(c, `document.querySelector('main .browser-source .overlay-url .hint').textContent`), '600×900');
  assert.equal((await f.ok('GET', '/api/widgets')).widgets.chat.layout, 'vertical');
  await save(c);
  assert.equal((await f.ok('GET', '/api/widgets')).widgets.chat.layout, 'horizontal');
  assert.equal(await dom(c, `${frame}.getAttribute('src')`), '/widget/chat?demo');
  try {
    await waitDom(c, `document.querySelector('main .browser-source .overlay-url .hint')?.textContent === '1832×160'`, { timeoutMs: 8000 });
  } catch (error) {
    // Keep the original timeout and error, but capture the actual preview when it fails in CI.
    const actual = await evaluateChrome(c, `(() => { const f = ${frame}; return {
      hint: document.querySelector('main .browser-source .overlay-url .hint')?.textContent ?? null,
      src: f?.getAttribute('src') ?? null, width: f?.style.width ?? null, height: f?.style.height ?? null,
    }; })()`, { timeoutMs: 1000 }).catch(() => null);
    error.message += `; actual preview: ${JSON.stringify(actual)}`;
    throw error;
  }
  assert.deepEqual(await dom(c, `[${frame}.style.width, ${frame}.style.height]`), ['1832px', '160px']);
});

test('selection loads fresh variant settings after an external update', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', route, { name: 'Externa' })).variant;
  const c = await f.open();
  await f.ok('PUT', `${route}/${v.id}`, { fontSize: 39, css: '.msg { color: cyan; }' });
  await choose(c, v.id);
  assert.equal(await dom(c, `${field('Tamaño de letra')}.value`), '39');
  assert.equal(await dom(c, `${field('CSS personalizado')}.value`), '.msg { color: cyan; }');
  assert.equal(await dom(c, `document.querySelector('main .browser-source code').textContent`), f.base + '/widget/chat?variant=externa');
  await f.ok('PUT', `${route}/${v.id}`, { fontSize: 47 });
  await waitDom(c, `${field('Tamaño de letra')}?.value === '47'`, { timeoutMs: 10000 });
});
