// Onboarding del panel: el modal de bienvenida se muestra la primera vez, al cerrarlo se
// marca en config (panel.onboardingDone) y no reaparece al recargar; el botón de
// «General y archivos» lo relanza cuando quieras.
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-onb-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });

test('onboarding: primera vez, cierre persistente y relanzamiento desde General', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    // Primera entrada: la bienvenida aparece (onboardingDone parte a false).
    chrome = await openChromePage(bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!document.querySelector('.onboarding')`, { timeoutMs: 15000 });
    // Las nueve áreas están en las tarjetas.
    const tarjetas = await dom(chrome, `document.querySelectorAll('.onboarding__card').length`);
    if (tarjetas !== 9) throw new Error(`esperaba 9 tarjetas, hay ${tarjetas}`);
    // Cerrar la marca como vista y la guarda en el servidor (patchConfig con PUT /api/config).
    await dom(chrome, `${buttonByText('Empezar')}.click(); 'ok'`);
    for (let i = 0; i < 50 && app.store.config.panel.onboardingDone !== true; i++) await sleep(100);
    if (app.store.config.panel.onboardingDone !== true) throw new Error('el cierre no guardó panel.onboardingDone');
    await waitDom(chrome.cdp, `!document.querySelector('.onboarding')`, { timeoutMs: 9000 });
    await chrome.child.kill(); await chrome.cdp.close(); chrome = null;

    // Recargar: no reaparece.
    chrome = await openChromePage(bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `document.querySelector('.view-head') && !document.querySelector('.onboarding')`, { timeoutMs: 15000 });
    await chrome.child.kill(); await chrome.cdp.close(); chrome = null;

    // Relanzar desde General y archivos.
    chrome = await openChromePage(bin, `${base}/#/general`);
    await waitDom(chrome.cdp, `!!${buttonByText('Ver la bienvenida de nuevo')}`, { timeoutMs: 15000 });
    await dom(chrome, `${buttonByText('Ver la bienvenida de nuevo')}.click(); 'ok'`);
    await waitDom(chrome.cdp, `!!document.querySelector('.onboarding')`, { timeoutMs: 12000 });
    // Y al cerrarla de nuevo vuelve a guardarse como vista.
    await dom(chrome, `${buttonByText('Empezar')}.click(); 'ok'`);
    for (let i = 0; i < 50 && app.store.config.panel.onboardingDone !== true; i++) await sleep(100);
    await waitDom(chrome.cdp, `!document.querySelector('.onboarding')`, { timeoutMs: 9000 });
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});
