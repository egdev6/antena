// Transferencia de un tema: comparte admisión, ZIP, huella y transacción con la copia completa.
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { validateLook, themeAvatarError } from '../config-schema.mjs';
import { httpError, freeName } from '../http-util.mjs';
import { checkZipName, writeZip, MAX_ZIP_ENTRIES, MAX_ZIP_TOTAL } from '../zip-archive.mjs';
import { themeMedia } from '../theme-media.mjs';
import { MAX_UPLOAD } from './media.mjs';
import { portable, transferAppVersion, withZipUpload } from './config-transfer.mjs';

export function registerThemeTransfer({ route, store, themes, transfer, mediaDir, zipUploadLimit, zipExportLimit }) {
  const conflict = () => httpError(409, 'La configuración ha cambiado; vuelve a previsualizar');
  const checkLook = look => { const [error] = validateLook(look); if (error) throw httpError(400, error.message); };
  const prepare = file => {
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.format !== 'antena-theme' || file.kind !== 'theme' || file.version !== 1 || typeof file.app !== 'string' ||
        Object.keys(file).some(k => !['format', 'kind', 'version', 'app', 'theme'].includes(k)) ||
        !file.theme || typeof file.theme !== 'object' || Array.isArray(file.theme) || Object.keys(file.theme).some(k => !['name', 'avatar', 'look'].includes(k)))
      throw httpError(400, 'Formato de tema no válido');
    portable(file, '', true);
    const name = themes.nameOf(file.theme.name), look = structuredClone(file.theme.look), avatar = structuredClone(file.theme.avatar);
    if (avatar !== undefined) { const error = themeAvatarError(avatar); if (error) throw httpError(400, error); }
    checkLook(look);
    const archiveRefs = themeMedia(look, avatar);
    const overlayIds = new Set((store.config.customOverlays || []).map(item => item.id)), warnings = [];
    for (const id of Object.keys(look.customOverlayCss)) if (!overlayIds.has(id)) {
      delete look.customOverlayCss[id]; warnings.push(`Se omitió el CSS del overlay «${id}» porque no existe en este equipo.`);
    }
    return { name, look, avatar, warnings, archiveRefs };
  };
  const exportZip = async (res, rawId) => {
    const item = themes.find(rawId), source = portable(themes.lookOf(item));
    checkLook(source);
    const avatar = item.avatar === undefined ? undefined : portable(item.avatar);
    if (avatar !== undefined) { const error = themeAvatarError(avatar); if (error) throw httpError(400, error); }
    const { names, required } = themeMedia(source, avatar);
    const file = { format: 'antena-theme', kind: 'theme', version: 1, app: transferAppVersion,
      theme: { name: item.name, ...(avatar !== undefined && { avatar }), look: source } };
    const json = JSON.stringify(file), entries = [{ name: 'config.json', source: json }];
    let total = Buffer.byteLength(json);
    const limit = Math.min(zipExportLimit ?? MAX_ZIP_TOTAL, MAX_ZIP_TOTAL);
    for (const name of [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      checkZipName(`media/${name}`, undefined, { allowCss: true });
      const filename = path.join(mediaDir, name);
      let stat;
      try { stat = await lstat(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!stat?.isFile()) {
        if (required.has(name)) throw httpError(400, `No existe un archivo normal de medios «${name}»`);
        continue; // Missing CSS-only references remain in the manifest and are reported on preview.
      }
      if (stat.size > MAX_UPLOAD) throw httpError(400, 'El archivo de medios supera 300 MB.');
      total += stat.size;
      if (total > limit) throw httpError(400, 'El ZIP supera el límite total de 2 GB.');
      entries.push({ name: `media/${name}`, source: { path: filename } });
    }
    if (entries.length > MAX_ZIP_ENTRIES) throw httpError(400, 'El ZIP contiene demasiadas entradas.');
    res.setHeader('Content-Disposition', `attachment; filename="antena-tema-${item.id}.zip"`);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/zip');
    await writeZip(res, entries, { allowCss: true });
  };
  const importZip = (req, applying, chosenName) => withZipUpload(req, zipUploadLimit, async (zip, archiveHash, scratch) => {
    let file;
    try { file = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await zip.readConfig())); }
    catch (error) { if (error.status) throw error; throw httpError(400, 'JSON no válido'); }
    const prepared = prepare(file);
    themes.ensureCapacity();
    const retained = themeMedia(prepared.look, prepared.avatar), refs = retained.names;
    const entries = zip.entries.filter(e => e.name !== 'config.json' && e.name !== 'media/');
    const present = new Set(entries.filter(e => e.name.startsWith('media/')).map(e => e.name.slice(6)));
    if (entries.some(e => !e.name.startsWith('media/') || !prepared.archiveRefs.names.has(e.name.slice(6))) || [...prepared.archiveRefs.required].some(name => !present.has(name)))
      throw httpError(400, 'Los medios del ZIP no coinciden con las referencias del tema');
    const warnings = [...prepared.warnings, ...retained.warnings,
      ...[...retained.cssNames].filter(name => !present.has(name)).map(name => `No se incluyó el medio CSS «${name}» en el ZIP.`)];
    const stage = path.join(scratch, 'stage'); await mkdir(stage, { mode: 0o700 });
    const state = [], plan = [], reserved = new Set(), conflicts = []; let size = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name.slice(6), extracted = await zip.extract(entry.name, stage);
      if (!refs.has(name)) continue; // CRC/size were verified even for dropped overlay CSS.
      const [incoming, current] = await Promise.all([transfer.hashFile(extracted), transfer.localHash(name)]);
      let target = name;
      if (current !== null && current !== incoming) conflicts.push(name);
      if (current !== incoming || current === null) {
        target = path.basename(await freeName(mediaDir, name));
        let n = 1;
        while (reserved.has(target)) {
          const ext = path.extname(name), stem = name.slice(0, -ext.length || undefined);
          target = path.basename(await freeName(mediaDir, `${stem}-${n++}${ext}`));
        }
      }
      reserved.add(target); size += entry.size;
      state.push([name, current, target]); plan.push({ name, target, extracted, reuse: current !== null && current === incoming });
    }
    const before = structuredClone(store.config);
    const fingerprint = transfer.fingerprint(before, { archive: archiveHash, media: state, warnings });
    const suggestedName = themes.suggestName(prepared.name);
    const report = { name: prepared.name, suggestedName, media: { count: plan.length, size, conflicts }, warnings, fingerprint };
    if (!applying) return report;
    if (req.headers['x-config-fingerprint'] !== fingerprint) throw conflict();
    const name = chosenName === null ? suggestedName : themes.nameOf(chosenName);
    const replacements = new Map(plan.map(item => [item.name, item.target]));
    const { look, avatar } = themeMedia(prepared.look, prepared.avatar, replacements); checkLook(look);
    const installed = []; let committed = false;
    try {
      for (const item of plan) if (!item.reuse) {
        const file = await open(path.join(mediaDir, item.target), 'wx', 0o644);
        installed.push(item.target);
        try { await pipeline(createReadStream(item.extracted), file.createWriteStream()); }
        finally { await file.close().catch(() => {}); }
      }
      const result = await themes.add(name, look, avatar, { transactional: true, expected: before, onCommit: () => { committed = true; } });
      return { ...result, warnings };
    } catch (error) {
      if (committed) {
        const item = store.config.themes.saved.find(t => t.name === name);
        if (item) return { theme: { id: item.id, name: item.name, active: false, ...(item.avatar && { avatar: item.avatar }) }, warnings };
      }
      for (const name of installed.reverse()) await unlink(path.join(mediaDir, name));
      throw error;
    }
  }, { allowCss: true });
  // Dispatcher handles streaming ZIPs before normal JSON body parsing.
  route('POST', '/api/themes/import/preview', async () => { throw httpError(400, 'Se esperaba un archivo ZIP'); });
  route('POST', '/api/themes/import', async () => { throw httpError(400, 'Se esperaba un archivo ZIP'); });
  return { exportZip, importZip };
}
