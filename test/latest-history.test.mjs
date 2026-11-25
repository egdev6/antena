// #357: «Últimos» can show the last supporter of each type across all streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { DEFAULT_CONFIG } from '../src/store.mjs';

async function start(dataDir) {
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const state = async () => (await call('GET', '/api/widgets')).body;
  const real = (type, user, extra = {}) => app.engine.handleEvent({ externalId: `real:${type}:${user}`, type, vars: { user, ...extra } });
  const stop = async () => { await app.session.flush(); await app.latestHistory.flush(); await new Promise(r => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }); };
  return { app, call, state, real, stop };
}
const who = entry => entry?.user ?? null;
const users = latest => Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, who(v)]));

async function dir(t) {
  const d = await mkdtemp(path.join(tmpdir(), 'antena-latest-history-'));
  t.after(() => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return d;
}

test('the historical record keeps the last supporters across streams and restarts; the per-stream one resets', async t => {
  const dataDir = await dir(t);
  let a = await start(dataDir);
  try {
    a.real('follow', 'Ana'); a.real('sub', 'Bea'); a.real('superchat', 'Cris', { amount: 5, amountText: '5 €' });
    await a.call('POST', '/api/session/new', { title: 'Next stream' });
    a.real('raid', 'Dani', { viewers: 12 });
    const s = await a.state();
    assert.deepEqual(users(s.latest), { follow: null, sub: null, cheer: null, raid: 'Dani', superchat: null, member: null, any: 'Dani' });
    assert.deepEqual(users(s.latestAll), { follow: 'Ana', sub: 'Bea', cheer: null, raid: 'Dani', superchat: 'Cris', member: null, any: 'Dani' });
    assert.equal(s.latestAll.superchat.vars.amountText, '5 €');
  } finally { await a.stop(); }
  a = await start(dataDir);
  try {
    const s = await a.state();
    assert.deepEqual(users(s.latestAll), { follow: 'Ana', sub: 'Bea', cheer: null, raid: 'Dani', superchat: 'Cris', member: null, any: 'Dani' }, 'survives a restart');
  } finally { await a.stop(); }
});

test('simulated alerts count for the current stream but never for the historical record', async t => {
  const dataDir = await dir(t);
  const a = await start(dataDir);
  try {
    a.real('follow', 'Ana');
    const sim = await a.call('POST', '/api/simulate', { type: 'follow', vars: { user: 'Prueba' } });
    assert.equal(sim.status, 200);
    const s = await a.state();
    assert.equal(who(s.latest.follow), 'Prueba');
    assert.equal(who(s.latestAll.follow), 'Ana');
    assert.equal(who(s.latestAll.any), 'Ana');
  } finally { await a.stop(); }
});

test('a missing record is rebuilt once from the archived and current streams, newest first', async t => {
  const dataDir = await dir(t);
  let a = await start(dataDir);
  try {
    a.real('follow', 'Old'); a.real('cheer', 'Bits', { amount: 100 });
    await a.call('POST', '/api/session/new', {});
    await new Promise(r => setTimeout(r, 20));
    a.real('follow', 'New'); a.real('member', 'Socio');
  } finally { await a.stop(); }
  await rm(path.join(dataDir, 'latest-history.json'), { force: true });   // an install from before #357
  a = await start(dataDir);
  try {
    const s = await a.state();
    assert.deepEqual(users(s.latestAll), { follow: 'New', sub: null, cheer: 'Bits', raid: null, superchat: null, member: 'Socio', any: 'Socio' });
  } finally { await a.stop(); }
  const saved = JSON.parse(await readFile(path.join(dataDir, 'latest-history.json'), 'utf8'));
  assert.equal(saved.entries.follow.user, 'New');
});

test('«Últimos» scope defaults to the current stream, accepts «all» and rejects anything else', async t => {
  assert.equal(DEFAULT_CONFIG.widgets.latest.scope, 'stream');
  const dataDir = await dir(t);
  const a = await start(dataDir);
  try {
    assert.equal((await a.state()).widgets.latest.scope, 'stream');
    assert.equal((await a.call('PUT', '/api/widgets', { latest: { scope: 'all' } })).status, 200);
    assert.equal((await a.state()).widgets.latest.scope, 'all');
    const bad = await a.call('PUT', '/api/widgets', { latest: { scope: 'forever' } });
    assert.equal(bad.status, 400);
    assert.equal((await a.state()).widgets.latest.scope, 'all', 'a rejected value leaves the saved one');
    const viaConfig = await a.call('PUT', '/api/config', { widgets: { latest: { scope: 'stream' } } });
    assert.equal(viaConfig.status, 200, JSON.stringify(viaConfig.body));
    assert.equal((await a.state()).widgets.latest.scope, 'stream');
  } finally { await a.stop(); }
});
