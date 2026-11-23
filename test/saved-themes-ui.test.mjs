// S3/S6: the selected theme can be inspected without activating or exposing operational data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { DEFAULT_THEME } from '../src/theme.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-theme-ui-'));
  let app;
  t.after(async () => {
    try {
      if (app) {
        app.interactive.quiesceVoteTimer(); await app.drainAutoSession(); await app.session.flush(); await app.interactive.flush();
        app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const snapshot = async () => ({ bytes: await readFile(path.join(dir, 'config.json'), 'utf8'), status: (await call('GET', '/api/status')).body.persistence });
  return { call, snapshot, dir };
}

// Render the real list and swatch components in memory, with a chosen selection and
// already-loaded public looks; effects and network requests are not needed for this view.
async function renderThemes(t) {
  t.after(() => { stop(); delete globalThis.__themeUi; delete globalThis.__themeUiState; });
  const result = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { Temas } from './app/src/panel/views/Temas';
      export function render(fixture) {
        globalThis.__themeUi = fixture; globalThis.__themeUiState = 0;
        return renderToStaticMarkup(React.createElement(Temas));
      }
    ` },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
    plugins: [{ name: 'themes-view-fixture', setup(b) {
      b.onResolve({ filter: /^react$/ }, args => args.importer.endsWith('/panel/views/Temas.tsx')
        ? { path: 'hooks', namespace: 'theme-fixture' } : null);
      b.onResolve({ filter: /^\.\.\/\.\.\/lib\/themes$/ }, () => ({ path: 'themes', namespace: 'theme-fixture' }));
      b.onResolve({ filter: /^(\.\.\/\.\.\/lib\/live|\.\/live)$/ }, () => ({ path: 'live', namespace: 'theme-fixture' }));
      b.onResolve({ filter: /^(\.\.\/\.\.\/lib\/api|\.\/api)$/ }, () => ({ path: 'api', namespace: 'theme-fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'theme-fixture' }, args => ({ contents: {
        hooks: 'export const useEffect = () => {}; export const useState = value => [globalThis.__themeUiState++ === 0 ? globalThis.__themeUi.chosen : value, () => {}];',
        themes: `export { ThemeSwatch } from ${JSON.stringify(path.resolve('app/src/lib/themes.tsx'))}; export const useThemes = () => globalThis.__themeUi; export const activateTheme = () => {};`,
        live: 'export const useLive = select => select({ config: { widgets: {} }, alertPreviews: {} });',
        api: 'export const get = () => {}; export const post = () => {}; export const put = () => {}; export const del = () => {};',
      }[args.path], loader: 'js', resolveDir: process.cwd() }));
    } }],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
  return chosen => {
    const themes = [{ id: 'normal', name: 'Normal', active: true }, { id: 'navidad', name: 'Navidad', active: false }, { id: 'platform', name: 'Plataformas', active: false }];
    const looks = { normal: { theme: { accent: '#AABBCC', platformAccent: false } }, navidad: { theme: { accent: '#123456', platformAccent: false } }, platform: { theme: { accent: '#FF0036', platformAccent: true } } };
    const html = module.exports.render({ themes, looks, activeId: 'normal', chosen });
    return new Map([...html.matchAll(/<button\b[^>]*data-theme-row="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)].map(m => [m[1], m[2]]));
  };
}

test('theme rows identify the active and selected preview without changing activation', async t => {
  const render = await renderThemes(t);
  let rows = render('navidad');
  assert.match(rows.get('normal'), /<small[^>]*>✓ Activo<\/small>/);
  assert.match(rows.get('navidad'), /<small[^>]*>Vista previa seleccionada<\/small>/);
  assert.doesNotMatch(rows.get('platform'), /Vista previa seleccionada|✓ Activo/);
  rows = render('platform');
  assert.match(rows.get('platform'), /<small[^>]*>Vista previa seleccionada<\/small>/);
  assert.doesNotMatch(rows.get('navidad'), /Vista previa seleccionada|✓ Activo/);
  rows = render('normal');
  assert.match(rows.get('normal'), /<small[^>]*>✓ Activo<\/small>/);
});

test('theme rows use their own accent or a multicolour platform swatch', async t => {
  const render = await renderThemes(t);
  const rows = render('navidad');
  assert.match(rows.get('normal'), /background:#AABBCC/);
  assert.match(rows.get('navidad'), /background:#123456/);
  assert.match(rows.get('platform'), /background:conic-gradient\(/);
});

test('new installs and themes from default use platform colors, old v2 installs keep their historical defaults', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-theme-v2-ui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 2, theme: { accent: '#123456' } }));
  const migrated = await new Store(dir).load();
  assert.equal(migrated.config.theme.platformAccent, false);
  assert.equal(migrated.config.theme.platformBadge, 'text');
  assert.equal(migrated.config.theme.accent, '#123456');
  const disk = JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.theme.platformAccent, false); assert.equal(disk.theme.platformBadge, 'text');
  const prev = { platformAccent: DEFAULT_THEME.platformAccent, platformBadge: DEFAULT_THEME.platformBadge };
  try {
    DEFAULT_THEME.platformAccent = true; DEFAULT_THEME.platformBadge = 'logo';
    const reloaded = await new Store(dir).load();
    assert.equal(reloaded.config.theme.platformAccent, false); assert.equal(reloaded.config.theme.platformBadge, 'text');
  } finally { Object.assign(DEFAULT_THEME, prev); }
  const f = await fixture(t);
  const fresh = await f.call('GET', '/api/theme');
  assert.equal(fresh.status, 200); assert.equal(fresh.body.theme.platformAccent, true); assert.equal(fresh.body.theme.platformBadge, 'logo');
  const made = await f.call('POST', '/api/themes/from-default', { name: 'Plataformas' });
  assert.equal(made.status, 200);
  const look = await f.call('GET', `/api/themes/${made.body.theme.id}/look`);
  assert.equal(look.status, 200); assert.equal(look.body.look.theme.platformAccent, true); assert.equal(look.body.look.theme.platformBadge, 'logo');
});

test('preset API only retains platform look; rejected old presets do not mutate config or persistence', async t => {
  const f = await fixture(t);
  const info = await f.call('GET', '/api/theme');
  assert.deepEqual(info.body.presets.map(p => p.id), ['plataforma']);
  assert.equal((await f.call('PUT', '/api/theme', { accent: '#123456', position: 'top' })).status, 200);
  for (const id of ['egdev', 'cian', 'esmeralda', 'ambar', 'sobrio', 'cristal']) {
    const before = await f.snapshot(), rejected = await f.call('POST', '/api/theme/preset', { id });
    assert.equal(rejected.status, 404, id); assert.equal(rejected.body.error, `No existe el punto de partida «${id}». Hay: plataforma`);
    assert.deepEqual(await f.snapshot(), before, id);
  }
  const platform = await f.call('POST', '/api/theme/preset', { id: 'plataforma' });
  assert.equal(platform.status, 200); assert.equal(platform.body.theme.position, 'center');
  assert.equal(platform.body.theme.platformAccent, true); assert.equal(platform.body.theme.platformBadge, 'logo');
  const reset = await f.call('POST', '/api/theme/reset');
  assert.equal(reset.status, 200); assert.equal(reset.body.theme.platformAccent, true); assert.equal(reset.body.theme.platformBadge, 'logo');
});

test('Stream Deck switches themes through the same atomic activation; missing ids do nothing', async t => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Directo' });
  assert.equal(created.status, 200);
  const before = await f.snapshot();
  const missing = await f.call('GET', '/sd/tema/missing');
  assert.deepEqual(missing, { status: 404, body: { error: 'No existe el tema «missing»' } });
  assert.deepEqual(await f.snapshot(), before);
  const switched = await f.call('GET', `/sd/tema/${created.body.theme.id}`);
  assert.equal(switched.status, 200); assert.equal(switched.body.theme.active, true);
  assert.equal((await f.call('GET', '/api/themes')).body.themes.find(x => x.active).id, created.body.theme.id);
  const back = await f.call('POST', '/sd/tema/normal');
  assert.equal(back.status, 200); assert.equal(back.body.theme.active, true);
  assert.equal((await f.call('GET', '/api/themes')).body.themes.find(x => x.active).id, 'normal');
});

test('look preview is read-only, uses selected stored values, omits actions and private sections, and reports missing ids', async t => {
  const f = await fixture(t);
  const patch = { theme: { accent: '#123456' }, alerts: { follow: { title: 'Hola del tema', text: 'Hola {user}', actions: [{ kind: 'say', text: 'private action marker' }] } }, widgets: { chat: { fontSize: 37 }, goals: [{ id: 'g', title: 'Mi meta', visible: true, showMetric: true, css: '', bars: [{ id: 'b', platform: 'twitch', metric: 'follows', target: 50, visible: true }] }] } };
  assert.equal((await f.call('PUT', '/api/config', patch)).status, 200);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Copia' });
  assert.equal(made.status, 200);
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#abcdef' }, alerts: { follow: { title: 'Actual' } }, widgets: { chat: { fontSize: 21 } } })).status, 200);
  const before = await f.snapshot();
  const inactive = await f.call('GET', `/api/themes/${made.body.theme.id}/look`);
  assert.equal(inactive.status, 200); assert.equal(inactive.body.look.theme.accent, '#123456');
  assert.equal(inactive.body.look.alert.title, 'Hola del tema'); assert.equal(inactive.body.look.goal.title, 'Mi meta'); assert.equal(inactive.body.look.chat.fontSize, 37);
  assert.doesNotMatch(JSON.stringify(inactive.body), /private action marker|"actions"|"commands"|"timers"|"connections"|"youtube"/i);
  const active = await f.call('GET', '/api/themes/normal/look');
  assert.equal(active.status, 200); assert.equal(active.body.look.theme.accent, '#abcdef'); assert.equal(active.body.look.alert.title, 'Actual');
  const missing = await f.call('GET', '/api/themes/missing/look');
  assert.deepEqual(missing, { status: 404, body: { error: 'No existe el tema «missing»' } });
  assert.deepEqual(await f.snapshot(), before);
});
