// #105 en la interfaz React: vista panel › Atajos y Stream Deck. Crear, editar, probar
// y borrar un atajo, comprobando el efecto en la API (config del servidor y notas de sesión).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';

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

    // crear: «+ Nuevo atajo» abre el modal, nombre y «Crear atajo» → el servidor guarda el atajo con su paso
    // y el modal pasa a editarlo (los botones de abajo son los del modal, no los de la lista)
    // .modal: the onboarding greeting is also a role=dialog and stays open in this test
    const inModal = text => `[...(document.querySelector('.modal[role=dialog]')?.querySelectorAll('button') || [])].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    await clickWhen(c, buttonByText('+ Nuevo atajo'));
    await waitDom(c, `!!document.querySelector('input[aria-label="Nombre del atajo nuevo"]')`, { timeoutMs: 9000 });
    await ev(typeInto(`document.querySelector('input[aria-label="Nombre del atajo nuevo"]')`, 'Empezar el directo'));
    await clickWhen(c, buttonByText('Crear atajo'));
    await waitDom(c, `!!(${inModal('Probar')})`, { timeoutMs: 9000 });
    const sc = await new Promise(r => setTimeout(() => r(custom()[0]), 300));
    assert.ok(sc, 'el atajo quedó en la configuración del servidor');
    assert.equal(sc.name, 'Empezar el directo');
    assert.deepEqual(sc.steps, [{ kind: 'builtin', action: 'marca' }]);

    // editar el nombre: el LazyInput confirma con retardo; el PUT llega a la configuración
    await ev(typeInto(`document.querySelector('input[aria-label="Nombre del atajo"]')`, 'Arrancar'));
    await new Promise(r => setTimeout(r, 1600));
    assert.equal(custom()[0].name, 'Arrancar', 'el renombrado llegó al servidor');
    await waitDom(c, `document.querySelector('.shortcut-card input[aria-label="Nombre del atajo"]').value === 'Arrancar'`, { timeoutMs: 9000 });

    // probar: ejecuta el paso (marca) y el mensaje dice cuántos pasos se hicieron
    await clickWhen(c, inModal('Probar'));
    await waitDom(c, `Array.from(document.querySelectorAll('.hint[aria-live="polite"]')).some(h => h.textContent.includes('Hecho: 1 paso'))`, { timeoutMs: 9000 });
    const note = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'marker')), 300));
    assert.ok(note, 'Probar ejecutó el paso marca en el servidor');

    // borrar: confirm() del navegador aceptado; el atajo desaparece de la configuración
    await ev('window.confirm = () => true;');
    await clickWhen(c, inModal('Borrar'));
    await waitDom(c, `document.body.textContent.includes('Aún no tienes atajos') && !document.querySelector('.modal[role=dialog]')`, { timeoutMs: 9000 });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(custom().length, 0, 'el atajo se borró de la configuración del servidor');
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
