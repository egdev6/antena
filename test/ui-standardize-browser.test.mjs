// O3.2 (odd/tasks/antena-ux-ajustes.md) · secciones con varios objetos en pestañas (ItemTabs):
// una pestaña por elemento, al pulsarla cambia el editor, «+ Nuevo…» crea y selecciona el nuevo
// y al borrar la selección sigue siendo válida.
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-o3-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Espera a que una condición del lado del servidor se cumpla (guardados con debounce de 500 ms).
async function until(fn, what, timeoutMs = 6000) {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) if (fn()) return;
  throw new Error('no se cumplió: ' + what);
}
const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const api = (base, method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`); return r.json(); });
const tabsOf = label => `Array.from(document.querySelectorAll('[role=tablist][aria-label=${JSON.stringify(label)}] [role=tab]'))`;
const tabTexts = label => `${tabsOf(label)}.map(x => x.textContent.trim()).join('|')`;
const selectedTab = label => `(${tabsOf(label)}.find(x => x.getAttribute('aria-selected') === 'true')?.textContent.trim() ?? '')`;
// confirm() nativo: en headless se acepta siempre y se guarda el texto para comprobar la redacción
const acceptConfirms = `(() => { window.__confirms = []; window.confirm = m => { window.__confirms.push(m); return true; }; return 'ok'; })()`;

// Jerarquía v2: las colecciones (tier lists, guiones) son una lista y cada elemento se abre en un
// slide; «+ Nueva…» abre el slide de creación y al crear se abre el nuevo; al borrar se vuelve a la lista.
const rowNames = `[...document.querySelectorAll('main .lv-list tbody tr .lv-open')].map(a => a.textContent.trim()).join('|')`;
const slideTitle = `(document.querySelector('.lv-slide .lv-stitle h2')?.textContent.trim() || document.querySelector('.lv-slide .lv-stitle h2 input')?.value || '')`;
const setInput = (sel, v) => `(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`;

test('v2 tier lists: lista → slide, + Nueva tier list y borrado', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    await api(base, 'POST', '/api/tierlists', { title: 'Lista A', items: ['x'] });
    await api(base, 'POST', '/api/tierlists', { title: 'Lista B', items: ['y'] });
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/tierlist`);
    await waitDom(chrome.cdp, `${rowNames} === 'Lista A|Lista B'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `!!document.querySelector('.lv-slide')`), false);

    // abrir una: el slide de esa lista
    await dom(chrome, `[...document.querySelectorAll('main .lv-list .lv-open')][1].click()`);
    await waitDom(chrome.cdp, `${slideTitle} === 'Lista B'`, { timeoutMs: 12000 });

    // «+ Nueva tier list»: slide de creación; al crear se abre la nueva
    await dom(chrome, `[...document.querySelectorAll('main .view-head a')].find(a => a.textContent.trim() === '+ Nueva tier list').click()`);
    await waitDom(chrome.cdp, `location.hash === '#/tierlist/nueva' && ${slideTitle} === 'Nueva tier list'`, { timeoutMs: 12000 });
    await dom(chrome, setInput('.lv-slide label input', 'Lista C'));
    await dom(chrome, `${buttonByText('Crear tier list')}.click()`);
    await waitDom(chrome.cdp, `${slideTitle} === 'Lista C' && ${rowNames} === 'Lista A|Lista B|Lista C' && !!${buttonByText('Borrar lista…')}`, { timeoutMs: 12000 });

    // borrar: pregunta, cierra el slide y la lista queda sin ella
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${buttonByText('Borrar lista…')}.click()`);
    await waitDom(chrome.cdp, `location.hash === '#/tierlist' && !document.querySelector('.lv-slide') && ${rowNames} === 'Lista A|Lista B'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `window.__confirms[0]`), '¿Borrar «Lista C»?');
    eq(app.interactive.s.tierlists.map(x => x.title).join('|'), 'Lista A|Lista B');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('v2 teleprompter: pestañas para elegir el activo, guiones en lista → slide y el último no se borra', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    const first = (await api(base, 'GET', '/api/teleprompter')).scripts[0];
    await api(base, 'POST', '/api/teleprompter/scripts', { title: 'Guion B', select: false });
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/teleprompter`);
    const L = 'Guiones';
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3`, { timeoutMs: 12000 });
    eq(await dom(chrome, tabTexts(L)), `${first.title}|Guion B|+ Nuevo guion`);
    eq(await dom(chrome, selectedTab(L)), first.title);
    // item tabs share the underlined style of the alert editor tabs, not the segmented one
    const tabClasses = `[...document.querySelector('[role=tablist][aria-label=${JSON.stringify(L)}]').classList].filter(c => c.startsWith('eg-tabs')).join(' ')`;
    eq(await dom(chrome, tabClasses), 'eg-tabs');
    eq(await dom(chrome, `!!document.querySelector('select#tp-guion')`), false);

    // elegir otra pestaña cambia el guion activo
    await waitDom(chrome.cdp, `!!${tabsOf(L)}[1]`, { timeoutMs: 9000 });
    await dom(chrome, `${tabsOf(L)}[1]?.click(); 'ok'`);
    await waitDom(chrome.cdp, `${selectedTab(L)} === 'Guion B'`, { timeoutMs: 12000 });
    eq(app.teleprompter.snapshot().script.title, 'Guion B');

    // «+ Nuevo guion» abre el slide de creación en la pestaña Guiones; al crear se abre el nuevo
    await dom(chrome, `${tabsOf(L)}.at(-1)?.click(); 'ok'`);
    await waitDom(chrome.cdp, `location.hash === '#/teleprompter/guiones/nuevo' && ${slideTitle} === 'Nuevo guion'`, { timeoutMs: 12000 });
    await waitDom(chrome.cdp, `!!${buttonByText('Crear guion')}`, { timeoutMs: 9000 });
    await dom(chrome, `${buttonByText('Crear guion')}?.click(); 'ok'`);
    await waitDom(chrome.cdp, `${slideTitle} === 'Nuevo guion' && ${rowNames}.split('|').length === 3 && !!${buttonByText('Borrar guion…')}`, { timeoutMs: 12000 });

    // borrar: pregunta y vuelve a la lista
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${buttonByText('Borrar guion…')}?.click(); 'ok'`);
    await waitDom(chrome.cdp, `location.hash === '#/teleprompter/guiones' && !document.querySelector('.lv-slide') && ${rowNames} === ${JSON.stringify(first.title + '|Guion B')}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `window.__confirms[0]`), '¿Borrar «Nuevo guion»?');

    // el último guion no se puede borrar
    await dom(chrome, `[...document.querySelectorAll('main .lv-list .lv-open')].find(a => a.textContent.trim() === 'Guion B')?.click(); 'ok'`);
    await waitDom(chrome.cdp, `${slideTitle} === 'Guion B' && !!${buttonByText('Borrar guion…')}`, { timeoutMs: 12000 });
    await dom(chrome, `${buttonByText('Borrar guion…')}?.click(); 'ok'`);
    await waitDom(chrome.cdp, `${rowNames} === ${JSON.stringify(first.title)}`, { timeoutMs: 12000 });
    await dom(chrome, `document.querySelector('main .lv-list .lv-open')?.click(); 'ok'`);
    await waitDom(chrome.cdp, `${slideTitle} === ${JSON.stringify(first.title)} && !!${buttonByText('Borrar guion…')}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `${buttonByText('Borrar guion…')}.disabled`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('atajos (v2): lista en «Mis atajos» con Probar, «+ Nuevo atajo» en la cabecera y cada atajo en su slide', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    await api(base, 'POST', '/api/shortcuts', { name: 'Uno', steps: [{ kind: 'builtin', action: 'marca' }, { kind: 'builtin', action: 'pausa' }] });
    await api(base, 'POST', '/api/shortcuts', { name: 'Dos', steps: [{ kind: 'builtin', action: 'saltar' }] });
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/atajos`);
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const list = `document.querySelector('[data-tour="atajos-list"]')`;
    const rows = `[...${list}.querySelectorAll('tbody tr')]`;
    const slide = `document.querySelector('.lv-slide')`;
    const btnIn = (scope, text) => `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const save = `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary')`;
    await waitDom(chrome.cdp, `!!${list} && ${rows}.length === 2`, { timeoutMs: 15000 });

    // pestañas de página, sin pestañas por atajo; «+ Nuevo atajo» vive en la cabecera
    eq((await dom(chrome, tabTexts('Partes de la página'))).replace(/\d+/g, ''), 'Mis atajos|De serie|Cómo ponerlo en el Stream Deck');
    eq(await dom(chrome, `!!document.querySelector('[role=tablist][aria-label="Atajos"]')`), false);
    eq(await dom(chrome, `[...document.querySelectorAll('.view-head a')].some(a => a.textContent.trim() === '+ Nuevo atajo')`), true);
    eq(await dom(chrome, rowNames), 'Uno|Dos');
    eq(await dom(chrome, `${rows}.every(r => !!${btnIn('r', 'Probar')})`), true);
    eq(await dom(chrome, `${rows}[0].querySelector('.lv-mono').textContent`), `/sd/custom/${app.store.config.shortcuts[0].id}`);
    eq(await dom(chrome, `!!${slide}`), false);

    // Probar desde la lista ejecuta sus pasos y lo avisa
    await dom(chrome, `${btnIn(`${rows}[0]`, 'Probar')}.click()`);
    await waitDom(chrome.cdp, `document.querySelector('.toast.on')?.textContent.includes('Hecho')`, { timeoutMs: 9000 });
    eq(app.session.data.notes.some(n => n.kind === 'marker'), true);

    // abrir un atajo: su slide; los pasos se reordenan y se guardan con «Guardar»
    await dom(chrome, `${rows}[0].querySelector('.lv-open').click()`);
    await waitDom(chrome.cdp, `${slide}?.querySelector('input[aria-label="Nombre del atajo"]')?.value === 'Uno'`, { timeoutMs: 9000 });
    await dom(chrome, `${slide}.querySelectorAll('.action')[0].querySelector('[aria-label="Bajar"]').click()`);
    await waitDom(chrome.cdp, `!${save}.disabled`, { timeoutMs: 9000 });
    await dom(chrome, `${save}.click()`);
    // «disabled» también ocurre mientras se guarda; esperar la confirmación del pie.
    await waitDom(chrome.cdp, `${save}.disabled && document.querySelector('.lv-slide .lv-sfoot [role="status"]')?.textContent === 'Todo guardado'`, { timeoutMs: 9000 });
    eq(app.store.config.shortcuts[0].steps.map(x => x.action).join('|'), 'pausa|marca');

    // salir con pasos sin guardar pregunta; si se rechaza el slide sigue abierto, si se acepta se descartan
    await dom(chrome, `${slide}.querySelectorAll('.action')[0].querySelector('[aria-label="Bajar"]').click()`);
    await waitDom(chrome.cdp, `!${save}.disabled`, { timeoutMs: 9000 });
    await dom(chrome, `(() => { window.__confirms = []; window.confirm = m => { window.__confirms.push(m); return false; }; return 'ok'; })()`);
    await dom(chrome, `document.querySelector('.lv-drawer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    eq(await dom(chrome, `!!${slide}`), true);
    eq(await dom(chrome, `window.__confirms[0]`), 'Tienes cambios sin guardar. ¿Salir y descartarlos?');
    await dom(chrome, acceptConfirms);
    await dom(chrome, `document.querySelector('.lv-slide a[aria-label="Volver"]').click()`);
    await waitDom(chrome.cdp, `!${slide} && location.hash === '#/atajos'`, { timeoutMs: 9000 });
    eq(app.store.config.shortcuts[0].steps.map(x => x.action).join('|'), 'pausa|marca');

    // «+ Nuevo atajo»: el slide pide el nombre y, al crear, abre el atajo nuevo
    await dom(chrome, `[...document.querySelectorAll('.view-head a')].find(a => a.textContent.trim() === '+ Nuevo atajo').click()`);
    await waitDom(chrome.cdp, `location.hash === '#/atajos/nuevo' && !!${slide}?.querySelector('label input')`, { timeoutMs: 9000 });
    await dom(chrome, setInput('.lv-slide label input', 'Tres'));
    await dom(chrome, `${buttonByText('Crear atajo')}.click()`);
    await waitDom(chrome.cdp, `${slide}?.querySelector('input[aria-label="Nombre del atajo"]')?.value === 'Tres' && ${rows}.length === 3 && !!${buttonByText('Borrar atajo…')}`, { timeoutMs: 9000 });

    // borrar desde su slide
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${buttonByText('Borrar atajo…')}.click()`);
    await waitDom(chrome.cdp, `!${slide} && ${rows}.length === 2`, { timeoutMs: 9000 });
    eq(await dom(chrome, `window.__confirms[0]`), '¿Borrar «Tres»?');
    eq(app.store.config.shortcuts.map(x => x.name).join('|'), 'Uno|Dos');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('O3.2 EmptyState: las listas vacías usan el mismo estado vacío (eg-post--empty)', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.commands = [];
    app.store.config.timers = [];
    chrome = await openChromePage(bin, `${base}/#/comandos`);
    const empty = `Array.from(document.querySelectorAll('main .eg-post--empty.empty-state')).map(e => e.textContent.trim())`;
    await waitDom(chrome.cdp, `${empty}.some(x => x.startsWith('Todavía no hay comandos'))`, { timeoutMs: 12000 });
    eq(await dom(chrome, `document.querySelectorAll('li.empty, li.hint').length`), 0);
    await dom(chrome, `location.hash = '#/historial'`);
    await waitDom(chrome.cdp, `${empty}.includes('Todavía no ha llegado ninguna alerta.')`, { timeoutMs: 12000 });
    await dom(chrome, `location.hash = '#/sorteo'`);
    await waitDom(chrome.cdp, `${empty}.includes('Aún no se ha sorteado.') && ${empty}.includes('Sin sorteos anteriores.')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `getComputedStyle(document.querySelector('main .empty-state')).cursor`), 'default');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('botones eg-btn en todas las vistas y Comandos y Mensajes como lista → slide (v2)', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    await api(base, 'POST', '/api/commands', { trigger: '!web', title: 'web', text: '{user}' });
    await api(base, 'POST', '/api/timers', { name: 'Recordatorio', message: 'Sigue el canal' });
    await api(base, 'POST', '/api/shortcuts', { name: 'Uno', steps: [{ kind: 'builtin', action: 'marca' }] });
    chrome = await openChromePage(bin, `${base}/#/comandos`);
    const row = `document.querySelector('main .lv-list tbody tr')`;
    // cada fila: nombre que abre el slide y la acción rápida como eg-btn
    await waitDom(chrome.cdp, `${row}?.querySelector('.lv-open')?.textContent === '!web'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `Array.from(${row}.querySelectorAll('.eg-btn.eg-btn--ghost.eg-btn--sm')).map(b => b.textContent.trim()).join('|')`), 'Probar');
    await dom(chrome, `${row}.querySelector('.lv-open').click()`);
    await waitDom(chrome.cdp, `!!document.querySelector('.lv-slide')`, { timeoutMs: 12000 });
    await dom(chrome, `location.hash = '#/mensajes'`);
    await waitDom(chrome.cdp, `${row}?.querySelector('.lv-open')?.textContent === 'Recordatorio'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `Array.from(${row}.querySelectorAll('.eg-btn')).map(b => b.textContent.trim()).join('|')`), 'Enviar ahora');
    for (const hash of ['#/comandos', '#/mensajes', '#/atajos', '#/alertas', '#/widgets', '#/conexiones', '#/general', '#/fuentes', '#/historial', '#/directos', '#/archivos', '#/chat', '#/prompter', '#/meld', '#/filtros']) {
      await dom(chrome, `location.hash = ${JSON.stringify(hash)}`);
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(hash)} && !!document.querySelector('main h1') && !document.querySelector('main p.hint')?.textContent.startsWith('Cargando')`, { timeoutMs: 12000 });
      eq(await dom(chrome, `${JSON.stringify(hash)} + ':' + document.querySelectorAll('main .btn').length`), `${hash}:0`);
    }
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('O3.2 css-help: cada campo de CSS lista las clases de su widget', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/widgets/latest`);
    const helps = `Array.from(document.querySelectorAll('main .css-help')).map(h => h.textContent)`;
    const has = (i, classes) => `(${helps}[${i}] || '').length > 0 && ${JSON.stringify(classes)}.every(c => ${helps}[${i}].includes(c))`;
    await waitDom(chrome.cdp, `${helps}.length === 2`, { timeoutMs: 12000 });
    eq(await dom(chrome, has(0, ['.root', '.item', '.kick', '.big', '.extra', '.flash'])), true);
    eq(await dom(chrome, has(1, ['.band', '.label', '.track', '.run', '.it', '.k'])), true);
    await dom(chrome, `location.hash = '#/widgets/credits'`);
    await waitDom(chrome.cdp, `${helps}.length === 1 && ${has(0, ['.roll', '.head', '.grp', '.end', '.kick', '.big', '.sub', '.hl'])}`, { timeoutMs: 12000 });
    // el editor de alertas (slide) tiene su pestaña CSS con la ayuda de clases
    await dom(chrome, `location.hash = '#/alertas/follow/css'`);
    await waitDom(chrome.cdp, `!!document.querySelector('.lv-slide .css-help')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `['.alert', '.alert-box', '.alert-title', '.alert-name', '.alert-sub'].every(c => document.querySelector('.lv-slide .css-help').textContent.includes(c))`), true);
    // #15: el CSS propio del prompter también lista sus clases, justo debajo de su campo
    await dom(chrome, `location.hash = '#/prompter/vista'`);
    const prHelp = `document.querySelector('main textarea.code')?.closest('label')?.nextElementSibling`;
    await waitDom(chrome.cdp, `${prHelp}?.classList.contains('css-help') === true`, { timeoutMs: 12000 });
    eq(await dom(chrome, `['.pr', '.pr-top', '.pr-main', '.pr-chat', '.eg-timeline__item', '.pr-send', '.pr-side', '.pr-pane', '.ev-pane', '.ev-block', '.ev-item'].every(c => ${prHelp}.textContent.includes(c))`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('#15 la espera de Espectadores es un Status neutro, no un p.hint suelto', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(fileURLToPath(new URL('../app/src/panel/views/Espectadores.tsx', import.meta.url)), 'utf8');
  const wait = src.split('\n').find(l => l.includes('El servidor no ha mandado aún el estado de espectadores.')) ?? '';
  eq(/<Status tone="neutral"[^>]*>El servidor no ha mandado aún el estado de espectadores\.<\/Status>/.test(wait), true);
  eq(wait.includes('className="hint"'), false);
});

test('esqueleto común: la miga empieza por el grupo de la barra lateral, interruptores y sin márgenes en línea', { timeout: 180000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/chat`);
    await waitDom(chrome.cdp, `!!document.querySelector('#nav a[href="#/acerca"]')`, { timeoutMs: 12000 });
    const links = await dom(chrome, `JSON.stringify(Array.from(document.querySelectorAll('#nav .nav-grp')).flatMap(g => Array.from(g.querySelectorAll('a.eg-menu__item')).map(a => [a.getAttribute('href'), g.querySelector('.grp-l').textContent.trim(), a.querySelector('.eg-menu__label').textContent.trim()])))`);
    eq(JSON.parse(links).length > 0, true);
    const bad = [];
    for (const [href, group, label] of JSON.parse(links)) {
      if (href === '#/directo') continue;   // el tablero lleva el estado del directo en la miga
      await dom(chrome, `location.hash = ${JSON.stringify(href)}`);
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(href)} && !!document.querySelector('main .view-head h1') && !document.querySelector('main > p.hint')`, { timeoutMs: 12000 });
      const got = JSON.parse(await dom(chrome, `JSON.stringify({ crumb: document.querySelector('main .view-head .crumb')?.textContent.trim(), h1: document.querySelector('main .view-head h1')?.textContent.trim() || document.querySelector('main .view-head h1 input')?.value, order: Array.from(document.querySelector('main .view-head > div').children).map(e => e.tagName).join(','), margins: Array.from(document.querySelectorAll('main [style]')).filter(e => /margin/.test(e.getAttribute('style'))).length, checks: document.querySelectorAll('main .switch').length })`));
      // v2: «grupo», «grupo · resumen» (p. ej. «Configurar · 3 comandos») o «grupo › vista»
      const crumbOk = got.crumb === group || got.crumb?.startsWith(`${group} · `) || got.crumb === `${group} › ${label}`;
      if (!crumbOk || got.h1 !== label || !/^SPAN,H1(,P)?$/.test(got.order) || got.margins) bad.push({ href, ...got, want: `${group} › ${label}` });
    }
    eq(JSON.stringify(bad), '[]');
    // ajustes de sí/no: interruptor (Switch), no casilla suelta
    for (const [hash, n] of [['#/filtros', 1], ['#/prompter/vista', 2], ['#/meld', 1], ['#/widgets/chat', 4]]) {
      await dom(chrome, `location.hash = ${JSON.stringify(hash)}`);
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(hash)} && !!document.querySelector('main .view-head h1')`, { timeoutMs: 12000 });
      eq(await dom(chrome, `${JSON.stringify(hash)} + ':' + (document.querySelectorAll('main label.switch').length >= ${n}) + ':' + document.querySelectorAll('main label.check:not(:has(+ label.check)):not(label.check + label.check)').length`), `${hash}:true:0`);
    }
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

// #16: gramática de controles. Tier (4 opciones fijas) y destino del mensaje (3) son Seg;
// el tipo de acción sigue siendo select (lista larga) pero con su propia etiqueta.
test('#16 Tier y destino del mensaje son Seg; el tipo de acción lleva aria-label', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    const { variation } = await api(base, 'POST', '/api/alerts/sub/variations', { name: 'Tier' });
    await api(base, 'PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: 'hola' }] });
    await api(base, 'POST', '/api/shortcuts', { name: 'Chat', steps: [{ kind: 'chat', text: 'x' }] });
    app.store.config.panel = { onboardingDone: true };
    const seg = (scope, label) => `${scope}.querySelector('[role=radiogroup][aria-label=${JSON.stringify(label)}]')`;
    const radios = group => `[...${group}.querySelectorAll('[role=radio]')]`;

    chrome = await openChromePage(bin, `${base}/#/alertas/sub/v/${variation.id}`);
    const tier = seg('document', 'Tier');
    await waitDom(chrome.cdp, `!!${tier}`, { timeoutMs: 15000 });
    eq(await dom(chrome, `${radios(tier)}.map(b => b.textContent.trim()).join('|')`), 'Cualquiera|Tier 1|Tier 2|Tier 3');
    eq(await dom(chrome, `${radios(tier)}.filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.textContent.trim()).join('|')`), 'Cualquiera');
    eq(await dom(chrome, `!!${tier}.closest('.field-ctl')?.parentElement.classList.contains('lbl')`), true);
    await dom(chrome, `${radios(tier)}.find(b => b.textContent.trim() === 'Tier 2').click()`);
    // guardado manual (v2): se guarda con «Guardar»
    await waitDom(chrome.cdp, `!document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`, { timeoutMs: 9000 });
    await dom(chrome, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').click()`);
    await until(() => String(app.store.config.alerts.sub.variations[0].conditions.tier) === '2', "conditions.tier = '2' guardado");
    eq(await dom(chrome, `${radios(tier)}.find(b => b.getAttribute('aria-checked') === 'true')?.textContent.trim()`), 'Tier 2');

    // guardado terminado antes de salir (si no, el aviso de cambios sin guardar bloquea la navegación)
    await waitDom(chrome.cdp, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled && document.querySelector('.lv-slide .lv-sfoot [role="status"]')?.textContent === 'Todo guardado'`, { timeoutMs: 9000 });
    await dom(chrome, acceptConfirms);
    await dom(chrome, `location.hash = '#/alertas/follow'`);
    await waitDom(chrome.cdp, `[...document.querySelectorAll('.lv-slide [role=tab]')].some(t => t.textContent.startsWith('Acciones al salir'))`, { timeoutMs: 12000 });
    await dom(chrome, `[...document.querySelectorAll('.lv-slide [role=tab]')].find(t => t.textContent.startsWith('Acciones al salir')).click()`);
    const kind = `document.querySelector('main .actions-list .action > select')`;
    await waitDom(chrome.cdp, `!!${kind}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `${kind}.getAttribute('aria-label')`), 'Qué hace');
    eq(await dom(chrome, `!!${seg(`document.querySelector('main .actions-list')`, 'Dónde')}`), true);

    await dom(chrome, `location.hash = '#/atajos'`);
    const row = `document.querySelector('[data-tour="atajos-list"] tbody tr')`;
    const modal = `document.querySelector('.lv-slide')`;
    await waitDom(chrome.cdp, `!!${row}`, { timeoutMs: 12000 });
    await dom(chrome, `${row}.querySelector('.lv-open').click()`);
    await waitDom(chrome.cdp, `!!${modal}?.querySelector('.action')`, { timeoutMs: 9000 });
    const step = `${modal}.querySelector('.action')`;
    eq(await dom(chrome, `${radios(seg(step, 'Dónde'))}.map(b => b.textContent.trim()).join('|')`), 'Twitch|YouTube|Ambos');
    eq(await dom(chrome, `${step}.querySelectorAll('select').length`), 1);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

function eq(actual, expected) { if (actual !== expected) throw new Error(`esperaba ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`); }

// Un solo estilo de pestaña en toda la interfaz: el subrayado del editor de alertas. Ni las
// pestañas (Chat, Prompter) ni los selectores de valor (Seg) usan el estilo segmentado.
test('pestañas y selectores usan el estilo subrayado del editor, nunca el segmentado', { timeout: 90000 }, async t => {
  const { readdir, readFile } = await import('node:fs/promises');
  // fileURLToPath, not URL#pathname: on Windows the pathname is «/D:/…» and path.join breaks it
  const src = fileURLToPath(new URL('../app/src', import.meta.url));
  const files = (await readdir(src, { recursive: true })).filter(f => /\.(tsx?|css)$/.test(f));
  const offenders = [];
  for (const f of files) {
    const text = await readFile(path.join(src, f), 'utf8');
    if (/eg-tabs--segmented|eg-tabs--sm|\.seg\b|'seg'/.test(text)) offenders.push(f);
  }
  eq(offenders.join(', '), '');

  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia`);
    const group = `document.querySelector('[role=radiogroup]:not(.send-to)')`;
    await waitDom(chrome.cdp, `!!${group}`, { timeoutMs: 12000 });
    // el selector de valor conserva su semántica de radio, con el aspecto de pestañas
    eq(await dom(chrome, `[...${group}.classList].filter(c => c.startsWith('eg-tabs')).join(' ')`), 'eg-tabs');
    eq(await dom(chrome, `[...${group}.children].every(b => b.classList.contains('eg-tabs__item') && b.getAttribute('role') === 'radio')`), true);
    eq(await dom(chrome, `[...${group}.children].filter(b => b.getAttribute('aria-checked') === 'true' && b.getAttribute('aria-selected') === 'true').length`), 1);
    // elegir otra opción la marca como activa
    await dom(chrome, `[...${group}.children].find(b => b.getAttribute('aria-checked') !== 'true').click()`);
    await waitDom(chrome.cdp, `[...${group}.children].filter(b => b.getAttribute('aria-selected') === 'true').length === 1`, { timeoutMs: 12000 });

    // el cambio deja un borrador en Apariencia (guardado manual): se descarta al salir
    await dom(chrome, acceptConfirms);
    await dom(chrome, `location.hash = '#/chat'`);
    await waitDom(chrome.cdp, `!!document.querySelector('.send-to')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `[...document.querySelector('.send-to').classList].filter(c => c.startsWith('eg-tabs')).join(' ')`), 'eg-tabs');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

// Apariencia (v2) se divide en pestañas de página, una por sección, con la dirección propia
// (#/apariencia/sonido) y la vista previa siempre a la vista.
test('Apariencia: secciones en pestañas de página y la vista previa fija', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, close } = ctx;
  const { base } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia`);
    const L = 'Partes de la página';
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 5`, { timeoutMs: 15000 });
    eq(await dom(chrome, tabTexts(L)), 'Color|Tipografía|Iconos|Forma y posición|Sonido');
    eq(await dom(chrome, selectedTab(L)), 'Color');
    eq(await dom(chrome, `!!document.querySelector('.ap-color input.mono')`), true);

    await dom(chrome, `${tabsOf(L)}.find(x => x.textContent.trim() === 'Sonido').click()`);
    await waitDom(chrome.cdp, `${selectedTab(L)} === 'Sonido' && location.hash === '#/apariencia/sonido'`, { timeoutMs: 9000 });
    eq(await dom(chrome, `!!document.querySelector('.ap-color input.mono')`), false);
    eq(await dom(chrome, `document.querySelector('#ap-sound')?.closest('section')?.querySelector('select')?.closest('label')?.textContent.includes('Sonido de serie')`), true);
    // la vista previa no depende de la pestaña
    eq(await dom(chrome, `!!document.querySelector('.ap-preview .eg-stage iframe') && document.querySelector('.ap-preview').getBoundingClientRect().width > 0`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

// Separación entre tarjetas: en cualquier vista (y en cada una de sus pestañas), dos bloques de
// tarjeta apilados uno debajo del otro dejan al menos 12 px entre sí. Antes las vistas cuyas
// tarjetas cuelgan directamente de main (Comandos, Fuentes, General, Acerca de) quedaban pegadas.
test('ninguna vista deja tarjetas apiladas sin separación', { timeout: 240000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/directo`);
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitDom(chrome.cdp, `!!document.querySelector('#nav a[href="#/acerca"]')`, { timeoutMs: 15000 });
    // Interactive views remain reachable through Widgets, even without sidebar entries.
    const routes = [...new Set([...(await dom(chrome, `[...document.querySelectorAll('#nav a[href^="#/"]')].map(a => a.getAttribute('href'))`)), '#/preguntas', '#/tierlist', '#/sorteo', '#/teleprompter'])];
    const probe = `(() => {
      const CARD = '.panel, .sec, .eg-stage, .goal-card, .stats, .browser-source, .lv-panel, .lv-card, .lv-box, .lv-kpis, .lv-group';
      const isCard = el => el.matches(CARD) || !!el.querySelector(CARD);
      const vis = el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0; };
      const bad = [];
      for (const parent of [document.querySelector('#main'), ...document.querySelectorAll('#main *')]) {
        const kids = [...parent.children].filter(k => vis(k) && isCard(k));
        for (let i = 0; i < kids.length - 1; i++) {
          const a = kids[i].getBoundingClientRect(), b = kids[i + 1].getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 20 || b.top < a.bottom - 2) continue;
          if (b.top - a.bottom < 12) bad.push(Math.round(b.top - a.bottom) + 'px antes de «' + (kids[i + 1].querySelector('h2,h3,.eg-eyebrow')?.textContent || kids[i + 1].className).trim().slice(0, 30) + '»');
        }
      }
      return bad;
    })()`;
    const offenders = [];
    for (const r of routes) {
      await dom(chrome, `location.hash = ${JSON.stringify(r)}`);
      await waitDom(chrome.cdp, `!!document.querySelector('#main .view-head')`, { timeoutMs: 9000 });
      await sleep(400);
      const tabs = await dom(chrome, `document.querySelectorAll('#main [role=tablist] [role=tab]').length`);
      const found = [...await dom(chrome, probe)];
      for (let i = 0; i < tabs; i++) { await dom(chrome, `document.querySelectorAll('#main [role=tablist] [role=tab]')[${i}]?.click(); 'ok'`); await sleep(250); found.push(...await dom(chrome, probe)); }
      for (const f of new Set(found)) offenders.push(`${r}: ${f}`);
    }
    eq(offenders.join(' | '), '');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});
