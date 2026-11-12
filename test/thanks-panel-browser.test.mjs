// Immediate follower actions and stale list responses in the React Widgets panel.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'thanks-panel-'));
process.env.ANTENA_DATA = path.join(root, 'default-data');
process.env.ANTENA_MEDIA = path.join(root, 'default-media');
const { createApp } = await import('../src/server.mjs');
after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });
async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const dir = await mkdtemp(path.join(root, 'case-'));
  const twitch = blank(), youtube = blank();
  const row = (id, name, followedAt) => ({ id, name, followedAt, source: 'offline', thanked: false });
  twitch.entries = [row('old', 'Old', '2026-01-01T00:00:00Z'), row('same', 'Twitch Shared', '2026-01-02T00:00:00Z')];
  youtube.entries = [row('same', 'YouTube Shared', '2026-01-03T00:00:00Z')];
  youtube.anonymous = [{ at: '2026-01-03T00:00:00Z', count: 3, thanked: false }];
  await writeFile(path.join(dir, 'followers.json'), JSON.stringify({ version: 1, platforms: { twitch, youtube } }));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; let chrome;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, 200); return response.json();
  };
  await call('PUT', '/api/config', { panel: { onboardingDone: true } });
  await call('PUT', '/api/widgets', { thanks: { window: 'all', maxNames: 1, showAnonymous: true } });
  t.after(async () => { if (chrome) await closeChrome(chrome); app.timers.stop(); await app.closeHttp(); await rm(dir, { recursive: true, force: true }); });
  return { base, call, open: async () => { chrome = await openChromePage(bin, base + '/#/widgets/thanks'); return chrome.cdp; } };
}
const list = `document.querySelector('[data-thanks-list]')`;
const entry = name => `Array.from(${list}?.querySelectorAll('[data-thanks-entry]') || []).find(e => e.textContent.includes(${JSON.stringify(name)}))`;

test('S3: individual and confirmed bulk actions are immediate and target only displayed records', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open();
  await waitDom(c, `!!${entry('Old')} && !!${entry('YouTube Shared')}`, { timeoutMs: 15000 });
  await evaluateChrome(c, `window.confirm = () => true; ${entry('Old')}.querySelector('button').click(); true`);
  await waitDom(c, `!${entry('Old')}`, { timeoutMs: 8000 });
  let pending = await f.call('GET', '/api/followers?pending=true');
  assert.deepEqual(pending.entries.map(e => e.name), ['Twitch Shared', 'YouTube Shared']);
  assert.equal(pending.anonymous.length, 1);
  await evaluateChrome(c, `document.querySelector('[data-thanks-bulk]').click(); true`);
  await waitDom(c, `!${entry('YouTube Shared')}`, { timeoutMs: 8000 });
  pending = await f.call('GET', '/api/followers?pending=true');
  assert.deepEqual(pending.entries.map(e => e.name), ['Twitch Shared']);
  assert.deepEqual(pending.anonymous, []);
});

test('S3: an older follower fetch cannot restore records after a newer change', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open();
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const real = window.fetch; let release;
    const gate = new Promise(resolve => { release = resolve; });
    window.releaseOldFollowers = release; window.heldFollowerFetch = false; let first = true;
    window.fetch = function (...args) {
      const request = real.apply(this, args);
      if (first && String(args[0]).includes('/api/followers?pending=true')) {
        first = false;
        return request.then(async response => { const text = await response.text(); window.heldFollowerFetch = true; await gate; return new Response(text, { status: response.status, headers: response.headers }); });
      }
      return request;
    };
  })()` });
  await c.send('Page.reload');
  await waitDom(c, `window.heldFollowerFetch === true`, { timeoutMs: 15000 });
  await f.call('POST', '/api/followers/thank', { entries: [{ platform: 'twitch', id: 'old' }] });
  await waitDom(c, `!!${entry('Twitch Shared')} && !${entry('Old')}`, { timeoutMs: 10000 });
  await evaluateChrome(c, `window.releaseOldFollowers(); true`);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await evaluateChrome(c, `!!${entry('Old')}`), false);
});
