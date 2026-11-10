// Exportación de solo lectura de sesiones automáticas finalizadas.
import { isValidRoot } from '../session.mjs';
import { exportSession } from '../metrics-export.mjs';
import { httpError } from '../http-util.mjs';

const SCHEMA = 'antena.session-metrics', VERSION = 1;
const safeId = id => typeof id === 'string' && /^[\w-]+$/.test(id);
const date = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const validPlatforms = platforms => platforms == null || (typeof platforms === 'object' && !Array.isArray(platforms)
  && ['twitch', 'youtube'].every(p => platforms[p] == null || (typeof platforms[p] === 'object'
    && !Array.isArray(platforms[p]) && [p === 'twitch' ? 'streamId' : 'videoId'].every(k => platforms[p][k] == null
      || typeof platforms[p][k] === 'string'))));

export function registerMetricsRoutes({ route, session }) {
  const load = async id => {
    if (!safeId(id)) throw httpError(404, 'No existe ese directo');
    const data = await session.get(id).catch(error => {
      if (error.status === 404) throw httpError(404, 'No existe ese directo');
      throw error;
    });
    if (!isValidRoot(data) || data.id !== id || !date(data.startedAt) || !validPlatforms(data.platforms))
      throw httpError(500, 'El directo archivado contiene datos no válidos.');
    if (data.meldAutoSession !== true || !date(data.endedAt)) return null;
    if (Date.parse(data.endedAt) < Date.parse(data.startedAt)
      || Object.values(data.viewers || {}).some(series => Array.isArray(series?.samples)
        && series.samples.some(sample => !Number.isSafeInteger(sample?.value) || sample.value < 0)))
      throw httpError(500, 'El directo archivado contiene datos no válidos.');
    return data;
  };
  route('GET', '/api/metrics/v1/sessions', async (_, __, url) => {
    const limits = url.searchParams.getAll('limit'), cursors = url.searchParams.getAll('before');
    const rawLimit = limits.length ? limits[0] : null;
    if (limits.length > 1 || (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50)))
      throw httpError(400, 'El límite debe ser un entero entre 1 y 50.');
    if (cursors.length > 1) throw httpError(400, 'El cursor no corresponde a un directo exportable.');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    const ids = (await session.list()).map(m => m.id);
    if (session.data.meldAutoSession === true && date(session.data.endedAt)) ids.push(session.data.id);
    const items = [];
    for (const id of new Set(ids)) {
      const data = await load(id);
      if (data) items.push(data);
    }
    items.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id));
    const before = cursors.length ? cursors[0] : null;
    let offset = 0;
    if (before !== null) {
      const index = items.findIndex(item => item.id === before);
      if (index < 0) throw httpError(400, 'El cursor no corresponde a un directo exportable.');
      offset = index + 1;
    }
    const selected = items.slice(offset, offset + limit);
    return { schema: SCHEMA, version: VERSION, generatedAt: new Date().toISOString(),
      sessions: selected.map(data => exportSession(data)), next: offset + limit < items.length ? selected.at(-1).id : null };
  });
  route('GET', '/api/metrics/v1/sessions/:id', async ({ id }) => {
    let decoded;
    try { decoded = decodeURIComponent(id); } catch { throw httpError(404, 'No existe ese directo'); }
    const data = await load(decoded);
    if (!data) throw httpError(404, 'No existe ese directo');
    return { schema: SCHEMA, version: VERSION, generatedAt: new Date().toISOString(), ...exportSession(data) };
  });
}
