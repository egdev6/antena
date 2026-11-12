// Regressions for YouTube subscriber alerts: synthetic accounts, responses and temp data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const spin = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await spin(); }
  assert.fail(message);
}
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const subscriber = id => ({ subscriberSnippet: { channelId: id, title: id } });

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'youtube-134-hardening-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  app.store.secrets.youtube = { access: 'synthetic', expiresAt: 9e15 };
  let now = Date.parse('2026-01-01T00:00:00Z');
  app.followers.now = () => now += 1000;
  const releases = [];
  t.after(async () => {
    app.followers.halt(); app.channelTotals.halt();
    for (const release of releases) release();
    await Promise.allSettled(Object.values(app.followers.busy));
    await app.followers.flush(); await app.channelTotals.flush(); await app.session.flush(); await app.closeHttp();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { app, releases };
}

async function goalFixture(t, { configured = 'UC-A', owner = 'UC-B' } = {}) {
  const { app } = await fixture(t), events = [], calls = [];
  app.store.config.youtube.channelId = configured;
  app.store.config.youtube.apiKey = 'synthetic';
  let rows = [];
  app.youtube.api = async (endpoint, params, options) => {
    calls.push([endpoint, params, options]);
    if (endpoint === '/subscriptions') return { items: rows };
    assert.equal(endpoint, '/channels');
    if (params.id === 'UC-A') return { items: [{ id: 'UC-A', statistics: { subscriberCount: '100' } }] };
    assert.equal(params.mine, 'true'); assert.deepEqual(options, { auth: true });
    return { items: [{ ...(owner === null ? {} : { id: owner }), statistics: { subscriberCount: '400' } }] };
  };
  const handle = app.engine.handleEvent.bind(app.engine);
  app.engine.handleEvent = event => { events.push(event); return handle(event); };
  app.youtube.setStatus({ state: 'escuchando' });
  await until(() => app.followers.snapshot().youtube.status === 'ok', 'baseline did not finish');
  return { app, events, calls, set rows(value) { rows = value; } };
}

for (const [label, settings, expected] of [
  ['different configured channel', { configured: 'UC-A', owner: 'UC-B' }, 100],
  ['unavailable OAuth identity with configured channel', { configured: 'UC-A', owner: null }, 100],
  ['matching configured channel', { configured: 'UC-A', owner: 'UC-A' }, 101],
  ['default OAuth channel with unavailable identity', { configured: '', owner: null }, 401],
]) {
  test(`Y134-1: ${label} keeps the correct goal and deduplicates the alert`, async t => {
    const f = await goalFixture(t, settings), { app } = f;
    assert.equal(app.session.goalValue('subscribers', 'youtube'), settings.configured ? 100 : 400);
    f.rows = [subscriber('viewer'), subscriber('viewer')];
    await app.followers.sync('youtube');
    assert.equal(app.session.goalValue('subscribers', 'youtube'), expected);
    assert.deepEqual(f.events, [{ externalId: 'ytsub:viewer', type: 'ytsub', vars: { user: 'viewer' } }]);
    assert.deepEqual(app.bus.history.map(a => [a.type, a.text]), [['ytsub', 'viewer']]);
    assert.deepEqual(app.followers.list().entries.map(e => [e.id, e.source]), [['viewer', 'live']]);
    await app.followers.sync('youtube');
    assert.equal(f.events.length, 1); assert.equal(app.session.goalValue('subscribers', 'youtube'), expected);
    if (expected === 101 || expected === 401) {
      app.channelTotals.onEvent(f.events[0]);
      assert.equal(app.session.goalValue('subscribers', 'youtube'), expected, 'externalId remains deduplicated');
    }
    assert.ok(f.calls.some(([endpoint, params]) => endpoint === '/channels' && params.mine === 'true'));
    if (settings.configured) assert.ok(f.calls.some(([endpoint, params]) => endpoint === '/channels' && params.id === 'UC-A'));
  });
}

const SAFE_AVATAR = 'https://yt3.ggpht.com/synthetic.png';
const BAD_AVATARS = ['http://127.0.0.1/unsafe', '<iframe src="https://evil.test"></iframe>', '<img src=x onerror=alert(1)>'];

test('Y134-2: public test and simulate routes sanitize ytsub avatar vars before dispatch', async t => {
  const { app } = await fixture(t), sent = [], send = app.bus.send.bind(app.bus);
  app.bus.send = (type, value, kinds) => { if (['alert', 'publicAlert'].includes(type)) sent.push({ type, value: structuredClone(value), kinds }); return send(type, value, kinds); };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const endpoint of ['/api/test', '/api/simulate']) await t.test(endpoint, async () => {
    for (const avatar of [...BAD_AVATARS, SAFE_AVATAR]) {
      const start = sent.length;
      const payload = { type: 'ytsub', ...(endpoint === '/api/test' ? { target: 'preview' } : {}), vars: { user: 'Viewer', avatar, message: 'kept' } };
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true); assert.equal(body.alert.type, 'ytsub'); assert.equal(body.alert.text, 'Viewer');
      const emitted = sent.slice(start);
      assert.deepEqual(emitted.map(e => e.type), endpoint === '/api/test' ? ['alert'] : ['alert', 'publicAlert']);
      for (const { value } of emitted) {
        assert.equal(value.type, 'ytsub'); assert.equal(value.text, 'Viewer');
        assert.deepEqual(value.vars, { user: 'Viewer', message: 'kept', ...(avatar === SAFE_AVATAR ? { avatar } : {}) });
        if (avatar !== SAFE_AVATAR) assert.equal(JSON.stringify(value).includes(avatar), false);
      }
    }
  });
  await t.test('PRESERVE: non-ytsub test and simulate vars are not rewritten', async () => {
    for (const endpoint of ['/api/test', '/api/simulate']) {
      const start = sent.length, avatar = 'http://127.0.0.1/unchanged';
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'follow', ...(endpoint === '/api/test' ? { target: 'preview' } : {}), vars: { user: 'Twitch Viewer', avatar } }) });
      assert.equal(response.status, 200); const body = await response.json();
      assert.equal(body.alert.type, 'follow'); assert.equal(body.alert.text, 'Twitch Viewer');
      assert.ok(sent.slice(start).every(e => e.value.vars.avatar === avatar));
    }
  });
});

for (const outcome of ['quota', 'error', 'success']) {
  test(`Y134-3: stale account refresh ${outcome} cannot affect the next listening period`, async t => {
    const { app, releases } = await fixture(t), blocked = gate(), statuses = [];
    releases.push(blocked.release); let calls = 0, rows = [];
    app.channelTotals.readers['subscribers@youtube'] = async () => 100;
    app.followers.on('change', snap => statuses.push(snap.youtube.status));
    app.youtube.api = async endpoint => {
      if (endpoint === '/channels') return { items: [{ statistics: { subscriberCount: '100' } }] };
      assert.equal(endpoint, '/subscriptions');
      const snapshot = rows; calls++;
      if (calls === 2) {
        await blocked.promise;
        if (outcome === 'quota') throw Object.assign(new Error('old quota'), { reason: 'quotaExceeded' });
        if (outcome === 'error') throw new Error('old failure');
      }
      return { items: snapshot };
    };
    app.youtube.setStatus({ state: 'escuchando' });
    await until(() => app.followers.snapshot().youtube.status === 'ok', 'first baseline');
    const before = app.followers.snapshot().youtube.lastSync;
    rows = [subscriber('stale')];
    app.youtube.setStatus({ account: 'Reconnected account' });
    await until(() => calls === 2, 'old account refresh entered');
    app.youtube.setStatus({ state: 'parado' }); rows = [subscriber('baseline')];
    app.youtube.setStatus({ state: 'escuchando' });
    const statusStart = statuses.length; blocked.release();
    await until(() => app.followers.snapshot().youtube.status === 'quota'
      || (calls >= 3 && app.followers.snapshot().youtube.lastSync !== before), 'restart did not settle');
    assert.equal(calls, 3, 'the new baseline must run despite stale work');
    assert.equal(app.followers.snapshot().youtube.status, 'ok');
    assert.ok(!statuses.slice(statusStart).some(status => ['quota', 'error'].includes(status)), 'no stale status may escape');
    assert.deepEqual(app.bus.history, []);
    assert.deepEqual(app.followers.list().entries.map(e => [e.id, e.source]), [['baseline', 'offline']]);
    rows = [subscriber('baseline'), subscriber('live')];
    await app.followers.sync('youtube'); await app.followers.sync('youtube');
    assert.deepEqual(app.bus.history.map(a => [a.type, a.text]), [['ytsub', 'live']]);
    assert.deepEqual(app.followers.list().entries.map(e => [e.id, e.source]), [['baseline', 'offline'], ['live', 'live']]);
    assert.equal(app.followers.snapshot().youtube.status, 'ok');
  });
}

test('Y134-3: a refresh waiting on totals is bound to its admitted period', async t => {
  const { app, releases } = await fixture(t), blocked = gate(); releases.push(blocked.release);
  let totals = 0, calls = 0, rows = [];
  app.channelTotals.readers['subscribers@youtube'] = async () => { totals++; if (totals === 2) await blocked.promise; return 100; };
  app.youtube.api = async endpoint => {
    if (endpoint === '/channels') return { items: [{ statistics: { subscriberCount: '100' } }] };
    assert.equal(endpoint, '/subscriptions'); calls++; return { items: rows };
  };
  app.youtube.setStatus({ state: 'escuchando' });
  await until(() => app.followers.snapshot().youtube.status === 'ok', 'first baseline');
  const before = app.followers.snapshot().youtube.lastSync;
  app.youtube.setStatus({ account: 'Reconnected account' });
  await until(() => totals === 2, 'account totals read entered');
  app.youtube.setStatus({ state: 'parado' }); rows = [subscriber('baseline')];
  app.youtube.setStatus({ state: 'escuchando' }); blocked.release();
  await until(() => totals >= 3 && calls >= 2 && app.followers.snapshot().youtube.lastSync !== before, 'new baseline');
  await spin(); await spin();
  assert.equal(calls, 2, 'only the two listening baselines read subscribers');
  assert.deepEqual(app.bus.history, []);
  assert.deepEqual(app.followers.list().entries.map(e => [e.id, e.source]), [['baseline', 'offline']]);
});
