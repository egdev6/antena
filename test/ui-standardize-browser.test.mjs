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
const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const api = (base, method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`); return r.json(); });
const tabsOf = label => `Array.from(document.querySelectorAll('[role=tablist][aria-label=${JSON.stringify(label)}] [role=tab]'))`;
const tabTexts = label => `${tabsOf(label)}.map(x => x.textContent.trim()).join('|')`;
const selectedTab = label => `(${tabsOf(label)}.find(x => x.getAttribute('aria-selected') === 'true')?.textContent.trim() ?? '')`;
// confirm() nativo: en headless se acepta siempre y se guarda el texto para comprobar la redacción
const acceptConfirms = `(() => { window.__confirms = []; window.confirm = m => { window.__confirms.push(m); return true; }; return 'ok'; })()`;

test('O3.2 tier lists: pestañas, cambio de editor, + Nueva y borrado', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    await api(base, 'POST', '/api/tierlists', { title: 'Lista A', items: ['x'] });
    await api(base, 'POST', '/api/tierlists', { title: 'Lista B', items: ['y'] });
    chrome = await openChromePage(bin, `${base}/#/widget/tierlist`);
    const L = 'Tier lists';
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3`, { timeoutMs: 12000 });
    eq(await dom(chrome, tabTexts(L)), 'Lista Aen pantalla|Lista B|+ Nueva');
    eq(await dom(chrome, selectedTab(L)), 'Lista Aen pantalla');
    const title = `document.querySelector('#h-list')?.closest('section')?.querySelector('label input')?.value`;
    eq(await dom(chrome, title), 'Lista A');

    await dom(chrome, `${tabsOf(L)}[1].click()`);
    await waitDom(chrome.cdp, `${title} === 'Lista B' && ${selectedTab(L)} === 'Lista B'`, { timeoutMs: 12000 });

    // «+ Nueva»: formulario de creación; al crear queda seleccionada la nueva
    await dom(chrome, `${tabsOf(L)}.at(-1).click()`);
    await waitDom(chrome.cdp, `!!document.querySelector('#h-new') && ${selectedTab(L)} === '+ Nueva'`, { timeoutMs: 12000 });
    await dom(chrome, `(() => { const i = document.querySelector('#h-new').closest('section').querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Lista C'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await dom(chrome, `${buttonByText('Crear')}.click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 4 && ${selectedTab(L)} === 'Lista C' && ${title} === 'Lista C'`, { timeoutMs: 12000 });

    // borrar: la lista desaparece y la selección pasa a «+ Nueva» (una selección válida)
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${buttonByText('Borrar lista')}.click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3 && ${selectedTab(L)} === '+ Nueva' && !!document.querySelector('#h-new')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `window.__confirms[0]`), '¿Borrar «Lista C»?');
    eq(app.interactive.s.tierlists.map(x => x.title).join('|'), 'Lista A|Lista B');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('O3.2 teleprompter: pestañas por guion, + Nuevo guion y el último no se borra', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    const first = (await api(base, 'GET', '/api/teleprompter')).scripts[0];
    await api(base, 'POST', '/api/teleprompter/scripts', { title: 'Guion B', select: false });
    chrome = await openChromePage(bin, `${base}/#/widget/teleprompter`);
    const L = 'Guiones';
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3`, { timeoutMs: 12000 });
    eq(await dom(chrome, tabTexts(L)), `${first.title}|Guion B|+ Nuevo guion`);
    eq(await dom(chrome, selectedTab(L)), first.title);
    // item tabs share the underlined style of the alert editor tabs, not the segmented one
    const tabClasses = `[...document.querySelector('[role=tablist][aria-label=${JSON.stringify(L)}]').classList].filter(c => c.startsWith('eg-tabs')).join(' ')`;
    eq(await dom(chrome, tabClasses), 'eg-tabs');
    eq(await dom(chrome, `!!document.querySelector('select#tp-guion')`), false);
    const title = `document.querySelector('#tp-title')?.value`;
    eq(await dom(chrome, title), first.title);

    await dom(chrome, `${tabsOf(L)}[1].click()`);
    await waitDom(chrome.cdp, `${title} === 'Guion B' && ${selectedTab(L)} === 'Guion B'`, { timeoutMs: 12000 });
    eq(app.teleprompter.snapshot().script.title, 'Guion B');

    // «+ Nuevo guion» lo crea y lo deja seleccionado
    await dom(chrome, `${tabsOf(L)}.at(-1).click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 4 && ${selectedTab(L)} === 'Nuevo guion' && ${title} === 'Nuevo guion'`, { timeoutMs: 12000 });

    // borrar: queda seleccionado otro guion válido
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${buttonByText('Borrar guion')}.click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3 && ${selectedTab(L)} === ${JSON.stringify(first.title)} && ${title} === ${JSON.stringify(first.title)}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `window.__confirms[0]`), '¿Borrar «Nuevo guion»?');

    // el último guion no se puede borrar
    await dom(chrome, `${tabsOf(L)}[1].click()`);
    await waitDom(chrome.cdp, `${title} === 'Guion B'`, { timeoutMs: 12000 });
    await dom(chrome, `${buttonByText('Borrar guion')}.click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 2 && ${selectedTab(L)} === ${JSON.stringify(first.title)}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `${buttonByText('Borrar guion')}.disabled`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('atajos: lista bajo «Cómo ponerlo» con Probar/Editar/Borrar, «+ Nuevo atajo» en la cabecera y el editor en un modal', { timeout: 120000 }, async t => {
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
    const rows = `[...${list}.querySelectorAll('.eg-post--row')]`;
    const modal = `document.querySelector('[role=dialog][aria-modal=true]')`;
    const btnIn = (scope, text) => `[...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    await waitDom(chrome.cdp, `!!${list} && ${rows}.length === 2`, { timeoutMs: 15000 });

    // sin pestañas; «+ Nuevo atajo» vive en la cabecera
    eq(await dom(chrome, `!!document.querySelector('[role=tablist][aria-label="Atajos"]')`), false);
    eq(await dom(chrome, `!!${btnIn(`document.querySelector('.view-head')`, '+ Nuevo atajo')}`), true);
    // la lista va debajo de «Cómo ponerlo en el Stream Deck», en la misma columna; «Atajos de serie» a la derecha
    eq(await dom(chrome, `(() => { const how = document.querySelector('[data-tour="atajos-streamdeck"]').getBoundingClientRect(), l = ${list}.getBoundingClientRect(), serie = [...document.querySelectorAll('main h2')].find(h => h.textContent.includes('Atajos de serie')).closest('.panel').getBoundingClientRect(); return l.top >= how.bottom && Math.abs(l.left - how.left) < 2 && serie.left > how.right; })()`), true);
    eq(await dom(chrome, `${rows}.map(r => r.querySelector('b').textContent + ':' + [...r.querySelectorAll('button')].map(b => b.textContent.trim()).join('/')).join('|')`), 'Uno:Probar/Editar/Borrar|Dos:Probar/Editar/Borrar');
    eq(await dom(chrome, `${rows}[0].querySelector('code').textContent`), `/sd/custom/${app.store.config.shortcuts[0].id}`);
    eq(await dom(chrome, `!!${modal}`), false);

    // Probar desde la lista ejecuta sus pasos y lo avisa
    await dom(chrome, `${btnIn(`${rows}[0]`, 'Probar')}.click()`);
    await waitDom(chrome.cdp, `document.querySelector('.toast.on')?.textContent.includes('Hecho: 2 pasos')`, { timeoutMs: 9000 });
    eq(app.session.data.notes.some(n => n.kind === 'marker'), true);

    // Editar abre el modal con ese atajo; los pasos se reordenan y se guardan con «Guardar pasos»
    // (focus + click like a real click, so the modal can give the focus back to «Editar» on close)
    await dom(chrome, `(() => { const b = ${btnIn(`${rows}[0]`, 'Editar')}; b.focus(); b.click(); return 'ok'; })()`);
    await waitDom(chrome.cdp, `!!${modal} && ${modal}.querySelector('input[aria-label="Nombre del atajo"]')?.value === 'Uno'`, { timeoutMs: 9000 });
    eq(await dom(chrome, `document.activeElement && ${modal}.contains(document.activeElement)`), true);
    await dom(chrome, `${modal}.querySelectorAll('.action')[0].querySelector('[aria-label="Bajar"]').click()`);
    await waitDom(chrome.cdp, `!!${btnIn(modal, 'Guardar pasos')}`, { timeoutMs: 9000 });
    await dom(chrome, `${btnIn(modal, 'Guardar pasos')}.click()`);
    await waitDom(chrome.cdp, `!${btnIn(modal, 'Guardar pasos')}`, { timeoutMs: 9000 });
    eq(app.store.config.shortcuts[0].steps.map(x => x.action).join('|'), 'pausa|marca');

    // cerrar con pasos sin guardar pregunta; si se rechaza el modal sigue abierto, si se acepta se descartan
    await dom(chrome, `${modal}.querySelectorAll('.action')[0].querySelector('[aria-label="Bajar"]').click()`);
    await waitDom(chrome.cdp, `!!${btnIn(modal, 'Guardar pasos')}`, { timeoutMs: 9000 });
    await dom(chrome, `(() => { window.__confirms = []; window.confirm = m => { window.__confirms.push(m); return false; }; return 'ok'; })()`);
    await dom(chrome, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(300);
    eq(await dom(chrome, `!!${modal}`), true);
    eq(await dom(chrome, `window.__confirms[0]`), 'Tienes pasos sin guardar. ¿Cerrar sin guardarlos?');
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${modal}.querySelector('[aria-label="Cerrar"]').click()`);
    await waitDom(chrome.cdp, `!${modal}`, { timeoutMs: 9000 });
    eq(app.store.config.shortcuts[0].steps.map(x => x.action).join('|'), 'pausa|marca');
    eq(await dom(chrome, `document.activeElement?.textContent.trim()`), 'Editar');

    // «+ Nuevo atajo»: el modal pide el nombre y, al crear, pasa a editar el atajo nuevo
    await dom(chrome, `${btnIn(`document.querySelector('.view-head')`, '+ Nuevo atajo')}.click()`);
    await waitDom(chrome.cdp, `!!${modal}?.querySelector('input[aria-label="Nombre del atajo nuevo"]')`, { timeoutMs: 9000 });
    await dom(chrome, `(() => { const i = ${modal}.querySelector('input[aria-label="Nombre del atajo nuevo"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Tres'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await dom(chrome, `${btnIn(modal, 'Crear atajo')}.click()`);
    await waitDom(chrome.cdp, `${modal}?.querySelector('input[aria-label="Nombre del atajo"]')?.value === 'Tres' && ${rows}.length === 3`, { timeoutMs: 9000 });
    await dom(chrome, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitDom(chrome.cdp, `!${modal}`, { timeoutMs: 9000 });

    // Borrar desde la lista
    await dom(chrome, acceptConfirms);
    await dom(chrome, `${btnIn(`${rows}[2]`, 'Borrar')}.click()`);
    await waitDom(chrome.cdp, `${rows}.length === 2`, { timeoutMs: 9000 });
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
    await dom(chrome, `location.hash = '#/widget/giveaway'`);
    await waitDom(chrome.cdp, `${empty}.includes('Aún no se ha sorteado.') && ${empty}.includes('Sin sorteos anteriores.')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `getComputedStyle(document.querySelector('main .empty-state')).cursor`), 'default');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('O3.2 botones eg-btn en todas las vistas y filas eg-post--row en Comandos y Mensajes', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    await api(base, 'POST', '/api/commands', { trigger: '!web', title: 'web', text: '{user}' });
    await api(base, 'POST', '/api/timers', { name: 'Recordatorio', message: 'Sigue el canal' });
    await api(base, 'POST', '/api/shortcuts', { name: 'Uno', steps: [{ kind: 'builtin', action: 'marca' }] });
    chrome = await openChromePage(bin, `${base}/#/comandos`);
    const row = `document.querySelector('main .rows .eg-post--row')`;
    await waitDom(chrome.cdp, `${row}?.querySelector('.eg-post__content code')?.textContent === '!web'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `Array.from(${row}.querySelectorAll('.eg-btn.eg-btn--ghost.eg-btn--sm')).map(b => b.textContent.trim()).join('|')`), 'Probar|Editar');
    await dom(chrome, `location.hash = '#/mensajes'`);
    await waitDom(chrome.cdp, `${row}?.querySelector('.eg-post__content b')?.textContent === 'Recordatorio'`, { timeoutMs: 12000 });
    eq(await dom(chrome, `Array.from(${row}.querySelectorAll('.eg-btn')).map(b => b.textContent.trim()).join('|')`), 'Enviar ahora|Editar');
    for (const hash of ['#/comandos', '#/mensajes', '#/atajos', '#/conexiones', '#/general', '#/fuentes', '#/historial', '#/chat', '#/prompter', '#/meld', '#/filtros']) {
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
    chrome = await openChromePage(bin, `${base}/#/widget/latest`);
    const helps = `Array.from(document.querySelectorAll('main .css-help')).map(h => h.textContent)`;
    const has = (i, classes) => `(${helps}[${i}] || '').length > 0 && ${JSON.stringify(classes)}.every(c => ${helps}[${i}].includes(c))`;
    await waitDom(chrome.cdp, `${helps}.length === 2`, { timeoutMs: 12000 });
    eq(await dom(chrome, has(0, ['.root', '.item', '.kick', '.big', '.extra', '.flash'])), true);
    eq(await dom(chrome, has(1, ['.band', '.label', '.track', '.run', '.it', '.k'])), true);
    await dom(chrome, `location.hash = '#/widget/credits'`);
    await waitDom(chrome.cdp, `${helps}.length === 1 && ${has(0, ['.roll', '.head', '.grp', '.end', '.kick', '.big', '.sub', '.hl'])}`, { timeoutMs: 12000 });
    await dom(chrome, `location.hash = '#/alerta/follow'`);
    await waitDom(chrome.cdp, `!!document.querySelector('#tb-css')`, { timeoutMs: 12000 });
    await dom(chrome, `document.querySelector('#tb-css').click()`);
    await waitDom(chrome.cdp, `!document.querySelector('#tp-css').hidden && !!document.querySelector('#tp-css .css-help')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `['.alert', '.alert-box', '.alert-title', '.alert-name', '.alert-sub'].every(c => document.querySelector('#tp-css .css-help').textContent.includes(c))`), true);
    // #15: el CSS propio del prompter también lista sus clases, justo debajo de su campo
    await dom(chrome, `location.hash = '#/prompter'`);
    const prHelp = `document.querySelector('main textarea.code')?.closest('label')?.nextElementSibling`;
    await waitDom(chrome.cdp, `${prHelp}?.classList.contains('css-help') === true`, { timeoutMs: 12000 });
    eq(await dom(chrome, `['.pr', '.pr-top', '.pr-main', '.pr-chat', '.eg-timeline__item', '.pr-send', '.pr-side', '.pr-pane', '.pr-tierbtn'].every(c => ${prHelp}.textContent.includes(c))`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('#15 la espera de Espectadores es un Status neutro, no un p.hint suelto', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(fileURLToPath(new URL('../app/src/panel/views/Espectadores.tsx', import.meta.url)), 'utf8');
  const wait = src.split('\n').find(l => l.includes('El servidor no ha mandado aún el estado de espectadores.')) ?? '';
  eq(/<Status tone="neutral"[^>]*>El servidor no ha mandado aún el estado de espectadores\.<\/Status>/.test(wait), true);
  eq(wait.includes('className="hint"'), false);
});

test('O3.2 esqueleto común: cabecera con miga «grupo › vista» igual que la barra lateral, interruptores y sin márgenes en línea', { timeout: 180000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/chat`);
    await waitDom(chrome.cdp, `document.querySelectorAll('#nav a.eg-menu__item').length > 20`, { timeoutMs: 12000 });
    const links = await dom(chrome, `JSON.stringify(Array.from(document.querySelectorAll('#nav .nav-grp')).flatMap(g => Array.from(g.querySelectorAll('a.eg-menu__item')).map(a => [a.getAttribute('href'), g.querySelector('.grp-l').textContent.trim(), a.querySelector('.eg-menu__label').textContent.trim()])))`);
    eq(JSON.parse(links).length > 25, true);
    const bad = [];
    for (const [href, group, label] of JSON.parse(links)) {
      if (href === '#/directo') continue;   // el tablero lleva el estado del directo en la miga
      await dom(chrome, `location.hash = ${JSON.stringify(href)}`);
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(href)} && !!document.querySelector('main .view-head h1') && !document.querySelector('main > p.hint')`, { timeoutMs: 12000 });
      const got = JSON.parse(await dom(chrome, `JSON.stringify({ crumb: document.querySelector('main .view-head .crumb')?.textContent.trim(), h1: document.querySelector('main .view-head h1')?.textContent.trim() || document.querySelector('main .view-head h1 input')?.value, order: Array.from(document.querySelector('main .view-head > div').children).map(e => e.tagName).join(','), margins: Array.from(document.querySelectorAll('main [style]')).filter(e => /margin/.test(e.getAttribute('style'))).length, checks: document.querySelectorAll('main .switch').length })`));
      if (got.crumb !== `${group} › ${label}` || got.h1 !== label || !/^SPAN,H1(,P)?$/.test(got.order) || got.margins) bad.push({ href, ...got, want: `${group} › ${label}` });
    }
    eq(JSON.stringify(bad), '[]');
    // ajustes de sí/no: interruptor (Switch), no casilla suelta
    for (const [hash, n] of [['#/filtros', 1], ['#/prompter', 3], ['#/meld', 1], ['#/widget/chat', 4]]) {
      await dom(chrome, `location.hash = ${JSON.stringify(hash)}`);
      await waitDom(chrome.cdp, `location.hash === ${JSON.stringify(hash)} && !!document.querySelector('main .view-head h1')`, { timeoutMs: 12000 });
      eq(await dom(chrome, `${JSON.stringify(hash)} + ':' + (document.querySelectorAll('main label.switch').length >= ${n}) + ':' + document.querySelectorAll('main label.check:not(:has(+ label.check)):not(label.check + label.check)').length`), `${hash}:true:0`);
    }
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

    await dom(chrome, `location.hash = '#/chat'`);
    await waitDom(chrome.cdp, `!!document.querySelector('.send-to')`, { timeoutMs: 12000 });
    eq(await dom(chrome, `[...document.querySelector('.send-to').classList].filter(c => c.startsWith('eg-tabs')).join(' ')`), 'eg-tabs');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

// Apariencia se divide en pestañas como el editor de alertas: una por sección, un solo panel
// visible a la vez y la vista previa siempre a la vista.
test('Apariencia: secciones en pestañas con el estilo del editor y la vista previa fija', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, close } = ctx;
  const { base } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia`);
    const L = 'Secciones de la apariencia';
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 6`, { timeoutMs: 15000 });
    eq(await dom(chrome, tabTexts(L)), 'Color|Tipografía|Iconos|Forma y efectos|Posición y movimiento|Sonido');
    eq(await dom(chrome, `document.querySelector('[role=tablist][aria-label=${JSON.stringify(L)}]').className`), 'eg-tabs editor-tabs');
    eq(await dom(chrome, selectedTab(L)), 'Color');
    const visible = `[...document.querySelectorAll('[role=tabpanel][id^=ap-tp-]')].filter(p => !p.hidden).map(p => p.id).join(',')`;
    eq(await dom(chrome, visible), 'ap-tp-color');
    eq(await dom(chrome, `!!document.querySelector('#ap-tp-color .ap-color input.mono')`), true);

    await dom(chrome, `${tabsOf(L)}.find(x => x.textContent.trim() === 'Sonido').click()`);
    await waitDom(chrome.cdp, `${selectedTab(L)} === 'Sonido'`, { timeoutMs: 9000 });
    eq(await dom(chrome, visible), 'ap-tp-sound');
    eq(await dom(chrome, `document.querySelector('#ap-tp-sound select')?.closest('label')?.textContent.includes('Sonido de serie')`), true);
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
    await waitDom(chrome.cdp, `document.querySelectorAll('#nav a[href^="#/"]').length > 20`, { timeoutMs: 15000 });
    const routes = [...new Set(await dom(chrome, `[...document.querySelectorAll('#nav a[href^="#/"]')].map(a => a.getAttribute('href'))`))];
    const probe = `(() => {
      const CARD = '.panel, .sec, .eg-stage, .goal-card, .stats, .browser-source';
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
      for (let i = 0; i < tabs; i++) { await dom(chrome, `document.querySelectorAll('#main [role=tablist] [role=tab]')[${i}].click()`); await sleep(150); found.push(...await dom(chrome, probe)); }
      for (const f of new Set(found)) offenders.push(`${r}: ${f}`);
    }
    eq(offenders.join(' | '), '');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});
