// Regresiones del rediseño: origen/Host en mutaciones, máscara de secretos, destino de chat
// y obsolescencia/accesibilidad de la vista Prompter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { observeChromeStartup, chromePortFileDiagnostic, chromeTargetDiagnostic } from './helpers/chrome-startup.mjs';
import { evaluateChrome, waitChromeDom, chromeDiagnosticEvent } from './helpers/chrome-dom.mjs';

// El panel React requiere app/dist compilado; el servidor ya no tiene panel clásico de repliegue.

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-rg-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const close = () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
  return { app, port, close };
}

// http.request deja fijar Host/Origin/Sec-Fetch-Site a mano (fetch no).
function raw(port, { connect = '127.0.0.1', method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: connect, port, method, path: p, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const sameOrigin = port => ({ Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' });
const jsonHeaders = port => ({ 'Content-Type': 'application/json', ...sameOrigin(port) });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Cliente MCP real por stdio (mismo patrón que test/integration.test.mjs), sin servidor embebido.
function spawnMcp(base) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp.mjs')], { env: { ...process.env, ANTENA_URL: base, ANTENA_NO_EMBED: '1' } });
  const rl = readline.createInterface({ input: child.stdout });
  const waiters = new Map();
  let nextId = 0;
  rl.on('line', line => { const msg = JSON.parse(line); const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error('sin respuesta del MCP: ' + method)); }, 5000);
    waiters.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const stop = () => new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); });
  return { rpc, stop };
}

test('MCP marcar_agradecido: valor false sin id se rechaza sin tocar la cola de agradecidos', { timeout: 20000 }, async () => {
  const { app, port, close } = await start();
  const mcp = spawnMcp(`http://127.0.0.1:${port}`);
  try {
    await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    const rec = (id, user) => app.session.record({ id, type: 'superchat', at: new Date().toISOString(), vars: { user }, text: user });
    rec('e1', 'Ana'); rec('e2', 'Bea');
    const flags = () => app.session.data.events.map(e => [e.id, !!e.thanked]);
    const pending = () => app.session.pendingThanks();
    const call = args => mcp.rpc('tools/call', { name: 'marcar_agradecido', arguments: args });

    // valor false sin id: la herramienta debe rechazarlo, no marcar la más antigua pendiente
    const before = flags(); const pendingBefore = pending();
    const missing = await call({ valor: false });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /id/i);
    assert.deepEqual(flags(), before, 'ninguna alerta cambió de estado');
    assert.equal(pending(), pendingBefore, 'la cola de pendientes no cambió');

    // id vacío + valor false: mismo rechazo y sin efecto
    const empty = await call({ id: '', valor: false });
    assert.equal(empty.result.isError, true);
    assert.deepEqual(flags(), before);
    assert.equal(pending(), pendingBefore);

    // id explícito: marcar y desmarcar sigue funcionando
    const marked = await call({ id: 'e1' });
    assert.ok(!marked.result.isError, marked.result.content[0].text);
    assert.deepEqual(flags(), [['e1', true], ['e2', false]]);
    const unmarked = await call({ id: 'e1', valor: false });
    assert.ok(!unmarked.result.isError, unmarked.result.content[0].text);
    assert.deepEqual(JSON.parse(unmarked.result.content[0].text), { id: 'e1', done: false });
    assert.deepEqual(flags(), before);
    assert.equal(pending(), pendingBefore);

    // sin id y sin valor (o valor true) sigue siendo el atajo de la más antigua pendiente
    const oldest = await call({});
    assert.deepEqual(JSON.parse(oldest.result.content[0].text), { id: 'e1', user: 'Ana', pending: 1 });
    const next = await call({ valor: true });
    assert.deepEqual(JSON.parse(next.result.content[0].text), { id: 'e2', user: 'Bea', pending: 0 });
  } finally { await mcp.stop(); await close(); }
});

test('mutaciones: Host y origen no confiables se rechazan sin efecto', async () => {
  const { app, port, close } = await start();
  try {
    // Host ajeno sobre loopback (DNS rebinding) se bloquea en cualquier ruta
    assert.equal((await raw(port, { path: '/', headers: { Host: 'evil.example' } })).status, 403);
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { Host: 'evil.example:4500' } })).status, 403);

    // GET /sd es mutante: Origin ajeno y Sec-Fetch-Site cross-site no lo disparan
    const before = app.engine.pauseState().paused;
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    // mismo host/puerto pero otro esquema o puerto no es same-origin estricto
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { Origin: `https://127.0.0.1:${port}` } })).status, 403);
    assert.equal((await raw(port, { path: '/sd/pausa', headers: { Origin: `http://127.0.0.1:${port + 1}` } })).status, 403);
    assert.equal(app.engine.pauseState().paused, before, 'la pausa no cambió');

    // POST de configuración con origen ajeno tampoco cambia nada
    const cfg = await raw(port, { method: 'POST', path: '/api/config', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: { prompter: { fontSize: 19 } } });
    assert.equal(cfg.status, 403);
    assert.notEqual(app.store.config.prompter.fontSize, 19);

    // Stream Deck (sin cabeceras de navegador) y same-origin local siguen funcionando
    assert.equal((await raw(port, { path: '/sd/pausa' })).status, 200);
    assert.equal((await raw(port, { path: '/sd/pausa', headers: sameOrigin(port) })).status, 200);
  } finally { await close(); }
});

test('config: reenviar la máscara no pisa el secreto real de YouTube', async () => {
  const { app, port, close } = await start();
  try {
    await raw(port, { method: 'PUT', path: '/api/config', headers: jsonHeaders(port), body: { youtube: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-SECRETO' } } });
    assert.equal(app.store.config.youtube.clientSecret, 'GOCSPX-SECRETO');

    // El panel reenvía la configuración pública (con la máscara) al tocar otro ajuste
    const pub = app.store.publicConfig();
    assert.match(pub.youtube.clientSecret, /^••••/);
    await raw(port, { method: 'PUT', path: '/api/config', headers: jsonHeaders(port), body: { youtube: pub.youtube, prompter: { fontSize: 23 } } });
    assert.equal(app.store.config.youtube.clientSecret, 'GOCSPX-SECRETO');
    assert.equal(app.store.config.youtube.clientId, 'abc.apps.googleusercontent.com');
    assert.equal(app.store.config.prompter.fontSize, 23);
  } finally { await close(); }
});

test('chat: un destino inválido se rechaza sin enviar a ninguna plataforma', async () => {
  const { app, port, close } = await start();
  try {
    const sent = { twitch: 0, youtube: 0 };
    app.twitch.sendChat = async () => { sent.twitch++; return { is_sent: true }; };
    app.youtube.sendChat = async () => { sent.youtube++; return { sent: true }; };

    // 1) config inválida ya persistida (como un config.json editado a mano; PUT ya no la acepta, #106):
    //    ni se envía ni cae a una plataforma por defecto
    app.store.config.chat.sendTo = 'inexistente';
    await app.store.save('chat');
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola' } })).status, 400);
    assert.deepEqual(sent, { twitch: 0, youtube: 0 });

    // 2) valores no string no se coercionan ([] caía a Twitch y ['twitch'] se aceptaba)
    await raw(port, { method: 'PUT', path: '/api/config', headers: jsonHeaders(port), body: { chat: { sendTo: 'twitch' } } });
    for (const to of [false, 0, [], ['twitch'], {}]) {
      const r = await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola', to } });
      assert.equal(r.status, 400, `to=${JSON.stringify(to)} debe rechazarse`);
    }
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola', to: 'nada' } })).status, 400);
    assert.deepEqual(sent, { twitch: 0, youtube: 0 });

    // 3) contrato documentado: vacío/espacios/ausente usa chat.sendTo
    await raw(port, { method: 'PUT', path: '/api/config', headers: jsonHeaders(port), body: { chat: { sendTo: 'youtube' } } });
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola', to: '' } })).status, 200);
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola', to: '   ' } })).status, 200);
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola' } })).status, 200);
    assert.deepEqual(sent, { twitch: 0, youtube: 3 });

    // 4) config corrupta a un falsy (sembrada en memoria; /config/set ya la rechaza, #106): no se convierte en Twitch en silencio
    app.store.config.chat.sendTo = false;
    assert.equal((await raw(port, { method: 'POST', path: '/api/config/set', headers: jsonHeaders(port), body: { path: 'chat.sendTo', value: false } })).status, 400);
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola' } })).status, 400);
    assert.deepEqual(sent, { twitch: 0, youtube: 3 });

    // 5) un destino explícito válido sigue mandando aunque la config esté corrupta
    assert.equal((await raw(port, { method: 'POST', path: '/api/chat/send', headers: jsonHeaders(port), body: { text: 'hola', to: 'twitch' } })).status, 200);
    assert.deepEqual(sent, { twitch: 1, youtube: 3 });
  } finally { await close(); }
});

test('sd/agradecido marca el más antiguo pendiente y salta los ya agradecidos', async () => {
  const { app, port, close } = await start();
  try {
    const t = s => new Date(Date.now() + s * 1000).toISOString();
    const rec = (id, user, s) => app.session.record({ id, type: 'superchat', at: t(s), vars: { user }, text: user });
    rec('e1', 'Ana', 0);
    rec('e2', 'Bea', 1);
    rec('e3', 'Cruz', 2);
    app.session.setThanked('e1', true);   // ya agradecido: se salta

    // primer atajo: el pendiente más antiguo (e2), no el más reciente (e3)
    const r1 = JSON.parse((await raw(port, { path: '/sd/agradecido' })).body);
    assert.deepEqual(r1, { id: 'e2', user: 'Bea', pending: 1 });

    // el siguiente en orden de registro
    const r2 = JSON.parse((await raw(port, { path: '/sd/agradecido' })).body);
    assert.deepEqual(r2, { id: 'e3', user: 'Cruz', pending: 0 });

    // sin pendientes: no-op
    const r3 = JSON.parse((await raw(port, { path: '/sd/agradecido' })).body);
    assert.deepEqual(r3, { ok: true, pending: 0 });
  } finally { await close(); }
});

test('mutaciones: IPv6 loopback sigue siendo same-origin', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-rg6-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  const close = async () => { app.timers.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(() => r())); };
  const up = await new Promise(r => { app.server.once('error', () => r(false)); app.server.listen(0, '::1', () => r(true)); });
  if (!up) { await close().catch(() => {}); t.skip('sin loopback IPv6 en este entorno'); return; }
  const port = app.server.address().port;
  try {
    const host = `[::1]:${port}`;
    assert.equal((await raw(port, { connect: '::1', path: '/sd/pausa', headers: { Host: host, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    assert.equal((await raw(port, { connect: '::1', path: '/sd/pausa', headers: { Host: 'evil.example' } })).status, 403);
  } finally { await close(); }
});

// Los equivalentes React de las antiguas pruebas de fuente del clásico (descartar respuestas
// obsoletas de la vista Prompter y alcance de las acciones por teclado) viven ahora dentro de
// la regresión de navegador del prompter React, más abajo: SSE que no pisa la edición,
// activación por teclado del botón de editar marca y pestañas que no dejan estado obsoleto.
// --- Regresión de navegador real (CDP sobre el WebSocket nativo de Node) --------------------------
// Hermano de los casos de arriba: solo corre con Chrome local; sin Chrome se marca como omitido.
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findChrome() {
  const paths = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const p of paths) { try { await stat(p); return p; } catch {} }
  return null;
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl); let id = 0; const waiters = new Map(); const events = [];
    const fail = () => {
      const error = new Error('CDP: transporte cerrado');
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear(); reject(error);
    };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      const diagnostic = chromeDiagnosticEvent(m);
      if (diagnostic) { events.push(diagnostic); if (events.length > 6) events.shift(); }
      const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id);
      if (m.error) w.reject(Object.assign(new Error('CDP: comando rechazado'), { code: m.error.code }));
      else w.resolve(m.result);
    };
    ws.onerror = fail; ws.onclose = fail;
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiters.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      diagnostics: () => events.slice(), close: () => ws.close(),
    });
  });
}

// Perfil y proceso propios y aislados; las fuentes externas (p. ej. Google Fonts) quedan resueltas a loopback.
async function openPrompter(bin, url) {
  const probeStarted = performance.now();
  const elapsed = () => performance.now() - probeStarted;
  // Separar HTTP del navegador: registrar estado/MIME, nunca el cuerpo privado.
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  const html = (response.headers.get('content-type') || '').includes('text/html');
  await response.body?.cancel();
  assert.equal(response.status, 200, 'la página HTTP del fixture debe responder 200 antes de Chrome');
  assert.equal(html, true, 'la página HTTP del fixture debe ser HTML');
  const profile = await mkdtemp(path.join(tmpdir(), 'egdev-chrome-'));
  const diagnose = true; // stderr acotado también en Windows, sin relajar sandbox.
  const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-gpu', '--mute-audio', '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: diagnose ? ['ignore', 'ignore', 'pipe'] : 'ignore' });
  const startup = diagnose ? observeChromeStartup(child, profile) : null;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort'); let port; let page;
    let discovery = { attempted: false }, targets = [];
    // Identidad acotada: nunca rutas configuradas, salvo los fallbacks literales conocidos.
    const fallbackPaths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    const leaf = bin.split(/[\\/]/).pop();
    const safeLeaf = ['chrome', 'chrome.exe', 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].includes(leaf);
    const probe = {
      binary: { source: bin === process.env.CHROME_PATH ? 'CHROME_PATH' : 'fallback',
        identity: fallbackPaths.includes(bin) ? bin : safeLeaf ? `[configured]/${leaf}` : '[other]' },
      failurePhase: null,
      portDiscovery: { attempts: 0, firstReadMs: null, lastReadMs: null, endMs: null },
      targetDiscovery: { attempts: 0, startMs: null, lastPollMs: null, endMs: null },
      observationMs: null,
    };
    const chromeSnapshot = () => ({ devTools: { discovery, targets, selected: chromeTargetDiagnostic(page) }, ...(startup?.snapshot() || { unavailable: true }) });
    for (let i = 0; i < 150 && !port; i++) {
      probe.portDiscovery.attempts++;
      probe.portDiscovery.lastReadMs = elapsed();
      probe.portDiscovery.firstReadMs ??= probe.portDiscovery.lastReadMs;
      try {
        const text = await readFile(portFile, 'utf8');
        discovery = chromePortFileDiagnostic(text);
        port = text.split('\n')[0].trim();
      } catch (error) { discovery = chromePortFileDiagnostic(null, error); await sleep(100); }
    }
    probe.portDiscovery.endMs = elapsed();
    probe.targetDiscovery.startMs = elapsed();
    for (let i = 0; i < 100 && !page; i++) {
      probe.targetDiscovery.attempts++;
      probe.targetDiscovery.lastPollMs = elapsed();
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
      targets = list.filter(x => x.type === 'page').slice(0, 3).map(chromeTargetDiagnostic);
      page = list.find(x => x.type === 'page' && x.url === 'about:blank');
      if (!page) await sleep(100);
    }
    probe.targetDiscovery.endMs = elapsed();
    if (!port || !page) {
      probe.failurePhase = !port ? 'port-discovery' : 'target-discovery';
      // Una lectura final sólo observa aparición tardía/vacío/permisos; no reintenta
      // discovery, no usa este puerto para navegar y no amplía sus plazos originales.
      let atFailure;
      try { atFailure = chromePortFileDiagnostic(await readFile(portFile, 'utf8')); }
      catch (error) { atFailure = chromePortFileDiagnostic(null, error); }
      probe.observationMs = elapsed();
      throw new Error('Chrome no expuso la página del prompter' + '; Chrome startup: ' +
        JSON.stringify({ portAvailable: !!port, pageAvailable: !!page, probe, devTools: { discovery, atFailure, targets }, ...(startup?.snapshot() || { unavailable: true }) }));
    }
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    cdp.chromeStartup = chromeSnapshot;
    // Lectura fresca sólo para el diagnóstico de fallo; no reintenta ni navega.
    cdp.chromeTargetsNow = async () => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      .then(r => r.json())).filter(x => x.type === 'page').slice(0, 3).map(chromeTargetDiagnostic);
    await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Page.enable');
    // Una única navegación observada tras habilitar Network: en Windows la de línea de comandos
    // podía abortarse (ERR_ABORTED) al reiniciarse el network service y nadie la reintentaba.
    // Si ésta falla, el test falla con su error; no hay segundo intento.
    let timer;
    const navigation = await Promise.race([cdp.send('Page.navigate', { url }), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Chrome no confirmó la navegación al prompter')), 9000);
    })]).finally(() => clearTimeout(timer));
    if (navigation?.errorText) {
      throw new Error('Chrome no navegó al prompter: ' + (/net::ERR_[A-Z_]+/.exec(navigation.errorText)?.[0] || 'navigation-error') +
        '; Chrome startup: ' + JSON.stringify(chromeSnapshot()));
    }
    // Navegada por CDP la pestaña no recibe foco; el original lo tenía y blur/focus dependen de él.
    await cdp.send('Page.bringToFront');
    return { child, cdp };
  } catch (e) { child.kill(); throw e; }
}

const cdpEval = (c, expression) => evaluateChrome(c, expression);
const reloadPage = c => cdpEval(c, 'location.reload()').catch(() => {});

async function waitDom(c, expression, timeout = 9000) { return waitChromeDom(c, expression, { timeoutMs: timeout }); }

async function marker(base, label = '') {
  const r = await fetch(base + '/api/markers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
  return (await r.json()).marker;
}
const markerLabels = async base => (await (await fetch(base + '/api/timeline?kinds=marker')).json()).items.map(i => i.label);
async function waitLabel(base, label) {
  for (let i = 0; i < 60; i++) { if ((await markerLabels(base)).includes(label)) return; await sleep(100); }
  throw new Error('la etiqueta no persistió: ' + label);
}

test('prompter React: guardar una marca libera la cronología (Enter/blur, SSE y fallo)', { timeout: 90000 }, async t => {
  // La interfaz React requiere app/dist (#115): sin ella no hay página de repliegue.
  try { await stat(new URL('../app/dist/index.html', import.meta.url)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return t.skip('sin app/dist/index.html; compila la interfaz con pnpm app:build para ejecutar la regresión React'); }
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const { port, close } = await start();
  const base = `http://127.0.0.1:${port}`;
  let chrome;
  // Valor en un input controlado de React: setter nativo + evento input.
  const setReactValue = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
  const markersInDom = () => `document.querySelectorAll('.ev.k-marker').length`;
  const waitMarkerCount = async (c, n) => waitDom(c, `${markersInDom()} >= ${n}`, { timeoutMs: 12000 });
  const openEdit = async (c, n) => {
    // Equivalente React de «acciones alcanzables con teclado»: el botón de editar es un
    // <button> real y recibe el foco (alcanzable por tabulación), no un div oculto por CSS.
    assert.equal(await cdpEval(c, `(() => { const b = document.querySelectorAll('.ev.k-marker')[${n - 1}].querySelector('button[aria-label="Poner nombre"]'); b.focus(); const focused = document.activeElement === b; b.click(); return focused; })()`), true, 'el botón de editar marca es enfocable');
    await waitDom(c, '!!document.querySelector(".pr-edit")');
  };
  try {
    chrome = await openPrompter(bin, base + '/prompter');
    const c = chrome.cdp;
    await waitDom(c, '!!document.querySelector(".tabs")');
    for (const mode of ['Enter', 'blur']) {
      await reloadPage(c); await sleep(400);                           // estado y vista limpios en cada caso
      await waitDom(c, '!!document.querySelector(".tabs")');
      await marker(base);
      await waitMarkerCount(c, 1);
      await openEdit(c, 1);
      const typed = 'Nombre ' + mode;
      await cdpEval(c, setReactValue('.pr-edit', typed));
      await marker(base, 'SSE ' + mode);                                // la SSE no debe pisar lo que se escribe
      await waitMarkerCount(c, 2);
      await sleep(350);
      assert.equal(await cdpEval(c, 'document.querySelector(".pr-edit").value'), typed, 'la SSE no pisa el nombre en edición');
      await cdpEval(c, mode === 'Enter' ? 'document.querySelector(".pr-edit").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))' : 'document.querySelector(".pr-edit").blur()');
      await waitDom(c, '!document.querySelector(".pr-edit")');         // el editor desaparece al terminar
      await waitLabel(base, typed);
      await waitDom(c, `document.body.innerText.includes(${JSON.stringify(typed)})`);   // el nombre llega por la SSE real
      const next = await marker(base, 'Posterior ' + mode);
      await waitDom(c, `document.body.innerText.includes(${JSON.stringify(next.label)})`);   // la cronología ya no está congelada
    }
    // Pestañas sin estado obsoleto: cambiar y volver deja la cronología intacta.
    await cdpEval(c, `Array.from(document.querySelectorAll('.tabs .tab')).find(b => b.textContent.includes('Preguntas')).click()`);
    await waitDom(c, '!document.querySelector(".ev.k-marker") && document.querySelector(".tabs .tab[aria-selected=\\"true\\"]").textContent.includes("Preguntas")');
    await cdpEval(c, `Array.from(document.querySelectorAll('.tabs .tab')).find(b => b.textContent.includes('Cronología')).click()`);
    await waitDom(c, `document.querySelectorAll('.ev.k-marker').length >= 4`);

    // Escape cancela sin guardar y sin dejar el editor montado.
    await reloadPage(c); await sleep(400);
    await waitDom(c, '!!document.querySelector(".tabs")');
    await marker(base, 'Intacta');
    await waitMarkerCount(c, 1);
    await cdpEval(c, `document.querySelector('.ev.k-marker').click()`);
    await waitDom(c, '!!document.querySelector(".pr-edit")');
    await cdpEval(c, 'document.querySelector(".pr-edit").value = "Descartado"; document.querySelector(".pr-edit").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await waitDom(c, '!document.querySelector(".pr-edit")');
    assert.ok((await markerLabels(base)).includes('Intacta'), 'Escape no debe guardar');
    // Un PUT que falla (id ya borrado) tampoco puede dejar la vista atascada.
    const mf = await marker(base, 'Fallará');
    await waitMarkerCount(c, 2);
    await openEdit(c, 2);
    await fetch(base + '/api/timeline/' + encodeURIComponent(mf.id), { method: 'DELETE' });
    await cdpEval(c, 'document.querySelector(".pr-edit").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    await waitDom(c, '!document.querySelector(".pr-edit")');
    const mok = await marker(base, 'Tras el fallo');
    await waitDom(c, `document.body.innerText.includes(${JSON.stringify(mok.label)})`);
  } finally { chrome?.cdp?.close(); chrome?.child?.kill(); await close(); }
});

test('panel React: el aviso de configuración/secretos persiste, no finge guardado y se recupera sin recargar', { timeout: 90000 }, async t => {
  // La interfaz React requiere app/dist (#115): sin ella no hay página de repliegue.
  try { await stat(new URL('../app/dist/index.html', import.meta.url)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; return t.skip('sin app/dist/index.html; compila la interfaz con pnpm app:build para ejecutar la regresión React'); }
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const { app, port, close } = await start();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = app.store.dir;
  let chrome; let release;
  // Valor en un input controlado de React: setter nativo + evento input.
  const setChannel = value => `(() => { const el = document.querySelector('input[placeholder="UC…"]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`;
  try {
    chrome = await openPrompter(bin, base + '/');
    const c = chrome.cdp;
    // La PersistBar React solo existe con cambios pendientes: el reposo es «sin banner».
    await waitDom(c, '!!document.querySelector("main .view-head")', { timeoutMs: 12000 });
    // la SSE del panel está conectada antes de tocar nada (además del snapshot inicial por handshake)
    for (let i = 0; i < 100 && ![...app.bus.clients].some(cl => cl.kind === 'panel'); i++) await sleep(50);
    assert.ok([...app.bus.clients].some(cl => cl.kind === 'panel'), 'SSE del panel conectada');

    // fallo determinista de config (ENOTDIR) + cola retenida: pending visible y sin fingir guardado
    const blocker = path.join(dataDir, 'blocker');
    await writeFile(blocker, 'x');
    app.store.cfgFile = path.join(blocker, 'config.json');
    const gate = new Promise(resolve => { release = resolve; });
    app.store.chain = app.store.chain.then(() => gate);
    // v2: Conexiones es un listado; YouTube se edita en su slide y se guarda con «Guardar»
    await cdpEval(c, 'window.confirm = () => true');
    await cdpEval(c, `location.hash = '#/conexiones/youtube'`);
    await waitDom(c, '!!document.querySelector("main input[placeholder=\\"UC…\\"]")', { timeoutMs: 12000 });
    await cdpEval(c, setChannel('UC-odd04'));
    await waitDom(c, '!document.querySelector(".lv-sfoot .eg-btn--secondary").disabled');
    await cdpEval(c, 'document.querySelector(".lv-sfoot .eg-btn--secondary").click()');
    await waitDom(c, 'document.querySelector(".persist").dataset.state === "pending"');
    assert.doesNotMatch(await cdpEval(c, 'document.querySelector(".persist").textContent'), /guardado/i);
    release(); release = null;
    await waitDom(c, 'document.querySelector(".persist").dataset.state === "error"');
    assert.doesNotMatch(await cdpEval(c, 'document.querySelector(".persist").textContent'), /ENOTDIR|blocker|config\.json|guardado/i);

    // navegar no borra el aviso persistente (la PersistBar vive en el armazón de la app)
    await cdpEval(c, `location.hash = '#/general'`);
    await waitDom(c, '!!document.querySelector("main .view-head")');
    assert.equal(await cdpEval(c, 'document.querySelector(".persist").dataset.state'), 'error');

    // fallo de secretos con canario: mensaje acotado, sin valor y sin HTML inyectado
    app.store.secFile = path.join(blocker, 'secrets.json');
    await app.store.setSecret('youtube', { access: 'CANARY-UI-SECRET' }).catch(() => {});
    await waitDom(c, '/secretos/i.test(document.querySelector(".persist").textContent)');
    const secText = await cdpEval(c, 'document.querySelector(".persist").textContent');
    assert.doesNotMatch(secText, /CANARY-UI-SECRET|ENOTDIR|blocker|secrets\.json/);
    assert.equal(await cdpEval(c, 'document.querySelector(".persist").firstElementChild.tagName'), 'SPAN');
    assert.equal(await cdpEval(c, 'document.querySelector(".persist").firstElementChild.childNodes.length'), 1);

    // config recuperada, secretos sucios: sigue en error y no dice 'guardado'
    app.store.cfgFile = path.join(dataDir, 'config.json');
    await cdpEval(c, `location.hash = '#/conexiones/youtube'`);
    await waitDom(c, '!!document.querySelector("main input[placeholder=\\"UC…\\"]")');
    await cdpEval(c, setChannel('UC-odd04-ok'));
    await waitDom(c, '!document.querySelector(".lv-sfoot .eg-btn--secondary").disabled');
    await cdpEval(c, 'document.querySelector(".lv-sfoot .eg-btn--secondary").click()');
    await waitDom(c, 'document.querySelector(".persist").dataset.state === "error" && /secretos/i.test(document.querySelector(".persist").textContent) && !/configuraci/i.test(document.querySelector(".persist").textContent)');
    assert.doesNotMatch(await cdpEval(c, 'document.querySelector(".persist").textContent'), /guardado/i);

    // reparar secretos: la SSE limpia el banner sin recargar (equivalente React del estado «saved»)
    app.store.secFile = path.join(dataDir, 'secrets.json');
    await app.store.setSecret('youtube', { access: 'ok' });
    await waitDom(c, '!document.querySelector(".persist")');
  } finally { release?.(); chrome?.cdp?.close(); chrome?.child?.kill(); await close(); }
});
