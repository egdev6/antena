import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const items = () => ({
  v: { type: 'scene', name: 'Camera [Vertical]', index: 0, current: true },
  h: { type: 'scene', name: 'Camera', index: 1, current: true },
  soloH: { type: 'scene', name: 'Solo H', index: 2, current: false },
  soloV: { type: 'scene', name: 'Solo V [Vertical]', index: 3, current: false },
  similar: { type: 'scene', name: 'Name [Vertical] extra', index: 4, current: false },
  nested: { type: 'scene', name: 'Camera [Vertical] [Vertical]', index: 5, current: false },
});
const names = ['Camera', 'Solo H', 'Solo V [Vertical]', 'Name [Vertical] extra', 'Camera [Vertical] [Vertical]'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dom = (chrome, expression) => evaluateChrome(chrome.cdp, expression, { timeoutMs: 12000 });
const tile = name => `[...document.querySelectorAll('.scene-tiles button')].find(b => b.querySelector('.eg-tile__name')?.textContent === ${JSON.stringify(name)})`;

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-meld-scenes-'));
  const meld = fakeMeld(items());
  let app, api;
  t.after(async () => {
    if (app?.server.listening) {
      await api('POST', '/api/meld/disconnect').catch(() => {});
      app.timers.stop();
      app.teleprompter.stop();
      app.viewers.stop();
      app.chat.stop();
      await app.closeHttp();
    }
    if (meld.server.listening) await new Promise(resolve => meld.server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.ok, true, `${method} ${url}: ${result.error || response.status}`);
    return result;
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true } });
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
  for (let i = 0; i < 200; i++) {
    if ((await api('GET', '/api/meld')).status.state === 'conectado') return { bin, base, api, meld };
    await sleep(25);
  }
  assert.fail('fake Meld did not connect');
}

async function open(t, ctx, route) {
  const chrome = await openChromePage(ctx.bin, ctx.base + route);
  const profile = chrome.child.spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  t.after(async () => {
    chrome.cdp.close();
    const exited = chrome.child.exitCode === null && chrome.child.signalCode === null ? once(chrome.child, 'exit') : Promise.resolve();
    chrome.child.kill();
    await exited;
    // Chrome helpers can still hold profile files after the main process exits (ENOTEMPTY on
    // Linux, EBUSY on Windows): retry, and never fail the test over temp cleanup.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  });
  await waitDom(chrome.cdp, route === '/dock' ? `!!document.querySelector('.d-scene')` : `!!document.querySelector('.scene-tiles button')`, { timeoutMs: 20000 });
  return chrome;
}

async function recordRequests(chrome, failVertical = false) {
  await dom(chrome, `(() => {
    const original = window.fetch;
    window.sceneRequests = [];
    window.sceneResponses = [];
    window.fetch = (url, options) => {
      if (String(url).includes('/api/meld/scene')) {
        const scene = JSON.parse(options.body).scene;
        window.sceneRequests.push(scene);
        const response = ${failVertical} && scene === 'v'
          ? Promise.resolve(new Response(JSON.stringify({ error: 'falló vertical' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
          : original(url, options);
        return response.then(result => { window.sceneResponses.push([scene, result.status]); return result; });
      }
      return original(url, options);
    };
    return true;
  })()`);
}

async function requests(chrome, count) {
  await waitDom(chrome.cdp, `window.sceneRequests.length >= ${count}`, { timeoutMs: 9000 }).catch(() => {});
  return dom(chrome, 'window.sceneRequests');
}

test('panel shows one entry per scene with H, V or H + V and live indicators', { timeout: 60000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const chrome = await open(t, ctx, '/#/meld/escenas');
  const panelNames = await dom(chrome, `[...document.querySelectorAll('.scene-tiles .eg-tile__name')].map(e => e.textContent)`);
  assert.deepEqual(panelNames, names);
  const dock = await open(t, ctx, '/dock');
  assert.deepEqual(await dom(dock, `[...document.querySelectorAll('.d-scene-n')].map(e => e.textContent)`), panelNames);
  const metadata = await dom(chrome, `[...document.querySelectorAll('.scene-tiles .eg-tile__meta')].map(e => e.textContent.split(' · ')[0])`);
  assert.deepEqual(metadata, ['H + V', 'H', 'V', 'H', 'V']);
  assert.equal(await dom(chrome, `${tile('Camera')}.getAttribute('aria-pressed')`), 'true');
  assert.match(await dom(chrome, `${tile('Camera')}.querySelector('.eg-tile__badge').textContent`), /En directo · H \+ V/);
  ctx.meld.setCurrentScenes(['v']);
  await waitDom(chrome.cdp, `${tile('Camera')}?.querySelector('.eg-tile__badge')?.textContent === 'En directo · V'`);
  ctx.meld.setCurrentScenes(['h']);
  await waitDom(chrome.cdp, `${tile('Camera')}?.querySelector('.eg-tile__badge')?.textContent === 'En directo · H'`);
  ctx.meld.setCurrentScenes(['soloV']);
  await waitDom(chrome.cdp, `${tile('Solo V [Vertical]')}?.querySelector('.eg-tile__badge')?.textContent === 'En directo · V'`);
});

test('panel switches both variants in order and preserves unpaired scene switching', { timeout: 60000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const chrome = await open(t, ctx, '/#/meld/escenas');
  await recordRequests(chrome);
  await clickWhen(chrome.cdp, tile('Camera'));
  assert.deepEqual(await requests(chrome, 2), ['h', 'v']);
  await waitDom(chrome.cdp, `window.sceneResponses.length === 2`);
  assert.deepEqual(await dom(chrome, 'window.sceneResponses'), [['h', 200], ['v', 200]]);
  await waitDom(chrome.cdp, `${tile('Camera')}?.querySelector('.eg-tile__badge')?.textContent === 'En directo · V'`);
  assert.equal((await ctx.api('GET', '/api/meld')).scenes.find(s => s.id === 'v').current, true);
  await clickWhen(chrome.cdp, tile('Solo H'));
  assert.deepEqual(await requests(chrome, 3), ['h', 'v', 'soloH']);
  await waitDom(chrome.cdp, `${tile('Solo H')}?.getAttribute('aria-pressed') === 'true'`);
  await clickWhen(chrome.cdp, tile('Solo V [Vertical]'));
  assert.deepEqual(await requests(chrome, 4), ['h', 'v', 'soloH', 'soloV']);
  await waitDom(chrome.cdp, `${tile('Solo V [Vertical]')}?.getAttribute('aria-pressed') === 'true'`);
});

test('panel exposes a second-switch error and does not roll back the first switch', { timeout: 60000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const chrome = await open(t, ctx, '/#/meld/escenas');
  ctx.meld.setCurrentScenes(['soloH']);
  await waitDom(chrome.cdp, `${tile('Solo H')}?.getAttribute('aria-pressed') === 'true'`);
  await recordRequests(chrome, true);
  await clickWhen(chrome.cdp, tile('Camera'));
  assert.deepEqual(await requests(chrome, 2), ['h', 'v']);
  await waitDom(chrome.cdp, `document.querySelector('.toast.err')?.textContent === 'falló vertical'`);
  assert.deepEqual(await dom(chrome, 'window.sceneResponses'), [['h', 200], ['v', 500]]);
  const scenes = (await ctx.api('GET', '/api/meld')).scenes;
  assert.equal(scenes.find(s => s.id === 'h').current, true);
  assert.equal(scenes.find(s => s.id === 'soloH').current, false);
  assert.equal(scenes.find(s => s.id === 'v').current, false);
  assert.deepEqual(await dom(chrome, 'window.sceneRequests'), ['h', 'v']);
});
