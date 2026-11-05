// S9/T3: las seis herramientas de overlays propios del MCP (listar, ver, crear, editar, borrar y
// probar). El listado no lleva el código; crear/editar enseñan a escribir un overlay; probar
// manda un evento de ejemplo a UNA capa por el canal SSE de los widgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'src', 'mcp.mjs');
const NAMES = ['listar_overlays', 'ver_overlay', 'crear_overlay', 'editar_overlay', 'borrar_overlay', 'probar_overlay'];

/** Cliente JSON-RPC por stdio del MCP real (como lo usaría Claude). */
function mcp(url) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ANTENA_URL: url, ANTENA_NO_EMBED: '1' } });
  let buf = ''; let id = 0; const waiters = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return {
    init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }),
    list: async () => (await rpc('tools/list')).result.tools,
    call: async (name, args = {}) => {
      const res = await rpc('tools/call', { name, arguments: args });
      if (res.result.isError) throw new Error(res.result.content[0].text);
      return JSON.parse(res.result.content[0].text);
    },
    callRaw: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    close: () => { child.stdin.end(); child.kill(); },
  };
}

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-mcp-overlays-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
  });
  return { app, base, call, close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

async function sse(url) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  async function next(name, pred = () => true, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = events.findIndex(e => e.event === name && pred(e.data));
      if (i >= 0) return events.splice(i, 1)[0].data;
      if (Date.now() > deadline) throw new Error(`no "${name}" event within ${timeoutMs} ms`);
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 100))]);
      if (done) throw new Error('stream closed');
      if (!value) continue;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  }
  return { next, close: () => ctrl.abort() };
}

test('MCP: las seis herramientas de overlays propios están y enseñan a escribir uno', { timeout: 20000 }, async () => {
  const c = mcp('http://127.0.0.1:1');
  try {
    await c.init();
    const tools = await c.list();
    const byName = Object.fromEntries(tools.map(t => [t.name, t]));
    for (const name of NAMES) assert.ok(byName[name], `falta la herramienta ${name}`);
    assert.deepEqual(byName.crear_overlay.inputSchema.required, ['nombre']);
    assert.deepEqual(byName.editar_overlay.inputSchema.required, ['id']);
    assert.deepEqual(byName.probar_overlay.inputSchema.required, ['id', 'evento']);
    assert.deepEqual(byName.probar_overlay.inputSchema.properties.evento.enum, ['alert', 'chat', 'viewers', 'widgets']);
    assert.deepEqual(byName.listar_overlays.inputSchema.properties, {});
    // La descripción de crear/editar enseña lo justo para escribir uno en unas líneas.
    for (const name of ['crear_overlay', 'editar_overlay']) {
      const d = byName[name].description;
      assert.match(d, /iframe/i, name);
      assert.match(d, /sandbox|origen opaco/i, name);
      assert.match(d, /https/i, name);
      assert.match(d, /transparent/i, name);
      assert.match(d, /\/theme\.css/, name);
      assert.match(d, /antena\.on\('alert'/, name);
      assert.match(d, /\/custom\/<id>/, name);
      assert.match(d, /recarg/i, name);
    }
    // Todo lo que hace el panel se puede hacer por MCP: el listado sigue siendo válido.
    assert.ok(tools.length >= 100);
    for (const t of tools) assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
  } finally { c.close(); }
});

test('MCP: crear, ver, editar, listar, probar y borrar un overlay propio', { timeout: 30000 }, async () => {
  const { base, call, close } = await start();
  const widget = await sse(base + '/api/stream?client=widget');
  const c = mcp(base);
  try {
    await c.init();
    // Las URLs usan el puerto configurado, igual que ver_widgets.
    await call('POST', '/api/config/set', { path: 'port', value: 4611 });
    const created = await c.call('crear_overlay', {
      nombre: 'Marco de cámara', html: '<div id="a">hola</div>', css: '#a{color:red}', js: "antena.on('alert', a => document.title = a.text);",
      ancho: 1280, alto: 720, transparente: false,
    });
    assert.match(created.id, /^[a-z0-9-]+$/);
    assert.equal(created.url, `http://127.0.0.1:4611/custom/${created.id}`);
    assert.equal(created.name, 'Marco de cámara');
    assert.equal(created.width, 1280);
    assert.equal(created.height, 720);
    assert.equal(created.transparent, false);
    // Lo que se ve por la API es lo mismo que ha guardado el MCP (misma validación y mismo almacén).
    const stored = (await call('GET', '/api/custom-overlays/' + created.id)).overlay;
    assert.equal(stored.js, created.js);
    assert.equal(stored.transparent, false);

    const seen = await c.call('ver_overlay', { id: created.id });
    assert.equal(seen.html, '<div id="a">hola</div>');
    assert.equal(seen.css, '#a{color:red}');
    assert.equal(seen.url, `http://127.0.0.1:4611/custom/${created.id}`);

    // Edición parcial: solo el css; el resto se queda como está y la versión sube (las capas recargan).
    const edited = await c.call('editar_overlay', { id: created.id, css: '#a{color:blue}' });
    assert.equal(edited.css, '#a{color:blue}');
    assert.equal(edited.html, '<div id="a">hola</div>');
    assert.ok(edited.updatedAt > created.updatedAt);

    // El listado es ligero: id, nombre, tamaño y URL; nunca el código.
    const list = await c.call('listar_overlays');
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['alto', 'ancho', 'id', 'nombre', 'url']);
    assert.equal(list[0].url, `http://127.0.0.1:4611/custom/${created.id}`);
    assert.equal(list[0].ancho, 1280);
    assert.equal(list[0].alto, 720);

    // Probar: evento de ejemplo a ESTA capa por el canal de los widgets, con los datos pedidos.
    const datos = { id: 'm1', platform: 'twitch', user: 'ana', text: '¡hola!', at: new Date().toISOString() };
    const probed = await c.call('probar_overlay', { id: created.id, evento: 'chat', datos });
    assert.equal(probed.ok, true);
    assert.deepEqual(await widget.next('customOverlayTest', d => d.id === created.id), { id: created.id, event: 'chat', data: datos });
    // Sin datos, el servidor manda un ejemplo realista.
    await c.call('probar_overlay', { id: created.id, evento: 'viewers' });
    const sample = await widget.next('customOverlayTest', d => d.id === created.id);
    assert.equal(sample.event, 'viewers');
    assert.deepEqual(Object.keys(sample.data.twitch).sort(), ['current', 'live', 'peak', 'record']);
    // Un evento que no existe es un error del MCP, no una prueba.
    const bad = await c.callRaw('probar_overlay', { id: created.id, evento: 'theme' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /evento/i);
    // Un id desconocido también es un error con su mensaje.
    const missing = await c.callRaw('ver_overlay', { id: 'nope' });
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /No existe ese overlay/);

    await c.call('borrar_overlay', { id: created.id });
    assert.deepEqual(await c.call('listar_overlays'), []);
    assert.deepEqual((await call('GET', '/api/custom-overlays')).overlays, []);
  } finally { c.close(); widget.close(); await close(); }
});
