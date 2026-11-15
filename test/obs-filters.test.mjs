import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createProgram } from '../src/programs/index.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { waitFor } from './helpers/program-contract.mjs';

const options = () => ({
  scenes: [
    { sceneName: 'Camera', sceneUuid: 'cam', sceneItems: [
      { sceneItemId: 1, sourceName: 'Video' }, { sceneItemId: 2, sourceName: 'Logo' },
      { sceneItemId: 3, sourceName: 'Video' },
    ] },
    { sceneName: 'Slides', sceneUuid: 'slides', sceneItems: [{ sceneItemId: 1, sourceName: 'Video' }] },
  ],
  inputs: [
    { inputName: 'Video', inputUuid: 'video', inputKind: 'ffmpeg_source', filters: [
      { filterName: 'Blur', filterEnabled: true }, { filterName: 'Color', filterEnabled: false },
    ] },
    { inputName: 'Logo', inputKind: 'image_source' },
  ],
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = fake => `ws://127.0.0.1:${fake.server.address().port}`;
const effects = session => session.scenes.flatMap(s => s.layers.filter(l => l.name === 'Video').map(l => l.effects));
async function fixture(t) {
  const fake = fakeObs(options());
  t.after(() => fake.close());
  await listen(fake.server);
  const program = createProgram('obs', { retryDelays: [10, 20] });
  t.after(async () => { await program.quiesceClose(); program.dispose(); });
  const ready = waitFor(program, 'status', s => s.state === 'conectado');
  program.start(url(fake)); await ready;
  return { fake, program };
}
async function external(t, fake) {
  const socket = new WebSocket(url(fake), 'obswebsocket.json'), pending = new Map();
  t.after(() => socket.close());
  await new Promise(resolve => {
    socket.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.op === 0) socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1 } }));
      if (m.op === 2) resolve();
      if (m.op === 7) pending.get(m.d.requestId)?.(m.d);
    };
  });
  let id = 0;
  return (requestType, requestData) => new Promise(resolve => {
    const requestId = String(++id); pending.set(requestId, resolve);
    socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  });
}

test('OBS filter session shape, shared sources, toggle by name and id, and rejected lookups', async t => {
  const { fake, program } = await fixture(t);
  const initial = [{ id: 'Blur', name: 'Blur', enabled: true }, { id: 'Color', name: 'Color', enabled: false }];
  assert.deepEqual(effects(program.session()), [initial, initial, initial]);
  assert.deepEqual(program.session().scenes[0].layers[1].effects, []);
  const copy = program.session(); copy.scenes[0].layers[0].effects[0].enabled = false;
  assert.equal(program.session().scenes[0].layers[0].effects[0].enabled, true);
  const before = fake.requests.length;
  await program.toggleEffect('cam', 'cam:1', 'blur');
  await program.toggleEffect('Slides', 'Video', 'Color');
  assert.deepEqual(fake.requests.slice(before), [
    { requestType: 'SetSourceFilterEnabled', requestData: { sourceName: 'Video', filterName: 'Blur', filterEnabled: false } },
    { requestType: 'SetSourceFilterEnabled', requestData: { sourceName: 'Video', filterName: 'Color', filterEnabled: true } },
  ]);
  const changed = [{ ...initial[0], enabled: false }, { ...initial[1], enabled: true }];
  assert.deepEqual(effects(program.session()), [changed, changed, changed]);
  const snapshot = program.session(), count = fake.requests.length;
  await assert.rejects(program.toggleEffect('Camera', 'Video', 'missing'), { message: 'No encuentro el efecto «missing»' });
  await assert.rejects(program.toggleEffect('Camera', 'missing', 'Blur'), { message: 'No encuentro la capa «missing»' });
  assert.equal(fake.requests.length, count); assert.deepEqual(program.session(), snapshot);
});

test('external OBS filter create, enable, rename and removal synchronize every shared layer', async t => {
  const { fake, program } = await fixture(t), request = await external(t, fake);
  for (const [type, data, expected] of [
    ['CreateSourceFilter', { sourceName: 'Video', filterName: 'Glow', filterKind: 'fake_filter' }, ['Blur:true', 'Color:false', 'Glow:true']],
    ['SetSourceFilterEnabled', { sourceName: 'Video', filterName: 'Glow', filterEnabled: false }, ['Blur:true', 'Color:false', 'Glow:false']],
    ['SetSourceFilterName', { sourceName: 'Video', filterName: 'Glow', newFilterName: 'Light' }, ['Blur:true', 'Color:false', 'Light:false']],
    ['RemoveSourceFilter', { sourceName: 'Video', filterName: 'Light' }, ['Blur:true', 'Color:false']],
  ]) {
    const published = waitFor(program, 'session');
    published.catch(() => {}); // A rejected RPC must not leave an unhandled event timeout.
    const response = await request(type, data);
    assert.equal(response.requestStatus.result, true, type);
    await published;
    assert.deepEqual(effects(program.session()).map(list => list.map(e => `${e.name}:${e.enabled}`)), [expected, expected, expected], type);
  }
});

test('OBS media controls target the source, translate seconds, and reject non-media inputs', async t => {
  const { fake, program } = await fixture(t), before = fake.requests.length;
  for (const [command, seconds] of [['play'], ['pause'], ['restart'], ['stop'], ['seekTo', 1.234], ['seekTo']])
    await program.media('cam:1', command, seconds);
  assert.deepEqual(fake.requests.slice(before), [
    ...['PLAY', 'PAUSE', 'RESTART', 'STOP'].map(action => ({ requestType: 'TriggerMediaInputAction',
      requestData: { inputName: 'Video', mediaAction: `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${action}` } })),
    { requestType: 'SetMediaInputCursor', requestData: { inputName: 'Video', mediaCursor: 1234 } },
    { requestType: 'SetMediaInputCursor', requestData: { inputName: 'Video', mediaCursor: 0 } },
  ]);
  const snapshot = program.session();
  await assert.rejects(program.media('Logo', 'play'), { message: 'La capa «Logo» no es una fuente multimedia de OBS.' });
  await assert.rejects(program.media('Logo', 'seekTo', 2), { message: 'La capa «Logo» no es una fuente multimedia de OBS.' });
  const count = fake.requests.length;
  await assert.rejects(program.media('missing', 'play'), { message: 'No encuentro la capa «missing»' });
  await assert.rejects(program.media('Video', 'skip'), { message: 'Comando multimedia «skip» no disponible con OBS.' });
  assert.equal(fake.requests.length, count); assert.deepEqual(program.session(), snapshot);
});

test('OBS effect and media HTTP routes and engine effect use the same facade', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-filters-')), fake = fakeObs(options());
  let app;
  t.after(async () => {
    if (app) { await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); }
    await fake.close(); await rm(root, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (endpoint, body) => {
    const r = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  };
  const ready = waitFor(app.program, 'status', s => s.state === 'conectado');
  const config = await fetch(base + '/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ program: { kind: 'obs' }, obs: { url: url(fake) } }), signal: AbortSignal.timeout(5000) });
  assert.equal(config.status, 200); await ready;
  assert.deepEqual(await call('/api/program/effect', { scene: 'cam', layer: 'cam:1', effect: 'Blur' }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call('/api/program/media', { layer: 'Video' }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call('/api/program/media', { layer: 'Video', command: 'pause' }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call('/api/program/media', { layer: 'Video', command: 'seekTo', seconds: 2.5 }), { status: 200, body: { ok: true } });
  const snapshot = app.program.session(), count = fake.requests.length;
  assert.deepEqual(await call('/api/program/effect', { scene: 'cam', layer: 'cam:1', effect: 'missing' }),
    { status: 500, body: { error: 'No encuentro el efecto «missing»' } });
  assert.equal(fake.requests.length, count); assert.deepEqual(app.program.session(), snapshot);
  assert.deepEqual(await call('/api/program/media', { layer: 'Logo', command: 'play' }),
    { status: 500, body: { error: 'La capa «Logo» no es una fuente multimedia de OBS.' } });
  assert.deepEqual(app.program.session(), snapshot);
  assert.deepEqual(await call('/api/actions/run', { actions: [{ kind: 'effect', scene: 'Camera', layer: 'Video', effect: 'Blur' }] }),
    { status: 200, body: { ok: true } });
  assert.equal(fake.requests.filter(r => r.requestType === 'SetSourceFilterEnabled').at(-1).requestData.filterEnabled, true);
  assert.equal(app.program.session().scenes[0].layers[0].effects[0].enabled, true);
});
