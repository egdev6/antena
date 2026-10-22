// O3.2 (odd/tasks/antena-ux-ajustes.md) · secciones con varios objetos en pestañas (ItemTabs):
// una pestaña por elemento, al pulsarla cambia el editor, «+ Nuevo…» crea y selecciona el nuevo
// y al borrar la selección sigue siendo válida.
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

    // el último guion no se puede borrar
    await dom(chrome, `${tabsOf(L)}[1].click()`);
    await waitDom(chrome.cdp, `${title} === 'Guion B'`, { timeoutMs: 12000 });
    await dom(chrome, `${buttonByText('Borrar guion')}.click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 2 && ${selectedTab(L)} === ${JSON.stringify(first.title)}`, { timeoutMs: 12000 });
    eq(await dom(chrome, `${buttonByText('Borrar guion')}.disabled`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await close(); }
});

test('O3.2 atajos: pestañas por atajo, + Nuevo atajo, pasos con subir/bajar y borrado', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, close } = ctx;
  let chrome;
  try {
    await api(base, 'POST', '/api/shortcuts', { name: 'Uno', steps: [{ kind: 'builtin', action: 'marca' }, { kind: 'builtin', action: 'pausa' }] });
    await api(base, 'POST', '/api/shortcuts', { name: 'Dos', steps: [{ kind: 'builtin', action: 'saltar' }] });
    chrome = await openChromePage(bin, `${base}/#/atajos`);
    const L = 'Atajos';
    const card = `document.querySelector('.shortcut-card:not([hidden])')`;
    const name = `${card}?.querySelector('input[aria-label="Nombre del atajo"]')?.value`;
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3`, { timeoutMs: 12000 });
    eq(await dom(chrome, tabTexts(L)), 'Uno|Dos|+ Nuevo atajo');
    eq(await dom(chrome, selectedTab(L)), 'Uno');
    eq(await dom(chrome, name), 'Uno');
    eq(await dom(chrome, `document.querySelectorAll('.shortcut-card:not([hidden])').length`), 1);
    eq(await dom(chrome, `getComputedStyle(document.querySelector('.shortcut-card[hidden]')).display`), 'none');

    // pasos: subir/bajar con IconBtn; el guardado sigue siendo explícito con «Guardar pasos»
    eq(await dom(chrome, `Array.from(${card}.querySelectorAll('.action .eg-icon-btn')).map(b => b.getAttribute('aria-label')).join('|')`), 'Subir|Bajar|Quitar paso|Subir|Bajar|Quitar paso');
    await dom(chrome, `${card}.querySelectorAll('.action')[0].querySelector('[aria-label="Bajar"]').click()`);
    await waitDom(chrome.cdp, `!!Array.from(${card}.querySelectorAll('button')).find(b => b.textContent.trim() === 'Guardar pasos')`, { timeoutMs: 12000 });
    eq(app.store.config.shortcuts[0].steps.map(x => x.action).join('|'), 'marca|pausa');
    await dom(chrome, `Array.from(${card}.querySelectorAll('button')).find(b => b.textContent.trim() === 'Guardar pasos').click()`);
    await waitDom(chrome.cdp, `!Array.from(${card}.querySelectorAll('button')).find(b => b.textContent.trim() === 'Guardar pasos')`, { timeoutMs: 12000 });
    eq(app.store.config.shortcuts[0].steps.map(x => x.action).join('|'), 'pausa|marca');

    await dom(chrome, `${tabsOf(L)}[1].click()`);
    await waitDom(chrome.cdp, `${name} === 'Dos' && ${selectedTab(L)} === 'Dos'`, { timeoutMs: 12000 });

    // «+ Nuevo atajo»: formulario; al crear queda seleccionado el nuevo
    await dom(chrome, `${tabsOf(L)}.at(-1).click()`);
    await waitDom(chrome.cdp, `${selectedTab(L)} === '+ Nuevo atajo' && !${card} && !!document.querySelector('input[aria-label="Nombre del atajo nuevo"]')`, { timeoutMs: 12000 });
    await dom(chrome, `(() => { const i = document.querySelector('input[aria-label="Nombre del atajo nuevo"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Tres'); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await dom(chrome, `${buttonByText('Crear atajo')}.click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 4 && ${selectedTab(L)} === 'Tres' && ${name} === 'Tres'`, { timeoutMs: 12000 });

    // borrar: queda seleccionado otro atajo válido
    await dom(chrome, acceptConfirms);
    await dom(chrome, `Array.from(${card}.querySelectorAll('button')).find(b => b.textContent.trim() === 'Borrar').click()`);
    await waitDom(chrome.cdp, `${tabsOf(L)}.length === 3 && ${selectedTab(L)} === 'Uno' && ${name} === 'Uno'`, { timeoutMs: 12000 });
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
  const { bin, app, base, close } = ctx;
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

function eq(actual, expected) { if (actual !== expected) throw new Error(`esperaba ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`); }
