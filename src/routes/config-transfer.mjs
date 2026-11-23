// Transferencia portable v1: JSON compatible y ZIP con medios. Las copias locales son privadas.
import { readFile, readdir, lstat, mkdir, mkdtemp, open, rename, rm, unlink } from 'node:fs/promises';
import { validDiscordEmoji } from '../discord.mjs';
import { createReadStream } from 'node:fs';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT, DEFAULT_CONFIG, deepMerge } from '../store.mjs';
import { migrateConfig } from '../config-migrations.mjs';
import { PROTO_KEYS, validatePatch, validateImportedChatVariants } from '../config-schema.mjs';
import { httpError, credential, credentialParam, cleanUrl } from '../http-util.mjs';
import { checkZipName, openZip, writeZip, MAX_ZIP_TOTAL, MAX_ZIP_ENTRIES, MAX_SESSION } from '../zip-archive.mjs';
import { isImportableArchive } from '../session.mjs';
import { serialize } from '../json-file.mjs';
import { checkInterviewsSection } from '../interviews.mjs';
import { MAX_UPLOAD } from './media.mjs';
import { metricsDocument } from './metrics.mjs';

// A stream must be importable and also valid for the metrics routes: one invalid archive makes
// GET /api/metrics/v1/sessions fail for every stream.
const validStream = (id, data) => {
  if (!isImportableArchive(data) || data.id !== id) return false;
  try { metricsDocument(id, data); return true; } catch { return false; }
};

const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const object = value => value !== null && typeof value === 'object';
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

export function portable(value, prefix = '', reject = false) {
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

export const transferAppVersion = VERSION;

// Shared streamed ZIP admission and lifetime for configuration and individual themes.
export async function withZipUpload(req, zipUploadLimit, callback, zipOptions) {
  const limit = Math.min(zipUploadLimit ?? Infinity, 2 * 1024 ** 3 + 32 * 1024 ** 2);
  const tooLarge = () => httpError(413, 'El archivo ZIP es demasiado grande');
  if (Number(req.headers['content-length'] || 0) > limit) { req.resume(); throw tooLarge(); }
  const scratch = await mkdtemp(path.join(tmpdir(), 'antena-config-')); let zip;
  try {
    const archive = path.join(scratch, 'upload.zip'), fd = await open(archive, 'wx', 0o600), hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length; if (size > limit) { req.resume(); throw tooLarge(); }
        hash.update(chunk); await fd.writeFile(chunk);
      }
    } finally { await fd.close(); }
    zip = await openZip(archive, zipOptions);
    return await callback(zip, hash.digest('hex'), scratch);
  } finally {
    if (zip) await zip.close();
    await rm(scratch, { recursive: true, force: true });
  }
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
export function registerConfigTransferRoutes({ route, store, customOverlays, afterConfig, mediaDir, configTransferIO = {}, zipUploadLimit, zipExportLimit, session, retention, afterSessions }) {
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
    const raw = portable(file.config, '', true);
    // Derived from the stored secret: like PUT, a value that matches is ignored and a different
    // one is rejected as read-only; it is never stored.
    if (raw?.discord && typeof raw.discord === 'object' && Object.hasOwn(raw.discord, 'webhookUrlSet')) {
      if (raw.discord.webhookUrlSet !== !!store.secrets.discord?.webhookUrl) throw httpError(400, 'discord.webhookUrlSet: es de solo lectura');
      delete raw.discord.webhookUrlSet;
    }
    // Valida primero lo que llegó: una migración no puede ocultar una sección o alias inválidos.
    if (raw?.scheduleCalendar && typeof raw.scheduleCalendar === 'object' && Object.hasOwn(raw.scheduleCalendar, 'tokenSet')) {
      if (raw.scheduleCalendar.tokenSet !== !!store.secrets.scheduleCalendar?.token) throw httpError(400, 'scheduleCalendar.tokenSet: es de solo lectura');
      delete raw.scheduleCalendar.tokenSet;
    }
    const [rawError] = validatePatch(raw); if (rawError) throw httpError(400, rawError.message);
    const input = migrateConfig(raw).config;
    const [error] = validatePatch(input); if (error) throw httpError(400, error.message);
    for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
      if (object(def) && Object.hasOwn(input, key) && (input[key] === null || typeof input[key] !== 'object' || Array.isArray(input[key]) !== Array.isArray(def)))
        throw httpError(400, `${key}: se esperaba ${Array.isArray(def) ? 'una lista' : 'un objeto'}`);
    }
    const before = structuredClone(store.config);
    const next = deepMerge(structuredClone(DEFAULT_CONFIG), input);
    for (const key of ['emojiTwitch', 'emojiYoutube'])
      if (next.discord?.[key] && !validDiscordEmoji(next.discord[key])) throw httpError(400, `discord.${key}: se esperaba un emoji de Discord como <:nombre:id>`);
    if (next.discord?.enabled && !store.secrets.discord?.webhookUrl)
      throw httpError(400, 'discord.enabled: guarda primero un webhook de Discord');
    if (next.scheduleCalendar?.enabled && (!store.secrets.scheduleCalendar?.token || store.dirty.secrets || store.pending.secrets > 0))
      throw httpError(400, 'scheduleCalendar.enabled: guarda primero una credencial');
    next.port = before.port; preserveLocal(before, next);
    const chat = deepMerge(structuredClone(DEFAULT_CONFIG.widgets.chat), before.widgets?.chat || {});
    const [variantError] = validateImportedChatVariants(before.widgets?.chatVariants, next.widgets?.chatVariants, chat);
    if (variantError) throw httpError(400, variantError.message);
    if (Object.hasOwn(next, 'interviews')) next.interviews = checkInterviewsSection(next.interviews);
    next.customOverlays = customOverlays.prepareReplacement(next.customOverlays);
    const summary = changes(portable(before), portable(next));
    return { before, next, summary };
  };
  const conflict = () => httpError(409, 'La configuración ha cambiado; vuelve a previsualizar');
  const applyConfig = async ({ before, next, summary }, onCommit) => {
    const changed = Object.fromEntries(Object.keys(summary).map(key => [key, true]));
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

  // Session archives preserve chat statistics, but never credential-named fields or the
  // local push obligation. Public session endpoints still project away authorIds.
  const cleanSession = data => { const { _pushExportOwed, ...rest } = portable(data); return rest; };
  const decodeSession = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  // Compute the same entry list for the cheap report and the download, before sending bytes.
  // zipExportLimit is a test seam; production is always capped by MAX_ZIP_TOTAL.
  const planExport = async (file, options = {}, scratch) => {
    const config = JSON.stringify(file), entries = [{ name: 'config.json', source: config }], skipped = [], seen = new Set();
    const limit = Math.min(zipExportLimit ?? MAX_ZIP_TOTAL, MAX_ZIP_TOTAL);
    let total = Buffer.byteLength(config), full = false;
    if (options.sessions) {
      const { archived, memory } = await session.exportableArchives();
      const streams = [...archived, ...memory.map(data => ({ id: data.id, data }))].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
      for (const stream of streams) {
        const name = `sessions/${stream.id}.json`;
        try { checkZipName(name, seen); } catch (err) { skipped.push(`${name} (${err.message})`); continue; }
        let data = stream.data, size;
        if (stream.path) {
          let info;
          try { info = await lstat(stream.path); } catch { skipped.push(`${name} (No se pudo leer el archivo)`); continue; }
          if (!info.isFile()) { skipped.push(`${name} (No es un archivo normal)`); continue; }
          if (info.size > MAX_SESSION) { skipped.push(`${name} (supera 64 MB)`); continue; }
          size = info.size;
          let bytes;
          try { bytes = await readFile(stream.path); } catch { skipped.push(`${name} (No se pudo leer el archivo)`); continue; }
          try { data = decodeSession(bytes); } catch { skipped.push(`${name} (JSON no válido)`); continue; }
        }
        if (data?.id !== stream.id && isImportableArchive(data)) { skipped.push(`${name} (el id no coincide con el nombre)`); continue; }
        if (!validStream(stream.id, data)) { skipped.push(`${name} (directo no válido)`); continue; }
        const clean = cleanSession(data), changed = !isDeepStrictEqual(clean, data);
        const sanitized = !stream.path || changed ? Buffer.from(serialize(clean)) : null;
        if (sanitized) size = sanitized.length;
        if (size > MAX_SESSION) { skipped.push(`${name} (supera 64 MB)`); continue; }
        if (full || total + size > limit) { full = true; skipped.push(`${name} (límite total de 2 GB)`); continue; }
        if (entries.length >= MAX_ZIP_ENTRIES) { skipped.push(`${name} (límite de entradas del ZIP)`); continue; }
        let source = stream.path ? { path: stream.path } : sanitized;
        if (stream.path && changed && scratch) {
          const target = path.join(scratch, `${stream.id}.json`), fd = await open(target, 'wx', 0o600);
          try { await fd.writeFile(sanitized); } finally { await fd.close(); }
          source = { path: target };
        }
        total += size; entries.push({ name, source });
      }
    }
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
  const exportZip = async (res, file, options = {}) => {
    const scratch = options.sessions ? await mkdtemp(path.join(tmpdir(), 'antena-config-export-')) : null;
    try {
      const { entries, skipped } = await planExport(file, options, scratch);
      if (skipped.length) {
        // Keep headers well below common client limits; the full list has a separate report.
        const encoded = Buffer.from(JSON.stringify(skipped)).toString('base64url');
        res.setHeader('X-Antena-Skipped-Media-Count', String(skipped.length));
        if (encoded.length <= 8000) res.setHeader('X-Antena-Skipped-Media', encoded);
      }
      res.setHeader('Content-Disposition', `attachment; filename="antena-config-${file.exportedAt.slice(0, 10)}.zip"`);
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/zip');
      await writeZip(res, entries);
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  };
  const exportSkipped = async (file, options = {}) => (await planExport(file, options)).skipped;
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
  const sessionStatus = async id => session.protectedIds().has(id) || await session.hasArchive(id) ? 'unchanged' : 'added';
  const applyMedia = async (prepared, media, state, stage, streams) => {
    let backupName, backupDir, committed = false, preserve = false;
    const moved = [], installed = [], written = [], caches = [];
    const counts = streams && { ...streams.counts };
    try {
      // Media routes are serialized by the dispatcher; session cutovers share the import lock.
      for (const [name, expected] of state) if (await localHash(name) !== expected) throw conflict();
      if (streams) for (const [id, expected] of streams.state) if (await sessionStatus(id) !== expected) throw conflict();
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
      if (streams) for (const [id, status] of streams.state) if (status === 'added') {
        const data = decodeSession(await readFile(path.join(streams.stage, `${id}.json`)));
        delete data._pushExportOwed;
        caches.push([id, await session.importCache(id)]);
        if (await session.importArchive(data, { locked: true })) written.push(id);
        else { caches.pop(); counts.added--; counts.unchanged++; }
      }
      if (counts) {
        delete counts.retention;
        if (streams.retention > 0 && await session.archiveCount() > streams.retention) counts.retention = streams.retention;
      }
      const result = await applyConfig(prepared, () => { committed = true; });
      return { ...result, media, mediaBackup: backupName || null, ...(counts ? { sessions: counts } : {}) };
    } catch (err) {
      if (!committed) {
        let sessionRollback;
        for (const id of written.reverse()) try { await session.removeImportedArchive(id, { locked: true }); } catch (rollback) { sessionRollback ||= rollback; }
        for (const [id, cache] of caches.reverse()) try { await session.restoreImportCache(id, cache); } catch (rollback) { sessionRollback ||= rollback; }
        try {
          for (const name of installed.reverse()) await unlink(path.join(mediaDir, name));
          for (const name of moved.reverse()) await move(path.join(backupDir, name), path.join(mediaDir, name));
          if (backupDir) await rm(backupDir, { recursive: true, force: true });
        } catch (rollback) { preserve = true; throw Object.assign(new Error(`No se pudieron restaurar los medios${sessionRollback ? ' ni los directos' : ''}; conserva las copias locales${backupName ? ` en media/${backupName}` : ''}`), { cause: rollback }); }
        if (sessionRollback) throw Object.assign(new Error('No se pudieron restaurar los directos importados.'), { cause: sessionRollback });
      }
      throw err;
    } finally {
      if (committed && written.length) try { await afterSessions(); } catch { /* el commit ya es durable */ }
      if (!preserve) await rm(stage, { recursive: true, force: true });
      if (committed && backupName) try {
        const backups = (await readdir(mediaDir)).filter(n => /^\.backup-\d{4}-\d\d-\d\dT[\dTZ-]+-[0-9a-f-]{36}$/.test(n) && n !== backupName).sort().reverse();
        for (const old of backups.slice(9)) await rm(path.join(mediaDir, old), { recursive: true, force: true });
      } catch { /* una limpieza fallida no deshace la importación confirmada */ }
    }
  };
  const importZip = async (req, applying) => withZipUpload(req, zipUploadLimit, async (zip, archiveHash, scratch) => {
    let stage;
    try {
      let file;
      try { file = JSON.parse((await zip.readConfig()).toString('utf8')); } catch (e) { if (e.status) throw e; throw httpError(400, 'JSON no válido'); }
      const prepared = prepare(file), state = [], media = { added: [], replaced: [], unchanged: 0 };
      stage = applying ? await mkdtemp(path.join(mediaDir, '.antena-stage-')) : path.join(scratch, 'stage');
      if (!applying) await mkdir(stage, { mode: 0o700 });
      for (const entry of zip.entries.filter(e => e.name.startsWith('media/') && e.name !== 'media/').sort((a, b) => a.name.localeCompare(b.name))) {
        const name = entry.name.slice(6), extracted = await zip.extract(entry.name, stage);
        const [incoming, current] = await Promise.all([hashFile(extracted), localHash(name)]); state.push([name, current]);
        if (current === null) media.added.push(name); else if (current !== incoming) media.replaced.push(name); else media.unchanged++;
      }
      const sessionEntries = zip.entries.filter(e => e.name.startsWith('sessions/')).sort((a, b) => a.name.localeCompare(b.name));
      let streams;
      if (sessionEntries.length) {
        const sessionStage = path.join(scratch, 'sessions'), sessionState = [], counts = { added: 0, unchanged: 0 };
        await mkdir(sessionStage, { mode: 0o700 });
        for (const entry of sessionEntries) {
          const id = entry.name.slice(9, -5), extracted = await zip.extract(entry.name, sessionStage);
          const bytes = await readFile(extracted); let data;
          try { data = decodeSession(bytes); } catch { throw httpError(400, 'El directo importado no es un JSON válido.'); }
          if (!isImportableArchive(data)) throw httpError(400, 'El directo importado no es válido.');
          if (data.id !== id) throw httpError(400, 'El directo importado no coincide con su nombre de archivo.');
          if (!validStream(id, data)) throw httpError(400, 'El directo importado no es válido.');
          const status = await sessionStatus(id); counts[status]++;
          sessionState.push([id, status, createHash('sha256').update(bytes).digest('hex')]);
        }
        const currentRetention = retention();
        if (currentRetention > 0 && await session.archiveCount() + counts.added > currentRetention) counts.retention = currentRetention;
        streams = { stage: sessionStage, state: sessionState, counts, retention: currentRetention };
      }
      const token = fingerprint(prepared.before, { archive: archiveHash, media: state, ...(streams ? { sessions: streams.state } : {}) });
      if (!applying) return { summary: prepared.summary, media, ...(streams ? { sessions: streams.counts } : {}), fingerprint: token };
      if (req.headers['x-config-fingerprint'] !== token) throw conflict();
      const dir = stage; stage = null;
      const apply = () => applyMedia(prepared, media, state, dir, streams);
      return await (streams ? session.withArchiveImport(apply) : apply());
    } finally {
      if (stage && applying) await rm(stage, { recursive: true, force: true });
    }
  });
  return { exportFile, exportZip, exportSkipped, importZip, fingerprint, hashFile, localHash };
}
