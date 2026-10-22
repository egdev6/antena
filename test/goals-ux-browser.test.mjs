// O1 (odd/tasks/antena-ux-ajustes.md) · pruebas de navegador de los ajustes de objetivos:
// relleno recortado al carril (O1.2), color de plataforma del tema en las barras (O1.1),
// cabecera configurable (O1.3), barras actualizadas en su sitio para que cada una anime
// su subida (O1.6) y, en el panel, pestañas por objetivo (O1.7), hint de clases CSS (O1.4)
// y preview que se recarga al cambiar la config (O1.5).
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
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-o1-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const box = (id, title) => ({
  id, title, visible: true, showMetric: true, css: '',
  bars: [
    { id: `${id}-tw`, platform: 'twitch', metric: 'follows', target: 10, visible: true },
    { id: `${id}-yt`, platform: 'youtube', metric: 'superchats', target: 5, visible: true },
  ],
});
const putBox = async (app, patch) => { Object.assign(app.store.config.widgets.goals[0], patch); await app.store.save('widgets'); };

test('O1 overlay: relleno recortado, color de plataforma, cabecera configurable y barras actualizadas en su sitio', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.widgets.goals = [box('ux', 'Caja UX')];
    const theme = await fetch(`${base}/api/theme`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platformAccent: true, twitchColor: '#9146FF' }) });
    eq(theme.status, 200);
    const set = (barId, value) => fetch(`${base}/api/goals/ux/bars/${barId}/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) });
    await set('ux-tw', 2);
    await set('ux-yt', 1);

    chrome = await openChromePage(bin, `${base}/widget/goal?id=ux&debug`);
    await waitDom(chrome.cdp, `Array.from(document.querySelectorAll('#bars .pct')).map(e => e.textContent).join() === '2/10,1/5'`, { timeoutMs: 12000 });
    await waitDom(chrome.cdp, `document.getElementById('eg-theme').href.includes('v=')`, { timeoutMs: 12000 });

    // O1.2: el relleno recorta sus rayas (::after) en su propio borde redondeado
    eq(await dom(chrome, `Array.from(document.querySelectorAll('#bars .fill')).map(f => getComputedStyle(f).overflow).join()`), 'hidden,hidden');

    // O1.1: cada barra lleva la clase de su plataforma; con «color de cada plataforma» la de Twitch es morada
    eq(await dom(chrome, `Array.from(document.querySelectorAll('#bars .bar')).map(r => r.classList.contains('pf-' + r.dataset.platform) && r.dataset.platform).join()`), 'twitch,youtube');
    await waitDom(chrome.cdp, `getComputedStyle(document.querySelector('#bars .bar.pf-twitch .fill')).backgroundImage.includes('145, 70, 255')`, { timeoutMs: 12000 });

    // O1.3: sin campos nuevos, la cabecera es la de siempre
    eq(await dom(chrome, `[document.getElementById('kick').textContent, getComputedStyle(document.getElementById('kick')).display !== 'none', getComputedStyle(document.getElementById('title')).display !== 'none'].join()`), 'Objetivo,true,true');

    // O1.6: un cambio de valor actualiza la barra en su sitio y anima su anchura; la otra no se toca
    await dom(chrome, `window.__rows = Array.from(document.querySelectorAll('#bars .bar')); window.__fills = Array.from(document.querySelectorAll('#bars .fill')); 'ok'`);
    await set('ux-tw', 7);
    await waitDom(chrome.cdp, `document.querySelector('#bars .pct').textContent === '7/10'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `(() => { const r = Array.from(document.querySelectorAll('#bars .bar')), f = Array.from(document.querySelectorAll('#bars .fill')); return [r[0] === __rows[0], f[0] === __fills[0], r[1] === __rows[1], f[1] === __fills[1]].join(); })()`), 'true,true,true,true');
    eq(await dom(chrome, `__fills[0].style.width + ' ' + __fills[1].style.width`), '70% 20%');
    eq(await dom(chrome, `__fills[0].getAnimations().some(a => a.transitionProperty === 'width')`), true);
    eq(await dom(chrome, `__fills[1].getAnimations().some(a => a.transitionProperty === 'width')`), false);
    eq(await dom(chrome, `document.querySelectorAll('#bars .pct')[1].textContent`), '1/5');

    // barra nueva: se crea solo la nueva; barra quitada: se quita solo esa, el resto sigue siendo el mismo nodo
    app.store.config.widgets.goals[0].bars.push({ id: 'ux-tw2', platform: 'twitch', metric: 'subs', target: 4, visible: true });
    await app.store.save('widgets');
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .bar').length === 3`, { timeoutMs: 12000 });
    eq(await dom(chrome, `(() => { const r = Array.from(document.querySelectorAll('#bars .bar')); return [r[0] === __rows[0], r[1] === __rows[1], r.map(x => x.dataset.id).join('|')].join(); })()`), 'true,true,ux-tw|ux-yt|ux-tw2');
    app.store.config.widgets.goals[0].bars.splice(0, 1);
    await app.store.save('widgets');
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .bar').length === 2`, { timeoutMs: 12000 });
    eq(await dom(chrome, `(() => { const r = Array.from(document.querySelectorAll('#bars .bar')); return [r[0] === __rows[1], r.map(x => x.dataset.id).join('|')].join(); })()`), 'true,ux-yt|ux-tw2');
    // showMetric sigue aplicándose sobre las barras existentes
    await putBox(app, { showMetric: false });
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .metric').length === 0`, { timeoutMs: 12000 });
    await putBox(app, { showMetric: true });
    await waitDom(chrome.cdp, `document.querySelectorAll('#bars .metric').length === 2 && document.querySelector('#bars .metric').nextElementSibling.classList.contains('pct')`, { timeoutMs: 12000 });

    // O1.3: label editable y ocultable, título ocultable
    await putBox(app, { label: 'Meta del día' });
    await waitDom(chrome.cdp, `document.getElementById('kick').textContent === 'Meta del día'`, { timeoutMs: 12000 });
    await putBox(app, { showLabel: false, showTitle: false });
    await waitDom(chrome.cdp, `getComputedStyle(document.getElementById('kick')).display === 'none' && getComputedStyle(document.getElementById('title')).display === 'none'`, { timeoutMs: 12000 });
    await putBox(app, { label: '', showLabel: true, showTitle: true });
    await waitDom(chrome.cdp, `document.getElementById('kick').textContent === 'Objetivo' && getComputedStyle(document.getElementById('kick')).display !== 'none' && getComputedStyle(document.getElementById('title')).display !== 'none'`, { timeoutMs: 12000 });
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('O1 panel: pestañas por objetivo, + Nuevo objetivo, cabecera, hint CSS y preview que se recarga con la config', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.widgets.goals = [box('uno', 'Objetivo Uno'), box('dos', 'Objetivo Dos')];
    chrome = await openChromePage(bin, `${base}/#/widget/goals`);
    await waitDom(chrome.cdp, `!!document.querySelector('.goal-card')`, { timeoutMs: 12000 });

    // O1.7: una pestaña por objetivo y «+ Nuevo objetivo»; solo se edita la seleccionada
    const tabs = `Array.from(document.querySelectorAll('[role=tablist][aria-label="Objetivos"] [role=tab]'))`;
    eq(await dom(chrome, `${tabs}.map(x => x.textContent.trim()).join('|')`), 'Objetivo Uno|Objetivo Dos|+ Nuevo objetivo');
    eq(await dom(chrome, `document.querySelectorAll('.goal-card').length`), 1);
    eq(await dom(chrome, `document.querySelector('.goal-card h2').textContent`), 'Objetivo Uno');
    await dom(chrome, `${tabs}[1].click()`);
    await waitDom(chrome.cdp, `document.querySelector('.goal-card h2').textContent === 'Objetivo Dos' && ${tabs}[1].getAttribute('aria-selected') === 'true'`, { timeoutMs: 12000 });

    // O1.1 (panel): el logo de la leyenda va en línea con su texto
    eq(await dom(chrome, `getComputedStyle(document.querySelector('.goal-card legend svg')).display`), 'inline-block');

    // O1.4: hint de clases bajo el CSS del objetivo
    eq(await dom(chrome, `(() => { const h = document.querySelector('.goal-css .css-help')?.textContent || ''; return ['.goal', '.kick', '.title', '.bar', '.fill', '.metric', '.pct', '.done'].every(c => h.includes(c)); })()`), true);

    // O1.5: cambiar la config recarga la preview; cambiar solo el valor no
    await dom(chrome, `window.__frame = document.querySelector('.goal-card iframe'); 'ok'`);
    await dom(chrome, `${buttonByText('+1')}.click()`);
    await waitDom(chrome.cdp, `document.querySelector('.goal-card .gval').textContent === '1'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `document.querySelector('.goal-card iframe') === window.__frame`), true);
    await dom(chrome, `document.querySelectorAll('.goal-card .row2 input[type=checkbox]')[1].click()`);
    await waitDom(chrome.cdp, `document.querySelector('.goal-card iframe') !== window.__frame`, { timeoutMs: 12000 });
    await eventually(() => app.store.config.widgets.goals[1].showMetric, false);

    // O1.3 (panel): etiqueta editable, ocultar etiqueta y título
    await dom(chrome, `(() => { const i = document.querySelector('.goal-card input[aria-label="Etiqueta"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Meta'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
    await eventually(() => app.store.config.widgets.goals[1].label, 'Meta');
    await dom(chrome, `(() => { const l = Array.from(document.querySelectorAll('.goal-card label.check')); for (const t of ['Mostrar etiqueta', 'Mostrar título']) l.find(x => x.textContent.trim().startsWith(t)).querySelector('input').click(); return 'ok'; })()`);
    await eventually(() => app.store.config.widgets.goals[1].showLabel, false);
    await eventually(() => app.store.config.widgets.goals[1].showTitle, false);

    // O1.7: «+ Nuevo objetivo» crea la caja y la deja seleccionada
    await dom(chrome, `${tabs}.at(-1).click()`);
    await eventually(() => app.store.config.widgets.goals.length, 3);
    await waitDom(chrome.cdp, `${tabs}.length === 4 && ${tabs}[2].getAttribute('aria-selected') === 'true' && document.querySelector('.goal-card h2').textContent === 'Nuevo objetivo'`, { timeoutMs: 12000 });
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

async function eventually(read, expected, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let actual = await read();
  while (actual !== expected && Date.now() < until) { await sleep(50); actual = await read(); }
  eq(actual, expected);
}
function eq(actual, expected) { if (actual !== expected) throw new Error(`esperaba ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`); }
