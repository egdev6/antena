// Onboarding del panel (O5): la primera vez sale un saludo («¿Te enseño cómo funciona?»);
// «Ahora no» lo marca como visto (panel.onboardingDone) y «Empezar el tour» lanza un tour
// guiado con driver.js que navega por las vistas señalando sus zonas ([data-tour]).
// Terminar o cerrar el tour también lo marca; «General y archivos» lo relanza sin saludo.
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(t, { done = false } = {}) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-onb-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  app.store.config.panel.onboardingDone = done;
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

// Ventana de escritorio: por debajo de 860 px los grupos del menú no tienen caja propia
// (display: contents) y el tour se salta sus pasos.
async function openDesktop(bin, url) {
  const chrome = await openChromePage(bin, url);
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return chrome;
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const GREET = `document.querySelector('.tour-greet')`;
const POPOVER = `document.querySelector('.driver-popover')`;
const ACTIVE = `document.querySelector('.driver-active-element')?.getAttribute('data-tour')`;
const NEXT = `document.querySelector('.driver-popover-next-btn')`;
const PROGRESS = `document.querySelector('.driver-popover-progress-text')?.textContent`;
// Pulsa «Siguiente» y espera en la página a que se resalte otra ancla; devuelve los ms.
const nextTimed = (chrome, anchor) => dom(chrome, `new Promise(resolve => {
  const t0 = performance.now();
  ${NEXT}.click();
  const tick = () => (${ACTIVE} === ${JSON.stringify(anchor)} ? resolve(Math.round(performance.now() - t0)) : setTimeout(tick, 10));
  tick();
})`);

async function waitDone(app) {
  for (let i = 0; i < 50 && app.store.config.panel.onboardingDone !== true; i++) await sleep(100);
  if (app.store.config.panel.onboardingDone !== true) throw new Error('no se guardó panel.onboardingDone');
}

// Anota cada ancla resaltada (en orden y sin repetir seguidas) en window.__tourSeen.
const RECORD = `(() => { window.__tourSeen = [];
  new MutationObserver(ms => { for (const m of ms) {
    const a = m.target.classList?.contains('driver-active-element') && m.target.getAttribute('data-tour');
    if (a && window.__tourSeen.at(-1) !== a) window.__tourSeen.push(a);
  } }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  return 'ok'; })()`;

test('onboarding: primera vez sale el saludo y «Ahora no» lo deja visto aunque recargues', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openDesktop(bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!${GREET}`, { timeoutMs: 15000 });
    const text = await dom(chrome, `${GREET}.textContent`);
    if (!text.includes('¿Te enseño cómo funciona?')) throw new Error('el saludo no pregunta si enseñar el tour');
    if (await dom(chrome, `!!${POPOVER}`)) throw new Error('el tour no debe empezar antes de pedirlo');
    await dom(chrome, `${buttonByText('Ahora no')}.click(); 'ok'`);
    await waitDone(app);
    await waitDom(chrome.cdp, `!${GREET} && !${POPOVER}`, { timeoutMs: 9000 });
    await chrome.child.kill(); await chrome.cdp.close(); chrome = null;

    chrome = await openDesktop(bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!document.querySelector('[data-tour="directo-head"]')`, { timeoutMs: 15000 });
    await sleep(500);
    if (await dom(chrome, `!!${GREET} || !!${POPOVER}`)) throw new Error('el saludo o el tour reaparecen al recargar');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('onboarding: el tour señala zonas, cambia de vista, salta anclas que faltan y al terminar queda visto', { timeout: 180000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openDesktop(bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!${GREET}`, { timeoutMs: 15000 });
    await dom(chrome, RECORD);
    await dom(chrome, `${buttonByText('Empezar el tour')}.click(); 'ok'`);
    // Primer paso: popover sobre el menú lateral, con el progreso «1 de N» y botones en español.
    await waitDom(chrome.cdp, `!!${POPOVER} && ${ACTIVE} === 'nav'`, { timeoutMs: 9000 });
    if (await dom(chrome, `!!${GREET}`)) throw new Error('el saludo sigue visible durante el tour');
    const progress = await dom(chrome, `document.querySelector('.driver-popover-progress-text').textContent`);
    if (progress !== '1 de 19') throw new Error(`progreso inesperado: ${progress}`);
    const next = await dom(chrome, `${NEXT}.textContent`);
    if (next !== 'Siguiente') throw new Error(`botón siguiente: ${next}`);
    if (app.store.config.panel.onboardingDone !== false) throw new Error('empezar el tour no debe marcarlo aún');

    // Siguiente hasta cruzar a otra vista: aterriza en #/chat con su ancla resaltada.
    for (let i = 0; i < 12 && await dom(chrome, `location.hash`) !== '#/chat'; i++) {
      const before = await dom(chrome, ACTIVE);
      await dom(chrome, `${NEXT}.click(); 'ok'`);
      await waitDom(chrome.cdp, `${ACTIVE} !== ${JSON.stringify(before)}`, { timeoutMs: 9000 });
    }
    await waitDom(chrome.cdp, `location.hash === '#/chat' && ${ACTIVE} === 'chat-log' && !!document.querySelector('.chatlog[data-tour="chat-log"]')`, { timeoutMs: 9000 });
    // Anterior vuelve a la vista de antes.
    await dom(chrome, `document.querySelector('.driver-popover-prev-btn').click(); 'ok'`);
    await waitDom(chrome.cdp, `location.hash === '#/directo' && ${ACTIVE} === 'directo-timeline'`, { timeoutMs: 9000 });

    // Meld sin conectar: el paso de escenas no cuenta y se salta al instante, sin huecos.
    for (let i = 0; i < 12 && await dom(chrome, ACTIVE) !== 'meld-head'; i++) {
      const before = await dom(chrome, ACTIVE);
      await dom(chrome, `${NEXT}.click(); 'ok'`);
      await waitDom(chrome.cdp, `${ACTIVE} !== ${JSON.stringify(before)}`, { timeoutMs: 9000 });
    }
    await waitDom(chrome.cdp, `${ACTIVE} === 'meld-head' && ${PROGRESS} === '13 de 19'`, { timeoutMs: 9000 });
    const ms = await nextTimed(chrome, 'meld-connection');
    await waitDom(chrome.cdp, `${PROGRESS} === '14 de 19'`, { timeoutMs: 3000 });
    if (ms > 1000) throw new Error(`el paso no disponible hizo esperar ${ms} ms`);

    // Siguiente hasta el final: el último paso dice «Terminar» y al pulsarlo se cierra y queda visto,
    // aunque se pulse mientras el resaltado aún se anima.
    for (let i = 0; i < 40 && await dom(chrome, `!!${POPOVER}`); i++) {
      const label = await dom(chrome, `${NEXT}?.textContent`);
      const before = await dom(chrome, ACTIVE);
      await dom(chrome, `${NEXT}.click(); 'ok'`);
      if (label === 'Terminar') break;
      await waitDom(chrome.cdp, `${ACTIVE} !== ${JSON.stringify(before)} || !${POPOVER}`, { timeoutMs: 9000 });
    }
    await waitDom(chrome.cdp, `!${POPOVER} && !document.querySelector('.driver-active-element')`, { timeoutMs: 9000 });
    await waitDone(app);
    const seen = await dom(chrome, `window.__tourSeen`);
    // Meld está sin conectar: sus escenas no existen y ese paso se salta sin romper el tour.
    for (const a of ['directo-alerts', 'chat-send', 'goals-tabs', 'meld-head', 'meld-connection', 'atajos-streamdeck', 'atajos-list', 'conexiones-twitch', 'general-tour']) {
      if (!seen.includes(a)) throw new Error(`el tour no pasó por ${a}: ${seen.join(', ')}`);
    }
    if (seen.includes('meld-scenes')) throw new Error('el paso sin ancla no se saltó');
    if (seen.indexOf('meld-connection') !== seen.indexOf('meld-head') + 1) throw new Error(`orden inesperado: ${seen.join(', ')}`);
    if (seen.at(-1) !== 'general-tour') throw new Error(`el tour no terminó en General: ${seen.join(', ')}`);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('onboarding: «General y archivos» relanza el tour sin saludo; Esc y las flechas funcionan', { timeout: 120000 }, async t => {
  const ctx = await start(t, { done: true });
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openDesktop(bin, `${base}/#/general`);
    await waitDom(chrome.cdp, `!!${buttonByText('Ver el tour de nuevo')}`, { timeoutMs: 15000 });
    if (await dom(chrome, `!!${GREET}`)) throw new Error('con el onboarding visto no debe salir el saludo');
    await dom(chrome, `${buttonByText('Ver el tour de nuevo')}.click(); 'ok'`);
    await waitDom(chrome.cdp, `!!${POPOVER} && ${ACTIVE} === 'nav' && location.hash === '#/directo'`, { timeoutMs: 9000 });
    if (await dom(chrome, `!!${GREET}`)) throw new Error('relanzar desde General no debe pasar por el saludo');
    // Flecha derecha = siguiente; flecha izquierda = anterior (driver.js ignora las teclas
    // mientras anima el resaltado, así que se deja asentar cada paso).
    const key = async k => {
      await sleep(700);
      for (const type of ['keyDown', 'keyUp']) await chrome.cdp.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: { ArrowRight: 39, ArrowLeft: 37, Escape: 27 }[k] });
    };
    await key('ArrowRight');
    await waitDom(chrome.cdp, `${ACTIVE} === 'nav-directo'`, { timeoutMs: 9000 });
    await key('ArrowLeft');
    await waitDom(chrome.cdp, `${ACTIVE} === 'nav'`, { timeoutMs: 9000 });
    // Esc cierra el tour.
    await key('Escape');
    await waitDom(chrome.cdp, `!${POPOVER} && !document.querySelector('.driver-active-element')`, { timeoutMs: 9000 });
    await waitDone(app);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('onboarding: red de seguridad, un ancla que no aparece se salta y la numeración se rehace sin huecos', { timeout: 120000 }, async t => {
  const ctx = await start(t, { done: true });
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    chrome = await openDesktop(bin, `${base}/#/general`);
    await waitDom(chrome.cdp, `!!${buttonByText('Ver el tour de nuevo')}`, { timeoutMs: 15000 });
    // La tarjeta de alertas existe pero no se ve: su paso cumple la condición y aun así no llega.
    await dom(chrome, `(() => { const s = document.createElement('style'); s.textContent = '[data-tour="directo-alerts"]{display:none!important}'; document.head.append(s); return 'ok'; })()`);
    await dom(chrome, RECORD);
    await dom(chrome, `${buttonByText('Ver el tour de nuevo')}.click(); 'ok'`);
    await waitDom(chrome.cdp, `${ACTIVE} === 'nav' && ${PROGRESS} === '1 de 19'`, { timeoutMs: 9000 });
    for (let i = 0; i < 8 && await dom(chrome, ACTIVE) !== 'directo-stats'; i++) {
      const before = await dom(chrome, ACTIVE);
      await dom(chrome, `${NEXT}.click(); 'ok'`);
      await waitDom(chrome.cdp, `${ACTIVE} !== ${JSON.stringify(before)}`, { timeoutMs: 9000 });
    }
    await waitDom(chrome.cdp, `${ACTIVE} === 'directo-stats' && ${PROGRESS} === '5 de 19'`, { timeoutMs: 9000 });
    // Tras la espera acotada, la cronología toma el número del paso que falta y el total baja.
    await dom(chrome, `${NEXT}.click(); 'ok'`);
    await waitDom(chrome.cdp, `${ACTIVE} === 'directo-timeline' && ${PROGRESS} === '6 de 18'`, { timeoutMs: 9000 });
    // Y hacia atrás no vuelve a esperar por él.
    await dom(chrome, `document.querySelector('.driver-popover-prev-btn').click(); 'ok'`);
    await waitDom(chrome.cdp, `${ACTIVE} === 'directo-stats' && ${PROGRESS} === '5 de 18'`, { timeoutMs: 1500 });
    const seen = await dom(chrome, `window.__tourSeen`);
    if (seen.includes('directo-alerts')) throw new Error('el ancla invisible se resaltó');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});
