// Goal bars with a platform-reported channel total (#132): Twitch followers/subs and YouTube
// subscribers show the real total plus a persistent correction, never reset by a session cut.
// Synthetic temp dirs and injected readers: never touches real data/ or platforms.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ChannelTotals, isTotalMetric, TOTAL_FILE } from '../src/channel-totals.mjs';
import { PLATFORM_METRICS } from '../src/goals.mjs';
import { Session } from '../src/session.mjs';

const dirs = [];
const tmp = async () => { const dir = await mkdtemp(path.join(tmpdir(), 'totals-132-')); dirs.push(dir); return dir; };
after(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))); });
const fixed = values => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, async () => {
  if (v instanceof Error) throw v;
  return v;
}]));
const make = async (dir, readers, extra = {}) => new ChannelTotals({ dir, readers: fixed(readers), initialDelayMs: 0, ...extra }).load();
const alert = (type, vars = {}) => ({ id: Math.random().toString(36).slice(2), type, at: new Date().toISOString(), vars: { user: 'u', ...vars }, text: type });

test('S5: total metrics are Twitch follows/subs and the new YouTube subscribers; the rest stay per session', () => {
  assert.ok(PLATFORM_METRICS.youtube.includes('subscribers'));
  assert.equal(isTotalMetric('follows', 'twitch'), true);
  assert.equal(isTotalMetric('subs', 'twitch'), true);
  assert.equal(isTotalMetric('subscribers', 'youtube'), true);
  for (const [m, p] of [['bits', 'twitch'], ['raids', 'twitch'], ['events', 'twitch'], ['superchats', 'youtube'], ['members', 'youtube'], ['events', 'youtube']]) {
    assert.equal(isTotalMetric(m, p), false, `${m}@${p}`);
  }
});

test('S2/S7: never-known total is null; after a poll the value is the platform total', async () => {
  const dir = await tmp();
  const t = await make(dir, { 'follows@twitch': 1234, 'subs@twitch': 7, 'subscribers@youtube': 589 });
  assert.equal(t.value('follows@twitch'), null);
  await t.poll();
  assert.equal(t.value('follows@twitch'), 1234);
  assert.equal(t.value('subs@twitch'), 7);
  assert.equal(t.value('subscribers@youtube'), 589);
});

test('S4: an unfollow lowers the value on the next poll', async () => {
  const dir = await tmp();
  let n = 100;
  const t = await new ChannelTotals({ dir, readers: { 'follows@twitch': async () => n }, initialDelayMs: 0 }).load();
  await t.poll();
  n = 98;
  await t.poll();
  assert.equal(t.value('follows@twitch'), 98);
});

test('S3: live events complement the total until the next poll replaces it', async () => {
  const dir = await tmp();
  let n = 10, s = 3;
  const t = await new ChannelTotals({ dir, readers: { 'follows@twitch': async () => n, 'subs@twitch': async () => s }, initialDelayMs: 0 }).load();
  await t.poll();
  t.onEvent(alert('follow'));
  t.onEvent(alert('sub'));
  t.onEvent(alert('resub'));
  t.onEvent(alert('giftsub', { amount: 5 }));
  t.onEvent(alert('cheer', { amount: 100 }));
  assert.equal(t.value('follows@twitch'), 11);
  assert.equal(t.value('subs@twitch'), 9);   // sub +1, resub 0, giftsub +5
  n = 12; s = 8;
  await t.poll();
  assert.equal(t.value('follows@twitch'), 12);
  assert.equal(t.value('subs@twitch'), 8);
});

test('S3: live events before any known total do not invent a value', async () => {
  const t = await make(await tmp(), {});
  t.onEvent(alert('follow'));
  assert.equal(t.value('follows@twitch'), null);
});

test('S7: a failing platform keeps the last known value and reports the error; others still update', async () => {
  const dir = await tmp();
  let fail = false;
  const t = await new ChannelTotals({ dir, initialDelayMs: 0, readers: {
    'follows@twitch': async () => { if (fail) throw new Error('Twitch respondió 500'); return 50; },
    'subscribers@youtube': async () => (fail ? 590 : 589),
  } }).load();
  await t.poll();
  fail = true;
  await t.poll();
  assert.equal(t.value('follows@twitch'), 50);
  assert.equal(t.value('subscribers@youtube'), 590);
  assert.match(t.snapshot()['follows@twitch'].error, /500/);
  assert.equal(t.snapshot()['subscribers@youtube'].error, null);
});

test('S7: a reader without credentials (null) leaves the value untouched and is not an error', async () => {
  const t = await make(await tmp(), { 'follows@twitch': null });
  await t.poll();
  assert.equal(t.value('follows@twitch'), null);
  assert.equal(t.snapshot()['follows@twitch'].error, null);
});

test('S1/S7: the last known total and corrections survive a restart', async () => {
  const dir = await tmp();
  const a = await make(dir, { 'subscribers@youtube': 589 });
  await a.poll();
  a.adjust('subscribers@youtube', -1);
  await a.flush();
  const b = await make(dir, { 'subscribers@youtube': new Error('sin red') });
  assert.equal(b.value('subscribers@youtube'), 588);
  const raw = JSON.parse(await readFile(path.join(dir, TOTAL_FILE), 'utf8'));
  assert.equal(raw.totals['subscribers@youtube'].value, 589);
  assert.equal(raw.offsets['subscribers@youtube'], -1);
});

test('S8: correction is total + persistent offset; set computes the offset against the current total', async () => {
  const dir = await tmp();
  let s = 5;
  const t = await new ChannelTotals({ dir, readers: { 'subs@twitch': async () => s }, initialDelayMs: 0 }).load();
  await t.poll();
  t.adjust('subs@twitch', -1);   // own sub
  assert.equal(t.value('subs@twitch'), 4);
  t.set('subs@twitch', 10);
  assert.equal(t.value('subs@twitch'), 10);
  s = 6;
  await t.poll();
  assert.equal(t.value('subs@twitch'), 11);   // offset +5 kept across polls
});

test('S8: set without a known total is rejected (409) and changes nothing', async () => {
  const dir = await tmp();
  const t = await make(dir, {});
  assert.throws(() => t.set('follows@twitch', 10), err => err.status === 409 && /total/.test(err.message));
  await t.flush();
  assert.equal(t.value('follows@twitch'), null);
  t.adjust('follows@twitch', 2);
  assert.equal(t.value('follows@twitch'), null);   // offset stored, value still unknown
  await t.flush();
  const raw = JSON.parse(await readFile(path.join(dir, TOTAL_FILE), 'utf8'));
  assert.equal(raw.offsets['follows@twitch'], 2);
});

test('S1/S8/S9: session goalValue delegates total bars to the totals and survives a session cut; per-session metrics unchanged', async () => {
  const dir = await tmp();
  // old session offsets for total keys must not apply anymore (S8: reset at migration)
  await writeFile(path.join(dir, 'session-current.json'), JSON.stringify({
    id: 's1', title: 't', startedAt: new Date().toISOString(), events: [], notes: [],
    goalOffsets: { 'follows@twitch': 40, follows: 7, 'bits@twitch': 25 },
  }));
  const session = await new Session(dir).load();
  const totals = await make(dir, { 'follows@twitch': 200 });
  session.channelTotals = totals;
  await totals.poll();
  assert.equal(session.goalValue('follows', 'twitch'), 200);
  assert.equal(session.goalValue('bits', 'twitch'), 25);   // per session keeps its offset
  session.addToGoal('follows', 3, 'twitch');
  assert.equal(session.goalValue('follows', 'twitch'), 203);
  assert.equal(session.data.goalOffsets['follows@twitch'], 40);   // session data not rewritten
  await session.startNew('nuevo');
  assert.equal(session.goalValue('follows', 'twitch'), 203);   // no reset at the cut
  assert.equal(session.goalValue('bits', 'twitch'), 0);
  session.setGoalValue('follows', 250, 'twitch');
  assert.equal(session.goalValue('follows', 'twitch'), 250);
});

test('S3: poll emits change only when a value or error changes', async () => {
  let n = 1;
  const t = await new ChannelTotals({ dir: await tmp(), readers: { 'follows@twitch': async () => n }, initialDelayMs: 0 }).load();
  let changes = 0;
  t.on('change', () => changes++);
  await t.poll();
  await t.poll();
  assert.equal(changes, 1);
  n = 2;
  await t.poll();
  assert.equal(changes, 2);
});

test('S3: refresh(platform) polls only that platform', async () => {
  const calls = [];
  const t = await new ChannelTotals({ dir: await tmp(), initialDelayMs: 0, readers: {
    'follows@twitch': async () => { calls.push('f'); return 1; },
    'subs@twitch': async () => { calls.push('s'); return 1; },
    'subscribers@youtube': async () => { calls.push('y'); return 1; },
  } }).load();
  await t.refresh('youtube');
  assert.deepEqual(calls, ['y']);
});

test('S5: default readers call the documented endpoints and parse total / subscriberCount', async () => {
  const helixCalls = [], apiCalls = [];
  const twitch = { userId: '42', token: { access: 'x' }, helix: async (m, p) => { helixCalls.push(p); return { ok: true, status: 200, data: { total: p.startsWith('/channels/followers') ? 1500 : 12, data: [] } }; } };
  const youtube = { cfg: { channelId: 'UC123', apiKey: 'k' }, token: null, api: async (p, params) => { apiCalls.push([p, params]); return { items: [{ statistics: { subscriberCount: '589', hiddenSubscriberCount: false } }] }; } };
  const t = await new ChannelTotals({ dir: await tmp(), twitch, youtube, initialDelayMs: 0 }).load();
  await t.poll();
  assert.deepEqual(helixCalls.sort(), ['/channels/followers?broadcaster_id=42&first=1', '/subscriptions?broadcaster_id=42&first=1']);
  assert.deepEqual(apiCalls, [['/channels', { part: 'statistics', id: 'UC123' }]]);
  assert.equal(t.value('follows@twitch'), 1500);
  assert.equal(t.value('subs@twitch'), 12);
  assert.equal(t.value('subscribers@youtube'), 589);
});

test('S5/S7: YouTube without channel id uses the connected account; hidden count and missing credentials are unavailable', async () => {
  const calls = [];
  const youtube = { cfg: { channelId: '', apiKey: '' }, token: { access: 'a' }, api: async (p, params, opts) => { calls.push([params, opts]); return { items: [{ statistics: { hiddenSubscriberCount: true } }] }; } };
  const t = await new ChannelTotals({ dir: await tmp(), twitch: {}, youtube, initialDelayMs: 0 }).load();
  await t.poll();
  assert.deepEqual(calls, [[{ part: 'statistics', mine: 'true' }, { auth: true }]]);
  assert.equal(t.value('subscribers@youtube'), null);
  assert.match(t.snapshot()['subscribers@youtube'].error, /oculto/i);
  assert.equal(t.snapshot()['follows@twitch'].error, null);   // no Twitch session: not an error
});

test('S5: Twitch error response is reported with its status and keeps the last value', async () => {
  let ok = true;
  const twitch = { userId: '42', token: { access: 'x' }, helix: async () => (ok ? { ok: true, status: 200, data: { total: 9 } } : { ok: false, status: 403, data: {} }) };
  const t = await new ChannelTotals({ dir: await tmp(), twitch, youtube: {}, initialDelayMs: 0 }).load();
  await t.poll();
  ok = false;
  await t.poll();
  assert.equal(t.value('subs@twitch'), 9);
  assert.match(t.snapshot()['subs@twitch'].error, /403/);
});

test('S5: the config schema accepts a YouTube subscribers bar and rejects subscribers on Twitch', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  const bar = platform => ({ widgets: { goals: [{ id: 'a', title: 'T', visible: true, showMetric: true, css: '', bars: [{ id: 'a-1', platform, metric: 'subscribers', target: 1000, visible: true }] }] } });
  assert.deepEqual(validatePatch(bar('youtube')), []);
  assert.ok(validatePatch(bar('twitch')).length > 0);
});

test('S8: goal set route on a total bar returns 409 before the first read, then sets the corrected value', async () => {
  const { registerGoalsRoutes } = await import('../src/routes/goals.mjs');
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const config = { widgets: { goals: [{ id: 'g', title: 'Subs', visible: true, showMetric: true, css: '', bars: [{ id: 'g-1', platform: 'youtube', metric: 'subscribers', target: 1000, visible: true }] }] } };
  const dir = await tmp();
  const session = await new Session(dir).load();
  let n = null;
  session.channelTotals = await new ChannelTotals({ dir, readers: { 'subscribers@youtube': async () => n }, initialDelayMs: 0 }).load();
  registerGoalsRoutes({ route, store: { config, validateGoals: () => [], save: async () => {} }, session });
  const call = (method, url, body) => { const r = routes.find(x => x.method === method && x.re.test(url)); return r.fn(url.match(r.re).groups, body); };
  await assert.rejects(() => call('POST', '/api/goals/g/bars/g-1/set', { value: 600 }), err => err.status === 409);
  n = 589;
  await session.channelTotals.poll();
  assert.deepEqual(await call('POST', '/api/goals/g/bars/g-1/add', { amount: -1 }), { id: 'g', barId: 'g-1', value: 588, target: 1000 });
  assert.deepEqual(await call('POST', '/api/goals/g/bars/g-1/set', { value: 600 }), { id: 'g', barId: 'g-1', value: 600, target: 1000 });
});

test('S1/S7: a corrupt totals file is copied aside before anything can replace it', async () => {
  const dir = await tmp();
  const body = '{"version":1,"offsets":{"subs@twitch":-1';
  await writeFile(path.join(dir, TOTAL_FILE), body);
  const t = await make(dir, { 'subs@twitch': 5 });
  const { readdir } = await import('node:fs/promises');
  const copies = (await readdir(dir)).filter(f => f.startsWith(`${TOTAL_FILE}.corrupt-`));
  assert.equal(copies.length, 1);
  assert.equal(await readFile(path.join(dir, copies[0]), 'utf8'), body);
  await t.poll(); await t.flush();
  assert.equal(t.value('subs@twitch'), 5);
});
