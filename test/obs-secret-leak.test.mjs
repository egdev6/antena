import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createApp } from '../src/server.mjs';

const SECRET = 'OBS_FAKE_SECRET_6uvX92';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const bounded = (p, label) => Promise.race([p, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label}: timeout`)), 5000); timer.unref();
})]);

test('OBS password is secret across HTTP, SSE, MCP, errors, logs, restart and clear', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'ant-obs-secret-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await mkdir(dataDir);
  let app, base, reader, abort, child, closed, mcpOutput = '', mcpErrors = '', id = 0;
  const pending = new Map(), logs = [], originalWarn = console.warn, originalError = console.error;
  console.warn = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  const rpc = async (method, params) => {
    const n = ++id, result = new Promise(resolve => pending.set(n, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
    return bounded(result, `MCP ${method}`);
  };
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  };
  const tool = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const open = async () => {
    app = await createApp({ dataDir, mediaDir, push: {}, log: (...a) => logs.push(a.join(' ')) });
    await listen(app.server); base = `http://127.0.0.1:${app.server.address().port}`;
    abort = new AbortController();
    const response = await fetch(base + '/api/stream?client=panel', { signal: abort.signal });
    assert.equal(response.status, 200); reader = response.body.getReader();
    child = spawn(process.execPath, ['src/mcp.mjs'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: root, PATH: process.env.PATH || '', TMPDIR: tmpdir(), ANTENA_DATA: dataDir, ANTENA_URL: base, ANTENA_NO_EMBED: '1' } });
    closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stderr.setEncoding('utf8').on('data', s => { mcpErrors += s; });
    createInterface({ input: child.stdout }).on('line', line => {
      mcpOutput += line + '\n'; const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id);
    });
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'obs-test', version: '1' } })).result.serverInfo.name, 'antena');
  };
  const close = async () => {
    if (child) { child.stdin.end(); assert.deepEqual(await bounded(closed, 'MCP close'), { code: 0, signal: null }); child = null; }
    abort?.abort(); reader = null;
    if (app) { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose(); await app.closeHttp(); app = null; }
  };
  t.after(async () => { try { await close(); } finally { console.warn = originalWarn; console.error = originalError; await rm(root, { recursive: true, force: true }); } });
  const file = name => path.join(dataDir, name);
  let stream = '';
  const checkpoint = async label => {
    const marker = `obs-barrier-${label}`;
    assert.equal((await call('PUT', '/api/config', { prompter: { css: marker } })).status, 200);
    while (!stream.includes(marker)) {
      const chunk = await bounded(reader.read(), 'SSE barrier'); assert.equal(chunk.done, false);
      stream += new TextDecoder().decode(chunk.value);
    }
    assert.match(stream, /event: (status|persistence|config)/);
    const samples = [await call('GET', '/api/config'), await call('GET', '/api/state'),
      await call('GET', '/api/config?path=obs'), await call('GET', '/api/config?path=obs.password'),
      await tool('ver_config'), await tool('ver_config', { ruta: 'obs.password' }), await tool('estado')];
    for (const sample of samples) assert.ok(!JSON.stringify(sample).includes(SECRET), `${label}: response leaked`);
    for (const [where, text] of [['SSE', stream], ['MCP stdout', mcpOutput], ['MCP stderr', mcpErrors], ['logs', logs.join('\n')]])
      assert.ok(!text.includes(SECRET), `${label}: ${where} leaked`);
  };
  await open();
  assert.equal((await call('GET', '/api/config')).body.obs.passwordSet, false);
  const set = await call('PUT', '/api/config', { obs: { password: SECRET } });
  assert.equal(set.status, 200); assert.equal(set.body.config.obs.passwordSet, true);
  assert.ok(!JSON.stringify(set).includes(SECRET));
  assert.equal(JSON.parse(await readFile(file('secrets.json'), 'utf8')).obs.password, SECRET);
  assert.ok(!(await readFile(file('config.json'), 'utf8')).includes(SECRET));
  for (const write of [
    () => tool('fijar_valor', { ruta: 'obs..password', valor: SECRET }),
    () => tool('cambiar_config', { cambios: { obs: { password: SECRET } } }),
    () => call('POST', '/api/config/set', { path: 'obs', value: { url: 'wss://localhost:4455', password: SECRET } }),
  ]) {
    const result = await write();
    assert.equal(result.status ?? 200, 200); assert.notEqual(result.result?.isError, true);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.ok(!(await readFile(file('config.json'), 'utf8')).includes(SECRET));
    assert.equal(JSON.parse(await readFile(file('secrets.json'), 'utf8')).obs.password, SECRET);
  }
  await checkpoint('set');
  const beforeConfig = await readFile(file('config.json'), 'utf8'), beforeSecret = await readFile(file('secrets.json'), 'utf8');
  const beforeCounters = (await call('GET', '/api/status')).body.persistence;
  const invalid = await call('PUT', '/api/config', { obs: { url: `http://${SECRET}`, password: 'other-secret' } });
  assert.deepEqual(invalid, { status: 400, body: { error: 'obs.url: se esperaba una URL ws:// o wss:// válida (sin usuario ni contraseña)' } });
  assert.equal(await readFile(file('config.json'), 'utf8'), beforeConfig);
  assert.equal(await readFile(file('secrets.json'), 'utf8'), beforeSecret);
  assert.deepEqual((await call('GET', '/api/status')).body.persistence, beforeCounters);
  assert.deepEqual(await call('POST', '/api/config/set', { path: 'obs.password.extra', value: SECRET }),
    { status: 400, body: { error: 'obs.password.extra: obs.password no admite subcampos' } });
  await checkpoint('invalid');
  await close(); stream = ''; await open();
  assert.equal((await call('GET', '/api/config')).body.obs.passwordSet, true);
  await checkpoint('restart');
  const cleared = await tool('borrar_valor', { ruta: 'obs.password' });
  assert.ok(!JSON.stringify(cleared).includes(SECRET));
  assert.equal((await call('GET', '/api/config')).body.obs.passwordSet, false);
  assert.ok(!(await readFile(file('secrets.json'), 'utf8')).includes(SECRET));
  assert.equal((await call('PUT', '/api/config', { obs: { password: SECRET } })).status, 200);
  assert.equal((await call('PUT', '/api/config', { obs: { password: '' } })).status, 200);
  assert.equal((await call('GET', '/api/config')).body.obs.passwordSet, false);
  assert.ok(!(await readFile(file('secrets.json'), 'utf8')).includes(SECRET));
  await checkpoint('clear');
});
