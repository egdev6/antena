import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createProgram } from '../src/programs/index.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { waitFor } from './helpers/program-contract.mjs';

const BASE = (1 << 2) | (1 << 3) | (1 << 5) | (1 << 6) | (1 << 7);
const METERS = 1 << 16;
const inputs = [{ inputName: 'Mic', inputUuid: 'mic' }, { inputName: 'Music', inputUuid: 'music' }];
const level = (inputName, inputUuid, ...channels) => ({ inputName, inputUuid, inputLevelsMul: channels });
const delay = ms => new Promise(r => setTimeout(r, ms));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const until = async (fn, label) => {
  const end = Date.now() + 4000;
  while (!fn()) { assert.ok(Date.now() < end, `timeout: ${label}`); await delay(5); }
};

async function fixture(t, server = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-meters-'));
  const fake = fakeObs({ inputs }); let program, app;
  t.after(async () => {
    if (app) { await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); }
    else if (program) await program.quiesceClose();
    await fake.close(); await rm(root, { recursive: true, force: true });
  });
  await listen(fake.server);
  const url = `ws://127.0.0.1:${fake.server.address().port}`;
  if (!server) {
    program = createProgram('obs', { retryDelays: [10, 20] });
    const ready = waitFor(program, 'status', s => s.state === 'conectado');
    program.start(url); await ready;
    return { fake, program };
  }
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const ready = waitFor(app.program, 'status', s => s.state === 'conectado');
  const response = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ program: { kind: 'obs' }, obs: { url } }) });
  assert.equal(response.status, 200); await ready;
  return { fake, app, base };
}

function stream(base, query) {
  const abort = new AbortController(), events = [];
  const ready = (async () => {
    const r = await fetch(`${base}/api/stream?${query}`, { signal: abort.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); let i;
          while ((i = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data), at: performance.now() });
          }
        }
      } catch { /* abort */ }
    })();
  })();
  return { ready, events, close: () => abort.abort() };
}

const masks = fake => fake.identifications.map(x => [x.op, x.eventSubscriptions]);

test('OBS subscribes only on demand via Reidentify; acknowledgements do not restart initialization', async t => {
  const { fake, program } = await fixture(t); const events = [];
  program.on('meters', value => events.push(value));
  assert.deepEqual(masks(fake), [[1, BASE]]);
  fake.setVolumeMeters([level('Mic', 'mic', [0.2, 0.5, 0.5])]); await delay(80);
  assert.deepEqual(events, []);
  const count = fake.requests.length;
  program.watchMeters(true); program.watchMeters(true);
  await until(() => masks(fake).length === 2, 'subscribe');
  assert.deepEqual(masks(fake), [[1, BASE], [3, BASE | METERS]]);
  fake.setVolumeMeters([level('Mic', 'mic', [0.2, 0.1, 0.1])]);
  await until(() => events.length === 1, 'meter event');
  assert.equal(fake.requests.length, count, 'Identified acknowledgement must not trigger queries');
  program.watchMeters(false); program.watchMeters(false);
  await until(() => masks(fake).length === 3, 'unsubscribe');
  assert.deepEqual(masks(fake).at(-1), [3, BASE]);
  fake.setVolumeMeters([level('Mic', 'mic', [1, 1, 1])]); await delay(80);
  assert.equal(events.length, 1);
});

test('OBS meters use the loudest channel peak in the -60 to 0 dB scale and input clipping', async t => {
  const { fake, program } = await fixture(t); const events = [];
  program.on('meters', value => events.push(value)); program.watchMeters(true);
  await until(() => masks(fake).length === 2, 'subscribe');
  for (const [peak, expected] of [[0, 0], [0.001, 0], [0.01, 1 / 3], [0.1, 2 / 3], [1, 1], [2, 1]]) {
    fake.setVolumeMeters([level('Mic', 'mic', [0.9, peak / 2, 0.2], [0.1, peak, 1.2]),
      level('Music', 'music', [0, 0, 0]), level('Unknown', 'unknown', [1, 1, 1])]);
    await until(() => events.length > 0, 'levels');
    const tracks = events.shift();
    assert.deepEqual(tracks.map(x => x.id), ['mic', 'music']);
    assert.ok(Math.abs(tracks[0].level - expected) < 1e-9, `${peak}: ${tracks[0].level}`);
    assert.equal(tracks[0].clipping, true);
    assert.deepEqual(tracks[1], { id: 'music', level: 0, clipping: false });
  }
  fake.setVolumeMeters([]); await until(() => events.length, 'empty snapshot'); assert.deepEqual(events.shift(), []);
});

test('server aggregates meter snapshots at most 10 Hz for watching streams only and releases the last watcher', async t => {
  const { fake, base } = await fixture(t, true);
  assert.deepEqual(masks(fake), [[1, BASE]]);
  const panel = stream(base, 'client=panel'), overlay = stream(base, 'client=overlay'), a = stream(base, 'client=dock-meters'), b = stream(base, 'client=dock-meters');
  t.after(() => { panel.close(); overlay.close(); a.close(); b.close(); });
  await Promise.all([panel.ready, overlay.ready, a.ready, b.ready]);
  await until(() => panel.events.some(e => e.event === 'status') && overlay.events.some(e => e.event === 'pause') && overlay.events.some(e => e.event === 'theme'), 'legacy SSE snapshots');
  await until(() => masks(fake).length === 2, 'two watchers subscribed');
  assert.deepEqual(masks(fake), [[1, BASE], [3, BASE | METERS]]);
  for (let i = 0; i < 12; i++) {
    fake.setVolumeMeters([level('Mic', 'mic', [0, i === 11 ? 1 : 0.1, 0.5]), level('Music', 'music', [0, 0.01, 0])]);
    await delay(50);
  }
  await until(() => a.events.length && a.events.at(-1).data.tracks?.[0].level === 1, 'latest levels');
  const frames = a.events.filter(e => e.event === 'meld');
  assert.ok(frames.length >= 3 && frames.length <= 7, `bounded frames: ${frames.length}`);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].at - frames[i - 1].at >= 80, 'bounded spacing');
  assert.deepEqual(frames.at(-1).data.tracks.map(x => x.id), ['mic', 'music']);
  assert.equal(b.events.filter(e => e.event === 'meld').length, frames.length);
  assert.equal(panel.events.some(e => e.data?.tracks), false);
  assert.equal(overlay.events.some(e => e.data?.tracks), false);
  a.close(); await delay(100); assert.equal(masks(fake).length, 2);
  b.close(); await until(() => masks(fake).length === 3, 'last watcher left');
  assert.deepEqual(masks(fake).at(-1), [3, BASE]);
  fake.setVolumeMeters([level('Mic', 'mic', [1, 1, 1])]); await delay(150);
  assert.equal(panel.events.some(e => e.data?.tracks), false);
});

test('meter demand survives an OBS restart but never enters the Identify mask', async t => {
  const { fake, program } = await fixture(t);
  program.watchMeters(true); await until(() => masks(fake).length === 2, 'first subscription');
  program.stop();
  const ready = waitFor(program, 'status', s => s.state === 'conectado');
  program.start(`ws://127.0.0.1:${fake.server.address().port}`); await ready;
  await until(() => masks(fake).length === 4, 'resubscription');
  assert.deepEqual(masks(fake), [[1, BASE], [3, BASE | METERS], [1, BASE], [3, BASE | METERS]]);
  const events = []; program.on('meters', value => events.push(value));
  fake.setVolumeMeters([level('Mic', 'mic', [0, 0.1, 0])]);
  await until(() => events.length === 1, 'levels after restart');
  assert.equal(events[0][0].id, 'mic');
});

test('disconnect clears previously published levels for a still-watching dock', async t => {
  const { fake, base } = await fixture(t, true);
  const watcher = stream(base, 'client=dock-meters'); t.after(() => watcher.close()); await watcher.ready;
  await until(() => masks(fake).length === 2, 'watching');
  fake.setVolumeMeters([level('Mic', 'mic', [0, 1, 1])]);
  await until(() => watcher.events.some(e => e.data?.tracks?.[0]?.level === 1), 'loud level');
  fake.invalidateSession();
  await until(() => watcher.events.some(e => Array.isArray(e.data?.tracks) && e.data.tracks.length === 0), 'cleared on disconnect');
});

test('switching to Meld disables meter collection even if a watcher remains', async t => {
  const { fake, base } = await fixture(t, true);
  const watcher = stream(base, 'client=dock-meters'); t.after(() => watcher.close()); await watcher.ready;
  await until(() => masks(fake).length === 2, 'watching');
  const r = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ program: { kind: 'meld' }, meld: { enabled: false } }) });
  assert.equal(r.status, 200);
  fake.setVolumeMeters([level('Mic', 'mic', [1, 1, 1])]); await delay(150);
  assert.equal(watcher.events.some(e => e.event === 'meld'), false);
});
