// «Últimos» and the ticker accept every support type, and the ticker keeps its own selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { DEFAULT_CONFIG } from '../src/store.mjs';

const ALL = ['follow', 'sub', 'cheer', 'raid', 'superchat', 'member', 'any'];

async function start(dataDir) {
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const get = async p => (await call('GET', '/api/config?path=' + p)).body.value;
  const stop = () => new Promise(r => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
  return { call, get, stop };
}

test('every support type offered for «Últimos» is saved, survives a restart and passes the config API', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-latest-types-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let app = await start(dataDir);
  try {
    assert.equal((await app.call('PUT', '/api/widgets', { latest: { items: ALL } })).status, 200);
    assert.deepEqual(await app.get('widgets.latest.items'), ALL);
    const viaConfig = await app.call('PUT', '/api/config', { widgets: { latest: { items: ['raid', 'member', 'any'] } } });
    assert.equal(viaConfig.status, 200, JSON.stringify(viaConfig.body));
    assert.deepEqual(await app.get('widgets.latest.items'), ['raid', 'member', 'any']);
  } finally { await app.stop(); }
  app = await start(dataDir);
  try {
    assert.deepEqual(await app.get('widgets.latest.items'), ['raid', 'member', 'any'], 'the selection is not reset on load');
  } finally { await app.stop(); }
});

test('the ticker keeps its own types, starts without them and rejects unknown ones', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-ticker-own-types-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let app = await start(dataDir);
  try {
    assert.equal(await app.get('widgets.ticker.items'), undefined, 'no own selection by default: it follows «Últimos»');
    assert.equal((await app.call('PUT', '/api/widgets', { ticker: { items: ['cheer', 'raid'] } })).status, 200);
    assert.equal((await app.call('PUT', '/api/widgets', { latest: { items: ['follow'] } })).status, 200);
    assert.deepEqual(await app.get('widgets.ticker.items'), ['cheer', 'raid'], 'editing «Últimos» leaves the ticker alone');

    const badTicker = await app.call('PUT', '/api/widgets', { ticker: { items: ['cheer', 'nope'] } });
    assert.equal(badTicker.status, 400);
    assert.match(JSON.stringify(badTicker.body), /widgets\.ticker.*cada elemento debe ser uno de: follow, sub, cheer, raid, superchat, member, any/);
    assert.deepEqual(await app.get('widgets.ticker.items'), ['cheer', 'raid'], 'a rejected ticker patch changes nothing');

    const badLatest = await app.call('PUT', '/api/widgets', { latest: { items: ['nope'] } });
    assert.equal(badLatest.status, 400);
    assert.match(JSON.stringify(badLatest.body), /widgets\.latest.*cada elemento debe ser uno de/);
    assert.deepEqual(await app.get('widgets.latest.items'), ['follow'], 'a rejected «Últimos» patch changes nothing');
  } finally { await app.stop(); }
  app = await start(dataDir);
  try {
    assert.deepEqual(await app.get('widgets.ticker.items'), ['cheer', 'raid'], 'the ticker selection survives a restart');
  } finally { await app.stop(); }
});

test('the ticker has no own types by default and null brings back the «Últimos» types', async t => {
  assert.equal(Object.hasOwn(DEFAULT_CONFIG.widgets.ticker, 'items'), false, 'a default would replace the fallback for every existing setup');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-ticker-null-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  let app = await start(dataDir);
  try {
    assert.equal((await app.call('PUT', '/api/widgets', { ticker: { items: ['raid'] } })).status, 200);
    assert.equal((await app.call('PUT', '/api/widgets', { ticker: { items: null } })).status, 200);
  } finally { await app.stop(); }
  app = await start(dataDir);
  try { assert.equal(await app.get('widgets.ticker.items'), null); } finally { await app.stop(); }
});

test('raid, member and any written to config.json by hand survive startup', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-latest-disk-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ widgets: { latest: { items: ['raid', 'member', 'any'] } } }));
  const app = await start(dataDir);
  try { assert.deepEqual(await app.get('widgets.latest.items'), ['raid', 'member', 'any']); } finally { await app.stop(); }
});

test('PUT /api/widgets validates only the new fields and keeps the legacy merge for the rest', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-widgets-partial-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await start(dataDir);
  try {
    assert.equal((await app.call('PUT', '/api/widgets', { ticker: { speed: -1, count: 'abc' } })).status, 200);
    const bad = await app.call('PUT', '/api/widgets', { latest: { label: 5 } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /widgets\.latest\.label: se esperaba un texto/);
    assert.equal(await app.get('widgets.latest.label'), '', 'a rejected label changes nothing');
    assert.equal((await app.call('PUT', '/api/widgets', { latest: { label: 'Últimos' } })).status, 200);
    assert.equal(await app.get('widgets.latest.label'), 'Últimos');
  } finally { await app.stop(); }
});
