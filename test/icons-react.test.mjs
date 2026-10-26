// #22 · los iconos se pintan como elementos React, nunca con innerHTML: ninguna fuente de
// app/src usa dangerouslySetInnerHTML y el SVG que sale es el mismo de antes del cambio
// (marcado capturado de main 42f0a15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('ninguna fuente de app/src usa dangerouslySetInnerHTML', async () => {
  // fileURLToPath, not URL#pathname: on Windows the pathname is «/D:/…» and path.join breaks it
  const src = fileURLToPath(new URL('../app/src', import.meta.url));
  const files = (await readdir(src, { recursive: true })).filter(f => /\.(tsx?|jsx?|mjs)$/.test(f));
  const offenders = [];
  for (const f of files) if ((await readFile(path.join(src, f), 'utf8')).includes('dangerouslySetInnerHTML')) offenders.push(f);
  assert.equal(offenders.join(', '), '');
});

// Atributos del <svg> que pinta Icon; solo cambia la clase.
const svg = (cls, body) => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const BEFORE = {
  directo: svg('eg-icon', '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>'),
  up: svg('eg-icon', '<path d="m18 15-6-6-6 6"></path>'),
  down: svg('eg-icon', '<path d="m6 9 6 6 6-6"></path>'),
  x: svg('eg-icon', '<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>'),
};

test('los iconos pintan el mismo SVG que antes (barra lateral e IconBtn)', { timeout: 90000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-icons-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    // dos preguntas en cola: la primera tiene «Bajar» activo y la segunda «Subir»
    for (const text of ['¿Primera pregunta de prueba?', '¿Segunda pregunta de prueba?']) {
      const r = await fetch(base + '/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      assert.equal(r.status, 200);
    }
    chrome = await openChromePage(bin, `${base}/#/preguntas`);
    await waitDom(chrome.cdp, `!!document.querySelector('button[aria-label=Subir]:not([disabled])')`, { timeoutMs: 12000 });
    const got = JSON.parse(await evaluateChrome(chrome.cdp, `JSON.stringify({
      directo: document.querySelector('a[href="#/directo"] svg').outerHTML,
      up: document.querySelector('button[aria-label=Subir] svg').outerHTML,
      down: document.querySelector('button[aria-label=Bajar] svg').outerHTML,
      x: document.querySelector('button[aria-label=Descartar] svg').outerHTML,
    })`, { timeoutMs: 12000 }));
    assert.deepEqual(got, BEFORE);
  } finally {
    chrome?.child.kill(); await chrome?.cdp.close();
    app.timers.stop(); app.server.closeAllConnections(); app.server.close();
  }
});
