// Miniaturas de las tarjetas de Alertas: son el overlay de verdad en pequeño (/overlay?still=<tipo>)
// y se rehacen cuando cambia lo que se ve (Apariencia o la propia alerta), sin recargar el panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const frame = type => `document.querySelector('.lv-still iframe[src*="still=${type}&"]')`;
const inFrame = (type, expr) => `(() => { const d = ${frame(type)}?.contentDocument; return d ? (${expr}) : null; })()`;

test('alertas: la miniatura es el overlay real y sigue a Apariencia y a la configuración guardadas', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-thumbs-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  let chrome;
  try {
    // la muestra: la alerta de ejemplo con lo guardado, sin entregarla a ningún overlay
    const sample = await fetch(`${base}/api/alerts/follow/sample`).then(r => r.json());
    assert.equal(sample.alert.type, 'follow');
    assert.ok(sample.theme.version, 'trae el tema público');
    assert.equal((await fetch(`${base}/api/alerts/nada/sample`)).status, 404);

    app.store.config.panel = { onboardingDone: true };
    chrome = await openChromePage(bin, `${base}/#/alertas`);
    const c = chrome.cdp;
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitDom(c, `document.querySelectorAll('.lv-card .lv-still iframe').length === 14`, { timeoutMs: 15000 });
    await waitDom(c, inFrame('follow', `!!d.querySelector('.alert.on .alert-name')?.textContent`), { timeoutMs: 15000 });
    // quieta: sin conexión en directo ni sonido; la tarjeta se queda
    assert.equal(await evaluateChrome(c, inFrame('follow', `d.body.classList.contains('still')`)), true);

    // cambiar el título de la alerta: la miniatura se rehace con el nuevo
    const src0 = await evaluateChrome(c, `${frame('follow')}.src`);
    await api('PUT', '/api/alerts/follow', { title: 'Bienvenida al canal' });
    await waitDom(c, `${frame('follow')}?.src !== ${JSON.stringify(src0)}`, { timeoutMs: 9000 });
    await waitDom(c, inFrame('follow', `d.querySelector('.alert-title')?.textContent.includes('Bienvenida al canal')`), { timeoutMs: 12000 });

    // Apariencia: otro color de acento llega a todas las miniaturas
    const src1 = await evaluateChrome(c, `${frame('raid')}.src`);
    await api('PUT', '/api/theme', { accent: '#00D1FF' });
    await waitDom(c, `${frame('raid')}?.src !== ${JSON.stringify(src1)}`, { timeoutMs: 9000 });
    await waitDom(c, inFrame('raid', `getComputedStyle(d.querySelector('.alert')).getPropertyValue('--accent').trim().toUpperCase() === '#00D1FF'`), { timeoutMs: 12000 });
  } finally {
    if (chrome) await closeChrome(chrome);
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
