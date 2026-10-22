// #105 en la interfaz React: vista Prompter (/prompter). Carga, pestañas, chat recibido
// por SSE pintado en el DOM y una marca guardada en la cronología del servidor.
// Efecto observable: notas en la sesión del servidor (app.session.data.notes), no solo el DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';

test('prompter React: pestañas, chat por SSE y marca de short guardada en el servidor', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-pr-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/prompter`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!(document.querySelector('.top .clock') && document.querySelector('.chat'))`, { timeoutMs: 12000 });

    // pestañas del prompter: preguntas, tier list, sorteo y cronología
    const tabs = await ev(`Array.from(document.querySelectorAll('.tabs .tab')).map(b => b.textContent.replace(/\\d+|●/g, '').trim())`);
    assert.deepEqual(tabs, ['Preguntas', 'Tier list', 'Sorteo', 'Cronología']);

    // chat: un mensaje inyectado en el motor llega por SSE y se pinta con su autor y texto
    app.engine.handleChat({ id: 'c-test-1', user: 'EspectadorBot', text: 'hola desde el test', platform: 'twitch', color: '#3B5CFF' });
    await waitDom(c, `Array.from(document.querySelectorAll('.chat .msg')).some(m => m.textContent.includes('EspectadorBot') && m.textContent.includes('hola desde el test'))`, { timeoutMs: 9000 });

    // marca de short desde la vista: la cronología la recibe y el servidor guarda la nota
    const marca = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Marca de short'))`;
    await clickWhen(c, marca);
    await waitDom(c, `Array.from(document.querySelectorAll('.ev')).some(x => x.textContent.includes('Marca de short'))`, { timeoutMs: 9000 });
    const note = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'marker')), 300));
    assert.ok(note, 'la marca quedó como nota kind marker en la sesión del servidor');

    // guardar un mensaje del chat desde el prompter: nota kind saved con usuario y texto
    const guardarBtn = `Array.from(document.querySelectorAll('.chat .msg')).find(m => m.textContent.includes('EspectadorBot'))
      .querySelectorAll('.acts .act')[1]`;
    await clickWhen(c, guardarBtn);
    await waitDom(c, `(() => { const b = ${guardarBtn}; return b && b.classList.contains('done'); })()`, { timeoutMs: 9000 });
    const saved = await new Promise(r => setTimeout(() => r(app.session.data.notes.find(n => n.kind === 'saved')), 300));
    assert.ok(saved, 'el guardado quedó como nota kind saved en la sesión del servidor');
    assert.equal(saved.user, 'EspectadorBot');
    assert.equal(saved.text, 'hola desde el test');
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});

// #117 pulido tras el rediseño: la insignia de moderador se ve en el chat y el
// sorteo abierto muestra el premio y el comando de participación.
test('prompter React: insignia de mod en el chat y sorteo abierto con premio y comando', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return; // sin app/dist o sin Chrome: omitido con motivo (t.skip)
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-pr-117-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // sorteo abierto con premio, sin anuncio por chat (no hay plataforma conectada)
  for (const [p, v] of [['interactive.giveaway.prize', 'Una taza EGDEV'], ['interactive.giveaway.announceInChat', false]]) {
    const cfg = await fetch(`${base}/api/config/set`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, value: v }) });
    assert.equal(cfg.status, 200, `la configuración ${p} se guardó`);
    await cfg.json();
  }
  const abierto = await fetch(`${base}/api/giveaway/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(abierto.status, 200, 'el sorteo quedó abierto');
  await abierto.json();
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/prompter`);
    const c = chrome.cdp;
    await waitDom(c, `!!(document.querySelector('.top .clock') && document.querySelector('.chat'))`, { timeoutMs: 12000 });

    // chat: un mensaje de un moderador pinta su insignia, no solo un color
    app.engine.handleChat({ id: 'c-mod-1', user: 'ModBot', text: 'presente', platform: 'twitch', color: '#3B5CFF', mod: true });
    await waitDom(c, `!!Array.from(document.querySelectorAll('.chat .msg')).find(m => m.textContent.includes('ModBot') && m.querySelector('[title="Moderador"]'))`, { timeoutMs: 9000 });

    // sorteo: con la pestaña abierta se ven el premio y el comando mientras está abierto
    await clickWhen(c, `Array.from(document.querySelectorAll('.tabs .tab')).find(b => b.textContent.includes('Sorteo'))`);
    await waitDom(c, `(() => { const s = document.body.textContent; return s.includes('Una taza EGDEV') && s.includes('!sorteo'); })()`, { timeoutMs: 9000 });
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
