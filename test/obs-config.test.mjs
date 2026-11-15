import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
async function fixture(t, seed = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'ant-obs-config-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await mkdir(dataDir);
  const file = path.join(dataDir, 'config.json');
  const original = JSON.stringify({ access: { key: 'fake-access' }, ...seed });
  await writeFile(file, original);
  const logs = [], app = await createApp({ dataDir, mediaDir, push: {}, log: (...a) => logs.push(a.join(' ')) });
  await listen(app.server);
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); app.program.dispose();
    await app.closeHttp(); await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  };
  return { root, file, original, logs, call };
}

test('meld-only config retains its values and disk bytes while OBS defaults are supplied', async t => {
  const meld = { enabled: false, url: 'ws://127.0.0.1:9876', autoSession: false, recordOnStart: true };
  const f = await fixture(t, { meld });
  const r = await f.call('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.meld, meld);
  assert.deepEqual(r.body.program, { kind: 'meld' });
  assert.deepEqual(r.body.obs, { url: 'ws://127.0.0.1:4455', passwordSet: false });
  assert.equal(await readFile(f.file, 'utf8'), f.original);
  assert.equal(f.logs.filter(x => /OBS/.test(x)).length, 0);
});

test('OBS URLs accept ws/wss and bad URLs or kinds leave config and counters unchanged', async t => {
  const f = await fixture(t);
  for (const url of ['ws://127.0.0.1:4455', 'wss://localhost:443/socket']) {
    const r = await f.call('PUT', '/api/config', { obs: { url } });
    assert.equal(r.status, 200); assert.equal(r.body.config.obs.url, url);
  }
  assert.equal((await f.call('POST', '/api/config/set', { path: 'program.kind', value: 'obs' })).status, 200);
  const before = await readFile(f.file, 'utf8');
  const config = (await f.call('GET', '/api/config')).body;
  const counters = (await f.call('GET', '/api/status')).body.persistence;
  const badUrls = ['http://127.0.0.1:4455', 'ws://', 'not a url', 'ws://user:pass@localhost:4455', 'ws://localhost/#fragment', null, 12];
  const message = 'obs.url: se esperaba una URL ws:// o wss:// válida (sin usuario ni contraseña)';
  for (const value of badUrls) {
    for (const [method, endpoint, body] of [
      ['PUT', '/api/config', { obs: { url: value } }],
      ['POST', '/api/config/set', { path: 'obs.url', value }],
    ]) {
      const r = await f.call(method, endpoint, body);
      assert.deepEqual(r, { status: 400, body: { error: message } });
      assert.equal(await readFile(f.file, 'utf8'), before);
      assert.deepEqual((await f.call('GET', '/api/config')).body, config);
      assert.deepEqual((await f.call('GET', '/api/status')).body.persistence, counters);
    }
  }
  for (const value of ['other', null]) for (const [method, endpoint, body] of [
    ['PUT', '/api/config', { program: { kind: value } }],
    ['POST', '/api/config/set', { path: 'program.kind', value }],
  ]) {
    assert.deepEqual(await f.call(method, endpoint, body), { status: 400, body: { error: 'program.kind: se esperaba uno de: meld, obs' } });
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.deepEqual((await f.call('GET', '/api/config')).body, config);
    assert.deepEqual((await f.call('GET', '/api/status')).body.persistence, counters);
  }
  for (const section of ['program', 'obs']) for (const [method, endpoint, body] of [
    ['PUT', '/api/config', { [section]: null }], ['POST', '/api/config/set', { path: section, value: null }],
  ]) {
    assert.deepEqual(await f.call(method, endpoint, body), { status: 400, body: { error: `${section}: se esperaba un objeto` } });
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.deepEqual((await f.call('GET', '/api/config')).body, config);
    assert.deepEqual((await f.call('GET', '/api/status')).body.persistence, counters);
  }
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'obs.url.extra', value: 'x' }),
    { status: 400, body: { error: 'obs.url.extra: obs.url no admite subcampos' } });
});

test('replacing a new config section keeps its required defaults', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'program', value: {} }),
    { status: 200, body: { path: 'program', value: { kind: 'meld' } } });
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'obs', value: {} }),
    { status: 200, body: { path: 'obs', value: { url: 'ws://127.0.0.1:4455', passwordSet: false } } });
});

test('existing generic config PUT, path write and public path read keep working', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('PUT', '/api/config', { overlay: { volume: 0.8 } })).body.config.overlay.volume, 0.8);
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'tts.rate', value: 1.25 }),
    { status: 200, body: { path: 'tts.rate', value: 1.25 } });
  assert.deepEqual(await f.call('GET', '/api/config?path=tts.rate'), { status: 200, body: { path: 'tts.rate', value: 1.25 } });
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).overlay.volume, 0.8);
});

test('invalid OBS configuration on disk is repaired in memory without rewriting it', async t => {
  const warnings = [], warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  t.after(() => { console.warn = warn; });
  const f = await fixture(t, { program: { kind: 'other' }, obs: { url: 'https://invalid' } });
  const r = await f.call('GET', '/api/config');
  assert.equal(r.body.program.kind, 'meld');
  assert.equal(r.body.obs.url, 'ws://127.0.0.1:4455');
  assert.equal(await readFile(f.file, 'utf8'), f.original);
  assert.ok(warnings.some(w => w.includes('program.kind')));
  assert.ok(warnings.some(w => w.includes('obs.url')));
});

test('selecting OBS leaves the live Meld connection and controls alone; restart warns once', async t => {
  const fake = fakeMeld(); let upgrades = 0;
  fake.server.on('upgrade', () => upgrades++);
  await listen(fake.server);
  const f = await fixture(t);
  t.after(() => new Promise(resolve => fake.server.close(resolve)));
  assert.equal((await f.call('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` })).status, 200);
  const deadline = Date.now() + 5000;
  while ((await f.call('GET', '/api/meld')).body.status.state !== 'conectado') {
    assert.ok(Date.now() < deadline, 'Meld did not connect');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await f.call('POST', '/api/meld/scene', { scene: 'Pantalla' }), { status: 200, body: { scene: 'Pantalla' } });
  assert.equal((await f.call('PUT', '/api/config', { program: { kind: 'obs' } })).status, 200);
  assert.equal((await f.call('PUT', '/api/config', { obs: { url: 'ws://localhost:4455' } })).status, 200);
  assert.deepEqual(await f.call('POST', '/api/meld/scene', { scene: 'Cámara' }), { status: 200, body: { scene: 'Cámara' } });
  assert.equal((await f.call('GET', '/api/meld')).body.status.state, 'conectado');
  assert.equal(upgrades, 1);
  assert.deepEqual(fake.state.calls.filter(c => c[0] === 10).map(c => c[1]), ['s2', 's1']);
  assert.equal(f.logs.filter(x => /OBS.*Meld/.test(x)).length, 1);
  const restarted = await fixture(t, { program: { kind: 'obs' } });
  assert.equal((await restarted.call('GET', '/api/config')).body.program.kind, 'obs');
  assert.equal(restarted.logs.filter(x => /OBS.*Meld/.test(x)).length, 1);
});
