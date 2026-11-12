// Public MCP tools/list contract for channel-total goals (#132).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function tools() {
  const result = spawnSync(process.execPath, [path.join(root, 'src/mcp.mjs')], {
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8',
    env: { ...process.env, ANTENA_URL: 'http://127.0.0.1:1', ANTENA_NO_EMBED: '1' }, timeout: 10000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const message = JSON.parse(result.stdout);
  assert.equal(message.id, 1);
  return Object.fromEntries(message.result.tools.map(tool => [tool.name, tool]));
}

test('S5 MCP: los esquemas de métricas incluyen suscriptores sin perder las métricas existentes', () => {
  const t = tools();
  for (const name of ['crear_objetivo', 'crear_barra', 'editar_barra']) {
    assert.deepEqual(t[name].inputSchema.properties.metrica.enum,
      ['follows', 'subs', 'bits', 'raids', 'subscribers', 'superchats', 'members', 'events']);
  }
  assert.match(t.crear_barra.description, /youtube \(subscribers, superchats, members, events\)/);
});

test('S8 MCP: sumar y fijar explican la corrección persistente y el corte no reinicia los totales de canal', () => {
  const t = tools();
  for (const name of ['sumar_objetivo', 'fijar_objetivo', 'sumar_barra', 'fijar_barra']) {
    assert.match(t[name].description, /corrección persistente/i, name);
  }
  assert.match(t.nuevo_directo.description, /totales de canal.*no.*(reinician|cero)/i);
});
