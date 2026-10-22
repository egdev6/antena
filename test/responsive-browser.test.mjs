// #5 · Ajustes responsive del panel y del prompter, verificados con navegador:
// 1) a 1024 la fila de 6 KPIs del directo se reparte 3×2 (antes partía 5+1 y «Miembros»
//    quedaba sola) y a 1440 sigue cabiendo en una sola fila;
// 2) la barra lateral corta las etiquetas por palabra (grupo «Alertas de YouTube» e
//    item «Récord de espectadores»), nunca a mitad de palabra;
// 3) el placeholder del chat es corto («Escribe en tu chat…») y el aviso «tus mensajes
//    no salen en el chat en pantalla» queda como hint de la vista;
// 4) en /prompter, cuando los filtros de la cronología se cortan en el borde derecho
//    hay una pista visual (fundido) de que hay más contenido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-i5-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}
const viewport = (cdp, width, height = 800) =>
  cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
const dom = (cdp, expr) => evaluateChrome(cdp, expr, { timeoutMs: 12000 });

// Reparto en filas de las tarjetas de un grid: «3+3» son dos filas de tres, «6» una fila de seis.
const ROWS = `(() => {
  const tops = new Map();
  for (const el of document.querySelectorAll('.stats .eg-stat')) {
    const r = el.getBoundingClientRect();
    if (r.height <= 0 || r.width <= 0) continue;
    const k = Math.round(r.top / 10) * 10;
    tops.set(k, (tops.get(k) || 0) + 1);
  }
  return [...tops.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n).join('+');
})()`;

// Contrato del truncado en la barra lateral: el corte cae en un hueco de palabra (clamp de
// línea, no recorte de nowrap). CSS no deja leer el corte glifo a glifo de forma fiable, así
// que comprobamos el mecanismo (white-space normal + line-clamp) y que la primera línea
// conserva todas las palabras que caben (medidas fuera del propio clamp, misma tipografía).
const LABEL = el => `(() => {
  const el = ${el};
  if (!el) return null;
  const cs = getComputedStyle(el);
  const full = el.textContent.replace(/\\s+/g, ' ').trim();
  const meas = document.createElement('span');
  meas.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:' + cs.font + ';letter-spacing:' + cs.letterSpacing + ';text-transform:' + cs.textTransform;
  document.body.appendChild(meas);
  const words = full.split(' ');
  let line = '';
  for (const w of words) {
    const cand = line ? line + ' ' + w : w;
    meas.textContent = cand;
    if (meas.getBoundingClientRect().width > el.clientWidth) break;
    line = cand;
  }
  const lineW = line ? meas.getBoundingClientRect().width : 0;
  meas.remove();
  return JSON.stringify({ full, fits: el.scrollWidth <= el.clientWidth + 1,
    // Chrome normaliza display:-webkit-box a flow-root en el estilo computado; el contrato
    // observable es line-clamp activo + white-space normal (el corte cae en hueco de palabra)
    clamp: cs.webkitLineClamp === '1' && cs.whiteSpace === 'normal',
    words: line ? line.split(' ').length : 0, lineW, clientW: el.clientWidth });
})()`;
// entera o cortada por palabra, sin quedarse corta antes de tiempo
const cortaPorPalabra = e => e.clamp && (e.fits || (e.words >= 1 && e.lineW > e.clientW * 0.5));

test('a 1024 los 6 KPIs del directo se reparten 3×2 sin huérfanos y a 1440 caben en una fila', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/directo`);
    const c = chrome.cdp;
    await waitDom(c, `document.querySelectorAll('.stats .eg-stat').length === 6`, { timeoutMs: 15000 });

    await viewport(c, 1024);
    await waitDom(c, `${ROWS} !== ''`, { timeoutMs: 9000 });
    assert.equal(await dom(c, ROWS), '3+3', 'a 1024 las 6 tarjetas de KPI deben repartirse 3×2, sin fila huérfana');

    await viewport(c, 1440);
    await waitDom(c, `${ROWS} === '6'`, { timeoutMs: 9000 });
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('a 1024 la barra lateral corta grupo e items por palabra y el placeholder del chat es corto', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/directo`);
    const c = chrome.cdp;
    await viewport(c, 1024);
    await waitDom(c, `document.querySelectorAll('#nav a[href^="#/"]').length > 20`, { timeoutMs: 15000 });

    // grupo «Alertas de YouTube»: entero o cortado por palabra, nunca «ALERTAS DE YOUTU…»
    await waitDom(c, `!!document.querySelector('#nav [data-grp=youtube] .grp-l')`, { timeoutMs: 9000 });
    const grupo = JSON.parse(await dom(c, LABEL(`document.querySelector('#nav [data-grp=youtube] .grp-l')`)));
    assert.equal(grupo.full, 'Alertas de YouTube');
    assert.ok(cortaPorPalabra(grupo), `el grupo «Alertas de YouTube» se corta a mitad de palabra: ${JSON.stringify(grupo)}`);

    // item «Récord de espectadores»: igual
    await waitDom(c, `!!document.querySelector('#nav a[href="#/alerta/viewers"] .eg-menu__label')`, { timeoutMs: 9000 });
    const item = JSON.parse(await dom(c, LABEL(`document.querySelector('#nav a[href="#/alerta/viewers"] .eg-menu__label')`)));
    assert.equal(item.full, 'Récord de espectadores');
    assert.ok(cortaPorPalabra(item), `el item «Récord de espectadores» se corta a mitad de palabra: ${JSON.stringify(item)}`);

    // chat: placeholder corto y el aviso fuera del placeholder, como hint de la vista
    await dom(c, `location.hash = '#/chat'`);
    await waitDom(c, `!!document.querySelector('.chat-send input')`, { timeoutMs: 9000 });
    assert.equal(await dom(c, `document.querySelector('.chat-send input').placeholder`), 'Escribe en tu chat…');
    const hint = await dom(c, `document.querySelector('.view-head .hint')?.textContent || ''`);
    assert.ok(hint.includes('no salen en el chat en pantalla'), 'el aviso «tus mensajes no salen en el chat en pantalla» debe quedar como hint de la vista');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('en /prompter los filtros de la cronología cortados en el borde muestran una pista de scroll', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/prompter`);
    const c = chrome.cdp;
    await viewport(c, 1280);
    await waitDom(c, `!!(document.querySelector('.top .clock') && document.querySelector('.pr-filters'))`, { timeoutMs: 15000 });

    // #5 en Windows el desborde natural no ocurre (métricas de fuente del SO): forzamos el
    // corte de forma determinista inyectando CSS de prueba — cada uno de los 5 filtros mide
    // al menos 320px sin encoger (flex:none), 5×320=1600 > viewport 1280, así el desborde
    // es independiente de la tipografía. El ResizeObserver de la barra recalcula el cue.
    await dom(c, `(()=>{const s=document.createElement('style');s.id='i5-force-overflow';s.textContent='.pr-filters .eg-tabs__item{flex:none!important;min-width:320px!important}';document.head.appendChild(s);return true})()`);

    // la fila se desplaza horizontalmente (sin scrollbar) y el fundido avisa de que hay más
    const overflow = `(()=>{const el=document.querySelector('.pr-filters');return el.scrollWidth>el.clientWidth+1})()`;
    await waitDom(c, overflow, { timeoutMs: 9000 });
    assert.equal(await dom(c, overflow), true, 'precondición: con el CSS de prueba los filtros de la cronología se cortan en el borde derecho');
    await waitDom(c, `document.querySelector('.pr-filters-cue').classList.contains('cue-right')`, { timeoutMs: 9000 });

    // al llegar al final, la pista de la derecha desaparece y aparece la de la izquierda
    await dom(c, `document.querySelector('.pr-filters').scrollTo({ left: 9999 })`);
    await waitDom(c, `(()=>{const q=document.querySelector('.pr-filters-cue');return q.classList.contains('cue-left')&&!q.classList.contains('cue-right')})()`, { timeoutMs: 9000 });
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});
