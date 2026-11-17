// #182: selector experimental through the real panel, config API and simulated programs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const password = 'OBS_SELECTOR_SYNTHETIC_PASSWORD_914';
const wrong = 'OBS_SELECTOR_SYNTHETIC_WRONG_318';
const urlError = 'obs.url: se esperaba una URL ws:// o wss:// válida (sin usuario ni contraseña)';
const dom = (page, expression) => evaluateChrome(page.cdp, expression, { timeoutMs: 8000 });
const wait = (page, expression) => waitDom(page.cdp, expression, { timeoutMs: 6000 });
const radio = name => `([...document.querySelectorAll('[role="radiogroup"][aria-label="Programa de emisión"] [role="radio"]')].find(b => b.textContent.trim() === ${JSON.stringify(name)}))`;
const card = name => `[...document.querySelectorAll('.lv-conn')].find(x => x.querySelector('b')?.textContent.trim() === ${JSON.stringify(name)})`;
const saveButton = label => `Array.from(document.querySelectorAll('.lv-savebar button')).find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
const setInput = (selector, value) => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const panelBuilds = new Map();
async function buildPanel(dist, withDock = false) {
  if (!panelBuilds.has(withDock)) panelBuilds.set(withDock, build({
    ...(withDock ? { stdin: { resolveDir: fileURLToPath(new URL('../app/src/panel/', import.meta.url)), loader: 'tsx', contents: `
      import './main.tsx';
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { DockQuestions } from '../dock/DockQuestions';
      function mountDock() {
        if (!document.querySelector('#programa-emision')) return setTimeout(mountDock, 20);
        const host = document.createElement('div'); host.id = 'fixture-dock'; document.body.append(host);
        createRoot(host).render(React.createElement(DockQuestions));
      }
      mountDock();` } } : { entryPoints: [fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url))] }),
    outfile: path.join(tmpdir(), 'antena-selector-panel.js'), bundle: true, format: 'esm', minify: true, write: false,
    target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/ds/*'], logLevel: 'silent' }));
  const assets = path.join(dist, 'assets'); await mkdir(assets, { recursive: true });
  const result = await panelBuilds.get(withDock);
  await Promise.all([...result.outputFiles.map(file => writeFile(path.join(assets, 'panel' + path.extname(file.path)), file.contents)),
    writeFile(path.join(dist, 'index.html'), '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/ds/tokens.css"><link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/assets/panel.css"></head><body><div id="root"></div><script type="module" src="/assets/panel.js"></script></body></html>')]);
}

// Observe fetch responses and the panel's WebSocket/SSE messages, not only the save response.
const observePage = `(() => {
  window.__received = []; window.__requests = []; window.__pending = 0; window.__console = [];
  for (const name of Object.getOwnPropertyNames(console)) {
    if (typeof console[name] !== 'function') continue;
    const original = console[name].bind(console);
    console[name] = (...args) => {
      window.__console.push(args.map(value => { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); } }));
      return original(...args);
    };
  }
  const original = window.fetch;
  window.fetch = (...args) => {
    const url = new URL(String(args[0]), location.href);
    window.__requests.push({ path: url.pathname, method: args[1]?.method || 'GET', body: args[1]?.body || null });
    return original(...args).then(response => {
      window.__pending++;
      response.clone().text().then(text => window.__received.push({ path: url.pathname, status: response.status, text }))
        .finally(() => window.__pending--);
      return response;
    });
  };
  const WS = window.WebSocket;
  window.WebSocket = class extends WS { constructor(...args) { super(...args); this.addEventListener('message', e => {
    if (typeof e.data === 'string') window.__received.push({ path: 'websocket', text: e.data });
  }); } };
  const ES = window.EventSource;
  window.EventSource = class extends ES { addEventListener(type, listener, options) {
    super.addEventListener(type, e => { if (typeof e.data === 'string') window.__received.push({ path: 'sse', text: e.data }); }, options);
    return super.addEventListener(type, listener, options);
  } };
})()`;

async function fixture(t, { withDock = false } = {}) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH'); return null; }
  const root = await mkdtemp(path.join(tmpdir(), 'antena-selector-'));
  const obs = fakeObs({ password }), meld = fakeMeld();
  let app, page;
  t.after(() => closeAll(() => page && closeChrome(page), async () => {
    if (app) {
      await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose();
      app.program.stop(); app.meld.stop(); app.program.dispose(); await app.closeHttp();
    }
  }, () => obs.close(), () => new Promise(resolve => meld.server.close(resolve)),
  () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  await new Promise(resolve => obs.server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve));
  const dist = path.join(root, 'dist'); await buildPanel(dist, withDock);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const obsUrl = `ws://127.0.0.1:${obs.server.address().port}`;
  const api = async (method, endpoint, body) => {
    const response = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const json = await response.json(); assert.equal(response.status, 200, json.error); return json;
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true }, meld: { url: `ws://127.0.0.1:${meld.server.address().port}` } });
  page = await openChromePage(bin, 'about:blank');
  await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: observePage });
  await page.cdp.send('Page.navigate', { url: `${base}/#/conexiones` });
  await wait(page, `!!document.querySelector('[data-tour="conexiones-head"]')`);
  const choose = async name => { await clickWhen(page.cdp, radio(name), { tries: 20, ms: 100 }); };
  const input = async (selector, value) => dom(page, setInput(selector, value));
  const save = async () => { await clickWhen(page.cdp, saveButton('Guardar')); await wait(page, `!document.querySelector('.lv-savebar.is-open')`); };
  return { page, api, obsUrl, choose, input, save };
}

test('selector experimental guarda la elección y restaura la tarjeta y conexión de Meld', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl, choose, input, save } = f;
  await wait(page, `!!${radio('Meld')} && !!${radio('OBS')}`);
  assert.match(await dom(page, `document.querySelector('#programa-emision').textContent`), /Programa de emisión.*Experimental/s);
  assert.equal(await dom(page, `${radio('Meld')}.getAttribute('aria-checked')`), 'true');
  assert.equal(await dom(page, `!!document.querySelector('#obs-url') || !!document.querySelector('#obs-password')`), false);
  assert.equal((await api('GET', '/api/config')).program.kind, 'meld');
  assert.ok(await dom(page, `!!(${card('Meld Studio')})`));
  await clickWhen(page.cdp, `(${card('Meld Studio')}).querySelector('button')`);
  await wait(page, `/Conectado/i.test((${card('Meld Studio')}).textContent)`);
  await choose('OBS');
  await wait(page, `!!document.querySelector('#obs-url') && !!document.querySelector('#obs-password')`);
  assert.equal((await api('GET', '/api/config')).program.kind, 'meld');
  await input('#obs-url', obsUrl); await save();
  assert.equal((await api('GET', '/api/config')).program.kind, 'obs');
  await wait(page, `!!(${card('OBS Studio')}) && /Contraseña de OBS incorrecta\./.test((${card('OBS Studio')}).textContent)`);
  assert.match(await dom(page, `(${card('OBS Studio')}).textContent`), /Error/);
  assert.equal(await dom(page, `!!(${card('Meld Studio')})`), false);
  await choose('Meld'); await save();
  assert.equal((await api('GET', '/api/config')).program.kind, 'meld');
  await wait(page, `!!(${card('Meld Studio')}) && !document.querySelector('#obs-url')`);
  assert.equal(await dom(page, `!!document.querySelector('#obs-password')`), false);
  await clickWhen(page.cdp, `(${card('Meld Studio')}).querySelector('button')`);
  await wait(page, `/Conectado/i.test((${card('Meld Studio')}).textContent)`);
});

test('al volver de OBS inaccesible Meld no muestra el error anterior', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, choose, input, save } = f;
  await api('PUT', '/api/config', { meld: { enabled: false } });
  await choose('OBS'); await wait(page, `!!document.querySelector('#obs-url')`);
  await input('#obs-url', 'ws://127.0.0.1:1'); await save();
  await wait(page, `!!(${card('OBS Studio')}) && /No se puede conectar con OBS/.test((${card('OBS Studio')}).textContent)`);
  await choose('Meld'); await save();
  await wait(page, `!!(${card('Meld Studio')})`);
  const status = await api('GET', '/api/status');
  assert.equal(status.meld.state, 'desconectado');
  assert.equal(status.meld.error, null);
  assert.doesNotMatch(await dom(page, `(${card('Meld Studio')}).textContent`), /No se puede conectar con OBS/);
});

test('URL inválida muestra el 400 exacto y no guarda ni programa ni contraseña', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl, choose, input, save } = f;
  await api('PUT', '/api/config', { obs: { password } });
  await wait(page, `!!${radio('OBS')}`);
  const before = await api('GET', '/api/config');
  const counters = (await api('GET', '/api/status')).persistence;
  await choose('OBS'); await wait(page, `!!document.querySelector('#obs-url')`);
  await input('#obs-url', 'https://invalid'); await input('#obs-password', wrong);
  await clickWhen(page.cdp, saveButton('Guardar'));
  await wait(page, `document.querySelector('.toast')?.textContent === ${JSON.stringify(urlError)}`);
  await wait(page, `window.__received.some(r => r.path === '/api/config' && r.status === 400)`);
  assert.deepEqual(await dom(page, `JSON.parse(window.__received.find(r => r.path === '/api/config' && r.status === 400).text)`), { error: urlError });
  assert.deepEqual(await api('GET', '/api/config'), before);
  assert.deepEqual((await api('GET', '/api/status')).persistence, counters);
  assert.equal(await dom(page, `!!document.querySelector('.lv-savebar.is-open')`), true);
  await clickWhen(page.cdp, saveButton('Descartar'));
  await wait(page, `${radio('Meld')}.getAttribute('aria-checked') === 'true' && !document.querySelector('#obs-password')`);
  assert.equal((await api('GET', '/api/config')).obs.passwordSet, true);
  // The previously stored value, not merely the masked indicator, still authenticates.
  await choose('OBS'); await wait(page, `!!document.querySelector('#obs-url')`);
  await input('#obs-url', obsUrl); await save();
  await wait(page, `!!(${card('OBS Studio')}) && /Conectado/i.test((${card('OBS Studio')}).textContent)`);
});

test('contraseña es de solo escritura, se puede cambiar y borrar sin filtrarla', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl, choose, input, save } = f;
  await wait(page, `!!${radio('OBS')}`); await choose('OBS');
  await wait(page, `!!document.querySelector('#obs-password')`);
  const assertNoLeaks = async () => {
    const observed = await dom(page, `({ html: document.documentElement.outerHTML, logs: window.__console,
      local: Object.entries(localStorage), session: Object.entries(sessionStorage) })`);
    for (const secret of [password, wrong]) for (const [name, value] of Object.entries(observed))
      assert.equal(JSON.stringify(value).includes(secret), false, `contraseña ausente de ${name}`);
  };
  await dom(page, `console.debug('selector-observer-probe'); localStorage.setItem('selector-probe', 'local'); sessionStorage.setItem('selector-probe', 'session')`);
  assert.equal(await dom(page, `window.__console.some(args => args.includes('selector-observer-probe'))`), true);
  assert.equal(await dom(page, `localStorage.getItem('selector-probe') + '/' + sessionStorage.getItem('selector-probe')`), 'local/session');
  await input('#obs-url', obsUrl); await input('#obs-password', password);
  await assertNoLeaks();
  await save();
  await wait(page, `!!(${card('OBS Studio')}) && /Conectado/i.test((${card('OBS Studio')}).textContent)`);
  assert.equal((await api('GET', '/api/config')).obs.passwordSet, true);
  assert.equal(await dom(page, `document.querySelector('#obs-password').value`), '');
  assert.match(await dom(page, `document.querySelector('#programa-emision').textContent`), /Contraseña guardada/);
  await input('#obs-password', wrong); await assertNoLeaks(); await save();
  await wait(page, `/Contraseña de OBS incorrecta\./.test((${card('OBS Studio')}).textContent)`);
  assert.equal(await dom(page, `document.querySelector('#obs-password').value`), '');
  await input('#obs-password', password); await assertNoLeaks(); await save();
  await wait(page, `/Conectado/i.test((${card('OBS Studio')}).textContent)`);
  await clickWhen(page.cdp, `Array.from(document.querySelectorAll('#programa-emision button')).find(b => b.textContent.trim() === 'Quitar contraseña')`);
  await save();
  await wait(page, `/Contraseña de OBS incorrecta\./.test((${card('OBS Studio')}).textContent)`);
  assert.equal((await api('GET', '/api/config')).obs.passwordSet, false);
  assert.equal(await dom(page, `document.querySelector('#obs-password').value`), '');
  assert.doesNotMatch(await dom(page, `document.querySelector('#programa-emision').textContent`), /Contraseña guardada/);
  await wait(page, `window.__pending === 0 && window.__received.some(r => r.path === 'websocket')`);
  await assertNoLeaks();
  const traffic = await dom(page, `({ received: window.__received, requests: window.__requests })`);
  for (const secret of [password, wrong]) {
    assert.equal(JSON.stringify(traffic.received).includes(secret), false, 'ninguna respuesta o evento devuelve la contraseña');
    assert.equal(await dom(page, `document.documentElement.outerHTML.includes(${JSON.stringify(secret)})`), false);
  }
  const writes = traffic.requests.filter(r => r.path === '/api/config' && r.method === 'PUT').map(r => JSON.parse(r.body));
  assert.ok(writes.some(body => body.obs?.password === password));
  assert.ok(writes.some(body => body.obs?.password === wrong));
  assert.ok(writes.some(body => body.obs?.password === ''));
  await dom(page, `window.__beforeReload = true`); await page.cdp.send('Page.reload');
  await wait(page, `!window.__beforeReload && !!document.querySelector('#obs-password') && ${radio('OBS')}?.getAttribute('aria-checked') === 'true'`);
  assert.equal(await dom(page, `document.querySelector('#obs-password').value`), '');
});

test('vaciar el campo no cambia la contraseña; solo Quitar contraseña la borra', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl, choose, input, save } = f;
  await api('PUT', '/api/config', { obs: { password } });
  await choose('OBS'); await wait(page, `!!document.querySelector('#obs-password')`);
  await input('#obs-url', obsUrl); await save();
  await wait(page, `!!(${card('OBS Studio')}) && /Conectado/i.test((${card('OBS Studio')}).textContent)`);
  await input('#obs-password', 'x'); await input('#obs-password', '');
  const before = await dom(page, `window.__requests.length`);
  await save();
  assert.equal((await api('GET', '/api/config')).obs.passwordSet, true);
  const writes = await dom(page, `window.__requests.slice(${before}).filter(r => r.path === '/api/config' && r.method === 'PUT').map(r => JSON.parse(r.body))`);
  assert.ok(writes.every(body => !Object.hasOwn(body.obs || {}, 'password')), 'no se envía contraseña vacía');
  await clickWhen(page.cdp, `Array.from(document.querySelectorAll('#programa-emision button')).find(b => b.textContent.trim() === 'Quitar contraseña')`);
  await save();
  assert.equal((await api('GET', '/api/config')).obs.passwordSet, false);
});

test('la conexión de Meld no vuelve a pedir config durante los eventos de estado', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page } = f;
  await wait(page, `!!(${card('Meld Studio')}) && window.__pending === 0`);
  await new Promise(resolve => setTimeout(resolve, 700));
  const before = await dom(page, `({ gets: window.__requests.filter(r => r.path === '/api/config' && r.method === 'GET').length,
    events: window.__received.filter(r => r.path === 'websocket' && r.text.startsWith('event: status\\n')).length })`);
  await clickWhen(page.cdp, `(${card('Meld Studio')}).querySelector('button')`);
  await wait(page, `/Conectado/i.test((${card('Meld Studio')}).textContent)`);
  await new Promise(resolve => setTimeout(resolve, 700));
  const after = await dom(page, `({ gets: window.__requests.filter(r => r.path === '/api/config' && r.method === 'GET').length,
    events: window.__received.filter(r => r.path === 'websocket' && r.text.startsWith('event: status\\n')).length })`);
  assert.ok(after.events > before.events, 'la conexión produjo eventos de estado');
  assert.equal(after.gets - before.gets, 0, 'el estado no debe volver a pedir config');
});

test('un ajuste ajeno se autoguarda mientras Programa de emisión tiene un borrador', { timeout: 60000 }, async t => {
  const f = await fixture(t, { withDock: true }); if (!f) return;
  const { page, api, choose, save } = f;
  await wait(page, `!!document.querySelector('#fixture-dock [aria-label="Preguntas del chat"]')`);
  const before = (await api('GET', '/api/state')).interactive.config.questions.enabled;
  await choose('OBS');
  await wait(page, `!!document.querySelector('.lv-savebar.is-open')`);
  await clickWhen(page.cdp, `document.querySelector('#fixture-dock [aria-label="Preguntas del chat"]')`);
  await wait(page, `window.__received.some(r => r.path === '/api/interactive/config' && r.status === 200)`);
  assert.equal((await api('GET', '/api/state')).interactive.config.questions.enabled, !before);
  assert.equal((await api('GET', '/api/config')).program.kind, 'meld', 'el selector sigue en borrador');
  await save();
  assert.equal((await api('GET', '/api/config')).program.kind, 'obs');
});

test('el estado corresponde al programa activo aunque se edite durante un guardado', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl, choose, input, save } = f;
  await wait(page, `!!${radio('OBS')}`); await choose('OBS');
  await wait(page, `!!document.querySelector('#obs-url')`); await input('#obs-url', obsUrl);
  await dom(page, `(() => { const original = window.__unheldFetch = window.fetch; window.fetch = (...args) => original(...args).then(response => {
    if (args[1]?.method === 'PUT' && new URL(String(args[0]), location.href).pathname === '/api/config') {
      return new Promise(resolve => { window.__saveHeld = true; window.__releaseSave = () => resolve(response); });
    } return response;
  }); })()`);
  await clickWhen(page.cdp, saveButton('Guardar'));
  await wait(page, `window.__saveHeld === true`);
  assert.equal((await api('GET', '/api/config')).program.kind, 'obs');
  await choose('Meld');
  assert.equal(await dom(page, `!!(${card('Meld Studio')})`), true);
  assert.equal(await dom(page, `(${card('Meld Studio')}).querySelector('button').disabled`), true);
  await dom(page, `window.__releaseSave()`);
  await wait(page, `!!(${card('Meld Studio')}) && (${card('Meld Studio')}).querySelector('button').disabled`);
  assert.equal((await api('GET', '/api/status')).program.kind, 'obs');
  assert.doesNotMatch(await dom(page, `(${card('Meld Studio')}).textContent`), /Contraseña de OBS incorrecta/);
  assert.equal(await dom(page, `${radio('Meld')}.getAttribute('aria-checked')`), 'true');
  // Restore the observer so a second save can complete.
  await dom(page, `window.fetch = window.__unheldFetch`);
  await save();
  assert.equal((await api('GET', '/api/config')).program.kind, 'meld');
  await wait(page, `!!(${card('Meld Studio')})`);
});

test('un cambio de programa desde otra interfaz actualiza el selector y el estado', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl } = f;
  await wait(page, `!!${radio('Meld')}`);
  await api('PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: obsUrl, password } });
  await wait(page, `!!(${card('OBS Studio')}) && /Conectado/i.test((${card('OBS Studio')}).textContent)`);
  await wait(page, `${radio('OBS')}.getAttribute('aria-checked') === 'true' && !!document.querySelector('#obs-password')`);
  assert.equal(await dom(page, `document.querySelector('#obs-password').value`), '');
  assert.match(await dom(page, `document.querySelector('#programa-emision').textContent`), /Contraseña guardada/);
  await api('PUT', '/api/config', { program: { kind: 'meld' } });
  await wait(page, `!!(${card('Meld Studio')}) && ${radio('Meld')}.getAttribute('aria-checked') === 'true' && !document.querySelector('#obs-url')`);
});

test('los ajustes de Twitch y YouTube siguen guardándose solo al confirmar', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, input, save } = f;
  for (const [service, field, section, key, value] of [
    ['twitch', '#twitch input', 'twitch', 'clientId', 'cliente-sintetico'],
    ['youtube', '#youtube input[placeholder="UC…"]', 'youtube', 'channelId', 'UCsintetico'],
  ]) {
    const before = (await api('GET', '/api/config'))[section][key] || '';
    await clickWhen(page.cdp, `document.querySelector('a[href="#/conexiones/${service}"]')`);
    await wait(page, `!!document.querySelector(${JSON.stringify(field)})`);
    await input(field, value);
    await wait(page, `!!document.querySelector('.lv-savebar.is-open')`);
    assert.equal((await api('GET', '/api/config'))[section][key] || '', before);
    await save();
    assert.equal((await api('GET', '/api/config'))[section][key], value);
    await clickWhen(page.cdp, `document.querySelector('.lv-slide a[aria-label="Volver"]')`);
    await wait(page, `!document.querySelector('.lv-drawer')`);
  }
});

test('descartar mantiene el programa y la contraseña guardados', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const { page, api, obsUrl, choose, input, save } = f;
  await wait(page, `!!${radio('OBS')}`); await choose('OBS');
  await wait(page, `!!document.querySelector('#obs-password')`);
  await input('#obs-url', obsUrl); await input('#obs-password', password); await save();
  await wait(page, `/Conectado/i.test((${card('OBS Studio')}).textContent)`);
  await input('#obs-password', wrong);
  await clickWhen(page.cdp, saveButton('Descartar'));
  await wait(page, `document.querySelector('#obs-password').value === '' && !document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await api('GET', '/api/config')).obs.passwordSet, true);
  assert.match(await dom(page, `document.querySelector('#programa-emision').textContent`), /Contraseña guardada/);
  assert.match(await dom(page, `(${card('OBS Studio')}).textContent`), /Conectado/i);
});
