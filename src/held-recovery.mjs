// Solo instantáneas finalizadas explícitas. Sin Engine, Store, repetición ni registro de payload.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { createWindowsHeldRecovery } from './held-recovery-windows.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => { throw new TypeError('Invalid held recovery data or limits'); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = s => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const exact = (v, keys) => object(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const IO_CODES = new Set(['EACCES', 'EBADF', 'EBUSY', 'EDQUOT', 'EEXIST', 'EINVAL', 'EIO', 'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EROFS', 'EXDEV']);
function saveFailure(error, phase, publication) {
  let code;
  try { code = error?.code; } catch { /* Las propiedades de un error no fiable no son diagnóstico. */ }
  // Nunca se retiene el error IO crudo (ni cause, mensaje, ruta ni payload).
  return Object.assign(new Error('Held recovery save failed'), {
    name: 'HeldRecoverySaveError', phase, publication, code: IO_CODES.has(code) ? code : 'EIO',
  });
}

// Se inspeccionan descriptores, nunca valores de propiedades de entrada no fiable. Los proxies se rechazan
// before reflection. Object undefined is the JSON omission used by finalize().
function copy(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail();
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(k => typeof k === 'symbol' || k === 'toJSON')) fail();
  const out = array ? [] : Object.create(null);
  ancestors.add(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (array && key === 'length') continue;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail();
    if (descriptor.value === undefined) { if (array) fail(); else continue; }
    out[key] = copy(descriptor.value, ancestors);
  }
  if (array && Object.keys(out).length !== value.length) fail();
  ancestors.delete(value);
  return out;
}

export function createHeldRecovery({ dir, maxAlertBytes, maxBatchBytes, io = fs, uuid = randomUUID, now = () => new Date().toISOString(), platform = process.platform, windows, windowsFactory = createWindowsHeldRecovery }) {
  if (typeof dir !== 'string' || !dir || !positive(maxAlertBytes) || !positive(maxBatchBytes) || !['win32', 'linux', 'darwin', 'aix', 'freebsd', 'openbsd', 'sunos', 'android'].includes(platform)) fail();
  const win = platform === 'win32';
  const paths = win ? path.win32 : path;
  const base = paths.resolve(dir), root = paths.join(base, 'held-recovery');
  // Solo entradas de confianza explícitas; el valor por defecto en producción es el helper real de ACL.
  // La inyección de fábrica/plataforma es para tests, nunca un sustituto del modo privado.
  const acl = win ? windowsFactory({ base, systemRoot: windows?.systemRoot, tempDir: windows?.tempDir }) : null;
  if (win && ['inspectNamespace', 'createNamespace', 'createBatch', 'createTemp', 'verifyDirectory', 'verifyFile'].some(key => typeof acl?.[key] !== 'function')) fail();
  const bytes = v => Buffer.byteLength(JSON.stringify(v));
  function alertValid(alert) {
    if (!object(alert) || typeof alert.id !== 'string' || !alert.id || typeof alert.type !== 'string' || !alert.type || !Array.isArray(alert.actions) || !object(alert.vars) || bytes(alert) > maxAlertBytes) fail();
  }
  function validate(batch, id) {
    if (!exact(batch, 'version,app,batchId,createdAt,state,records') || batch.version !== 1 || batch.app !== 'antena' || batch.batchId !== id || !iso(batch.createdAt) || batch.state !== 'pending' || !Array.isArray(batch.records)) fail();
    batch.records.forEach((r, ordinal) => {
      if (!exact(r, 'id,ordinal,state,alert') || r.ordinal !== ordinal || r.state !== 'not-dispatched') fail();
      alertValid(r.alert);
      if (r.id !== r.alert.id) fail();
    });
  }
  const metadata = b => ({ batchId: b.batchId, createdAt: b.createdAt, state: b.state, count: b.records.length });
  async function directory(target, privateMode = false) {
    const s = await io.lstat(target);
    if (!s.isDirectory() || s.isSymbolicLink() || (privateMode && (s.mode & 0o077))) fail();
  }
  async function baseAccess() {
    // Se rechazan ancestros de enlace simbólico además de los enlaces del propio namespace. Sin chmod recursivo.
    let current = path.parse(base).root;
    await directory(current);
    for (const part of base.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); await directory(current);
    }
  }
  async function access(create) {
    await baseAccess();
    if (create) {
      try { await io.mkdir(root, { mode: 0o700 }); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    await directory(root, true);
  }
  async function save(snapshots) {
    // Instantánea antes del primer await, sin ejecutar getters/toJSON/acciones.
    const alerts = copy(snapshots);
    if (!Array.isArray(alerts)) fail();
    alerts.forEach(alertValid);
    const batchId = uuid(), createdAt = now();
    if (typeof batchId !== 'string' || !UUID.test(batchId) || !iso(createdAt)) fail();
    const batch = { version: 1, app: 'antena', batchId, createdAt, state: 'pending', records: alerts.map((alert, ordinal) => ({ id: alert.id, ordinal, state: 'not-dispatched', alert })) };
    const text = JSON.stringify(batch);
    if (Buffer.byteLength(text) > maxBatchBytes) fail();
    // Fases cerradas: access, mkdir, create-temp, verify-temp-before-open,
    // open, verify-open, write, close, verify-temp-before-link, link,
    // verify-final, unlink. Diagnostics never include helper output.
    let phase = 'access', publication = 'not-published';
    try {
      if (win) await acl.createNamespace();
      else await access(true);
      const folder = paths.join(root, batchId);
      // Identidad exclusiva: se conserva el EEXIST observado, nunca se reutiliza ni se reintenta.
      phase = 'mkdir';
      if (win) await acl.createBatch(batchId);
      else await io.mkdir(folder, { mode: 0o700 });
      const temp = paths.join(folder, '.batch.tmp');
      if (win) {
        phase = 'create-temp'; await acl.createTemp(batchId);
        phase = 'verify-temp-before-open'; await acl.verifyFile(batchId, '.batch.tmp');
      }
      phase = 'open';
      const handle = win ? await io.open(temp, 'r+') : await io.open(temp, 'wx', 0o600);
      try {
        if (win) {
          phase = 'verify-open';
          const opened = await handle.stat();
          if (!opened.isFile() || opened.size !== 0) fail();
        }
        phase = 'write'; await handle.writeFile(text);
      }
      catch (err) {
        // Un solo close, conservando el primer fallo aunque close también falle.
        try { await handle.close(); } catch { /* Sin limpieza ni reintento. */ }
        throw err;
      }
      phase = 'close';
      await handle.close();
      if (win) {
        phase = 'verify-temp-before-link'; await acl.verifyFile(batchId, '.batch.tmp');
      }
      // Publicación atómica no-replace en los sistemas de ficheros que la soportan, no durabilidad fsync.
      // Sin repliegue a rename. Un link que lanza puede haber publicado ya.
      phase = 'link'; publication = 'unknown';
      await io.link(temp, paths.join(folder, 'batch.json'));
      publication = 'published';
      if (win) {
        phase = 'verify-final'; await acl.verifyFile(batchId, 'batch.json');
      }
      phase = 'unlink'; await io.unlink(temp);
      return metadata(batch);
    } catch (err) {
      // Los directorios/temporales se conservan como evidencia; un rechazo no es ausencia.
      throw saveFailure(err, phase, publication);
    }
  }
  async function readBatch(id) {
    if (!UUID.test(id)) fail();
    const folder = paths.join(root, id);
    if (win) await acl.verifyDirectory(id);
    await directory(folder, !win);
    const entries = await io.opendir(folder);
    let count = 0;
    for await (const entry of entries) {
      if (++count > 1 || entry.name !== 'batch.json' || !entry.isFile() || entry.isSymbolicLink()) fail();
    }
    if (count !== 1) fail();
    const file = paths.join(folder, 'batch.json');
    if (win) await acl.verifyFile(id, 'batch.json');
    const stat = await io.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (!win && (stat.mode & 0o077)) || stat.size > maxBatchBytes) fail();
    // El O_NOFOLLOW de POSIX es obligatorio ahí, no un sustituto de las ACL de Windows.
    if (!win && constants.O_NOFOLLOW === undefined) fail();
    const handle = await io.open(file, win ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW);
    let text;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxBatchBytes) fail();
      const buffer = Buffer.alloc(Math.min(maxBatchBytes + 1, opened.size + 1));
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used !== opened.size) fail();
      text = buffer.toString('utf8', 0, used);
    } finally { await handle.close(); }
    // Se recomprueba ACL/reparse de Windows tras leer; no es una instantánea del FS a prueba de adversarios.
    if (win) await acl.verifyFile(id, 'batch.json');
    // Bytes acotados, no una instantánea frente a adversarios: una mutación tras EOF puede colarse.
    const batch = copy(JSON.parse(text));
    validate(batch, id);
    return metadata(batch);
  }
  async function list({ limit } = {}) {
    if (!positive(limit)) fail();
    const result = { state: 'ok', batches: [], limited: false };
    if (win) {
      // El helper de solo lectura valida base/ancestros y clasifica únicamente el namespace.
      try {
        const state = await acl.inspectNamespace();
        if (state === 'absent') return result;
        if (state !== 'valid') fail();
      } catch { return { ...result, state: 'blocked' }; }
    } else {
      // Una base/ancestro ausente es un fallo de configuración, nunca una cola vacía.
      try { await baseAccess(); }
      catch { return { ...result, state: 'blocked' }; }
      // Solo esta fase puede interpretar ENOENT como namespace ausente.
      try { await directory(root, true); }
      catch (err) {
        let code;
        try { code = err?.code; } catch { /* Un getter de error IO no es un diagnóstico seguro. */ }
        if (code === 'ENOENT') return result;
        return { ...result, state: 'blocked' };
      }
    }
    try {
      const entries = await io.opendir(root);
      let seen = 0;
      for await (const entry of entries) {
        if (++seen > limit) { result.state = 'blocked'; result.limited = true; break; }
        try {
          if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
          result.batches.push(await readBatch(entry.name));
        } catch { result.state = 'blocked'; }
      }
    } catch { result.state = 'blocked'; }
    return result;
  }
  return { save, list };
}
