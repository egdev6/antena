// #276: herramientas MCP de entrevistas (listar, ver, crear, importar, editar, borrar y elegir),
// contra el MCP real por stdio y la app real por HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(HERE, '..', 'src', 'mcp.mjs');
const VALID = JSON.parse(await readFile(path.join(HERE, 'fixtures', 'interviews', 'valid.json'), 'utf8'));
const NAMES = ['listar_entrevistas', 'ver_entrevista', 'crear_entrevista', 'importar_entrevista', 'editar_entrevista', 'borrar_entrevista', 'elegir_entrevista'];

function mcpClient(url) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ANTENA_URL: url, ANTENA_NO_EMBED: '1' } });
  let buf = ''; let id = 0; const waiters = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return {
    list: async () => (await rpc('tools/list')).result.tools,
    // devuelve el JSON de la herramienta; si falla, lanza con el texto del error
    call: async (name, args = {}) => {
      const res = await rpc('tools/call', { name, arguments: args });
      if (res.result.isError) throw new Error(res.result.content[0].text);
      return JSON.parse(res.result.content[0].text);
    },
    close: () => { child.stdin.end(); child.kill(); },
  };
}

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-mcp-interviews-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const mcp = mcpClient(base);
  t.after(async () => {
    mcp.close();
    await new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  return { mcp, base };
}

test('las siete herramientas existen; las de lectura son solo lectura y las destructivas piden confirmar', async t => {
  const { mcp } = await start(t);
  const tools = Object.fromEntries((await mcp.list()).map(x => [x.name, x]));
  for (const n of NAMES) assert.ok(tools[n], n);
  for (const n of ['listar_entrevistas', 'ver_entrevista']) assert.equal(tools[n].annotations?.readOnlyHint, true, n);
  for (const n of ['borrar_entrevista', 'editar_entrevista']) {
    assert.equal(tools[n].annotations?.destructiveHint, true, n);
    assert.ok(tools[n].inputSchema.required.includes('confirmar'), n);
  }
  for (const n of ['crear_entrevista', 'importar_entrevista', 'elegir_entrevista']) assert.ok(!tools[n].inputSchema.required.includes('confirmar'), n);
  for (const n of NAMES) assert.match(tools[n].description, /entrada no confiable/i, n);
});

test('importar, listar, ver y elegir entrevista por MCP', async t => {
  const { mcp } = await start(t);
  const imported = await mcp.call('importar_entrevista', { paquete: VALID });
  assert.deepEqual(imported.interview, VALID);
  const list = await mcp.call('listar_entrevistas');
  assert.equal(list.interviews.length, 1);
  assert.equal(list.interviews[0].id, 'ana-garcia-ia');
  assert.deepEqual((await mcp.call('ver_entrevista', { id: 'ana-garcia-ia' })).interview, VALID);
  const chosen = await mcp.call('elegir_entrevista', { id: 'ana-garcia-ia', item: 'q1' });
  assert.equal(chosen.activeId, 'ana-garcia-ia');
  assert.equal(chosen.activeItemId, 'q1');
});

test('MCP: un paquete inválido da error claro y no cambia lo guardado; un ítem no aprobado no se activa', async t => {
  const { mcp } = await start(t);
  await mcp.call('importar_entrevista', { paquete: VALID });
  const bad = structuredClone(VALID); bad.id = 'mala'; bad.rounds[1].items[0].media.url = 'http://www.youtube.com/x';
  await assert.rejects(mcp.call('importar_entrevista', { paquete: bad }), /https/);
  assert.equal((await mcp.call('listar_entrevistas')).interviews.length, 1);
  await mcp.call('elegir_entrevista', { id: 'ana-garcia-ia', item: 'q1' });
  await assert.rejects(mcp.call('elegir_entrevista', { id: 'ana-garcia-ia', item: 'q4' }), /aprobad/i);
  assert.equal((await mcp.call('listar_entrevistas')).activeItemId, 'q1');
});

test('MCP: crear y editar (editar y borrar exigen confirmar: true antes de tocar nada)', async t => {
  const { mcp } = await start(t);
  const created = await mcp.call('crear_entrevista', { titulo: 'Nueva', invitado: { name: 'Pepe' } });
  const id = created.interview.id;
  await assert.rejects(mcp.call('editar_entrevista', { id, cambios: { title: 'Cambiada' } }), /confirmar: true/);
  assert.equal((await mcp.call('ver_entrevista', { id })).interview.title, 'Nueva');
  const edited = await mcp.call('editar_entrevista', { id, cambios: { title: 'Cambiada' }, confirmar: true });
  assert.equal(edited.interview.title, 'Cambiada');
  await assert.rejects(mcp.call('borrar_entrevista', { id }), /confirmar: true/);
  assert.equal((await mcp.call('listar_entrevistas')).interviews.length, 1);
  await mcp.call('borrar_entrevista', { id, confirmar: true });
  assert.equal((await mcp.call('listar_entrevistas')).interviews.length, 0);
});
