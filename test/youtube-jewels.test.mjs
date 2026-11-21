// Jewels (#288): documented synthetic liveChatMessages and isolated application state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { YouTube } from '../src/youtube.mjs';
import { Engine } from '../src/engine.mjs';
import { Bus } from '../src/bus.mjs';
import { Session } from '../src/session.mjs';
import { createApp } from '../src/server.mjs';

const gift = (id, comboCount, { owner = false, authorId = 'UC-viewer', user = 'Ana' } = {}) => ({
  id,
  snippet: { type: 'giftEvent', authorChannelId: authorId, publishedAt: '2026-10-12T12:00:00Z',
    giftDetails: { jewelsAmount: 25, giftName: 'Rosa', giftUrl: 'https://example.test/rosa.png',
      giftDuration: { seconds: '3', nanos: 0 }, hasVisualEffect: true, comboCount, altText: 'Una rosa', language: 'es' } },
  authorDetails: { channelId: authorId, displayName: user, isChatOwner: owner },
});

function pollFixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-10-12T12:00:00Z') });
  const store = { config: { youtube: { apiKey: 'fake', channelId: 'UC-owner', pollSeconds: 8 }, alerts: {}, overlay: {}, filters: {} }, secrets: {} };
  const youtube = new YouTube(store, () => {}), bus = new Bus();
  const session = new Session(tmpdir(), { writer: async () => {} });
  const engine = new Engine({ store, bus, session, youtube, meld: {}, log: () => {} });
  const events = [], chats = [];
  youtube.on('event', e => { events.push(e); engine.handleEvent(e); });
  youtube.on('chat', c => chats.push(c));
  youtube.running = true; youtube.primed = false; youtube.status.liveChatId = 'chat';
  async function poll(items) {
    clearTimeout(youtube.timer);
    youtube.api = async () => ({ items, nextPageToken: 'next', pollingIntervalMillis: 8000 });
    await youtube.poll();
    clearTimeout(youtube.timer); // tests drive polls explicitly; the production cadence is still 8 s
  }
  t.after(async () => {
    await youtube.quiescePoll();
    await session.flush();
    t.mock.timers.reset();
  });
  return { youtube, bus, session, engine, events, chats, poll };
}

const tick = (t, ms) => t.mock.timers.tick(ms);

test('S1/S3/S5: a single gift waits through a polling interval plus five quiet seconds and records one alert', async t => {
  const f = pollFixture(t);
  await f.poll([gift('historical', 0)]);
  await f.poll([gift('historical', 2), gift('single', 0)]);
  assert.deepEqual(f.bus.history, []);
  tick(t, 12_999); assert.deepEqual(f.bus.history, []);
  tick(t, 1);
  assert.equal(f.bus.history.length, 1);
  const a = f.bus.history[0];
  assert.deepEqual([a.type, a.platform, a.text, a.sub], ['jewels', 'youtube', 'Ana', 'Rosa ×1 · 25 Jewels']);
  assert.deepEqual([a.vars.giftName, a.vars.giftUrl, a.vars.altText, a.vars.jewelsAmount, a.vars.comboCount, a.vars.count, a.vars.amount],
    ['Rosa', 'https://example.test/rosa.png', 'Una rosa', 25, 0, 1, 25]);
  assert.equal(f.session.timeline().length, 1);
  assert.equal(f.session.timeline()[0].type, 'jewels');
  assert.equal(f.session.totals().events, 1);
  assert.equal(f.session.totals().superchats, 0, 'Jewels are not euros');
  assert.equal(f.session.goalValue('events', 'youtube'), 1);
  assert.deepEqual(f.session.credits().find(g => g.title === 'Regalos de YouTube').names, ['Ana']);
});

test('S3/S5: updates across polls coalesce once with the final count and never replay after ten minutes', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('combo', 1)]);
  tick(t, 8000); await f.poll([gift('combo', 2)]);
  tick(t, 8000); await f.poll([gift('combo', 3)]);
  assert.equal(f.bus.history.length, 0);
  tick(t, 12_999); assert.equal(f.bus.history.length, 0);
  tick(t, 1);
  assert.equal(f.events.length, 1);
  assert.deepEqual([f.events[0].externalId, f.events[0].senderId], ['yt:combo', 'UC-viewer']);
  assert.deepEqual([f.bus.history[0].sub, f.bus.history[0].vars.comboCount, f.bus.history[0].vars.amount], ['Rosa ×3 · 75 Jewels', 3, 75]);
  tick(t, 11 * 60_000);
  await f.poll([gift('combo', 4)]);
  tick(t, 20_000);
  assert.equal(f.events.length, 1);
  assert.equal(f.bus.history.length, 1);
  assert.equal(f.session.timeline().length, 1);
});

test('S7: the owner never alerts by owner flag or channel identity; ordinary gifts still do', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('viewer', 0), gift('owner-flag', 1, { owner: true }), gift('owner-id', 0, { authorId: 'UC-owner' })]);
  tick(t, 13_000);
  assert.deepEqual(f.bus.history.map(a => a.text), ['Ana']);
  assert.deepEqual(f.events.map(e => e.externalId), ['yt:viewer']);
  assert.equal(f.session.timeline().length, 1);
});

test('PRESERVE: ordinary Super Chat and text chat keep their existing immediate behavior and deduplication', async t => {
  const f = pollFixture(t); await f.poll([]);
  const sc = { id: 'sc', snippet: { type: 'superChatEvent', superChatDetails: { amountMicros: '5000000', amountDisplayString: '5 €', currency: 'EUR', userComment: 'hola' } }, authorDetails: { displayName: 'Bea' } };
  const chat = { id: 'chat', snippet: { type: 'textMessageEvent', textMessageDetails: { messageText: 'hola' } }, authorDetails: { displayName: 'Bea' } };
  await f.poll([sc, chat]); await f.poll([sc]);
  assert.deepEqual(f.bus.history.map(a => [a.type, a.text, a.sub]), [['superchat', 'Bea', '5 € · hola']]);
  assert.deepEqual(f.chats.map(c => [c.user, c.text]), [['Bea', 'hola']]);
  assert.equal(f.session.totals().superchats, 5);
});

test('S7: catalog, editor fields, variations, preview and simulation work over HTTP', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-jewels-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  t.after(async () => { await app.session.flush(); await app.closeHttp(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (url, method = 'GET', body) => {
    const res = await fetch(base + url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  const state = await request('/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.types.jewels, { platform: 'youtube', icon: 'gift', label: 'Regalo de YouTube' });
  assert.equal(state.body.samples.jewels.amount, 75);
  const sample = await request('/api/alerts/jewels/sample');
  assert.equal(sample.status, 200);
  assert.deepEqual([sample.body.alert.text, sample.body.alert.sub], ['Ana', 'Rosa ×3 · 75 Jewels']);
  const edit = await request('/api/alerts/jewels', 'PUT', { title: 'Gracias', text: '{user}', sub: '{giftName} ×{count} · {amount} Jewels', ttsEnabled: true, ttsTemplate: '{user} regala {giftName} ×{count} por {amount} Jewels' });
  assert.equal(edit.status, 200); assert.equal(edit.body.config.title, 'Gracias');
  const variation = await request('/api/alerts/jewels/variations', 'POST', { name: 'Grande', conditions: { minAmount: 50 }, overrides: { title: 'Gran regalo' } });
  assert.equal(variation.status, 200);
  const preview = await request('/api/test', 'POST', { type: 'jewels', target: 'preview', variationId: variation.body.variation.id });
  assert.equal(preview.status, 200); assert.equal(preview.body.alert.title, 'Gran regalo');
  assert.equal(preview.body.alert.tts, 'Ana regala Rosa ×3 por 50 Jewels');
  assert.equal(app.bus.history.length, 0); assert.equal(app.session.timeline().length, 0);
  const simulated = await request('/api/simulate', 'POST', { type: 'jewels' });
  assert.equal(simulated.status, 200); assert.equal(simulated.body.ok, true);
  assert.equal(simulated.body.alert.title, 'Gran regalo'); assert.equal(simulated.body.alert.sub, 'Rosa ×3 · 75 Jewels');
  assert.equal(app.bus.history.length, 1); assert.equal(app.session.timeline().length, 1);
  assert.equal(app.session.totals().superchats, 0); assert.equal(app.session.totals().events, 1);
  const iconView = await readFile(new URL('../app/src/panel/views/Apariencia.tsx', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../app/src/panel/views/Editor.tsx', import.meta.url), 'utf8');
  assert.match(iconView, /\['jewels', 'gift'\]/);
  assert.match(editor, /const AMOUNT_TYPES = \[[^\n]*'jewels'/);
});

test('S3/S5: two combos in parallel each alert once with their own total', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('a', 1), gift('b', 1, { user: 'Bea' })]);
  tick(t, 8000); await f.poll([gift('a', 5), gift('b', 2, { user: 'Bea' })]);
  tick(t, 13_000);
  assert.deepEqual(f.bus.history.map(a => [a.text, a.sub]).sort(), [['Ana', 'Rosa ×5 · 125 Jewels'], ['Bea', 'Rosa ×2 · 50 Jewels']]);
});

test('S5: the same id twice in one poll and an update after the alert stay one alert', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('a', 1), gift('a', 2)]); tick(t, 13_000);
  assert.equal(f.bus.history.length, 1); assert.equal(f.bus.history[0].vars.count, 2);
  await f.poll([gift('a', 3)]); tick(t, 30_000);
  assert.equal(f.events.length, 1);
});

test('S3: an update restarts the quiet window', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('a', 1)]); tick(t, 12_000); await f.poll([gift('a', 2)]);
  tick(t, 12_999); assert.equal(f.bus.history.length, 0);
  tick(t, 1); assert.equal(f.bus.history.length, 1);
});

test('S3: a failed poll during a combo neither loses nor duplicates it', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('a', 1)]);
  f.youtube.api = async () => { throw Object.assign(new Error('x'), { reason: 'backendError' }); };
  await f.youtube.poll(); clearTimeout(f.youtube.timer);
  tick(t, 13_000); assert.equal(f.bus.history.length, 1);
});

test('S7: an owner update mid-combo cancels the pending alert', async t => {
  const f = pollFixture(t); await f.poll([]);
  await f.poll([gift('a', 1)]); await f.poll([gift('a', 2, { owner: true })]);
  tick(t, 30_000); assert.equal(f.bus.history.length, 0);
});
