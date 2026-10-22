// #130 · chat del overlay: pruebas de navegador de la vista previa en vivo y las opciones nuevas.
// - Cambio de fuente/CSS sin recargar (identidad del mensaje conservada, sin replay de entrada).
// - reverse con ráfaga y tope de maxMessages (nuevos arriba, se expulsa el más antiguo).
// - animIn 'none' en mensajes nuevos y expiración (fade) tras cambiar la configuración.
// - Iconos de plataforma con showPlatform (SVG de public/platform-icons.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chat = n => ({ id: `c-${n}`, platform: n % 2 ? 'twitch' : 'youtube', user: `Espectador ${n}`, text: `Sintético ${n}`, parts: [{ t: `Sintético ${n}` }], at: new Date().toISOString() });
const dom = (c, expr) => evaluateChrome(c, expr);

async function start(t) {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar las pruebas de navegador');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-130-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

test('chat overlay: vista previa en vivo, reverse con tope, anim none, fade e iconos', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  const sleepPut = ms => new Promise(r => setTimeout(r, ms));
  // El servidor agrupa el aviso de widgets ~120 ms: se deja llegar antes de seguir.
  const put = async patch => { const r = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(2500) }); assert.equal(r.status, 200, 'PUT /api/config'); await sleepPut(300); };
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/widget/chat`);
    const c = chrome.cdp;
    app.engine.handleChat(chat(101));
    await waitDom(c, '!!document.querySelector(".msg")', { timeoutMs: 12000 });

    // (a) cambio de fuente y CSS en vivo sin recargar: identidad y clases del mensaje intactas
    assert.equal(await dom(c, `getComputedStyle(document.getElementById('root')).getPropertyValue('--fs').trim()`), '26px');
    await dom(c, `document.querySelector('.msg').__sentinel = 1; document.querySelector('.msg').className`);
    await dom(c, `window.__nav = performance.getEntriesByType('navigation').length`);
    await put({ widgets: { chat: { fontSize: 40, css: '.msg{border-left-color:#00ff88;}' } } });
    await waitDom(c, `getComputedStyle(document.getElementById('root')).getPropertyValue('--fs').trim() === '40px'`, { timeoutMs: 12000 });
    assert.ok(await dom(c, `document.querySelector('.msg').__sentinel`), 'el mensaje no se reconstruye al cambiar config');
    assert.ok(await dom(c, `document.querySelector('.msg').className.includes('a-slide')`), 'clase de entrada intacta (sin replay)');
    assert.ok(await dom(c, `window.__nav === performance.getEntriesByType('navigation').length`), 'sin recarga');
    await waitDom(c, `getComputedStyle(document.querySelector('.msg')).borderLeftColor.includes('0, 255, 136') || getComputedStyle(document.querySelector('.msg')).borderLeftColor.includes('0,255,136')`, { timeoutMs: 12000 });
    await put({ widgets: { chat: { fontSize: 26, css: '' } } });

    // (b) reverse con ráfaga y tope: nuevos arriba y expulsión del más antiguo
    await put({ widgets: { chat: { reverse: true, maxMessages: 5 } } });
    await waitDom(c, `document.getElementById('root').className.includes('reverse')`, { timeoutMs: 12000 });
    for (let n = 201; n <= 208; n++) app.engine.handleChat(chat(n));
    await waitDom(c, `document.querySelectorAll('.msg').length === 5`, { timeoutMs: 12000 });
    assert.ok(await dom(c, `Array.from(document.querySelectorAll('.msg')).at(-1).textContent.includes('Sintético 208')`), 'el más nuevo queda arriba (column-reverse)');
    assert.ok(await dom(c, `document.querySelector('.msg').textContent.includes('Sintético 204')`), 'el más antiguo se expulsa');
    await put({ widgets: { chat: { reverse: false, maxMessages: 12 } } });

    // (c) animIn none: el mensaje nuevo entra sin animación y los previos no la reproducen
    await put({ widgets: { chat: { animIn: 'none' } } });
    app.engine.handleChat(chat(209));
    await waitDom(c, `Array.from(document.querySelectorAll('.msg')).some(m => m.textContent.includes('Sintético 209'))`, { timeoutMs: 12000 });
    assert.ok(await dom(c, `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético 209')).className.includes('a-none')`), 'clase a-none en el mensaje nuevo');
    assert.ok(await dom(c, `getComputedStyle(Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético 209'))).animationName === 'none'`), 'sin animación de entrada');
    await put({ widgets: { chat: { animIn: 'slide' } } });

    // (d) fade tras cambio de configuración: caduca sin resetearse
    await put({ widgets: { chat: { fadeAfterSec: 2 } } });
    app.engine.handleChat(chat(210));
    await waitDom(c, `Array.from(document.querySelectorAll('.msg')).some(m => m.textContent.includes('Sintético 210'))`, { timeoutMs: 12000 });
    await sleep(500);
    await dom(c, `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético 210')).__sentinel = 1`);
    await put({ widgets: { chat: { fontSize: 30 } } }); // cambio en vivo a mitad de vida del temporizador
    await waitDom(c, `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético 210')).className.includes('out')`, { timeoutMs: 12000 });
    assert.ok(await dom(c, `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético 210')).__sentinel`), 'el fade no reconstruye el mensaje');
    await waitDom(c, `!document.querySelector('.msg') || !Array.from(document.querySelectorAll('.msg')).some(m => m.textContent.includes('Sintético 210'))`, { timeoutMs: 12000 });
    await put({ widgets: { chat: { fadeAfterSec: 0, fontSize: 26 } } });

    // (e) iconos de plataforma con showPlatform
    await put({ widgets: { chat: { showPlatform: true } } });
    await waitDom(c, `!!document.querySelector('.msg .pf svg[aria-label="Twitch"]') || !!document.querySelector('.msg .pf svg[aria-label="YouTube"]')`, { timeoutMs: 12000 });
  } finally {
    if (chrome) chrome.child.kill();
    await close();
  }
});
