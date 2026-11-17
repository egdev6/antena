import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Store } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

const legacyGoal = { id: 'eventos', title: 'Eventos', metric: 'events', target: 7, css: '.meta{}' };
const convertedGoal = { id: 'eventos', title: 'Eventos', visible: true, showMetric: true, css: '.meta{}', bars: [
  { id: 'eventos-tw', platform: 'twitch', metric: 'events', target: 7, visible: true },
  { id: 'eventos-yt', platform: 'youtube', metric: 'events', target: 7, visible: true },
] };
const backupNames = async dir => (await readdir(dir)).filter(name => name.startsWith('config.backup-'));

async function storeFixture(t, data) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const bytes = JSON.stringify(data, null, 1) + '\n';
  await writeFile(file, bytes); await chmod(file, 0o640);
  return { dir, file, bytes, store: new Store(dir) };
}

async function appFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-version-api-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await mkdir(dataDir);
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ access: { key: 'VERSION_TEST_KEY' } }));
  let app;
  t.after(async () => {
    try {
      if (app) {
        await app.drainAutoSession(); await app.session.flush();
        app.teleprompter.stop(); app.viewers.stop(); app.timers.stop();
        await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  app = await createApp({ dataDir, mediaDir, push: {}, log: () => {} });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = async () => ({ config: await call('GET', '/api/config'), status: (await call('GET', '/api/status')).body.persistence,
    bytes: await readFile(path.join(dataDir, 'config.json'), 'utf8'), files: (await readdir(dataDir)).sort() });
  return { base, call, snapshot, dataDir };
}

test('las migraciones ordenadas son puras e idempotentes y conservan la conversión de objetivos', async () => {
  const { MIGRATIONS } = await import('../src/config-migrations.mjs');
  assert.deepEqual(MIGRATIONS.map(step => step.to), [1, 2]);
  const goalInput = { widgets: { goals: [legacyGoal] }, other: { keep: true } };
  const beforeGoal = structuredClone(goalInput);
  const first = MIGRATIONS[0].up(goalInput);
  assert.deepEqual(goalInput, beforeGoal);
  assert.deepEqual(first.widgets.goals, [convertedGoal]);
  assert.deepEqual(first.other, { keep: true });
  assert.deepEqual(MIGRATIONS[0].up(first), first);
  const settingsInput = { program: { kind: 'obs' }, meld: { enabled: false, autoSession: false, recordOnStart: true } };
  const beforeSettings = structuredClone(settingsInput);
  const second = MIGRATIONS[1].up(settingsInput);
  assert.deepEqual(settingsInput, beforeSettings);
  assert.deepEqual(second, { program: { kind: 'obs', autoSession: false, recordOnStart: true }, meld: { enabled: false } });
  assert.deepEqual(MIGRATIONS[1].up(second), second);
});

test('un archivo antiguo con objetivos se migra una vez y conserva la copia exacta anterior', async t => {
  const f = await storeFixture(t, { widgets: { goals: [legacyGoal] } });
  const events = []; f.store.on('persistence', state => events.push(state.pending.config));
  await f.store.load();
  assert.equal(f.store.config.configVersion, 2);
  assert.deepEqual(f.store.config.widgets.goals, [convertedGoal]);
  assert.deepEqual(events, [1, 0]);
  const disk = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(disk.configVersion, 2); assert.deepEqual(disk.widgets.goals, [convertedGoal]);
  const backups = await backupNames(f.dir); assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(f.dir, backups[0]), 'utf8'), f.bytes);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(f.dir, backups[0]))).mode & 0o777, 0o640);
  const saved = await readFile(f.file, 'utf8');
  const reloaded = await new Store(f.dir).load();
  assert.deepEqual(reloaded.config.widgets.goals, [convertedGoal]);
  assert.equal(await readFile(f.file, 'utf8'), saved); assert.deepEqual(await backupNames(f.dir), backups);
});

test('un archivo versión 1 mueve ambos ajustes a program y mantiene las demás claves', async t => {
  const f = await storeFixture(t, { configVersion: 1, program: { kind: 'obs' }, meld: { enabled: false, url: 'ws://localhost:1234', autoSession: false, recordOnStart: true } });
  await f.store.load();
  assert.deepEqual(f.store.config.program, { kind: 'obs', autoSession: false, recordOnStart: true });
  assert.deepEqual(f.store.config.meld, { enabled: false, url: 'ws://localhost:1234' });
  const disk = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(disk.configVersion, 2); assert.deepEqual(disk.program, f.store.config.program);
  assert.deepEqual(disk.meld, f.store.config.meld);
  const backups = await backupNames(f.dir); assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(f.dir, backups[0]), 'utf8'), f.bytes);
  const bytes = await readFile(f.file, 'utf8'); await new Store(f.dir).load();
  assert.equal(await readFile(f.file, 'utf8'), bytes); assert.deepEqual(await backupNames(f.dir), backups);
});

test('una configuración sin cambios no se reescribe ni respalda; el siguiente guardado añade la versión', async t => {
  const f = await storeFixture(t, { overlay: { volume: 0.7 } });
  await f.store.load();
  assert.equal(f.store.config.configVersion, 2);
  assert.equal(f.store.config.program.autoSession, true); assert.equal(f.store.config.program.recordOnStart, false);
  assert.equal(await readFile(f.file, 'utf8'), f.bytes); assert.deepEqual(await backupNames(f.dir), []);
  await f.store.setPath('paused', true);
  const disk = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(disk.configVersion, 2); assert.equal(disk.paused, true); assert.deepEqual(await backupNames(f.dir), []);
});

test('configVersion solo admite enteros no negativos y rechaza null sin guardar', async t => {
  const f = await appFixture(t), before = await f.snapshot();
  for (const [value, message] of [[null, 'se esperaba un número'], ['2', 'se esperaba un número'], [1.5, 'se esperaba un número entero'], [-1, 'el valor mínimo es 0']]) {
    for (const [method, url, body] of [
      ['PUT', '/api/config', { configVersion: value }],
      ['POST', '/api/config/set', { path: 'configVersion', value }],
    ]) {
      assert.deepEqual(await f.call(method, url, body), { status: 400, body: { error: `configVersion: ${message}` } });
      assert.deepEqual(await f.snapshot(), before);
    }
  }
});

test('una versión futura se carga con aviso sin migrar ni reescribir el archivo', async t => {
  const f = await storeFixture(t, { configVersion: 99, meld: { autoSession: false, recordOnStart: true }, future: { keep: 42 } });
  const warnings = [], warn = console.warn;
  try { console.warn = (...args) => warnings.push(args.join(' ')); await f.store.load(); }
  finally { console.warn = warn; }
  assert.equal(f.store.config.configVersion, 99); assert.deepEqual(f.store.config.future, { keep: 42 });
  assert.equal(f.store.config.meld.autoSession, false); assert.equal(f.store.config.meld.recordOnStart, true);
  assert.ok(warnings.some(message => /configVersion|versión/i.test(message) && message.includes('99')), warnings.join('\n'));
  assert.equal(await readFile(f.file, 'utf8'), f.bytes); assert.deepEqual(await backupNames(f.dir), []);
});

test('PUT acepta ambos nombres antiguos y guarda únicamente los nuevos', async t => {
  const f = await appFixture(t);
  const response = await f.call('PUT', '/api/config', { meld: { autoSession: false, recordOnStart: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.config.program, { kind: 'meld', autoSession: false, recordOnStart: true });
  assert.equal(Object.hasOwn(response.body.config.meld, 'autoSession'), false);
  assert.equal(Object.hasOwn(response.body.config.meld, 'recordOnStart'), false);
  const disk = JSON.parse(await readFile(path.join(f.dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(disk.program, response.body.config.program);
  assert.equal(Object.hasOwn(disk.meld, 'autoSession'), false); assert.equal(Object.hasOwn(disk.meld, 'recordOnStart'), false);
});

test('config/set admite las rutas antiguas y sus puntos equivalentes sin guardar claves Meld', async t => {
  const f = await appFixture(t);
  for (const [p, canonical, value] of [['meld.autoSession', 'program.autoSession', false], ['meld..recordOnStart', 'program.recordOnStart', true]]) {
    assert.deepEqual(await f.call('POST', '/api/config/set', { path: p, value }), { status: 200, body: { path: p, value } });
    assert.deepEqual(await f.call('GET', `/api/config?path=${canonical}`), { status: 200, body: { path: canonical, value } });
    assert.deepEqual(await f.call('GET', `/api/config?path=${p}`), { status: 200, body: { path: p, value } });
  }
  const config = (await f.call('GET', '/api/config')).body;
  assert.equal(Object.hasOwn(config.meld, 'autoSession'), false); assert.equal(Object.hasOwn(config.meld, 'recordOnStart'), false);
});

test('config/set acepta los ajustes antiguos dentro de la sección Meld completa', async t => {
  const f = await appFixture(t);
  const value = { enabled: false, url: 'ws://localhost:13376', autoSession: false, recordOnStart: true };
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'meld', value }),
    { status: 200, body: { path: 'meld', value: { enabled: false, url: value.url } } });
  const config = (await f.call('GET', '/api/config')).body;
  assert.deepEqual(config.program, { kind: 'meld', autoSession: false, recordOnStart: true });
  const disk = JSON.parse(await readFile(path.join(f.dataDir, 'config.json'), 'utf8'));
  assert.deepEqual(disk.program, config.program); assert.deepEqual(disk.meld, { enabled: false, url: value.url });
});

test('un cambio por alias publica program en el SSE y conserva ese estado en el siguiente evento', async t => {
  const f = await appFixture(t), ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const response = await fetch(f.base + '/api/stream?client=panel', { signal: ctrl.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
  const nextConfig = async () => {
    for (;;) {
      const end = text.indexOf('\n\n');
      if (end >= 0) {
        const frame = text.slice(0, end); text = text.slice(end + 2);
        if (frame.startsWith('event: config\n')) return JSON.parse(frame.split('\ndata: ')[1]);
      } else {
        const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value);
      }
    }
  };
  assert.equal((await f.call('PUT', '/api/config', { meld: { autoSession: false, recordOnStart: true } })).status, 200);
  let event = await nextConfig();
  assert.deepEqual(event.program, { kind: 'meld', autoSession: false, recordOnStart: true });
  assert.equal((await f.call('PUT', '/api/config', { chat: { sendTo: 'youtube' } })).status, 200);
  event = await nextConfig();
  assert.equal(event.chat.sendTo, 'youtube'); assert.deepEqual(event.program, { kind: 'meld', autoSession: false, recordOnStart: true });
  await reader.cancel(); ctrl.abort();
});

test('los alias inválidos se rechazan con el mensaje previo y sin cambiar datos ni contadores', async t => {
  const f = await appFixture(t), before = await f.snapshot();
  for (const [method, body, message] of [
    ['PUT', { meld: { autoSession: 'sí' } }, 'meld.autoSession: se esperaba true o false'],
    ['PUT', { meld: { recordOnStart: null } }, 'meld.recordOnStart: se esperaba true o false'],
    ['POST', { path: 'meld.autoSession', value: 1 }, 'meld.autoSession: se esperaba true o false'],
    ['POST', { path: 'meld.recordOnStart', value: null }, 'meld.recordOnStart: se esperaba true o false'],
  ]) {
    assert.deepEqual(await f.call(method, method === 'PUT' ? '/api/config' : '/api/config/set', body), { status: 400, body: { error: message } });
    assert.deepEqual(await f.snapshot(), before);
  }
});

test('MCP cambiar_config y fijar_valor aceptan los nombres antiguos', async t => {
  const f = await appFixture(t);
  const child = spawn(process.execPath, ['src/mcp.mjs'], { env: { PATH: process.env.PATH, ANTENA_URL: f.base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout }); let id = 0, stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null }); assert.equal(stderr, ''); });
  const rpc = async (method, params) => {
    const response = new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
    return response;
  };
  const tool = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    assert.equal(response.result.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  const changed = await tool('cambiar_config', { cambios: { meld: { autoSession: false } } });
  assert.equal(changed.config.program.autoSession, false);
  assert.deepEqual(await tool('fijar_valor', { ruta: 'meld.recordOnStart', valor: true }), { path: 'meld.recordOnStart', value: true });
  const config = (await f.call('GET', '/api/config')).body;
  assert.equal(config.program.autoSession, false); assert.equal(config.program.recordOnStart, true);
  assert.equal(Object.hasOwn(config.meld, 'autoSession'), false); assert.equal(Object.hasOwn(config.meld, 'recordOnStart'), false);
});

test('un export antiguo se previsualiza e importa con la misma migración y una copia previa', async t => {
  const f = await appFixture(t);
  const file = (await f.call('GET', '/api/config/export?format=json')).body;
  delete file.config.configVersion; delete file.config.program.autoSession; delete file.config.program.recordOnStart;
  Object.assign(file.config.meld, { autoSession: false, recordOnStart: true });
  file.config.widgets.goals = [legacyGoal];
  const before = await f.snapshot();
  const preview = await f.call('POST', '/api/config/import/preview', file);
  assert.equal(preview.status, 200); assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(preview.body.summary.program.changed.paths.sort(), ['program.autoSession', 'program.recordOnStart']);
  const imported = await f.call('POST', '/api/config/import', file, { 'x-config-fingerprint': preview.body.fingerprint });
  assert.equal(imported.status, 200);
  assert.equal(await readFile(path.join(f.dataDir, imported.body.backup), 'utf8'), before.bytes);
  const config = (await f.call('GET', '/api/config')).body;
  assert.equal(config.configVersion, 2); assert.equal(config.program.autoSession, false); assert.equal(config.program.recordOnStart, true);
  assert.deepEqual(config.widgets.goals, [convertedGoal]);
  assert.equal(Object.hasOwn(config.meld, 'autoSession'), false); assert.equal(Object.hasOwn(config.meld, 'recordOnStart'), false);
});

test('importar rechaza ajustes antiguos y secciones inválidas antes de migrar, sin cambios', async t => {
  const f = await appFixture(t), original = (await f.call('GET', '/api/config/export?format=json')).body;
  const before = await f.snapshot();
  for (const [mutate, message] of [
    [file => { file.config.program = null; file.config.meld.autoSession = false; }, 'program: se esperaba un objeto'],
    [file => { delete file.config.program.autoSession; file.config.meld.autoSession = 'sí'; }, 'meld.autoSession: se esperaba true o false'],
    [file => { delete file.config.program.recordOnStart; file.config.meld.recordOnStart = null; }, 'meld.recordOnStart: se esperaba true o false'],
  ]) {
    const file = structuredClone(original); delete file.config.configVersion; mutate(file);
    for (const url of ['/api/config/import/preview', '/api/config/import']) {
      assert.deepEqual(await f.call('POST', url, file), { status: 400, body: { error: message } });
      assert.deepEqual(await f.snapshot(), before);
    }
  }
});

test('PUT, config/set y lectura de ajustes existentes conservan su comportamiento', async t => {
  const f = await appFixture(t);
  assert.equal((await f.call('PUT', '/api/config', { overlay: { volume: 0.8 } })).body.config.overlay.volume, 0.8);
  assert.deepEqual(await f.call('POST', '/api/config/set', { path: 'tts.rate', value: 1.25 }), { status: 200, body: { path: 'tts.rate', value: 1.25 } });
  assert.deepEqual(await f.call('GET', '/api/config?path=tts.rate'), { status: 200, body: { path: 'tts.rate', value: 1.25 } });
});
