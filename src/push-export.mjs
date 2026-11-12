// Optional local delivery of the existing v1 export; receiver data is never logged.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';
import { metricsDocument } from './routes/metrics.mjs';

const MAX_BYTES = 256 * 1024;
const MAX_PENDING = 100;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const BAD_URL = 'La URL del receptor no es válida.';
const BAD_TOKEN = 'El token del receptor no es válido.';
const BAD_DOCUMENT = 'El documento de envío no es válido.';
const QUEUE_ERROR = 'No se pudo guardar o leer la cola de envío.';
const safeId = id => typeof id === 'string' && /^[\w-]+$/.test(id);

// Check the original spelling before URL normalization: 127.1, localhost, mapped
// addresses, credentials and even empty ?/# must not slip through.
function receiverUrl(value) {
  if (typeof value !== 'string') throw new Error(BAD_URL);
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})(\/[^?#\\\s]*)?$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error(BAD_URL);
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new Error(BAD_URL); }
}

// A persisted body is untrusted input. Validate the exact shape emitted by the v1
// detail builder, including nested objects, immediately before every transmission.
const fields = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const iso = value => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};
const metricNames = ['viewers_average', 'viewers_peak', 'chat_unique_chatters', 'chat_messages', 'chat_messages_per_minute'];
const metricSources = [
  ['twitch.helix.streams', 'twitch.irc'],
  ['youtube.videos.liveStreamingDetails', 'youtube.liveChat.messages'],
];
function validDocument(doc) {
  if (!fields(doc, ['schema', 'version', 'generatedAt', 'session', 'metrics'])
    || doc.schema !== 'antena.session-metrics' || doc.version !== 1 || !iso(doc.generatedAt)) return false;
  const session = doc.session;
  if (!fields(session, ['id', 'startedAt', 'endedAt', 'platforms']) || !safeId(session.id)
    || !iso(session.startedAt) || !iso(session.endedAt) || session.endedAt < session.startedAt
    || !Array.isArray(session.platforms) || session.platforms.length !== 2
    || !Array.isArray(doc.metrics) || doc.metrics.length !== 10) return false;
  const platforms = ['twitch', 'youtube'];
  for (let i = 0; i < platforms.length; i++) {
    const platform = session.platforms[i];
    if (!fields(platform, ['platform', 'externalId', 'live']) || platform.platform !== platforms[i]
      || !(platform.externalId === null || (typeof platform.externalId === 'string' && platform.externalId.length > 0))
      || platform.live !== (platform.externalId !== null)) return false;
    for (let j = 0; j < metricNames.length; j++) {
      const row = doc.metrics[i * metricNames.length + j], coverage = row?.coverage;
      if (!fields(row, ['sessionId', 'platform', 'metric', 'value', 'unit', 'capturedAt', 'final', 'coverage', 'source'])
        || row.sessionId !== session.id || row.platform !== platforms[i] || row.metric !== metricNames[j]
        || !(row.value === null || (Number.isFinite(row.value) && row.value >= 0))
        || row.unit !== (j === 4 ? 'per_minute' : 'count') || row.capturedAt !== session.endedAt || row.final !== true
        || row.source !== metricSources[i][j < 2 ? 0 : 1]
        || !fields(coverage, ['basis', 'liveSeconds', 'coveredSeconds', 'ratio'])
        || coverage.basis !== (j < 2 ? 'viewer_samples' : 'platform_presence')
        || !Number.isSafeInteger(coverage.liveSeconds) || coverage.liveSeconds < 0
        || !(j < 2 ? Number.isSafeInteger(coverage.coveredSeconds) && coverage.coveredSeconds >= 0
          && coverage.coveredSeconds <= coverage.liveSeconds : coverage.coveredSeconds === null)
        || !Number.isFinite(coverage.ratio) || coverage.ratio < 0 || coverage.ratio > 1) return false;
    }
  }
  return true;
}
function parseDocument(body) {
  try { return JSON.parse(body); } catch { return null; }
}

export function createPushExport({ config = {}, timers = { setTimeout, clearTimeout }, now = Date.now, timeoutMs = 5000,
  onChange = () => {}, onSpace = () => {}, onCheckpoint = () => {} } = {}) {
  const enabled = config.url !== undefined && config.url !== '';
  const url = enabled ? receiverUrl(config.url) : null;
  const token = config.token;
  if (enabled && (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token))) throw new Error(BAD_TOKEN);
  const receiver = url ? createHash('sha256').update(url.href).digest('hex') : null;
  const state = { enabled, lastSuccess: null, lastError: null, pending: 0 };
  const queue = [], seen = new Set(), delivered = new Set(), failed = new Set();
  let durable = new Set();
  const successes = [], spaceRevisions = [];
  let file, owner = receiver, writes = Promise.resolve(), revision = 0, persisted = 0;
  let timer = null, current = null, running = false, closed = false, blocked = false;
  const notify = () => { try { onChange(); } catch { /* status is observational */ } };
  const setPending = () => { state.pending = queue.length; notify(); };
  const fail = message => { state.lastError = message; notify(); };
  const dirty = () => ++revision;
  // Queue, terminal IDs and receiver ownership are one atomic snapshot. A failed
  // write never rolls an observed terminal response back into the sendable queue.
  function save() {
    const savedRevision = revision;
    const snapshot = { version: 1, receiver: owner,
      entries: queue.map(({ body, attempts, nextAt }) => ({ body, attempts, nextAt })),
      delivered: [...delivered], failed: [...failed] };
    const savedIds = new Set([...snapshot.delivered, ...snapshot.failed, ...queue.map(entry => entry.id)]);
    const run = writeJson(file, snapshot, { after: writes }).then(() => {
      persisted = Math.max(persisted, savedRevision);
      const gained = [...savedIds].some(id => !durable.has(id));
      durable = savedIds;
      if (gained) { try { onCheckpoint(); } catch { /* retention is independent of delivery */ } }
      let changed = false;
      while (successes.length && successes[0].revision <= persisted) {
        state.lastSuccess = successes.shift().at; changed = true;
      }
      if (persisted === revision) setPending();
      else if (changed) notify();
      let freed = false;
      while (spaceRevisions.length && spaceRevisions[0] <= persisted) { spaceRevisions.shift(); freed = true; }
      if (freed) { try { onSpace(); } catch { /* reconciliation is independent of delivery */ } }
    });
    writes = run.catch(() => {});
    return run;
  }
  function schedule(delay) {
    if (closed || timer) return;
    timer = timers.setTimeout(() => { timer = null; void run(); }, delay);
    timer?.unref?.();
  }
  function saveQueued() {
    save().then(() => { if (!closed) void run(); }, () => { fail(QUEUE_ERROR); schedule(BASE_DELAY_MS); });
  }
  async function load(dir) {
    file = path.join(dir, 'push-export.json');
    let saved;
    try { saved = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error?.code !== 'ENOENT') { blocked = true; fail(QUEUE_ERROR); }
      return;
    }
    try {
      if (saved?.version !== 1 || !/^[0-9a-f]{64}$/.test(saved.receiver) || !Array.isArray(saved.entries)
        || saved.entries.length > MAX_PENDING) throw new Error();
      for (const [name, target] of [['delivered', delivered], ['failed', failed]]) {
        const ids = saved[name] ?? [];
        if (!Array.isArray(ids) || ids.some(id => !safeId(id)) || new Set(ids).size !== ids.length) throw new Error();
        for (const id of ids) { target.add(id); seen.add(id); durable.add(id); }
      }
      owner = saved.receiver;
      for (const entry of saved.entries) {
        if (typeof entry?.body !== 'string' || !Number.isInteger(entry.attempts)
          || entry.attempts < 0 || entry.attempts > MAX_ATTEMPTS || !Number.isFinite(entry.nextAt) || entry.nextAt < 0) throw new Error();
        const doc = parseDocument(entry.body), id = doc?.session?.id;
        if (Buffer.byteLength(entry.body) > MAX_BYTES || !validDocument(doc)) {
          if (safeId(id)) { failed.add(id); seen.add(id); }
          dirty(); fail(BAD_DOCUMENT); continue;
        }
        if (seen.has(id)) { dirty(); continue; }
        queue.push({ id, body: entry.body, attempts: entry.attempts, nextAt: entry.nextAt });
        seen.add(id); durable.add(id);
      }
    } catch {
      queue.length = 0; seen.clear(); delivered.clear(); failed.clear(); durable.clear(); blocked = true; fail(QUEUE_ERROR); return;
    }
    setPending();
    if (queue.length && enabled && owner !== receiver) fail('La cola pertenece a otro receptor.');
    else if (enabled) void run();
  }
  function post(body) {
    return new Promise(resolve => {
      let done = false, watchdog;
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        current = null;
        resolve(result);
      };
      try {
        const req = current = http.request(url, { method: 'POST', headers: {
          'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body),
        } }, res => {
          const status = res.statusCode || 0;
          if (status !== 200) {
            res.resume();
            return finish({ error: `HTTP ${status}`, retry: status === 408 || status === 429 || (status >= 500 && status <= 599) });
          }
          let text = '', size = 0;
          res.on('data', chunk => {
            size += chunk.length;
            if (size > 4096) { req.destroy(); finish({ error: 'Respuesta del receptor no válida.', retry: false }); }
            else text += chunk;
          });
          res.on('end', () => {
            try {
              const reply = JSON.parse(text);
              if (reply?.result === 'stored' || reply?.result === 'unchanged') return finish({ delivered: true });
            } catch { /* no echo of untrusted receiver data */ }
            finish({ error: 'Respuesta del receptor no válida.', retry: false });
          });
          res.on('error', () => finish({ error: 'No se pudo contactar con el receptor.', retry: true }));
        });
        req.on('error', () => finish({ error: 'No se pudo contactar con el receptor.', retry: true }));
        watchdog = setTimeout(() => {
          req.destroy();
          finish({ error: 'No se pudo contactar con el receptor.', retry: true });
        }, timeoutMs);
        watchdog.unref?.();
        req.end(body);
      } catch {
        finish({ error: 'No se pudo contactar con el receptor.', retry: true });
      }
    });
  }
  function terminal(item, result) {
    queue.shift();
    const id = parseDocument(item.body)?.session?.id;
    if (safeId(id)) (result.delivered ? delivered : failed).add(id);
    const rev = dirty();
    spaceRevisions.push(rev);
    if (result.delivered) successes.push({ revision: rev, at: new Date().toISOString() });
    else fail(result.error);
  }
  async function run() {
    if (closed || blocked || !enabled || running || timer) return;
    if (queue.length && owner !== receiver) return;
    running = true;
    let delay = null;
    try {
      // A newer enqueue can follow a failed terminal write. Persist the latest
      // snapshot before transmitting anything else, including after recovery.
      await writes;
      if (persisted < revision) await save();
      if (closed || !queue.length) return;
      const item = queue[0], doc = parseDocument(item.body);
      if (!validDocument(doc)) {
        terminal(item, { error: BAD_DOCUMENT });
        await save();
        return;
      }
      const wait = item.nextAt - now();
      if (wait > 0) { delay = wait; return; }
      if (item.attempts >= MAX_ATTEMPTS) {
        terminal(item, { error: 'Se agotaron los intentos de envío.' });
        await save();
        return;
      }
      const previousNextAt = item.nextAt;
      item.attempts++; item.nextAt = 0; dirty();
      try { await save(); } // every attempt is durable before transmission
      catch (error) {
        // No POST was made: a storage failure must not spend a network attempt.
        item.attempts--; item.nextAt = previousNextAt; dirty();
        throw error;
      }
      if (closed) return;
      const result = await post(item.body);
      if (closed) return;
      if (!result.delivered && result.retry && item.attempts < MAX_ATTEMPTS) {
        fail(result.error);
        const backoff = BASE_DELAY_MS * 2 ** (item.attempts - 1);
        item.nextAt = now() + backoff; dirty();
        await save();
        delay = Math.max(0, item.nextAt - now());
        return;
      }
      terminal(item, result);
      await save();
    } catch {
      fail(QUEUE_ERROR);
      delay = BASE_DELAY_MS;
    } finally {
      running = false;
      if (!closed) {
        if (delay !== null) schedule(delay);
        else if (queue.length || persisted < revision) void run();
      }
    }
  }
  function enqueue(data) {
    if (!enabled || closed || blocked || !data?.meldAutoSession || !data.endedAt || seen.has(data.id)) return;
    if (queue.length && owner !== receiver) { fail('La cola pertenece a otro receptor.'); return; }
    let body;
    try {
      const document = metricsDocument(data.id, data);
      if (!document) return;
      body = JSON.stringify(document);
    } catch { fail('No se pudo preparar la exportación.'); return; }
    if (queue.length >= MAX_PENDING) { fail('La cola de envío está llena.'); return; }
    owner = receiver;
    seen.add(data.id);
    if (Buffer.byteLength(body) > MAX_BYTES) {
      failed.add(data.id); dirty(); fail('La exportación supera 256 KiB.'); saveQueued(); return;
    }
    queue.push({ id: data.id, body, attempts: 0, nextAt: 0 }); dirty();
    setPending();
    // No disk or network operation is awaited by the session transition.
    saveQueued();
  }
  async function close() {
    if (!closed) {
      closed = true;
      if (timer) timers.clearTimeout(timer);
      timer = null;
      current?.destroy();
    }
    await writes;
  }
  return { load, enqueue, close, status: () => ({ ...state }),
    has: id => seen.has(id), isDurable: id => durable.has(id), hasCapacity: () => queue.length < MAX_PENDING,
    reconciliationError: () => fail(QUEUE_ERROR) };
}
