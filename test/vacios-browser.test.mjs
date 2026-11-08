// #4 · patrón de estado vacío con caja y CTA en Chat, Archivos (General) y el chat del prompter,
// y copy unificado: ningún vacío de las vistas del panel dice «Aún no hay» (familia «Todavía no…»).
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-vacios-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'igualdad'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const EMPTY = `Array.from(document.querySelectorAll('main .eg-post--empty.empty-state')).map(e => e.textContent.trim())`;
// PNG de 1×1 píxel para subir un archivo real a media/
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('#4 chat vacío: caja de estado vacío con CTA a conexiones, no texto suelto', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(ctx.bin, `${base}/#/chat`);
    await waitDom(chrome.cdp, `${EMPTY}.some(x => x.startsWith('Todavía no hay mensajes'))`, { timeoutMs: 12000 });
    eq(await dom(chrome, `['normal','none'].includes(getComputedStyle(document.querySelector('main .chatlog'), '::before').content)`), true, 'sin pseudo-texto suelto: el ol ya no está :empty');
    eq(await dom(chrome, `document.querySelector('main .empty-state')?.querySelector('a[href="#/conexiones"]')?.textContent.trim()`), 'Conectar Twitch', 'CTA a conexiones');
    // al llegar un mensaje de verdad, la caja desaparece y la lista se pinta
    app.engine.handleChat({ id: 'c-1', user: 'EspectadorBot', text: 'hola', platform: 'twitch', color: '#3B5CFF' });
    await waitDom(chrome.cdp, `Array.from(document.querySelectorAll('main ol.chatlog li')).some(li => li.textContent.includes('EspectadorBot'))`, { timeoutMs: 9000 });
    eq(await dom(chrome, `document.querySelectorAll('main .eg-post--empty').length`), 0, 'con mensajes no queda la caja');
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

test('#4 archivos vacíos en Archivos: caja con CTA «Subir archivos» y desaparece al subir', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(ctx.bin, `${base}/#/archivos`);
    await waitDom(chrome.cdp, `${EMPTY}.some(x => x.startsWith('Todavía no hay archivos'))`, { timeoutMs: 12000 });
    const cta = `document.querySelector('main .empty-state')?.querySelector('label.upload')`;
    eq(await dom(chrome, `${cta}?.textContent.trim()`), 'Subir archivos', 'CTA «Subir archivos» dentro de la caja');
    eq(await dom(chrome, `${cta}?.querySelector('input[type=file]')?.multiple`), true, 'el CTA acepta varios archivos');
    // al subir un archivo por la API, la caja desaparece y aparece la lista (la subida por API
    // no empuja el live al panel: se recarga y el estado guardado ya la lista)
    const up = await fetch(base + '/api/media/upload?name=test.png', { method: 'POST', body: PNG });
    if (!up.ok) throw new Error('upload: ' + up.status);
    await dom(chrome, `setTimeout(() => location.reload(), 0); 'ok'`);
    await waitDom(chrome.cdp, `!!document.querySelector('main table.lv-list tbody tr')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `document.querySelectorAll('main .empty-state').length`), 0, 'con archivos no queda la caja');
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

test('#4 recorrido del panel: ninguna vista dice «Aún no hay»', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(ctx.bin, `${base}/#/comandos`);
    await waitDom(chrome.cdp, `!!document.querySelector('main h1')`, { timeoutMs: 12000 });
    const rutas = ['#/directo', '#/chat', '#/historial', '#/comandos', '#/mensajes',
      '#/preguntas', '#/teleprompter', '#/tierlist', '#/sorteo', '#/alertas', '#/widgets', '#/widgets/chat', '#/widgets/objetivos', '#/widgets/latest', '#/widgets/credits',
      '#/fuentes', '#/meld', '#/atajos', '#/prompter', '#/directos', '#/archivos', '#/apariencia', '#/filtros', '#/conexiones', '#/general', '#/acerca'];
    for (const hash of rutas) {
      await dom(chrome, `location.hash = ${JSON.stringify(hash)}`);
      // Directo es la excepción sin h1 (title-input): vale la cabecera de vista
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(hash)} && (!!document.querySelector('main h1') || !!document.querySelector('main .view-head'))`, { timeoutMs: 12000 });
      await sleep(150);
      eq(await dom(chrome, `document.body.textContent.includes('Aún no hay')`), false, `${hash} sin «Aún no hay»`);
    }
    // las tres cajas nuevas existen donde toca: chat, archivos y la cronología de Directo
    await dom(chrome, `location.hash = '#/chat'`);
    await waitDom(chrome.cdp, `${EMPTY}.some(x => x.startsWith('Todavía no hay mensajes'))`, { timeoutMs: 12000 });
    await dom(chrome, `location.hash = '#/archivos'`);
    await waitDom(chrome.cdp, `${EMPTY}.some(x => x.startsWith('Todavía no hay archivos'))`, { timeoutMs: 12000 });
    await dom(chrome, `location.hash = '#/directo'`);
    await waitDom(chrome.cdp, `${EMPTY}.some(x => x.startsWith('Todavía no hay mensajes'))`, { timeoutMs: 12000 });
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});
