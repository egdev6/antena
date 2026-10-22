// #157 Apariencia: el overlay aplica el tema de Apariencia (public/overlay.html).
// En Chrome sobre el overlay real servido por el servidor: icono emoji y logo de
// plataforma por tipo de alerta, etiqueta de plataforma como logo y clase de
// posición del tema, todo llegando por SSE (`theme` + `alert` de vista previa).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';

test('overlay: icono por tipo, etiqueta como logo y posición del tema', { timeout: 90000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-overlay-157-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    // tema con icono emoji para follow, logo para sub, badge como logo y posición abajo
    const put = await fetch(`${base}/api/theme`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 'bottom', platformBadge: 'logo', icons: { follow: 'emoji:🎉', sub: 'logo' } }),
    });
    assert.equal(put.status, 200, 'el tema se guardó');
    chrome = await openChromePage(bin, `${base}/overlay?preview&mute`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));

    // el tema llega por SSE: posición del tema en la clase de la escena
    await waitDom(c, `document.querySelector('#stage').classList.contains('bottom')`, { timeoutMs: 12000 });
    await waitDom(c, `document.getElementById('eg-theme').href.includes('v=')`, { timeoutMs: 5000 });

    // follow con icono emoji del tema y etiqueta de plataforma como logo
    const p1 = await fetch(`${base}/api/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'follow', target: 'preview' }) });
    assert.equal(p1.status, 200);
    await waitDom(c, `document.querySelector('.alert-card.type-follow .tile .emoji')?.textContent === '🎉'`, { timeoutMs: 9000 });
    const badge1 = await ev(`(() => {
      const card = document.querySelector('.alert-card.type-follow');
      return { logo: !!card.querySelector('.alert-title .pf.as-logo svg'), cls: card.className };
    })()`);
    assert.ok(badge1.logo, 'la etiqueta de plataforma sale como logo (Twitch)');
    assert.ok(badge1.cls.includes('pf-twitch'), 'la tarjeta lleva la clase de plataforma');

    // sub con icono «logo» del tema: el logo de plataforma dentro de la casilla
    const p2 = await fetch(`${base}/api/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'sub', target: 'preview' }) });
    assert.equal(p2.status, 200);
    await waitDom(c, `!!document.querySelector('.alert-card.type-sub .tile svg.logo')`, { timeoutMs: 9000 });
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
