import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const wait = async predicate => { for (let i = 0; i < 250; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout esperando el estado'); };
const seed = { twitch: { access: 'TWITCH_ACCESS_EXAMPLE', refresh: 'TWITCH_REFRESH_EXAMPLE' }, youtube: { access: 'YOUTUBE_ACCESS_EXAMPLE', refresh: 'YOUTUBE_REFRESH_EXAMPLE' }, obs: { password: 'OBS_PASSWORD_EXAMPLE' } };

async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-transfer-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await mkdir(dataDir);
  const config = path.join(dataDir, 'config.json'), credentials = path.join(dataDir, 'secrets.json');
  await writeFile(config, JSON.stringify({ access: { key: 'LOCAL_KEY_EXAMPLE' }, youtube: { apiKey: 'YOUTUBE_KEY_EXAMPLE', clientSecret: 'CLIENT_SECRET_EXAMPLE' }, ...extra }, null, 2));
  await chmod(config, 0o640);
  await writeFile(credentials, JSON.stringify(seed));
  const app = await createApp({ dataDir, mediaDir, push: {}, log: () => {} });
  t.after(async () => { app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  const ok = async (method, url, body) => { const r = await call(method, url, body); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const snapshot = async () => ({ config: hash(await readFile(config)), credentials: hash(await readFile(credentials)), files: (await readdir(dataDir)).sort(), state: await ok('GET', '/api/config'), persistence: (await ok('GET', '/api/status')).persistence });
  const throwChange = () => {
    const listener = () => { throw new Error('fallo del oyente'); };
    app.store.on('change', listener);
    return () => app.store.off('change', listener);
  };
  const failWrite = async () => {
    const blocker = path.join(root, 'blocker'); await writeFile(blocker, 'x');
    const write = app.store.write;
    app.store.write = function (file, value) {
      this.cfgFile = path.join(blocker, 'config.json');
      try { return write.call(this, this.cfgFile, value); } finally { this.cfgFile = file; }
    };
    return () => { app.store.write = write; };
  };
  const throwOverlay = () => {
    const callback = app.customOverlays.onChange;
    app.customOverlays.onChange = () => { throw new Error('fallo del callback'); };
    return () => { app.customOverlays.onChange = callback; };
  };
  return { base, call, ok, snapshot, config, credentials, dataDir, throwChange, failWrite, throwOverlay };
}

const exp = f => f.ok('GET', '/api/config/export');
const preview = (f, file) => f.call('POST', '/api/config/import/preview', file);
const apply = (f, file) => f.call('POST', '/api/config/import', file);

test('exporta todas las secciones y rutas de medios sin campos ni valores de credenciales', async t => {
  const f = await fixture(t, { twitch: { clientId: 'public-id', accessToken: 'HIDDEN_UNKNOWN_TOKEN' } });
  await f.ok('PUT', '/api/config', { alerts: { follow: { sound: 'campana.mp3', media: 'saludo.webm' } }, overlay: { css: '/* propio */' } });
  const r = await f.call('GET', '/api/config/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="antena-config-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(r.body.format, 'antena-config'); assert.equal(r.body.version, 1);
  assert.match(r.body.exportedAt, /^\d{4}-\d\d-\d\dT/); assert.match(r.body.app, /^\d+\.\d+\.\d+/);
  const state = await f.ok('GET', '/api/config');
  assert.deepEqual(Object.keys(r.body.config).sort(), Object.keys(state).sort());
  assert.equal(r.body.config.alerts.follow.sound, 'campana.mp3'); assert.equal(r.body.config.alerts.follow.media, 'saludo.webm');
  for (const forbidden of ['TWITCH_ACCESS_EXAMPLE', 'TWITCH_REFRESH_EXAMPLE', 'YOUTUBE_ACCESS_EXAMPLE', 'YOUTUBE_REFRESH_EXAMPLE', 'OBS_PASSWORD_EXAMPLE', 'YOUTUBE_KEY_EXAMPLE', 'CLIENT_SECRET_EXAMPLE', 'LOCAL_KEY_EXAMPLE', 'HIDDEN_UNKNOWN_TOKEN', 'apiKey', 'clientSecret', 'accessToken', 'password']) assert.equal(JSON.stringify(r.body).includes(forbidden), false, forbidden);
  assert.equal(r.body.config.twitch.clientId, 'public-id');
});

test('preview informa paths y recuentos sin cambiar archivos, estado ni contadores', async t => {
  const f = await fixture(t);
  await f.ok('PUT', '/api/config', { overlay: { obsolete: true } });
  const file = await exp(f);
  file.config.overlay.volume = 0.9; file.config.overlay.added = true; delete file.config.overlay.obsolete;
  const before = await f.snapshot(), r = await preview(f, file);
  assert.equal(r.status, 200); assert.deepEqual(r.body.summary.overlay, { added: { count: 1, paths: ['overlay.added'] }, removed: { count: 1, paths: ['overlay.obsolete'] }, changed: { count: 1, paths: ['overlay.volume'] } });
  assert.deepEqual(await f.snapshot(), before);
});

test('rechaza formato, versión, valores, tema y credenciales con mensaje exacto y sin mutación', async t => {
  const f = await fixture(t), original = await exp(f), before = await f.snapshot();
  const cases = [
    [file => { file.format = 'otro'; }, 'Formato de configuración no válido'],
    [file => { file.version = 2; }, 'Versión de configuración no compatible'],
    [file => { file.config.tts.rate = 99; }, 'tts.rate: el valor máximo es 2'],
    [file => { file.config.theme.glow = 999; }, 'theme.glow: el valor máximo es 200'],
    [file => { file.config.access.key = 'intruso'; }, 'El archivo contiene credenciales: access.key'],
    [file => { file.config.youtube.apiKey = ''; }, 'El archivo contiene credenciales: youtube.apiKey'],
    [file => { file.config.youtube.clientSecret = 'x'; }, 'El archivo contiene credenciales: youtube.clientSecret'],
    [file => { file.config.obs.password = 'x'; }, 'El archivo contiene credenciales: obs.password'],
    [file => { file.config.twitch.refreshToken = 'x'; }, 'El archivo contiene credenciales: twitch.refreshToken'],
    [file => { file.authorization = 'x'; }, 'El archivo contiene credenciales: authorization'],
    [file => { file.config.meld.url = 'ws://user:pass@localhost/?token=x'; }, 'El archivo contiene credenciales: meld.url'],
    [file => { file.config.widgets.chatVariants = [{ id: 'default' }]; }, 'widgets.chatVariants.0.name: campo obligatorio de la variante'],
  ];
  for (const [mutate, message] of cases) for (const run of [preview, apply]) {
    const file = structuredClone(original); mutate(file); const r = await run(f, file);
    assert.equal(r.status, 400, message); assert.equal(r.body.error, message); assert.deepEqual(await f.snapshot(), before);
  }
});

test('export→import conserva variantes editadas, medios, secciones y credenciales locales', async t => {
  const source = await fixture(t), target = await fixture(t);
  await source.ok('PUT', '/api/config', { overlay: { gapMs: 1200 }, filters: { blockedWords: ['spam'] }, theme: { accent: '#123456' }, alerts: { follow: { sound: 'tono.mp3' } } });
  const v = (await source.ok('POST', '/api/widgets/chat/variants', { name: 'Original' })).variant;
  await source.ok('PUT', `/api/widgets/chat/variants/${v.id}`, { name: 'Renombrada', css: '.chat { color: red }', fontSize: 44 });
  await source.ok('POST', '/api/widgets/chat/variants', { name: 'foo-2001' });
  const long = 'x'.repeat(60);
  const first = (await source.ok('POST', '/api/widgets/chat/variants', { name: long })).variant;
  await source.ok('POST', '/api/widgets/chat/variants', { name: long });
  await source.ok('DELETE', `/api/widgets/chat/variants/${first.id}`);
  const overlay = (await source.ok('POST', '/api/custom-overlays', { name: 'Marco', html: '<b>hola</b>', requestedPermissions: ['chat'] })).overlay;
  await source.ok('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['chat'] });
  await target.ok('POST', '/api/config/set', { path: 'port', value: 4666 });
  const file = await exp(source), before = await readFile(target.config), mode = (await stat(target.config)).mode & 0o777, cred = hash(await readFile(target.credentials));
  const r = await apply(target, file); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await readFile(path.join(target.dataDir, r.body.backup)), before);
  assert.equal((await stat(path.join(target.dataDir, r.body.backup))).mode & 0o777, mode);
  assert.equal(hash(await readFile(target.credentials)), cred);
  const after = await exp(target);
  for (const key of Object.keys(file.config)) if (!['port', 'customOverlays'].includes(key)) assert.deepEqual(after.config[key], file.config[key], key);
  const imported = after.config.customOverlays[0];
  for (const key of ['id', 'name', 'html', 'css', 'js', 'requestedPermissions']) assert.deepEqual(imported[key], file.config.customOverlays[0][key]);
  assert.deepEqual(imported.permissions, []); assert.equal(imported.approvedAt, 0);
  assert.equal((await target.ok('GET', '/api/config')).obs.passwordSet, true);
  assert.equal((await target.ok('GET', '/api/access')).key, 'LOCAL_KEY_EXAMPLE');
  assert.equal((await target.ok('GET', '/api/config')).port, 4666);
  const raw = JSON.parse(await readFile(target.config, 'utf8'));
  assert.equal(raw.youtube.apiKey, 'YOUTUBE_KEY_EXAMPLE'); assert.equal(raw.youtube.clientSecret, 'CLIENT_SECRET_EXAMPLE');
});

test('un oyente que falla tras guardar conserva el nuevo config y su copia, igual que PUT', async t => {
  const put = await fixture(t), unlistenPut = put.throwChange();
  const p = await put.call('PUT', '/api/config', { overlay: { volume: 0.81 } });
  assert.deepEqual({ status: p.status, body: p.body }, { status: 500, body: { error: 'fallo del oyente' } });
  unlistenPut(); assert.equal((await put.ok('GET', '/api/config')).overlay.volume, 0.81);
  assert.equal(JSON.parse(await readFile(put.config, 'utf8')).overlay.volume, 0.81);

  const f = await fixture(t), file = await exp(f), before = await readFile(f.config), credentials = hash(await readFile(f.credentials));
  file.config.overlay.volume = 0.82; const unlisten = f.throwChange();
  const r = await apply(f, file); unlisten();
  assert.deepEqual({ status: r.status, body: r.body }, { status: 500, body: { error: 'fallo del oyente' } });
  assert.equal((await f.ok('GET', '/api/config')).overlay.volume, 0.82);
  assert.equal(JSON.parse(await readFile(f.config, 'utf8')).overlay.volume, 0.82);
  const backups = (await readdir(f.dataDir)).filter(n => n.startsWith('config.backup-'));
  assert.equal(backups.length, 1); assert.deepEqual(await readFile(path.join(f.dataDir, backups[0])), before);
  assert.equal(hash(await readFile(f.credentials)), credentials);
  assert.equal((await f.ok('GET', '/api/status')).persistence.dirty.config, false);
});

test('un fallo de escritura conserva memoria y archivos anteriores sin copia huérfana', async t => {
  const f = await fixture(t), file = await exp(f), before = await f.snapshot(); file.config.overlay.volume = 0.83;
  const restore = await f.failWrite(); const r = await apply(f, file); restore();
  assert.deepEqual({ status: r.status, body: r.body }, { status: 500, body: { error: 'No se pudo guardar la configuración; los cambios permanecen en memoria pendientes de guardado' } });
  const after = await f.snapshot();
  assert.equal(after.config, before.config); assert.equal(after.credentials, before.credentials);
  assert.deepEqual(after.files, before.files); assert.deepEqual(after.state, before.state);
  assert.equal(after.persistence.pending.config, 0); assert.equal(after.persistence.dirty.config, true);
});

test('un callback posterior que falla no deshace el config ya confirmado ni borra su copia', async t => {
  const source = await fixture(t), target = await fixture(t);
  await source.ok('POST', '/api/custom-overlays', { name: 'Marco', html: '<b>prueba</b>' });
  const file = await exp(source), before = await readFile(target.config), credentials = hash(await readFile(target.credentials));
  const restore = target.throwOverlay(); const r = await apply(target, file); restore();
  assert.deepEqual({ status: r.status, body: r.body }, { status: 500, body: { error: 'fallo del callback' } });
  assert.equal((await target.ok('GET', '/api/config')).customOverlays[0].html, '<b>prueba</b>');
  assert.equal(JSON.parse(await readFile(target.config, 'utf8')).customOverlays[0].html, '<b>prueba</b>');
  const backups = (await readdir(target.dataDir)).filter(n => n.startsWith('config.backup-'));
  assert.equal(backups.length, 1); assert.deepEqual(await readFile(path.join(target.dataDir, backups[0])), before);
  assert.equal(hash(await readFile(target.credentials)), credentials);
});

test('conserva credenciales locales en secciones y ramas ausentes o sustituidas', async t => {
  const source = await fixture(t), target = await fixture(t, {
    future: { plugin: { apiKey: 'LOCAL_PLUGIN_KEY', option: true }, items: [{ accessToken: 'LOCAL_PLUGIN_TOKEN' }] },
    otherFuture: { nested: { password: 'LOCAL_PLUGIN_PASSWORD', setting: 'old' } },
  });
  const file = await exp(source); file.config.otherFuture = 'importado';
  const before = hash(await readFile(target.credentials)); const r = await apply(target, file);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const config = await target.ok('GET', '/api/config');
  assert.deepEqual(config.future, { plugin: { apiKey: 'LOCAL_PLUGIN_KEY' }, items: [{ accessToken: 'LOCAL_PLUGIN_TOKEN' }] });
  assert.deepEqual(config.otherFuture, { nested: { password: 'LOCAL_PLUGIN_PASSWORD' } });
  assert.equal(hash(await readFile(target.credentials)), before);
  const portable = JSON.stringify(await exp(target));
  for (const value of ['LOCAL_PLUGIN_KEY', 'LOCAL_PLUGIN_TOKEN', 'LOCAL_PLUGIN_PASSWORD']) assert.equal(portable.includes(value), false);
});

test('el export de un id largo con sufijo superior a 2000 se importa sin perder identidad ni CSS', async t => {
  const initial = await fixture(t), chat = (await initial.ok('GET', '/api/config')).widgets.chat;
  const id = 'x'.repeat(60) + '-2001';
  const source = await fixture(t, { widgets: { chatVariants: [{ ...chat, id, name: 'Renombrada', css: '.mensaje{color:red}' }] } });
  const target = await fixture(t), file = await exp(source);
  assert.equal(file.config.widgets.chatVariants[0].id, id);
  const r = await apply(target, file); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await exp(target)).config.widgets.chatVariants, file.config.widgets.chatVariants);
});

test('la importación sustituye claves, conserva puerto y genera copias locales acotadas', async t => {
  const f = await fixture(t), file = await exp(f); file.config.port = 4321;
  await f.ok('POST', '/api/config/set', { path: 'overlay.obsolete', value: 'quitar' });
  const before = await readFile(f.config);
  let r = await apply(f, file); assert.equal(r.status, 200); assert.deepEqual(await readFile(path.join(f.dataDir, r.body.backup)), before);
  assert.equal((await f.ok('GET', '/api/config')).port, 4500);
  assert.equal(Object.hasOwn((await f.ok('GET', '/api/config')).overlay, 'obsolete'), false);
  for (let i = 0; i < 12; i++) { r = await apply(f, file); assert.equal(r.status, 200); }
  const backups = (await readdir(f.dataDir)).filter(name => /^config\.backup-.*\.json$/.test(name));
  assert.ok(backups.length <= 10 && backups.length > 0); assert.ok(backups.includes(r.body.backup));
});

test('tema y config se reenvían por SSE tras aplicar', async t => {
  const f = await fixture(t), file = await exp(f), ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(f.base + '/api/stream?client=panel', { signal: ctrl.signal });
  const reader = res.body.getReader(), decoder = new TextDecoder(); let text = '';
  const reading = (async () => { try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); } } catch {} })();
  await wait(() => text.includes('event: status'));
  file.config.theme.accent = '#123456'; file.config.chat.twitchChannel = '';
  const r = await apply(f, file); assert.equal(r.status, 200);
  await wait(() => text.includes('event: theme') && text.includes('#123456') && text.includes('event: config'));
  assert.match(await fetch(f.base + '/theme.css').then(r => r.text()), /--red:#123456/);
  ctrl.abort(); await reading;
});

for (const kind of ['meld', 'obs']) test(`${kind}: reconecta solo cuando cambia su configuración`, async t => {
  const fake = kind === 'meld' ? fakeMeld() : fakeObs(); let upgrades = 0;
  const sockets = new Set(); fake.server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  fake.server.on('upgrade', () => upgrades++); await listen(fake.server);
  t.after(async () => { for (const s of sockets) s.destroy(); if (kind === 'obs') await fake.close(); else await new Promise(r => fake.server.close(r)); });
  const f = await fixture(t), url = `ws://127.0.0.1:${fake.server.address().port}`;
  await f.ok('PUT', '/api/config', kind === 'meld' ? { meld: { enabled: true, url } } : { program: { kind: 'obs' }, obs: { url } });
  await wait(() => upgrades === 1); const file = await exp(f);
  file.config.overlay.volume = 0.8; assert.equal((await apply(f, file)).status, 200);
  await new Promise(r => setTimeout(r, 150)); assert.equal(upgrades, 1);
  file.config[kind].url = url + '?profile=two'; assert.equal((await apply(f, file)).status, 200);
  await wait(() => upgrades === 2);
});

test('MCP exporta y previsualiza por defecto; confirmar aplica', async t => {
  const f = await fixture(t), child = spawn(process.execPath, ['src/mcp.mjs'], { env: { PATH: process.env.PATH, ANTENA_URL: f.base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout }); let id = 0;
  t.after(async () => { child.stdin.end(); await new Promise(r => child.once('close', r)); });
  const rpc = async (method, params = {}) => {
    const result = new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'); return result;
  };
  const call = async (name, args = {}) => { const result = (await rpc('tools/call', { name, arguments: args })).result; assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const tools = (await rpc('tools/list')).result.tools;
  assert.ok(tools.some(x => x.name === 'exportar_configuracion')); assert.ok(tools.some(x => x.name === 'importar_configuracion'));
  const file = await call('exportar_configuracion'); file.config.overlay.volume = 0.77;
  const before = await f.snapshot(); const seen = await call('importar_configuracion', { archivo: file });
  assert.deepEqual(seen.summary.overlay.changed, { count: 1, paths: ['overlay.volume'] }); assert.deepEqual(await f.snapshot(), before);
  const applied = await call('importar_configuracion', { archivo: file, confirmar: true }); assert.ok(applied.backup);
  assert.equal((await f.ok('GET', '/api/config')).overlay.volume, 0.77);
});

test('PUT y config/set existentes mantienen su comportamiento', async t => {
  const f = await fixture(t);
  assert.equal((await f.ok('PUT', '/api/config', { overlay: { volume: 0.8 } })).config.overlay.volume, 0.8);
  assert.deepEqual(await f.ok('POST', '/api/config/set', { path: 'tts.rate', value: 1.25 }), { path: 'tts.rate', value: 1.25 });
});
