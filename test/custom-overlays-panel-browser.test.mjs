// S3/S10: la sección «Overlays» del panel. Catálogo en tarjetas con el estado vacío que explica
// que el agente los crea por MCP, editor en slide con HTML/CSS/JS, vista previa en vivo, pruebas,
// borrado y cambios del agente por SSE que nunca pisan el borrador local. Todo por las interfaces
// públicas (panel, HTTP y SSE): la prueba no lee el estado interno de la vista.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome as closeSharedChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-overlays-panel-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  app.store.config.panel = { onboardingDone: true };   // la bienvenida taparía la vista
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
    return d;
  };
  return {
    bin, app, base, api,
    close: async () => { app.timers.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); },
  };
}

const dom = (cdp, expr) => evaluateChrome(cdp, expr, { timeoutMs: 12000 });

/** Escribe en un input o textarea como lo haría una persona: el setter nativo y el evento input. */
const setValue = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) throw new Error('sin ' + ${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value;
})()`;

/** Sondeo hasta que el valor leído coincide (sin sleeps fijos). */
async function eventually(read, expected, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  let actual = await read();
  while (actual !== expected && Date.now() < until) { await sleep(50); actual = await read(); }
  assert.equal(actual, expected);
}

/** Lector SSE mínimo: las pruebas observan lo que el panel/la capa recibe por el stream público. */
async function sse(base, client, t) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream?client=${client}`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* abortado al cerrar */ }
  })();
  const close = () => ctrl.abort();
  t.after(close);
  return {
    async wait(event, pred = () => true, timeoutMs = 8000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const e = events.find(x => x.event === event && pred(x.data));
        if (e) return e.data;
        if (Date.now() > until) throw new Error(`no llegó «${event}» en ${timeoutMs} ms`);
        await sleep(50);
      }
    },
  };
}

const closeChrome = async chrome => { if (chrome) await closeSharedChrome(chrome); };

test('panel: Overlays en el grupo de Widgets, estado vacío que habla del agente, crear y Fuentes para Meld', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, app, base, api, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/overlays`);
    const c = chrome.cdp;
    await waitDom(c, `location.hash === '#/overlays' && !!document.querySelector('main .view-head h1')`, { timeoutMs: 15000 });
    assert.equal(await dom(c, `document.querySelector('main .view-head h1').textContent.trim()`), 'Overlays');

    // la entrada cuelga del mismo grupo que Widgets
    const nav = JSON.parse(await dom(c, `JSON.stringify(Array.from(document.querySelectorAll('#nav .nav-grp')).map(g => [g.querySelector('.grp-l').textContent.trim(), Array.from(g.querySelectorAll('a.eg-menu__item')).map(a => [a.getAttribute('href'), a.querySelector('.eg-menu__label').textContent.trim()])]))`));
    const configurar = nav.find(([label]) => label === 'Configurar');
    assert.ok(configurar, 'el grupo Configurar existe');
    assert.ok(configurar[1].some(([href]) => href === '#/widgets'), 'Widgets sigue en ese grupo');
    assert.ok(configurar[1].some(([href, label]) => href === '#/overlays' && label === 'Overlays'), 'Overlays cuelga del grupo de Widgets');

    // estado vacío: el agente puede crearlos por MCP
    const empty = await dom(c, `document.querySelector('main .empty-state')?.textContent || ''`);
    assert.match(empty, /Pídele a Claude: «crea un overlay con un marco para la cámara»/);
    assert.equal(await dom(c, `document.querySelectorAll('main .lv-card').length`), 0);

    // crear desde el panel
    await dom(c, `${buttonByText('Nuevo overlay')}.click()`);
    await waitDom(c, `location.hash.startsWith('#/overlays/') && !!document.querySelector('main .lv-slide')`, { timeoutMs: 12000 });
    const created = await api('GET', '/api/custom-overlays');
    assert.equal(created.overlays.length, 1);
    assert.equal(created.overlays[0].name, 'Overlay nuevo');
    const id = created.overlays[0].id;
    assert.equal(new URL(await dom(c, 'location.href')).hash, `#/overlays/${id}`, 'el slide nuevo abre con su id');

    // ya no hay estado vacío y la tarjeta está en el catálogo, con su contador en la barra lateral
    await dom(c, `location.hash = '#/overlays'`);
    await waitDom(c, `!!document.querySelector('main .lv-card .lv-cname')`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `document.querySelector('main .lv-card .lv-cname').textContent.trim()`), 'Overlay nuevo');
    assert.equal(await dom(c, `document.querySelector('main .empty-state') ? 1 : 0`), 0);
    assert.equal(await dom(c, `document.querySelector('#nav a[href="#/overlays"] .nav-n')?.textContent`), '1');

    // S8: la capa propia está en Fuentes para Meld con su URL y su tamaño
    const sources = await api('GET', '/api/sources');
    const src = sources.sources.find(x => x.path === `/custom/${id}`);
    assert.ok(src, 'el overlay aparece como fuente de navegador');
    assert.equal(src.name, 'Overlay · Overlay nuevo');
    assert.equal(src.width, 1920);
    assert.equal(src.height, 1080);
    await dom(c, `location.hash = '#/fuentes'`);
    await waitDom(c, `document.body.textContent.includes('Overlay · Overlay nuevo')`, { timeoutMs: 12000 });

    // el editor abre la capa en /custom/<id> dentro del panel
    await dom(c, `location.hash = ${JSON.stringify(`#/overlays/${id}`)}`);
    await waitDom(c, `!!document.querySelector('main .lv-slide iframe')`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `document.querySelector('main .lv-slide iframe').getAttribute('src')`), `/custom/${id}`);
  } finally {
    await closeChrome(chrome);
    await close();
    void app;
  }
});

test('panel: editar el CSS y guardar persiste y sube updatedAt; un ancho inválido enseña el 400 y no guarda; borrar quita el overlay', { timeout: 150000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, api, close } = ctx;
  let chrome;
  try {
    const { overlay } = await api('POST', '/api/custom-overlays', { name: 'Marco cámara', css: '.marco{}' });
    const before = overlay.updatedAt;

    // una capa abierta (cliente «widget») recibe la prueba que se lanza desde el panel
    const widget = await sse(ctx.base, 'widget', t);

    chrome = await openChromePage(bin, `${ctx.base}/#/overlays/${overlay.id}`);
    const c = chrome.cdp;
    await waitDom(c, `!!document.querySelector('textarea[data-code]')`, { timeoutMs: 15000 });
    assert.equal(await dom(c, `document.querySelector('input[aria-label="Nombre del overlay"]').value`), 'Marco cámara');
    assert.equal(await dom(c, `document.querySelector('input[aria-label=Ancho]').value`), '1920');

    // pestaña CSS del código
    await dom(c, `Array.from(document.querySelectorAll('[role=tablist][aria-label=Código] [role=tab]')).find(b => b.textContent.trim() === 'CSS').click()`);
    await waitDom(c, `!!document.querySelector('textarea[data-code=css]')`, { timeoutMs: 12000 });
    await dom(c, setValue('textarea[data-code=css]', '.marco{border:4px solid #f00}'));

    // guardado manual: nada se persiste antes de «Guardar»
    await sleep(400);
    assert.equal((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.css, '.marco{}');
    await waitDom(c, `!document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`, { timeoutMs: 12000 });
    await dom(c, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').click()`);
    await eventually(async () => (await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.css, '.marco{border:4px solid #f00}');
    const after = (await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay;
    assert.ok(after.updatedAt > before, `updatedAt sube al guardar (${before} → ${after.updatedAt})`);
    await waitDom(c, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`, { timeoutMs: 12000 });

    // «Probar alerta» manda el evento de ejemplo a la capa por el stream público
    await dom(c, `${buttonByText('Probar alerta')}.click()`);
    const test1 = await widget.wait('customOverlayTest', d => d.id === overlay.id && d.event === 'alert');
    assert.equal(test1.data.type, 'follow');
    await dom(c, `${buttonByText('Probar espectadores')}.click()`);
    await widget.wait('customOverlayTest', d => d.id === overlay.id && d.event === 'viewers');

    // un 400 del servidor se enseña tal cual y no guarda nada
    await dom(c, setValue('input[aria-label=Ancho]', '5'));
    await waitDom(c, `!document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`, { timeoutMs: 12000 });
    await dom(c, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').click()`);
    await waitDom(c, `(document.querySelector('.toast')?.textContent || '').includes('El ancho tiene que ser un número entero entre 16 y 7680')`, { timeoutMs: 12000 });
    assert.equal((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.width, 1920, 'el ancho inválido no se guarda');
    assert.equal(await dom(c, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`), false, 'el borrador sigue ahí para corregirlo');

    // borrar el overlay (confirmación nativa sustituida: en headless no hay diálogo)
    await dom(c, `window.confirm = () => true; 'ok'`);
    await dom(c, `${buttonByText('Borrar overlay')}.click()`);
    await eventually(async () => (await api('GET', '/api/custom-overlays')).overlays.length, 0);
    await waitDom(c, `location.hash === '#/overlays' && !!document.querySelector('main .empty-state')`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `document.querySelectorAll('main .lv-card').length`), 0);
  } finally {
    await closeChrome(chrome);
    await close();
  }
});

test('panel: un cambio del agente llega al editor abierto y nunca pisa el borrador', { timeout: 150000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, api, close } = ctx;
  let chrome;
  try {
    const { overlay } = await api('POST', '/api/custom-overlays', { name: 'Título animado', css: '.a{}' });
    chrome = await openChromePage(bin, `${ctx.base}/#/overlays/${overlay.id}`);
    const c = chrome.cdp;
    await waitDom(c, `!!document.querySelector('textarea[data-code]')`, { timeoutMs: 15000 });
    await dom(c, `Array.from(document.querySelectorAll('[role=tablist][aria-label=Código] [role=tab]')).find(b => b.textContent.trim() === 'CSS').click()`);
    await waitDom(c, `!!document.querySelector('textarea[data-code=css]')`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `document.querySelector('textarea[data-code=css]').value`), '.a{}');

    // sin cambios locales: la versión del agente entra sola
    await api('PUT', `/api/custom-overlays/${overlay.id}`, { css: '.remoto{}' });
    await waitDom(c, `document.querySelector('textarea[data-code=css]').value === '.remoto{}'`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `document.querySelector('[data-agent-change]') ? 1 : 0`), 0);

    // con cambios locales: aviso y el borrador se queda como está
    await dom(c, setValue('textarea[data-code=css]', '.borrador{}'));
    await dom(c, `document.querySelector('textarea[data-code=css]').blur(); 'ok'`);
    await api('PUT', `/api/custom-overlays/${overlay.id}`, { css: '.agente{}' });
    await waitDom(c, `!!document.querySelector('[data-agent-change]')`, { timeoutMs: 12000 });
    assert.match(await dom(c, `document.querySelector('[data-agent-change]').textContent`), /El agente ha cambiado este overlay/);
    assert.equal(await dom(c, `document.querySelector('textarea[data-code=css]').value`), '.borrador{}', 'el borrador no se pisa');
    assert.equal((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.css, '.agente{}');

    // cargar la versión nueva descarta el borrador a propósito
    await dom(c, `${buttonByText('Cargar la versión nueva')}.click()`);
    await waitDom(c, `document.querySelector('textarea[data-code=css]').value === '.agente{}'`, { timeoutMs: 12000 });
    assert.equal(await dom(c, `document.querySelector('[data-agent-change]') ? 1 : 0`), 0);
  } finally {
    await closeChrome(chrome);
    await close();
  }
});

// T5/S11d: la sección «Permisos» del editor. El usuario aprueba y revoca desde el panel (la
// petición sale del navegador, con Sec-Fetch-Site: same-origin), ve los pedidos y los aprobados,
// y el editor avisa cuando el código ha cambiado desde la última aprobación.
test('panel: aprueba y revoca permisos, y avisa si el código cambió desde la aprobación', { timeout: 150000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { bin, api, close } = ctx;
  let chrome;
  const warning = 'El código ha cambiado desde que aprobaste los permisos';
  try {
    const { overlay } = await api('POST', '/api/custom-overlays', { name: 'Con permisos', requestedPermissions: ['scene', 'say'], js: 'antena.on("alert", () => {});' });
    chrome = await openChromePage(bin, `${ctx.base}/#/overlays/${overlay.id}`);
    const c = chrome.cdp;
    await waitDom(c, `!!document.querySelector('[data-permisos]')`, { timeoutMs: 15000 });
    const block = await dom(c, `document.querySelector('main .lv-slide').textContent`);
    assert.match(block, /Permisos/);
    assert.match(block, /Cambiar de escena/i);
    assert.match(block, /Leer en voz alta/i);
    // Empieza sin nada aprobado.
    assert.equal(await dom(c, `document.querySelectorAll('[data-perm] input:checked').length`), 0);

    // Aprobar «Cambiar de escena» desde el panel: la aprobación queda guardada.
    await dom(c, `document.querySelector('[data-perm="scene"] input').click(), 'ok'`);
    await waitDom(c, `document.querySelector('[data-perm="scene"] input').checked`, { timeoutMs: 12000 });
    await eventually(async () => JSON.stringify((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.permissions), '["scene"]');
    const approved = (await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay;
    assert.ok(approved.approvedAt > 0);
    assert.equal(approved.approvedUpdatedAt, approved.updatedAt, 'aprobar no versiona el código');
    assert.equal(await dom(c, `document.body.textContent.includes(${JSON.stringify(warning)}) ? 1 : 0`), 0, 'sin cambios de código no hay aviso');

    // El agente cambia el JavaScript: el editor avisa y la aprobación se conserva.
    await api('PUT', `/api/custom-overlays/${overlay.id}`, { js: 'antena.on("chat", () => {});' });
    await waitDom(c, `document.body.textContent.includes(${JSON.stringify(warning)})`, { timeoutMs: 12000 });
    assert.deepEqual((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.permissions, ['scene']);

    // Revocar desde el panel: el aviso desaparece (no queda nada aprobado).
    await dom(c, `document.querySelector('[data-perm="scene"] input').click(), 'ok'`);
    await waitDom(c, `document.querySelector('[data-perm="scene"] input').checked === false`, { timeoutMs: 12000 });
    await eventually(async () => JSON.stringify((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.permissions), '[]');
    await waitDom(c, `document.body.textContent.includes(${JSON.stringify(warning)}) ? 0 : 1`, { timeoutMs: 12000 });

    // Volver a aprobar el código nuevo deja la aprobación al día: el aviso no vuelve.
    await dom(c, `document.querySelector('[data-perm="scene"] input').click(), 'ok'`);
    await waitDom(c, `document.querySelector('[data-perm="scene"] input').checked`, { timeoutMs: 12000 });
    await eventually(async () => JSON.stringify((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay.permissions), '["scene"]');
    assert.equal(await dom(c, `document.body.textContent.includes(${JSON.stringify(warning)}) ? 1 : 0`), 0);
  } finally {
    await closeChrome(chrome);
    await close();
  }
});
