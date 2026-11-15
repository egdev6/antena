import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { waitFor } from './helpers/program-contract.mjs';
import { closeChrome, findChrome, openChromePage, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/dock.css"></head><body><div id="root"></div><script type="module" src="/assets/dock.js"></script></body></html>';
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', r));
const delay = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label) => { const end = Date.now() + 4000; while (!fn()) { assert.ok(Date.now() < end, label); await delay(10); } };

test('dock meters follow OBS audio visibility and never subscribe or render for Meld', { timeout: 60000 }, async t => {
  const bin = await findChrome(); if (!bin) return t.skip('sin Chrome local');
  const root = await mkdtemp(path.join(tmpdir(), 'dock-meters-'));
  const dist = path.join(root, 'dist'), assets = path.join(dist, 'assets');
  const fake = fakeObs({ inputs: [{ inputName: 'Mic', inputUuid: 'mic' }] });
  const meld = fakeMeld({ t1: { type: 'track', name: 'Mic', muted: false } });
  let app, chrome;
  t.after(async () => {
    if (chrome) await closeChrome(chrome);
    if (app) { await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); }
    await fake.close(); await new Promise(r => meld.server.close(r)); await rm(root, { recursive: true, force: true });
  });
  const result = await build({ entryPoints: { dock: 'app/src/dock/main.tsx' }, outdir: assets, bundle: true, format: 'esm', minify: true,
    write: false, target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, external: ['/fonts/*', '/ds/*'] });
  await mkdir(assets, { recursive: true });
  await Promise.all([...result.outputFiles.map(f => writeFile(f.path, f.contents)), writeFile(path.join(dist, 'index.html'), html), writeFile(path.join(dist, 'dock.html'), html)]);
  await listen(fake.server); await listen(meld.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  const interest = [];
  app.server.on('request', req => { if (req.url.includes('client=dock-meters')) interest.push(req.url); });
  app.server.on('upgrade', req => { if (req.url.includes('client=dock-meters')) interest.push(req.url); });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const configure = body => fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let ready = waitFor(app.program, 'status', s => s.state === 'conectado');
  assert.equal((await configure({ program: { kind: 'obs' }, obs: { url: `ws://127.0.0.1:${fake.server.address().port}` } })).status, 200); await ready;
  chrome = await openChromePage(bin, 'about:blank');
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 1, mobile: false });
  await chrome.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await chrome.cdp.send('Page.navigate', { url: `${base}/dock` });
  const c = chrome.cdp, dom = expression => evaluateChrome(c, expression);
  await waitDom(c, `!!document.querySelector('#d-t-audio')`); await delay(150);
  assert.equal(interest.length, 0, 'control tab has no meter interest');
  await clickWhen(c, `document.querySelector('#d-t-audio')`);
  await waitDom(c, `!!document.querySelector('[role="meter"][aria-label="Nivel de Mic"]')`, { timeoutMs: 4000 });
  await until(() => fake.identifications?.some(x => x.op === 3 && (x.eventSubscriptions & (1 << 16))), 'meter subscription');
  const meter = `document.querySelector('[role="meter"][aria-label="Nivel de Mic"]')`;
  fake.setVolumeMeters([{ inputName: 'Mic', inputUuid: 'mic', inputLevelsMul: [[0.05, 0.1, 1.2]] }]);
  await waitDom(c, `${meter}?.getAttribute('aria-valuenow') === '67'`);
  assert.deepEqual(await dom(`({ min: ${meter}.getAttribute('aria-valuemin'), max: ${meter}.getAttribute('aria-valuemax'), live: ${meter}.closest('[aria-live]')?.getAttribute('aria-live') || null, transition: getComputedStyle(${meter}.firstElementChild).transitionDuration })`),
    { min: '0', max: '100', live: null, transition: '0s' });
  await clickWhen(c, `document.querySelector('#d-t-control')`);
  await until(() => fake.identifications.at(-1).eventSubscriptions === ((1 << 2) | (1 << 3) | (1 << 5) | (1 << 6) | (1 << 7)), 'tab unsubscribe');
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 780, deviceScaleFactor: 1, mobile: false });
  await until(() => (fake.identifications.at(-1).eventSubscriptions & (1 << 16)) !== 0, 'visible wide audio subscribes');
  ready = waitFor(app.program, 'status', s => s.state === 'conectado');
  assert.equal((await configure({ program: { kind: 'meld' }, meld: { enabled: true, url: `ws://127.0.0.1:${meld.server.address().port}` } })).status, 200); await ready;
  await waitDom(c, `!!document.querySelector('.d-trk-n') && !document.querySelector('[role="meter"]')`);
  const before = interest.length;
  await chrome.cdp.send('Page.reload');
  await waitDom(c, `!!document.querySelector('.d-trk-n')`); await delay(300);
  assert.equal(await dom(`document.querySelectorAll('[role="meter"]').length`), 0);
  assert.equal(interest.length, before, 'Meld dock makes no meter interest request');
});
