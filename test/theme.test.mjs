// Apariencia: validación del tema, hoja /theme.css y su llegada a overlay y widgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, PRESETS, cleanTheme, themeCss, publicTheme } from '../src/theme.mjs';
import { createApp } from '../src/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('cleanTheme: valida colores, enums, rangos, fuentes e iconos', () => {
  const t = cleanTheme({ accent: '#00d1ff', glow: 999, animation: 'slide', icons: { follow: 'emoji:💙', sub: 'crown' }, fontDisplay: 'impact' });
  assert.equal(t.accent, '#00D1FF');
  assert.equal(t.glow, 200);
  assert.equal(t.animation, 'slide');
  assert.deepEqual(t.icons, { follow: 'emoji:💙', sub: 'crown' });
  assert.equal(cleanTheme({ icons: { follow: null } }, t).icons.follow, undefined);
  assert.throws(() => cleanTheme({ accent: 'rojo' }), /#RRGGBB/);
  assert.throws(() => cleanTheme({ animation: 'girar' }), /uno de/);
  assert.throws(() => cleanTheme({ fontBody: 'Comic' }), /fuente desconocida/);
  assert.throws(() => cleanTheme({ icons: { follow: '<svg>' } }), /icono desconocido/);
  assert.throws(() => cleanTheme({ nada: 1 }), /desconocido/);
  assert.equal(cleanTheme({ fontBody: 'media:Mi Fuente.woff2' }).fontBody, 'media:Mi Fuente.woff2');
  for (const [id, p] of Object.entries(PRESETS)) assert.doesNotThrow(() => cleanTheme(p.theme), id);
});

test('themeCss: capa egdev-theme después de egdev, variables y reglas opcionales', () => {
  const base = themeCss(DEFAULT_THEME);
  assert.match(base, /^\/\*.*\n@layer egdev, egdev-theme;/);
  assert.match(base, /--red:#FF0036/);
  assert.doesNotMatch(base, /--surface-border/);   // borde del acento
  const css = themeCss({ ...DEFAULT_THEME, tilt: false, uppercase: false, platformAccent: true, surfaceStyle: 'glass', animation: 'pop', fontDisplay: 'media:Gordita.woff2', border: '#FFFFFF' });
  assert.match(css, /--tilt:rotate\(0deg\)/);
  assert.match(css, /text-transform:none/);
  assert.match(css, /\.pf-twitch\{--red:#9146FF/);
  assert.match(css, /backdrop-filter/);
  assert.match(css, /@keyframes enter/);
  assert.match(css, /@font-face\{font-family:'EGU Gordita'/);
  assert.match(css, /--surface-border:#FFFFFF/);
  assert.notEqual(publicTheme(DEFAULT_THEME).version, publicTheme({ ...DEFAULT_THEME, accent: '#000000' }).version);
});

test('todas las capas del directo cargan /theme.css; el teleprompter no', async () => {
  const dir = path.join(ROOT, 'public/widgets');
  for (const f of (await readdir(dir)).filter(f => f.endsWith('.html'))) {
    const html = await readFile(path.join(dir, f), 'utf8');
    if (f === 'teleprompter.html') assert.doesNotMatch(html, /theme\.css/, f);
    else assert.match(html, /<link href="\/theme\.css" rel="stylesheet" id="eg-theme">/, f);
  }
  assert.match(await readFile(path.join(ROOT, 'public/overlay.html'), 'utf8'), /id="eg-theme"/);
  // sin rojos de marca fijos en las capas: todo sale de las variables del tema
  for (const f of ['overlay.html', 'widgets/widget.css', 'widgets/chat.html', 'widgets/goal.html', 'widgets/ticker.html', 'widgets/question.html', 'widgets/giveaway.html', 'widgets/tierlist.html', 'widgets/credits.html', 'widgets/latest.html']) {
    const src = await readFile(path.join(ROOT, 'public', f), 'utf8');
    assert.doesNotMatch(src, /rgba\(255, ?0, ?54/, f);
  }
});

test('API del tema: cambiar, punto de partida, importar, restaurar, /theme.css y SSE', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-theme-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; };
  const ctrl = new AbortController();
  try {
    const info = await call('GET', '/api/theme');
    assert.equal(info.theme.accent, '#FF0036');
    assert.ok(info.fonts.some(f => f.id === 'egdev-cond'));
    // un overlay recibe el tema al conectarse y cada cambio
    const r = await fetch(base + '/api/stream?client=overlay', { signal: ctrl.signal });
    const reader = r.body.getReader(); let text = '';
    const until = async re => { for (let i = 0; i < 40 && !re.test(text); i++) text += new TextDecoder().decode((await reader.read()).value); };
    await until(/event: theme/);
    assert.match(text, /event: theme\ndata: \{"accent":"#FF0036"/);
    const d = await call('PUT', '/api/theme', { accent: '#18E08B', position: 'top' });
    assert.equal(d.theme.accent, '#18E08B');
    await until(/#18E08B/);
    const css = await fetch(base + '/theme.css').then(x => { assert.equal(x.headers.get('cache-control'), 'no-store'); return x.text(); });
    assert.match(css, /--red:#18E08B/);
    await assert.rejects(call('PUT', '/api/theme', { accent: 'verde' }), /#RRGGBB/);
    assert.equal((await call('POST', '/api/theme/preset', { id: 'cian' })).theme.accent, '#00D1FF');
    assert.equal((await call('POST', '/api/theme/preset', { id: 'cian' })).theme.position, 'center');   // sustituye, no mezcla
    assert.equal((await call('POST', '/api/theme/import', { theme: { accent: '#123456' } })).theme.glow, 100);
    assert.equal((await call('POST', '/api/theme/reset')).theme.accent, '#FF0036');
    assert.equal(app.store.config.theme.accent, '#FF0036');
  } finally { ctrl.abort(); app.teleprompter.stop(); app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); }
});
