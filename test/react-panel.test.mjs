// #117 pulido tras el rediseño, panel React: etiquetas descriptivas de la cronología
// en Directo («Marca de short», «Cola del overlay»), el botón «Probar» de cada
// variación con su texto (no solo el icono) y la marca de la barra lateral más
// grande (el logo nuevo es apaisado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';

test('panel React: etiquetas de la cronología, «Probar» con texto y marca más grande', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-panel-117-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // una variación de la alerta de follow para ver su botón «Probar» en el editor
  const nueva = await fetch(`${base}/api/alerts/follow/variations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Variación de prueba', conditions: {} }),
  });
  assert.equal(nueva.status, 200, 'la variación de prueba se creó');
  await nueva.json();
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!document.querySelector('.brand-mark')`, { timeoutMs: 12000 });

    // la marca de la barra lateral escala el logo cuadrado con «cover»: caja ≥ 48px de
    // ancho y recorte del margen transparente; con «contain» seguiría viéndose a 30px
    const mark = await ev(`(() => { const s = getComputedStyle(document.querySelector('.brand-mark')); return { w: parseFloat(s.width), fit: s.objectFit }; })()`);
    assert.ok(mark.w >= 48 && mark.fit === 'cover', `la marca escala el logo cuadrado (ancho ${mark.w}px, object-fit ${mark.fit})`);

    // cronología de Directo: notas marker y queue con sus etiquetas descriptivas
    app.session.addNote({ kind: 'marker', label: '' });
    app.session.addNote({ kind: 'queue', label: 'Aviso de cola' });
    await waitDom(c, `Array.from(document.querySelectorAll('.eg-timeline__type')).some(x => x.textContent.includes('Marca de short'))
      && Array.from(document.querySelectorAll('.eg-timeline__type')).some(x => x.textContent.includes('Cola del overlay'))`, { timeoutMs: 9000 });

    // editor de alertas: el botón de probar la variación muestra el texto «Probar»
    await ev(`location.hash = '#/alerta/follow'`);
    await clickWhen(c, `Array.from(document.querySelectorAll('.lv-tab')).find(b => b.textContent.includes('Variaciones'))`);
    await waitDom(c, `Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === 'Probar')`, { timeoutMs: 9000 });
    const probar = await ev(`Array.from(document.querySelectorAll('button')).filter(b => b.textContent.trim() === 'Probar').length`);
    assert.ok(probar >= 1, 'el botón «Probar» de la variación muestra su texto');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => new Promise(r => app.server.close(r)));
  }
});
