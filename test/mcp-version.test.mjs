// El MCP anuncia la versión del paquete (package.json) en serverInfo, no una fija.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP initialize anuncia la versión de package.json', { timeout: 15000 }, async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp.mjs')], {
    env: { ...process.env, ANTENA_URL: 'http://127.0.0.1:1', ANTENA_NO_EMBED: '1' },
  });
  try {
    const rl = readline.createInterface({ input: child.stdout });
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sin respuesta de initialize')), 8000);
      rl.on('line', line => {
        const msg = JSON.parse(line);
        if (msg.id === 1) { clearTimeout(timer); resolve(msg); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    });
    assert.equal(res.result.serverInfo.version, pkg.version);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
