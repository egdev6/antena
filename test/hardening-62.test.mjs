// Issue #62: endurecimiento menor.
// 1) nosniff en respuestas estáticas y JSON. 2) esc() escapa la comilla simple en los tres sitios.
// 3) deepMerge ignora __proto__/constructor/prototype (servidor y app React).
// 4) POST /api/probe con tamaño máximo y esquema mínimo. 5) CSP básica en el HTML de la app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// #105: sin interfaz compilada no hay HTML que auditar; se omite con motivo en vez de fallar.
const existsAppDist = () => stat(path.join(ROOT, 'app/dist/index.html')).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-hardening-62-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await Promise.all([dataDir, mediaDir].map(dir => mkdir(dir)));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ port: 0 }), { flag: 'wx' });
  const { createApp } = await import('../src/server.mjs');
  const app = await createApp({ dataDir, mediaDir, log: () => {} });
  t.after(async () => { await app.closeHttp(); });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

function request(base, reqPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + reqPath, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {} }, resolve);
    req.on('error', reject);
    if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

// ---------- 1) nosniff ----------
test('nosniff en respuestas estáticas y JSON', async t => {
  const { app, base } = await fixture(t);
  await t.test('JSON de la API', async () => {
    const res = await request(base, '/api/status');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    res.resume();
  });
  await t.test('HTML de una página servida', async () => {
    const res = await request(base, '/');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    res.resume();
  });
  await t.test('fichero estático de overlay', async () => {
    const res = await request(base, '/overlay.html');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    res.resume();
  });
});

// ---------- 2) esc() con comilla simple ----------
// Extrae la definición de esc() del fichero y la evalúa: los tres sitios deben escapar '.
const escSources = [
  'public/overlay.html',
  'public/widgets/widget.js',
];
for (const file of escSources) {
  test(`esc() escapa la comilla simple en ${file}`, async () => {
    const src = await readFile(path.join(ROOT, file), 'utf8');
    const m = src.match(/const esc = (s => [^\n]+?);?\s*$/m);
    assert.ok(m, 'se encuentra la definición de esc()');
    const esc = new Function(`return (${m[1]});`)();
    assert.equal(esc("'"), '&#39;');
    assert.equal(esc('a"b<c>&d'), 'a&quot;b&lt;c&gt;&amp;d');
  });
}

// ---------- 3) deepMerge sin prototipos ----------
test('deepMerge del servidor ignora __proto__, constructor y prototype', async () => {
  const { deepMerge } = await import('../src/store.mjs');
  const out = deepMerge({ a: { b: 1 } }, JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"prototype":{"z":3},"a":{"__proto__":{"w":9},"b":2}}'));
  assert.equal(out.a.b, 2);
  assert.equal({}.x, undefined);
  assert.equal(Object.keys(out).sort().join(','), 'a');
  assert.equal(Object.keys(out.a).sort().join(','), 'b');
  assert.equal(Object.prototype.x, undefined);
  assert.equal(Object.prototype.y, undefined);
  assert.equal(Object.prototype.z, undefined);
});

test('deepMerge de la app React (live.ts) ignora __proto__, constructor y prototype', async () => {
  const esbuild = await import('esbuild');
  const ts = await readFile(path.join(ROOT, 'app/src/lib/live.ts'), 'utf8');
  const js = await esbuild.transform(ts, { loader: 'ts', format: 'esm' }).then(r => r.code);
  // Stub de los imports (react, ./api y el contrato de eventos #72): el test solo ejercita deepMerge.
  const stub = js
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]react['"];?/, 'const useSyncExternalStore = () => () => {};')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/api['"];?/, 'const api = async () => ({}); const withKey = (u) => u;')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*events\.mjs['"];?/, 'const warnUnknownClientEvent = () => false;')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/chat-merge\.mjs['"];?/, 'const mergeChat = () => [];')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/draft['"];?/, 'const protectDrafts = state => state; const holding = () => false; const registerDraft = () => () => {};')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"]\.\/manual-draft['"];?/, 'class ManualDraft { constructor(options) { this.pending = options.empty(); } }')
    .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*stream-client\.js['"];?/, 'class AntenaStream {}');
  assert.ok(!/from ['"](react|\.\/api|\.\/draft|\.\/manual-draft|\.\/chat-merge\.mjs|[^'"]*events\.mjs|[^'"]*stream-client\.js)['"]/.test(stub), 'se eliminan los imports');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-stub-'));
  const file = path.join(dir, 'live.mjs');
  await writeFile(file, stub);
  const { deepMerge } = await import(pathToFileURL(file).href);   // en Windows, import() exige file://
  const out = deepMerge({ a: { b: 1 } }, JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2},"a":{"__proto__":{"w":9},"b":2}}'));
  assert.equal(out.a.b, 2);
  assert.equal({}.x, undefined);
  assert.equal(Object.keys(out).sort().join(','), 'a');
  assert.equal(Object.prototype.x, undefined);
  assert.equal(Object.prototype.w, undefined);
});

test('PUT /api/config con __proto__ no contamina ningún objeto', async t => {
  const { app, base } = await fixture(t);
  // Cuerpo crudo: un literal de objeto no puede tener «__proto__» como clave propia.
  const res = await request(base, '/api/config', { method: 'PUT', body: '{"__proto__":{"x":1},"prompter":{"__proto__":{"y":2},"fontSize":30}}' });
  res.resume();
  assert.equal(res.statusCode, 200);
  const cfg = app.store.config;
  assert.equal({}.x, undefined);
  assert.equal(Object.prototype.x, undefined);
  assert.equal(Object.prototype.y, undefined);
  assert.equal(cfg.prompter.fontSize, 30);
  assert.equal('x' in cfg, false);
  assert.equal(Object.keys(cfg.prompter).includes('y'), false);
});

// ---------- 4) POST /api/probe ----------
test('/api/probe acepta un cuerpo válido y guarda el informe', async t => {
  const { app, base } = await fixture(t);
  const res = await request(base, '/api/probe', { method: 'POST', body: { id: 'dock-meld', autoplay: true, codecs: 'h264' } });
  assert.equal(res.statusCode, 200);
  res.resume();
  const saved = JSON.parse(await readFile(path.join(app.store.dir, 'probe.json'), 'utf8'));
  assert.equal(saved['dock-meld'].autoplay, true);
});

test('/api/probe rechaza cuerpos por encima del límite (413)', async t => {
  const { base } = await fixture(t);
  const grande = { id: 'grande', texto: 'x'.repeat(200 * 1024) };
  const res = await request(base, '/api/probe', { method: 'POST', body: grande });
  assert.equal(res.statusCode, 413);
  res.resume();
});

test('/api/probe rechaza cuerpos que no cumplen el esquema mínimo (400)', async t => {
  const { base } = await fixture(t);
  for (const malo of ['"hola"', '[1,2]', '{"id":42}', '{"id":"ok","anidado":{"a":1}}']) {
    const res = await request(base, '/api/probe', { method: 'POST', body: malo });
    assert.equal(res.statusCode, 400, `400 para ${malo}`);
    res.resume();
  }
});

// ---------- 5) CSP en el HTML de la app ----------
// Sin app/dist se omite con motivo claro (#105): el resto del test no cambia.
test('el HTML generado para la app declara una CSP que no rompe el panel', { skip: await existsAppDist() ? false : 'sin app/dist/index.html; compila la interfaz con pnpm app:build para ejecutar la comprobación de CSP' }, async () => {
  const html = await readFile(path.join(ROOT, 'app/dist/index.html'), 'utf8');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
  assert.ok(csp, 'el HTML incluye la meta CSP');
  assert.match(csp, /script-src 'self'/, 'solo scripts propios');
  assert.match(csp, /style-src 'self' 'unsafe-inline'/, 'estilos propios y el <style> del prompter');
  assert.match(csp, /img-src 'self' data: blob: https:\/\/static-cdn\.jtvnw\.net/, 'emotes de Twitch (src/chat.mjs, Prompter.tsx)');
  assert.match(csp, /connect-src 'self' ipc: http:\/\/ipc\.localhost/, 'IPC de Tauri 2 desde la app de escritorio (#61)');
  assert.doesNotMatch(csp, /https:\/\/(?!static-cdn\.jtvnw\.net)/, 'ningún otro origen remoto');
  for (const page of ['prompter.html', 'dock.html']) {
    const other = await readFile(path.join(ROOT, 'app/dist', page), 'utf8');
    assert.match(other, /Content-Security-Policy/, `${page} también lleva CSP`);
  }
});
