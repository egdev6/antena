// #39 S3/S5: exercise the current panel and dock sources against an isolated HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { DEFAULT_DOCK } from '../src/dock-layout.mjs';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const q = JSON.stringify;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const button = text => `[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === ${q(text)})`;
const field = label => `document.querySelector('main [aria-label=${q(label)}]')`;
const row = id => `document.querySelector('main [data-dock-module=${q(id)}]')`;
const frame = `document.querySelector('main iframe[title="Vista previa del dock"]')`;
const layout = `document.querySelector('main label:has(select[aria-label="Distribución del dock"]) select')`;
const preview = async c => {
  const src = await dom(c, `${frame}.getAttribute('src')`);
  const url = new URL(src, 'http://127.0.0.1');
  assert.equal(url.pathname, '/dock');
  assert.ok(url.searchParams.has('preview'));
  return JSON.parse(Buffer.from(url.searchParams.get('preview'), 'base64url').toString('utf8'));
};
async function setValue(c, selector, value) {
  await dom(c, `(() => { const el = ${selector}; if (!el) throw Error('missing field');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
}
async function click(c, expression) {
  await waitDom(c, `!!(${expression}) && !(${expression}).disabled`, { timeoutMs: 4000 });
  await dom(c, `${expression}.click(); true`);
}
async function save(c) {
  await click(c, button('Guardar'));
  await waitDom(c, `document.querySelector('.lv-savebar [role=status]')?.textContent === 'Todo guardado'`, { timeoutMs: 10000 });
}
async function editor(c) {
  await waitDom(c, `!!${layout} && !!${frame} && !!${row('stream')}`, { timeoutMs: 2500 });
}

const html = name => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ds/tokens.css"><link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/assets/${name}.css"></head><body><div id="root"></div><script type="module" src="/assets/${name}.js"></script></body></html>`;

test('S3/S5 dock editor: draft, preview, live save and reset', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  assert.ok(bin, 'Chrome is required for the panel editor browser test');
  const root = await mkdtemp(path.join(tmpdir(), 'antena-dock-editor-'));
  const dist = path.join(root, 'dist'), assets = path.join(dist, 'assets');
  let app, chrome, dockChrome;
  t.after(async () => {
    await closeAll(() => dockChrome && closeChrome(dockChrome), () => chrome && closeChrome(chrome),
      () => app && app.closeHttp(), () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  });
  const built = await build({ entryPoints: { panel: 'app/src/panel/main.tsx', dock: 'app/src/dock/main.tsx' }, outdir: assets,
    bundle: true, format: 'esm', minify: true, write: false, target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, external: ['/fonts/*', '/ds/*'] });
  await mkdir(assets, { recursive: true });
  await Promise.all([...built.outputFiles.map(f => writeFile(f.path, f.contents)),
    writeFile(path.join(dist, 'index.html'), html('panel')), writeFile(path.join(dist, 'dock.html'), html('dock'))]);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  let actions = 0;
  app.server.on('request', req => { if (!['GET', 'HEAD'].includes(req.method)) actions++; });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await r.json(); assert.equal(r.status, 200, `${method} ${url}: ${JSON.stringify(result)}`); return result;
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true } });
  chrome = await openChromePage(bin, `${base}/#/prompter/vista`);
  const c = chrome.cdp;
  await waitDom(c, `!!document.querySelector('main textarea.code')`, { timeoutMs: 15000 });
  await dom(c, `window.confirm = () => true; true`);

  await t.test('S3: ordered Spanish module switches and accessible reorder stay in the draft', async () => {
    await editor(c);
    const ids = DEFAULT_DOCK.modules.map(m => m.id);
    const labels = ['Emisión', 'Alertas', 'Marca y agradecidos', 'Escenas', 'Teleprompter', 'Créditos', 'Audio', 'Preguntas', 'Tier list', 'Sorteo', 'Atajos'];
    assert.deepEqual(await dom(c, `[...document.querySelectorAll('main [data-dock-module]')].map(r => [r.dataset.dockModule, r.querySelector('label.switch').textContent.trim()])`), ids.map((id, i) => [id, labels[i]]));
    assert.equal(await dom(c, `${row('stream')}.querySelector('[aria-label="Subir Emisión"]').disabled`), true);
    assert.equal(await dom(c, `${row('shortcuts')}.querySelector('[aria-label="Bajar Atajos"]').disabled`), true);
    assert.equal(await dom(c, `${row('shortcuts')}.querySelector('input').checked`), false);
    await waitDom(c, `${frame}.contentWindow?.location.search === new URL(${frame}.src).search && !!${frame}.contentDocument?.querySelector('.dock[inert]')`, { timeoutMs: 15000 });
    await c.send('Page.bringToFront');
    await dom(c, `${row('shortcuts')}.querySelector('[aria-label="Subir Atajos"]').focus(); true`);
    assert.equal(await dom(c, `document.activeElement?.getAttribute('aria-label')`), 'Subir Atajos');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitDom(c, `${row('shortcuts')}.nextElementSibling?.dataset.dockModule === 'giveaway'`);
    await click(c, `${row('shortcuts')}.querySelector('input')`);
    assert.deepEqual((await preview(c)).modules.slice(-2), [{ id: 'shortcuts', enabled: true }, { id: 'giveaway', enabled: true }]);
    assert.deepEqual((await api('GET', '/api/config')).dock, DEFAULT_DOCK, 'draft never autosaves');
    await click(c, button('Descartar'));
    assert.deepEqual(await preview(c), DEFAULT_DOCK);
    assert.equal(await dom(c, `${row('shortcuts')}.querySelector('input').checked`), false);
  });

  await t.test('S3/S5: two split zones, UTF-8 names, live inert preview and both viewport sizes', async () => {
    await editor(c);
    assert.deepEqual(await dom(c, `[...${layout}.options].map(o => [o.value,o.textContent.trim()])`), [
      ['auto', 'Automática — recomendada'], ['tabs', 'Pestañas'], ['columns', 'Columnas'],
      ['split-v', 'Partida arriba y abajo'], ['split-h', 'Lado a lado'],
    ]);
    await setValue(c, layout, 'split-v');
    assert.equal(await dom(c, `document.querySelectorAll('main input[aria-label^="Nombre de la zona "]').length`), 2);
    assert.equal(await dom(c, `document.querySelectorAll('main select[aria-label^="Zona de "]').length`), 10);
    await setValue(c, field('Zona de Emisión'), 'audio');
    await setValue(c, field('Nombre de la zona 2'), 'Señal 🦊');
    const draft = await preview(c);
    assert.equal(draft.layout, 'split-v');
    assert.deepEqual(draft.zones.map(z => z.label), ['Control', 'Señal 🦊']);
    assert.ok(draft.zones[1].modules.includes('stream'));
    assert.ok(draft.zones[1].modules.includes('questions'), 'third-zone modules remain visible in a split');
    assert.deepEqual((await api('GET', '/api/config')).dock, DEFAULT_DOCK);
    assert.deepEqual(await dom(c, `[${frame}.style.width, ${frame}.style.height]`), ['420px', '780px']);
    await waitDom(c, `${frame}.contentWindow?.location.search === new URL(${frame}.src).search && !!${frame}.contentDocument?.querySelector('.dock[inert] .d-tabs')`, { timeoutMs: 15000 });
    const before = actions, pause = (await api('GET', '/api/state')).status.pause.paused;
    await dom(c, `(() => { const d = ${frame}.contentDocument; d.querySelectorAll('button').forEach(b => { b.click(); b.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true})); }); return true; })()`);
    await delay(250);
    assert.equal(actions, before, 'preview cannot send actions');
    assert.equal((await api('GET', '/api/state')).status.pause.paused, pause);
    await click(c, button('Ancho'));
    assert.deepEqual(await dom(c, `[${frame}.style.width, ${frame}.style.height]`), ['1256px', '780px']);
    await waitDom(c, `${frame}.contentWindow?.location.search === new URL(${frame}.src).search && !!${frame}.contentDocument?.querySelector('.dock[inert] .d-cols')`, { timeoutMs: 15000 });
    assert.deepEqual(await dom(c, `[...${frame}.contentDocument.querySelectorAll('.d-col-h')].map(e => e.firstChild.textContent.trim())`), ['Control', 'Señal 🦊']);
    await click(c, button('Descartar'));
  });

  await t.test('S3/S5: Guardar persists dock and updates an already-open dock', async () => {
    await editor(c);
    dockChrome = await openChromePage(bin, `${base}/dock`);
    const d = dockChrome.cdp;
    await waitDom(d, `!!document.querySelector('.d-grid button')`, { timeoutMs: 15000 });
    await click(c, `${row('alerts')}.querySelector('input')`);
    const draft = await preview(c);
    assert.equal(draft.modules.find(m => m.id === 'alerts').enabled, false);
    assert.deepEqual((await api('GET', '/api/config')).dock, DEFAULT_DOCK);
    assert.equal(await dom(d, `[...document.querySelectorAll('.d-grid button')].some(b => b.textContent.includes('Pausar'))`), true);
    await save(c);
    assert.deepEqual((await api('GET', '/api/config')).dock, draft);
    await waitDom(d, `![...document.querySelectorAll('.d-grid button')].some(b => b.textContent.includes('Pausar'))`, { timeoutMs: 12000 });
    await closeChrome(dockChrome); dockChrome = null;
  });

  await t.test('S3: reset is a discardable draft and saves the shared defaults', async () => {
    await editor(c);
    const before = (await api('GET', '/api/config')).dock;
    assert.notDeepEqual(before, DEFAULT_DOCK);
    await click(c, button('Restablecer el dock de serie'));
    assert.deepEqual(await preview(c), DEFAULT_DOCK);
    assert.deepEqual((await api('GET', '/api/config')).dock, before);
    await click(c, button('Descartar'));
    assert.deepEqual(await preview(c), before);
    await click(c, button('Restablecer el dock de serie'));
    await save(c);
    assert.deepEqual((await api('GET', '/api/config')).dock, DEFAULT_DOCK);
  });

  await t.test('S3 preserve: existing Prompter Vista controls still save and discard', async () => {
    const before = (await api('GET', '/api/config')).prompter;
    const mirror = `Array.from(document.querySelectorAll('main label.switch')).find(l => l.textContent.includes('Espejo')).querySelector('input')`;
    const chat = `Array.from(document.querySelectorAll('main label')).find(l => l.textContent.includes('Mensajes de chat en la vista')).querySelector('input')`;
    await click(c, mirror);
    await setValue(c, chat, '77');
    assert.deepEqual((await api('GET', '/api/config')).prompter, before);
    await save(c);
    const saved = (await api('GET', '/api/config')).prompter;
    assert.equal(saved.mirror, !before.mirror); assert.equal(saved.chatLines, 77);
    await click(c, mirror); await click(c, button('Descartar'));
    assert.equal(await dom(c, `${mirror}.checked`), saved.mirror);
  });

  await t.test('S3/S5: split assignment handles unplaced and disabled modules without losing them', async () => {
    const custom = structuredClone(DEFAULT_DOCK);
    custom.zones = [{ id: 'solo', label: 'Solo', modules: ['stream', 'shortcuts'] }];
    await api('PUT', '/api/config', { dock: custom });
    await dom(c, `location.reload(); true`);
    await waitDom(c, `!!document.querySelector('main textarea.code')`, { timeoutMs: 15000 });
    await editor(c);
    assert.deepEqual(await preview(c), custom, 'opening the editor does not change the saved preview');
    assert.equal(await dom(c, `${field('Zona de Alertas')}.value`), 'solo', 'unplaced modules project to the saved last zone');
    await setValue(c, layout, 'split-h');
    assert.equal(await dom(c, `document.querySelectorAll('main input[aria-label^="Nombre de la zona "]').length`), 2);
    await click(c, `${row('shortcuts')}.querySelector('input')`);
    const selected = await dom(c, `${field('Zona de Atajos')}.value`);
    assert.equal(selected, 'solo', 'disabled placement is retained when enabled');
    await setValue(c, field('Zona de Atajos'), await dom(c, `${field('Zona de Atajos')}.options[1].value`));
    const draft = await preview(c);
    assert.equal(draft.layout, 'split-h');
    assert.equal(draft.zones.length, 2);
    assert.ok(draft.zones[1].modules.includes('shortcuts'));
    assert.deepEqual((await api('GET', '/api/config')).dock, custom);
    await save(c);
    assert.deepEqual((await api('GET', '/api/config')).dock, draft);
  });

  await t.test('S3/S5: an existing split edits the two zones actually rendered after empty zones', async () => {
    const custom = structuredClone(DEFAULT_DOCK);
    custom.layout = 'split-h';
    custom.zones[0].modules = [];
    await api('PUT', '/api/config', { dock: custom });
    await dom(c, `location.reload(); true`);
    await waitDom(c, `!!document.querySelector('main textarea.code')`, { timeoutMs: 15000 });
    await editor(c);
    assert.deepEqual(await preview(c), custom);
    assert.deepEqual(await dom(c, `[...document.querySelectorAll('main input[aria-label^="Nombre de la zona "]')].map(x => x.value)`), ['Audio', 'Interactivos']);
    assert.equal(await dom(c, `${field('Zona de Preguntas')}.value`), 'interactivos');
    assert.equal(await dom(c, `${field('Zona de Preguntas')}.selectedOptions[0].disabled`), false);
    await click(c, button('Ancho'));
    await waitDom(c, `!!${frame}.contentDocument?.querySelector('.dock[inert] .d-cols')`, { timeoutMs: 15000 });
    assert.deepEqual(await dom(c, `[...${frame}.contentDocument.querySelectorAll('.d-col-h')].map(e => e.firstChild.textContent.trim())`), ['Audio', 'Interactivos']);
    await setValue(c, field('Nombre de la zona 2'), 'Juegos');
    const draft = await preview(c);
    assert.equal(draft.zones.find(z => z.id === 'interactivos').label, 'Juegos');
    await save(c);
    assert.deepEqual((await api('GET', '/api/config')).dock, draft);
  });
});
