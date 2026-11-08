// #105 en la interfaz React: vista Prompter (/prompter). Carga, pestañas, chat recibido
// por SSE pintado en el DOM y una marca guardada en la cronología del servidor.
// Efecto observable: notas en la sesión del servidor (app.session.data.notes), no solo el DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';

test('prompter React: pestañas, chat por SSE y marca en la cronología guardada en el servidor', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-pr-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/prompter`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!(document.querySelector('.top .clock') && document.querySelector('.chat'))`, { timeoutMs: 12000 });

    // pestañas del prompter: Eventos (cronología y destacados) y Preguntas (S7)
    const tabs = await ev(`Array.from(document.querySelectorAll('.pr-side .tabs .tab')).map(b => b.textContent.replace(/\\d+|●/g, '').trim())`);
    assert.deepEqual(tabs, ['Eventos', 'Preguntas']);

    // chat: un mensaje inyectado en el motor llega por SSE y se pinta con su autor y texto
    app.engine.handleChat({ id: 'c-test-1', user: 'EspectadorBot', text: 'hola desde el test', platform: 'twitch', color: '#3B5CFF' });
    await waitDom(c, `Array.from(document.querySelectorAll('.chat .msg')).some(m => m.textContent.includes('EspectadorBot') && m.textContent.includes('hola desde el test'))`, { timeoutMs: 9000 });

    // marca de short creada por la API: la cronología la pinta en su bloque y el servidor la guarda
    // (el botón «Marca de short» del prompter se retiró en S7)
    await fetch(`${base}/api/markers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: '' }) });
    await waitDom(c, `Array.from(document.querySelectorAll('.ev.k-marker')).some(x => x.textContent.includes('Marca de short'))`, { timeoutMs: 9000 });
    const note = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'marker')), 300));
    assert.ok(note, 'la marca quedó como nota kind marker en la sesión del servidor');

    // guardar un mensaje del chat desde el prompter: nota kind saved con usuario y texto, en Destacados
    const guardarBtn = `Array.from(document.querySelectorAll('.chat .msg')).find(m => m.textContent.includes('EspectadorBot'))
      .querySelectorAll('.acts .act')[1]`;
    await clickWhen(c, guardarBtn);
    await waitDom(c, `(() => { const b = ${guardarBtn}; return b && b.classList.contains('done'); })()`, { timeoutMs: 9000 });
    await waitDom(c, `Array.from(document.querySelectorAll('.ev-block')[1].querySelectorAll('.ev-item')).some(x => x.textContent.includes('EspectadorBot'))`, { timeoutMs: 9000 });
    const saved = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'saved')), 300));
    assert.ok(saved, 'el guardado quedó como nota kind saved en la sesión del servidor');
    assert.equal(saved.user, 'EspectadorBot');
    assert.equal(saved.text, 'hola desde el test');
  } finally {
    if (chrome) await closeChrome(chrome);
    await new Promise(r => app.server.close(r));
  }
});

// #117 pulido tras el rediseño: la insignia de moderador se ve en el chat. El sorteo dejó el
// prompter en S7 (sigue en el dock y en su vista del panel), así que aquí solo queda la insignia.
test('prompter React: insignia de mod en el chat', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-pr-117-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/prompter`);
    const c = chrome.cdp;
    await waitDom(c, `!!(document.querySelector('.top .clock') && document.querySelector('.chat'))`, { timeoutMs: 12000 });

    // chat: un mensaje de un moderador pinta su insignia, no solo un color
    app.engine.handleChat({ id: 'c-mod-1', user: 'ModBot', text: 'presente', platform: 'twitch', color: '#3B5CFF', mod: true });
    await waitDom(c, `!!Array.from(document.querySelectorAll('.chat .msg')).find(m => m.textContent.includes('ModBot') && m.querySelector('[title="Moderador"]'))`, { timeoutMs: 9000 });
  } finally {
    if (chrome) await closeChrome(chrome);
    await new Promise(r => app.server.close(r));
  }
});
