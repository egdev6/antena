// Transferencia portable v1: JSON compatible y ZIP con medios. Las copias locales son privadas.
import { readFile, readdir, lstat, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT, DEFAULT_CONFIG, deepMerge } from '../store.mjs';
import { PROTO_KEYS, validatePatch, validateImportedChatVariants } from '../config-schema.mjs';
import { httpError } from '../http-util.mjs';
import { checkZipName, openZip, writeZip, MAX_ZIP_TOTAL, MAX_ZIP_ENTRIES } from '../zip-archive.mjs';
import { MAX_UPLOAD } from './media.mjs';

const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const object = value => value !== null && typeof value === 'object';
// Unknown schema fields are accepted by generic writes; do not export common credential names.
const credential = (key, prefix) => (prefix === 'access' && key === 'key') ||
  /token|secret|password|passwd|apikey|privatekey|credential|^passphrase$|^authorization$/i.test(key.replace(/[_-]/g, '')) ||
  (['twitch', 'youtube'].includes(prefix) && ['access', 'refresh'].includes(key));
const credentialParam = key => ['key', 'pass', 'pwd', 'auth'].includes(key.toLowerCase()) || credential(key, '');

// Only portable URL parts leave the PC; whitespace must not bypass credential detection.
function cleanUrl(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^wss?:\/\//i.test(trimmed)) return value;
  try {
    const url = new URL(trimmed); let changed = !!(url.username || url.password);
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) if (credentialParam(key)) { url.searchParams.delete(key); changed = true; }
    return changed ? url.toString() : trimmed;
  } catch {
    // Meld accepts arbitrary text, including malformed URLs. Redact their authority and query
    // without relying on URL parsing; if even the split is ambiguous, fail closed.
    const parts = /^(wss?:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?(#.*)?$/is.exec(trimmed);
    if (!parts) return '';
    const at = parts[2].lastIndexOf('@');
    let changed = at !== -1;
    const query = new URLSearchParams(parts[4] || '');
    for (const key of [...query.keys()]) if (credentialParam(key)) { query.delete(key); changed = true; }
    if (!changed) return trimmed;
    const params = query.toString();
    return `${parts[1]}${parts[2].slice(at + 1)}${parts[3]}${params ? '?' + params : ''}${parts[5] || ''}`;
  }
}

// Retain only local credentials, never the old destination, and only for the same endpoint.
function withLocalUrlCredentials(previous, imported) {
  if (typeof previous !== 'string' || typeof imported !== 'string') return imported;
  try {
    const local = new URL(previous.trim()), next = new URL(imported);
    if (local.protocol !== next.protocol || local.hostname !== next.hostname || local.port !== next.port) return imported;
    let changed = !!(local.username || local.password);
    next.username = local.username; next.password = local.password;
    for (const [key, value] of local.searchParams) if (credentialParam(key)) { next.searchParams.append(key, value); changed = true; }
    return changed ? next.toString() : imported;
  } catch { return imported; }
}

function portable(value, prefix = '', reject = false) {
  if (!object(value)) return value;
  const out = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (PROTO_KEYS.has(key)) { if (reject) throw httpError(400, `Clave de configuración no válida: ${p}`); continue; }
    if (credential(key, prefix)) { if (reject) throw httpError(400, `El archivo contiene credenciales: ${p}`); continue; }
    const clean = (p === 'meld.url' || p === 'obs.url') ? cleanUrl(child) : child;
    if (reject && clean !== child && typeof child === 'string' && clean !== child.trim()) throw httpError(400, `El archivo contiene credenciales: ${p}`);
    out[key] = portable(clean, p, reject);
  }
  return out;
}

function preserveLocal(previous, next, prefix = '') {
  if (!object(previous) || !object(next)) return false;
  let kept = false;
  for (const [key, value] of Object.entries(previous)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (PROTO_KEYS.has(key)) continue;
    if (credential(key, prefix)) {
      next[key] = structuredClone(value); kept = true;
    } else if (p === 'meld.url' || p === 'obs.url') {
      next[key] = withLocalUrlCredentials(value, next[key]);
    } else if (object(value)) {
      const compatible = object(next[key]) && Array.isArray(value) === Array.isArray(next[key]);
      const branch = compatible ? next[key] : (Array.isArray(value) ? [] : {});
      if (preserveLocal(value, branch, p)) { if (!compatible) next[key] = branch; kept = true; }
    }
  }
  return kept;
}

function changes(previous, next) {
  const summary = {};
  const visit = (a, b, p, section) => {
    if (isDeepStrictEqual(a, b)) return;
    const entry = () => summary[section] ||= { added: { count: 0, paths: [] }, removed: { count: 0, paths: [] }, changed: { count: 0, paths: [] } };
    if (a === undefined || b === undefined || !object(a) || !object(b) || Array.isArray(a) || Array.isArray(b)) {
      const bucket = entry()[a === undefined ? 'added' : b === undefined ? 'removed' : 'changed'];
      bucket.paths.push(p); bucket.count++; return;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) visit(a[k], b[k], p ? `${p}.${k}` : k, section);
  };
  for (const k of new Set([...Object.keys(previous), ...Object.keys(next)])) visit(previous[k], next[k], k, k);
  return summary;
}

/** Strict like PUT /api/config (including theme ranges), not theme-import clamping.
 * Overlay approval/version fields are local trust state and never imported as approvals. */
export function registerConfigTransferRoutes({ route, store, customOverlays, afterConfig, mediaDir, configTransferIO = {}, zipUploadLimit, zipExportLimit }) {
  // The keyed fingerprint binds both current private state and the exact file without exposing either.
  const fingerprintKey = randomBytes(32);
  const fingerprint = (before, file) => createHmac('sha256', fingerprintKey).update(JSON.stringify([before, file])).digest('hex');
  const exportFile = () => ({ format: 'antena-config', version: 1, exportedAt: new Date().toISOString(), app: VERSION, config: portable(store.config) });
  const prepare = file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.format !== 'antena-config') throw httpError(400, 'Formato de configuración no válido');
    if (file.version !== 1) throw httpError(400, 'Versión de configuración no compatible');
    if (!file.config || typeof file.config !== 'object' || Array.isArray(file.config)) throw httpError(400, 'La configuración debe ser un objeto');
    const { config: _config, ...metadata } = file;
    portable(metadata, '', true);
    const input = portable(file.config, '', true);
    const [error] = validatePatch(input); if (error) throw httpError(400, error.message);
    for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
      if (object(def) && Object.hasOwn(input, key) && (input[key] === null || typeof input[key] !== 'object' || Array.isArray(input[key]) !== Array.isArray(def)))
        throw httpError(400, `${key}: se esperaba ${Array.isArray(def) ? 'una lista' : 'un objeto'}`);
    }
    const before = structuredClone(store.config);
    const next = deepMerge(structuredClone(DEFAULT_CONFIG), input);
    next.port = before.port; preserveLocal(before, next);
    const chat = deepMerge(structuredClone(DEFAULT_CONFIG.widgets.chat), before.widgets?.chat || {});
    const [variantError] = validateImportedChatVariants(before.widgets?.chatVariants, next.widgets?.chatVariants, chat);
    if (variantError) throw httpError(400, variantError.message);
    next.customOverlays = customOverlays.prepareReplacement(next.customOverlays);
    const summary = changes(portable(before), portable(next));
    return { before, next, summary };
  };
  const conflict = () => httpError(409, 'La configuración ha cambiado; vuelve a previsualizar');
  const applyConfig = async ({ before, next, summary }, onCommit) => {
    const changed = Object.fromEntries(Object.keys(summary).map(key => [key, true]));
    // PUT treats recordOnStart alone as non-reconnecting.
    if (changed.meld && summary.meld.changed.paths.every(p => p === 'meld.recordOnStart') && !summary.meld.added.count && !summary.meld.removed.count) changed.meld = false;
    const backup = await store.replaceConfigWithBackup(next, before, { ...changed, all: true }, onCommit);
    if (changed.customOverlays) customOverlays.notify(next.customOverlays);
    afterConfig(changed);
    return { summary, backup };
  };
  route('POST', '/api/config/import/preview', async file => {
    const { before, summary } = prepare(file);
    return { summary, fingerprint: fingerprint(before, file) };
  });
  route('POST', '/api/config/import', async (file, _, _url, req) => {
    const prepared = prepare(file);
    if (req.headers['x-config-fingerprint'] !== fingerprint(prepared.before, file)) throw conflict();
    return applyConfig(prepared);
  });

  // Compute the same entry list for the cheap report and the download, before sending bytes.
  // zipExportLimit is a test seam; production is always capped by MAX_ZIP_TOTAL.
  const planExport = async file => {
    const config = JSON.stringify(file), entries = [{ name: 'config.json', source: config }], skipped = [], seen = new Set();
    const limit = Math.min(zipExportLimit ?? MAX_ZIP_TOTAL, MAX_ZIP_TOTAL);
    let total = Buffer.byteLength(config), full = false;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (const entry of (await readdir(mediaDir, { withFileTypes: true, encoding: 'buffer' })).sort((a, b) => Buffer.compare(a.name, b.name))) {
      if (entry.isDirectory()) continue;
      let name;
      try { name = decoder.decode(entry.name); } catch { skipped.push(`base64:${entry.name.toString('base64url')} (Nombre no válido en UTF-8)`); continue; }
      if (!entry.isFile()) { skipped.push(`${name} (No es un archivo normal)`); continue; }
      try { checkZipName(`media/${name}`, seen); }
      catch (err) { skipped.push(`${name} (${err.message})`); continue; }
      const filename = path.join(mediaDir, name); let info;
      try { info = await lstat(filename); } catch { skipped.push(`${name} (No se pudo leer el archivo)`); continue; }
      if (!info.isFile()) { skipped.push(`${name} (No es un archivo normal)`); continue; }
      if (info.size > MAX_UPLOAD) { skipped.push(`${name} (supera 300 MB)`); continue; }
      if (full || total + info.size > limit) { full = true; skipped.push(`${name} (límite total de 2 GB)`); continue; }
      if (entries.length >= MAX_ZIP_ENTRIES) { skipped.push(`${name} (límite de entradas del ZIP)`); continue; }
      total += info.size; entries.push({ name: `media/${name}`, source: { path: filename } });
    }
    return { entries, skipped };
  };
  // Header: base64url de un array JSON UTF-8 con nombre y motivo; nombres no UTF-8 usan «base64:<bytes base64url>».
  const exportZip = async (res, file) => {
    const { entries, skipped } = await planExport(file);
    if (skipped.length) {
      // Keep headers well below common client limits (Node: 16 KB); the full list is always
      // available from GET /api/config/export?skipped=1.
      const encoded = Buffer.from(JSON.stringify(skipped)).toString('base64url');
      res.setHeader('X-Antena-Skipped-Media-Count', String(skipped.length));
      if (encoded.length <= 8000) res.setHeader('X-Antena-Skipped-Media', encoded);
    }
    res.setHeader('Content-Disposition', `attachment; filename="antena-config-${file.exportedAt.slice(0, 10)}.zip"`);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/zip');
    await writeZip(res, entries);
  };
  const exportSkipped = async file => (await planExport(file)).skipped;
  const hashFile = async file => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  };
  const localHash = async name => {
    const file = path.join(mediaDir, name); let info;
    try { info = await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    if (!info.isFile()) throw httpError(400, 'El archivo de medios local no es un archivo normal');
    return hashFile(file);
  };
  const move = configTransferIO.rename || rename;
  let lastMediaBackup = 0;
  const applyMedia = async (prepared, media, state, stage) => {
    let backupName, backupDir, committed = false, preserve = false;
    const moved = [], installed = [];
    try {
      // Media routes are serialized by the dispatcher; recheck just before the first rename.
      for (const [name, expected] of state) if (await localHash(name) !== expected) throw conflict();
      if (media.replaced.length) {
        lastMediaBackup = Math.max(Date.now(), lastMediaBackup + 1);
        backupName = `.backup-${new Date(lastMediaBackup).toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
        backupDir = path.join(mediaDir, backupName); await mkdir(backupDir, { mode: 0o700 });
      }
      for (const name of [...media.replaced, ...media.added]) {
        const target = path.join(mediaDir, name);
        if (media.replaced.includes(name)) { await move(target, path.join(backupDir, name)); moved.push(name); }
        await move(path.join(stage, name), target); installed.push(name);
      }
      const result = await applyConfig(prepared, () => { committed = true; });
      return { ...result, media, mediaBackup: backupName || null };
    } catch (err) {
      if (!committed) {
        try {
          for (const name of installed.reverse()) await unlink(path.join(mediaDir, name));
          for (const name of moved.reverse()) await move(path.join(backupDir, name), path.join(mediaDir, name));
          if (backupDir) await rm(backupDir, { recursive: true, force: true });
        } catch (rollback) { preserve = true; throw Object.assign(new Error(`No se pudieron restaurar los medios; conserva las copias locales${backupName ? ` en media/${backupName}` : ''}`), { cause: rollback }); }
      }
      throw err;
    } finally {
      if (!preserve) await rm(stage, { recursive: true, force: true });
      if (committed && backupName) try {
        const backups = (await readdir(mediaDir)).filter(n => /^\.backup-\d{4}-\d\d-\d\dT[\dTZ-]+-[0-9a-f-]{36}$/.test(n) && n !== backupName).sort().reverse();
        for (const old of backups.slice(9)) await rm(path.join(mediaDir, old), { recursive: true, force: true });
      } catch { /* una limpieza fallida no deshace la importación confirmada */ }
    }
  };
  const importZip = async (req, applying) => {
    const limit = Math.min(zipUploadLimit ?? Infinity, 2 * 1024 ** 3 + 32 * 1024 ** 2);
    const tooLarge = () => httpError(413, 'El archivo ZIP es demasiado grande');
    if (Number(req.headers['content-length'] || 0) > limit) { req.resume(); throw tooLarge(); }
    const scratch = await mkdtemp(path.join(tmpdir(), 'antena-config-')); let zip, stage;
    try {
      const archive = path.join(scratch, 'upload.zip'), fd = await open(archive, 'wx', 0o600), hash = createHash('sha256'); let size = 0;
      try {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length; if (size > limit) { req.resume(); throw tooLarge(); }
          hash.update(chunk); await fd.writeFile(chunk);
        }
      } finally { await fd.close(); }
      zip = await openZip(archive); let file;
      try { file = JSON.parse((await zip.readConfig()).toString('utf8')); } catch (e) { if (e.status) throw e; throw httpError(400, 'JSON no válido'); }
      const prepared = prepare(file), state = [], media = { added: [], replaced: [], unchanged: 0 };
      stage = applying ? await mkdtemp(path.join(mediaDir, '.antena-stage-')) : path.join(scratch, 'stage');
      if (!applying) await mkdir(stage, { mode: 0o700 });
      for (const entry of zip.entries.filter(e => e.name.startsWith('media/') && e.name !== 'media/').sort((a, b) => a.name.localeCompare(b.name))) {
        const name = entry.name.slice(6), extracted = await zip.extract(entry.name, stage);
        const [incoming, current] = await Promise.all([hashFile(extracted), localHash(name)]); state.push([name, current]);
        if (current === null) media.added.push(name); else if (current !== incoming) media.replaced.push(name); else media.unchanged++;
      }
      const token = fingerprint(prepared.before, { archive: hash.digest('hex'), media: state });
      if (!applying) return { summary: prepared.summary, media, fingerprint: token };
      if (req.headers['x-config-fingerprint'] !== token) throw conflict();
      const dir = stage; stage = null; return await applyMedia(prepared, media, state, dir);
    } finally {
      if (zip) await zip.close();
      if (stage && applying) await rm(stage, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  };
  return { exportFile, exportZip, exportSkipped, importZip };
}
