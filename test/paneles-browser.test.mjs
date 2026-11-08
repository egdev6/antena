import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-paneles-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { bin, base: `http://127.0.0.1:${app.server.address().port}`, close: async () => {
    app.timers.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  } };
}
const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const click = text => `[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})?.click()`;

test('Paneles en el navegador: secciones, acciones y pestaña Vista conservada', { timeout: 60000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${ctx.base}/#/prompter`);
    await waitDom(chrome.cdp, `document.querySelector('main h1')?.textContent.trim() === 'Paneles'`, { timeoutMs: 15000 });
    assert.equal(await dom(chrome, `document.querySelector('#nav a[href="#/prompter"] .eg-menu__label').textContent`), 'Paneles');
    assert.equal(await dom(chrome, `document.querySelectorAll('main .view-head .actions button').length`), 0);
    assert.deepEqual(await dom(chrome, `[...document.querySelectorAll('main [role=tab]')].map(x => x.textContent.trim())`), ['Pantalla', 'Vista']);
    assert.deepEqual(await dom(chrome, `[...document.querySelectorAll('main section[aria-labelledby] > h2')].map(x => x.textContent.trim())`), ['En el Elgato', 'Ventanas flotantes']);
    assert.deepEqual(await dom(chrome, `[...document.querySelectorAll('main section[aria-labelledby] article h3')].map(x => x.textContent.trim())`), ['Prompter', 'Teleprompter', 'Dock', 'Teleprompter en ventana']);
    assert.doesNotMatch(await dom(chrome, `document.querySelector('main').textContent`), /En pantalla|Cerrado|Abierto/);
    await dom(chrome, `window.__opened = []; window.open = (...args) => { window.__opened.push(args); return null; }; 'ok'`);
    await dom(chrome, `${click('Mostrar en la pantalla')}; 'ok'`);
    await dom(chrome, `[...document.querySelectorAll('main button')].filter(b => b.textContent.trim() === 'Mostrar en la pantalla')[1].click(); 'ok'`);
    await dom(chrome, `${click('Abrir el dock')}; ${click('Abrir en ventana')}; 'ok'`);
    assert.deepEqual(await dom(chrome, `window.__opened.map(x => x[0])`), ['/prompter', '/widget/teleprompter', '/dock', '/widget/teleprompter']);
    await dom(chrome, `${click('Vista')}; 'ok'`);
    await waitDom(chrome.cdp, `location.hash === '#/prompter/vista' && !!document.querySelector('main textarea.code')`);
    assert.match(await dom(chrome, `document.querySelector('main').textContent`), /Tamaño de letra/);
  } finally { if (chrome) await closeChrome(chrome); await ctx.close(); }
});

test('Paneles de escritorio: estado, cambio de ventanas y actualización al recuperar foco', { timeout: 60000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, 'about:blank');
    await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__calls = []; window.__panelState = { dock: false, prompter: false, teleprompter: 'closed' };
      window.__TAURI__ = { core: { invoke: async (cmd, args) => {
        window.__calls.push([cmd, args]);
        if (cmd === 'monitors') return [{ name: 'Elgato', width: 1024, height: 600, prompterLike: true }];
        if (cmd === 'panel_windows') return { ...window.__panelState };
        if (cmd === 'open_prompter') window.__panelState = { ...window.__panelState, prompter: true, teleprompter: window.__panelState.teleprompter === 'screen' ? 'closed' : window.__panelState.teleprompter };
        if (cmd === 'open_teleprompter') window.__panelState = { ...window.__panelState, prompter: args.fullscreen ? false : window.__panelState.prompter, teleprompter: args.fullscreen ? 'screen' : 'floating' };
        if (cmd === 'open_dock') window.__panelState.dock = true;
        if (cmd === 'close_panel_window') window.__panelState[args.label] = args.label === 'prompter' ? false : 'closed';
        return null;
      } }, event: { listen: async (_name, fn) => { window.__panelEvent = fn; return () => {}; } } };
    ` });
    await chrome.cdp.send('Page.navigate', { url: `${ctx.base}/#/prompter` });
    await waitDom(chrome.cdp, `document.querySelector('main h1')?.textContent.trim() === 'Paneles' && !!window.__panelEvent && [...document.querySelectorAll('main select option')].some(x => x.value === 'Elgato')`);
    await dom(chrome, `${click('Mostrar en la pantalla')}; 'ok'`);
    await waitDom(chrome.cdp, `[...document.querySelectorAll('main button')].some(x => x.textContent.trim() === 'Quitar de la pantalla')`);
    assert.deepEqual(await dom(chrome, `window.__calls.find(x => x[0] === 'open_prompter')[1]`), { monitor: 'Elgato', fullscreen: true });
    await dom(chrome, `${click('Quitar de la pantalla')}; 'ok'`);
    await waitDom(chrome.cdp, `[...document.querySelectorAll('main button')].filter(x => x.textContent.trim() === 'Mostrar en la pantalla').length === 2`);
    assert.deepEqual(await dom(chrome, `window.__calls.find(x => x[0] === 'close_panel_window')[1]`), { label: 'prompter' });
    await dom(chrome, `[...document.querySelectorAll('main button')].filter(x => x.textContent.trim() === 'Mostrar en la pantalla')[1].click(); 'ok'`);
    await waitDom(chrome.cdp, `document.querySelector('main').textContent.includes('En pantalla')`);
    assert.deepEqual(await dom(chrome, `window.__calls.find(x => x[0] === 'open_teleprompter')[1]`), { monitor: 'Elgato', fullscreen: true });
    await dom(chrome, `${click('Quitar de la pantalla')}; 'ok'`);
    await waitDom(chrome.cdp, `[...document.querySelectorAll('main button')].filter(x => x.textContent.trim() === 'Mostrar en la pantalla').length === 2`);
    assert.deepEqual(await dom(chrome, `window.__calls.filter(x => x[0] === 'close_panel_window').at(-1)[1]`), { label: 'teleprompter' });
    await dom(chrome, `${click('Abrir en ventana')}; 'ok'`);
    await waitDom(chrome.cdp, `document.querySelector('main').textContent.includes('En ventana')`);
    assert.deepEqual(await dom(chrome, `window.__calls.filter(x => x[0] === 'open_teleprompter').at(-1)[1]`), { monitor: null, fullscreen: false });
    await dom(chrome, `${click('Abrir el dock')}; 'ok'`);
    await waitDom(chrome.cdp, `document.querySelector('main').textContent.includes('Abierto')`);
    assert.deepEqual(await dom(chrome, `window.__calls.find(x => x[0] === 'open_dock')[1]`), { alwaysOnTop: true });
    await dom(chrome, `window.__panelState.dock = false; window.dispatchEvent(new Event('focus')); 'ok'`);
    await waitDom(chrome.cdp, `!document.querySelector('main').textContent.includes('Abierto')`);
    await dom(chrome, `window.__panelState.teleprompter = 'closed'; window.__panelEvent({}); 'ok'`);
    await waitDom(chrome.cdp, `!document.querySelector('main').textContent.includes('En ventana')`);
  } finally { if (chrome) await closeChrome(chrome); await ctx.close(); }
});
