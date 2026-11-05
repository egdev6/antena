// S6 de punta a punta en Chrome: la shell manda una alerta real al SDK y el código del usuario
// del overlay la recibe dentro del marco opaco. El marco es un OOPIF (origen opaco), así que su
// DOM no se puede leer desde el target del padre: el propio código del usuario avisa a un
// servidor local de la prueba, que es lo que se comprueba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { findChrome, openChromePage } from './helpers/react-browser.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Servidor local que apunta las peticiones del marco (el canal de vuelta de la prueba). */
async function recorder() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    async waitFor(predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = hits.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`la prueba no recibió la petición esperada; llegaron: ${JSON.stringify(hits)}`);
        await sleep(100);
      }
    },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}

test('un overlay propio recibe la alerta por el SDK dentro del marco opaco', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-browser-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  });
  let chrome;
  try {
    // El código del usuario comprueba que el SDK ya existe, espera a ready y se suscribe a las alertas.
    const overlay = (await api('POST', '/api/custom-overlays', {
      name: 'SDK en vivo',
      js: [
        `fetch('${back.base}/sdk-loaded?typeof=' + encodeURIComponent(typeof antena), { mode: 'no-cors' });`,
        "antena.ready.then(() => fetch('" + back.base + "/sdk-ready', { mode: 'no-cors' }));",
        "antena.on('alert', a => fetch('" + back.base + "/sdk-alert?user=' + encodeURIComponent(a.vars.user) + '&title=' + encodeURIComponent(a.title), { mode: 'no-cors' }));",
      ].join('\n'),
    })).overlay;

    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    // El SDK es un script clásico en el head: existe antes de que corra el código del usuario.
    assert.match(decodeURIComponent(await back.waitFor(h => h.startsWith('/sdk-loaded'))), /typeof=object/);
    // ready se resuelve cuando la shell ya conectó y empujó los snapshots.
    await back.waitFor(h => h === '/sdk-ready');

    // El padre no puede leer el marco: origen opaco de verdad (S5).
    const crossOrigin = await chrome.cdp.send('Runtime.evaluate', {
      expression: "(() => { try { return document.querySelector('iframe').contentDocument === null ? 'blocked' : 'readable'; } catch (e) { return 'throws'; } })()",
      returnByValue: true,
    });
    assert.notEqual(crossOrigin.result?.value, 'readable', 'el padre no lee el DOM del marco');

    await api('POST', '/api/simulate', { type: 'follow', vars: { user: 'ana' } });
    const hit = new URL(await back.waitFor(h => h.startsWith('/sdk-alert')), back.base);
    assert.equal(hit.searchParams.get('user'), 'ana');
    assert.equal(hit.searchParams.get('title'), 'Nuevo seguidor');
  } finally {
    if (chrome) { chrome.child.kill(); try { await chrome.cdp.close(); } catch { /* socket ya cerrado */ } }
    await back.close();
    app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
