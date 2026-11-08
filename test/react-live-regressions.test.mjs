// #115 · equivalentes React de las regresiones que solo probaban el panel clásico:
// - tope de 200 mensajes del chat con anclaje de scroll y borrador intactos (antes panel-chat-cap);
// - reconexión SSE con recarga de snapshot y aviso visible de corte (antes panel-sse-reconnect).
// La interfaz React trae el cap en app/src/lib/live.ts (slice(-200), ventana propia por
// /api/chat?limit=200) y el aviso en App.tsx (.offline vía live.failed).
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const chat = (n, text = `Sintético ${n}`) => ({ id: `c-${n}`, user: `Espectador ${n % 7}`, text, platform: 'twitch', at: new Date().toISOString() });

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-115-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

// Justo tras una ráfaga de mensajes el renderizador puede no responder a CDP unos
// instantes: se espera con waitDom (que reintenta) en vez de evaluar a ciegas.
const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr);

test('chat React: tope de 200 mensajes con anclaje de scroll y borrador intactos', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/#/chat`);
    const c = chrome.cdp;
    await waitDom(c, '!!document.querySelector(".chatlog")', { timeoutMs: 12000 });

    // 230 mensajes: el panel conserva los 200 más recientes (#48), no la ventana de 50
    // del widget del overlay que viaja en /api/state y en los eventos 'widgets'.
    // Ráfaga por tandas: 230 mensajes de golpe satura el presupuesto SSE del cliente y el
    // renderizador bajo carga; en tandas el panel drena y el comportamiento es el de uso real.
    for (let n = 1; n <= 230; n++) {
      app.engine.handleChat(chat(n));
      if (n % 25 === 0) await sleep(60);
    }
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Sintético 230'))`, { timeoutMs: 30000 });
    await waitDom(c, `document.querySelectorAll('.chatlog li').length === 200`, { timeoutMs: 10000 });
    await waitDom(c, `(() => { const t = document.querySelector('.chatlog li').textContent; return t.includes('Sintético 31') && !/Sintético 30\\b/.test(t); })()`, { timeoutMs: 10000 });

    // Los borrados siguen funcionando en la lista del panel aunque los eventos 'widgets'
    // traigan la ventana corta del overlay: chatDelete quita uno y chatClear por login.
    app.engine.deleteChat('c-230');
    await waitDom(c, `!Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Sintético 230'))`, { timeoutMs: 10000 });
    app.engine.handleChat(chat(231));
    app.engine.handleChat({ ...chat(232), login: 'spammer' });
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Sintético 232'))`, { timeoutMs: 10000 });
    app.engine.clearChatUser('spammer');
    await waitDom(c, `!Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Sintético 232'))`, { timeoutMs: 10000 });

    // Lector arriba + selección + borrador: la llegada de mensajes no mueve lo que se lee,
    // no rompe la selección ni borra lo escrito. El ancla es la fila visible arriba (la 81.ª,
    // sobrevive al recorte de 30) y su posición en pantalla, no scrollTop: al recortar la
    // ventana por arriba el scrollTop correcto CAMBIA para que la vista no salte.
    const anchorRow = `(() => { const log = document.querySelector('.chatlog'); const r = log.getBoundingClientRect(); const li = Array.from(log.children).find(x => x.getBoundingClientRect().bottom > r.top + 1); return { text: li.textContent, y: li.getBoundingClientRect().top - r.top }; })()`;
    await waitDom(c, `(() => {
      const log = document.querySelector('.chatlog');
      log.scrollTop = log.children[80].offsetTop - log.firstElementChild.offsetTop;
      const range = document.createRange();
      // La selección se ancla a la ÚLTIMA fila (sobrevive al desplazamiento de la ventana
      // de 200, igual que el fixture clásico): la primera sale del DOM al crecer.
      const text = log.lastElementChild.querySelector('span:last-child').firstChild;
      range.setStart(text, 0); range.setEnd(text, Math.min(8, text.length));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      window.__cap115 = JSON.stringify({ row: ${anchorRow}, sel: String(getSelection()) });
      return true;
    })()`, { timeoutMs: 10000 });
    const setReactValue = value => `(() => { const el = document.querySelector('.chat-send input:not([placeholder="canal de Twitch (vacío = el tuyo)"])'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;
    await waitDom(c, setReactValue('Borrador sintético, sin enviar'), { timeoutMs: 10000 });
    for (let n = 233; n <= 262; n++) {
      app.engine.handleChat(chat(n));
      if (n % 15 === 0) await sleep(60);
    }
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Sintético 262'))`, { timeoutMs: 30000 });
    await waitDom(c, `(() => {
      const log = document.querySelector('.chatlog');
      const b = JSON.parse(window.__cap115);
      const a = { row: ${anchorRow}, sel: String(getSelection()) };
      const draft = document.querySelector('.chat-send input:not([placeholder="canal de Twitch (vacío = el tuyo)"])').value;
      return a.row.text === b.row.text && Math.abs(a.row.y - b.row.y) <= 4 && a.sel === b.sel && draft === 'Borrador sintético, sin enviar' && log.querySelectorAll('li').length <= 200;
    })()`, { timeoutMs: 10000 });
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

// Carrera real (CI de Windows): un gap o una reconexión lanza load() y la instantánea de
// /api/chat se genera ANTES de un borrado pero llega DESPUÉS del chatDelete. Sin registrar
// los borrados en vuelo, esa instantánea vieja devolvía el mensaje borrado a la lista.
test('chat React: un borrado durante una recarga en vuelo no reaparece con la instantánea vieja', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  // Retiene la respuesta de /api/chat (ya calculada) mientras `hold` esté activo.
  let hold = false, release, held, served;
  const heldP = new Promise(r => { held = r; });
  const releaseP = new Promise(r => { release = r; });
  const prompterP = new Promise(r => { served = r; });
  const [handler] = app.server.listeners('request');
  app.server.removeListener('request', handler);
  app.server.on('request', (req, res) => {
    if (hold && req.url.startsWith('/api/chat?limit=200')) {
      const end = res.end.bind(res);
      res.end = (...args) => { held(); releaseP.then(() => end(...args)); return res; };
    }
    if (hold && req.url.startsWith('/api/prompter')) res.on('finish', served);
    return handler(req, res);
  });
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/#/chat`);
    const c = chrome.cdp;
    await waitDom(c, '!!document.querySelector(".chatlog")', { timeoutMs: 12000 });
    app.engine.handleChat(chat(1, 'Se queda'));
    app.engine.handleChat(chat(2, 'Se borra'));
    app.engine.handleChat({ ...chat(3, 'Se limpia'), login: 'spammer' });
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Se limpia'))`, { timeoutMs: 15000 });

    // gap → load(): la instantánea de chat (con los tres) queda retenida en el servidor.
    hold = true;
    app.bus.send('gap', { dropped: 0, startedAt: new Date().toISOString() });
    await heldP;
    app.engine.deleteChat('c-2');
    app.engine.clearChatUser('spammer');
    await waitDom(c, `!/Se borra|Se limpia/.test(document.querySelector('.chatlog').textContent)`, { timeoutMs: 10000 });

    // Se suelta la instantánea vieja; load() la aplica antes de pedir /api/prompter.
    release();
    await prompterP;
    await sleep(500);
    const text = await dom(chrome, `document.querySelector('.chatlog').textContent`);
    if (/Se borra|Se limpia/.test(text) || !/Se queda/.test(text)) throw new Error('la instantánea vieja deshizo el borrado: ' + text);
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

test('chat React: tras un corte de SSE reconecta, recarga el snapshot y muestra el aviso', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/#/chat`);
    const c = chrome.cdp;
    await waitDom(c, '!!document.querySelector(".chatlog")', { timeoutMs: 12000 });
    app.engine.handleChat(chat(1, 'Antes del corte'));
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Antes del corte'))`, { timeoutMs: 15000 });

    // gap visible + cierre del cliente del panel: el React debe avisar y reconectar.
    for (const client of [...app.bus.clients].filter(cl => cl.kind === 'panel')) {
      app.bus.send('gap', { dropped: 0, startedAt: new Date().toISOString() });
      setTimeout(() => { try { client.res.destroy(); } catch { /* ya muerto */ } }, 150);
    }
    await waitDom(c, '!!document.querySelector(".offline")', { timeoutMs: 15000 });
    await waitDom(c, `/Sin conexión/.test(document.querySelector(".offline").textContent)`, { timeoutMs: 5000 });

    // al reconectar, la carga del snapshot trae lo publicado durante el corte y el aviso se va.
    app.engine.handleChat(chat(2, 'Durante el corte'));
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Durante el corte'))`, { timeoutMs: 20000 });
    await waitDom(c, '!document.querySelector(".offline")', { timeoutMs: 15000 });
    await waitDom(c, `Array.from(document.querySelectorAll('.chatlog li')).some(li => li.textContent.includes('Antes del corte'))`, { timeoutMs: 5000 });
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});
