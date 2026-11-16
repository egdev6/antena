// Transferencia portable v1: rutas de medios, no archivos. Las copias locales sí contienen
// credenciales del config.json y deben tratarse como privadas; conservamos las últimas diez.
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT, DEFAULT_CONFIG, deepMerge } from '../store.mjs';
import { PROTO_KEYS, validatePatch, validateImportedChatVariants } from '../config-schema.mjs';
import { httpError } from '../http-util.mjs';

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
export function registerConfigTransferRoutes({ route, store, customOverlays, afterConfig }) {
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
  route('POST', '/api/config/import/preview', async file => {
    const { before, summary } = prepare(file);
    return { summary, fingerprint: fingerprint(before, file) };
  });
  route('POST', '/api/config/import', async (file, _, _url, req) => {
    const { before, next, summary } = prepare(file);
    if (req.headers['x-config-fingerprint'] !== fingerprint(before, file)) throw httpError(409, 'La configuración ha cambiado; vuelve a previsualizar');
    const changed = Object.fromEntries(Object.keys(summary).map(key => [key, true]));
    // PUT treats recordOnStart alone as non-reconnecting.
    if (changed.meld && summary.meld.changed.paths.every(p => p === 'meld.recordOnStart') && !summary.meld.added.count && !summary.meld.removed.count) changed.meld = false;
    const backup = await store.replaceConfigWithBackup(next, before, { ...changed, all: true });
    if (changed.customOverlays) customOverlays.notify(next.customOverlays);
    afterConfig(changed);
    return { summary, backup };
  });
  return { exportFile };
}
