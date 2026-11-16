// ZIP clásico sin dependencias (Node >= 24). Límites de importación: 8 MiB por
// config, 300 MiB por medio, 2 GiB en total, 4096 entradas y 16 MiB de directorio.
// writeZip(dest, [{name, source}]) cierra dest; source es Buffer/string o {path}.
// openZip(path) devuelve {entries, readConfig(), extract(name, dir), close()}.
// extract deposita el basename en un directorio de staging confiable ya existente;
// el llamador debe cerrar el lector y conservar el archivo ZIP sin modificar.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createDeflateRaw, createInflateRaw } from 'node:zlib';
import { mediaKind } from './alerts.mjs';
import { httpError } from './http-util.mjs';
import { MAX_UPLOAD } from './routes/media.mjs';

const MAX32 = 0xffffffff, MAX_CONFIG = 8 * 1024 * 1024, MAX_DIRECTORY = 16 * 1024 * 1024;
export const MAX_ZIP_TOTAL = 2 * 1024 ** 3, MAX_ZIP_ENTRIES = 4096;
const errors = {
  name: 'Nombre de archivo no permitido en el ZIP.', missingConfig: 'El archivo no contiene config.json', duplicate: 'El ZIP contiene nombres duplicados.',
  encrypted: 'El ZIP contiene archivos cifrados.', method: 'Método de compresión no admitido en el ZIP.',
  link: 'El ZIP contiene enlaces o tipos de archivo no admitidos.', count: 'El ZIP contiene demasiadas entradas.',
  config: 'El archivo config.json supera 8 MB.', media: 'El archivo de medios supera 300 MB.',
  total: 'El ZIP supera el límite total de 2 GB.', size: 'El tamaño declarado no coincide con el contenido del ZIP.',
  crc: 'El CRC del archivo ZIP no coincide.', invalid: 'ZIP inválido o incompleto.',
  zip64: 'El ZIP supera el límite sin ZIP64.',
};
const fail = key => { throw httpError(400, errors[key]); };
const u16 = (b, n) => b.readUInt16LE(n), u32 = (b, n) => b.readUInt32LE(n);
const decoder = new TextDecoder('utf-8', { fatal: true });

export function checkZipName(name, seen = new Set()) {
  const base = name.startsWith('media/') ? name.slice(6) : '';
  if (name !== 'config.json' && name !== 'media/' &&
      (!base || base.lastIndexOf('.') === 0 || name.includes('..') || base.includes('/') || base.length > 255 ||
       /[\\\x00-\x1f\x7f<>:"|?*]/.test(base) || /[. ]$/.test(base) ||
       /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) || !mediaKind(base))) fail('name');
  const key = name.normalize('NFC').toLowerCase();
  if (seen.has(key)) fail('duplicate');
  seen.add(key);
}
function checkSize(name, size) {
  if (name === 'config.json' && size > MAX_CONFIG) fail('config');
  if (name.startsWith('media/') && size > MAX_UPLOAD) fail('media');
  if (name === 'media/' && size !== 0) fail('invalid');
}
function checkExtra(extra) {
  for (let p = 0; p < extra.length;) {
    if (p + 4 > extra.length) fail('invalid');
    const id = u16(extra, p), length = u16(extra, p + 2); p += 4;
    if (p + length > extra.length) fail('invalid');
    if (id === 1) fail('zip64');
    if (id === 0x000d || id === 0x756e) fail('link');
    p += length;
  }
}
async function readAt(fd, pos, length, end) {
  if (pos < 0 || length < 0 || pos + length > end) fail('invalid');
  const b = Buffer.alloc(length); let n = 0;
  while (n < length) {
    const result = await fd.read(b, n, length - n, pos + n);
    if (!result.bytesRead) fail('invalid');
    n += result.bytesRead;
  }
  return b;
}

// Data descriptors permiten CRC y tamaños calculados mientras se comprime.
export async function writeZip(dest, entries) {
  let offset = 0, total = 0; const seen = new Set(), central = [];
  const onError = () => {}; dest.on('error', onError);
  const send = async b => {
    if (offset + b.length > MAX32) fail('zip64');
    await new Promise((resolve, reject) => dest.write(b, e => e ? reject(e) : resolve()));
    offset += b.length;
  };
  try {
    if (entries.length > MAX_ZIP_ENTRIES) fail('count');
    // Preflight antes de producir bytes, incluso para archivos dispersos > 4 GiB.
    const inputs = [];
    for (const { name, source } of entries) {
      checkZipName(name, seen);
      const filename = source && typeof source === 'object' && !Buffer.isBuffer(source) ? source.path : null;
      const data = filename ? null : Buffer.isBuffer(source) ? source : Buffer.from(source);
      const size = filename ? (await stat(filename)).size : data.length;
      if (size > MAX32) fail('zip64');
      checkSize(name, size); total += size; if (total > MAX_ZIP_TOTAL) fail('total');
      inputs.push({ name, filename, data, size });
    }
    for (const { name, filename, data, size: expected } of inputs) {
      const n = Buffer.from(name), localOffset = offset, header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6);
      header.writeUInt16LE(8, 8); header.writeUInt16LE(n.length, 26);
      await send(header); await send(n);
      let size = 0, compressed = 0, crc = 0;
      const meter = new Transform({ transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > MAX32) return cb(httpError(400, errors.zip64));
        if (size > expected) return cb(httpError(400, errors.size));
        crc = crc32(chunk, crc); cb(null, chunk);
      } });
      const sink = new Writable({ write(chunk, _enc, cb) {
        compressed += chunk.length;
        send(chunk).then(() => cb(), cb);
      } });
      await pipeline(filename ? createReadStream(filename) : Readable.from([data]), meter, createDeflateRaw(), sink);
      if (size !== expected) fail('size');
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12); await send(descriptor);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x808, 8); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compressed, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(n.length, 28);
      cd.writeUInt32LE(((name === 'media/' ? 0o040755 : 0o100644) << 16 | (name === 'media/' ? 0x10 : 0)) >>> 0, 38);
      cd.writeUInt32LE(localOffset, 42); central.push(cd, n);
    }
    const start = offset;
    for (const b of central) await send(b);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(inputs.length, 8); end.writeUInt16LE(inputs.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); await send(end);
    await new Promise((resolve, reject) => dest.end(e => e ? reject(e) : resolve()));
  } catch (err) { dest.destroy(); throw err; }
  finally { dest.off('error', onError); }
}

export async function openZip(filename) {
  const fd = await open(filename, 'r');
  try {
    const length = (await fd.stat()).size, tailStart = Math.max(0, length - 65557);
    const tail = await readAt(fd, tailStart, length - tailStart, length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === 0x06054b50 && i + 22 + u16(tail, i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) fail('invalid');
    const end = tailStart + eocd, disk = u16(tail, eocd + 4), cdDisk = u16(tail, eocd + 6);
    const count = u16(tail, eocd + 10), cdSize = u32(tail, eocd + 12), cdStart = u32(tail, eocd + 16);
    if (count > MAX_ZIP_ENTRIES) fail('count');
    if (disk || cdDisk || u16(tail, eocd + 8) !== count || cdSize > MAX_DIRECTORY || cdStart + cdSize !== end) fail('invalid');
    const records = [], seen = new Set(); let cursor = cdStart, total = 0;
    for (let i = 0; i < count; i++) {
      const cd = await readAt(fd, cursor, 46, end);
      if (u32(cd, 0) !== 0x02014b50) fail('invalid');
      const flags = u16(cd, 8), method = u16(cd, 10), crc = u32(cd, 16);
      const compressed = u32(cd, 20), size = u32(cd, 24), nameLen = u16(cd, 28);
      const extraLen = u16(cd, 30), commentLen = u16(cd, 32), attr = u32(cd, 38), local = u32(cd, 42);
      if (flags & 0x2041) fail('encrypted');
      if (flags & ~0x080e || u16(cd, 34)) fail('invalid');
      if (method !== 0 && method !== 8) fail('method');
      if (size === MAX32 || compressed === MAX32 || local === MAX32) fail('zip64');
      const variable = await readAt(fd, cursor + 46, nameLen + extraLen + commentLen, end);
      const nameBytes = variable.subarray(0, nameLen); let name;
      try { name = decoder.decode(nameBytes); } catch { fail('name'); }
      checkZipName(name, seen); checkSize(name, size); total += size;
      if (total > MAX_ZIP_TOTAL) fail('total');
      checkExtra(variable.subarray(nameLen, nameLen + extraLen));
      const type = (attr >>> 16) & 0o170000, dir = name === 'media/';
      if ((attr & 0x400) || (type && type !== (dir ? 0o040000 : 0o100000)) || (!dir && (attr & 0x10))) fail('link');
      if (dir && (size || compressed || crc) && method === 0) fail('invalid');
      records.push({ name, nameBytes, flags, method, crc, compressed, size, local });
      cursor += 46 + variable.length;
    }
    if (cursor !== end) fail('invalid');
    // Validar todos los encabezados y rangos antes de permitir cualquier extracción.
    for (const e of records) {
      const local = await readAt(fd, e.local, 30, cdStart);
      if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== e.flags || u16(local, 8) !== e.method) fail('invalid');
      const n = u16(local, 26), x = u16(local, 28);
      const variable = await readAt(fd, e.local + 30, n + x, cdStart);
      if (!variable.subarray(0, n).equals(e.nameBytes)) fail('invalid');
      checkExtra(variable.subarray(n));
      if (!(e.flags & 8) && (u32(local, 14) !== e.crc || u32(local, 18) !== e.compressed || u32(local, 22) !== e.size)) fail('invalid');
      e.start = e.local + 30 + n + x; e.end = e.start + e.compressed;
      if (e.end > cdStart) fail('invalid');
    }
    const ordered = [...records].sort((a, b) => a.local - b.local);
    for (let i = 1; i < ordered.length; i++) if (ordered[i].local < ordered[i - 1].end) fail('invalid');
    const byName = new Map(records.map(e => [e.name, e]));
    async function consume(e, sink) {
      let size = 0, crc = 0;
      // Use the numeric descriptor: FileHandle.createReadStream retains a close listener per entry.
      const source = e.compressed ? createReadStream(null, { fd: fd.fd, start: e.start, end: e.end - 1, autoClose: false }) : Readable.from([]);
      const inflate = e.method === 8 ? createInflateRaw() : null;
      const meter = new Transform({ transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > e.size) return cb(httpError(400, errors.size));
        crc = crc32(chunk, crc); cb(null, chunk);
      } });
      try { await pipeline(source, ...(inflate ? [inflate] : []), meter, sink); }
      catch (err) { if (err.status === 400) throw err; if (err.code?.startsWith('Z_')) fail('invalid'); throw err; }
      if (inflate && inflate.bytesWritten !== e.compressed) fail('invalid');
      if (size !== e.size) fail('size');
      if (crc !== e.crc) fail('crc');
    }
    // La carpeta opcional nunca se extrae: verificarla aquí para no ignorar
    // datos ocultos, CRC incorrecto o un flujo deflate que infle más de cero.
    for (const e of records) if (e.name === 'media/') {
      await consume(e, new Writable({ write(_chunk, _enc, cb) { cb(); } }));
    }
    function entry(name) {
      const e = byName.get(name); if (!e || name === 'media/') fail('name'); return e;
    }
    return {
      entries: Object.freeze(records.map(e => Object.freeze({ name: e.name, size: e.size, compressedSize: e.compressed, method: e.method, crc32: e.crc }))),
      async readConfig() {
        const chunks = [], sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
        const config = byName.get('config.json'); if (!config) fail('missingConfig');
        await consume(config, sink); return Buffer.concat(chunks);
      },
      async extract(name, dir) {
        const e = entry(name), target = path.join(dir, path.basename(name));
        const temp = path.join(dir, `.antena-zip-${randomBytes(16).toString('hex')}.part`);
        const file = await open(temp, 'wx', 0o644); let done = false;
        try { await consume(e, file.createWriteStream()); await rename(temp, target); done = true; return target; }
        finally { await file.close().catch(() => {}); if (!done) await unlink(temp).catch(() => {}); }
      },
      async close() { await fd.close(); },
    };
  } catch (err) { await fd.close(); throw err; }
}
