// #158: prueba el dock compilado contra Meld simulado, sin conexiones a plataformas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { findChrome, closeChrome, openChromePage, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

function frame(message) {
  const data = Buffer.from(JSON.stringify(message));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}
function streamFake() {
  const meld = fakeMeld({}); let socket;
  meld.server.prependListener('upgrade', (_req, sock) => { socket = sock; });
  return { ...meld, report(value) { socket.write(frame({ type: 2, data: [{ object: 'meld', properties: { 2: value } }] })); } };
}
function nextWhere(emitter, event, predicate) {
  return new Promise(resolve => {
    const on = value => { if (predicate(value)) { emitter.off(event, on); resolve(value); } };
    emitter.on(event, on);
  });
}
const dom = (chrome, expression) => evaluateChrome(chrome.cdp, expression, { timeoutMs: 12000 });
const calls = meld => meld.state.calls.filter(c => c[0] === 12);
const button = text => buttonByText(text);
const card = `document.querySelector('[aria-label="Control de emisión"]')`;
const dialog = `document.querySelector('dialog[open]')`;
const counter = platform => `${card}.querySelector('[data-platform="${platform}"]')`;

async function start(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH'); return null; }
  // Si hay Chrome, un build ausente es un fallo y no un skip silencioso.
  await stat(new URL('../app/dist/index.html', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'dock-stream-control-'));
  const meld = streamFake(); let app;
  t.after(async () => {
    if (app) {
      await app.drainAutoSession().catch(() => {});
      await app.session.flush().catch(() => {});
      app.meld.stop();
      await app.closeHttp().catch(() => {});
    }
    await new Promise(resolve => meld.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json();
    assert.equal(r.ok, true, data.error || `${method} ${url}`);
    return data;
  };
  const ready = nextWhere(app.meld, 'status', s => s.state === 'conectado');
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
  await ready;
  const report = async value => {
    const changed = nextWhere(app.meld, 'status', s => s.state === 'conectado' && s.streaming === value);
    meld.report(value); await changed;
  };
  const open = async () => {
    const chrome = await openChromePage(bin, 'about:blank');
    t.after(() => closeChrome(chrome));
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 1, mobile: false });
    // El deadline de 20 s se captura e invoca a mano: la prueba nunca espera ese intervalo real.
    await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const realSet = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
      let callback = null; const fakeId = 2147483000;
      window.setTimeout = (fn, ms, ...args) => ms === 20000 ? (callback = () => fn(...args), fakeId) : realSet(fn, ms, ...args);
      window.clearTimeout = id => { if (id === fakeId) callback = null; else realClear(id); };
      window.__expireStream = () => { const fn = callback; callback = null; if (fn) fn(); return !!fn; };
      window.__hasStreamDeadline = () => !!callback;
      window.__streamResponses = 0; const realFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => realFetch(url, opts).then(response => {
        if (String(url).includes('/api/meld/stream')) window.__streamResponses++;
        return response;
      });
    })();` });
    await chrome.cdp.send('Page.navigate', { url: `${base}/dock` });
    await waitDom(chrome.cdp, `!!document.querySelector('.dock')`, { timeoutMs: 20000 });
    assert.equal(await dom(chrome, `!!${card}`), true, 'el dock incluye el control de emisión');
    return chrome;
  };
  return { app, meld, api, open, report };
}

async function openConfirmation(chrome, text) {
  await clickWhen(chrome.cdp, button(text));
  await waitDom(chrome.cdp, `!!${dialog}`);
}
async function confirm(chrome) {
  await clickWhen(chrome.cdp, `${dialog}.querySelector('[data-confirm-stream]')`);
}

test('iniciar requiere confirmación explícita; cancelar o Escape no envía nada', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  const chrome = await f.open();
  await openConfirmation(chrome, 'Iniciar directo');
  assert.match(await dom(chrome, `${dialog}.textContent`), /emisi[oó]n.*p[uú]blic/i);
  assert.equal(await dom(chrome, `document.activeElement?.textContent.trim()`), 'Cancelar');
  await clickWhen(chrome.cdp, `${dialog}.querySelector('[data-cancel-stream]')`);
  await waitDom(chrome.cdp, `!${dialog}`);
  assert.deepEqual(calls(f.meld), []);
  assert.equal(await dom(chrome, `document.activeElement?.textContent.trim()`), 'Iniciar directo');
  await openConfirmation(chrome, 'Iniciar directo');
  await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await chrome.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitDom(chrome.cdp, `!${dialog}`);
  assert.deepEqual(calls(f.meld), []);
});

test('iniciar y terminar esperan la confirmación de Meld y cada uno pide confirmación humana', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  const chrome = await f.open();
  const previous = await f.api('GET', '/api/session');
  await openConfirmation(chrome, 'Iniciar directo'); await confirm(chrome);
  await waitDom(chrome.cdp, `!!(${button('Iniciando…')}) && window.__hasStreamDeadline() && window.__streamResponses === 1`);
  assert.deepEqual(calls(f.meld), [[12, 'meld.startStreamingAction']]);
  assert.equal((await f.api('GET', '/api/session')).id, previous.id);
  assert.doesNotMatch(await dom(chrome, `${card}.textContent`), /En directo/i);
  // Cambiar de pestañas a columnas no pierde el plazo ni permite volver a pedir.
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1256, height: 780, deviceScaleFactor: 1, mobile: false });
  await waitDom(chrome.cdp, `document.querySelectorAll('.d-col').length === 3 && !!(${button('Iniciando…')}) && window.__hasStreamDeadline()`);
  assert.deepEqual(calls(f.meld), [[12, 'meld.startStreamingAction']]);
  await f.report(true);
  await waitDom(chrome.cdp, `${card}.textContent.includes('En directo') && !!(${button('Terminar directo')})`);
  await openConfirmation(chrome, 'Terminar directo');
  assert.match(await dom(chrome, `${dialog}.textContent`), /terminar/i);
  await clickWhen(chrome.cdp, `${dialog}.querySelector('[data-cancel-stream]')`);
  assert.deepEqual(calls(f.meld), [[12, 'meld.startStreamingAction']]);
  await openConfirmation(chrome, 'Terminar directo'); await confirm(chrome);
  await waitDom(chrome.cdp, `!!(${button('Terminando…')}) && window.__streamResponses === 2`);
  assert.deepEqual(calls(f.meld), [[12, 'meld.startStreamingAction'], [12, 'meld.stopStreamingAction']]);
  await f.report(false);
  await waitDom(chrome.cdp, `!!(${button('Iniciar directo')}) && !window.__hasStreamDeadline()`);
});

test('si el estado cambia durante el diálogo, confirmar queda desactivado y no envía', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  const chrome = await f.open();
  await openConfirmation(chrome, 'Iniciar directo');
  await f.report(true);
  await waitDom(chrome.cdp, `${dialog}?.querySelector('[data-confirm-stream]')?.disabled === true`);
  assert.deepEqual(calls(f.meld), []);
  await clickWhen(chrome.cdp, `${dialog}.querySelector('[data-cancel-stream]')`);
  await waitDom(chrome.cdp, `!!(${button('Terminar directo')})`);
});

test('una propiedad de emisión desconocida no se presenta como confirmada', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  await f.report(true);
  const chrome = await f.open();
  await waitDom(chrome.cdp, `!!(${button('Terminar directo')})`);
  const unknown = nextWhere(f.app.meld, 'status', s => s.state === 'conectado' && s.streamingKnown === false);
  f.meld.report(null); await unknown;
  await waitDom(chrome.cdp, `(${button('Iniciar directo')})?.disabled && ${card}.textContent.includes('no informa del estado')`);
  assert.doesNotMatch(await dom(chrome, `document.querySelector('.d-live').textContent`), /En directo/i);
  assert.deepEqual(calls(f.meld), []);
});

test('desconectado oculta el directo anterior y desactiva el control con motivo', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  await f.report(true);
  const chrome = await f.open();
  await waitDom(chrome.cdp, `!!(${button('Terminar directo')})`);
  await f.api('POST', '/api/meld/disconnect');
  await waitDom(chrome.cdp, `(${button('Iniciar directo')})?.disabled && ${card}.textContent.includes('Meld no está conectado')`);
  assert.doesNotMatch(await dom(chrome, `document.querySelector('.d-live').textContent`), /En directo/i);
  assert.doesNotMatch(await dom(chrome, `${card}.textContent`), /En directo/i);
  assert.deepEqual(calls(f.meld), []);
});

test('un inicio y un fin sin confirmar restauran su estado anterior con aviso sin esperar 20 segundos', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  const chrome = await f.open();
  await openConfirmation(chrome, 'Iniciar directo'); await confirm(chrome);
  await waitDom(chrome.cdp, `!!(${button('Iniciando…')}) && window.__hasStreamDeadline() && window.__streamResponses === 1`);
  assert.equal(await dom(chrome, `window.__expireStream()`), true);
  await waitDom(chrome.cdp, `!!(${button('Iniciar directo')}) && /no confirm[oó]/i.test(${card}.textContent)`);
  assert.deepEqual(calls(f.meld), [[12, 'meld.startStreamingAction']]);
  await f.report(true);
  await waitDom(chrome.cdp, `!!(${button('Terminar directo')})`);
  await openConfirmation(chrome, 'Terminar directo'); await confirm(chrome);
  await waitDom(chrome.cdp, `!!(${button('Terminando…')}) && window.__hasStreamDeadline() && window.__streamResponses === 2`);
  assert.equal(await dom(chrome, `window.__expireStream()`), true);
  await waitDom(chrome.cdp, `!!(${button('Terminar directo')}) && /no confirm[oó]/i.test(${card}.textContent)`);
  assert.deepEqual(calls(f.meld), [[12, 'meld.startStreamingAction'], [12, 'meld.stopStreamingAction']]);
});

test('el error del endpoint se muestra y permite reintentar sin atribuir una emisión', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  const chrome = await f.open();
  await dom(chrome, `(() => { const original = window.fetch; window.fetch = (url, opts) => String(url).includes('/api/meld/stream') ? Promise.resolve(new Response(JSON.stringify({error:'Meld rechazó la petición'}), {status:409, headers:{'Content-Type':'application/json'}})) : original(url, opts); return true; })()`);
  await openConfirmation(chrome, 'Iniciar directo'); await confirm(chrome);
  await waitDom(chrome.cdp, `${card}.textContent.includes('Meld rechazó la petición') && !!(${button('Iniciar directo')})`);
  assert.deepEqual(calls(f.meld), []);
  assert.doesNotMatch(await dom(chrome, `${card}.textContent`), /En directo/i);
});

test('contadores por plataforma: valores frescos, cero real y sin dato para falta, desconexión, error o caducidad', { timeout: 60000 }, async t => {
  const f = await start(t); if (!f) return;
  const chrome = await f.open();
  await waitDom(chrome.cdp, `${counter('twitch')}?.textContent.includes('sin dato') && ${counter('youtube')}?.textContent.includes('sin dato')`);
  const v = f.app.viewers;
  v.observe('twitch', { live: true, viewers: 37 }); v.observe('youtube', { live: true, viewers: 0 }); v.emit('change', v.snapshot());
  // textContent del contenedor concatena «YouTube0»: comprueba la cifra, no un límite de palabra.
  await waitDom(chrome.cdp, `${counter('twitch')}.querySelector('b').textContent === '37' && ${counter('youtube')}.querySelector('b').textContent === '0'`);
  const now = v.now; v.now = () => Date.now() - 61000;
  v.observe('twitch', { live: true, viewers: 99 }); v.now = now;
  v.observe('youtube', { live: false, off: true }); v.emit('change', v.snapshot());
  await waitDom(chrome.cdp, `${counter('twitch')}.textContent.includes('sin dato') && ${counter('youtube')}.textContent.includes('sin dato')`);
  assert.doesNotMatch(await dom(chrome, `${card}.textContent`), /99/);
  v.readers = { twitch: async () => { throw new Error('fallo simulado'); }, youtube: async () => ({ live: true, viewers: 18 }) };
  await v.tick();
  await waitDom(chrome.cdp, `${counter('twitch')}.textContent.includes('sin dato') && ${counter('youtube')}.textContent.includes('18')`);
});
