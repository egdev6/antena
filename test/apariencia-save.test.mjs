// #157 Apariencia: carrera entre el borrador y un punto de partida, y fallo del guardado (guardado manual, v2).
// Por la interfaz pública (panel React en Chrome): cambiar un color y, antes del
// debounce, aplicar un punto de partida debe dejar el tema del preset en el
// servidor; y si PUT /api/theme falla, el panel vuelve al último tema guardado
// y avisa con un toast de error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';

const setNativeValue = `(el, v) => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(el.tagName === 'SELECT' ? new Event('change', { bubbles: true }) : new Event('input', { bubbles: true }));
}`;

test('apariencia: el punto de partida gana a un cambio pendiente del autoguardado', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-apariencia-157-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const temaGuardado = async () => (await fetch(`${base}/api/theme`).then(r => r.json())).theme;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia`);
    const c = chrome.cdp;
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!document.querySelector('#ap-preset')`, { timeoutMs: 12000 });
    await ev(`window.confirm = () => true`);
    // el servidor tarda 800 ms en contestar al preset: más que el debounce de 350 ms,
    // así que el autoguardado dispara mientras la petición sigue en vuelo (#164)
    await ev(`(() => {
      const real = window.fetch;
      window.fetch = async (url, opts) => {
        const r = await real(url, opts);
        if (String(url).includes('/api/theme/preset')) await new Promise(res => setTimeout(res, 800));
        return r;
      };
    })()`);

    // sin esperar el debounce, se aplica el punto de partida «cian»
    await ev(`(() => {
      const input = document.querySelector('.ap-color input.mono');
      (${setNativeValue})(input, '#00FF00');
    })()`);
    await ev(`(() => {
      const sel = document.querySelector('#ap-preset');
      (${setNativeValue})(sel, 'cian');
    })()`);
    await waitDom(c, `true`, { timeoutMs: 1200 });
    // deja pasar el debounce (350 ms), el autoguardado y la respuesta lenta del preset (800 ms)
    await new Promise(r => setTimeout(r, 1800));
    const trasPreset = await temaGuardado();
    assert.equal(trasPreset.accent, '#00D1FF',
      `el preset «cian» gana al cambio pendiente (guardado ${trasPreset.accent})`);
  } finally {
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});

test('apariencia: si «Guardar» falla, avisa y el borrador sigue; «Descartar» vuelve al tema guardado', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-apariencia-157-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const temaGuardado = async () => (await fetch(`${base}/api/theme`).then(r => r.json())).theme;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/apariencia`);
    const c = chrome.cdp;
    // sin reconexión de SSE: un reintento recargaría el tema del servidor y enmascararía
    // la reversión; así la única vía de volver al tema guardado es la del panel
    await c.send('Network.enable');
    await c.send('Network.setBlockedURLs', { urls: ['/api/stream*'] });
    const ev = expr => import('./helpers/chrome-dom.mjs').then(m => m.evaluateChrome(c, expr));
    await waitDom(c, `!!document.querySelector('#ap-preset')`, { timeoutMs: 12000 });
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
    chrome?.cdp.close(); chrome?.child.kill();
    await new Promise(r => app.server.close(r));
  }
});
