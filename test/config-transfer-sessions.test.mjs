// #223: past streams travel in the configuration ZIP as sessions/<id>.json and are merged on import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, open, writeFile, readFile, readdir, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { openZip, writeZip } from '../src/zip-archive.mjs';

const canary = 'canary-session-secret-223';
const session = (id, extra = {}) => ({ id, title: `Directo ${id.slice(-4)}`, startedAt: '2026-10-01T18:00:00.000Z', endedAt: '2026-10-01T20:00:00.000Z',
  events: [{ type: 'follow', user: 'viewer', at: '2026-10-01T18:30:00.000Z' }], notes: [], goalOffsets: {}, ...extra });
const ID_A = '2026-10-01T18-00-00-000Z-11111111-1111-4111-8111-111111111111';
const ID_B = '2026-10-02T18-00-00-000Z-22222222-2222-4222-8222-222222222222';
const ID_C = '2026-10-03T18-00-00-000Z-33333333-3333-4333-8333-333333333333';

async function fixture(t, { sessions = [], config = {} } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-transfer-sessions-'));
  const data = path.join(root, 'data'), media = path.join(root, 'media'), dir = path.join(data, 'sessions');
  await mkdir(dir, { recursive: true }); await mkdir(media);
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ access: { key: canary }, ...config }));
  for (const s of sessions) await writeFile(path.join(dir, `${s.id}.json`), JSON.stringify(s));
  const app = await createApp({ dataDir: data, mediaDir: media, push: {}, log: () => {} });
  t.after(async () => { app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'sec-fetch-site': 'same-origin', ...headers }, body, signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json() };
  };
  const postZip = (url, bytes, fingerprint) => call('POST', url, bytes, { 'content-type': 'application/zip', ...(fingerprint ? { 'x-config-fingerprint': fingerprint } : {}) });
  const download = async query => { const r = await fetch(base + '/api/config/export' + query); return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) }; };
  const files = async () => Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async n => [n, await readFile(path.join(dir, n), 'utf8')])));
  return { root, data, dir, app, base, call, postZip, download, files };
}

async function inspect(f, bytes) {
  const file = path.join(f.root, `inspect-${Math.random()}.zip`); await writeFile(file, bytes); const zip = await openZip(file);
  const out = path.join(f.root, `out-${Math.random()}`); await mkdir(out);
  try {
    const sessions = {};
    for (const e of zip.entries.filter(x => x.name.startsWith('sessions/'))) sessions[e.name] = JSON.parse(await readFile(await zip.extract(e.name, out), 'utf8'));
    return { names: zip.entries.map(e => e.name), config: JSON.parse((await zip.readConfig()).toString()), sessions };
  } finally { await zip.close(); }
}
async function makeZip(f, entries) {
  const file = path.join(f.root, `made-${Math.random()}.zip`);
  await writeZip(createWriteStream(file), entries);
  return readFile(file);
}
const configEntry = () => ({ name: 'config.json', source: JSON.stringify({ format: 'antena-config', version: 1, config: {} }) });
const sessionEntry = s => ({ name: `sessions/${s.id}.json`, source: JSON.stringify(s) });

test('export leaves past streams out unless sessions=1 is requested', async t => {
  const f = await fixture(t, { sessions: [session(ID_A)] });
  const r = await f.download('');
  assert.equal(r.status, 200);
  assert.deepEqual((await inspect(f, r.bytes)).names, ['config.json']);
});

test('sessions=1 exports every archived stream, without caches or private push flags', async t => {
  const f = await fixture(t, { sessions: [session(ID_A, { _pushExportOwed: true }), session(ID_B)] });
  await writeFile(path.join(f.dir, `${ID_A}.meta.json`), JSON.stringify({ id: ID_A }));
  const r = await f.download('?sessions=1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  const zip = await inspect(f, r.bytes);
  assert.deepEqual(zip.names, ['config.json', `sessions/${ID_A}.json`, `sessions/${ID_B}.json`]);
  const { _pushExportOwed, ...publicA } = session(ID_A, { _pushExportOwed: true });
  assert.deepEqual(zip.sessions[`sessions/${ID_A}.json`], publicA);
  assert.deepEqual(zip.sessions[`sessions/${ID_B}.json`], session(ID_B));
  assert.equal(r.bytes.includes(canary), false);
});

test('sessions=1 also exports the last ended stream that is not archived yet, never the live one', async t => {
  const f = await fixture(t);
  const live = f.app.session.data.id;
  assert.deepEqual((await inspect(f, (await f.download('?sessions=1')).bytes)).names, ['config.json']);
  await f.app.session.endCurrent();
  const zip = await inspect(f, (await f.download('?sessions=1')).bytes);
  assert.deepEqual(zip.names, ['config.json', `sessions/${live}.json`]);
  assert.equal(zip.sessions[`sessions/${live}.json`].id, live);
  assert.equal(typeof zip.sessions[`sessions/${live}.json`].endedAt, 'string');
});

test('preview reports added and unchanged streams and writes nothing', async t => {
  const source = await fixture(t, { sessions: [session(ID_A), session(ID_B)] });
  const target = await fixture(t, { sessions: [session(ID_A)] });
  const before = await target.files();
  const r = await target.postZip('/api/config/import/preview', (await source.download('?sessions=1')).bytes);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions, { added: 1, unchanged: 1 });
  assert.equal(typeof r.body.fingerprint, 'string');
  assert.deepEqual(await target.files(), before);
});

test('apply adds only the missing streams and never overwrites an existing one', async t => {
  const source = await fixture(t, { sessions: [session(ID_A, { title: 'Otro título' }), session(ID_B, { _pushExportOwed: true })] });
  const target = await fixture(t, { sessions: [session(ID_A)] });
  const original = (await target.files())[`${ID_A}.json`];
  const bytes = (await source.download('?sessions=1')).bytes;
  const { body } = await target.postZip('/api/config/import/preview', bytes);
  const r = await target.postZip('/api/config/import', bytes, body.fingerprint);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sessions, { added: 1, unchanged: 1 });
  const files = await target.files();
  assert.deepEqual(Object.keys(files), [`${ID_A}.json`, `${ID_B}.json`]);
  assert.equal(files[`${ID_A}.json`], original);
  const { _pushExportOwed, ...expected } = session(ID_B, { _pushExportOwed: true });
  assert.deepEqual(JSON.parse(files[`${ID_B}.json`]), expected);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(target.dir, `${ID_B}.json`))).mode & 0o777, 0o600);
  const listed = (await target.call('GET', '/api/sessions')).body;
  assert.ok(JSON.stringify(listed).includes(ID_B));
});

test('the live stream id is never written from an import', async t => {
  const target = await fixture(t);
  const live = target.app.session.data.id;
  const bytes = await makeZip(target, [configEntry(), sessionEntry(session(live))]);
  const { body } = await target.postZip('/api/config/import/preview', bytes);
  assert.deepEqual(body.sessions, { added: 0, unchanged: 1 });
  const r = await target.postZip('/api/config/import', bytes, body.fingerprint);
  assert.equal(r.status, 200);
  assert.deepEqual(await target.files(), {});
});

test('an invalid stream file rejects the whole import without writing anything', async t => {
  const cases = [
    [{ name: `sessions/${ID_B}.json`, source: JSON.stringify(session(ID_C)) }, 'El directo importado no coincide con su nombre de archivo.'],
    [{ name: `sessions/${ID_B}.json`, source: '{not json' }, 'El directo importado no es un JSON válido.'],
    [{ name: `sessions/${ID_B}.json`, source: JSON.stringify(session(ID_B, { events: 'x' })) }, 'El directo importado no es válido.'],
    [{ name: `sessions/${ID_B}.json`, source: JSON.stringify(session(ID_B, { startedAt: 'ayer' })) }, 'El directo importado no es válido.'],
    [{ name: `sessions/${ID_B}.json`, source: JSON.stringify({ id: ID_B }) }, 'El directo importado no es válido.'],
  ];
  const target = await fixture(t, { sessions: [session(ID_A)] });
  const before = await target.files();
  const config = await readFile(path.join(target.data, 'config.json'));
  for (const [entry, message] of cases) {
    const bytes = await makeZip(target, [configEntry(), entry]);
    const preview = await target.postZip('/api/config/import/preview', bytes);
    assert.equal(preview.status, 400, message);
    assert.deepEqual(preview.body, { error: message });
    const applied = await target.postZip('/api/config/import', bytes, 'x');
    assert.equal(applied.status, 400, message);
  }
  assert.deepEqual(await target.files(), before);
  assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
});

test('a failed configuration commit removes the streams it added', async t => {
  const source = await fixture(t, { sessions: [session(ID_B)] });
  const target = await fixture(t, { sessions: [session(ID_A)] });
  await source.call('PUT', '/api/config', JSON.stringify({ overlay: { volume: 0.31 } }), { 'content-type': 'application/json' });
  const bytes = (await source.download('?sessions=1')).bytes;
  const { body } = await target.postZip('/api/config/import/preview', bytes);
  const before = await target.files();
  const write = target.app.store.replaceConfigWithBackup;
  target.app.store.replaceConfigWithBackup = async () => { throw new Error('disk full'); };
  try {
    const r = await target.postZip('/api/config/import', bytes, body.fingerprint);
    assert.equal(r.status, 500);
  } finally { target.app.store.replaceConfigWithBackup = write; }
  assert.deepEqual(await target.files(), before);
});

test('preview warns when retention will prune imported streams', async t => {
  const source = await fixture(t, { sessions: [session(ID_B), session(ID_C)] });
  const target = await fixture(t, { sessions: [session(ID_A)], config: { sessions: { retention: 2 } } });
  const { body } = await target.postZip('/api/config/import/preview', (await source.download('?sessions=1')).bytes);
  assert.deepEqual(body.sessions, { added: 2, unchanged: 0, retention: 2 });
  const quiet = await fixture(t, { config: { sessions: { retention: 5 } } });
  assert.deepEqual((await quiet.postZip('/api/config/import/preview', (await source.download('?sessions=1')).bytes)).body.sessions, { added: 2, unchanged: 0 });
});

test('a zip without streams keeps the previous preview shape', async t => {
  const source = await fixture(t, { sessions: [session(ID_A)] });
  const target = await fixture(t);
  const { body } = await target.postZip('/api/config/import/preview', (await source.download('')).bytes);
  assert.equal(body.sessions, undefined);
});

test('export reports oversized, malformed and mismatched archives in both report and download', async t => {
  const f = await fixture(t, { sessions: [session('legacy_id', { _pushExportOwed: true })] });
  const large = await open(path.join(f.dir, `${ID_A}.json`), 'w');
  try { await large.truncate(64 * 1024 ** 2 + 1); } finally { await large.close(); }
  await writeFile(path.join(f.dir, `${ID_B}.json`), '{bad');
  await writeFile(path.join(f.dir, `${ID_C}.json`), JSON.stringify(session(ID_A)));
  const report = await f.call('GET', '/api/config/export?skipped=1&sessions=1');
  assert.equal(report.status, 200);
  assert.deepEqual(report.body.skipped, [
    `sessions/${ID_A}.json (supera 64 MB)`,
    `sessions/${ID_B}.json (JSON no válido)`,
    `sessions/${ID_C}.json (el id no coincide con el nombre)`,
  ]);
  const download = await f.download('?sessions=1');
  assert.equal(download.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(download.headers.get('x-antena-skipped-media'), 'base64url').toString()), report.body.skipped);
  assert.deepEqual((await inspect(f, download.bytes)).names, ['config.json', 'sessions/legacy_id.json']);
});

test('export strips credential fields while preserving private chat metrics only in the archive', async t => {
  const archived = session(ID_A, { token: canary, events: [{ type: 'follow', vars: { password: canary, user: 'viewer' } }],
    chatStats: { twitch: { authorIds: ['private-author'], minutes: [{ at: '2026-10-01T18:30:00.000Z', messages: 1 }] } } });
  const f = await fixture(t, { sessions: [archived] });
  const zip = await inspect(f, (await f.download('?sessions=1')).bytes);
  const data = zip.sessions[`sessions/${ID_A}.json`];
  assert.equal(JSON.stringify(data).includes(canary), false);
  assert.deepEqual(data.events[0].vars, { user: 'viewer' });
  assert.deepEqual(data.chatStats.twitch.authorIds, ['private-author']);
  const summary = await f.call('GET', `/api/session/summary?format=json&id=${ID_A}`);
  assert.equal(summary.status, 200);
  assert.equal(JSON.stringify(summary.body).includes('authorIds'), false);
  assert.equal(JSON.stringify(summary.body).includes('private-author'), false);
});

test('an archive appearing after preview invalidates the session fingerprint without writes', async t => {
  const source = await fixture(t, { sessions: [session(ID_B)] }), target = await fixture(t);
  const bytes = (await source.download('?sessions=1')).bytes;
  const preview = await target.postZip('/api/config/import/preview', bytes);
  assert.deepEqual(preview.body.sessions, { added: 1, unchanged: 0 });
  await writeFile(path.join(target.dir, `${ID_B}.json`), JSON.stringify(session(ID_B, { title: 'concurrente' })));
  const before = await target.files(), config = await readFile(path.join(target.data, 'config.json'));
  const applied = await target.postZip('/api/config/import', bytes, preview.body.fingerprint);
  assert.deepEqual({ status: applied.status, body: applied.body }, { status: 409, body: { error: 'La configuración ha cambiado; vuelve a previsualizar' } });
  assert.deepEqual(await target.files(), before); assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
});

test('a changed session entry invalidates the preview fingerprint without writes', async t => {
  const target = await fixture(t), before = await target.files(), config = await readFile(path.join(target.data, 'config.json'));
  const first = await makeZip(target, [configEntry(), sessionEntry(session(ID_B))]);
  const changed = await makeZip(target, [configEntry(), sessionEntry(session(ID_B, { title: 'cambiado' }))]);
  const preview = await target.postZip('/api/config/import/preview', first);
  assert.deepEqual(preview.body.sessions, { added: 1, unchanged: 0 });
  const applied = await target.postZip('/api/config/import', changed, preview.body.fingerprint);
  assert.deepEqual({ status: applied.status, body: applied.body }, { status: 409, body: { error: 'La configuración ha cambiado; vuelve a previsualizar' } });
  assert.deepEqual(await target.files(), before); assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
});

test('an unsafe session filename rejects preview and apply without writes', async t => {
  const target = await fixture(t, { sessions: [session(ID_A)] }), before = await target.files(), config = await readFile(path.join(target.data, 'config.json'));
  const bytes = await makeZip(target, [configEntry(), sessionEntry(session('abc'))]);
  const safe = Buffer.from('sessions/abc.json'), unsafe = Buffer.from('sessions/a/b.json'); let offset = 0, count = 0;
  while ((offset = bytes.indexOf(safe, offset)) !== -1) { unsafe.copy(bytes, offset); offset += safe.length; count++; }
  assert.equal(count, 2);
  for (const endpoint of ['/api/config/import/preview', '/api/config/import']) {
    const result = await target.postZip(endpoint, bytes, 'x');
    assert.deepEqual({ status: result.status, body: result.body }, { status: 400, body: { error: 'Nombre de archivo no permitido en el ZIP.' } });
    assert.deepEqual(await target.files(), before); assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
  }
});

test('a pending cutover is exported and its id is never overwritten', async t => {
  const target = await fixture(t), old = target.app.session.data.id, original = target.app.session.writer;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  target.app.session.writer = (file, data, options = {}) => original(file, data, { ...options, after: Promise.resolve(options.after).then(async () => {
    if (file === path.join(target.dir, `${old}.json`)) { entered(); await gate; }
  }) });
  let cutover;
  try {
    cutover = target.app.session.startNew();
    await started;
    assert.equal(target.app.session.archiveState().sessionId, old);
    const exported = await inspect(target, (await target.download('?sessions=1')).bytes);
    assert.equal(exported.sessions[`sessions/${old}.json`].id, old);
    const bytes = await makeZip(target, [configEntry(), sessionEntry(session(old, { title: 'no reemplazar' }))]);
    const preview = await target.postZip('/api/config/import/preview', bytes);
    assert.deepEqual(preview.body.sessions, { added: 0, unchanged: 1 });
    release(); await cutover;
    const originalArchive = await readFile(path.join(target.dir, `${old}.json`));
    const applied = await target.postZip('/api/config/import', bytes, preview.body.fingerprint);
    assert.equal(applied.status, 200); assert.deepEqual(applied.body.sessions, { added: 0, unchanged: 1 });
    assert.deepEqual(await readFile(path.join(target.dir, `${old}.json`)), originalArchive);
  } finally { release(); if (cutover) await cutover; target.app.session.writer = original; }
});

test('import rejects a non-regular stale session cache without reading or writing it', async t => {
  const source = await fixture(t, { sessions: [session(ID_B)] }), target = await fixture(t);
  const bytes = (await source.download('?sessions=1')).bytes, preview = await target.postZip('/api/config/import/preview', bytes);
  const before = await target.files(), config = await readFile(path.join(target.data, 'config.json'));
  const io = target.app.session.io, lstat = io.lstat, read = io.readFile; let cacheRead = false;
  io.lstat = async file => file.endsWith(`${ID_B}.meta.json`) ? { isFile: () => false } : lstat(file);
  io.readFile = async (...args) => {
    if (args[0].endsWith(`${ID_B}.meta.json`)) { cacheRead = true; return Buffer.from('synthetic link target'); }
    return read(...args);
  };
  try {
    const applied = await target.postZip('/api/config/import', bytes, preview.body.fingerprint);
    assert.deepEqual({ status: applied.status, body: applied.body }, { status: 500, body: { error: 'La caché del directo no es un archivo normal.' } });
    assert.equal(cacheRead, false);
    assert.deepEqual(await target.files(), before); assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
  } finally { io.lstat = lstat; io.readFile = read; }
});

test('a later session failure rolls back sessions, stale cache, media and config', async t => {
  const source = await fixture(t, { sessions: [session(ID_B), session(ID_C)] }), target = await fixture(t);
  await writeFile(path.join(source.root, 'media', 'one.png'), 'new');
  await writeFile(path.join(target.root, 'media', 'one.png'), 'old');
  const cache = path.join(target.dir, `${ID_B}.meta.json`);
  await writeFile(cache, 'stale cache');
  if (process.platform !== 'win32') await chmod(cache, 0o640);
  const cacheMode = (await stat(cache)).mode & 0o777;
  const bytes = (await source.download('?sessions=1')).bytes;
  const preview = await target.postZip('/api/config/import/preview', bytes);
  assert.deepEqual(preview.body.sessions, { added: 2, unchanged: 0 });
  const before = await target.files(), config = await readFile(path.join(target.data, 'config.json'));
  const original = target.app.session.importArchive;
  target.app.session.importArchive = function (data, ...rest) {
    if (data.id === ID_C) throw new Error('fallo de directo inyectado');
    return original.call(this, data, ...rest);
  };
  try {
    const applied = await target.postZip('/api/config/import', bytes, preview.body.fingerprint);
    assert.deepEqual({ status: applied.status, body: applied.body }, { status: 500, body: { error: 'fallo de directo inyectado' } });
  } finally { target.app.session.importArchive = original; }
  assert.deepEqual(await target.files(), before); assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
  if (process.platform !== 'win32') assert.equal((await stat(cache)).mode & 0o777, cacheMode);
  assert.equal(await readFile(path.join(target.root, 'media', 'one.png'), 'utf8'), 'old');
  assert.deepEqual(await readdir(path.join(target.root, 'media')), ['one.png']);
});

test('a cutover waits until session import commits', async t => {
  const source = await fixture(t, { sessions: [session(ID_B)] }), target = await fixture(t);
  const bytes = (await source.download('?sessions=1')).bytes;
  const preview = await target.postZip('/api/config/import/preview', bytes);
  let entered, release;
  const atCommit = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const original = target.app.store.replaceConfigWithBackup;
  target.app.store.replaceConfigWithBackup = async function (...args) { entered(); await gate; return original.apply(this, args); };
  let cutover, completed = false;
  try {
    const applied = target.postZip('/api/config/import', bytes, preview.body.fingerprint);
    await atCommit;
    cutover = target.app.session.startNew().then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(completed, false, 'el corte espera a que la importación confirme o revierta');
    release();
    assert.equal((await applied).status, 200);
    await cutover;
    assert.ok((await target.files())[`${ID_B}.json`]);
  } finally { release(); if (cutover) await cutover; target.app.store.replaceConfigWithBackup = original; }
});
