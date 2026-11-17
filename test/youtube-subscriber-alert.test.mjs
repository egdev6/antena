// YouTube subscribers (#134): synthetic API responses and isolated temporary data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { FollowerRegistry } from '../src/followers.mjs';

const row = (id, name, at, thumbnails) => ({ snippet: { publishedAt: at }, subscriberSnippet: { channelId: id, title: name, ...(thumbnails === undefined ? {} : { thumbnails }) } });
const later = () => new Date(Date.now() + 1).toISOString();
const spin = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, message) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await spin(); }
  assert.fail(message || 'operation did not finish');
}
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

async function fixture(t, { seconds = 60, clock = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'youtube-subscriber-134-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  app.store.secrets.youtube = { access: 'synthetic' };
  app.store.config.youtube.subscriberPollSeconds = seconds;
  let rows = [], calls = [], fail = null, block = null, subscriberCount = 100, hiddenCount = false;
  app.youtube.api = async (url, params, options) => {
    calls.push({ url, params, options });
    const requestedRows = rows;
    if (block && url === '/subscriptions') await block.promise;
    if (fail?.url === url) throw Object.assign(new Error('quota exhausted'), { reason: 'quotaExceeded' });
    return url === '/subscriptions' ? { items: requestedRows } : { items: [{ id: 'UC-oauth', statistics: {
      ...(subscriberCount === null ? {} : { subscriberCount: String(subscriberCount) }), hiddenSubscriberCount: hiddenCount,
    } }] };
  };
  app.channelTotals.readers['subscribers@youtube'] = async () => 100;
  const events = [], publicAlerts = [], handle = app.engine.handleEvent.bind(app.engine), send = app.bus.send.bind(app.bus);
  app.engine.handleEvent = event => { events.push(event); return handle(event); };
  app.bus.send = (type, data, kinds) => { if (type === 'publicAlert') publicAlerts.push(data); return send(type, data, kinds); };
  if (clock) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    app.followers.now = () => Date.now();
  }
  t.after(async () => {
    if (block) block.release();
    app.followers.halt(); app.channelTotals.halt();
    await app.followers.flush(); await app.channelTotals.flush(); await app.session.flush();
    await app.closeHttp();
    if (clock) t.mock.timers.reset();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { app, dir, events, publicAlerts, get calls() { return calls; }, get rows() { return rows; }, set rows(value) { rows = value; },
    set subscriberCount(value) { subscriberCount = value; }, set hiddenCount(value) { hiddenCount = value; },
    set fail(value) { fail = value; }, set block(value) { block = value; } };
}
const subscriptions = f => f.calls.filter(c => c.url === '/subscriptions');
const listening = f => f.app.youtube.setStatus({ state: 'escuchando' });
const stopped = f => f.app.youtube.setStatus({ state: 'parado' });
const advance = (t, ms) => t.mock.timers.tick(ms);

async function baseline(f) {
  const before = subscriptions(f).length;
  listening(f);
  await until(() => subscriptions(f).length > before && f.app.followers.snapshot().youtube.status !== 'idle', 'baseline did not complete');
  await spin();
}

test('S2: thumbnail and name reach public alerts; missing thumbnails and registry reload stay unchanged', async t => {
  const f = await fixture(t); await baseline(f);
  const urls = ['https://yt3.ggpht.com/default.png', 'https://googleusercontent.com/medium.png', 'https://ggpht.com:443/high.png'];
  f.rows = [
    row('default', 'Default', later(), { default: { url: urls[0] }, medium: { url: urls[1] } }),
    row('medium', 'Medium', later(), { default: { url: 'https://evil.test/no.png' }, medium: { url: urls[1] } }),
    row('high', 'High', later(), { default: null, medium: { url: 42 }, high: { url: urls[2] } }),
    row('plain', 'Plain', later()),
    row('malformed', 'Malformed', later(), 'not-an-object'),
  ];
  await f.app.refreshFollowers('youtube');
  assert.deepEqual(f.events.map(e => e.vars), [
    { user: 'Default', avatar: urls[0] }, { user: 'Medium', avatar: urls[1] }, { user: 'High', avatar: urls[2] },
    { user: 'Plain' }, { user: 'Malformed' },
  ]);
  assert.deepEqual(f.publicAlerts.map(a => [a.type, a.vars]), f.events.map(e => [e.type, e.vars]));
  await f.app.followers.flush();
  const restored = await new FollowerRegistry({ dir: f.dir }).load();
  const entries = restored.list().entries;
  assert.deepEqual(entries.map(e => [e.id, e.name, e.source]), [
    ['default', 'Default', 'live'], ['medium', 'Medium', 'live'], ['high', 'High', 'live'], ['plain', 'Plain', 'live'], ['malformed', 'Malformed', 'live'],
  ]);
  assert.ok(entries.every(e => !Object.hasOwn(e, 'avatar')));
});

test('S2: unsafe subscriber thumbnail URLs are excluded without rejecting names', async t => {
  const f = await fixture(t); await baseline(f);
  const unsafe = [
    'http://ggpht.com/x', 'https://user:pass@ggpht.com/x', 'https://@ggpht.com/x', 'https://ggpht.com:444/x',
    'https://ggpht.com.evil.test/x', 'https://evilggpht.com/x', 'https://googleusercontent.com.evil.test/x',
    'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'javascript:alert(1)', 'data:image/png;base64,AA==',
    '//ggpht.com/x', '/relative.png', 'https:ggpht.com/x', 'https://ggpht.com/space here', 7, {},
  ];
  f.rows = unsafe.map((url, i) => row(`bad-${i}`, `Viewer ${i}`, later(), { default: { url } }));
  await f.app.refreshFollowers('youtube');
  assert.equal(f.events.length, unsafe.length);
  assert.deepEqual(f.events.map(e => e.vars), unsafe.map((_, i) => ({ user: `Viewer ${i}` })));
  assert.deepEqual(f.publicAlerts.map(a => a.vars), f.events.map(e => e.vars));
  assert.ok(f.calls.every(c => ['/subscriptions', '/channels'].includes(c.url)));
});

test('S1–S3/S6: listening baseline is offline, later polls emit once, persist live and complement the goal', async t => {
  const f = await fixture(t), { app } = f;
  f.rows = [row('old', 'Old', '2020-01-01T00:00:00.000Z')];
  await app.followers.sync('youtube');
  f.rows = [...f.rows, row('offline', 'Offline', later())];
  advance(t, 1000);
  await baseline(f);
  assert.deepEqual(f.events, []);
  assert.deepEqual(app.followers.list().entries.map(e => [e.id, e.source]), [['offline', 'offline']]);
  assert.equal(app.session.goalValue('subscribers', 'youtube'), 100);
  f.rows = [...f.rows, row('new', 'New Subscriber', later())];
  advance(t, 60_000);
  await until(() => f.events.length === 1, 'new subscriber was not dispatched');
  assert.deepEqual(f.events, [{ externalId: 'ytsub:new', type: 'ytsub', vars: { user: 'New Subscriber' } }]);
  assert.equal(app.bus.history[0].type, 'ytsub');
  assert.equal(app.bus.history[0].text, 'New Subscriber');
  assert.equal(app.followers.list().entries.find(e => e.id === 'new').source, 'live');
  assert.equal(app.session.goalValue('subscribers', 'youtube'), 101);
  app.channelTotals.onEvent(f.events[0]);
  app.engine.handleEvent(f.events[0]);
  assert.equal(app.session.goalValue('subscribers', 'youtube'), 101);
  assert.equal(app.bus.history.length, 1);
  assert.equal(app.session.data.events.length, 1);
  assert.equal(app.session.latest().follow.user, 'New Subscriber');
  assert.deepEqual(app.session.credits().find(g => g.title === 'Nuevos seguidores').names, ['New Subscriber']);
  const count = subscriptions(f).length;
  advance(t, 60_000);
  await until(() => subscriptions(f).length > count, 'second poll did not run');
  await app.followers.sync('youtube'); await app.followers.flush();
  assert.equal(f.events.length, 2, 'only the explicit duplicate was re-submitted');
  assert.equal(app.followers.list().entries.filter(e => e.id === 'new').length, 1);
  assert.equal(app.session.goalValue('subscribers', 'youtube'), 101);
  assert.deepEqual(subscriptions(f)[0].params, { part: 'snippet,subscriberSnippet', myRecentSubscribers: 'true', maxResults: 50 });
  assert.deepEqual(subscriptions(f)[0].options, { auth: true });
});

test('S2/S6: a normal registry refresh during listening cannot silently consume a new subscriber', async t => {
  const f = await fixture(t); await baseline(f);
  f.rows = [row('startup-race', 'During startup refresh', later())];
  await f.app.refreshFollowers('youtube');
  assert.deepEqual(f.events, [{ externalId: 'ytsub:startup-race', type: 'ytsub', vars: { user: 'During startup refresh' } }]);
  assert.deepEqual(f.app.followers.list().entries.map(e => [e.id, e.source]), [['startup-race', 'live']]);
  const count = subscriptions(f).length; advance(t, 60_000);
  await until(() => subscriptions(f).length > count);
  assert.equal(f.events.length, 1);
});

test('S2/S3: a refresh queued behind the baseline uses the newly established live reference', async t => {
  const f = await fixture(t), g = gate(); f.block = g;
  listening(f); await until(() => subscriptions(f).length === 1);
  f.rows = [row('queued', 'Queued', later())];
  const refresh = f.app.refreshFollowers('youtube'); await spin();
  g.release(); f.block = null; await refresh;
  assert.deepEqual(f.events, [{ externalId: 'ytsub:queued', type: 'ytsub', vars: { user: 'Queued' } }]);
  assert.deepEqual(f.app.followers.list().entries.map(e => [e.id, e.source]), [['queued', 'live']]);
});

test('S1/S5: the default is 120 seconds, positive values below 60 clamp, and 0 disables polling', async t => {
  const f = await fixture(t, { seconds: 1 });
  await baseline(f); let count = subscriptions(f).length;
  advance(t, 59_999); await spin(); assert.equal(subscriptions(f).length, count);
  advance(t, 1); await until(() => subscriptions(f).length > count);
  await f.app.store.patchConfig({ youtube: { subscriberPollSeconds: 0 } });
  count = subscriptions(f).length; advance(t, 300_000); await spin(); assert.equal(subscriptions(f).length, count);
  await f.app.store.patchConfig({ youtube: { subscriberPollSeconds: 120 } });
  advance(t, 119_999); await spin(); assert.equal(subscriptions(f).length, count);
  advance(t, 1); await until(() => subscriptions(f).length > count);
  assert.equal((await import('../src/store.mjs')).DEFAULT_CONFIG.youtube.subscriberPollSeconds, 120);
});

test('S1/S5: zero at the start keeps the transition baseline but disables subsequent polls', async t => {
  const f = await fixture(t, { seconds: 0 }); await baseline(f);
  const count = subscriptions(f).length;
  advance(t, 300_000); await spin(); assert.equal(subscriptions(f).length, count);
  f.rows = [row('offline-disabled', 'Offline', later())];
  await f.app.refreshFollowers('youtube');
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.app.followers.list().entries.map(e => [e.id, e.source]), [['offline-disabled', 'offline']]);
  await f.app.store.patchConfig({ youtube: { subscriberPollSeconds: 60 } });
  const afterRefresh = subscriptions(f).length;
  advance(t, 60_000); await until(() => subscriptions(f).length > afterRefresh);
});

test('S3/S5: quotaExceeded during the baseline stays stopped until a new listening period', async t => {
  const f = await fixture(t); f.fail = { url: '/subscriptions' }; listening(f);
  await until(() => f.app.followers.snapshot().youtube.status === 'quota');
  const count = subscriptions(f).length; f.fail = null;
  advance(t, 180_000); await spin(); assert.equal(subscriptions(f).length, count);
  stopped(f); await baseline(f);
  assert.deepEqual(f.events, []);
  f.rows = [row('after', 'After', later())]; advance(t, 60_000);
  await until(() => f.events.length === 1);
  assert.deepEqual(f.events[0], { externalId: 'ytsub:after', type: 'ytsub', vars: { user: 'After' } });
});

test('S3/S5: leaving listening discards in-flight results and a new listening period has a new baseline', async t => {
  const f = await fixture(t); await baseline(f);
  const g = gate(); f.block = g; f.rows = [row('late', 'Late', later())];
  const count = subscriptions(f).length; advance(t, 60_000);
  await until(() => subscriptions(f).length > count);
  stopped(f); g.release(); f.block = null;
  await spin(); await spin();
  assert.deepEqual(f.events, []); assert.deepEqual(f.app.followers.list().entries, []);
  await baseline(f);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.app.followers.list().entries.map(e => [e.id, e.source]), [['late', 'offline']]);
  stopped(f); const after = subscriptions(f).length;
  advance(t, 120_000); await spin(); assert.equal(subscriptions(f).length, after);
});

test('S5: halt cancels the timer and does not admit an in-flight subscriber', async t => {
  const f = await fixture(t); await baseline(f);
  const g = gate(); f.block = g; f.rows = [row('late', 'Late', later())];
  const count = subscriptions(f).length; advance(t, 60_000);
  await until(() => subscriptions(f).length > count);
  f.app.followers.halt(); g.release(); f.block = null;
  await spin(); advance(t, 180_000); await spin();
  assert.equal(subscriptions(f).length, count + 1);
  assert.deepEqual(f.events, []); assert.deepEqual(f.app.followers.list().entries, []);
});

test('S5: quotaExceeded in subscriber pages stops polling visibly until the next listening period', async t => {
  const f = await fixture(t); await baseline(f);
  f.fail = { url: '/subscriptions' };
  advance(t, 60_000);
  await until(() => f.app.followers.snapshot().youtube.status === 'quota', 'quota status not visible');
  assert.match(f.app.followers.snapshot().youtube.error, /quota exhausted/);
  const count = subscriptions(f).length;
  advance(t, 300_000); await spin(); assert.equal(subscriptions(f).length, count);
  stopped(f); f.fail = null; await baseline(f);
  const next = subscriptions(f).length; advance(t, 60_000);
  await until(() => subscriptions(f).length > next);
});

test('S5: quotaExceeded during the own-account total read also stops polling', async t => {
  const f = await fixture(t); await baseline(f);
  f.fail = { url: '/channels' }; advance(t, 60_000);
  await until(() => f.app.followers.snapshot().youtube.status === 'quota', 'quota from channels was swallowed');
  const count = subscriptions(f).length; advance(t, 180_000); await spin();
  assert.equal(subscriptions(f).length, count);
});

test('S1: slow subscriber polls do not overlap or queue repeated timer reads', async t => {
  const f = await fixture(t); await baseline(f);
  const g = gate(); f.block = g;
  const count = subscriptions(f).length; advance(t, 60_000);
  await until(() => subscriptions(f).length === count + 1);
  advance(t, 300_000); await spin(); assert.equal(subscriptions(f).length, count + 1);
  const sync = f.app.followers.sync('youtube'); await spin(); assert.equal(subscriptions(f).length, count + 1);
  g.release(); f.block = null; await sync;
  assert.equal(subscriptions(f).length, count + 2, 'explicit registry sync is serialized');
  await spin(); assert.equal(subscriptions(f).length, count + 2, 'no timer backlog');
});

test('S1/S5/S6: schema validates the setting and alert catalog/sample work through HTTP', async t => {
  const { app, dir } = await fixture(t, { seconds: undefined, clock: false });
  // Use the actual default rather than an injected interval.
  app.store.config.youtube.subscriberPollSeconds = (await import('../src/store.mjs')).DEFAULT_CONFIG.youtube.subscriberPollSeconds;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const state = await request('/api/state');
  assert.equal(state.body.config.youtube.subscriberPollSeconds, 120);
  assert.deepEqual(state.body.types.ytsub, { platform: 'youtube', icon: 'heart', label: 'Nuevo suscriptor' });
  const sample = await request('/api/alerts/ytsub/sample');
  assert.equal(sample.status, 200);
  assert.equal(sample.body.alert.title, 'Nuevo suscriptor');
  assert.equal(sample.body.alert.text, state.body.samples.ytsub.user);
  assert.equal(sample.body.alert.sub, 'se suscribe al canal');
  const preview = await request('/api/test', 'POST', { type: 'ytsub', target: 'preview' });
  assert.equal(preview.status, 200); assert.equal(preview.body.alert.text, state.body.samples.ytsub.user);
  assert.equal(app.bus.history.length, 0);
  for (const value of [0, 1, 59, 60, 120, 500]) {
    const response = await request('/api/config', 'PUT', { youtube: { subscriberPollSeconds: value } });
    assert.equal(response.status, 200); assert.equal(response.body.config.youtube.subscriberPollSeconds, value);
  }
  const before = await readFile(path.join(dir, 'config.json'), 'utf8');
  for (const [value, message] of [[-1, 'el valor mínimo es 0'], [1.5, 'se esperaba un número entero'], ['60', 'se esperaba un número'], [true, 'se esperaba un número']]) {
    const response = await request('/api/config', 'PUT', { youtube: { subscriberPollSeconds: value } });
    assert.equal(response.status, 400); assert.deepEqual(response.body, { error: `youtube.subscriberPollSeconds: ${message}` });
    assert.equal((await request('/api/config')).body.youtube.subscriberPollSeconds, 500);
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), before);
  }
});

test('S2/S3/S5: exact growth subtracts named subscribers, renders once per poll and uses distinct ids', async t => {
  const f = await fixture(t); await baseline(f);
  assert.deepEqual(f.events, []);
  f.rows = [row('public', 'Public Subscriber', later())]; f.subscriberCount = 104;
  await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [
    ['ytsub', { user: 'Public Subscriber' }], ['ytsubcount', { amount: 3 }],
  ]);
  assert.match(f.events[1].externalId, /^ytsubcount:.+/);
  assert.deepEqual(f.publicAlerts.map(a => [a.type, a.text, a.sub]), [
    ['ytsub', 'Public Subscriber', 'se suscribe al canal'], ['ytsubcount', '+3 suscriptores', 'nuevos en el canal'],
  ]);
  f.subscriberCount = 107;
  await f.app.followers.sync('youtube'); await f.app.followers.sync('youtube');
  const counts = f.events.filter(e => e.type === 'ytsubcount');
  assert.deepEqual(counts.map(e => e.vars.amount), [3, 3]);
  assert.notEqual(counts[0].externalId, counts[1].externalId);
  assert.deepEqual(f.app.followers.list().anonymous.map(a => a.count), [3, 3]);
  const channelReads = f.calls.filter(c => c.url === '/channels');
  assert.ok(channelReads.every(c => c.params.mine === 'true' && c.options.auth === true));
});

test('S2/S3: scheduled growth alerts and a stopped period discards an in-flight count', async t => {
  const f = await fixture(t); await baseline(f);
  f.subscriberCount = 103; let reads = subscriptions(f).length;
  advance(t, 60_000); await until(() => f.events.length === 1, 'scheduled count alert missing');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [['ytsubcount', { amount: 3 }]]);
  assert.ok(subscriptions(f).length > reads);
  const blocked = gate(); f.block = blocked; f.subscriberCount = 105; reads = subscriptions(f).length;
  advance(t, 60_000); await until(() => subscriptions(f).length > reads, 'second poll missing');
  stopped(f); blocked.release(); f.block = null; await spin(); await spin();
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.app.followers.list().anonymous.map(a => a.count), [3]);
  await baseline(f);
  assert.equal(f.events.length, 1, 'restart baseline is silent');
  f.subscriberCount = 106; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => e.vars.amount), [3, 1]);
});

test('S3: each listening baseline is silent even when offline totals grew, and its high-water mark resets', async t => {
  const f = await fixture(t); await f.app.followers.sync('youtube');
  f.subscriberCount = 105; advance(t, 1000); await baseline(f);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.app.followers.list().anonymous.map(a => a.count), [5]);
  f.subscriberCount = 100; await f.app.followers.sync('youtube');
  stopped(f); advance(t, 1000); await baseline(f);
  assert.deepEqual(f.events, []);
  f.subscriberCount = 101; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [['ytsubcount', { amount: 1 }]]);
});

test('S3: falling and recovering totals do not alert; only new highs minus named subscribers do', async t => {
  const f = await fixture(t); await baseline(f);
  for (const total of [95, 100]) { f.subscriberCount = total; await f.app.followers.sync('youtube'); }
  assert.deepEqual(f.events, []);
  f.subscriberCount = 102; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [['ytsubcount', { amount: 2 }]]);
  f.subscriberCount = 97; await f.app.followers.sync('youtube');
  f.rows = [row('named-high', 'Named', later())]; f.subscriberCount = 104;
  await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [
    ['ytsubcount', { amount: 2 }], ['ytsub', { user: 'Named' }], ['ytsubcount', { amount: 1 }],
  ]);
  // Existing registry estimates still use the previous poll, not this alert's high-water mark.
  assert.deepEqual(f.app.followers.list().anonymous.map(a => a.count), [5, 2, 6]);
});

test('S3: counts at or above 1000 on either side never produce a generic alert', async t => {
  const f = await fixture(t); f.subscriberCount = 998; await baseline(f);
  f.subscriberCount = 999; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => e.vars), [{ amount: 1 }]);
  for (const total of [1000, 1001, 999, 998, 999]) {
    f.subscriberCount = total; await f.app.followers.sync('youtube');
  }
  assert.equal(f.events.length, 1);
});

test('S3: hidden or missing totals suppress both adjacent comparisons, then exact reads resume', async t => {
  const f = await fixture(t); await baseline(f);
  f.hiddenCount = true; f.subscriberCount = 103; await f.app.followers.sync('youtube');
  f.hiddenCount = false; f.subscriberCount = 104; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events, []);
  f.subscriberCount = null; await f.app.followers.sync('youtube');
  f.subscriberCount = 105; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events, []);
  f.subscriberCount = 106; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [['ytsubcount', { amount: 1 }]]);
});

test('S3: the system alert leaves metrics, latest, ticker, credits, goals and thanks unduplicated', async t => {
  const f = await fixture(t); await baseline(f);
  const app = f.app, totalEvents = [], onEvent = app.channelTotals.onEvent.bind(app.channelTotals);
  app.channelTotals.onEvent = event => { totalEvents.push(event.type); return onEvent(event); };
  f.rows = [row('seed', 'Seed', later())]; await app.followers.sync('youtube');
  const before = app.engine.widgetState(), pending = app.session.pendingThanks();
  const goal = app.session.goalValue('subscribers', 'youtube');
  const youtubeEvents = app.session.goalValue('events', 'youtube');
  const list = app.followers.list();
  f.subscriberCount = 103; await app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => e.type), ['ytsub', 'ytsubcount']);
  const after = app.engine.widgetState();
  assert.deepEqual(after.totals, before.totals);
  assert.deepEqual(after.latest, before.latest);
  assert.deepEqual(after.recent, before.recent);
  assert.deepEqual(after.credits, before.credits);
  assert.deepEqual(after.goals, before.goals);
  assert.equal(app.session.goalValue('subscribers', 'youtube'), goal);
  assert.equal(app.session.goalValue('events', 'youtube'), youtubeEvents);
  assert.deepEqual(totalEvents, ['ytsub'], 'generic alert must not be passed to channel totals');
  assert.equal(app.session.pendingThanks(), pending);
  assert.deepEqual(app.followers.list().entries, list.entries);
  assert.deepEqual(app.followers.list().anonymous.map(a => [a.count, a.thanked]), [[3, false]]);
  assert.equal(after.thanks.anonymous - before.thanks.anonymous, 3, 'only the pre-existing anonymous estimate feeds thanks');
});

test('S4: disabling the generic alert preserves named alerts and anonymous registry estimates', async t => {
  const f = await fixture(t); await baseline(f);
  await f.app.store.patchConfig({ youtube: { subscriberCountAlert: false } });
  f.rows = [row('off', 'Named while off', later())]; f.subscriberCount = 104;
  await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [['ytsub', { user: 'Named while off' }]]);
  assert.deepEqual(f.app.followers.list().anonymous.map(a => a.count), [3]);
  await f.app.store.patchConfig({ youtube: { subscriberCountAlert: true } });
  f.subscriberCount = 106; await f.app.followers.sync('youtube');
  assert.deepEqual(f.events.map(e => [e.type, e.vars]), [
    ['ytsub', { user: 'Named while off' }], ['ytsubcount', { amount: 2 }],
  ]);
  assert.deepEqual(f.app.followers.list().anonymous.map(a => a.count), [3, 2]);
});

test('S4/S5: HTTP exposes default, catalog and sample, validates and persists the toggle', async t => {
  const { app, dir } = await fixture(t, { clock: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.config.youtube.subscriberCountAlert, true);
  assert.deepEqual(state.body.types.ytsubcount, { platform: 'youtube', icon: 'heart', label: 'Suscriptores sin nombre', system: true });
  assert.deepEqual(state.body.samples.ytsubcount, { amount: 3 });
  const sample = await request('/api/alerts/ytsubcount/sample');
  assert.equal(sample.status, 200);
  assert.deepEqual([sample.body.alert.title, sample.body.alert.text, sample.body.alert.sub], ['Suscriptores sin nombre', '+3 suscriptores', 'nuevos en el canal']);
  const off = await request('/api/config', 'PUT', { youtube: { subscriberCountAlert: false } });
  assert.equal(off.status, 200); assert.equal(off.body.config.youtube.subscriberCountAlert, false);
  const saved = await readFile(path.join(dir, 'config.json'), 'utf8');
  const counters = (await request('/api/status')).body.persistence;
  for (const value of ['false', 0, {}, []]) {
    const response = await request('/api/config', 'PUT', { youtube: { subscriberCountAlert: value } });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'youtube.subscriberCountAlert: se esperaba true o false' });
    assert.equal((await request('/api/config')).body.youtube.subscriberCountAlert, false);
    assert.deepEqual((await request('/api/status')).body.persistence, counters);
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), saved);
  }
  const on = await request('/api/config', 'PUT', { youtube: { subscriberCountAlert: true } });
  assert.equal(on.status, 200); assert.equal(on.body.config.youtube.subscriberCountAlert, true);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')).youtube.subscriberCountAlert, true);
});

test('PRESERVE: Twitch follows still reach the registry, engine, latest, credits and Twitch total', async t => {
  const { app } = await fixture(t, { clock: false });
  app.channelTotals.readers['follows@twitch'] = async () => 7;
  await app.channelTotals.refresh('twitch');
  app.twitch.emitEvent('twitch-id', 'channel.follow', { user_id: 'u', user_name: 'Twitch Viewer', followed_at: '2026-01-01T00:00:00Z' });
  assert.deepEqual(app.followers.list().entries.map(e => [e.id, e.source]), [['u', 'live']]);
  assert.equal(app.bus.history[0].type, 'follow'); assert.equal(app.session.latest().follow.user, 'Twitch Viewer');
  assert.deepEqual(app.session.credits().find(g => g.title === 'Nuevos seguidores').names, ['Twitch Viewer']);
  assert.equal(app.session.goalValue('follows', 'twitch'), 8);
});
