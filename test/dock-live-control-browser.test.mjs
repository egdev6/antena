// Dock nuevo (S1–S7): tres columnas Control | Audio | Interactivos en apaisado
// ancho, pestañas Control/Audio/Interactivos en el resto; cada
// módulo manda las acciones reales del directo a la API. Meld es el simulado de
// test/helpers/fake-meld.mjs: escenas, pistas y gainUpdated salen de ahí.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const LONG_VERTICAL = 'Invitado con la pantalla compartida y el chat encima de la cámara [Vertical]';

const meldItems = () => ({
  s1: { type: 'scene', name: 'Full cam', index: 0, current: true },
  s2: { type: 'scene', name: 'Pausa', index: 1, current: false },
  s3: { type: 'scene', name: 'Full cam [Vertical]', index: 2, current: false },
  s4: { type: 'scene', name: LONG_VERTICAL, index: 3, current: false },
  t1: { type: 'track', name: 'Micro', muted: false },
  t2: { type: 'track', name: 'Música', muted: true },
  t3: { type: 'track', name: 'Cámara', muted: false, parent: 's1' },
});

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, tries = 400) => {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await wait(25); }
  assert.fail('no llegó a tiempo: ' + label);
};

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const meld = fakeMeld(meldItems());
  await new Promise(r => meld.server.listen(0, '127.0.0.1', r));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'dock-live-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async r => {
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${url}: ${d.error || r.status}`);
    return d;
  });
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
  await until(() => app.meld.status.state === 'conectado', 'Meld conectado');
  t.after(async () => {
    await new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await new Promise(r => meld.server.close(r));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });
  return { bin, app, base, meld, api };
}

async function openDock(t, ctx, { width = 1256, height = 780 } = {}) {
  const chrome = await openChromePage(ctx.bin, 'about:blank');
  t.after(() => { try { chrome.child.kill(); } catch { /* ya cerrado */ } try { chrome.cdp.close(); } catch { /* ya cerrado */ } });
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await chrome.cdp.send('Page.navigate', { url: `${ctx.base}/dock` });
  await waitDom(chrome.cdp, `!!document.querySelector('.dock') && !!document.querySelector('.d-top')`, { timeoutMs: 20000 });
  return chrome;
}

const dom = (chrome, expr) => evaluateChrome(chrome.cdp, expr, { timeoutMs: 12000 });
const resize = (chrome, width, height) => chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

/** SSE de un cliente de antena (para observar la orden que sale al widget). */
function openSse(base, client) {
  const ctrl = new AbortController();
  const events = [];
  const ready = (async () => {
    const res = await fetch(`${base}/api/stream?client=${client}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const raw = /^data: (.*)$/m.exec(chunk)?.[1];
            if (!ev) continue;
            let data = null;
            try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
            events.push({ event: ev, data });
          }
        }
      } catch { /* abort al cerrar */ }
    })();
  })();
  return { events, ready, stop: () => ctrl.abort() };
}

const setRange = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

test('dock ancho: columnas, escenas emparejadas, al aire y nombre largo recortado', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const chrome = await openDock(t, ctx);
  const c = chrome.cdp;

  await waitDom(c, `document.querySelectorAll('.d-col').length === 3 && !!document.querySelector('.d-scene')`, { timeoutMs: 15000 });
  assert.equal(await dom(chrome, `document.querySelectorAll('[role="tablist"]').length`), 1, 'solo las subpestañas de interactivos');
  assert.deepEqual(await dom(chrome, `Array.from(document.querySelectorAll('.d-col-h')).map(h => h.firstChild.textContent.trim())`), ['Control', 'Audio', 'Interactivos']);
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-btn.sc').length`), 0, 'sin atajos');
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-chat, .d-msgs, .d-send').length`), 0, 'sin chat en el dock (S12)');
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-open, a[href="/"]').length`), 0, 'sin botón Panel en el dock (#65)');

  assert.deepEqual(await dom(chrome, `Array.from(document.querySelectorAll('.d-scene-n')).map(n => n.textContent)`),
    ['Full cam', 'Pausa', LONG_VERTICAL]);

  // la escena al aire se marca con «AL AIRE» (texto, no solo color)
  const onAir = await dom(chrome, `(() => {
    const b = Array.from(document.querySelectorAll('.d-scene.on'));
    return { n: b.length, text: b[0]?.textContent.trim(), pressed: b[0]?.getAttribute('aria-pressed') };
  })()`);
  assert.equal(onAir.n, 1);
  assert.match(onAir.text, /Full cam\s*AL AIRE · H/);
  assert.equal(onAir.pressed, 'true');

  // nombre largo: dos líneas con puntos suspensivos y el nombre entero en title
  const long = await dom(chrome, `(() => {
    const n = Array.from(document.querySelectorAll('.d-scene-n')).find(x => x.textContent === ${JSON.stringify(LONG_VERTICAL)});
    const cs = getComputedStyle(n);
    return { clamp: cs.webkitLineClamp, title: n.closest('button').title };
  })()`);
  assert.equal(long.clamp, '2', 'el nombre de la escena se corta a dos líneas');
  assert.equal(long.title, LONG_VERTICAL, 'el nombre entero queda en el title del botón');
  assert.equal(await dom(chrome, `document.querySelector(${JSON.stringify(`button[title="${LONG_VERTICAL}"]`)}).getAttribute('aria-label')`), LONG_VERTICAL);

  // Los indicadores distinguen ambos formatos y el vertical por sí solo.
  const fullAir = `Array.from(document.querySelectorAll('.d-scene')).find(b => b.title === 'Full cam')`;
  ctx.meld.setCurrentScenes(['s1', 's3']);
  await waitDom(c, `${fullAir}?.textContent.includes('AL AIRE · H + V')`, { timeoutMs: 9000 });
  ctx.meld.setCurrentScenes(['s3']);
  await waitDom(c, `${fullAir}?.textContent.includes('AL AIRE · V')`, { timeoutMs: 9000 });
  ctx.meld.setCurrentScenes(['s1']);
  await waitDom(c, `${fullAir}?.textContent.includes('AL AIRE · H') && !${fullAir}?.textContent.includes('H + V')`, { timeoutMs: 9000 });
  await clickWhen(c, fullAir);
  await until(() => ctx.meld.state.calls.filter(x => x[0] === 10).length >= 2, 'showScene H y V');
  assert.deepEqual(ctx.meld.state.calls.filter(x => x[0] === 10).slice(-2).map(x => x[1]), ['s1', 's3']);
  await clickWhen(c, buttonByText('Pausa'));
  await until(() => ctx.meld.state.calls.some(x => x[0] === 10 && x[1] === 's2'), 'showScene s2');
  await waitDom(c, `Array.from(document.querySelectorAll('.d-scene.on .d-scene-n')).some(n => n.textContent === 'Pausa')`, { timeoutMs: 9000 });
  await clickWhen(c, `Array.from(document.querySelectorAll('.d-scene')).find(b => b.title === ${JSON.stringify(LONG_VERTICAL)})`);
  await until(() => ctx.meld.state.calls.some(x => x[0] === 10 && x[1] === 's4'), 'showScene vertical sin pareja');
  await waitDom(c, `Array.from(document.querySelectorAll('.d-scene')).find(b => b.title === ${JSON.stringify(LONG_VERTICAL)})?.textContent.includes('AL AIRE · V')`, { timeoutMs: 9000 });

  // Fallar la segunda petición no revierte la horizontal y muestra el error.
  await dom(chrome, `(() => { const original = window.fetch; window.fetch = (url, opts) => String(url).includes('/api/meld/scene') && JSON.parse(opts.body).scene === 's3' ? Promise.resolve(new Response(JSON.stringify({error:'falló vertical'}), {status:500, headers:{'Content-Type':'application/json'}})) : original(url, opts); return true; })()`);
  const callsBefore = ctx.meld.state.calls.filter(x => x[0] === 10).length;
  await clickWhen(c, fullAir);
  await until(() => ctx.meld.state.calls.filter(x => x[0] === 10).length === callsBefore + 1, 'showScene horizontal antes del error');
  await waitDom(c, `document.querySelector('.toast.err')?.textContent.includes('falló vertical')`, { timeoutMs: 9000 });
  assert.equal(ctx.meld.state.calls.filter(x => x[0] === 10).at(-1)[1], 's1');
  assert.equal(ctx.meld.state.session.items.s1.current, true);
});

test('dock estrecho: pestañas Control/Audio/Interactivos, teclado, memoria y cambio de forma', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const chrome = await openDock(t, ctx, { width: 420, height: 780 });
  const c = chrome.cdp;

  await waitDom(c, `document.querySelectorAll('.d-tabs [role="tab"]').length === 3`, { timeoutMs: 15000 });
  assert.deepEqual(await dom(chrome, `Array.from(document.querySelectorAll('.d-tabs [role="tab"]')).map(x => x.firstChild.textContent.trim())`), ['Control', 'Audio', 'Interactivos']);
  assert.ok(await dom(chrome, `!!document.querySelector('#d-t-audio [aria-label*="desactivada"]')`), 'Audio avisa de pistas silenciadas');
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-col').length`), 0, 'en estrecho no hay columnas');
  assert.equal(await dom(chrome, `document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim()`), 'Control', 'Control va primera y seleccionada');
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-chat, .d-msgs, .d-send').length`), 0, 'sin chat en el dock (S12)');
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-open, a[href="/"]').length`), 0, 'sin botón Panel en el dock (#65)');

  // Flechas mueven foco y panel, también con vuelta circular.
  await dom(chrome, `(() => { const t = document.querySelector('#d-t-control'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; })()`);
  await waitDom(c, `document.activeElement?.id === 'd-t-audio' && document.querySelector('#d-t-audio').getAttribute('aria-selected') === 'true' && !document.querySelector('#d-p-audio').hidden`, { timeoutMs: 9000 });
  await dom(chrome, `(() => { document.querySelector('#d-t-audio').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return true; })()`);
  await waitDom(c, `document.activeElement?.id === 'd-t-control'`, { timeoutMs: 9000 });
  await dom(chrome, `(() => { document.querySelector('#d-t-control').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); return true; })()`);
  await waitDom(c, `document.activeElement?.id === 'd-t-interactivos'`, { timeoutMs: 9000 });
  await clickWhen(c, `document.querySelector('#d-i-sorteo')`);
  await c.send('Page.reload');
  await waitDom(c, `document.querySelector('#d-t-interactivos')?.getAttribute('aria-selected') === 'true' && document.querySelector('#d-i-sorteo')?.getAttribute('aria-selected') === 'true'`, { timeoutMs: 20000 });

  // tablet en retrato: pestañas; apaisado ancho: columnas; vuelta a pestañas.
  await resize(chrome, 768, 1024);
  await waitDom(c, `document.querySelectorAll('.d-tabs [role="tab"]').length === 3 && document.querySelectorAll('.d-col').length === 0`, { timeoutMs: 9000 });
  await resize(chrome, 1256, 780);
  await waitDom(c, `document.querySelectorAll('.d-col').length === 3 && document.querySelectorAll('[role="tablist"]').length === 1`, { timeoutMs: 9000 });
  await resize(chrome, 420, 780);
  await waitDom(c, `document.querySelectorAll('.d-tabs [role="tab"]').length === 3 && document.querySelectorAll('.d-col').length === 0`, { timeoutMs: 9000 });
});

test('dock audio: globales y de la escena al aire, interruptor de mute y fader con el gain real', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const chrome = await openDock(t, ctx);
  const c = chrome.cdp;

  await waitDom(c, `document.querySelectorAll('.d-trk').length === 3`, { timeoutMs: 15000 });
  const audioHead = `Array.from(document.querySelectorAll('.d-col')).find(k => k.querySelector('.d-col-h').firstChild.textContent.trim() === 'Audio').querySelector('.d-col-h span')`;
  assert.equal(await dom(chrome, `${audioHead}.textContent.trim()`), '3 pistas · 1 desactivadas');
  assert.deepEqual(await dom(chrome, `Array.from(Array.from(document.querySelectorAll('.d-col'))[1].querySelectorAll('.d-sub')).map(h => h.firstChild.textContent.trim())`), ['Globales', 'En esta escena · Full cam']);
  assert.deepEqual(await dom(chrome, `Array.from(document.querySelectorAll('.d-trk-n')).map(n => n.textContent)`), ['Micro', 'Música', 'Cámara']);

  // interruptor: encendido = se oye; al pulsarlo se pide el mute a Meld y vuelve el estado
  assert.equal(await dom(chrome, `document.querySelector('[role="switch"][aria-label="Desactivar Micro"]')?.getAttribute('aria-checked')`), 'true');
  await clickWhen(c, `document.querySelector('[role="switch"][aria-label="Desactivar Micro"]')`);
  await until(() => ctx.meld.state.calls.some(x => x[0] === 14 && x[1] === 't1'), 'toggleMute t1');
  await waitDom(c, `document.querySelector('[role="switch"][aria-label="Activar Micro"]')?.getAttribute('aria-checked') === 'false'`, { timeoutMs: 9000 });

  // sin noticias de Meld el fader está desactivado y lo explica
  const muted = await dom(chrome, `(() => { const el = document.querySelector('input[aria-label="Volumen de Música"]'); return { disabled: el.disabled, title: el.title }; })()`);
  assert.equal(muted.disabled, true);
  assert.match(muted.title, /volumen desconocido/i);

  // el gain que informa Meld se pinta en el fader y en el %
  assert.equal(ctx.meld.emitGain('t1', 0.42, false), true);
  await waitDom(c, `document.querySelector('input[aria-label="Volumen de Micro"]')?.value === '42'`, { timeoutMs: 9000 });
  assert.equal(await dom(chrome, `document.querySelectorAll('.d-trk-v')[0].textContent.trim()`), '42%');

  // mover el fader manda el gain a Meld (0–100 ↔ 0–1)
  assert.equal(await dom(chrome, setRange('input[aria-label="Volumen de Micro"]', 75)), true);
  await until(() => ctx.meld.state.calls.some(x => x[0] === 16 && x[1] === 't1' && Math.abs(x[2] - 0.75) < 1e-6), 'setGain 0.75');
});

test('dock control: pausa, saltar, marca de short y agradecido', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const chrome = await openDock(t, ctx);
  const c = chrome.cdp;
  await waitDom(c, `!!(${buttonByText('⏸ Pausar')})`, { timeoutMs: 15000 });

  await clickWhen(c, buttonByText('⏸ Pausar'));
  await until(() => ctx.app.engine.pauseState().paused === true, 'alertas en pausa');
  await waitDom(c, `!!(${buttonByText('▶ Reanudar')})`, { timeoutMs: 9000 });
  await clickWhen(c, buttonByText('▶ Reanudar'));
  await until(() => ctx.app.engine.pauseState().paused === false, 'alertas reanudadas');

  await clickWhen(c, buttonByText('🎬 Marca'));
  await until(() => ctx.app.session.data.notes.some(n => n.kind === 'marker'), 'marca en la sesión');

  await clickWhen(c, buttonByText('⏭ Saltar'));
  await waitDom(c, `document.querySelector('.toast[role="status"]')?.textContent.includes('Saltada')`, { timeoutMs: 9000 });

  // agradecido: sin nada que agradecer el botón está desactivado y dice por qué
  const thanks = await dom(chrome, `(() => { const b = ${buttonByText('✔ Agradecido')}; return { disabled: b.disabled, title: b.title }; })()`);
  assert.equal(thanks.disabled, true);
  assert.match(thanks.title, /por agradecer/i);
});

test('dock interactivos: preguntas (siguiente, ocultar, interruptor persistido), sorteo y votación', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const chrome = await openDock(t, ctx);
  const c = chrome.cdp;
  await waitDom(c, `!!document.querySelector('.d-card[aria-label="Preguntas"]')`, { timeoutMs: 15000 });
  assert.deepEqual(await dom(chrome, `Array.from(document.querySelectorAll('.d-itabs [role="tab"]')).map(x => x.firstChild.textContent.trim())`), ['Preguntas', 'Tier list', 'Sorteo']);
  await dom(chrome, `(() => { const t = document.querySelector('#d-i-preguntas'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; })()`);
  await waitDom(c, `document.activeElement?.id === 'd-i-tier' && !document.querySelector('#d-ip-tier').hidden`, { timeoutMs: 9000 });
  assert.match(await dom(chrome, `document.querySelector('#d-ip-tier').textContent`), /ninguna votación/i);
  await clickWhen(c, `document.querySelector('#d-i-preguntas')`);

  await ctx.api('POST', '/api/questions', { user: 'Espectadora', text: '¿cómo hiciste los overlays?' });
  await waitDom(c, `document.querySelector('.d-card[aria-label="Preguntas"] .d-meta')?.textContent.includes('1 en cola') && document.querySelector('#d-i-preguntas').textContent.includes('1')`, { timeoutMs: 9000 });
  await clickWhen(c, buttonByText('Siguiente'));
  await waitDom(c, `document.querySelector('.d-q')?.textContent.includes('¿cómo hiciste los overlays?')`, { timeoutMs: 9000 });

  // interruptor del comando del chat: se guarda en la configuración de interactivos
  const sw = `document.querySelector('[role="switch"][aria-label="Preguntas del chat"]')`;
  assert.equal(await dom(chrome, `${sw}.getAttribute('aria-checked')`), 'true');
  await clickWhen(c, sw);
  await until(async () => (await ctx.api('GET', '/api/interactive')).config.questions.enabled === false, 'questions.enabled guardado en false');

  await clickWhen(c, buttonByText('Ocultar'));
  await waitDom(c, `!document.querySelector('.d-q')`, { timeoutMs: 9000 });

  // sorteo: abrir (reinicia la lista), participantes y sortear
  await clickWhen(c, `document.querySelector('#d-i-sorteo')`);
  await clickWhen(c, buttonByText('Abrir'));
  await waitDom(c, `document.querySelector('.d-card[aria-label="Sorteo"] .d-meta')?.textContent.includes('abierto')`, { timeoutMs: 9000 });
  await ctx.api('POST', '/api/giveaway/join', { user: 'Ana' });
  await waitDom(c, `document.querySelector('.d-card[aria-label="Sorteo"] .d-meta')?.textContent.includes('1 part') && document.querySelector('#d-i-sorteo').textContent.includes('1')`, { timeoutMs: 9000 });
  await clickWhen(c, buttonByText('Sortear'));
  await until(async () => (await ctx.api('GET', '/api/giveaway')).winners.length === 1, 'ganador del sorteo');

  // votación de tier list abierta: cerrar o cancelar desde el dock
  const list = await ctx.api('POST', '/api/tierlists', { title: 'React', items: ['useState', 'useEffect'] });
  await ctx.api('POST', `/api/tierlists/${list.tierlist.id}/vote`, { item: 'useState' });
  await waitDom(c, `!!document.querySelector('#d-i-tier [aria-label="Votación abierta"]')`, { timeoutMs: 9000 });
  await clickWhen(c, `document.querySelector('#d-i-tier')`);
  await waitDom(c, `!!document.querySelector('.d-card[aria-label="Tier list"]')`, { timeoutMs: 9000 });
  await clickWhen(c, buttonByText('Cancelar'));
  await until(async () => (await ctx.api('GET', '/api/interactive')).vote === null, 'votación cancelada');
  await waitDom(c, `!document.querySelector('.d-card[aria-label="Tier list"]')`, { timeoutMs: 9000 });
});

test('dock cierre: créditos al widget y teleprompter con guion', { timeout: 120000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const chrome = await openDock(t, ctx);
  const c = chrome.cdp;
  await waitDom(c, `!!document.querySelector('.d-card[aria-label="Cierre"]')`, { timeoutMs: 15000 });

  const sse = openSse(ctx.base, 'widget');
  t.after(() => sse.stop());
  await sse.ready;
  await clickWhen(c, buttonByText('Lanzar créditos'));
  await until(() => sse.events.some(e => e.event === 'credits' && e.data?.action === 'play'), 'orden de créditos al widget');

  // sin guion (se borran los de serie) el teleprompter explica por qué no puede avanzar
  for (const script of (await ctx.api('GET', '/api/teleprompter')).scripts) await ctx.api('DELETE', `/api/teleprompter/scripts/${script.id}`);
  await waitDom(c, `document.querySelector('button[aria-label="Bloque siguiente"]').disabled === true`, { timeoutMs: 9000 });
  const off = await dom(chrome, `(() => { const b = document.querySelector('button[aria-label="Bloque siguiente"]'); return { disabled: b.disabled, title: b.title }; })()`);
  assert.equal(off.disabled, true);
  assert.match(off.title, /guion/i);

  await ctx.api('POST', '/api/teleprompter/scripts', { title: 'Overlays', blocks: [{ title: 'Uno', text: 'hola mundo' }, { title: 'Dos', text: 'otra cosa' }] });
  await waitDom(c, `!document.querySelector('button[aria-label="Bloque siguiente"]').disabled`, { timeoutMs: 12000 });
  await clickWhen(c, `document.querySelector('.d-card[aria-label="Teleprompter"] button.d-tp-play')`);
  await until(async () => (await ctx.api('GET', '/api/teleprompter')).playback.playing === true, 'teleprompter en marcha');
  await clickWhen(c, `document.querySelector('button[aria-label="Bloque siguiente"]')`);
  await until(async () => (await ctx.api('GET', '/api/teleprompter')).playback.block === 1, 'siguiente bloque del teleprompter');
});
