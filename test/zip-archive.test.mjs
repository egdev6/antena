import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { crc32, deflateRawSync } from 'node:zlib';
import { checkZipName, openZip, writeZip } from '../src/zip-archive.mjs';
import { createApp } from '../src/server.mjs';

const MiB = 1024 * 1024;
const message = {
  name: 'Nombre de archivo no permitido en el ZIP.',
  duplicate: 'El ZIP contiene nombres duplicados.',
  encrypted: 'El ZIP contiene archivos cifrados.',
  method: 'Método de compresión no admitido en el ZIP.',
  link: 'El ZIP contiene enlaces o tipos de archivo no admitidos.',
  count: 'El ZIP contiene demasiadas entradas.',
  config: 'El archivo config.json supera 8 MB.',
  media: 'El archivo de medios supera 300 MB.',
  total: 'El ZIP supera el límite total de 2 GB.',
  size: 'El tamaño declarado no coincide con el contenido del ZIP.',
  crc: 'El CRC del archivo ZIP no coincide.',
  invalid: 'ZIP inválido o incompleto.',
  zip64: 'El ZIP supera el límite sin ZIP64.',
};
const isError = text => e => { assert.equal(e.status, 400); assert.equal(e.message, text); return true; };
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-zip-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'out'));
  return dir;
}

// Independent raw ZIP builder, extended from the verifier's synthetic helper.
function rawZip(entries, { count = entries.length, suffix = Buffer.alloc(0) } = {}) {
  const locals = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), localName = Buffer.from(e.localName ?? e.name);
    const data = Buffer.from(e.data || ''), method = e.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const size = e.size ?? data.length, crc = e.crc ?? crc32(data), flags = 0x800 | (e.flags || 0);
    const extra = e.extra ?? Buffer.alloc(0), localExtra = e.localExtra ?? extra;
    const local = Buffer.alloc(30), cd = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22); local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE((e.external ?? (0o100644 << 16)) >>> 0, 38); cd.writeUInt32LE(e.offset ?? offset, 42);
    locals.push(local, localName, localExtra, compressed); central.push(cd, name, extra);
    offset += local.length + localName.length + localExtra.length + compressed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end, suffix]);
}
async function archive(t, entries, opts) {
  const dir = await workspace(t), file = path.join(dir, 'input.zip');
  await writeFile(file, rawZip(entries, opts));
  return { dir, file, out: path.join(dir, 'out') };
}

test('round trip streams file sources, supports strings and fonts, and Python zipfile reads the ZIP', async t => {
  const dir = await workspace(t), file = path.join(dir, 'out.zip'), source = path.join(dir, 'big.webm');
  const video = Buffer.alloc(4 * MiB + 31); for (let i = 0; i < video.length; i++) video[i] = i % 251;
  await writeFile(source, video);
  const dest = createWriteStream(file);
  try {
    await writeZip(dest, [
      { name: 'config.json', source: '{"version":1}' },
      { name: 'media/video.webm', source: { path: source } },
      { name: 'media/logo.png', source: Buffer.from('png sintético') },
      { name: 'media/fuente.woff2', source: Buffer.from('fuente') },
      { name: 'media/foto (1).jpeg', source: Buffer.from('foto') },
    ]);
  } finally { dest.destroy(); }
  const python = spawnSync('python3', ['-I', '-c',
    'import sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read("config.json")==b\'{"version":1}\'; print("zipfile OK", len(z.namelist()))', file], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr); assert.equal(python.stdout.trim(), 'zipfile OK 5');
  const zip = await openZip(file);
  try {
    assert.deepEqual(zip.entries.map(e => e.name), ['config.json', 'media/video.webm', 'media/logo.png', 'media/fuente.woff2', 'media/foto (1).jpeg']);
    assert.equal((await zip.readConfig()).toString(), '{"version":1}');
    for (const name of ['media/video.webm', 'media/logo.png', 'media/fuente.woff2', 'media/foto (1).jpeg']) await zip.extract(name, path.join(dir, 'out'));
    assert.deepEqual(await readFile(path.join(dir, 'out', 'video.webm')), video);
    assert.equal(await readFile(path.join(dir, 'out', 'logo.png'), 'utf8'), 'png sintético');
    assert.equal(await readFile(path.join(dir, 'out', 'fuente.woff2'), 'utf8'), 'fuente');
    assert.equal(await readFile(path.join(dir, 'out', 'foto (1).jpeg'), 'utf8'), 'foto');
  } finally { await zip.close(); }
});

test('reader accepts stored entries and the optional media/ directory', async t => {
  const { file, out } = await archive(t, [
    { name: 'media/', method: 8, external: (0o040755 << 16) | 0x10 },
    { name: 'config.json', data: '{}' }, { name: 'media/Foto (1).JPEG', data: 'foto' },
  ]);
  const zip = await openZip(file);
  try {
    assert.equal((await zip.readConfig()).toString(), '{}');
    await zip.extract('media/Foto (1).JPEG', out);
    assert.equal(await readFile(path.join(out, 'Foto (1).JPEG'), 'utf8'), 'foto');
  } finally { await zip.close(); }
});

test('rejects a compressed directory hiding content before writing', async t => {
  const { file, out } = await archive(t, [{ name: 'media/', method: 8, data: 'oculto', size: 0, external: (0o040755 << 16) | 0x10 }]);
  let zip;
  try { await assert.rejects(openZip(file).then(value => { zip = value; return value; }), isError(message.size)); }
  finally { await zip?.close(); }
  assert.deepEqual(await readdir(out), []);
});

const unsafe = [
  ['traversal', [{ name: 'media/../salida.png' }], message.name],
  ['embedded dot-dot', [{ name: 'media/a..png' }], message.name],
  ['absolute', [{ name: '/media/a.png' }], message.name],
  ['drive letter', [{ name: 'C:/media/a.png' }], message.name],
  ['backslash', [{ name: 'media\\a.png' }], message.name],
  ['empty name', [{ name: '' }], message.name],
  ['NUL', [{ name: 'media/a\0.png' }], message.name],
  ['nested directory', [{ name: 'media/sub/a.png' }], message.name],
  ['other directory', [{ name: 'otro/' }], message.name],
  ['bad extension', [{ name: 'media/a.exe' }], message.name],
  ['empty PNG basename', [{ name: 'media/.png' }], message.name],
  ['empty MP4 basename', [{ name: 'media/.mp4' }], message.name],
  ['empty font basename', [{ name: 'media/.woff2' }], message.name],
  ['case-insensitive duplicate', [{ name: 'media/a.PNG' }, { name: 'media/A.png' }], message.duplicate],
  ['encrypted', [{ name: 'config.json', flags: 1 }], message.encrypted],
  ['unsupported method', [{ name: 'config.json', method: 12 }], message.method],
  ['symbolic link', [{ name: 'media/a.png', external: 0o120777 << 16 }], message.link],
  ['directory disguised as file', [{ name: 'media/a.png', external: (0o040755 << 16) | 0x10 }], message.link],
  ['oversized config', [{ name: 'config.json', size: 8 * MiB + 1 }], message.config],
  ['oversized media', [{ name: 'media/a.webm', size: 300 * MiB + 1 }], message.media],
  ['oversized session', [{ name: 'sessions/a.json', size: 64 * MiB + 1 }], 'Un directo del ZIP supera 64 MB.'],
  ['oversized total', Array.from({ length: 8 }, (_, i) => ({ name: `media/${i}.webm`, size: 300 * MiB })), message.total],
  ['too many entries', Array.from({ length: 4097 }, (_, i) => ({ name: `media/${i}.png` })), message.count],
];
for (const [label, entries, expected] of unsafe) {
  test(`rejects ${label} before writing`, async t => {
    const { file, out } = await archive(t, entries);
    await writeFile(path.join(out, 'sentinel'), 'sin cambios');
    await assert.rejects(openZip(file), isError(expected));
    assert.deepEqual(await readdir(out), ['sentinel']);
    assert.equal(await readFile(path.join(out, 'sentinel'), 'utf8'), 'sin cambios');
  });
}

// The second valid local header is embedded in the first entry's data.
const inner = rawZip([{ name: 'media/b.png', data: 'b' }]);
const embedded = inner.subarray(0, 30 + Buffer.byteLength('media/b.png') + 1);
const safetyCases = [
  ['NFC/NFD duplicate names', [{ name: 'media/café.png' }, { name: 'media/cafe\u0301.png' }]],
  ['local/central name mismatch', [{ name: 'media/a.png', localName: 'media/b.png' }]],
  ['overlapping offsets', [{ name: 'media/a.png', data: embedded }, { name: 'media/b.png', data: 'b', offset: 30 + Buffer.byteLength('media/a.png') }]],
  ['ZIP64 extra field', [{ name: 'config.json', extra: Buffer.from([1, 0, 0, 0]) }]],
  ['data after the end record', [{ name: 'config.json' }], { suffix: Buffer.from('extra') }],
  ['4097 entries', Array.from({ length: 4097 }, (_, i) => ({ name: `media/${i}.png` }))],
  ['encryption flag 0x40', [{ name: 'config.json', flags: 0x40 }]],
  ['symlink attribute', [{ name: 'media/a.png', external: 0o120777 << 16 }]],
];
for (const [label, entries, opts] of safetyCases) test(`verifier safety: rejects ${label}`, async t => {
  const { file, out } = await archive(t, entries, opts);
  await writeFile(path.join(out, 'sentinel'), 'sin cambios');
  await assert.rejects(openZip(file), { status: 400 });
  assert.deepEqual(await readdir(out), ['sentinel']);
  assert.equal(await readFile(path.join(out, 'sentinel'), 'utf8'), 'sin cambios');
});

test('reading 20 media entries leaves no process warnings', async t => {
  const entries = [{ name: 'config.json', data: '{}' }, ...Array.from({ length: 20 }, (_, i) => ({ name: `media/${i}.png`, data: `contenido ${i}` }))];
  const { file, out } = await archive(t, entries), warnings = [];
  const onWarning = warning => warnings.push(warning); process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  const zip = await openZip(file);
  try {
    assert.equal((await zip.readConfig()).toString(), '{}');
    for (const e of entries.slice(1)) {
      const target = await zip.extract(e.name, out);
      assert.equal(await readFile(target, 'utf8'), e.data);
    }
  } finally { await zip.close(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warnings.map(w => `${w.name}: ${w.message}`), []);
});

test('writer rejects empty basenames before emitting and permits a hidden name with a basename', async t => {
  let emitted = 0;
  const dest = new Writable({ write(chunk, _enc, cb) { emitted += chunk.length; cb(); } });
  try { await assert.rejects(writeZip(dest, [{ name: 'media/.png', source: 'x' }]), isError(message.name)); }
  finally { dest.destroy(); }
  assert.equal(emitted, 0);
  const { file, out } = await archive(t, [{ name: 'media/.hidden.png', data: 'ok' }]);
  const zip = await openZip(file);
  try { assert.equal(await readFile(await zip.extract('media/.hidden.png', out), 'utf8'), 'ok'); }
  finally { await zip.close(); }
});

for (const [label, entry, expected] of [
  ['declared-size bomb', { name: 'media/lie.png', method: 8, data: Buffer.alloc(MiB, 65), size: 10 }, message.size],
  ['shorter than declared', { name: 'media/lie.png', method: 8, data: 'corto', size: 6 }, message.size],
  ['bad CRC', { name: 'media/lie.png', method: 8, data: 'contenido', crc: 123 }, message.crc],
]) {
  test(`rejects ${label} and cleans partial files without replacing the target`, async t => {
    const { file, out } = await archive(t, [entry]);
    await writeFile(path.join(out, 'lie.png'), 'original');
    const zip = await openZip(file);
    try { await assert.rejects(zip.extract('media/lie.png', out), isError(expected)); }
    finally { await zip.close(); }
    assert.deepEqual(await readdir(out), ['lie.png']);
    assert.equal(await readFile(path.join(out, 'lie.png'), 'utf8'), 'original');
  });
}

test('rejects malformed local headers before writing', async t => {
  const { file, out } = await archive(t, [{ name: 'media/a.png', data: 'a' }]);
  const bytes = await readFile(file); bytes.writeUInt16LE(8, 8); await writeFile(file, bytes);
  await assert.rejects(openZip(file), isError(message.invalid));
  assert.deepEqual(await readdir(out), []);
});

test('existing media upload and import still use the shared limit without changing behavior', async t => {
  const dir = await workspace(t), mediaDir = path.join(dir, 'media');
  const source = path.join(dir, 'source.png'); await writeFile(source, 'importado');
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const upload = await fetch(`${base}/api/media/upload?name=subido.png`, { method: 'POST', body: 'subido' });
    assert.equal(upload.status, 200); assert.equal((await upload.json()).name, 'subido.png');
    const imported = await fetch(`${base}/api/media/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: source }) });
    assert.equal(imported.status, 200); assert.equal((await imported.json()).name, 'source.png');
    assert.equal(await readFile(path.join(mediaDir, 'subido.png'), 'utf8'), 'subido');
    assert.equal(await readFile(path.join(mediaDir, 'source.png'), 'utf8'), 'importado');
  } finally { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
});

test('writer rejects a file over 4 GiB without reading or emitting it', async t => {
  const dir = await workspace(t), large = path.join(dir, 'large.webm');
  const fd = await open(large, 'w'); try { await fd.truncate(0x100000000); } finally { await fd.close(); }
  let emitted = 0; const dest = new Writable({ write(chunk, _enc, cb) { emitted += chunk.length; cb(); } });
  try { await assert.rejects(writeZip(dest, [{ name: 'media/large.webm', source: { path: large } }]), isError(message.zip64)); }
  finally { dest.destroy(); }
  assert.equal(emitted, 0);
});

test('sessions/ entries accept only a safe stream id with .json and reject caches and traversal', () => {
  const ok = '2026-10-01T18-00-00-000Z-11111111-1111-4111-8111-111111111111';
  assert.doesNotThrow(() => checkZipName(`sessions/${ok}.json`));
  assert.doesNotThrow(() => checkZipName('sessions/legacy_id-1.json'));
  for (const name of ['sessions/', 'sessions/.json', `sessions/${ok}.meta.json`, 'sessions/../config.json', 'sessions/a/b.json',
    'sessions/a b.json', 'sessions/a.txt', 'sessions/a.JSON', `sessions/${'x'.repeat(200)}.json`, 'sessions/a\\b.json'])
    assert.throws(() => checkZipName(name), { message: 'Nombre de archivo no permitido en el ZIP.' }, name);
  const seen = new Set(); checkZipName('sessions/Abc.json', seen);
  assert.throws(() => checkZipName('sessions/abc.json', seen), { message: 'El ZIP contiene nombres duplicados.' });
});
