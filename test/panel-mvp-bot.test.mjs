// #44 en MCP y panel React (/): destino de mensajes y acciones de chat, avisos de longitud,
// bloqueo de «Enviar ahora», resultado por plataforma y fallos escapados.
// Navegador real por CDP; sin Chrome o sin app/dist se omite con motivo (#115: el clásico se retiró).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { TOOLS } from '../src/mcp.mjs';
import { evaluateChrome, waitChromeDom } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('MCP: la pausa también detiene los mensajes programados y los campos documentan destination', () => {
  const d = name => TOOLS.find(t => t.name === name).description;
  assert.match(d('pausar_alertas'), /mensajes programados/i);
  assert.match(d('pausar_alertas'), /enviar_mensaje_ahora|enviar ahora/i);
  assert.match(d('reanudar_alertas'), /mensajes programados[^.]*intervalo/i);
  for (const name of ['crear_mensaje', 'editar_mensaje', 'editar_alerta', 'crear_comando']) assert.match(d(name), /destination/, name);
  assert.match(d('enviar_mensaje_ahora'), /plataforma/i);
});

async function findChrome() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean)) {
    try { await stat(p); return p; } catch {}
  }
  return null;
}

// Perfil y proceso propios; una única navegación observada, sin reintentos.
async function openPanel(bin, url) {
  const profile = await mkdtemp(path.join(tmpdir(), 'egdev-chrome-'));
  const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-gpu', '--mute-audio', '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  try {
    let port, page;
    for (let i = 0; i < 150 && !port; i++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch { await sleep(100); } }
    for (let i = 0; port && i < 100 && !page; i++) {
      page = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => [])).find(x => x.type === 'page' && x.url === 'about:blank');
      if (!page) await sleep(100);
    }
    if (!page) throw new Error('Chrome no expuso la página');
    const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const waiters = new Map();
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ev => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id); m.error ? w.reject(Object.assign(new Error('CDP: comando rechazado'), { code: m.error.code })) : w.resolve(m.result); };
    const cdp = { send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiters.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const nav = await cdp.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error('Chrome no navegó al panel: ' + nav.errorText);
    await cdp.send('Page.bringToFront');
    return { child, cdp };
  } catch (e) { child.kill(); throw e; }
}

async function until(fn, what) {
  for (let i = 0; i < 80; i++) { if (fn()) return; await sleep(100); }
  throw new Error('no se cumplió: ' + what);
}

// Seg (radiogroup) por su aria-label: el destino de un mensaje es un Seg de 3 opciones (#16).
const reactSeg = label => `document.querySelector('main [role=radiogroup][aria-label=${JSON.stringify(label)}]')`;
const segValue = seg => `(${seg}).querySelector('[role=radio][aria-checked="true"]')?.textContent.trim()`;

test('panel React: destino de timer y acción, aviso 250/200, pausa, plataformas y fallo escapado', { timeout: 90000 }, async t => {
try { await stat(new URL('../app/dist/index.html', import.meta.url)); }
catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return t.skip('sin app/dist/index.html; compila la interfaz con pnpm app:build para ejecutar la regresión React');
}
const bin = await findChrome();
if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-mb-'));
const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const call = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());
let chrome;
try {
    const { timer } = await call('POST', '/api/timers', { name: 'Largo', message: 'x'.repeat(250), onlyWhenLive: false });
    await call('PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: 'hola {user}' }] });
    const sent = [];
    app.twitch.sendChat = async text => { sent.push(text); return { id: 'tw-1' }; };
    chrome = await openPanel(bin, `${base}/#/mensaje/${timer.id}`);
    const c = chrome.cdp;
    const ev = expr => evaluateChrome(c, expr);
    const waitDom = expr => waitChromeDom(c, expr, { timeoutMs: 9000 });
    const timerDestination = reactSeg('Dónde se publica');
    const actionDestination = reactSeg('Dónde');
    const timerState = `document.querySelector('main .timer-state')`;
    const fireResult = `document.querySelector('main [aria-live="polite"]')`;
    const toast = `document.querySelector('.toast[role="status"]')`;
    // v2: el listado también tiene «Enviar ahora» por fila; el del slide (con el resultado) es el último
    const fire = () => ev(`Array.from(document.querySelectorAll('main button')).filter(b => b.textContent.trim() === 'Enviar ahora').at(-1).click()`);
    // v2: guardado manual, los cambios se guardan con el botón «Guardar» del pie
    const save = () => ev(`document.querySelector('.lv-sfoot .eg-btn--secondary').click()`);
    const pick = (seg, text) => ev(`Array.from((${seg}).querySelectorAll('[role=radio]')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
    const stored = () => app.store.config.timers.find(x => x.id === timer.id);

    // destino del mensaje: sin campo se ve Twitch; elegir «Ambos» lo guarda y avisa del límite de YouTube
    await waitDom(`!!(${timerDestination})`);
    assert.equal(await ev(segValue(timerDestination)), 'Twitch');
    assert.equal(stored().destination, undefined, 'abrir el editor no cambia el destino implícitamente');
    await pick(timerDestination, 'Ambos');
    await sleep(100);
    assert.equal(stored().destination, undefined, 'sin pulsar Guardar no se guarda');
    await save();
    await until(() => stored().destination === 'both', 'destination=both guardado');
    await waitDom(`/YouTube/.test(${timerState}?.textContent || '') && /250\\/200/.test(${timerState}?.textContent || '')`);

    // «Enviar ahora» en pausa: se ve el motivo del 409, no un error genérico, y no se envía nada
    await call('POST', '/api/pause');
    await fire();
    await waitDom(`/pausa activa/.test(${fireResult}?.textContent || '')`);
    assert.equal(sent.length, 0);
    await call('POST', '/api/resume', {});

    // resultado por plataforma: Twitch sale, YouTube falla por longitud y se ve por qué
    await fire();
    await waitDom(`/Twitch: enviado/.test(${fireResult}?.textContent || '') && /YouTube: [^·]*no cabe/.test(${fireResult}?.textContent || '')`);
    await waitDom(`/Twitch: enviado/.test(${timerState}?.textContent || '') && /YouTube: [^·]*no cabe/.test(${timerState}?.textContent || '')`);
    assert.equal(sent.length, 1);

    // destino de una acción de chat de alerta: sin campo se ve Twitch; elegir YouTube lo guarda
    await ev('location.hash = "#/alerta/follow"');
    await waitDom(`!!(${actionDestination})`);
    assert.equal(await ev(segValue(actionDestination)), 'Twitch');
    await pick(actionDestination, 'YouTube');
    await save();
    await until(() => app.store.config.alerts.follow.actions[0]?.destination === 'youtube', 'destination=youtube en la acción');
    assert.equal(app.store.config.alerts.follow.actions[0].text, 'hola {user}');

    // fallo parcial de una acción de chat: aviso con el origen y el detalle por plataforma, escapado
    app.youtube.sendChat = async () => { throw new Error('<b>sin directo</b>'); };
    await call('PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: 'hola {user}', destination: 'both' }] });
    await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'ana' } });
    await waitDom(`(() => { const t = ${toast}; return !!t && /Nuevo seguidor/.test(t.textContent) && /Twitch: enviado/.test(t.textContent) && /YouTube: no enviado \\(<b>sin directo<\\/b>\\)/.test(t.textContent) && !t.querySelector("b"); })()`);
    assert.deepEqual(sent.slice(-1), ['hola ana'], 'Twitch recibe una sola vez');
} finally {
    chrome?.cdp?.close(); chrome?.child?.kill();
    await new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
}
});
