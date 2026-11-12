// Independent verification regressions for #128 (YouTube baseline, follow date, channel mismatch).
// No server import: every registry and total file lives under the system temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FollowerRegistry } from '../src/followers.mjs';
import { ChannelTotals } from '../src/channel-totals.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'followers-independent-'));
const dir = () => mkdtemp(path.join(root, 'case-'));
const sub = id => ({ subscriberSnippet: { channelId: id, title: `viewer-${id}` } });

test('S1/S2/S6: an incomplete YouTube baseline does not turn old followers into new ones', async () => {
  const d = await dir(); let ids = Array.from({ length: 201 }, (_, i) => String(i)), time = 0;
  const youtube = { token: { access: 'x' }, api: async (_url, params) => {
    const offset = Number(params.pageToken || 0), items = ids.slice(offset, offset + 50).map(sub);
    return { items, ...(offset + 50 < ids.length ? { nextPageToken: String(offset + 50) } : {}) };
  } };
  const r = await new FollowerRegistry({ dir: d, youtube, now: () => Date.parse('2026-01-01T00:00:00.000Z') + time }).load();
  await r.sync('youtube'); await r.flush();
  ids = ids.slice(1); time += 60000; await r.sync('youtube'); await r.flush();
  assert.deepEqual(r.list().entries, []);
});

test('S1: the YouTube follow date is the subscription date rather than the sync date', async () => {
  const d = await dir(), actualDate = '2026-01-01T00:00:17.000Z'; let fresh = false, time = Date.parse('2026-01-01T00:00:00.000Z');
  const youtube = { token: { access: 'x' }, api: async (_url, params) => ({ items: fresh ? [{
    ...sub('new'), ...(String(params.part).split(',').includes('snippet') ? { snippet: { publishedAt: actualDate } } : {}),
  }] : [] }) };
  const r = await new FollowerRegistry({ dir: d, youtube, now: () => time }).load();
  await r.sync('youtube'); fresh = true; time += 60000; await r.sync('youtube'); await r.flush();
  assert.equal(r.list().entries[0].followedAt, actualDate);
});

test('S6: anonymous YouTube growth cannot come from an unrelated configured channel', async () => {
  const d = await dir(); let otherTotal = 100;
  const youtube = { token: { access: 'x' }, cfg: { channelId: 'other-channel', apiKey: 'x' }, api: async (endpoint, params) => {
    if (endpoint === '/subscriptions') return { items: [] };
    return { items: [{ statistics: { subscriberCount: String(params.mine ? 20 : otherTotal) } }] };
  } };
  const totals = await new ChannelTotals({ dir: d, youtube }).load();
  const r = await new FollowerRegistry({ dir: d, youtube, channelTotals: totals }).load();
  await totals.refresh('youtube'); await r.sync('youtube'); otherTotal += 3;
  await totals.refresh('youtube'); await r.sync('youtube'); await r.flush(); await totals.flush();
  assert.deepEqual(r.list().anonymous, []);
});
