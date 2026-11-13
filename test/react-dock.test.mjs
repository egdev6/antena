// #105 en la interfaz React: vista Dock (/dock). Carga, estado, pausar y saltar, botones de
// pestañas Control/Audio/Interactivos; los atajos propios y el chat no salen en el dock.
// Efecto observable: estado del motor en el servidor (pausa) y notas de la sesión (marca).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';

const call = (base, method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());

test('dock React: estado, pausa, pestañas sin atajos ni chat', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-dk-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // el atajo propio se crea antes de abrir la página: así llega en la instantánea de SSE
  await call(base, 'POST', '/api/shortcuts', { name: 'Empezar el directo', steps: [{ kind: 'builtin', action: 'marca' }] });
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/dock`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!(document.querySelector('.d-top') && document.querySelector('.d-grid'))`, { timeoutMs: 12000 });

    // estado visible: cabecera de sesión y pestañas Control/Audio/Interactivos; sin chat
    assert.ok(await ev(`document.querySelector('.d-live').textContent.includes('Sesión') || document.querySelector('.d-live').textContent.includes('Sin emitir')`));
    const tabs = await ev(`Array.from(document.querySelectorAll('.d-tabs [role="tab"]')).map(b => b.firstChild.textContent.trim())`);
    assert.deepEqual(tabs, ['Control', 'Audio', 'Interactivos']);
    assert.equal(await ev(`!!document.querySelector('.d-chat, .d-msgs, .d-send')`), false, 'sin mini-chat en el dock');

    // Un atajo existente sigue guardado en el panel, pero no aparece en el dock.
    assert.equal(await ev(`document.body.textContent.includes('Empezar el directo')`), false);
    assert.equal(await ev(`document.querySelectorAll('.d-grid .sc').length`), 0);

    // pausar: el botón cambia y el motor queda en pausa en el servidor; reanudar lo devuelve
    await clickWhen(c, buttonByText('⏸ Pausar'));
    await waitDom(c, `!!(${buttonByText('▶ Reanudar')})`, { timeoutMs: 9000 });
    assert.equal(app.engine.pauseState().paused, true);
    await clickWhen(c, buttonByText('▶ Reanudar'));
    await waitDom(c, `!!(${buttonByText('⏸ Pausar')})`, { timeoutMs: 9000 });
    assert.equal(app.engine.pauseState().paused, false);

    // saltar: el botón lanza la acción de serie /sd/saltar
    await clickWhen(c, buttonByText('⏭ Saltar'));
    await waitDom(c, `document.querySelector('.toast[role="status"]')?.textContent.includes('Saltada')`, { timeoutMs: 9000 });
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => new Promise(r => app.server.close(r)),
      () => rm(dataDir, { recursive: true, force: true }));
  }
});
