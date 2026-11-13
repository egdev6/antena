// #105 en la interfaz React: vista panel › Atajos y Stream Deck. Crear, editar, probar
// y borrar un atajo, comprobando el efecto en la API (config del servidor y notas de sesión).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';

// Los inputs controlados de React necesitan el setter nativo + evento input.
const typeInto = (el, text) => `(() => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(${el}, ${JSON.stringify(text)});
  ${el}.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

test('atajos React: crear, editar, probar y borrar un atajo desde el panel', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-sc-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const custom = () => app.store.config.shortcuts || [];
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/atajos`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `document.querySelector('h1')?.textContent.includes('Atajos y Stream Deck')`, { timeoutMs: 12000 });
    await waitDom(c, `document.body.textContent.includes('Aún no tienes atajos')`, { timeoutMs: 9000 });

    // crear (v2): «+ Nuevo atajo» abre el slide en modo Nuevo con el nombre y una plantilla
    await ev(`location.hash = '#/atajos/nuevo'`);
    await waitDom(c, `!!document.querySelector('.lv-slide input[placeholder="Empezar el directo"]')`, { timeoutMs: 9000 });
    await ev(typeInto(`document.querySelector('.lv-slide input[placeholder="Empezar el directo"]')`, 'Empezar el directo'));
    await clickWhen(c, buttonByText('Crear atajo'));
    await waitDom(c, `!!document.querySelector('.lv-slide input[aria-label="Nombre del atajo"]')`, { timeoutMs: 9000 });
    const sc = await new Promise(r => setTimeout(() => r(custom()[0]), 300));
    assert.ok(sc, 'el atajo quedó en la configuración del servidor');
    assert.equal(sc.name, 'Empezar el directo');
    assert.deepEqual(sc.steps, [{ kind: 'builtin', action: 'marca' }]);

    // editar el nombre: guardado manual, no llega al servidor hasta «Guardar»
    await ev(typeInto(`document.querySelector('.lv-slide input[aria-label="Nombre del atajo"]')`, 'Arrancar'));
    await new Promise(r => setTimeout(r, 600));
    assert.equal(custom()[0].name, 'Empezar el directo', 'sin guardar, el servidor no cambia');
    await clickWhen(c, `document.querySelector('.lv-sfoot .eg-btn--secondary')`);
    await new Promise(r => setTimeout(r, 800));
    assert.equal(custom()[0].name, 'Arrancar', 'el renombrado llegó al servidor');

    // probar: ejecuta el paso (marca) y el mensaje dice cuántos pasos se hicieron
    await clickWhen(c, buttonByText('Guardar y probar'));
    await waitDom(c, `Array.from(document.querySelectorAll('.hint[aria-live="polite"]')).some(h => h.textContent.includes('Hecho: 1 paso'))`, { timeoutMs: 9000 });
    const note = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'marker')), 300));
    assert.ok(note, 'Probar ejecutó el paso marca en el servidor');

    // borrar: confirm() del navegador aceptado; el atajo desaparece de la configuración
    await ev('window.confirm = () => true;');
    await clickWhen(c, buttonByText('Borrar atajo…'));
    await waitDom(c, `document.body.textContent.includes('Aún no tienes atajos')`, { timeoutMs: 9000 });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(custom().length, 0, 'el atajo se borró de la configuración del servidor');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => new Promise(r => app.server.close(r)));
  }
});
