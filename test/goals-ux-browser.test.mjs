// O1 (odd/tasks/antena-ux-ajustes.md) · pruebas de navegador de los ajustes de objetivos:
// relleno recortado al carril (O1.2), color de plataforma del tema en las barras (O1.1),
// cabecera configurable (O1.3), barras actualizadas en su sitio para que cada una anime
// su subida (O1.6) y, en el panel, pestañas por objetivo (O1.7), hint de clases CSS (O1.4)
// y preview que se recarga al cambiar la config (O1.5).
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { goalsBrowserUi, seedTwitchTotals } from './helpers/goals-browser-app.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(t) {
  const ui = await goalsBrowserUi(t);
  if (!ui) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-o1-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), appDist: ui.dist, log: () => {} });
  await seedTwitchTotals(app);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin: ui.bin, app, base, close: async () => { app.timers.stop(); await app.channelTotals.flush(); app.server.closeAllConnections(); app.server.close(); } };
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
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('O1 panel: tabla de objetivos → slide, + Nuevo objetivo, cabecera, hint CSS y preview que se recarga con la config', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.widgets.goals = [box('uno', 'Objetivo Uno'), box('dos', 'Objetivo Dos')];
    // v2: los objetivos son una tabla dentro de la tarjeta «Objetivos»; cada uno abre su slide
    chrome = await openChromePage(bin, `${base}/#/widgets/objetivos`);
    const rows = `Array.from(document.querySelectorAll('[data-tour="goals-list"] tbody tr'))`;
    await waitDom(chrome.cdp, `${rows}.length === 2`, { timeoutMs: 12000 });
    eq(await dom(chrome, `${rows}.map(r => r.querySelector('.lv-open').textContent.trim()).join('|')`), 'Objetivo Uno|Objetivo Dos');
    await dom(chrome, `${rows}[1].querySelector('.lv-open').click()`);
    const title = `[...document.querySelectorAll('.lv-slide')].at(-1)?.querySelector('.lv-stitle h2')?.textContent`;
    await waitDom(chrome.cdp, `location.hash === '#/widgets/objetivos/dos' && ${title} === 'Objetivo Dos' && document.querySelectorAll('.goal-card').length === 1`, { timeoutMs: 12000 });

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
    await dom(chrome, `(() => { const l = Array.from(document.querySelectorAll('.goal-card label.switch')); for (const t of ['Mostrar etiqueta', 'Mostrar título']) l.find(x => x.textContent.trim().startsWith(t)).querySelector('input').click(); return 'ok'; })()`);
    await eventually(() => app.store.config.widgets.goals[1].showLabel, false);
    await eventually(() => app.store.config.widgets.goals[1].showTitle, false);

    // «+ Nuevo objetivo» abre el slide «Nuevo»; al crear, el objetivo nuevo se abre en su slide
    await dom(chrome, `location.hash = '#/widgets/objetivos/nuevo'`);
    await waitDom(chrome.cdp, `!!${buttonByText('Crear objetivo')}`, { timeoutMs: 12000 });
    await dom(chrome, `${buttonByText('Crear objetivo')}.click()`);
    await eventually(() => app.store.config.widgets.goals.length, 3);
    await waitDom(chrome.cdp, `location.hash.startsWith('#/widgets/objetivos/') && !location.hash.endsWith('/nuevo') && ${title} === 'Nuevo objetivo'`, { timeoutMs: 12000 });
    await dom(chrome, `location.hash = '#/widgets/objetivos'`);
    await waitDom(chrome.cdp, `${rows}.length === 3`, { timeoutMs: 12000 });
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

// #132: a never-read channel total is unknown, not zero, across overlay and panel.
test('S2/S5/S7 overlay: total desconocido, etiqueta, demo y lecturas posteriores', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.widgets.goals = [{ id: 'yt', title: 'Suscriptores', visible: true, showMetric: true,
      bars: [{ id: 'y', platform: 'youtube', metric: 'subscribers', target: 1000, visible: true }] }];
    chrome = await openChromePage(bin, `${base}/widget/goal?id=yt&debug`);
    await waitDom(chrome.cdp, `!!document.querySelector('#bars .pct')`);
    eq(await dom(chrome, `document.querySelector('.pct').textContent`), '—/1000');
    eq(await dom(chrome, `document.querySelector('.bar').title`), '— / 1000');
    eq(await dom(chrome, `document.querySelector('.fill').style.width`), '0%');
    eq(await dom(chrome, `document.querySelector('.metric').textContent`), 'Suscriptores');
    app.channelTotals.readers['subscribers@youtube'] = async () => 1234;
    await app.channelTotals.poll(['subscribers@youtube']);
    await waitDom(chrome.cdp, `document.querySelector('.pct').textContent === '1234/1000'`);
    eq(await dom(chrome, `document.querySelector('.fill').style.width`), '100%');
    app.channelTotals.readers['subscribers@youtube'] = async () => 0;
    await app.channelTotals.poll(['subscribers@youtube']);
    await waitDom(chrome.cdp, `document.querySelector('.pct').textContent === '0/1000'`);
    eq(await dom(chrome, `document.querySelector('.fill').style.width`), '0%');
    await chrome.cdp.send('Page.navigate', { url: `${base}/widget/goal?id=yt&debug&demo` });
    await waitDom(chrome.cdp, `document.querySelector('.pct')?.textContent === '700/1000'`);
    eq(await dom(chrome, `document.querySelector('.fill').style.width`), '70%');
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('S2/S5/S7 panel: — en lista, editor y Directo; opciones y etiqueta de suscriptores', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    app.store.config.widgets.goals = [{ id: 'yt', title: 'Meta YouTube', visible: true, showMetric: true,
      bars: [{ id: 'y', platform: 'youtube', metric: 'subscribers', target: 1000, visible: true }] }];
    chrome = await openChromePage(bin, `${base}/#/widgets/objetivos`);
    await waitDom(chrome.cdp, `!!document.querySelector('[data-tour="goals-list"] tbody tr')`);
    eq(await dom(chrome, `document.querySelector('[data-tour="goals-list"] tbody tr').textContent.includes('YT · suscriptores —/1000')`), true);
    eq(await dom(chrome, `document.body.textContent.includes('total del canal y no se reinician en cada directo')`), true);
    await dom(chrome, `location.hash = '#/widgets/objetivos/nuevo'`);
    await waitDom(chrome.cdp, `!!${buttonByText('Crear objetivo')}`);
    await dom(chrome, `(() => { const s = [...document.querySelectorAll('.lv-slide')].at(-1).querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'youtube'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    eq(await dom(chrome, `[...document.querySelectorAll('.lv-slide')].at(-1).querySelectorAll('select')[1].selectedOptions[0].textContent`), 'Suscriptores');
    await dom(chrome, `location.hash = '#/widgets/objetivos/yt'`);
    await waitDom(chrome.cdp, `!!document.querySelector('.goal-card fieldset')`);
    eq(await dom(chrome, `document.querySelector('.goal-card .gval').textContent`), '—');
    eq(await dom(chrome, `Array.from(document.querySelectorAll('.goal-card fieldset select')[1].options).map(o => o.value + ':' + o.textContent).join('|')`),
      'subscribers:Suscriptores|superchats:Super Chats (€)|members:Miembros|events:Eventos');
    await dom(chrome, `location.hash = '#/directo'`);
    await waitDom(chrome.cdp, `!!document.querySelector('.goals .goal-bar')`);
    eq(await dom(chrome, `document.querySelector('.goals .goal-bar b').textContent`), '—/1000');
    eq(await dom(chrome, `document.querySelector('.goals .goal-metric').textContent`), ' · Suscriptores');
    eq(await dom(chrome, `document.querySelector('.goals [role=progressbar]').getAttribute('aria-valuenow')`), '0');
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('S7/S8 panel: error de lectura y Fijar sin lectura, con corrección persistente', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    app.store.config.widgets.goals = [{ id: 'yt', title: 'Meta', visible: true, showMetric: true,
      bars: [{ id: 'y', platform: 'youtube', metric: 'subscribers', target: 1000, visible: true },
        { id: 'bits', platform: 'twitch', metric: 'bits', target: 100, visible: true }] }];
    app.channelTotals.readers['subscribers@youtube'] = async () => { throw new Error('YouTube no responde'); };
    await app.channelTotals.poll(['subscribers@youtube']);
    chrome = await openChromePage(bin, `${base}/#/widgets/objetivos/yt`);
    await waitDom(chrome.cdp, `!!document.querySelector('.goal-card fieldset')`);
    eq(await dom(chrome, `document.querySelector('.goal-card fieldset').textContent.includes('YouTube no responde')`), true);
    eq(await dom(chrome, `/total.*canal/i.test(document.querySelector('.goal-card fieldset').textContent) && /corrección persistente/i.test(document.querySelector('.goal-card fieldset').textContent)`), true);
    eq(await dom(chrome, `/corrección persistente|YouTube no responde/i.test(document.querySelectorAll('.goal-card fieldset')[1].textContent)`), false);
    const status = () => fetch(`${base}/api/status`).then(r => r.json());
    const before = (await status()).channelTotals['subscribers@youtube'];
    const rejected = await fetch(`${base}/api/goals/yt/bars/y/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 5 }) });
    eq(rejected.status, 409);
    const message = (await rejected.json()).error;
    eq(message, 'Aún no se conoce el total de la plataforma: conecta la cuenta y espera a la primera lectura antes de fijar el valor.');
    eq(JSON.stringify((await status()).channelTotals['subscribers@youtube']), JSON.stringify(before));
    await dom(chrome, `[...document.querySelectorAll('.goal-card fieldset button')].find(b => b.textContent.trim() === 'Fijar').click()`);
    await waitDom(chrome.cdp, `document.querySelector('.toast.on.err')?.textContent === ${JSON.stringify(message)}`);
    eq(await dom(chrome, `document.querySelector('.goal-card .gval').textContent`), '—');
    await dom(chrome, `(() => { const original = window.fetch; window.fetch = (...args) => { const request = original(...args); if (String(args[0]).endsWith('/bars/y/add')) window.__adjusted = request; return request; }; ${buttonByText('−1')}.click(); })()`);
    eq(await dom(chrome, `window.__adjusted.then(r => r.status)`), 200);
    eq((await status()).channelTotals['subscribers@youtube'].value, null);
    app.channelTotals.readers['subscribers@youtube'] = async () => 10;
    await app.channelTotals.poll(['subscribers@youtube']);
    await waitDom(chrome.cdp, `document.querySelector('.goal-card .gval').textContent === '9'`);
    eq((await status()).channelTotals['subscribers@youtube'].value, 9);
    eq(await dom(chrome, `document.querySelector('.goal-card fieldset').textContent.includes('YouTube no responde')`), false);
    app.channelTotals.readers['subscribers@youtube'] = async () => { throw new Error('YouTube no responde'); };
    await app.channelTotals.poll(['subscribers@youtube']);
    await waitDom(chrome.cdp, `document.querySelector('.goal-card fieldset').textContent.includes('YouTube no responde')`);
    eq(await dom(chrome, `document.querySelector('.goal-card .gval').textContent`), '9');
    const next = await fetch(`${base}/api/session/new`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    eq(next.status, 200);
    eq((await status()).channelTotals['subscribers@youtube'].value, 9);
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

async function eventually(read, expected, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let actual = await read();
  while (actual !== expected && Date.now() < until) { await sleep(50); actual = await read(); }
  eq(actual, expected);
}
function eq(actual, expected) { if (actual !== expected) throw new Error(`esperaba ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`); }

// Cambiar la plataforma de una barra (p. ej. una recién añadida, Twitch · Seguidores) a YouTube
// tiene que guardarse con una métrica válida allí: si no, el servidor lo rechaza, la barra sigue
// siendo Twitch · Seguidores y «Fijar» en otra barra de Twitch parece cambiarlas todas. Y si el
// servidor rechaza un cambio, el panel vuelve al valor guardado en vez de mostrar uno que no existe.
test('O1 panel: cambiar la plataforma de una barra se guarda con una métrica válida y Fijar solo toca su barra', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    await putBox(app, { id: 'mixta', title: 'Mixta', bars: [
      { id: 'b1', platform: 'twitch', metric: 'follows', target: 200, visible: true },
      { id: 'b2', platform: 'twitch', metric: 'follows', target: 1000, visible: true },
    ] });
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/widgets/objetivos/mixta`);
    const fs = i => `document.querySelectorAll('.goal-card fieldset')[${i}]`;
    await waitDom(chrome.cdp, `document.querySelectorAll('.goal-card fieldset').length === 2`, { timeoutMs: 15000 });
    const pick = (i, value) => `(() => { const s = ${fs(i)}.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`;
    const bar = id => app.store.config.widgets.goals[0].bars.find(b => b.id === id);

    // la segunda barra pasa a YouTube: el servidor la guarda con una métrica de YouTube
    await dom(chrome, pick(1, 'youtube'));
    for (let i = 0; i < 50 && bar('b2').platform !== 'youtube'; i++) await sleep(100);
    eq(bar('b2').platform, 'youtube');
    eq(bar('b2').metric, 'subscribers');
    await waitDom(chrome.cdp, `${fs(1)}.querySelector('legend').textContent.includes('YouTube')`, { timeoutMs: 9000 });
    // and the overlay in the preview draws that bar with the YouTube logo and colour
    const rows = `document.querySelector('.goal-card iframe')?.contentDocument?.querySelectorAll('#bars .bar')`;
    await waitDom(chrome.cdp, `${rows}?.length === 2 && ${rows}[0].classList.contains('pf-twitch') && ${rows}[1].classList.contains('pf-youtube') && ${rows}[1].querySelector('svg')?.getAttribute('aria-label') === 'YouTube'`, { timeoutMs: 12000 });

    // «Fijar 106» en la barra de Twitch solo cambia esa barra
    await dom(chrome, `(() => { const i = ${fs(0)}.querySelector('.goal-set-value'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '106'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await dom(chrome, `[...${fs(0)}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Fijar').click()`);
    for (let i = 0; i < 50 && app.session.goalValue('follows', 'twitch') !== 106; i++) await sleep(100);
    eq(app.session.goalValue('follows', 'twitch'), 106);
    const values = app.engine.widgetState().goals[0].bars;
    eq(values.find(b => b.id === 'b1').value, 106);
    eq(values.find(b => b.id === 'b2').value, null);

    // un cambio rechazado (meta 0) vuelve al valor guardado y se avisa
    const meta = `${fs(0)}.querySelector('input[type=number]')`;
    await dom(chrome, `(() => { const i = ${meta}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '0'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await waitDom(chrome.cdp, `!!document.querySelector('.toast.on.err')`, { timeoutMs: 9000 });
    await waitDom(chrome.cdp, `${meta}.value === '200'`, { timeoutMs: 9000 });
    eq(bar('b1').target, 200);
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});
