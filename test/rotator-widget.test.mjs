// Rotating messages widget: pure rotation order and timing, config contract and registration.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRotation, rotatorTiming } from '../public/widgets/rotator-core.js';

const root = await mkdtemp(path.join(tmpdir(), 'antena-rotator-'));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const take = (rotation, n) => Array.from({ length: n }, () => rotation.next());

test('sequential order shows the messages in their list order and loops', () => {
  assert.deepEqual(take(createRotation(['a', 'b', 'c'], 'sequential'), 7), ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
});

test('random order never repeats a message twice in a row and shows all before repeating', () => {
  for (let seed = 1; seed <= 200; seed++) {
    let x = seed;   // deterministic pseudo-random source per run
    const random = () => (x = (x * 16807) % 2147483647) / 2147483647;
    const items = ['a', 'b', 'c', 'd'];
    const shown = take(createRotation(items, 'random', random), 40);
    for (let i = 1; i < shown.length; i++) assert.notEqual(shown[i], shown[i - 1], `seed ${seed}: same message twice in a row at ${i}`);
    for (let i = 0; i < shown.length; i += items.length)
      assert.deepEqual([...shown.slice(i, i + items.length)].sort(), items, `seed ${seed}: round ${i / items.length} shows every message once`);
  }
});

test('random order with two messages alternates and with one message repeats it', () => {
  const two = take(createRotation(['a', 'b'], 'random', Math.random), 10);
  for (let i = 1; i < two.length; i++) assert.notEqual(two[i], two[i - 1]);
  assert.deepEqual(take(createRotation(['solo'], 'random'), 3), ['solo', 'solo', 'solo']);
  assert.deepEqual(take(createRotation([], 'sequential'), 2), [null, null]);
});

test('timing clamps the visible time to the interval and falls back to defaults', () => {
  assert.deepEqual(rotatorTiming({ intervalSec: 240, durationSec: 12 }), { intervalMs: 240000, durationMs: 12000 });
  assert.deepEqual(rotatorTiming({ intervalSec: 10, durationSec: 30 }), { intervalMs: 10000, durationMs: 10000 });
  assert.deepEqual(rotatorTiming({}), { intervalMs: 240000, durationMs: 12000 });
  assert.deepEqual(rotatorTiming({ intervalSec: 240, durationSec: 12 }, { demo: true }), { intervalMs: 5000, durationMs: 4000 });
});

async function start(t) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const put = body => fetch(base + '/api/widgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, put };
}

test('the rotator config has defaults, saves valid changes and rejects invalid ones unchanged', async t => {
  const { base, put } = await start(t);
  const initial = (await (await fetch(base + '/api/widgets')).json()).widgets.rotator;
  assert.deepEqual(initial, { label: 'Mensaje', messages: [], intervalSec: 240, durationSec: 12, order: 'sequential', css: '' });

  const messages = [{ id: 'm1', text: 'Únete al Discord: !discord' }, { id: 'm2', text: 'Todas mis redes en egdev.es' }];
  const saved = await put({ rotator: { messages, intervalSec: 180, order: 'random' } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).widgets.rotator, { ...initial, messages, intervalSec: 180, order: 'random' });

  const reordered = [messages[1], messages[0]];
  assert.deepEqual((await (await put({ rotator: { messages: reordered } })).json()).widgets.rotator.messages, reordered, 'the list is replaced, not merged');

  const before = (await (await fetch(base + '/api/widgets')).json()).widgets.rotator;
  for (const bad of [{ order: 'shuffle' }, { intervalSec: 2 }, { durationSec: 0 }, { messages: [{ id: 'x', text: 5 }] },
    { messages: Array.from({ length: 51 }, (_, i) => ({ id: 'm' + i, text: 't' })) }]) {
    const r = await put({ rotator: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((await r.json()).error, /rotator/);
  }
  assert.deepEqual((await (await fetch(base + '/api/widgets')).json()).widgets.rotator, before, 'rejected changes leave the config unchanged');
});

test('the rotator widget is served and listed as a browser source', async t => {
  const { base } = await start(t);
  const page = await fetch(base + '/widget/rotator');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /@layer egdev[\s\S]*rotator-core\.js/);
  const { sources } = await (await fetch(base + '/api/sources')).json();
  assert.ok(sources.some(s => s.id === 'rotator' && s.url === base + '/widget/rotator'), 'listed in the browser sources');
  const overlaySource = await readFile(new URL('../src/custom-overlays.mjs', import.meta.url), 'utf8');
  assert.match(overlaySource, /rotator: \[\]/, 'custom overlays can embed the rotator as a slot');
});
