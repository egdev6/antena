// Issue #73: al empezar el directo el panel avisa de las plataformas configuradas que no
// están conectadas y lleva a conectarlas (#/conexiones/<plataforma>).
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t, configure) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-platform-warning-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  app.store.config.panel = { onboardingDone: true };
  app.store.config.meld.autoSession = false;
  // Sin red: el intento automático de YouTube falla al momento.
  app.youtube.start = async () => { app.youtube.setStatus({ state: 'error', errors: ['La API key de YouTube no es válida.'] }); };
  configure?.(app);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'igualdad'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const DIALOG = `document.querySelector('.platform-warning[role="dialog"]')`;
const LINKS = `Array.from(document.querySelectorAll('.platform-warning a')).map(a => a.getAttribute('href') + ' ' + a.textContent.trim())`;

test('#73 al empezar el directo avisa de las plataformas sin conectar y lleva a conectarlas', { timeout: 90000 }, async t => {
  const ctx = await start(t, app => {
    app.store.config.twitch = { ...app.store.config.twitch, clientId: 'cliente' };
    app.store.config.youtube = { ...app.store.config.youtube, apiKey: 'fake', channelId: 'UCcanal' };
  });
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!document.querySelector('main')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `!!${DIALOG}`), false, 'sin directo no hay aviso');
    app.meld.setStatus({ state: 'conectado', streaming: true });
    await waitDom(chrome.cdp, `!!${DIALOG}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `${DIALOG}.querySelector('#modal-title').textContent.trim()`), 'Hay plataformas sin conectar');
    eq(JSON.stringify(await dom(chrome, LINKS)), JSON.stringify(['#/conexiones/twitch Conectar Twitch', '#/conexiones/youtube Conectar YouTube']));
    await dom(chrome, `document.querySelector('.platform-warning a[href="#/conexiones/twitch"]').click(), true`);
    await waitDom(chrome.cdp, `!${DIALOG} && location.hash === '#/conexiones/twitch'`, { timeoutMs: 9000 });
    // cerrado durante este directo, no vuelve a salir aunque cambie el estado
    app.youtube.setStatus({ state: 'error', errors: ['otra vez'] });
    await sleep(500);
    eq(await dom(chrome, `!!${DIALOG}`), false, 'no reaparece en el mismo directo');
    // en el siguiente directo vuelve a avisar
    app.meld.setStatus({ state: 'conectado', streaming: false });
    await sleep(300);
    app.meld.setStatus({ state: 'conectado', streaming: true });
    await waitDom(chrome.cdp, `!!${DIALOG}`, { timeoutMs: 12000 });
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('#73 sin plataformas configuradas, o todas conectadas, no hay aviso', { timeout: 90000 }, async t => {
  const ctx = await start(t, app => {
    app.store.config.youtube = { ...app.store.config.youtube, apiKey: 'fake', channelId: 'UCcanal' };
    app.youtube.start = async () => { app.youtube.setStatus({ state: 'escuchando', liveChatId: 'chat-1' }); };
  });
  if (!ctx) return;
  const { app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!document.querySelector('main')`, { timeoutMs: 12000 });
    app.meld.setStatus({ state: 'conectado', streaming: true });
    await sleep(4500); // más que la espera de gracia del aviso
    eq(await dom(chrome, `!!${DIALOG}`), false, 'Twitch sin configurar y YouTube escuchando: sin aviso');
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});
