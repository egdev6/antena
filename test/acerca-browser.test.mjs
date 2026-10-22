// Ajustes › Acerca de: versión instalada, créditos y actualizaciones. En el navegador no hay
// updater (solo el enlace a las releases, sin botón roto); en la app (puente de Tauri simulado)
// «Buscar actualizaciones» consulta el plugin y muestra la versión nueva o «la última versión».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const REPO = 'https://github.com/egdev6/antena';
const RELEASES = `${REPO}/releases`;
const WEB = 'https://egdev.es';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-acerca-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  app.store.config.panel.onboardingDone = true;   // la bienvenida taparía la vista
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const links = `JSON.stringify(Array.from(document.querySelectorAll('#main a')).map(a => [a.href.replace(/\\/$/, ''), a.target, a.rel]))`;

// Puente de Tauri falso: desktop_info da la versión de la app y el updater responde con `update`.
const fakeTauri = update => `(() => {
  const calls = window.__calls = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'desktop_info') return { port: 0, managed: true, dataDir: '', version: '9.9.9' };
    if (cmd === 'plugin:updater|check') return ${JSON.stringify(update)};
    return null;
  };
  window.__TAURI__ = { core: { invoke } };
  window.__TAURI_INTERNALS__ = { invoke, transformCallback: () => 0 };
})();`;

test('acerca de: en el navegador muestra la versión, los créditos y las releases sin updater', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, `${ctx.base}/#/acerca`);
    await waitDom(chrome.cdp, `!!document.querySelector('.acerca-version')`, { timeoutMs: 15000 });
    assert.equal(await dom(chrome, `document.querySelector('.acerca-version').textContent`), `v${version}`);
    assert.equal(await dom(chrome, `document.querySelector('#nav a[href="#/acerca"]')?.getAttribute('aria-current')`), 'page', 'Acerca de está en el menú de Ajustes');
    const found = JSON.parse(await dom(chrome, links));
    for (const url of [REPO, WEB, RELEASES]) {
      const a = found.find(([href]) => href === url);
      assert.ok(a, `falta el enlace a ${url}: ${JSON.stringify(found)}`);
      assert.equal(a[1], '_blank', `${url} se abre fuera del panel`);
      assert.match(a[2], /noopener/);
    }
    assert.equal(await dom(chrome, `!!${buttonByText('Buscar actualizaciones')}`), false, 'sin Tauri no hay botón de actualizar');
    assert.equal(await dom(chrome, `!!document.querySelector('.acerca-browser a[href="${RELEASES}"]')`), true);
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await ctx.close(); }
});

test('acerca de: en la app busca actualizaciones con el plugin y enseña el resultado', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  let chrome;
  try {
    chrome = await openChromePage(ctx.bin, 'about:blank');
    // sin versión nueva: «Tienes la última versión» y la versión que da la app, no la del panel
    let script = await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeTauri(null) });
    await chrome.cdp.send('Page.navigate', { url: `${ctx.base}/#/acerca` });
    await waitDom(chrome.cdp, `document.querySelector('.acerca-version')?.textContent === 'v9.9.9' && !!${buttonByText('Buscar actualizaciones')}`, { timeoutMs: 15000 });
    assert.equal(await dom(chrome, `!!document.querySelector('.acerca-browser')`), false, 'en la app no se muestra el aviso del navegador');
    await dom(chrome, `${buttonByText('Buscar actualizaciones')}.click(); 'ok'`);
    await waitDom(chrome.cdp, `document.querySelector('.acerca-updates')?.textContent.includes('Tienes la última versión')`, { timeoutMs: 9000 });
    assert.ok((await dom(chrome, `window.__calls.join(',')`)).includes('plugin:updater|check'));

    // con versión nueva: aviso con la versión, notas y el botón de instalar
    await chrome.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    script = await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: fakeTauri({ rid: 1, currentVersion: '9.9.9', version: '10.0.0', date: null, body: 'Novedades de prueba', rawJson: {} }),
    });
    await chrome.cdp.send('Page.reload');
    // la página recargada aún no ha llamado al updater (la anterior sí): así no se usa la vieja
    await waitDom(chrome.cdp, `!!window.__calls && !window.__calls.includes('plugin:updater|check') && !!${buttonByText('Buscar actualizaciones')}`, { timeoutMs: 15000 });
    await dom(chrome, `${buttonByText('Buscar actualizaciones')}.click(); 'ok'`);
    await waitDom(chrome.cdp, `document.querySelector('.acerca-notice')?.textContent.includes('Hay una versión nueva: 10.0.0')`, { timeoutMs: 9000 });
    assert.equal(await dom(chrome, `!!${buttonByText('Descargar y reiniciar')}`), true);
    assert.equal(await dom(chrome, `document.querySelector('.acerca-notes pre')?.textContent`), 'Novedades de prueba');
  } finally { chrome?.child.kill(); await chrome?.cdp.close(); await ctx.close(); }
});
