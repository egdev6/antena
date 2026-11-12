// #129 B2 boundary (verifier mwe0am4h-n-9nof): the last-stream cutoff must consider every archive,
// not only the first 50 returned by the id-sorted, capped Session.list().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'thanks-cutoff-51-'));
assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');

test('S4/B2: newest archived cutoff includes archives beyond the first 50 id-sorted entries', async t => {
  const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });
  const twitch = blank(), youtube = blank();
  twitch.entries = [{ id: 'old-follower', name: 'Before', followedAt: '2026-02-01T00:00:00.000Z', source: 'offline', thanked: false }];
  youtube.entries = [{ id: 'new-follower', name: 'After', followedAt: '2026-03-01T00:00:00.000Z', source: 'offline', thanked: false }];
  await writeFile(path.join(root, 'followers.json'), JSON.stringify({ version: 1, platforms: { twitch, youtube } }));
  await mkdir(path.join(root, 'sessions'));
  for (let i = 0; i < 50; i++) {
    const id = 'z-old-' + String(i).padStart(2, '0');
    await writeFile(path.join(root, 'sessions', id + '.json'), JSON.stringify({ id, title: 'Old', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-02T00:00:00Z', events: [], notes: [], goalOffsets: {} }));
  }
  await writeFile(path.join(root, 'sessions', 'a-new.json'), JSON.stringify({ id: 'a-new', title: 'Newest', startedAt: '2026-02-10T00:00:00Z', events: [], notes: [], goalOffsets: {} }));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.timers.stop(); await app.closeHttp(); });
  await app.store.patchConfig({ widgets: { thanks: { window: 'lastStream' } } });
  // the history view keeps its 50-entry listing contract
  assert.equal((await app.session.list()).length, 50);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/widgets`);
  assert.equal(response.status, 200);
  const widget = await response.json();
  assert.deepEqual(widget.thanks.names, [{ name: 'After', platform: 'youtube' }]);
});
