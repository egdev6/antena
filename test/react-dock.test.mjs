// #105 en la interfaz React: vista Dock (/dock). Carga, estado, pausar y saltar, botones de
// atajos propios que lanzan su atajo y pestañas Control/Escenas/Audio (el chat salió del dock).
// Efecto observable: estado del motor en el servidor (pausa) y notas de la sesión (marca).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';

const call = (base, method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());

test('dock React: estado, pausa, atajo propio desde el dock y pestañas sin chat', { timeout: 120000 }, async t => {
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

    // estado visible: cabecera de sesión y pestañas Control/Escenas/Audio; sin chat
    assert.ok(await ev(`document.querySelector('.d-live').textContent.includes('Sesión') || document.querySelector('.d-live').textContent.includes('Sin emitir')`));
    const tabs = await ev(`Array.from(document.querySelectorAll('[role="tablist"] [role="tab"]')).map(b => b.textContent.trim())`);
    assert.deepEqual(tabs, ['Control', 'Escenas', 'Audio'], 'el dock ya no tiene pestaña de chat (S12)');
    assert.equal(await ev(`!!document.querySelector('.d-chat, .d-msgs, .d-send')`), false, 'sin mini-chat en el dock');

    // botones de atajos propios: el creado antes aparece y al pulsarlo ejecuta su marca en el servidor
    const scBtn = `Array.from(document.querySelectorAll('.d-grid .sc')).find(b => b.textContent.includes('Empezar el directo'))`;
    await waitDom(c, `!!(${scBtn})`, { timeoutMs: 9000 });
    await clickWhen(c, scBtn);
    await waitDom(c, `document.querySelector('.toast[role="status"]')?.textContent.includes('Empezar el directo')`, { timeoutMs: 9000 });
    const note = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'marker')), 300));
    assert.ok(note, 'el atajo del dock creó la marca en la sesión del servidor');

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
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
