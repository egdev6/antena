// Social bar widget: config contract, registration and the brand icon set.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SOCIAL_LOGOS, SOCIAL_NAMES } from '../public/social-icons.js';
import { schemaAt } from '../src/config-schema.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'antena-socials-'));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const PLATFORMS = ['twitch', 'youtube', 'x', 'instagram', 'tiktok', 'github', 'discord', 'kick', 'linkedin', 'web'];

async function start(t) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const put = body => fetch(base + '/api/widgets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async () => (await (await fetch(base + '/api/widgets')).json()).widgets.socials;
  return { base, put, get };
}

test('every social platform has a name and a logo, and the config accepts exactly those platforms', () => {
  assert.deepEqual(Object.keys(SOCIAL_LOGOS), PLATFORMS);
  for (const p of PLATFORMS) {
    assert.equal(typeof SOCIAL_NAMES[p], 'string', p);
    assert.match(SOCIAL_LOGOS[p].viewBox, /^\d+ \d+ \d+ \d+$/, p);
    assert.ok(SOCIAL_LOGOS[p].paths.length > 0, p);
  }
  assert.deepEqual(schemaAt('widgets.socials.items').item.platform.values, PLATFORMS);
});

test('the social bar config has defaults, saves valid changes and rejects invalid ones unchanged', async t => {
  const { put, get } = await start(t);
  assert.deepEqual(await get(), { label: '', items: [], css: '' });

  const items = [{ id: 's1', platform: 'x', handle: '@egdev6' }, { id: 's2', platform: 'github', handle: 'egdev6' }];
  const saved = await put({ socials: { label: 'Sígueme', items } });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).widgets.socials, { label: 'Sígueme', items, css: '' });
  assert.deepEqual((await (await put({ socials: { items: [items[1]] } })).json()).widgets.socials.items, [items[1]], 'the list is replaced, not merged');

  const before = await get();
  for (const bad of [{ items: [{ id: 'a', platform: 'myspace', handle: 'x' }] }, { items: [{ id: 'a', platform: 'x', handle: 5 }] },
    { label: 3 }, { items: Array.from({ length: 13 }, (_, i) => ({ id: 's' + i, platform: 'web', handle: 'h' })) }]) {
    const r = await put({ socials: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((await r.json()).error, /widgets\.socials/);
  }
  assert.deepEqual(await get(), before, 'rejected changes leave the config unchanged');
});

test('the social bar is served, listed as a browser source and usable as a slot', async t => {
  const { base } = await start(t);
  const page = await fetch(base + '/widget/socials');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /@layer egdev[\s\S]*social-icons\.js/);
  const { sources } = await (await fetch(base + '/api/sources')).json();
  assert.ok(sources.some(s => s.id === 'socials' && s.url === base + '/widget/socials'), 'listed in the browser sources');
  const overlaySource = await readFile(new URL('../src/custom-overlays.mjs', import.meta.url), 'utf8');
  assert.match(overlaySource, /socials: \[\]/, 'custom overlays can embed the social bar as a slot');
});
