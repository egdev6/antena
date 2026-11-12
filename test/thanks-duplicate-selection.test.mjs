// #129 verifier finding (mwe29v49-r-yswx): a followers.json with same-identity duplicates (e.g. hand-edited)
// must not let an onlyShown thank also mark a hidden duplicate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'thanks-duplicate-'));
assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });

async function start(t, platforms) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const file = path.join(dir, 'followers.json');
  await writeFile(file, JSON.stringify({ version: 1, platforms }));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.timers.stop(); await app.closeHttp(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, route, body) => {
    const r = await fetch(base + route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: r.status, body: await r.json() };
  };
  return { file, call };
}

test('S3: onlyShown never thanks a hidden record with the same id', async t => {
  const twitch = blank(), youtube = blank();
  const row = (name, followedAt) => ({ id: 'same', name, followedAt, source: 'offline', thanked: false });
  twitch.entries = [row('Hidden', '2025-01-01T00:00:00.000Z'), row('Shown', '2025-02-01T00:00:00.000Z')];
  const f = await start(t, { twitch, youtube });
  assert.equal((await f.call('PUT', '/api/widgets', { thanks: { window: 'all', platforms: ['twitch'], maxNames: 1 } })).status, 200);
  assert.deepEqual((await f.call('GET', '/api/followers?pending=true&shown=true')).body.shown.entries.map(e => e.name), ['Shown']);
  const before = sha(await readFile(f.file));
  const r = await f.call('POST', '/api/followers/thank', { entries: [{ platform: 'twitch', id: 'same' }], onlyShown: true });
  assert.equal(r.status, 409);
  assert.equal(sha(await readFile(f.file)), before);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(saved.platforms.twitch.entries.map(e => e.thanked), [false, false]);
});

test('S3: onlyShown never thanks a hidden anonymous record with the same timestamp', async t => {
  const twitch = blank(), youtube = blank();
  const at = '2025-02-01T00:00:00.000Z';
  youtube.anonymous = [{ at, count: 2, thanked: false }, { at, count: 1, thanked: false }];
  const f = await start(t, { twitch, youtube });
  // both records are inside the window, so both are shown: the exact selection is unambiguous and accepted
  assert.equal((await f.call('PUT', '/api/widgets', { thanks: { window: 'all', platforms: ['youtube'], showAnonymous: true } })).status, 200);
  const ok = await f.call('POST', '/api/followers/thank', { anonymous: [at], onlyShown: true });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(saved.platforms.youtube.anonymous.map(a => a.thanked), [true, true]);
});

test('S3: a unique shown record is still thanked with onlyShown, without touching others', async t => {
  const twitch = blank(), youtube = blank();
  twitch.entries = [
    { id: 'a', name: 'Old', followedAt: '2025-01-01T00:00:00.000Z', source: 'offline', thanked: false },
    { id: 'b', name: 'New', followedAt: '2025-02-01T00:00:00.000Z', source: 'offline', thanked: false },
  ];
  const f = await start(t, { twitch, youtube });
  assert.equal((await f.call('PUT', '/api/widgets', { thanks: { window: 'all', platforms: ['twitch'], maxNames: 1 } })).status, 200);
  const r = await f.call('POST', '/api/followers/thank', { entries: [{ platform: 'twitch', id: 'b' }], onlyShown: true });
  assert.equal(r.status, 200);
  const saved = JSON.parse(await readFile(f.file, 'utf8'));
  assert.deepEqual(saved.platforms.twitch.entries.map(e => [e.id, e.thanked]), [['a', false], ['b', true]]);
});
