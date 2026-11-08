// #131 la tarjeta del sorteo usa el mismo lenguaje de filas que la cola de
// preguntas: participantes como eg-post--row con su botón de quitar accesible,
// premio y comando visibles en la cabecera y ganadores como filas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';

test('tarjeta del sorteo: filas de participantes, quitar accesible y premio en cabecera', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-giveaway-131-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  let chrome;
  try {
    await post('/api/config/set', { path: 'interactive.giveaway.prize', value: 'una camiseta EGDEV' });
    await post('/api/giveaway/open', {});
    await post('/api/giveaway/join', { user: 'devconcafe' });
    await post('/api/giveaway/join', { user: 'ana_frontend', member: true });

    chrome = await openChromePage(bin, `${base}/#/widget/giveaway`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!document.querySelector('.app main .view-head')`, { timeoutMs: 12000 });

    // la cabecera nombra el comando y el premio
    const head = await ev(`document.querySelector('.app main .view-head').textContent`);
    assert.match(head, /!sorteo/, 'la cabecera muestra el comando');
    assert.match(head, /camiseta EGDEV/, 'la cabecera muestra el premio');

    // los participantes van como filas eg-post--row, no como chips .entries
    await waitDom(c, `document.querySelectorAll('.app main .rows .eg-post--row').length >= 2`, { timeoutMs: 12000 });
    const rows = await ev(`(() => {
      const rows = Array.from(document.querySelectorAll('.app main .rows .eg-post--row'));
      return {
        n: rows.length,
        entradas: rows.some(r => r.textContent.includes('devconcafe')),
        sub: rows.some(r => r.textContent.includes('ana_frontend') && r.textContent.includes('sub o miembro')),
        quitar: rows.every(r => r.querySelector('button[aria-label^="Quitar"]')),
        chips: !!document.querySelector('.app main ul.entries'),
      };
    })()`);
    assert.equal(rows.n, 2, 'dos participantes como filas');
    assert.ok(rows.entradas && rows.sub, 'los participantes están con su meta');
    assert.ok(rows.quitar, 'cada fila tiene su botón de quitar con etiqueta accesible');
    assert.equal(rows.chips, false, 'ya no se usan los chips .entries');

    // la acción de quitar sigue funcionando
    await ev(`document.querySelector('.app main .rows .eg-post--row button[aria-label="Quitar a devconcafe"]').click()`);
    await waitDom(c, `document.querySelectorAll('.app main .rows .eg-post--row').length === 1`, { timeoutMs: 12000 });
    const quedan = await ev(`Array.from(document.querySelectorAll('.app main .rows .eg-post--row')).map(r => r.textContent)`);
    assert.ok(!quedan.some(x => x.includes('devconcafe')), 'quitar a un participante lo borra de la lista');
    assert.ok(quedan.some(x => x.includes('ana_frontend')), 'el resto sigue en la lista');

    // los ganadores siguen siendo filas y el sección ganadores existe
    await post('/api/giveaway/draw', {});
    // el ganador se asienta cuando termina la ruleta (rollSeconds por defecto, 5 s)
    let wins = null;
    for (let i = 0; i < 100 && !wins?.filas; i++) {
      await new Promise(r => setTimeout(r, 150));
      wins = await ev(`(() => {
        const secs = Array.from(document.querySelectorAll('.app main .sec'));
        const w = secs.find(s => s.querySelector('#h-win'));
        return { hay: !!w, filas: w ? w.querySelectorAll('.eg-post--row').length : 0 };
      })()`);
    }
    assert.equal(wins.hay, true, 'sigue la tarjeta de ganadores');
    assert.equal(wins.filas, 1, 'el ganador del sorteo sintético aparece como fila');
  } finally {
    if (chrome) await closeChrome(chrome);
    await new Promise(r => app.server.close(r));
  }
});
