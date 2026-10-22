import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-int-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  return { app, base, call, dataDir, close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('una variación con acciones cambia la escena de Meld cuando el overlay muestra la alerta', async () => {
  const meldSrv = fakeMeld();
  await new Promise(r => meldSrv.server.listen(0, '127.0.0.1', r));
  const { app, base, call, close } = await start();
  try {
    await call('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meldSrv.server.address().port}` });
    for (let i = 0; i < 40 && app.meld.status.state !== 'conectado'; i++) await wait(25);
    assert.equal(app.meld.status.state, 'conectado');
    await call('POST', '/api/alerts/raid/variations', { name: 'Grande', conditions: { minAmount: 50 }, overrides: { actions: [{ kind: 'scene', scene: 'Pantalla' }, { kind: 'layer', layer: 'Alertas', seconds: 0 }] } });
    // un overlay abierto: las acciones esperan a que diga que la alerta se ve
    const ctrl = new AbortController();
    const ov = await fetch(base + '/api/stream?client=overlay', { signal: ctrl.signal });
    const r = await call('POST', '/api/simulate', { type: 'raid', vars: { user: 'midudev', amount: 120 } });
    assert.equal(r.alert.variation.name, 'Grande');
    await wait(50);
    assert.equal(meldSrv.state.calls.length, 0);
    await call('POST', '/api/overlay/shown', { id: r.alert.id });
    await wait(80);
    assert.deepEqual(meldSrv.state.calls.map(c => c[0]), [10, 11]);
    // uno pequeño no lleva acciones
    const small = await call('POST', '/api/simulate', { type: 'raid', vars: { user: 'x', amount: 3 } });
    assert.equal(small.alert.variation, null);
    // desde la API también se maneja Meld
    await call('POST', '/api/meld/scene', { scene: 'Cámara' });
    assert.deepEqual(meldSrv.state.calls.at(-1), [10, 's1']);
    ctrl.abort(); void ov;
  } finally { await close(); meldSrv.server.close(); }
});

test('pausa: las alertas esperan en cola y salen al reanudar', async () => {
  const { app, call, close } = await start();
  try {
    await call('POST', '/api/pause');
    await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'a' } });
    await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'b' } });
    assert.equal((await call('GET', '/api/status')).pause.held, 2);
    const r = await call('POST', '/api/resume', {});
    assert.equal(r.released, 2); assert.equal(r.held, 0);
    assert.equal(app.session.data.events.length, 2);
  } finally { await close(); }
});

test('el MCP lista sus herramientas y maneja la app', async () => {
  const { base, close } = await start();
  try {
    const p = spawn(process.execPath, [path.join(ROOT, 'src/mcp.mjs')], { env: { ...process.env, ANTENA_URL: base, ANTENA_NO_EMBED: '1' } });
    let buf = ''; const waiters = new Map(); let id = 0;
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
    const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'antena');
    const tools = (await rpc('tools/list')).result.tools;
    assert.ok(tools.length >= 100);
    for (const t of tools) assert.equal(t.inputSchema.type, 'object', t.name);
    for (const t of tools) assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, 'nombre válido para Claude');
    const res = await rpc('tools/call', { name: 'editar_alerta', arguments: { tipo: 'follow', cambios: { title: 'Hola {user}', fontSize: 80 } } });
    assert.ok(!res.result.isError, res.result.content[0].text);
    const cfg = await rpc('tools/call', { name: 'ver_config', arguments: { ruta: 'alerts.follow.fontSize' } });
    assert.match(cfg.result.content[0].text, /80/);
    const bad = await rpc('tools/call', { name: 'meld_escena', arguments: { escena: 'x' } });
    assert.ok(bad.result.isError);
    const est = await rpc('tools/call', { name: 'estado', arguments: {} });
    p.stdin.end();   // cerrar el hijo antes de asertar: un fallo no debe dejar el MCP colgado
    const state = JSON.parse(est.result.content[0].text);
    assert.deepEqual(state.sessionRecovery, { source: 'fresh', preservedFiles: 0, message: null });   // el MCP hereda el campo
    assert.deepEqual(state.sessionArchive, { pendingCount: 0, sessionId: null, error: null });       // y el estado de archivo
  } finally { await close(); }
});

test('el MCP propaga el fallo de guardado con error seguro y persiste al recuperar', async () => {
  const { app, base, dataDir, close } = await start();
  let p;
  try {
    const blocker = path.join(dataDir, 'blocker');
    await writeFile(blocker, 'x');
    app.store.cfgFile = path.join(blocker, 'config.json');   // el padre es un fichero → ENOTDIR
    await app.store.setSecret('token', 'CANARY-MCP-CONFIG');   // secreto sano en disco: no debe filtrarse por el estado
    p = spawn(process.execPath, [path.join(ROOT, 'src/mcp.mjs')], { env: { ...process.env, ANTENA_URL: base, ANTENA_NO_EMBED: '1' } });
    let buf = ''; const waiters = new Map(); let id = 0;
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
    const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });

    const bad = await rpc('tools/call', { name: 'cambiar_config', arguments: { cambios: { tts: { rate: 1.9 } } } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /No se pudo guardar la configuración/);
    assert.doesNotMatch(bad.result.content[0].text, /ENOTDIR|blocker|config\.json/);

    // el disco publicado no finge el cambio pendiente
    const before = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
    assert.notEqual(before.tts.rate, 1.9);

    // estado por MCP: el subárbol persistence es visible, acotado y sin canario/ruta
    const estado = await rpc('tools/call', { name: 'estado', arguments: {} });
    assert.ok(!estado.result.isError, estado.result.content[0].text);
    const state = JSON.parse(estado.result.content[0].text);
    assert.equal(state.persistence.dirty.config, true);
    assert.equal(state.persistence.pending.config, 0);
    assert.deepEqual(Object.keys(state.persistence).sort(), ['dirty', 'message', 'pending']);
    assert.doesNotMatch(estado.result.content[0].text, /CANARY-MCP-CONFIG|ENOTDIR|blocker|config\.json/);

    // pending en memoria: la cadena retenida hace visible el contador exacto por MCP
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    app.store.chain = app.store.chain.then(() => gate);
    const pendingWrite = app.store.patchConfig({ tts: { rate: 1.8 } });
    const during = JSON.parse((await rpc('tools/call', { name: 'estado', arguments: {} })).result.content[0].text);
    assert.equal(during.persistence.pending.config, 1);
    assert.equal(during.persistence.dirty.config, true);
    release();
    await assert.rejects(pendingWrite);   // el fallo real sigue rechazando tras ceder la cola

    app.store.cfgFile = path.join(dataDir, 'config.json');
    const ok = await rpc('tools/call', { name: 'cambiar_config', arguments: { cambios: { tts: { rate: 1.9 } } } });
    assert.ok(!ok.result.isError, ok.result.content[0].text);
    const after = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(after.tts.rate, 1.9);
    const clean = JSON.parse((await rpc('tools/call', { name: 'estado', arguments: {} })).result.content[0].text);
    assert.deepEqual(clean.persistence.dirty, { config: false, secrets: false });

    // independencia: un fallo de secretos no ensucia config y el canario no sale en el feedback
    app.store.secFile = path.join(blocker, 'secrets.json');
    await assert.rejects(app.store.setSecret('youtube', { access: 'CANARY-MCP-SECRET' }));
    const secEstado = await rpc('tools/call', { name: 'estado', arguments: {} });
    const secState = JSON.parse(secEstado.result.content[0].text);
    assert.equal(secState.persistence.dirty.secrets, true);
    assert.equal(secState.persistence.dirty.config, false);
    assert.equal(secState.persistence.pending.secrets, 0);
    assert.doesNotMatch(secEstado.result.content[0].text, /CANARY-MCP-SECRET|ENOTDIR|blocker|secrets\.json/);
    app.store.secFile = path.join(dataDir, 'secrets.json');
    await app.store.setSecret('youtube', { access: 'ok' });
    const finalState = JSON.parse((await rpc('tools/call', { name: 'estado', arguments: {} })).result.content[0].text);
    assert.deepEqual(finalState.persistence.dirty, { config: false, secrets: false });
  } finally {
    try { await close(); } finally { p?.stdin.end(); }
  }
});
