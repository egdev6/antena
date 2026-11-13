// Teleprompter (#143): prueba de navegador del widget — regresión del render por párrafos.
// Un bloque con dos párrafos separados por una línea en blanco y una [nota] debe renderizar
// todas sus palabras, sin errores de página y con un <p> por párrafo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage } from './helpers/react-browser.mjs';
import { evaluateChrome, waitChromeDom } from './helpers/chrome-dom.mjs';

const dom = (c, expr) => evaluateChrome(c, expr);

async function start(t) {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar las pruebas de navegador');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-tp-widget-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

test('widget teleprompter: párrafos múltiples renderizan todas las palabras, un p por párrafo y sin errores de página', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { base, close } = ctx;
  let page = null;
  try {
    // Bloque con 2 párrafos (línea en blanco entre medias) y una nota entre corchetes.
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
    };
    const creado = await call('POST', '/api/teleprompter/scripts', {
      title: 'Regresión párrafos',
      blocks: [{ title: 'A', text: 'uno dos tres\n\ncuatro cinco [mira a cámara] seis' }],
    });
    const total = creado.script.total;
    assert.equal(total, 6, 'el guion de prueba tiene 6 palabras');

    page = await openChromePage(ctx.bin, 'about:blank');
    const c = page.cdp;
    // Colección de errores de página ANTES de que la página ejecute: el listener viaja con
    // addScriptToEvaluateOnNewDocument, así que captura también el primer render.
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errores = []; addEventListener('error', e => window.__errores.push(String(e.message)));`,
    });
    const nav = await c.send('Page.navigate', { url: `${base}/widget/teleprompter` });
    assert.ok(!nav?.errorText, 'navegación al widget sin error');
    // render() terminado: hay tantas palabras como dice el snapshot del servidor.
    await waitChromeDom(c, `!!document.querySelector('.w')`, { timeoutMs: 15000 });
    await new Promise(r => setTimeout(r, 300));

    assert.equal(await dom(c, `document.querySelectorAll('.w').length`), total, 'todas las palabras están en el DOM');
    const primera = await dom(c, `document.querySelector('.p')?.textContent || ''`);
    assert.ok(primera.includes('uno') && primera.includes('tres'), 'las palabras del PRIMER párrafo están presentes');
    assert.equal(await dom(c, `document.querySelectorAll('.blk .p').length`), 2, 'un p.p por párrafo');
    assert.deepEqual(
      await dom(c, `Array.from(document.querySelector('.blk').children).map(el => el.tagName.toLowerCase() + (el.className ? '.' + el.className : ''))`),
      ['h3.bt', 'p.p', 'p.p'],
      'orden del bloque: título primero y después los párrafos',
    );
    assert.ok(await dom(c, `!!document.querySelector('.note')`), 'la [nota] se renderiza');

    const errores = await dom(c, `window.__errores || []`);
    assert.deepEqual(errores, [], 'sin errores de página capturados');
  } finally { await closeAll(() => page && closeChrome(page), close); }
});
