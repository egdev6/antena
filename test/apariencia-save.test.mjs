// #157: import wins over a pending draft; failed manual saves preserve the draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';

const setNativeValue = `(el, v) => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(el.tagName === 'SELECT' ? new Event('change', { bubbles: true }) : new Event('input', { bubbles: true }));
}`;

test('apariencia: la importación gana a un borrador pendiente', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-apariencia-157-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const temaGuardado = async () => (await fetch(`${base}/api/theme`).then(r => r.json())).theme;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia/color`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!document.querySelector('#ap-color')`, { timeoutMs: 12000 });
    await ev(`window.prompt = () => '{"accent":"#00D1FF"}'`);
    // Retener la respuesta de importación más que el debounce del borrador (#164).
    await ev(`(() => {
      const real = window.fetch;
      window.fetch = async (url, opts) => {
        const r = await real(url, opts);
        if (String(url).includes('/api/theme/import')) await new Promise(res => setTimeout(res, 800));
        return r;
      };
    })()`);

    // Sin esperar el debounce, se importa otro aspecto.
    await ev(`(() => {
      const input = document.querySelector('.ap-color input.mono');
      (${setNativeValue})(input, '#00FF00');
    })()`);
    await ev(`(() => {
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Importar').click();
    })()`);
    await waitDom(c, `true`, { timeoutMs: 1200 });
    // Deja pasar el debounce y la respuesta lenta de importación.
    await new Promise(r => setTimeout(r, 1800));
    const imported = await temaGuardado();
    assert.equal(imported.accent, '#00D1FF', 'la importación gana al borrador pendiente');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => new Promise(r => app.server.close(r)));
  }
});

test('apariencia: si «Guardar» falla, avisa y el borrador sigue; «Descartar» vuelve al tema guardado', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-apariencia-157-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const temaGuardado = async () => (await fetch(`${base}/api/theme`).then(r => r.json())).theme;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia/color`);
    const c = chrome.cdp;
    // sin reconexión de SSE: un reintento recargaría el tema del servidor y enmascararía
    // la reversión; así la única vía de volver al tema guardado es la del panel
    await c.send('Network.enable');
    await c.send('Network.setBlockedURLs', { urls: ['/api/stream*'] });
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!document.querySelector('#ap-color')`, { timeoutMs: 12000 });
    const ultimo = (await temaGuardado()).accent;
    // PUT /api/theme falla (el borrador, PUT /api/theme/draft, sí funciona)
    await ev(`(() => {
      const real = window.fetch;
      window.fetch = (url, opts) => {
        if ((url === '/api/theme' || String(url).endsWith('/api/theme')) && (opts?.method || 'GET') === 'PUT') {
          return Promise.resolve(new Response(JSON.stringify({ error: 'no se pudo guardar el tema' }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
        }
        return real(url, opts);
      };
    })()`);
    await ev(`(() => {
      const input = document.querySelector('.ap-color input.mono');
      (${setNativeValue})(input, '#123456');
    })()`);
    // guardado manual: nada se guarda hasta «Guardar»
    await waitDom(c, `!document.querySelector('.lv-sfoot .eg-btn--secondary').disabled`, { timeoutMs: 9000 });
    assert.equal((await temaGuardado()).accent, ultimo, 'sin pulsar Guardar el tema guardado no cambia');
    await ev(`document.querySelector('.lv-sfoot .eg-btn--secondary').click()`);
    // falla: toast de error, el borrador sigue en pantalla y el tema guardado no cambió
    await waitDom(c, `document.querySelector('.toast.err.on')?.textContent.includes('no se pudo guardar el tema')`, { timeoutMs: 9000 });
    assert.equal(await ev(`document.querySelector('.ap-color input.mono').value`), '#123456', 'el borrador no se pierde');
    assert.equal(await ev(`document.querySelector('.lv-dirty').classList.contains('is-on')`), true, 'sigue habiendo cambios sin guardar');
    assert.equal((await temaGuardado()).accent, ultimo, 'el tema guardado no cambió');
    // «Descartar» vuelve al último tema guardado
    await ev(`[...document.querySelectorAll('.lv-sfoot button')].find(b => b.textContent.trim() === 'Descartar').click()`);
    await waitDom(c, `document.querySelector('.ap-color input.mono').value === ${JSON.stringify(ultimo)}`, { timeoutMs: 9000 });
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => new Promise(r => app.server.close(r)));
  }
});
