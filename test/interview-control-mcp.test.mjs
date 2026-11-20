// Interview live control (#278) over MCP: the six tools drive the real app and the widget follows;
// hints and the untrusted-content warning are right; without an active interview they report the
// warning as a tool error and change nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.mjs');
const PACK = {
  version: 1, id: 'directo', title: 'En directo', guest: { name: 'Ana' },
  rounds: [{ id: 'r', title: 'Ronda', items: [
    { id: 'a', question: 'Primera', media: { type: 'image', file: 'foto.jpg' }, notes: 'NOTA-PRIVADA-A', aprobado: true },
    { id: 'b', question: 'Sin aprobar', aprobado: false },
    { id: 'c', question: 'Tercera', aprobado: true },
  ] }],
};
const TOOLS = ['entrevista_estado', 'entrevista_siguiente', 'entrevista_anterior', 'entrevista_ir', 'entrevista_media', 'entrevista_ocultar'];

function mcpClient(url) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ANTENA_URL: url, ANTENA_NO_EMBED: '1' } });
  let buf = ''; let id = 0; const waiters = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return {
    list: async () => (await rpc('tools/list')).result.tools,
    call: async (name, args = {}) => {
      const res = await rpc('tools/call', { name, arguments: args });
      if (res.result.isError) throw new Error(res.result.content[0].text);
      return JSON.parse(res.result.content[0].text);
    },
    close: () => { child.stdin.end(); child.kill(); },
  };
}

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-mcp-interview-control-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const mcp = mcpClient(base);
  t.after(async () => {
    mcp.close();
    await new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const widget = () => app.interviews.activeItem();
  return { app, mcp, widget };
}

test('tools: names, read-only hint only on the state tool, no confirmation, untrusted-content warning', async t => {
  const { mcp } = await start(t);
  const tools = Object.fromEntries((await mcp.list()).map(x => [x.name, x]));
  for (const n of TOOLS) {
    assert.ok(tools[n], n);
    assert.match(tools[n].description, /entrada no confiable/i, n);
    assert.ok(!tools[n].inputSchema.required?.includes('confirmar'), n);
    assert.notEqual(tools[n].annotations?.destructiveHint, true, n);
  }
  assert.equal(tools.entrevista_estado.annotations?.readOnlyHint, true);
  for (const n of TOOLS.slice(1)) assert.notEqual(tools[n].annotations?.readOnlyHint, true, n);
  assert.deepEqual(tools.entrevista_ir.inputSchema.required, ['item']);
  assert.deepEqual(tools.entrevista_media.inputSchema.required, ['visible']);
  assert.deepEqual(tools.prompter_pestana.inputSchema.properties.pestana.enum, ['cronologia', 'preguntas', 'entrevista']);
});

test('tools drive the interview and the widget payload follows, without notes', async t => {
  const { app, mcp, widget } = await start(t);
  await mcp.call('importar_entrevista', { paquete: PACK });
  await mcp.call('elegir_entrevista', { id: 'directo' });
  let s = await mcp.call('entrevista_siguiente');
  assert.equal(s.current.id, 'a'); assert.equal(widget().id, 'a'); assert.ok(widget().media);
  assert.equal(s.current.notes, 'NOTA-PRIVADA-A'); assert.deepEqual(s.progress, { index: 1, total: 2 });
  assert.doesNotMatch(JSON.stringify(widget()), /NOTA-PRIVADA/);
  await mcp.call('entrevista_media', { visible: false });
  assert.deepEqual(widget(), { id: 'a', question: 'Primera' });
  await mcp.call('entrevista_media', { visible: true });
  assert.ok(widget().media);
  assert.equal((await mcp.call('entrevista_siguiente')).current.id, 'c');
  assert.equal((await mcp.call('entrevista_anterior')).current.id, 'a');
  assert.equal((await mcp.call('entrevista_ir', { item: 'c' })).current.id, 'c');
  await assert.rejects(mcp.call('entrevista_ir', { item: 'b' }), /no está aprobado/);
  assert.equal(widget().id, 'c');
  assert.equal((await mcp.call('entrevista_estado')).current.id, 'c');
  await mcp.call('entrevista_ocultar');
  assert.equal(widget(), null);
  assert.deepEqual(app.session.timeline().filter(i => i.kind === 'question').map(i => i.itemId), ['a', 'c', 'a', 'c']);
});

test('without an active interview the tools report the warning and change nothing', async t => {
  const { app, mcp } = await start(t);
  await mcp.call('importar_entrevista', { paquete: PACK });
  const before = JSON.stringify(app.store.config.interviews);
  for (const [n, a] of [['entrevista_siguiente'], ['entrevista_anterior'], ['entrevista_ir', { item: 'a' }], ['entrevista_media', { visible: false }], ['entrevista_ocultar']]) {
    await assert.rejects(mcp.call(n, a), /No hay entrevista activa/, n);
  }
  assert.equal(JSON.stringify(app.store.config.interviews), before);
  assert.equal((await mcp.call('entrevista_estado')).active, false);
});
