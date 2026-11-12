// Independent verification regressions for #129 (verifier mwdzjeko-k-jouv, reproduced 0/4 on 6b9fcf3):
// strict anonymous dates, newest-archive cutoff, and thank actions limited to the shown selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { findChrome, openChromePage, closeChrome, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'thanks-129-regression-'));
assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });
const entry = (id, name, followedAt) => ({ id, name, followedAt, source: 'offline', thanked: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function start(t, { archives = [] } = {}) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  assert.ok(dir.startsWith(root + path.sep));
  const twitch = blank(), youtube = blank();
  twitch.entries = [entry('t', 'Twitch One', '2026-02-01T00:00:00.000Z')];
  youtube.entries = [entry('y', 'YouTube Two', '2026-03-01T00:00:00.000Z')];
  const file = path.join(dir, 'followers.json');
  await writeFile(file, JSON.stringify({ version: 1, platforms: { twitch, youtube } }));
  if (archives.length) await mkdir(path.join(dir, 'sessions'));
  for (const a of archives) await writeFile(path.join(dir, 'sessions', a.id + '.json'), JSON.stringify({ ...a, events: [], notes: [], goalOffsets: {} }));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.timers.stop(); await app.closeHttp(); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
    return { status: r.status, body: await r.json() };
  };
  return { file, base, call };
}
async function panel(t) {
  const f = await start(t);
  await f.call('PUT', '/api/config', { panel: { onboardingDone: true } });
  await f.call('PUT', '/api/widgets', { thanks: { window: 'all', platforms: ['youtube'], maxNames: 1, showAnonymous: false } });
  const bin = await findChrome(); if (!bin) { t.skip('sin Chrome local'); return null; }
  const chrome = await openChromePage(bin, f.base + '/#/widgets/thanks');
  t.after(() => closeChrome(chrome));
  await waitDom(chrome.cdp, `!!document.querySelector('[data-thanks-bulk]:not(:disabled)') && !!document.querySelector('[data-thanks-entry]')`, { timeoutMs: 15000 });
  return { ...f, c: chrome.cdp };
}

test('S3: impossible date rejects the entire selection with bytes unchanged', async t => {
  const f = await start(t), before = hash(await readFile(f.file));
  const r = await f.call('POST', '/api/followers/thank', { entries: [{ platform: 'twitch', id: 't' }], anonymous: ['2026-02-30T00:00:00.000Z'] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: 'Indica «entries» y/o «anonymous» con selecciones válidas.' });
  assert.equal(hash(await readFile(f.file)), before);
});

test('S4: newest archived stream is determined by timestamp, not legacy id', async t => {
  const f = await start(t, { archives: [
    { id: 'z-old', title: 'Old', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-02T00:00:00Z' },
    { id: 'a-new', title: 'New', startedAt: '2026-02-10T00:00:00Z', endedAt: '2026-02-11T00:00:00Z' },
  ] });
  await f.call('PUT', '/api/widgets', { thanks: { window: 'lastStream' } });
  const r = await f.call('GET', '/api/widgets');
  assert.deepEqual(r.body.thanks.names, [{ name: 'YouTube Two', platform: 'youtube' }]);
});

test('S3: individual action must not persist a filtered-out record', { timeout: 30000 }, async t => {
  const f = await panel(t); if (!f) return;
  assert.deepEqual((await f.call('GET', '/api/widgets')).body.thanks.names.map(x => x.name), ['YouTube Two']);
  const clicked = await evaluateChrome(f.c, `(() => { const row = Array.from(document.querySelectorAll('[data-thanks-entry]')).find(e => e.textContent.includes('Twitch One')); const button = row?.querySelector('button'); if (!button || button.disabled) return false; button.click(); return true; })()`);
  if (clicked) await sleep(1000);
  const data = JSON.parse(await readFile(f.file));
  assert.equal(data.platforms.twitch.entries[0].thanked, false);
});

test('S3: a changed widget selection cannot make a bulk action thank hidden records', { timeout: 30000 }, async t => {
  const f = await panel(t); if (!f) return;
  await evaluateChrome(f.c, `(() => { const real = window.fetch; let release; const gate = new Promise(r => release = r); window.releaseOld = release; window.heldOld = false; let first = true; window.confirm = () => true; window.fetch = function(...args) { const p = real.apply(this, args); if (first && String(args[0]).includes('/api/followers?pending=true&shown=true')) { first = false; return p.then(async r => { const body = await r.text(); window.heldOld = true; await gate; return new Response(body, { status: r.status, headers: r.headers }); }); } return p; }; document.querySelector('[data-thanks-bulk]').click(); return true; })()`);
  await waitDom(f.c, 'window.heldOld === true', { timeoutMs: 10000 });
  await f.call('PUT', '/api/widgets', { thanks: { platforms: ['twitch'] } });
  assert.deepEqual((await f.call('GET', '/api/widgets')).body.thanks.names.map(x => x.name), ['Twitch One']);
  await evaluateChrome(f.c, 'window.releaseOld(); true');
  await sleep(1000);
  const data = JSON.parse(await readFile(f.file));
  assert.equal(data.platforms.youtube.entries[0].thanked, false);
});
