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
const QUEUE_ERROR = 'No se pudo guardar o leer la cola de envío.';

// Check the original spelling before URL normalization: 127.1, localhost, mapped
// addresses, credentials and even empty ?/# must not slip through.
function receiverUrl(value) {
  if (typeof value !== 'string') throw new Error(BAD_URL);
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):(\d{1,5})(\/[^?#\\\s]*)$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error(BAD_URL);
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error();
    return url;
  } catch { throw new Error(BAD_URL); }
}

export function createPushExport({ config = {}, timers = { setTimeout, clearTimeout }, now = Date.now, timeoutMs = 5000, onChange = () => {} } = {}) {
  const enabled = config.url !== undefined && config.url !== '';
  const url = enabled ? receiverUrl(config.url) : null;
  const token = config.token;
  if (enabled && (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token))) throw new Error(BAD_TOKEN);
  const receiver = url ? createHash('sha256').update(url.href).digest('hex') : null;
  const state = { enabled, lastSuccess: null, lastError: null, pending: 0 };
  const queue = [], seen = new Set();
  let file, owner = receiver, writes = Promise.resolve(), timer = null, current = null, running = false, closed = false, blocked = false;
  const notify = () => { try { onChange(); } catch { /* status is observational */ } };
  const setPending = () => { state.pending = queue.length; notify(); };
  const fail = message => { state.lastError = message; notify(); };
  // The shared JSON writer serializes snapshots atomically with all other writes to this file.
  function save() {
    const run = writeJson(file, { version: 1, receiver: owner, entries: queue.map(({ body, attempts, nextAt }) => ({ body, attempts, nextAt })) }, { after: writes });
    writes = run.catch(() => {});
    return run;
  }
  function schedule(delay) {
    timer = timers.setTimeout(() => { timer = null; void run(); }, delay);
    timer?.unref?.();
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
      if (saved?.version !== 1 || !/^[0-9a-f]{64}$/.test(saved.receiver) || !Array.isArray(saved.entries) || saved.entries.length > MAX_PENDING) throw new Error();
      for (const entry of saved.entries) {
        if (typeof entry.body !== 'string' || Buffer.byteLength(entry.body) > MAX_BYTES || !Number.isInteger(entry.attempts)
          || entry.attempts < 0 || entry.attempts > MAX_ATTEMPTS || !Number.isFinite(entry.nextAt) || entry.nextAt < 0) throw new Error();
        const doc = JSON.parse(entry.body);
        if (doc?.schema !== 'antena.session-metrics' || doc.version !== 1 || typeof doc.session?.id !== 'string') throw new Error();
        queue.push({ body: entry.body, attempts: entry.attempts, nextAt: entry.nextAt });
        seen.add(doc.session.id);
      }
      owner = saved.receiver;
    } catch {
      queue.length = 0; seen.clear(); blocked = true; fail(QUEUE_ERROR); return;
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
  async function run() {
    if (closed || blocked || !enabled || owner !== receiver || running || timer || !queue.length) return;
    const item = queue[0];
    const wait = item.nextAt - now();
    if (wait > 0) { schedule(wait); return; }
    running = true;
    // Persist each attempt before transmission, so a restart cannot reset the limit.
    if (item.attempts >= MAX_ATTEMPTS) {
      queue.shift();
      try { await save(); } catch { queue.unshift(item); fail(QUEUE_ERROR); running = false; return; }
      setPending(); running = false; void run(); return;
    }
    item.attempts++; item.nextAt = 0;
    try { await save(); } catch { item.attempts--; fail(QUEUE_ERROR); running = false; return; }
    if (closed) { running = false; return; }
    const result = await post(item.body);
    if (closed) { running = false; return; }
    if (!result.delivered) fail(result.error);
    if (!result.delivered && result.retry && item.attempts < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * 2 ** (item.attempts - 1);
      item.nextAt = now() + delay;
      try { await save(); } catch { fail(QUEUE_ERROR); running = false; return; }
      running = false;
      if (!closed) schedule(Math.max(0, item.nextAt - now()));
      return;
    }
    queue.shift();
    try { await save(); } catch { queue.unshift(item); fail(QUEUE_ERROR); running = false; return; }
    if (result.delivered) state.lastSuccess = new Date().toISOString();
    setPending(); running = false; void run();
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
    seen.add(data.id);
    if (Buffer.byteLength(body) > MAX_BYTES) { fail('La exportación supera 256 KiB.'); return; }
    if (queue.length >= MAX_PENDING) { fail('La cola de envío está llena.'); return; }
    owner = receiver;
    queue.push({ body, attempts: 0, nextAt: 0 });
    setPending();
    // No disk or network operation is awaited by the session transition.
    save().then(() => { if (!closed) void run(); }, () => fail(QUEUE_ERROR));
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
  return { load, enqueue, close, status: () => ({ ...state }) };
}
