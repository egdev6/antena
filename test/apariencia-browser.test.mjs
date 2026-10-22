// #6 Apariencia: al abrir la vista, la vista previa de la alerta muestra una alerta
// de ejemplo al cargar, igual que la del editor de alertas (el marco carga y salen
// los datos de ejemplo, sin la marca de agua «Vista previa»). El ejemplo sale cuando
// el marco termina de cargar, no con un temporizador fijo: con un marco que tarda
// más que el disparo (la carrera del informe UX), el ejemplo no se puede perder.
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { clickWhen, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';

const chipDe = texto => `Array.from(document.querySelectorAll('.ap-tabs .eg-chip')).find(b => b.textContent.trim() === ${JSON.stringify(texto)})`;
// la alerta de ejemplo salió: nodo .alert del tipo de serie y sin marca de agua
const hayAlertaDeEjemplo = `(() => {
  const d = document.querySelector('.ap-preview .preview iframe')?.contentDocument;
  return !!d && !d.getElementById('hint') && !!d.querySelector('.alert.type-follow');
})()`;

test('apariencia: la vista previa muestra una alerta de ejemplo al cargar', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-apariencia-6-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const appPort = app.server.address().port;
  // proxy que retrasa el documento del overlay 3 s: el marco de la vista previa tarda
  // más que un disparo con temporizador fijo y la carrera del informe se hace determinista
  const proxy = http.createServer((req, res) => {
    const pasar = () => {
      const up = http.request({ hostname: '127.0.0.1', port: appPort, path: req.url, method: req.method,
        // se reescriben host y origin: el servidor valida el origen contra su host (CSRF)
        headers: { ...req.headers, host: `127.0.0.1:${appPort}`, origin: `http://127.0.0.1:${appPort}` } },
        r => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
      up.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
      req.pipe(up);
    };
    if ((req.url || '').startsWith('/overlay')) setTimeout(pasar, 3000); else pasar();
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia`);
    const c = chrome.cdp;
    // la vista carga con su marco de previsualización de alertas
    await waitDom(c, `!!document.querySelector('.ap-preview .preview iframe[src*="/overlay?preview"]')`, { timeoutMs: 12000 });
    // al cargar sale la alerta de ejemplo (tipo follow) y se quita la marca de agua
    await waitDom(c, hayAlertaDeEjemplo, { timeoutMs: 15000 });

    // y también al volver a la pestaña «Alerta» desde otra del preview: el marco se
    // remonta y su ejemplo vuelve a salir cuando el marco termina de cargar
    await clickWhen(c, chipDe('Chat'));
    await new Promise(r => setTimeout(r, 500));
    await clickWhen(c, chipDe('Alerta'));
    await waitDom(c, hayAlertaDeEjemplo, { timeoutMs: 15000 });
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    proxy.closeAllConnections(); app.server.closeAllConnections();
    await new Promise(r => app.server.close(r));
    await new Promise(r => proxy.close(r));
  }
});
