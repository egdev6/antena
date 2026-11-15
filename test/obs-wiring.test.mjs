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
async function bounded(promise, label, ms = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timeout`)), ms); })]); }
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
function observe(server) {
  let upgrades = 0;
  const sockets = new Set();
  server.on('upgrade', () => upgrades++);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return { upgrades: () => upgrades, sockets, destroy: () => { for (const socket of sockets) socket.destroy(); } };
}
async function closeFakes(obs, meld, obsConnections, meldConnections) {
  obsConnections.destroy(); meldConnections.destroy();
  const results = await Promise.allSettled([
    bounded(obs.close(), 'OBS server close', 2000),
    bounded(new Promise((resolve, reject) => meld.server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    })), 'Meld server close', 2000),
  ]);
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'fake server teardown failed');
}
async function http(base, method, endpoint, body) {
  const r = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, body: await r.json() };
}
async function liveFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-wiring-'));
  const meld = fakeMeld(), obs = fakeObs({ password: secret }), logs = [];
  const meldConnections = observe(meld.server), obsConnections = observe(obs.server);
  let app, abort;
  t.after(async () => {
    const errors = [];
    abort?.abort();
    if (app) {
      try {
        await bounded((async () => {
          await app.drainAutoSession(); await app.session.flush();
          await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
        })(), 'app close', 2000);
      } catch (error) { errors.push(error); }
      app.program.stop(); app.meld.stop(); app.program.dispose();
      app.server.closeAllConnections(); app.closeUpgradedConnections();
    }
    try { await closeFakes(obs, meld, obsConnections, meldConnections); } catch (error) { errors.push(error); }
    if (app) try { await bounded(app.closeHttp(), 'HTTP close', 2000); } catch (error) { errors.push(error); }
    await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'fixture teardown failed');
  });
  await listen(meld.server); await listen(obs.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: (...a) => logs.push(a.join(' ')) });
  await listen(app.server);
  return { app, meld, obs, logs, meldConnections, obsConnections,
    base: `http://127.0.0.1:${app.server.address().port}`,
    meldUrl: `ws://127.0.0.1:${meld.server.address().port}`, obsUrl: `ws://127.0.0.1:${obs.server.address().port}`,
    setAbort: controller => { abort = controller; } };
}
async function startupFixture(t, kind, enabled) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-startup-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  const meld = fakeMeld(), obs = fakeObs({ password: secret });
  const meldConnections = observe(meld.server), obsConnections = observe(obs.server);
  let child, exit, closed = false, output = '';
  t.after(async () => {
    if (child) {
      if (!closed && child.connected) child.send('close');
      try { await bounded(exit, 'child exit', 2000); } catch {
        child.kill();
        await bounded(exit, 'killed child exit', 2000);
      }
    }
    try { await closeFakes(obs, meld, obsConnections, meldConnections); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await listen(meld.server); await listen(obs.server);
  const store = await new Store(dataDir).load();
  await store.patchConfig({ program: { kind }, obs: { url: `ws://127.0.0.1:${obs.server.address().port}` },
    meld: { enabled, url: `ws://127.0.0.1:${meld.server.address().port}` } });
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
  child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH || '', TMPDIR: tmpdir(), ANTENA_DATA: dataDir, ANTENA_MEDIA: mediaDir },
  });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const message = () => bounded(new Promise(resolve => child.once('message', resolve)), 'child message');
  const { port } = await message();
  return { base: `http://127.0.0.1:${port}`, meldConnections, obsConnections, output: () => output,
    close: async () => {
      const closing = message(); child.send('close');
      assert.deepEqual(await closing, { closed: 0 }); closed = true;
      assert.deepEqual(await bounded(exit, 'child exit'), { code: 0, signal: null });
    } };
}

test('live switching preserves the facade, disconnects the old program and masks OBS credentials', { timeout: 20000 }, async t => {
  const { app, meld, obs, logs, meldConnections, obsConnections, base, meldUrl, obsUrl, setAbort } = await liveFixture(t);
  const facade = app.program;
  assert.equal((await http(base, 'POST', '/api/meld/connect', { url: meldUrl })).status, 200);
  await ready(base, 2);
  const abort = new AbortController(); setAbort(abort);
  const response = await fetch(base + '/api/stream?client=panel', { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const changed = await http(base, 'PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: obsUrl, password: secret } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.config.obs.passwordSet, true);
  assert.ok(!JSON.stringify(changed).includes(secret));
  const status = await ready(base, '30.2.3');
  assert.strictEqual(app.program, facade);
  assert.equal(meldConnections.upgrades(), 1); assert.equal(obsConnections.upgrades(), 1);
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
  assert.equal(obsConnections.upgrades(), 2);
  assert.ok(obs.requests.length > obsRequests);
  const config = (await http(base, 'GET', '/api/config')).body;
  assert.equal(config.meld.url, meldUrl);
  assert.equal(config.obs.url, obsUrl);
  assert.equal((await http(base, 'PUT', '/api/config', { program: { kind: 'meld' } })).status, 200);
  await ready(base, 2);
  assert.strictEqual(app.program, facade);
  assert.equal(meldConnections.upgrades(), 2); assert.equal(obsConnections.upgrades(), 2);
  assert.deepEqual(await http(base, 'POST', '/api/meld/scene', { scene: 'Pantalla' }), { status: 200, body: { scene: 'Pantalla' } });
});

test('startup with OBS selected connects OBS, never starts enabled Meld, and closes cleanly', { timeout: 20000 }, async t => {
  const f = await startupFixture(t, 'obs', true);
  await ready(f.base, '30.2.3');
  assert.equal(f.obsConnections.upgrades(), 1); assert.equal(f.meldConnections.upgrades(), 0);
  await f.close();
  assert.ok(!f.output().includes(secret));
});

test('startup with Meld selected and disabled keeps both programs disconnected', { timeout: 20000 }, async t => {
  const f = await startupFixture(t, 'meld', false);
  await delay(150);
  const status = await http(f.base, 'GET', '/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.meld.state, 'desconectado');
  assert.equal(f.meldConnections.upgrades(), 0); assert.equal(f.obsConnections.upgrades(), 0);
  await f.close();
});

test('switching back to Meld respects meld.enabled false', { timeout: 20000 }, async t => {
  const { base, meldUrl, obsUrl, meldConnections, obsConnections } = await liveFixture(t);
  const selected = await http(base, 'PUT', '/api/config', {
    program: { kind: 'obs' }, obs: { url: obsUrl, password: secret }, meld: { enabled: false, url: meldUrl },
  });
  assert.equal(selected.status, 200); assert.equal(selected.body.config.meld.enabled, false);
  await ready(base, '30.2.3');
  assert.equal(obsConnections.upgrades(), 1); assert.equal(meldConnections.upgrades(), 0);
  assert.deepEqual(await http(base, 'POST', '/api/config/set', { path: 'meld.url', value: meldUrl }),
    { status: 200, body: { path: 'meld.url', value: meldUrl } });
  await delay(150);
  await ready(base, '30.2.3');
  assert.equal(obsConnections.upgrades(), 1); assert.equal(meldConnections.upgrades(), 0);
  assert.deepEqual(await http(base, 'POST', '/api/config/set', { path: 'program.kind', value: 'meld' }),
    { status: 200, body: { path: 'program.kind', value: 'meld' } });
  await delay(150);
  assert.equal(meldConnections.upgrades(), 0);
  const status = await http(base, 'GET', '/api/status');
  assert.equal(status.status, 200); assert.equal(status.body.meld.state, 'desconectado');
});

test('meld→obs closes the Meld socket; config/set obs.password reconnects OBS', { timeout: 20000 }, async t => {
  const { base, meldUrl, obsUrl, meldConnections, obsConnections } = await liveFixture(t);
  assert.equal((await http(base, 'POST', '/api/meld/connect', { url: meldUrl })).status, 200);
  await ready(base, 2);
  assert.equal(meldConnections.upgrades(), 1); assert.equal(meldConnections.sockets.size, 1);
  assert.equal((await http(base, 'PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: obsUrl } })).status, 200);
  const deadline = Date.now() + 3000;
  while (meldConnections.sockets.size && Date.now() < deadline) await delay(10);
  assert.equal(meldConnections.sockets.size, 0, 'old Meld socket closed');
  let status;
  do {
    status = await http(base, 'GET', '/api/status');
    assert.equal(status.status, 200);
    if (status.body.meld.state === 'error') break;
    await delay(10);
  } while (Date.now() < deadline);
  assert.equal(status.body.meld.state, 'error');
  assert.equal(status.body.meld.error, 'Contraseña de OBS incorrecta.');
  assert.equal(obsConnections.upgrades(), 1);
  assert.deepEqual(await http(base, 'POST', '/api/config/set', { path: 'obs.password', value: secret }),
    { status: 200, body: { path: 'obs.password', passwordSet: true } });
  await ready(base, '30.2.3');
  assert.equal(obsConnections.upgrades(), 2); assert.equal(meldConnections.sockets.size, 0);
});
