// #128 · pruebas de navegador del overlay goal.html y del bloque Goals del panel:
// dos barras con metas diferentes, progreso real, visibilidad de caja y barra,
// showMetric, crear/editar/ocultar/borrar y add/set. Capturas temporales por ejecución.
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = await mkdtemp(path.join(tmpdir(), 'egdev-128-shots-'));
process.once('exit', code => {
  if (code === 0) rmSync(SHOTS, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  else console.error(`Screenshots retained at ${SHOTS}`);
});

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-128-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });

async function shot(chrome, name) {
  await mkdir(SHOTS, { recursive: true });
  const { data } = await chrome.cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(SHOTS, name), Buffer.from(data, 'base64'));
}

// La caja sintética: dos barras con metas distintas (10 y 5) y progreso real por eventos.
// Los cambios de config se persisten con store.save('widgets') para que el evento 'change'
// llegue al overlay por SSE (una mutación directa no notifica a los widgets).
const putBox = async (app, patch) => { Object.assign(app.store.config.widgets.goals[0], patch); await app.store.save('widgets'); };

test('overlay goal.html: caja con dos barras, progreso, visibilidad de caja/barra y showMetric', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    // Caja sintética de dos barras con metas distintas; progreso real vía eventos del motor.
    app.store.config.widgets.goals = [{
      id: 'mixta', title: 'Objetivo Mixto', visible: true, showMetric: true, css: '',
      bars: [
        { id: 'm-tw', platform: 'twitch', metric: 'follows', target: 10, visible: true },
        { id: 'm-yt', platform: 'youtube', metric: 'superchats', target: 5, visible: true },
      ],
    }];
    for (const ev of [{ type: 'follow', vars: {} }, { type: 'follow', vars: {} }, { type: 'follow', vars: {} }, { type: 'follow', vars: {} },
      { type: 'superchat', vars: { amount: 4 } }]) {
      app.engine.handleEvent({ externalId: 'sim:' + Math.random(), type: ev.type, vars: { ...ev.vars, user: 'Sintético' } });
    }
    await sleep(50);   // los eventos llegan al widget por SSE

    chrome = await openChromePage(bin, `${base}/widget/goal?id=mixta&debug`);
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .bar').length === 2`, { timeoutMs: 12000 });
    // progreso real: 4/10 = 40 % y 4/5 = 80 % — metas diferentes, anchos diferentes
    const widths = await dom(chrome, `Array.from(document.querySelectorAll('#bars .fill')).map(f => Math.round(parseFloat(f.style.width)))`);
    assert2(widths, [40, 80]);
    // #129: logos legibles y valores reales, no porcentajes ni valores recortados.
    assert2(await dom(chrome, `Array.from(document.querySelectorAll('#bars .pct')).map(e => e.textContent)`), ['4/10', '4/5']);
    assert2(await dom(chrome, `Array.from(document.querySelectorAll('#bars svg')).map(e => e.getAttribute('aria-label'))`), ['Twitch', 'YouTube']);
    assert2(await dom(chrome, `Array.from(document.querySelectorAll('#bars .bar')).every(e => e.getBoundingClientRect().height >= 48)`), true);
    // showMetric: la etiqueta «qué cuenta» aparece en ambas barras
    assert2(await dom(chrome, `document.querySelectorAll('#bars .metric').length`), 2);
    await shot(chrome, 'overlay-dos-barras.png');

    // showMetric=false: sin etiquetas de métrica
    await putBox(app, { showMetric: false });
    await sleep(80);
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .metric').length === 0`, { timeoutMs: 12000 });

    // barra invisible: solo queda una
    app.store.config.widgets.goals[0].bars[1].visible = false;
    await app.store.save('widgets');
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .bar').length === 1`, { timeoutMs: 12000 });
    await shot(chrome, 'overlay-barra-oculta.png');

    // F2: la caja oculta (visible:false) esconde TODAS sus barras, no solo filtra b.visible
    await putBox(app, { visible: false });
    await sleep(80);
    await waitDom(chrome.cdp, `document.getElementById('goal').style.display === 'none'`, { timeoutMs: 12000 });
    await shot(chrome, 'overlay-caja-oculta.png');
    // restaurar: al activar la caja vuelven las barras visibles
    await putBox(app, { visible: true });
    await sleep(80);
    await waitDom(chrome.cdp, `document.getElementById('goal').style.display === '' && document.querySelectorAll('#bars .bar').length === 1`, { timeoutMs: 12000 });
    await shot(chrome, 'overlay-caja-restaurada.png');
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

test('panel: el bloque Goals muestra cajas y barras; crear/editar/ocultar/borrar y add/set funcionan en la UI', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.widgets.goals = [{
      id: 'mixta', title: 'Objetivo Mixto', visible: true, showMetric: true, css: '',
      bars: [
        { id: 'm-tw', platform: 'twitch', metric: 'follows', target: 10, visible: true },
        { id: 'm-yt', platform: 'youtube', metric: 'superchats', target: 5, visible: true },
      ],
    }];
    chrome = await openChromePage(bin, `${base}/#/widgets/goal-mixta`);
    try {
      await waitDom(chrome.cdp, `!!document.querySelector('.goal-card')`, { timeoutMs: 12000 });
    } catch (e) {
      const diag = await evaluateChrome(chrome.cdp, `JSON.stringify({ hash: location.hash, texto: document.body.innerText.slice(0, 300) })`, { timeoutMs: 8000 }).catch(err => 'eval-fallo: ' + err.message);
      console.error('[diag panel]', diag);
      throw e;
    }
    // los botones de borrado usan confirm(): en headless sin manejador de diálogos
    // bloquearía el evaluador CDP — se sustituye por una versión que acepta siempre.
    await dom(chrome, `window.confirm = () => true; 'ok'`);
    // dos fieldsets (una por barra) y el valor «Ahora» por barra
    assert2(await dom(chrome, `document.querySelectorAll('.goal-card fieldset').length`), 2);
    await shot(chrome, 'panel-caja-dos-barras.png');
    // #129: labels de edición y CSS plegable mantienen contenido editable.
    assert2(await dom(chrome, `!!document.querySelector('.goal-css textarea') && !document.querySelector('.goal-css').open`), true);
    assert2(await dom(chrome, `!!document.querySelector('input[aria-label^="Fijar valor"]')`), true);
    await dom(chrome, `document.querySelector('.goal-css summary').click()`);
    assert2(await dom(chrome, `document.querySelector('.goal-css').open`), true);

    // add/set de barra desde la UI (botones +1 y Fijar de la primera barra)
    await dom(chrome, `${buttonByText('+1')}.click()`);
    await eventually(() => app.session.goalValue('follows', 'twitch'), 1);

    // ocultar la caja con su checkbox «Visible» y comprobar que persiste
    await dom(chrome, `(() => { const c = document.querySelector('.goal-card .row2 input[type=checkbox]'); if (!c) throw new Error('sin checkbox'); c.click(); return 'ok'; })()`);
    await eventually(() => app.store.config.widgets.goals[0].visible, false);

    // añadir y borrar barra desde la UI
    await dom(chrome, `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.trim().startsWith('+ Añadir barra')); if (!b) throw new Error('sin botón de añadir'); b.click(); return 'ok'; })()`);
    await waitDom(chrome.cdp, `document.querySelectorAll('.goal-card fieldset').length === 3`, { timeoutMs: 12000 });
    await dom(chrome, `(() => { const b = Array.from(document.querySelectorAll('.goal-card fieldset button')).find(x => x.textContent.includes('Borrar barra')); if (!b) throw new Error('sin botón de borrar barra'); b.click(); return 'ok'; })()`);
    await waitDom(chrome.cdp, `document.querySelectorAll('.goal-card fieldset').length === 2`, { timeoutMs: 12000 });
    await shot(chrome, 'panel-tras-anadir-borrar.png');

    // editar título desde la UI (LazyInput comita con debounce de 450 ms tras onChange)
    await dom(chrome, `(() => { const i = document.querySelector('.goal-card input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, 'Mixto Editado'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    for (let i = 0; i < 30 && app.store.config.widgets.goals[0].title !== 'Mixto Editado'; i++) await sleep(100);
    assert2(app.store.config.widgets.goals[0].title, 'Mixto Editado');
    // Ocultar una barra y «qué cuenta» desde el panel, sin borrar su meta.
    await dom(chrome, `document.querySelector('.goal-card fieldset input[type=checkbox]').click()`);
    await waitDom(chrome.cdp, `!document.querySelector('.goal-card fieldset input[type=checkbox]').checked`);
    await dom(chrome, `document.querySelectorAll('.goal-card .row2 input[type=checkbox]')[1].click()`);
    await waitDom(chrome.cdp, `!document.querySelectorAll('.goal-card .row2 input[type=checkbox]')[1].checked`);
    await eventually(() => app.store.config.widgets.goals[0].bars[0].visible, false);
    await eventually(() => app.store.config.widgets.goals[0].showMetric, false);
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 680, height: 1000, deviceScaleFactor: 1, mobile: false });
    assert2(await dom(chrome, `document.querySelector('.goal-card').scrollWidth <= document.querySelector('.goal-card').clientWidth`), true);
    await shot(chrome, '129-panel-estrecho.png');
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

test('#129: Directo agrupa cajas y respeta visibilidad; overlay conserva cero, negativos y metas superadas en estrecho', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    const title = 'Apoyos de una comunidad que comparte conocimiento · '.repeat(4);
    app.store.config.widgets.goals = [{
      id: 'mixta', title, visible: true, showMetric: true, css: '',
      bars: [
        { id: 'tw', platform: 'twitch', metric: 'follows', target: 20, visible: true },
        { id: 'yt', platform: 'youtube', metric: 'members', target: 5, visible: true },
      ],
    }];
    const set = (id, value) => fetch(`${base}/api/goals/mixta/bars/${id}/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }),
    });
    await set('tw', -2);
    await set('yt', 7);
    chrome = await openChromePage(bin, `${base}/widget/goal?id=mixta&debug`);
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .bar').length === 2`);
    assert2(await dom(chrome, `Array.from(document.querySelectorAll('.pct')).map(e => e.textContent)`), ['-2/20', '7/5']);
    assert2(await dom(chrome, `Array.from(document.querySelectorAll('.fill')).map(e => e.style.width)`), ['0%', '100%']);
    assert2(await dom(chrome, `document.querySelector('.goal').getBoundingClientRect().right <= innerWidth && document.querySelector('.goal').getBoundingClientRect().bottom <= innerHeight`), true);
    await shot(chrome, '129-overlay-estrecho-negativo-superado.png');
    await set('tw', 0);
    await set('yt', 5);
    await waitDom(chrome.cdp, `document.querySelector('.pct')?.textContent === '0/20'`);
    assert2(await dom(chrome, `document.querySelectorAll('.pct')[1].textContent`), '5/5');
    assert2(await dom(chrome, `document.querySelector('.goal').classList.contains('done')`), false);
    await set('tw', 20);
    await waitDom(chrome.cdp, `document.querySelector('.goal').classList.contains('done')`);
    await set('tw', 21);
    await waitDom(chrome.cdp, `document.querySelector('.pct')?.textContent === '21/20'`);
    assert2(await dom(chrome, `document.querySelector('.goal').classList.contains('done')`), true);
    await chrome.cdp.send('Page.navigate', { url: `${base}/#/directo` });
    await waitDom(chrome.cdp, `document.querySelectorAll('.goals .goal').length === 1`);
    assert2(await dom(chrome, `document.querySelectorAll('.goals .goal-bar').length`), 2);
    assert2(await dom(chrome, `document.querySelector('.goals .goal-title').textContent`), title);
    await shot(chrome, '129-directo-dos-barras.png');
    await putBox(app, { showMetric: false });
    await waitDom(chrome.cdp, `document.querySelectorAll('.goals .goal-metric').length === 0`);
    app.store.config.widgets.goals[0].bars[1].visible = false;
    await app.store.save('widgets');
    await waitDom(chrome.cdp, `document.querySelectorAll('.goals .goal-bar').length === 1`);
    await putBox(app, { visible: false });
    await waitDom(chrome.cdp, `document.querySelectorAll('.goals .goal').length === 0`);
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});

// Espera a que el valor guardado llegue (sondeo, no un sleep fijo): en un runner lento el guardado
// tras un clic tarda más de 300 ms (#83). Si no llega en el plazo, falla con el último valor visto.
async function eventually(read, expected, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let actual = await read();
  while (actual !== expected && Date.now() < until) { await sleep(50); actual = await read(); }
  assert2(actual, expected);
}

function assert2(actual, expected) {
  const { strictEqual, deepEqual } = await0();
  if (Array.isArray(expected)) deepEqual(actual, expected); else strictEqual(actual, expected);
}
function await0() { return { strictEqual: (a, b) => { if (a !== b) throw new Error(`esperaba ${b}, hubo ${a}`); }, deepEqual: (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`esperaba ${JSON.stringify(b)}, hubo ${JSON.stringify(a)}`); } }; }
