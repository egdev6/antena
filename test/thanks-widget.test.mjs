// Offline thank-you widget (#129): isolated, synthetic registries and public HTTP/SSE contracts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'antena-thanks-'));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const DAY = 86_400_000;
const stamp = (base, days) => new Date(base + days * DAY).toISOString();
const entry = (id, name, followedAt, source = 'offline', thanked = false) => ({ id, name, followedAt, source, thanked });
const platform = entries => ({ lastSync: null, total: null, totalSource: null, knownIds: ['private-known-id'], entries, anonymous: [] });
async function start(t, { locked = false, archive = true } = {}) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const now = Date.now(), old = stamp(now, -10), cutoff = stamp(now, -5), recent = stamp(now, -2), newest = stamp(now, -1);
  const twitch = platform([
    entry('shared', 'Old', old), entry(null, 'Unknown', null), entry('live', 'Live', recent, 'live'),
    entry('done', 'Done', recent, 'offline', true), entry('t-new', 'Twitch New', newest),
  ]);
  const youtube = platform([entry('shared', 'YouTube Old', old), entry('y-new', 'YouTube New', recent)]);
  youtube.anonymous = [{ at: old, count: 2, thanked: false }, { at: recent, count: 3, thanked: false }, { at: newest, count: 7, thanked: true }];
  if (locked) await mkdir(path.join(dir, 'followers.json'));
  else await writeFile(path.join(dir, 'followers.json'), JSON.stringify({ version: 1, platforms: { twitch, youtube } }));
  if (archive) {
    await mkdir(path.join(dir, 'sessions'));
    const meta = { id: 'prior', title: 'Previous', startedAt: stamp(now, -6), endedAt: cutoff, events: 0 };
    await writeFile(path.join(dir, 'sessions', 'prior.json'), JSON.stringify({ ...meta, events: [], notes: [], goalOffsets: {} }));
    await writeFile(path.join(dir, 'sessions', 'prior.meta.json'), JSON.stringify(meta));
  }
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function call(method, url, body) {
    const response = await fetch(base + url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: response.status, body: await response.json() };
  }
  t.after(async () => { app.timers.stop(); await app.closeHttp(); });
  return { app, base, call, dir, now, old, recent, newest, cutoff };
}
async function stream(base) {
  const ctrl = new AbortController();
  const response = await fetch(base + '/api/stream?client=widget', { signal: ctrl.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function next(name, predicate = () => true) {
    for (;;) {
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
        if (event === name && data) { const parsed = JSON.parse(data); if (predicate(parsed)) return parsed; }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  return { next, close: () => ctrl.abort() };
}

test('S1/S2/S5: route, registered source and slim initial/change widget events', async t => {
  const { base, call } = await start(t);
  const page = await fetch(base + '/widget/thanks');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /\/widgets\/widget\.js/);
  assert.ok((await call('GET', '/api/state')).body.widgetNames.includes('thanks'));
  assert.ok((await call('GET', '/api/sources')).body.sources.some(s => s.id === 'thanks' && s.path === '/widget/thanks'));
  const s = await stream(base); t.after(s.close);
  const initial = await s.next('widgets');
  assert.deepEqual(Object.keys(initial.thanks).sort(), ['anonymous', 'names']);
  assert.ok(initial.thanks.names.length);
  for (const name of initial.thanks.names) assert.deepEqual(Object.keys(name).sort(), ['name', 'platform']);
  assert.doesNotMatch(JSON.stringify(initial.thanks), /private-known-id|shared|followedAt|error|owner|knownIds/);
  const done = await call('POST', '/api/followers/thank', { entries: [{ platform: 'twitch', id: 't-new' }] });
  assert.equal(done.status, 200);
  const changed = await s.next('widgets', d => d.thanks && !d.thanks.names.some(n => n.name === 'Twitch New'));
  assert.ok(changed.thanks.names.some(n => n.name === 'YouTube New'));
});

test('S1/S4: filters select only pending offline followers, retain unknown dates and cap most recent chronologically', async t => {
  const { call } = await start(t);
  const update = async thanks => { const r = await call('PUT', '/api/widgets', { thanks }); assert.equal(r.status, 200); };
  const read = async () => (await call('GET', '/api/widgets')).body.thanks;
  await update({ platforms: ['twitch', 'youtube'], window: 'all', maxNames: 20, showAnonymous: true });
  const all = await read();
  assert.deepEqual(all.names.map(n => n.name), ['Unknown', 'Old', 'YouTube Old', 'YouTube New', 'Twitch New']);
  assert.equal(all.anonymous, 5);
  await update({ platforms: ['youtube'] });
  assert.deepEqual(await read(), { names: [{ name: 'YouTube Old', platform: 'youtube' }, { name: 'YouTube New', platform: 'youtube' }], anonymous: 5 });
  await update({ platforms: ['twitch', 'youtube'], window: 'lastStream' });
  assert.deepEqual(await read(), { names: [{ name: 'Unknown', platform: 'twitch' }, { name: 'YouTube New', platform: 'youtube' }, { name: 'Twitch New', platform: 'twitch' }], anonymous: 3 });
  await update({ window: 'days', days: 3, maxNames: 2 });
  assert.deepEqual(await read(), { names: [{ name: 'YouTube New', platform: 'youtube' }, { name: 'Twitch New', platform: 'twitch' }], anonymous: 3 });
  await update({ showAnonymous: false, maxNames: 20 });
  assert.deepEqual(await read(), { names: [{ name: 'Unknown', platform: 'twitch' }, { name: 'YouTube New', platform: 'youtube' }, { name: 'Twitch New', platform: 'twitch' }], anonymous: 0 });
  await update({ platforms: ['twitch'], showAnonymous: true });
  assert.equal((await read()).anonymous, 0);
});

test('S3: shown exposes the exact private selection for the panel without expanding the widget snapshot', async t => {
  const { call, recent } = await start(t);
  assert.equal((await call('PUT', '/api/widgets', { thanks: { window: 'all', maxNames: 1, platforms: ['youtube'], showAnonymous: true } })).status, 200);
  const widget = (await call('GET', '/api/widgets')).body.thanks;
  const followers = (await call('GET', '/api/followers?pending=true&shown=true')).body;
  assert.deepEqual(widget.names, followers.shown.entries.map(({ name, platform }) => ({ name, platform })));
  assert.deepEqual(followers.shown.entries.map(e => e.id), ['y-new']);
  assert.equal(widget.anonymous, followers.shown.anonymous.reduce((sum, a) => sum + a.count, 0));
  assert.ok(followers.shown.anonymous.some(a => a.at === recent));
  assert.deepEqual(Object.keys(widget).sort(), ['anonymous', 'names']);
  assert.deepEqual((await call('GET', '/api/followers?pending=true')).body.shown, undefined);
});

test('S4: lastStream without archives has no cutoff, and a new cut refreshes it', async t => {
  const { call } = await start(t, { archive: false });
  assert.equal((await call('PUT', '/api/widgets', { thanks: { window: 'lastStream', maxNames: 20 } })).status, 200);
  const before = (await call('GET', '/api/widgets')).body.thanks;
  assert.ok(before.names.some(n => n.name === 'Old'));
  assert.equal((await call('POST', '/api/session/new', { title: 'New stream' })).status, 200);
  let after;
  for (let i = 0; i < 50; i++) {
    after = (await call('GET', '/api/widgets')).body.thanks;
    if (!after.names.some(n => n.name === 'Old')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(after.names.map(n => n.name), ['Unknown']);
  assert.equal(after.anonymous, 0);
});

test('S4: thanks config is validated before any widget settings are changed', async t => {
  const { call, dir } = await start(t);
  const initial = (await call('GET', '/api/widgets')).body.widgets;
  assert.deepEqual(Object.keys(initial.thanks).sort(), ['css', 'days', 'intervalSec', 'maxNames', 'platforms', 'showAnonymous', 'title', 'window']);
  const bytes = await readFile(path.join(dir, 'config.json'), 'utf8');
  for (const thanks of [null, [], { platforms: ['kick'] }, { window: 'other' }, { days: -1 }, { maxNames: 0 }, { intervalSec: 0 }, { showAnonymous: 'yes' }, { title: 4 }, { css: false }]) {
    const r = await call('PUT', '/api/widgets', { thanks, ticker: { label: 'must not change' } });
    assert.equal(r.status, 400, JSON.stringify(thanks)); assert.equal(typeof r.body.error, 'string');
    assert.deepEqual((await call('GET', '/api/widgets')).body.widgets, initial);
    assert.equal(await readFile(path.join(dir, 'config.json'), 'utf8'), bytes);
  }
});

test('S3: exact selections isolate same ids across platforms, id-less names and anonymous timestamps; persist and preserve legacy forms', async t => {
  const { call, dir, recent, old } = await start(t);
  const select = { entries: [{ platform: 'twitch', id: 'shared' }, { platform: 'twitch', name: 'Unknown' }], anonymous: [recent] };
  assert.equal((await call('POST', '/api/followers/thank', select)).status, 200);
  let list = (await call('GET', '/api/followers?pending=true')).body;
  assert.deepEqual(list.entries.map(e => [e.platform, e.name]), [['twitch', 'Live'], ['twitch', 'Twitch New'], ['youtube', 'YouTube Old'], ['youtube', 'YouTube New']]);
  assert.deepEqual(list.anonymous, [{ at: old, count: 2, thanked: false }]);
  const restored = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => restored.server.listen(0, '127.0.0.1', resolve));
  t.after(() => restored.closeHttp());
  const persisted = await fetch(`http://127.0.0.1:${restored.server.address().port}/api/followers?pending=true`).then(r => r.json());
  assert.deepEqual(persisted.entries.map(e => [e.platform, e.name]), list.entries.map(e => [e.platform, e.name]));
  assert.deepEqual(persisted.anonymous, list.anonymous);
  assert.equal((await call('POST', '/api/followers/thank', { ids: ['shared'] })).status, 200);
  list = (await call('GET', '/api/followers?pending=true')).body;
  assert.ok(!list.entries.some(e => e.name === 'YouTube Old'));
  assert.equal(list.anonymous.length, 1);
  assert.equal((await call('POST', '/api/followers/thank', { all: true })).status, 200);
  list = (await call('GET', '/api/followers?pending=true')).body;
  assert.deepEqual(list.entries, []); assert.deepEqual(list.anonymous, []);
});

test('S3: malformed selections are 400 and leave the list, counters and bytes unchanged; read-only is 503', async t => {
  const { call, dir } = await start(t);
  const before = (await call('GET', '/api/followers')).body;
  const bytes = await readFile(path.join(dir, 'followers.json'), 'utf8');
  for (const body of [
    { entries: 'x' }, { entries: [null] }, { entries: [{ platform: 'kick', id: 'x' }] },
    { entries: [{ platform: 'twitch', id: '' }] }, { entries: [{ platform: 'twitch', id: 'x', name: 'X' }] },
    { entries: [{ platform: 'youtube', name: ' ' }] }, { entries: [{ platform: 'twitch', id: 'x', extra: true }] },
    { anonymous: ['not-a-date'] }, { anonymous: [3] }, { entries: [], all: true }, { entries: [], unexpected: true },
  ]) {
    const r = await call('POST', '/api/followers/thank', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.body, { error: 'Indica «entries» y/o «anonymous» con selecciones válidas.' });
    assert.deepEqual((await call('GET', '/api/followers')).body, before);
    assert.equal(await readFile(path.join(dir, 'followers.json'), 'utf8'), bytes);
  }
  const locked = await start(t, { locked: true });
  const denied = await locked.call('POST', '/api/followers/thank', { entries: [{ platform: 'twitch', id: 'x' }] });
  assert.equal(denied.status, 503); assert.match(denied.body.error, /No se puede leer/);
});
