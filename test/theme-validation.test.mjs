// #151: el tema se valida con las mismas reglas en TODAS las vías de escritura (PUT /api/config,
// POST /api/config/set, PUT /api/theme y la carga de un config.json editado a mano) y /theme.css
// no emite nunca un valor sin validar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { DEFAULT_THEME, themeCss } from '../src/theme.mjs';

const INYECTADO = 'red}body{display:none';
const FUENTE_MALA = "media:x.woff2');}*{background:url(http://evil.example/x)";

/** App real en un dataDir temporal (mismo patrón que test/theme.test.mjs). */
async function fixture(config) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-theme-val-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  if (config) await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config));
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  const css = () => fetch(base + '/theme.css').then(r => r.text());
  const configFile = path.join(dataDir, 'config.json');
  const saved = () => readFile(configFile, 'utf8').catch(() => '');
  const stop = async () => {
    app.teleprompter.stop(); app.viewers.stop(); app.meld.stop();
    app.server.closeAllConnections();
    await new Promise(r => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  };
  return { app, base, call, css, configFile, saved, stop };
}

test('PUT /api/config rechaza un tema inyectado con 400, sin tocar /api/theme, /theme.css ni el SSE', async () => {
  const { base, call, css, saved, stop } = await fixture();
  const ctrl = new AbortController();
  try {
    const antes = (await call('GET', '/api/theme')).body.theme;
    const cssAntes = await css();
    const jsonAntes = await saved();
    const r = await fetch(base + '/api/stream?client=overlay', { signal: ctrl.signal });
    const reader = r.body.getReader();
    let text = '';
    const until = async re => { for (let i = 0; i < 60 && !re.test(text); i++) text += new TextDecoder().decode((await reader.read()).value); };
    await until(/event: theme/);   // el tema de serie al conectar
    const res = await call('PUT', '/api/config', { theme: { accent: INYECTADO } });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /#RRGGBB/);
    assert.match(res.body.error, /theme\.accent/);
    assert.deepEqual((await call('GET', '/api/theme')).body.theme, antes, 'GET /api/theme no cambia');
    assert.equal(await css(), cssAntes, '/theme.css no cambia');
    assert.doesNotMatch(await css(), /display:none/);
    assert.equal(await saved(), jsonAntes, 'config.json no cambia');
    // tras un rechazo, la siguiente escritura válida llega sola: el tema inyectado no salió por SSE
    assert.equal((await call('PUT', '/api/config', { theme: { accent: '#00AA00' } })).status, 200);
    await until(/#00AA00/);
    assert.doesNotMatch(text, /display:none/);
  } finally { ctrl.abort(); await stop(); }
});

test('POST /api/config/set rechaza el tema inválido por ruta con 400 y sin cambios', async () => {
  const { call, css, saved, stop } = await fixture();
  try {
    const antes = (await call('GET', '/api/theme')).body.theme;
    const cssAntes = await css();
    const jsonAntes = await saved();
    const intentos = [
      ['theme.accent', INYECTADO, /#RRGGBB/],
      ['theme.icons.follow', '<svg onload=alert(1)>', /icono desconocido/],
      ['theme.fontDisplay', FUENTE_MALA, /fuente desconocida/],
      ['theme.surfaceOpacity', 500, /el valor máximo es 100/],
      // bajar por debajo de un campo del tema lo convertiría en objeto (el overlay espera texto)
      ['theme.accent.x', INYECTADO, /no admite subcampos/],
      ['theme.icons.follow.x', '<b>', /no admite subcampos/],
      // el tema entero por ruta valida igual que PUT /api/config
      ['theme', { accent: INYECTADO }, /#RRGGBB/],
    ];
    for (const [ruta, value, motivo] of intentos) {
      const res = await call('POST', '/api/config/set', { path: ruta, value });
      assert.equal(res.status, 400, `${ruta}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, motivo, ruta);
      assert.match(res.body.error, new RegExp(ruta.replace(/\./g, '\\.')), `${ruta}: el mensaje nombra la ruta`);
    }
    assert.deepEqual((await call('GET', '/api/theme')).body.theme, antes, 'el tema no cambia');
    assert.equal(await css(), cssAntes, '/theme.css no cambia');
    assert.equal(await saved(), jsonAntes, 'config.json no cambia');
  } finally { await stop(); }
});

test('config.json a mano: el campo inválido vuelve a su default, lo válido se queda y /theme.css sale limpio', async () => {
  const avisos = [];
  const originalWarn = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  let f;
  try {
    f = await fixture({ theme: { accent: INYECTADO, fontDisplay: FUENTE_MALA, glow: 42, icons: { follow: 'crown', sub: '<svg>' } } });
  } finally { console.warn = originalWarn; }
  try {
    assert.equal(f.app.store.config.theme.accent, DEFAULT_THEME.accent, 'accent vuelve al de serie');
    assert.equal(f.app.store.config.theme.fontDisplay, DEFAULT_THEME.fontDisplay, 'fontDisplay vuelve al de serie');
    assert.equal(f.app.store.config.theme.glow, 42, 'lo válido se conserva');
    assert.deepEqual(f.app.store.config.theme.icons, { follow: 'crown' }, 'el icono válido se conserva y el inválido no');
    const css = await f.css();
    assert.doesNotMatch(css, /display:none|evil\.example/);
    assert.match(css, /--red:#FF0036/);
  } finally { await f.stop(); }
});

test('PUT /api/theme rechaza los rangos con el mensaje del esquema; import sigue recortando', async () => {
  const { call, css, saved, stop } = await fixture();
  try {
    const antes = (await call('GET', '/api/theme')).body.theme;
    const cssAntes = await css();
    const jsonAntes = await saved();
    // hoy PUT /api/theme recorta (glow 999 -> 200) en vez de rechazar
    for (const [campo, value, motivo] of [
      ['glow', 999, /glow: el valor máximo es 200/],
      ['offsetX', -9999, /offsetX: el valor mínimo es -960/],
      ['alertWidth', 99, /alertWidth: el valor mínimo es 400/],
    ]) {
      const res = await call('PUT', '/api/theme', { [campo]: value });
      assert.equal(res.status, 400, `${campo}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, motivo, campo);
    }
    assert.deepEqual((await call('GET', '/api/theme')).body.theme, antes, 'el tema no cambia');
    assert.equal(await css(), cssAntes, '/theme.css no cambia');
    assert.equal(await saved(), jsonAntes, 'config.json no cambia');
    // la importación de temas exportados antiguos sigue recortando, no rechaza
    const imp = await call('POST', '/api/theme/import', { theme: { glow: 999, accent: '#123456' } });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.equal(imp.body.theme.glow, 200, 'import recorta al máximo');
  } finally { await stop(); }
});

test('config/set con la sección theme entera se valida campo a campo', async () => {
  const { call, stop } = await fixture();
  try {
    const antes = (await call('GET', '/api/theme')).body.theme;
    const mala = await call('POST', '/api/config/set', { path: 'theme', value: { ...antes, accent: 'rojo' } });
    assert.equal(mala.status, 400, JSON.stringify(mala.body));
    assert.match(mala.body.error, /theme\.accent: usa un color #RRGGBB/);
    const fuera = await call('POST', '/api/config/set', { path: 'theme', value: { ...antes, glow: 999 } });
    assert.equal(fuera.status, 400, JSON.stringify(fuera.body));
    assert.match(fuera.body.error, /theme\.glow: el valor máximo es 200/);
    assert.deepEqual((await call('GET', '/api/theme')).body.theme, antes, 'el tema no cambia');
  } finally { await stop(); }
});

test('PUT /api/theme rechaza claves de icono inseguras (__proto__, espacios, signos) con 400', async () => {
  const { call, css, saved, stop } = await fixture();
  try {
    const antes = (await call('GET', '/api/theme')).body.theme;
    const cssAntes = await css();
    const jsonAntes = await saved();
    const mapas = [{ ['__proto__']: 'heart' }, { 'a b': 'heart' }, { 'x);': 'heart' }, { constructor: 'heart' }];
    for (const mapa of mapas) {
      const res = await call('PUT', '/api/theme', { icons: mapa });
      assert.equal(res.status, 400, JSON.stringify(Object.keys(mapa)));
      assert.match(res.body.error, /icons\.|nombre de tipo/);
    }
    assert.equal(Object.prototype.heart, undefined, 'nada se cuela en el prototipo');
    assert.deepEqual((await call('GET', '/api/theme')).body.theme, antes, 'el tema no cambia');
    assert.equal(await css(), cssAntes, '/theme.css no cambia');
    assert.equal(await saved(), jsonAntes, 'config.json no cambia');
    // y un tipo normal sigue valiendo
    assert.equal((await call('PUT', '/api/theme', { icons: { follow: 'crown' } })).status, 200);
    assert.equal((await call('GET', '/api/theme')).body.theme.icons.follow, 'crown');
  } finally { await stop(); }
});

test('themeCss no emite nunca un valor sin validar y escapa la url() de @font-face', async () => {
  const { escapeCssUrl } = await import('../src/theme.mjs');
  const crudo = themeCss({ accent: INYECTADO, surface: 'verde};', glow: 'mucho', fontDisplay: FUENTE_MALA, icons: { ['__proto__']: 'heart' } });
  assert.doesNotMatch(crudo, /display:none/);
  assert.doesNotMatch(crudo, /evil\.example/);
  assert.doesNotMatch(crudo, /verde\}/);
  assert.match(crudo, /--red:#FF0036/, 'lo inválido cae al valor de serie');
  // los paréntesis también pueden cerrar la cadena url('…'): se escapan
  const cara = themeCss({ fontDisplay: 'media:a(b).woff2' }).split('\n').find(l => l.startsWith('@font-face'));
  assert.ok(cara, 'sale la @font-face');
  assert.doesNotMatch(cara, /a\(b\)/);
  assert.match(cara, /a\\28 b\\29 /);
  assert.equal(escapeCssUrl("'"), '\\27 ');
  assert.equal(escapeCssUrl('"'), '\\22 ');
  assert.equal(escapeCssUrl('('), '\\28 ');
  assert.equal(escapeCssUrl(')'), '\\29 ');
  assert.equal(escapeCssUrl('\\'), '\\5c ');
  assert.equal(escapeCssUrl('\n'), '\\a ');
  assert.equal(escapeCssUrl('Gordita.woff2'), 'Gordita.woff2');
});

test('las escrituras válidas del tema siguen funcionando por todas las vías', async () => {
  const { app, call, css, stop } = await fixture();
  try {
    assert.equal((await call('PUT', '/api/config', { theme: { accent: '#18E08B' } })).status, 200);
    assert.match(await css(), /--red:#18E08B/);
    assert.equal((await call('POST', '/api/config/set', { path: 'theme.accent', value: '#00D1FF' })).status, 200);
    assert.match(await css(), /--red:#00D1FF/);
    assert.equal((await call('POST', '/api/config/set', { path: 'theme.icons.follow', value: 'crown' })).status, 200);
    assert.equal(app.store.getPath('theme.icons.follow'), 'crown');
    assert.equal((await call('POST', '/api/config/set', { path: 'theme.fontDisplay', value: 'impact' })).status, 200);
    assert.match(await css(), /--f-cond:Impact/);
    assert.equal((await call('PUT', '/api/theme', { accent: '#FFB21E', icons: { follow: 'gift' } })).status, 200);
    const info = await call('GET', '/api/theme');
    assert.equal(info.body.theme.accent, '#FFB21E');
    assert.equal(info.body.theme.icons.follow, 'gift');
    assert.match(await css(), /--red:#FFB21E/);
  } finally { await stop(); }
});

test('claves heredadas del prototipo no cuentan como fuente ni como punto de partida', async () => {
  const { call, css, saved, stop } = await fixture();
  try {
    const antes = (await call('GET', '/api/theme')).body.theme;
    const cssAntes = await css();
    const jsonAntes = await saved();
    for (const f of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const res = await call('PUT', '/api/theme', { fontDisplay: f });
      assert.equal(res.status, 400, `fontDisplay ${f}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /fuente desconocida/, f);
      const porRuta = await call('POST', '/api/config/set', { path: 'theme.fontBody', value: f });
      assert.equal(porRuta.status, 400, `theme.fontBody ${f}`);
      const preset = await call('POST', '/api/theme/preset', { id: f });
      assert.equal(preset.status, 404, `preset ${f}: ${JSON.stringify(preset.body)}`);
      assert.match(preset.body.error, /No existe el punto de partida/, f);
    }
    assert.deepEqual((await call('GET', '/api/theme')).body.theme, antes, 'el tema no cambia');
    assert.equal(await css(), cssAntes, '/theme.css no cambia');
    assert.equal(await saved(), jsonAntes, 'config.json no cambia');
    assert.doesNotMatch(themeCss({ ...DEFAULT_THEME, fontDisplay: 'constructor', fontBody: 'toString' }), /undefined/);
  } finally { await stop(); }
});
