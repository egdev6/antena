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
    // (d) con caducidad en vivo ya retiró los mensajes previos: entra uno nuevo
    await put({ widgets: { chat: { showPlatform: true } } });
    app.engine.handleChat(chat(211));
    await waitDom(c, `!!document.querySelector('.msg .pf svg[aria-label="Twitch"]') || !!document.querySelector('.msg .pf svg[aria-label="YouTube"]')`, { timeoutMs: 12000 });
  } finally {
    if (chrome) chrome.child.kill();
    await close();
  }
});

// O2.1 · la vista previa refleja la config en vivo: las opciones por mensaje (filtros, icono,
// tope, caducidad) se reaplican a los mensajes ya pintados, sin recargar ni reconstruirlos.
test('chat overlay: la config se reaplica en vivo a los mensajes existentes', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  const put = async patch => { const r = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(2500) }); assert.equal(r.status, 200, 'PUT /api/config'); await sleep(300); };
  let chrome, demo;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/widget/chat`);
    const c = chrome.cdp;
    for (let n = 301; n <= 304; n++) app.engine.handleChat(chat(n));
    await waitDom(c, `document.querySelectorAll('.msg').length === 4 && !!document.querySelector('.msg .pf')`, { timeoutMs: 12000 });
    await dom(c, `document.querySelectorAll('.msg').forEach(m => m.__sentinel = 1); window.__nav = performance.getEntriesByType('navigation').length`);

    await put({ widgets: { chat: { showPlatform: false } } });
    await waitDom(c, `!document.querySelector('.msg .pf')`, { timeoutMs: 12000 });
    await put({ widgets: { chat: { showPlatform: true } } });
    await waitDom(c, `document.querySelectorAll('.msg .pf').length === 4`, { timeoutMs: 12000 });

    await put({ widgets: { chat: { platforms: ['twitch'] } } });
    await waitDom(c, `!document.querySelector('.msg.pf-youtube') && document.querySelectorAll('.msg.pf-twitch').length === 2`, { timeoutMs: 12000 });

    await put({ widgets: { chat: { maxMessages: 1 } } });
    await waitDom(c, `document.querySelectorAll('.msg').length === 1`, { timeoutMs: 12000 });
    assert.ok(await dom(c, `document.querySelector('.msg').textContent.includes('Sintético 303')`), 'el tope conserva el más reciente');
    assert.ok(await dom(c, `document.querySelector('.msg').__sentinel === 1 && window.__nav === performance.getEntriesByType('navigation').length`), 'sin reconstruir ni recargar');

    await put({ widgets: { chat: { fadeAfterSec: 1, animOut: 'fade' } } });
    await waitDom(c, `!document.querySelector('.msg')`, { timeoutMs: 12000 });
    await put({ widgets: { chat: { platforms: ['twitch', 'youtube'], maxMessages: 12, fadeAfterSec: 0, animOut: 'slide' } } });

    // Modo demo (la vista previa del panel): un cambio de entrada se ve al instante con una muestra.
    demo = await openChromePage(ctx.bin, `${base}/widget/chat?demo`);
    const d = demo.cdp;
    await waitDom(d, `document.querySelectorAll('.msg').length >= 6`, { timeoutMs: 12000 });
    await put({ widgets: { chat: { fontSize: 31, animIn: 'pop' } } });
    await waitDom(d, `getComputedStyle(document.getElementById('root')).getPropertyValue('--fs').trim() === '31px'`, { timeoutMs: 12000, intervalMs: 20 });
    assert.ok(await dom(d, `!!document.querySelector('.msg.a-pop')`), 'la muestra demo usa la entrada nueva en cuanto llega la config');
  } finally {
    if (chrome) chrome.child.kill();
    if (demo) demo.child.kill();
    await close();
  }
});

// O2.2 · efectos nuevos: cada valor pone su clase y una animación real (y su variante invertida).
test('chat overlay: efectos nuevos de entrada y salida', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  const put = async patch => { const r = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(2500) }); assert.equal(r.status, 200, 'PUT /api/config'); await sleep(300); };
  const last = `Array.from(document.querySelectorAll('.msg')).at(-1)`;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/widget/chat`);
    const c = chrome.cdp;
    let n = 400;
    for (const v of ['bounce', 'zoom', 'flip', 'blur']) {
      await put({ widgets: { chat: { animIn: v } } });
      app.engine.handleChat(chat(++n));
      await waitDom(c, `!!document.querySelector('.msg') && ${last}.textContent.includes('Sintético ${n}')`, { timeoutMs: 12000 });
      assert.ok(await dom(c, `${last}.classList.contains('a-${v}')`), `clase a-${v}`);
      assert.notEqual(await dom(c, `getComputedStyle(${last}).animationName`), 'none', `animación de entrada ${v}`);
    }
    await put({ widgets: { chat: { animIn: 'slide', fadeAfterSec: 1 } } });
    for (const v of ['zoom', 'blur', 'drop']) {
      await put({ widgets: { chat: { animOut: v } } });
      app.engine.handleChat(chat(++n));
      const el = `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético ${n}'))`;
      await waitDom(c, `${el}?.classList.contains('o-${v}')`, { timeoutMs: 12000, intervalMs: 20 });
      assert.notEqual(await dom(c, `getComputedStyle(${el}).animationName`), 'none', `animación de salida ${v}`);
    }
    await put({ widgets: { chat: { reverse: true, fadeAfterSec: 0, animIn: 'bounce' } } });
    app.engine.handleChat(chat(++n));
    await waitDom(c, `!!document.querySelector('.msg.a-bounce')`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg.a-bounce')).animationName`), 'inBR', 'bounce invertido entra desde arriba');
  } finally {
    if (chrome) chrome.child.kill();
    await close();
  }
});

// Entrada y salida ofrecen las mismas animaciones, y las que tienen dirección siguen al orden:
// los mensajes nuevos entran por un borde y los viejos salen por el otro (se invierten con
// «Chat invertido»). «Caída» es gravedad: siempre cae hacia abajo, también en orden invertido.
const ANIMS = ['slide', 'fade', 'pop', 'bounce', 'zoom', 'flip', 'blur', 'drop', 'none'];
test('chat overlay: mismas animaciones de entrada y salida, orientadas al orden', { timeout: 180000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  const put = async patch => { const r = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(2500) }); assert.equal(r.status, 200, `PUT /api/config ${JSON.stringify(patch)}`); };
  // En vez de una espera fija, se espera a que el widget refleje la config aplicada en #root
  // (data-anim-in/data-anim-out/data-fade y la clase reverse) antes de mandar el mensaje.
  const applied = (c, { animIn, animOut, reverse, fadeAfterSec }) => waitDom(c, `(() => { const r = document.getElementById('root');
    return r.dataset.animIn === ${JSON.stringify(animIn)} && (${JSON.stringify(animOut ?? null)} === null || r.dataset.animOut === ${JSON.stringify(animOut ?? null)})
      && r.classList.contains('reverse') === ${!!reverse} && r.dataset.fade === ${JSON.stringify(String(fadeAfterSec))}; })()`, { timeoutMs: 12000, intervalMs: 20 });
  const byN = n => `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético ${n}'))`;
  let chrome;
  try {
    // el panel ofrece la misma lista en los dos selects
    chrome = await openChromePage(ctx.bin, `${base}/#/widget/chat`);
    const opts = label => `Array.from(document.querySelectorAll('main label')).find(l => l.textContent.startsWith(${JSON.stringify(label)}))?.querySelectorAll('option')`;
    await waitDom(chrome.cdp, `(${opts('Animación de entrada')})?.length > 0`, { timeoutMs: 12000 });
    const values = label => dom(chrome.cdp, `Array.from(${opts(label)}).map(o => o.value).join(',')`);
    assert.equal(await values('Animación de entrada'), ANIMS.join(','));
    assert.equal(await values('Animación al desaparecer'), ANIMS.join(','));
    chrome.child.kill(); chrome = null;

    chrome = await openChromePage(ctx.bin, `${base}/widget/chat`);
    const c = chrome.cdp;
    let n = 600;
    const enter = async (v, reverse) => {
      await put({ widgets: { chat: { animIn: v, reverse, fadeAfterSec: 0 } } });
      await applied(c, { animIn: v, reverse, fadeAfterSec: 0 });
      app.engine.handleChat(chat(++n));
      await waitDom(c, `!!(${byN(n)})`, { timeoutMs: 12000 });
      assert.ok(await dom(c, `${byN(n)}.classList.contains('a-${v}')`), `clase a-${v}`);
      return dom(c, `getComputedStyle(${byN(n)}).animationName`);
    };
    const leave = async (v, reverse, animIn = 'none') => {
      await put({ widgets: { chat: { animIn, animOut: v, reverse, fadeAfterSec: 1 } } });
      await applied(c, { animIn, animOut: v, reverse, fadeAfterSec: 1 });
      app.engine.handleChat(chat(++n));
      // sin animación de salida el mensaje se quita al caducar, sin pasar por .out
      if (v === 'none') {
        await waitDom(c, `!!(${byN(n)})`, { timeoutMs: 12000, intervalMs: 20 });
        await waitDom(c, `!(${byN(n)})`, { timeoutMs: 12000, intervalMs: 20 });
        return 'none';
      }
      await waitDom(c, `${byN(n)}?.classList.contains('o-${v}')`, { timeoutMs: 12000, intervalMs: 20 });
      assert.ok(await dom(c, `${byN(n)}.classList.contains('a-${animIn}')`), `entró con a-${animIn}`);
      return dom(c, `getComputedStyle(${byN(n)}).animationName`);
    };
    for (const v of ANIMS) {
      const a = await enter(v, false);
      assert.equal(a === 'none', v === 'none', `entrada ${v}: ${a}`);
      const o = await leave(v, false);
      assert.equal(o === 'none', v === 'none', `salida ${v}: ${o}`);
    }
    // orden normal: entran por abajo y salen por arriba; invertido, al revés
    assert.equal(await leave('bounce', false), 'outB', 'bounce sale hacia arriba');
    assert.equal(await leave('bounce', true), 'outBR', 'bounce invertido sale hacia abajo');
    assert.equal(await leave('flip', true), 'outFlR', 'flip invertido pliega sobre el borde de abajo');
    // caída: siempre hacia abajo
    assert.equal(await leave('drop', false), 'outD');
    assert.equal(await leave('drop', true), 'outD', 'caída en orden invertido también cae hacia abajo');
    assert.equal(await enter('drop', true), 'inD', 'entrada en caída: desde arriba en los dos órdenes');
    // la animación de entrada nunca pisa la de salida, tampoco en orden invertido
    for (const animIn of ['slide', 'bounce', 'flip']) {
      assert.equal(await leave('fade', true, animIn), 'outF', `invertido: entrada ${animIn} no pisa la salida`);
      assert.equal(await leave('fade', false, animIn), 'outF', `normal: entrada ${animIn} no pisa la salida`);
    }
  } finally {
    if (chrome) chrome.child.kill();
    await close();
  }
});

// Al pasar el tope de mensajes, el más antiguo sale con la animación de salida (no desaparece de
// golpe), aunque todavía no le tocara caducar; los que ya están saliendo no cuentan para el tope.
test('chat overlay: el mensaje que sobra por el tope sale con la animación de salida', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  const put = async patch => { const r = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(2500) }); assert.equal(r.status, 200, `PUT /api/config ${JSON.stringify(patch)}`); };
  const byN = n => `Array.from(document.querySelectorAll('.msg')).find(m => m.textContent.includes('Sintético ${n}'))`;
  const visible = `document.querySelectorAll('.msg:not(.out)').length`;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/widget/chat`);
    const c = chrome.cdp;
    for (const [animOut, name] of [['fade', 'outF'], ['drop', 'outD']]) {
      await put({ widgets: { chat: { maxMessages: 3, fadeAfterSec: 0, animIn: 'none', animOut } } });
      await waitDom(c, `document.getElementById('root').dataset.animOut === ${JSON.stringify(animOut)} && document.getElementById('root').dataset.fade === '0'`, { timeoutMs: 12000, intervalMs: 20 });
      await dom(c, `document.getElementById('root').replaceChildren()`);
      const first = animOut === 'fade' ? 701 : 711;
      for (let n = first; n < first + 3; n++) app.engine.handleChat(chat(n));
      await waitDom(c, `${visible} === 3`, { timeoutMs: 12000 });
      app.engine.handleChat(chat(first + 3));
      // el más antiguo no se borra de golpe: sale animado y deja el tope en 3 visibles
      await waitDom(c, `${byN(first)}?.classList.contains('out')`, { timeoutMs: 12000, intervalMs: 20 });
      assert.ok(await dom(c, `${byN(first)}.classList.contains('o-${animOut}')`), `sale con o-${animOut}`);
      assert.equal(await dom(c, `getComputedStyle(${byN(first)}).animationName`), name);
      assert.equal(await dom(c, visible), 3, 'tope de 3 mensajes visibles');
      // y al terminar la animación se quita del DOM
      await waitDom(c, `!(${byN(first)})`, { timeoutMs: 12000 });
      assert.equal(await dom(c, `document.querySelectorAll('.msg').length`), 3);
    }
    // sin animación de salida, el que sobra se quita al momento
    await put({ widgets: { chat: { maxMessages: 2, animOut: 'none' } } });
    await waitDom(c, `document.getElementById('root').dataset.animOut === 'none'`, { timeoutMs: 12000, intervalMs: 20 });
    await waitDom(c, `document.querySelectorAll('.msg').length === 2`, { timeoutMs: 2000, intervalMs: 20 });
  } finally {
    if (chrome) chrome.child.kill();
    await close();
  }
});
