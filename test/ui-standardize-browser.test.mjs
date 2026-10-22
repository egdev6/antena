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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function eventually(read, expected, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  let actual = await read();
  while (actual !== expected && Date.now() < until) { await sleep(50); actual = await read(); }
  eq(actual, expected);
}
function eq(actual, expected) { if (actual !== expected) throw new Error(`esperaba ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`); }
