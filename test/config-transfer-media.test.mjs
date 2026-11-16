import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, open, writeFile, readFile, readdir, rm, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { createApp } from '../src/server.mjs';
import { openZip } from '../src/zip-archive.mjs';

const error = message => ({ error: message });
const conflict = 'La configuración ha cambiado; vuelve a previsualizar';
const large = 'El archivo ZIP es demasiado grande';
const canary = 'ZIP_PRIVATE_CREDENTIAL_CANARY';

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-transfer-media-'));
  const data = path.join(root, 'data'), media = path.join(root, 'media');
  await mkdir(data); await mkdir(media);
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ access: { key: canary }, youtube: { apiKey: canary } }));
  await writeFile(path.join(data, 'secrets.json'), JSON.stringify({ obs: { password: canary } }));
  const app = await createApp({ dataDir: data, mediaDir: media, push: {}, log: () => {}, ...options });
  t.after(async () => { app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'sec-fetch-site': 'same-origin', ...headers }, body, signal: AbortSignal.timeout(15000) });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const json = (method, url, body) => call(method, url, body === undefined ? undefined : JSON.stringify(body), { 'content-type': 'application/json' });
  const postZip = (url, bytes, fingerprint) => call('POST', url, bytes, { 'content-type': 'application/zip', ...(fingerprint ? { 'x-config-fingerprint': fingerprint } : {}) });
  const download = async () => { const r = await fetch(base + '/api/config/export'); return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) }; };
  const snapshot = async () => ({ config: await readFile(path.join(data, 'config.json')), data: (await readdir(data)).sort(),
    mediaEntries: (await readdir(media, { recursive: true })).sort(), media: (await Promise.all((await readdir(media, { recursive: true, withFileTypes: true })).filter(x => x.isFile()).map(async x => {
      const name = path.relative(media, path.join(x.parentPath, x.name)); return [name, (await readFile(path.join(media, name))).toString('base64')];
    }))).sort((a, b) => a[0].localeCompare(b[0])), state: (await json('GET', '/api/config')).body, persistence: (await json('GET', '/api/status')).body.persistence });
  const failWrite = async () => {
    const blocker = path.join(root, 'blocker'); await writeFile(blocker, 'x'); const write = app.store.write;
    app.store.write = function (file, value) { this.cfgFile = path.join(blocker, 'config.json'); try { return write.call(this, this.cfgFile, value); } finally { this.cfgFile = file; } };
    return () => { app.store.write = write; };
  };
  return { root, data, media, app, base, call, json, postZip, download, snapshot, failWrite };
}

async function archiveConfig(f, bytes) {
  const file = path.join(f.root, 'inspect.zip'); await writeFile(file, bytes); const zip = await openZip(file);
  try { return { file: JSON.parse((await zip.readConfig()).toString()), names: zip.entries.map(e => e.name) }; }
  finally { await zip.close(); }
}
async function preview(f, bytes) { return f.postZip('/api/config/import/preview', bytes); }
async function apply(f, bytes, fingerprint) { return f.postZip('/api/config/import', bytes, fingerprint); }
async function exportedFixture(t) {
  const source = await fixture(t), target = await fixture(t);
  await source.json('PUT', '/api/config', { overlay: { volume: 0.77 } });
  for (const [name, content] of [['replace.png', 'new'], ['added.wav', 'added'], ['same.jpg', 'same'], ['font.woff2', 'font']]) await writeFile(path.join(source.media, name), content);
  for (const [name, content] of [['replace.png', 'old'], ['same.jpg', 'same'], ['keep.mp3', 'keep']]) await writeFile(path.join(target.media, name), content);
  return { source, target, exported: await source.download() };
}

// Independently construct stored/deflated archives, including deliberately dishonest sizes.
function rawZip(entries) {
  let offset = 0; const locals = [], central = [];
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data), method = e.method || 0, compressed = method ? deflateRawSync(data) : data;
    const size = e.size ?? data.length, crc = e.crc ?? crc32(data), local = Buffer.alloc(30), cd = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(cd, name); offset += local.length + name.length + compressed.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

test('ZIP export and preview/apply round-trip config and media, preserving local-only media and private fields', async t => {
  const { source, target, exported } = await exportedFixture(t);
  assert.equal(exported.status, 200); assert.equal(exported.headers.get('content-type'), 'application/zip');
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.match(exported.headers.get('content-disposition'), /^attachment; filename="antena-config-\d{4}-\d{2}-\d{2}\.zip"$/);
  const zip = await archiveConfig(source, exported.bytes), json = await source.json('GET', '/api/config/export?format=json');
  assert.equal(json.status, 200); assert.deepEqual({ ...zip.file, exportedAt: json.body.exportedAt }, json.body);
  assert.equal(JSON.stringify(zip.file).includes(canary), false); assert.ok(zip.names.includes('media/font.woff2'));
  const before = await target.snapshot(), p = await preview(target, exported.bytes);
  assert.equal(p.status, 200, JSON.stringify(p.body)); assert.deepEqual(p.body.summary.overlay.changed.paths, ['overlay.volume']);
  assert.deepEqual(p.body.media, { added: ['added.wav', 'font.woff2'], replaced: ['replace.png'], unchanged: 1 });
  assert.match(p.body.fingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(await target.snapshot(), before);
  const r = await apply(target, exported.bytes, p.body.fingerprint); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await readFile(path.join(target.data, r.body.backup)), before.config);
  const backups = (await readdir(target.media)).filter(n => n.startsWith('.backup-')); assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(target.media, backups[0], 'replace.png'), 'utf8'), 'old');
  for (const name of ['replace.png', 'added.wav', 'same.jpg', 'font.woff2']) assert.deepEqual(await readFile(path.join(target.media, name)), await readFile(path.join(source.media, name)));
  assert.equal(await readFile(path.join(target.media, 'keep.mp3'), 'utf8'), 'keep');
  const listed = await target.json('GET', '/api/media'); assert.equal(listed.status, 200); assert.ok(!listed.body.some(e => e.name.startsWith('.backup-')));
  const state = await target.json('GET', '/api/state'); assert.ok(!state.body.media.some(e => e.name.startsWith('.backup-')));
  const next = await target.download(), contents = await archiveConfig(target, next.bytes);
  assert.ok(!contents.names.some(n => n.includes('.backup-'))); assert.ok(contents.names.includes('media/keep.mp3'));
  assert.equal((await target.json('GET', '/api/config')).body.overlay.volume, 0.77);
});

test('a very long skipped list never overflows client header limits', async t => {
  const f = await fixture(t); await writeFile(path.join(f.media, 'safe.png'), 'yes');
  const names = Array.from({ length: 1500 }, (_, i) => `${String(i).padStart(4, '0')}-${'n'.repeat(150)}.txt`);
  for (const name of names) await writeFile(path.join(f.media, name), 'x');
  const r = await f.download(); assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-antena-skipped-media-count'), '1500');
  assert.equal(r.headers.get('x-antena-skipped-media'), null);
  assert.deepEqual((await archiveConfig(f, r.bytes)).names, ['config.json', 'media/safe.png']);
  const report = await (await fetch(f.base + '/api/config/export?skipped=1')).json();
  assert.equal(report.skipped.length, 1500);
});

test('unportable local names are skipped and reported without failing the export', async t => {
  const f = await fixture(t); await writeFile(path.join(f.media, 'safe.png'), 'yes'); await writeFile(path.join(f.media, 'odd..png'), 'odd');
  const r = await f.download(); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.deepEqual(JSON.parse(Buffer.from(r.headers.get('x-antena-skipped-media'), 'base64url').toString()), ['odd..png (Nombre de archivo no permitido en el ZIP.)']);
  assert.deepEqual((await archiveConfig(f, r.bytes)).names, ['config.json', 'media/safe.png']);
});

test('a non-UTF-8 media filename is skipped losslessly instead of aborting export', async t => {
  if (process.platform === 'win32') return t.skip('POSIX filenames: Windows cannot create a non-UTF-8 media filename; the skip-and-report path runs on Linux');
  const f = await fixture(t), name = Buffer.concat([Buffer.from([0xff]), Buffer.from('.png')]);
  await writeFile(Buffer.concat([Buffer.from(f.media + path.sep), name]), 'odd'); await writeFile(path.join(f.media, 'safe.png'), 'yes');
  const r = await f.download(); assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(r.headers.get('x-antena-skipped-media'), 'base64url').toString()), [`base64:${name.toString('base64url')} (Nombre no válido en UTF-8)`]);
  assert.deepEqual((await archiveConfig(f, r.bytes)).names, ['config.json', 'media/safe.png']);
});

const skippedHeader = r => JSON.parse(Buffer.from(r.headers.get('x-antena-skipped-media'), 'base64url').toString());
const sparse = async (file, size) => { const h = await open(file, 'w'); try { await h.truncate(size); } finally { await h.close(); } };

test('export skips a 301 MiB media file and returns a complete ZIP with the reason', async t => {
  const f = await fixture(t);
  await sparse(path.join(f.media, 'v0.mp4'), 301 * 2 ** 20);
  await writeFile(path.join(f.media, 'safe.png'), 'small');
  const r = await f.download();
  assert.equal(r.status, 200);
  assert.deepEqual(skippedHeader(r), ['v0.mp4 (supera 300 MB)']);
  assert.deepEqual((await archiveConfig(f, r.bytes)).names, ['config.json', 'media/safe.png']);
});

test('export stops at the total limit in deterministic order and reports every remaining file', async t => {
  // A 4 MiB test cap exercises the 2 GiB rule without streaming gigabytes of sparse zeros.
  const f = await fixture(t, { zipExportLimit: 4 * 2 ** 20 });
  await sparse(path.join(f.media, 'v1.mp4'), 2 * 2 ** 20);
  await sparse(path.join(f.media, 'v0.mp4'), 2 * 2 ** 20);
  await writeFile(path.join(f.media, 'v2.mp4'), 'x');
  const r = await f.download();
  assert.equal(r.status, 200);
  assert.deepEqual(skippedHeader(r), ['v1.mp4 (límite total de 2 GB)', 'v2.mp4 (límite total de 2 GB)']);
  assert.deepEqual((await archiveConfig(f, r.bytes)).names, ['config.json', 'media/v0.mp4']);
  const report = await f.json('GET', '/api/config/export?skipped=1');
  assert.equal(report.status, 200); assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.deepEqual(report.body, { skipped: skippedHeader(r) });
});

test('skipped-only export report has no ZIP body and preserves the ordinary ZIP and JSON exports', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.media, 'odd..png'), 'odd'); await writeFile(path.join(f.media, 'safe.png'), 'safe');
  const report = await f.json('GET', '/api/config/export?skipped=1');
  assert.equal(report.status, 200); assert.match(report.headers.get('content-type'), /^application\/json/);
  assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.deepEqual(report.body, { skipped: ['odd..png (Nombre de archivo no permitido en el ZIP.)'] });
  const zip = await f.download(); assert.equal(zip.status, 200);
  assert.deepEqual(skippedHeader(zip), report.body.skipped);
  assert.deepEqual((await archiveConfig(f, zip.bytes)).names, ['config.json', 'media/safe.png']);
  assert.equal((await f.json('GET', '/api/config/export?format=json')).body.format, 'antena-config');
});

test('changed local media invalidates the archive fingerprint without writing', async t => {
  const { target, exported } = await exportedFixture(t), p = await preview(target, exported.bytes); assert.equal(p.status, 200);
  await writeFile(path.join(target.media, 'replace.png'), 'concurrent'); const before = await target.snapshot();
  const r = await apply(target, exported.bytes, p.body.fingerprint); assert.deepEqual({ status: r.status, body: r.body }, { status: 409, body: error(conflict) });
  assert.deepEqual(await target.snapshot(), before);
});

for (const kind of ['rename', 'config write']) test(`failure during ${kind} rolls back config and every media change`, async t => {
  let armed = false, calls = 0;
  const options = { configTransferIO: { rename: async (...args) => { if (armed && ++calls === 2) throw new Error('fallo de rename inyectado'); return rename(...args); } } };
  const source = await fixture(t), target = await fixture(t, options);
  await source.json('PUT', '/api/config', { overlay: { volume: 0.72 } });
  await writeFile(path.join(source.media, 'one.png'), 'new'); await writeFile(path.join(source.media, 'two.png'), 'added');
  await writeFile(path.join(target.media, 'one.png'), 'old'); const { bytes, headers } = await source.download();
  assert.equal(headers.get('content-type'), 'application/zip'); const p = await preview(target, bytes);
  assert.equal(p.status, 200); const before = await target.snapshot(), restore = kind === 'config write' ? await target.failWrite() : () => {};
  armed = kind === 'rename'; const r = await apply(target, bytes, p.body.fingerprint); restore();
  assert.deepEqual({ status: r.status, body: r.body }, { status: 500, body: error(kind === 'rename' ? 'fallo de rename inyectado' : 'No se pudo guardar la configuración; no se aplicaron los cambios') });
  assert.deepEqual(await target.snapshot(), before); assert.deepEqual((await readdir(target.media)).sort(), ['one.png']);
});

test('traversal and inflated-size bombs return 400 with no data or media mutations', async t => {
  const f = await fixture(t), config = (await f.json('GET', '/api/config/export?format=json')).body, before = await f.snapshot();
  for (const [entry, message] of [[{ name: 'media/../escape.png', data: 'x' }, 'Nombre de archivo no permitido en el ZIP.'],
    [{ name: 'media/bomb.png', data: Buffer.alloc(4096, 65), method: 8, size: 10 }, 'El tamaño declarado no coincide con el contenido del ZIP.'],
    [{ name: 'media/bad.png', data: 'incorrect crc', crc: 123 }, 'El CRC del archivo ZIP no coincide.']]) {
    const bytes = rawZip([{ name: 'config.json', data: JSON.stringify(config) }, entry]);
    for (const run of [preview, apply]) { const r = await run(f, bytes); assert.deepEqual({ status: r.status, body: r.body }, { status: 400, body: error(message) }); assert.deepEqual(await f.snapshot(), before); }
  }
});

test('ZIP import reports missing config.json without touching config, media or counters', async t => {
  const f = await fixture(t), before = await f.snapshot();
  const bytes = rawZip([{ name: 'media/a.png', data: 'x' }]);
  for (const run of [preview, apply]) {
    const r = await run(f, bytes);
    assert.deepEqual({ status: r.status, body: r.body }, { status: 400, body: error('El archivo no contiene config.json') });
    assert.deepEqual(await f.snapshot(), before);
  }
});

test('ZIP import rejects empty media basenames without touching config, media or counters', async t => {
  const f = await fixture(t), config = (await f.json('GET', '/api/config/export?format=json')).body, before = await f.snapshot();
  for (const name of ['.png', '.mp4', '.woff2']) {
    const bytes = rawZip([{ name: 'config.json', data: JSON.stringify(config) }, { name: `media/${name}`, data: 'x' }]);
    for (const run of [preview, apply]) {
      const r = await run(f, bytes);
      assert.deepEqual({ status: r.status, body: r.body }, { status: 400, body: error('Nombre de archivo no permitido en el ZIP.') });
      assert.deepEqual(await f.snapshot(), before);
    }
  }
});

test('installed ZIP media use the same 0644 mode as uploads', async t => {
  const { target, exported } = await exportedFixture(t);
  const uploaded = await target.call('POST', '/api/media/upload?name=mode.png', 'uploaded', { 'content-type': 'application/octet-stream' });
  assert.equal(uploaded.status, 200);
  const uploadMode = (await stat(path.join(target.media, 'mode.png'))).mode & 0o777;
  const p = await preview(target, exported.bytes); assert.equal(p.status, 200);
  const r = await apply(target, exported.bytes, p.body.fingerprint); assert.equal(r.status, 200);
  if (process.platform !== 'win32') {
    assert.equal(uploadMode, 0o644);
    for (const name of ['added.wav', 'replace.png']) assert.equal((await stat(path.join(target.media, name))).mode & 0o777, uploadMode, name);
  }
  assert.equal(await readFile(path.join(target.media, r.body.mediaBackup, 'replace.png'), 'utf8'), 'old');
});

test('rollback failure identifies the media backup folder and preserves recoverable bytes', async t => {
  let armed = false;
  const target = await fixture(t, { configTransferIO: { rename: async (from, to) => {
    if (armed && (from.includes('.antena-stage-') || from.includes('.backup-'))) throw new Error('fallo inyectado');
    return rename(from, to);
  } } });
  const source = await fixture(t);
  await writeFile(path.join(source.media, 'one.png'), 'new'); await writeFile(path.join(target.media, 'one.png'), 'old');
  const { bytes } = await source.download(), p = await preview(target, bytes), config = await readFile(path.join(target.data, 'config.json'));
  assert.equal(p.status, 200); armed = true;
  const r = await apply(target, bytes, p.body.fingerprint);
  const backups = (await readdir(target.media)).filter(n => n.startsWith('.backup-'));
  assert.equal(r.status, 500); assert.equal(backups.length, 1);
  assert.ok(r.body.error.includes(`media/${backups[0]}`), r.body.error);
  assert.equal(await readFile(path.join(target.media, backups[0], 'one.png'), 'utf8'), 'old');
  assert.deepEqual(await readFile(path.join(target.data, 'config.json')), config);
});

test('declared and chunked oversized ZIP uploads return 413 JSON and leave state unchanged', async t => {
  const f = await fixture(t, { zipUploadLimit: 1024 }), before = await f.snapshot();
  const declared = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/config/import/preview', { method: 'POST', headers: { 'content-type': 'application/zip', 'content-length': String(2 * 1024 ** 3 + 32 * 1024 ** 2 + 1) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => { resolve({ status: res.statusCode, body: JSON.parse(text) }); req.destroy(); });
    }); req.on('error', reject); req.setTimeout(3000, () => req.destroy(new Error('sin respuesta 413'))); req.flushHeaders();
  });
  assert.deepEqual(declared, { status: 413, body: error(large) });
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(2048)); c.close(); } });
  const response = await fetch(f.base + '/api/config/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: stream, duplex: 'half', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 413); assert.deepEqual(await response.json(), error(large)); assert.deepEqual(await f.snapshot(), before);
});

test('archive digest and missing fingerprint are rejected without mutation', async t => {
  const { source, target, exported } = await exportedFixture(t), p = await preview(target, exported.bytes); assert.equal(p.status, 200);
  await writeFile(path.join(source.media, 'added.wav'), 'different'); const changed = await source.download(), before = await target.snapshot();
  for (const [bytes, token] of [[changed.bytes, p.body.fingerprint], [exported.bytes, undefined]]) {
    const r = await apply(target, bytes, token); assert.deepEqual({ status: r.status, body: r.body }, { status: 409, body: error(conflict) });
    assert.deepEqual(await target.snapshot(), before);
  }
});

test('last ten media backups are retained and contain the replaced bytes', async t => {
  const { target, exported } = await exportedFixture(t), backups = [];
  for (let i = 0; i < 11; i++) {
    await writeFile(path.join(target.media, 'replace.png'), `old-${i}`);
    const p = await preview(target, exported.bytes), r = await apply(target, exported.bytes, p.body.fingerprint);
    assert.equal(r.status, 200, JSON.stringify(r.body)); backups.push(r.body.mediaBackup);
    assert.equal(await readFile(path.join(target.media, r.body.mediaBackup, 'replace.png'), 'utf8'), `old-${i}`);
  }
  const kept = (await readdir(target.media)).filter(n => n.startsWith('.backup-'));
  assert.equal(kept.length, 10); assert.equal(kept.includes(backups[0]), false);
  for (const name of backups.slice(1)) assert.ok(kept.includes(name));
});

test('a listener error after config commit keeps both imported media and backups', async t => {
  const { target, exported } = await exportedFixture(t), p = await preview(target, exported.bytes), old = await readFile(path.join(target.data, 'config.json'));
  const listener = () => { throw new Error('fallo de oyente inyectado'); }; target.app.store.on('change', listener);
  const r = await apply(target, exported.bytes, p.body.fingerprint); target.app.store.off('change', listener);
  assert.deepEqual({ status: r.status, body: r.body }, { status: 500, body: error('fallo de oyente inyectado') });
  assert.equal(await readFile(path.join(target.media, 'replace.png'), 'utf8'), 'new');
  const backups = (await readdir(target.media)).filter(n => n.startsWith('.backup-')); assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(target.media, backups[0], 'replace.png'), 'utf8'), 'old');
  const cfg = (await readdir(target.data)).filter(n => n.startsWith('config.backup-')); assert.equal(cfg.length, 1);
  assert.deepEqual(await readFile(path.join(target.data, cfg[0])), old); assert.equal((await target.json('GET', '/api/config')).body.overlay.volume, 0.77);
});

test('existing media upload, import and delete retain their public behavior', async t => {
  const f = await fixture(t), source = path.join(f.root, 'source.png'); await writeFile(source, 'imported');
  const upload = await f.call('POST', '/api/media/upload?name=uploaded.png', 'uploaded', { 'content-type': 'application/octet-stream' });
  assert.equal(upload.status, 200); assert.equal(upload.body.name, 'uploaded.png');
  const imported = await f.json('POST', '/api/media/import', { path: source }); assert.equal(imported.status, 200); assert.equal(imported.body.name, 'source.png');
  const deleted = await f.json('POST', '/api/media/delete', { name: 'uploaded.png' }); assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.media.map(e => e.name), ['source.png']); assert.equal(await readFile(path.join(f.media, 'source.png'), 'utf8'), 'imported');
});

test('old JSON API export and fingerprinted import remain available', async t => {
  const f = await fixture(t), file = await f.json('GET', '/api/config/export?format=json'); assert.equal(file.status, 200);
  file.body.config.overlay.volume = 0.81; const p = await f.json('POST', '/api/config/import/preview', file.body); assert.equal(p.status, 200);
  const r = await f.call('POST', '/api/config/import', JSON.stringify(file.body), { 'content-type': 'application/json', 'x-config-fingerprint': p.body.fingerprint });
  assert.equal(r.status, 200); assert.equal((await f.json('GET', '/api/config')).body.overlay.volume, 0.81);
});
