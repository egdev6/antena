// Issue #3 · la píldora de estado de conexión usa la MISMA redacción canónica en las tres
// superficies (panel #/directo, /dock y /prompter): «Twitch · desconectado», «YouTube ·
// desconectado» y «Meld · desconectado». Antes cada superficie la redactaba a su manera
// («Twitch: desconectado», «Twitch sin conectar», «YouTube · parado»).
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-conn-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { bin, app, base, close: async () => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(); } };
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const api = (base, method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => { if (!r.ok) throw new Error(`${method} ${url}: ${r.status}`); return r.json(); });
function eq(actual, expected) { if (actual !== expected) throw new Error(`esperaba ${JSON.stringify(expected)}, hubo ${JSON.stringify(actual)}`); }

// Texto de la píldora de conexión que empieza por un prefijo («Twitch ·», «YouTube ·»…) dentro de un contenedor.
const pillText = (container, prefix) =>
  `(Array.from(document.querySelectorAll('${container} .eg-status')).map(x => x.textContent.trim()).find(t => t.startsWith(${JSON.stringify(prefix)})) ?? '')`;

test('las tres superficies redactan el estado de conexión igual', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    // Meld activado en configuración para que el prompter también muestre su píldora.
    await api(base, 'PUT', '/api/config', { meld: { enabled: true } });

    // Panel (#/directo): píldoras de la fila de conexiones.
    chrome = await openChromePage(bin, `${base}/#/directo`);
    await waitDom(chrome.cdp, `!!(${pillText('[aria-label=Conexiones]', 'Twitch ·')} && ${pillText('[aria-label=Conexiones]', 'YouTube ·')} && ${pillText('[aria-label=Conexiones]', 'Meld ·')})`, { timeoutMs: 15000 });
    const panel = {
      twitch: await dom(chrome, pillText('[aria-label=Conexiones]', 'Twitch ·')),
      youtube: await dom(chrome, pillText('[aria-label=Conexiones]', 'YouTube ·')),
      meld: await dom(chrome, pillText('[aria-label=Conexiones]', 'Meld ·')),
    };
    // En reposo, sin credenciales: Twitch desconectado y YouTube en la misma familia (YouTube
    // descansa en 'parado' internamente, pero se muestra como «desconectado»). Meld puede estar
    // 'desconectado' o 'reintentando' (la app lo busca en cuanto se activa): lo que manda es que
    // las tres superficies muestren el MISMO texto para ese estado.
    eq(panel.twitch, 'Twitch · desconectado');
    eq(panel.youtube, 'YouTube · desconectado');
    await closeChrome(chrome); chrome = null;

    // Dock: los avisos de la cabecera usan la misma píldora y la misma redacción.
    chrome = await openChromePage(bin, `${base}/dock`);
    await waitDom(chrome.cdp, `!!(${pillText('.d-warns', 'Twitch ·')} && ${pillText('.d-warns', 'Meld ·')})`, { timeoutMs: 15000 });
    eq(await dom(chrome, pillText('.d-warns', 'Twitch ·')), panel.twitch);
    eq(await dom(chrome, pillText('.d-warns', 'Meld ·')), panel.meld);
    await closeChrome(chrome); chrome = null;

    // Prompter: la barra superior usa la misma píldora y la misma redacción.
    chrome = await openChromePage(bin, `${base}/prompter`);
    await waitDom(chrome.cdp, `!!(${pillText('.pr-warns', 'Twitch ·')} && ${pillText('.pr-warns', 'Meld ·')})`, { timeoutMs: 15000 });
    eq(await dom(chrome, pillText('.pr-warns', 'Twitch ·')), panel.twitch);
    eq(await dom(chrome, pillText('.pr-warns', 'Meld ·')), panel.meld);
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});
