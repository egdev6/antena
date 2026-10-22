import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_KEY = 'ODD09_FAKE_API_KEY_a1K9';
const CLIENT_SECRET = 'ODD09_FAKE_CLIENT_SECRET_s2Q8';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const bounded = async (work, ms, label) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
};

// Also serialized as the real MCP child's --import preload; no production imports precede it.
function installNetworkGuard() {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
    connect: net.Socket.prototype.connect, tls: tls.connect };
  const state = { port: null, blocked: [], allowed: 0 };
  const deny = kind => {
    state.blocked.push(kind);
    throw Object.assign(new Error(`ODD09 network guard: ${kind}`), { code: 'ODD09_NETWORK' });
  };
  globalThis.fetch = (input, ...args) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== state.port) deny('fetch');
    state.allowed++;
    return original.fetch(input, ...args);
  };
  globalThis.WebSocket = class { constructor() { deny('WebSocket'); } };
  net.Socket.prototype.connect = function (...args) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    const options = typeof first === 'object' ? first : { port: first, host: normalized[1] };
    if (options.path || options.host !== '127.0.0.1' || Number(options.port) !== state.port) deny('net');
    return original.connect.apply(this, args);
  };
  tls.connect = () => deny('tls');
  // These probes must throw before opening a socket or resolving any external hostname.
  for (const probe of [() => fetch('https://odd09.invalid'), () => new WebSocket('wss://odd09.invalid'),
    () => new net.Socket().connect(443, 'odd09.invalid'), () => tls.connect(443, 'odd09.invalid')]) {
    let blocked = false;
    try { probe(); } catch (error) {
      if (error.code !== 'ODD09_NETWORK') throw error;
      blocked = true;
    }
    if (!blocked) throw new Error('ODD09 guard probe escaped');
  }
  return { state, restore() {
    globalThis.fetch = original.fetch;
    globalThis.WebSocket = original.WebSocket;
    net.Socket.prototype.connect = original.connect;
    tls.connect = original.tls;
  } };
}

function launchMcp(preload, env) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(ROOT, 'src/mcp.mjs')],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let id = 0, buffer = '', stderr = '', fault, done = false;
  const fail = error => {
    fault ||= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    done = true;
    if (pending.size) fail(new Error('MCP closed with pending RPCs'));
    resolve({ code, signal });
  }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    try {
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        assert.equal(message.jsonrpc, '2.0');
        assert.ok(pending.has(message.id), 'stdout must contain only expected RPC responses');
        assert.equal(message.error, undefined);
        pending.get(message.id).resolve(message.result);
        pending.delete(message.id);
      }
    } catch (error) { fail(error); }
  });
  return {
    async rpc(method, params) {
      if (fault) throw fault;
      assert.equal(done, false, 'MCP must still be running');
      const requestId = ++id;
      const response = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      try { return await bounded(response, 2500, `MCP ${method}`); }
      finally { pending.delete(requestId); }
    },
    async close() {
      child.stdin.end(); // Actual EOF, on every platform; never substitute a termination signal.
      let outcome;
      try { outcome = await bounded(closed, 4000, 'MCP EOF close'); }
      catch (error) {
        child.kill('SIGKILL');
        await bounded(closed, 1500, 'MCP rescue close');
        throw error; // Rescue must not turn a failed graceful close into a pass.
      }
      assert.deepEqual(outcome, { code: 0, signal: null });
      assert.equal(stderr, '', 'unexpected MCP stderr');
      assert.equal(buffer, '', 'unterminated MCP stdout');
      if (fault) throw fault;
      return { ...outcome, stderrBytes: Buffer.byteLength(stderr) };
    },
    pid: child.pid,
  };
}

async function fixture(t, populated) {
  const root = await mkdtemp(path.join(tmpdir(), 'odd09-config-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media'), home = path.join(root, 'home');
  await Promise.all([dataDir, mediaDir, home].map(dir => mkdir(dir)));
  const configFile = path.join(dataDir, 'config.json');
  const seed = { port: 4617, paused: false, access: { key: 'ODD09_FAKE_ACCESS_ONLY' },
    youtube: { apiKey: populated ? API_KEY : '', clientSecret: populated ? CLIENT_SECRET : '' } };
  const seedText = JSON.stringify(seed);
  await writeFile(configFile, seedText, { flag: 'wx' });
  const guard = installNetworkGuard();
  let app, mcp;
  t.after(async () => {
    try { if (mcp) await mcp.close(); }
    finally {
      try { if (app) await bounded(app.closeHttp(), 2500, 'HTTP close'); }
      finally { guard.restore(); }
    }
  });
  process.env.ANTENA_DATA = dataDir;
  process.env.ANTENA_MEDIA = mediaDir;
  process.env.HOME = home;
  process.env.APPDATA = home;
  const { createApp } = await import('../src/server.mjs');
  app = await createApp({ dataDir, mediaDir, log: () => {} });
  await bounded(new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  }), 2500, 'HTTP listen');
  guard.state.port = app.server.address().port;
  const base = `http://127.0.0.1:${guard.state.port}`;
  const get = async suffix => {
    const response = await fetch(base + suffix, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    assert.equal(response.status, 200);
    return response.json();
  };
  const rawBefore = structuredClone(app.store.config);
  const preload = path.join(root, 'network-guard.mjs');
  const guardReport = path.join(root, 'child-guard.json');
  await writeFile(preload, `import net from 'node:net';\nimport tls from 'node:tls';\n` +
    `import { writeFileSync } from 'node:fs';\nconst guard = (${installNetworkGuard.toString()})();\n` +
    `guard.state.port = Number(new URL(process.env.ANTENA_URL).port);\n` +
    `process.once('exit', () => writeFileSync(process.env.ODD09_GUARD_REPORT, JSON.stringify(guard.state), { flag: 'wx' }));\n`, { flag: 'wx' });
  // Explicit whitelist: no ambient credentials, NODE_OPTIONS, or NODE_TEST_CONTEXT.
  const env = { HOME: home, APPDATA: home, TMPDIR: root, TMP: root, TEMP: root,
    ANTENA_DATA: dataDir, ANTENA_MEDIA: mediaDir, ANTENA_URL: base,
    ANTENA_NO_EMBED: '1', ODD09_GUARD_REPORT: guardReport };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  }
  mcp = launchMcp(preload, env);
  t.diagnostic(JSON.stringify({ root, dataDir, mediaDir, home, base, childPid: mcp.pid, childEnvKeys: Object.keys(env) }));
  const init = await mcp.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'ODD09-characterization', version: '1' } });
  assert.equal(init.serverInfo.name, 'antena');
  const config = async ruta => {
    const result = await mcp.rpc('tools/call', { name: 'ver_config', arguments: ruta === undefined ? {} : { ruta } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    return JSON.parse(result.content[0].text);
  };
  return { app, get, config, async verify() {
    assert.deepEqual(app.store.config, rawBefore, 'public reads must not mutate internal config');
    assert.equal(app.store.getPath('youtube.apiKey'), seed.youtube.apiKey);
    assert.equal(app.store.getPath('youtube..clientSecret'), seed.youtube.clientSecret);
    assert.equal(await readFile(configFile, 'utf8'), seedText, 'fixture disk must retain raw fake values');
    const childClose = await mcp.close();
    mcp = null;
    const childGuard = JSON.parse(await readFile(guardReport, 'utf8'));
    for (const proof of [guard.state, childGuard]) {
      assert.deepEqual(proof.blocked, ['fetch', 'WebSocket', 'net', 'tls'], 'only deliberate probes were blocked');
      assert.ok(proof.allowed > 0, 'real loopback HTTP transport was exercised');
    }
    t.diagnostic(JSON.stringify({ parentGuard: guard.state, childGuard, childClose, fixtureRetained: root }));
  } };
}

for (const populated of [true, false]) {
  test(`public config reads (${populated ? 'fake secrets' : 'empty secrets'})`, { timeout: 15000 }, async t => {
    const f = await fixture(t, populated);
    const oracle = (await f.get('/api/state')).config;
    const maskedKey = populated ? '••••a1K9' : '';
    const maskedSecret = populated ? '••••s2Q8' : '';
    await t.test('state oracle explicitly masks only the current-policy secrets and flags', () => {
      assert.equal(oracle.youtube.apiKey, maskedKey);
      assert.equal(oracle.youtube.clientSecret, maskedSecret);
      assert.equal(oracle.youtube.apiKeySet, populated);
      assert.equal(oracle.youtube.clientSecretSet, populated);
      assert.equal(oracle.port, 4617);
      assert.equal(oracle.paused, false);
      assert.equal(oracle.youtube.clientId, '');
      for (const canary of [API_KEY, CLIENT_SECRET]) assert.ok(!JSON.stringify(oracle).includes(canary));
    });
    const cases = [
      ['root (no path)', undefined, oracle],
      ['root (empty path)', '', oracle],
      ['parent youtube', 'youtube', { path: 'youtube', value: oracle.youtube }],
      ['API key leaf', 'youtube.apiKey', { path: 'youtube.apiKey', value: maskedKey }],
      ['client secret leaf', 'youtube.clientSecret', { path: 'youtube.clientSecret', value: maskedSecret }],
      ['dotted path compatibility', 'youtube..clientSecret', { path: 'youtube..clientSecret', value: maskedSecret }],
      ['API key flag', 'youtube.apiKeySet', { path: 'youtube.apiKeySet', value: populated }],
      ['client secret flag', 'youtube.clientSecretSet', { path: 'youtube.clientSecretSet', value: populated }],
      ['numeric public leaf', 'port', { path: 'port', value: 4617 }],
      ['boolean public leaf', 'paused', { path: 'paused', value: false }],
      ['missing path omits undefined value', 'youtube.ODD09_missing', { path: 'youtube.ODD09_missing' }],
    ];
    for (const [label, ruta, expected] of cases) {
      const http = await f.get('/api/config' + (ruta === undefined ? '' : '?path=' + encodeURIComponent(ruta)));
      const mcp = await f.config(ruta);
      for (const [transport, actual] of [['HTTP', http], ['MCP ver_config', mcp]]) {
        await t.test(`${transport}: ${label}`, () => {
          assert.deepEqual(actual, expected);
          for (const canary of [API_KEY, CLIENT_SECRET]) assert.ok(!JSON.stringify(actual).includes(canary));
        });
      }
      await t.test(`HTTP/MCP parity: ${label}`, () => assert.deepEqual(mcp, http));
    }
    await t.test('raw store/disk preserved; guarded child exits cleanly via EOF', () => f.verify());
  });
}
