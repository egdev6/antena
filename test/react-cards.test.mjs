// #127 estilo común de tarjetas: la tarjeta compartida (Sec) lleva cabecera con
// el título en mayúsculas y la fuente de display, separadores finos entre
// secciones y un pie opcional con texto atenuado a izquierda y derecha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';

const cssOf = (c, sel, prop) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).${prop}`;

test('tarjeta común del panel: cabecera, separadores finos y pie opcional', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-cards-127-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));

    // Directo: tarjetas compartidas con cabecera (título display en mayúsculas)
    await waitDom(c, `!!document.querySelector('.app main .sec:not(.sec--flat) .sec-h h2')`, { timeoutMs: 12000 });
    const head = await ev(`(() => {
      const secs = Array.from(document.querySelectorAll('.app main .sec:not(.sec--flat)'));
      if (!secs.length) return { n: 0 };
      const h2 = secs[0].querySelector('.sec-h h2');
      if (!h2) return { n: secs.length, sinCabecera: true };
      const s = getComputedStyle(h2);
      return { n: secs.length, upper: s.textTransform, weight: +s.fontWeight, cabecera: secs.every(x => x.querySelector('.sec-h')) };
    })()`);
    assert.equal(head.n > 0, true, 'hay tarjetas compartidas en Directo');
    assert.equal(head.sinCabecera, undefined, 'todas las tarjetas llevan cabecera');
    assert.equal(head.upper, 'uppercase', 'el título va en mayúsculas');
    assert.ok(head.weight >= 700, `el título usa la fuente de display (peso ${head.weight})`);

    // separador fino entre la cabecera y el contenido
    const sep = await ev(cssOf(c, '.app main .sec:not(.sec--flat) .sec-h', 'borderBottomWidth'));
    assert.equal(sep, '1px', 'la cabecera separa del contenido con un filete de 1px');

    // pie opcional: en Mensajes programados, texto atenuado a izquierda y derecha
    await ev(`location.hash = '#/mensajes'`);
    await waitDom(c, `!!document.querySelector('.app main .sec-foot')`, { timeoutMs: 12000 });
    const foot = await ev(`(() => {
      const f = document.querySelector('.app main .sec-foot');
      const s = getComputedStyle(f);
      return {
        izq: f.children[0]?.textContent || '', der: f.children[1]?.textContent || '',
        sep: s.borderTopWidth, muted: s.color, atenuado: s.color !== getComputedStyle(f.closest('.sec')).color,
      };
    })()`);
    assert.ok(foot.izq.length > 0, 'el pie tiene texto a la izquierda');
    assert.ok(foot.der.length > 0, 'el pie tiene texto a la derecha');
    assert.equal(foot.sep, '1px', 'el pie se separa del contenido con un filete de 1px');
    assert.equal(foot.atenuado, true, 'el texto del pie va atenuado');
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
