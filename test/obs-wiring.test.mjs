import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';

const secret = 'OBS_WIRING_TEST_PASSWORD';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function ready(base, wanted) {
  const deadline = Date.now() + 5000;
  do {
    const r = await fetch(base + '/api/status');
    assert.equal(r.status, 200);
    const status = (await r.json()).meld;
    if (status.state === 'conectado' && status.version === wanted && status.streamingKnown && (wanted === 2 || status.recordingKnown)) return status;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(`program ${wanted} did not connect`);
}
function countUpgrades(server) {
  let upgrades = 0;
  server.on('upgrade', () => upgrades++);
  return () => upgrades;
}
async function http(base, method, endpoint, body) {
  const r = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json() };
}

test('live switching preserves the facade, disconnects the old program and masks OBS credentials', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-wiring-'));
  const meld = fakeMeld(), obs = fakeObs({ password: secret }), logs = [];
  const meldConnections = countUpgrades(meld.server), obsConnections = countUpgrades(obs.server);
  await listen(meld.server); await listen(obs.server);
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: (...a) => logs.push(a.join(' ')) });
  await listen(app.server);
  let abort;
  t.after(async () => {
    abort?.abort(); await app.drainAutoSession(); await app.session.flush();
    await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
    await obs.close(); await new Promise(resolve => meld.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const meldUrl = `ws://127.0.0.1:${meld.server.address().port}`, obsUrl = `ws://127.0.0.1:${obs.server.address().port}`;
  const facade = app.program;
  assert.equal((await http(base, 'POST', '/api/meld/connect', { url: meldUrl })).status, 200);
  await ready(base, 2);
  abort = new AbortController();
  const response = await fetch(base + '/api/stream?client=panel', { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const changed = await http(base, 'PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: obsUrl, password: secret } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.config.obs.passwordSet, true);
  assert.ok(!JSON.stringify(changed).includes(secret));
  const status = await ready(base, '30.2.3');
  assert.strictEqual(app.program, facade);
  assert.equal(meldConnections(), 1); assert.equal(obsConnections(), 1);
  assert.equal(status.error, null);
  let sse = '';
  while (!sse.includes('30.2.3')) {
    const part = await bounded(reader.read(), 'SSE');
    assert.equal(part.done, false); sse += new TextDecoder().decode(part.value);
  }
  for (const output of [status, await http(base, 'GET', '/api/state'), await http(base, 'GET', '/api/config'), sse, logs])
    assert.ok(!JSON.stringify(output).includes(secret));
  const rejected = await http(base, 'POST', '/api/meld/scene', { scene: 'Cámara' });
  assert.equal(rejected.status, 500);
  assert.match(rejected.body.error, /todavía no disponible con OBS/i);
  assert.deepEqual(meld.state.calls, []);
  const obsRequests = obs.requests.length;
  assert.equal((await http(base, 'POST', '/api/meld/connect', {})).status, 200);
  await ready(base, '30.2.3');
  assert.equal(obsConnections(), 2);
  assert.ok(obs.requests.length > obsRequests);
  const config = (await http(base, 'GET', '/api/config')).body;
  assert.equal(config.meld.url, meldUrl);
  assert.equal(config.obs.url, obsUrl);
  assert.equal((await http(base, 'PUT', '/api/config', { program: { kind: 'meld' } })).status, 200);
  await ready(base, 2);
  assert.strictEqual(app.program, facade);
  assert.equal(meldConnections(), 2); assert.equal(obsConnections(), 2);
  assert.deepEqual(await http(base, 'POST', '/api/meld/scene', { scene: 'Pantalla' }), { status: 200, body: { scene: 'Pantalla' } });
});

test('startup with OBS selected connects OBS, never starts enabled Meld, and closes cleanly', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-startup-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  const meld = fakeMeld(), obs = fakeObs({ password: secret });
  const meldConnections = countUpgrades(meld.server), obsConnections = countUpgrades(obs.server);
  await listen(meld.server); await listen(obs.server);
  const store = await new Store(dataDir).load();
  await store.patchConfig({ program: { kind: 'obs' }, obs: { url: `ws://127.0.0.1:${obs.server.address().port}` },
    meld: { enabled: true, url: `ws://127.0.0.1:${meld.server.address().port}` } });
  await store.setSecret('obs', { password: secret });
  const script = `
    import net from 'node:net';
    import { startServer } from './src/server.mjs';
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (_port, host, callback) { return listen.call(this, 0, host, callback); };
    const app = await startServer({ quiet: true, handleSignals: false, log: () => {} });
    process.send({ port: app.server.address().port });
    process.on('message', async () => { const code = await app.close(); process.send({ closed: code }); process.disconnect(); });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH || '', TMPDIR: tmpdir(), ANTENA_DATA: dataDir, ANTENA_MEDIA: mediaDir },
  });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const message = () => bounded(new Promise(resolve => child.once('message', resolve)), 'child message');
  let closed = false;
  t.after(async () => {
    if (!closed && child.connected) child.send('close');
    try { await bounded(exit, 'child exit'); } catch { child.kill(); }
    await obs.close(); await new Promise(resolve => meld.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const { port } = await message();
  await ready(`http://127.0.0.1:${port}`, '30.2.3');
  assert.equal(obsConnections(), 1); assert.equal(meldConnections(), 0);
  const closing = message(); child.send('close');
  assert.deepEqual(await closing, { closed: 0 }); closed = true;
  assert.deepEqual(await bounded(exit, 'child exit'), { code: 0, signal: null });
  assert.ok(!output.includes(secret));
});
