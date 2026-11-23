// #39 S1/S2/S4/S5: exercise current dock sources with real HTTP and Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/dock.css"></head><body><div id="root"></div><script type="module" src="/assets/dock.js"></script></body></html>';
const delay = ms => new Promise(r => setTimeout(r, ms));
const ids = ['stream', 'alerts', 'marks', 'scenes', 'teleprompter', 'credits', 'audio', 'questions', 'tierlist', 'giveaway', 'shortcuts'];
const config = (enabled, zones, layout = 'tabs', order = ids) => ({ layout, modules: order.map(id => ({ id, enabled: enabled.includes(id) })), zones });
const zone = (id, label, modules) => ({ id, label, modules });
const baseZones = [zone('control', 'Control', ids.slice(0, 6)), zone('audio', 'Audio', ['audio']), zone('interactivos', 'Interactivos', ['questions', 'tierlist', 'giveaway'])];
const standard = layout => config(ids.filter(id => id !== 'shortcuts'), baseZones, layout);

test('S1/S2/S4/S5: custom dock layouts, modules, shortcut, preview and meter visibility', { timeout: 120000 }, async t => {
  const bin = await findChrome(); if (!bin) return t.skip('sin Chrome local');
  const root = await mkdtemp(path.join(tmpdir(), 'dock-custom-'));
  const dist = path.join(root, 'dist'), assets = path.join(dist, 'assets');
  let app, chrome;
  t.after(async () => {
    try { if (chrome) await closeChrome(chrome); }
    finally { try { if (app) await app.closeHttp(); } finally { await rm(root, { recursive: true, force: true }); } }
  });
  const built = await build({ entryPoints: { dock: 'app/src/dock/main.tsx' }, outdir: assets, bundle: true, format: 'esm', minify: true, write: false,
    target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, external: ['/fonts/*', '/ds/*'] });
  await mkdir(assets, { recursive: true });
  await Promise.all([...built.outputFiles.map(f => writeFile(f.path, f.contents)), writeFile(path.join(dist, 'index.html'), html), writeFile(path.join(dist, 'dock.html'), html)]);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  let meterOpen = 0, meterRequests = 0, actionRequests = 0;
  app.server.on('request', req => {
    if (req.url.includes('client=dock-meters')) { meterOpen++; meterRequests++; req.on('close', () => meterOpen--); }
    if (!['GET', 'HEAD'].includes(req.method)) actionRequests++;
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); assert.equal(r.ok, true, data.error); return data; };
  const save = dock => call('PUT', '/api/config', { dock });
  chrome = await openChromePage(bin, 'about:blank');
  const c = chrome.cdp, dom = expression => evaluateChrome(c, expression, { timeoutMs: 12000 });
  const resize = width => c.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
  const open = async (width, query = '') => { await resize(width); await c.send('Page.navigate', { url: `${base}/dock${query}` }); await waitDom(c, `!!document.querySelector('.dock')`, { timeoutMs: 20000 }); };
  const until = async (fn, message) => { const end = Date.now() + 5000; while (!fn()) { assert.ok(Date.now() < end, message); await delay(25); } };
  const view = () => dom(`(() => ({ tabs:[...document.querySelectorAll('.d-tabs [role=tab]')].map(x => x.firstChild.textContent.trim()), selected:document.querySelector('.d-tabs [aria-selected=true]')?.id || null, cols:[...document.querySelectorAll('.d-cols > .d-col')].map(x => { const r=x.getBoundingClientRect(); return { label:x.querySelector('.d-col-h').firstChild.textContent.trim(), left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; }) }))()`);

  for (const [name, layout, width, expected, direction] of [
    ['auto narrow', 'auto', 600, ['Control', 'Audio', 'Interactivos'], 'tabs'],
    ['auto wide', 'auto', 900, ['Control', 'Audio', 'Interactivos'], 'horizontal'],
    ['tabs forced wide', 'tabs', 900, ['Control', 'Audio', 'Interactivos'], 'tabs'],
    ['columns forced below 768', 'columns', 600, ['Control', 'Audio', 'Interactivos'], 'horizontal'],
    ['split-v', 'split-v', 800, ['Control', 'Audio'], 'vertical'],
    ['split-h', 'split-h', 800, ['Control', 'Audio'], 'horizontal'],
    ['split-v fallback 479', 'split-v', 479, ['Control', 'Audio', 'Interactivos'], 'tabs'],
    ['split-h fallback 479', 'split-h', 479, ['Control', 'Audio', 'Interactivos'], 'tabs'],
    ['columns fallback 479', 'columns', 479, ['Control', 'Audio', 'Interactivos'], 'tabs'],
    ['columns threshold 480', 'columns', 480, ['Control', 'Audio', 'Interactivos'], 'horizontal'],
  ]) await t.test(`S2/S4/S5 ${name}`, async () => {
    await save(standard(layout)); await open(width);
    const v = await view();
    if (direction === 'tabs') { assert.deepEqual(v.tabs, [...expected, 'Tema']); assert.deepEqual(v.cols, []); assert.equal(v.selected, 'd-t-control'); }
    else {
      assert.deepEqual(v.tabs, []); assert.deepEqual(v.cols.map(x => x.label), expected);
      assert.ok(v.cols.every(x => x.width > 0 && x.height > 0));
      for (let i = 1; i < v.cols.length; i++) {
        if (direction === 'horizontal') { assert.ok(v.cols[i].left >= v.cols[i - 1].right - 1); assert.equal(v.cols[i].top, v.cols[0].top); }
        else { assert.ok(v.cols[i].top >= v.cols[i - 1].bottom - 1); assert.equal(v.cols[i].left, v.cols[0].left); }
      }
    }
  });

  await t.test('S4 preserve: current default dock keeps its controls and pause behavior', async () => {
    await save(standard('auto')); await open(600);
    assert.equal(await dom(`!!document.querySelector('[aria-label="Control de emisión"]') && !!document.querySelector('.d-grid')`), true);
    assert.equal(await dom(`document.querySelectorAll('.d-grid .sc').length`), 0);
    assert.equal((await call('GET', '/api/state')).status.pause.paused, false);
    await dom(`Array.from(document.querySelectorAll('.d-grid button')).find(b => b.textContent.startsWith('⏸ Pausar')).click()`);
    await until(() => app.engine.pauseState().paused, 'default pause');
    assert.equal((await call('GET', '/api/state')).status.pause.paused, true);
    await waitDom(c, `Array.from(document.querySelectorAll('.d-grid button')).some(b => b.textContent.startsWith('▶ Reanudar'))`);
    await dom(`Array.from(document.querySelectorAll('.d-grid button')).find(b => b.textContent.startsWith('▶ Reanudar')).click()`);
    await until(() => !app.engine.pauseState().paused, 'default resume');
    assert.equal((await call('GET', '/api/state')).status.pause.paused, false);
  });

  await t.test('S1/S2/S5 disabled, ordering, unplaced, duplicate and interactive grouping', async () => {
    const order = ['credits', 'marks', 'alerts', 'giveaway', 'questions', 'tierlist', 'stream', 'scenes', 'teleprompter', 'audio', 'shortcuts'];
    const dock = config(['credits', 'marks', 'alerts', 'giveaway', 'questions', 'teleprompter'], [zone('main', 'Principal', ['alerts', 'marks', 'credits', 'alerts', 'stream', 'unknown']), zone('empty', 'Vacía', []), zone('other', 'Juegos', ['questions', 'giveaway', 'questions'])], 'columns', order);
    await save(dock); await open(900);
    assert.deepEqual((await view()).cols.map(x => x.label), ['Principal', 'Juegos']);
    assert.deepEqual(await dom(`Array.from(document.querySelectorAll('.d-col:first-child .d-body > *')).map(x => x.getAttribute('aria-label') || x.className)`), ['Cierre', 'd-grid']);
    assert.deepEqual(await dom(`Array.from(document.querySelectorAll('.d-col:first-child .d-grid button')).map(x => x.firstChild.textContent.trim())`), ['🎬 Marca', '✔ Agradecido', '⏸ Pausar', '⏭ Saltar']);
    assert.equal(await dom(`!!document.querySelector('[aria-label="Control de emisión"], [aria-label="Escenas"]')`), false);
    assert.deepEqual(await dom(`Array.from(document.querySelectorAll('.d-col:last-child > .d-body > *')).map(x => x.getAttribute('aria-label') || x.className)`), ['d-inter', 'Teleprompter']);
    assert.deepEqual(await dom(`Array.from(document.querySelectorAll('.d-itabs [role=tab]')).map(x => x.firstChild.textContent.trim())`), ['Sorteo', 'Preguntas']);
    assert.equal(await dom(`document.querySelectorAll('#d-i-tier').length`), 0);
    // A saved tab no longer present must immediately select the current first zone.
    await dom(`localStorage.setItem('egdev.dock.tab','gone')`); await save({ ...dock, layout: 'tabs' }); await open(600);
    assert.equal((await view()).selected, 'd-t-main');
    assert.equal(await dom(`document.querySelector('#d-p-main').hidden`), false);
  });

  await t.test('S5 shortcuts module runs the existing Stream Deck route', async () => {
    const created = await call('POST', '/api/shortcuts', { name: 'Atajo de prueba', steps: [{ kind: 'builtin', action: 'pausa' }] });
    await save(config(['shortcuts'], [zone('custom', 'Acciones', ['shortcuts'])])); await open(600);
    await waitDom(c, `document.body.textContent.includes('Atajo de prueba')`);
    assert.equal((await call('GET', '/api/state')).status.pause.paused, false);
    await dom(`Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Atajo de prueba')).click()`);
    await until(() => app.engine.pauseState().paused, 'shortcut pauses alerts');
    assert.equal((await call('GET', '/api/state')).status.pause.paused, true);
    assert.ok(created.shortcut.id);
  });

  await t.test('S5 preview overrides saved config and blocks pointer, keyboard and synthetic actions', async () => {
    await save(standard('tabs'));
    const preview = config(['alerts', 'marks'], [zone('vista', 'Previsión ágil', ['alerts', 'marks'])]);
    const encoded = Buffer.from(JSON.stringify(preview)).toString('base64url');
    const beforeConfig = (await call('GET', '/api/config')).dock;
    const beforePause = (await call('GET', '/api/state')).status.pause.paused;
    await open(600, `?preview=${encoded}`);
    assert.deepEqual((await view()).tabs, ['Previsión ágil', 'Tema']);
    assert.equal(await dom(`!!document.querySelector('.dock[inert]')`), true);
    const beforeActions = actionRequests;
    await dom(`(() => { for (const b of document.querySelectorAll('.d-grid button')) { b.click(); b.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); } return true; })()`);
    await delay(300);
    assert.equal(actionRequests, beforeActions);
    assert.equal((await call('GET', '/api/state')).status.pause.paused, beforePause);
    assert.deepEqual((await call('GET', '/api/config')).dock, beforeConfig);
  });

  await t.test('S5 meters subscribe only for visible audio in custom layouts', async () => {
    await call('PUT', '/api/config', { program: { kind: 'obs' } });
    const dock = config(['alerts', 'audio'], [zone('one', 'Uno', ['alerts']), zone('two', 'Dos', ['audio'])]);
    await save(dock); await open(600); await delay(150);
    assert.equal(meterOpen, 0);
    await dom(`document.querySelector('#d-t-two').click()`); await until(() => meterOpen === 1, 'audio visible');
    await dom(`document.querySelector('#d-t-one').click()`); await until(() => meterOpen === 0, 'audio hidden');
    await save({ ...dock, layout: 'columns' }); await open(600); await until(() => meterOpen === 1, 'audio in columns');
    await save(config(['alerts'], [zone('one', 'Uno', ['alerts', 'audio'])], 'columns')); await open(600);
    await until(() => meterOpen === 0, 'audio disabled');
    const count = meterRequests;
    const preview = Buffer.from(JSON.stringify(dock)).toString('base64url');
    await open(600, `?preview=${preview}`); await delay(200);
    assert.equal(meterRequests, count, 'inert preview never subscribes to meters');
  });
});
