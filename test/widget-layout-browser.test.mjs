// O3.3 (odd/tasks/antena-ux-ajustes.md) · todas las páginas de widgets comparten el mismo esqueleto:
// dos columnas; la izquierda empieza siempre por el bloque «Fuente de navegador en Meld» (con una URL
// que se copia) y la vista previa va siempre en la columna derecha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const api = (base, method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`); return r.json(); });

// Lo que se mide en cada página: un único esqueleto en main, su primer bloque a la izquierda,
// la URL que copia ese bloque y dónde quedan las vistas previas.
const PROBE = `(() => {
  const layouts = document.querySelectorAll('main .widget-layout');
  const lay = layouts[0];
  if (!lay) return { layouts: 0 };
  const left = lay.querySelector(':scope > .form-col'), right = lay.querySelector(':scope > .preview-col');
  const first = left?.firstElementChild;
  const r = el => el.getBoundingClientRect();
  const frames = Array.from(lay.querySelectorAll('iframe'));
  return {
    layouts: layouts.length,
    order: Array.from(lay.children).map(c => c.className).join(' | '),
    firstIsSource: !!first?.classList.contains('browser-source'),
    title: first?.querySelector('h2')?.textContent.trim() ?? null,
    url: first?.querySelector('.overlay-url code')?.textContent ?? null,
    copyBtn: !!first?.querySelector('.overlay-url button'),
    sourcesOutsideLeftTop: document.querySelectorAll('main .browser-source').length - left.querySelectorAll(':scope > .browser-source').length,
    oldName: document.querySelector('main').textContent.includes('Capa de navegador'),
    frames: frames.length,
    framesLeft: frames.filter(f => left.contains(f)).length,
    framesRight: frames.filter(f => right?.contains(f) && f.closest('.eg-stage')?.querySelector('.eg-stage__bar .eg-eyebrow')).length,
    rightOfForm: frames.every(f => r(f).left >= r(left).right),
  };
})()`;

test('O3.3 páginas de widgets: fuente de navegador primero a la izquierda y vista previa a la derecha', { timeout: 180000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-o33-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    // la primera caja de objetivos es la que se abre al entrar en Objetivos
    const goal = app.store.config.widgets.goals[0];
    chrome = await openChromePage(bin, `${base}/#/directo`);
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // el portapapeles headless no siempre deja escribir: se captura lo que copia el botón
    await dom(chrome, `(() => { window.__copied = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: x => { window.__copied.push(x); return Promise.resolve(); } } }); return 'ok'; })()`);

    // [ruta, url que debe copiar el bloque]; todas tienen vista previa
    const pages = [
      ['#/widget/questions', '/widget/question'],
      ['#/widget/teleprompter', '/widget/teleprompter'],
      ['#/widget/tierlist', '/widget/tierlist'],
      ['#/widget/giveaway', '/widget/giveaway'],
      ['#/widget/chat', '/widget/chat'],
      ['#/widget/goals', `/widget/goal?id=${encodeURIComponent(goal.id)}`],
      ['#/widget/latest', '/widget/latest'],
      ['#/widget/credits', '/widget/credits'],
    ];
    for (const [hash, url] of pages) {
      await dom(chrome, `location.hash = ${JSON.stringify(hash)}`);
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(hash)} && !!document.querySelector('main .widget-layout .form-col > .browser-source')`, { timeoutMs: 12000 }).catch(() => {});
      const p = await dom(chrome, PROBE);
      assert.equal(p.layouts, 1, `${hash}: un solo esqueleto de widget`);
      assert.equal(p.order, 'form-col | preview-col', `${hash}: columnas configuración | vista previa`);
      assert.equal(p.firstIsSource, true, `${hash}: el primer bloque de la izquierda es la fuente`);
      assert.equal(p.title, 'Fuente de navegador en Meld', `${hash}: título del bloque`);
      assert.equal(p.url, base + url, `${hash}: URL de la fuente`);
      assert.equal(p.copyBtn, true, `${hash}: la URL tiene botón de copiar`);
      assert.equal(p.sourcesOutsideLeftTop, 0, `${hash}: no hay bloques de fuente fuera de la columna izquierda`);
      assert.equal(p.oldName, false, `${hash}: ya no se llama «Capa de navegador»`);
      assert.ok(p.frames >= 1, `${hash}: tiene vista previa`);
      assert.equal(p.framesLeft, 0, `${hash}: ninguna vista previa en la columna izquierda`);
      assert.equal(p.framesRight, p.frames, `${hash}: todas las vistas previas a la derecha con su barra de título`);
      assert.equal(p.rightOfForm, true, `${hash}: la vista previa queda a la derecha del formulario`);
      await dom(chrome, `window.__copied = []; document.querySelector('main .browser-source .overlay-url button').click(); 'ok'`);
      await waitDom(chrome.cdp, `window.__copied.length === 1`, { timeoutMs: 5000 });
      assert.equal(await dom(chrome, `window.__copied[0]`), base + url, `${hash}: copia la URL`);
    }

    // Últimos y ticker: dos fuentes en el mismo bloque y dos vistas previas a la derecha
    await dom(chrome, `location.hash = '#/widget/latest'`);
    await waitDom(chrome.cdp, `!!document.querySelector('main .browser-source')`, { timeoutMs: 12000 });
    assert.equal(await dom(chrome, `Array.from(document.querySelectorAll('main .browser-source .overlay-url code')).map(c => c.textContent).join(' ')`), `${base}/widget/latest ${base}/widget/ticker`);
    assert.equal(await dom(chrome, `document.querySelectorAll('main .preview-col iframe').length`), 2);

    // Tier list sin listas: la pestaña «+ Nueva» también enseña la vista previa (datos de ejemplo)
    await dom(chrome, `location.hash = '#/widget/tierlist'`);
    await waitDom(chrome.cdp, `!!document.querySelector('#h-new')`, { timeoutMs: 12000 });
    assert.match(await dom(chrome, `document.querySelector('main .preview-col iframe')?.getAttribute('src') ?? ''`), /^\/widget\/tierlist\?demo$/);
    const { tierlist } = await api(base, 'POST', '/api/tierlists', { title: 'Lista O33', items: ['a'] });
    await waitDom(chrome.cdp, `document.querySelectorAll('[role=tablist][aria-label="Tier lists"] [role=tab]').length === 2`, { timeoutMs: 12000 });
    await dom(chrome, `document.querySelector('[role=tablist][aria-label="Tier lists"] [role=tab]').click()`);
    await waitDom(chrome.cdp, `(document.querySelector('main .preview-col iframe')?.getAttribute('src') ?? '').includes(${JSON.stringify('id=' + encodeURIComponent(tierlist.id))})`, { timeoutMs: 12000 });

    // las anclas del tour siguen en su sitio
    await dom(chrome, `location.hash = '#/widget/goals'`);
    await waitDom(chrome.cdp, `!!document.querySelector('[data-tour="goals-editor"] .widget-layout') && !!document.querySelector('[data-tour="goals-tabs"]') && !!document.querySelector('[data-tour="goals-head"]')`, { timeoutMs: 12000 });
  } finally {
    chrome?.child.kill(); await chrome?.cdp.close();
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
