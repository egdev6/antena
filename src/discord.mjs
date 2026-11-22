// Discord webhook delivery: a durable pre-send fence prevents automatic duplicate creates.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';
import { httpError } from './http-util.mjs';

const MAX_ATTEMPTS = 5;
const VALID_URL = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const SAFE_ID = /^[\w-]+$/;
const MESSAGE_ID = /^\d+$/;
export const validDiscordWebhook = value => typeof value === 'string' && VALID_URL.test(value);
const fingerprint = url => createHash('sha256').update(url).digest('hex');
const excerpt = value => typeof value === 'string' ? value.trim().split(/\r?\n/).slice(0, 3).join('\n').slice(0, 300).trim() : '';
const delayResult = (work, ms = 2000) => {
  let timer;
  return Promise.race([
    Promise.resolve().then(work).catch(() => null),
    new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
};

// «2 h 10 min» or «45 min»; never negative.
function duration(from, to) {
  const minutes = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 60000)) : 0;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

export function createDiscord({ store, dir, twitch, youtube, fetch: send = globalThis.fetch, retryDelayMs = 1000, timeoutMs = 5000, onChange = () => {} }) {
  const file = path.join(dir, 'discord-announcements.json');
  const entries = new Map(), metadata = new Map(), timers = new Map(), controllers = new Set();
  let chain = Promise.resolve(), closed = false, blocked = false;
  const notify = () => { try { onChange(); } catch {} };
  const save = () => writeJson(file, { version: 1, entries: [...entries.values()] });
  const queue = fn => {
    const work = chain.then(() => closed ? undefined : fn());
    chain = work.catch(() => { blocked = true; notify(); });
    return work;
  };
  const status = current => {
    const entry = entries.get(current) || [...entries.values()].at(-1);
    return { state: blocked ? 'error' : entry?.state || 'sin avisos', sessionId: entry?.sessionId || null };
  };
  const enabled = () => store.config.discord?.enabled === true && validDiscordWebhook(store.secrets.discord?.webhookUrl);
  const webhook = () => store.secrets.discord?.webhookUrl;
  async function load() {
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') blocked = true; return; }
    try {
      if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error();
      for (const entry of data.entries) {
        if (!entry || !SAFE_ID.test(entry.sessionId) || entries.has(entry.sessionId)
          || !/^[a-f0-9]{64}$/.test(entry.owner) || typeof entry.state !== 'string'
          || (entry.messageId != null && !MESSAGE_ID.test(entry.messageId)) || !entry.desired || typeof entry.desired !== 'object'
          || (['enviando', 'sin confirmar'].includes(entry.state) && entry.messageId)) throw new Error();
        if (entry.state === 'enviando') entry.state = 'sin confirmar';
        entries.set(entry.sessionId, entry);
      }
      await save();
      for (const entry of entries.values()) {
        if (entry.state === 'actualizando') entry.state = 'esperando';
        if (['esperando', 'preparando'].includes(entry.state)) schedule(entry, Math.max(0, (entry.nextAt || 0) - Date.now()));
      }
    } catch { entries.clear(); blocked = true; }
  }
  function schedule(entry, wait) {
    if (closed || timers.has(entry.sessionId)) return;
    const timer = setTimeout(() => {
      timers.delete(entry.sessionId);
      void queue(() => deliver(entry));
    }, Math.min(2_147_483_647, Math.max(0, wait)));
    timer.unref?.(); timers.set(entry.sessionId, timer);
  }
  async function request(url, method, body) {
    const active = new AbortController(); controllers.add(active);
    const timer = setTimeout(() => active.abort(), timeoutMs); timer.unref?.();
    try {
      const response = await send(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual', signal: active.signal });
      const data = await response.json().catch(() => ({}));
      return { status: response.status, ok: response.ok, data, retryAfter: response.headers.get('retry-after') };
    } catch { return { status: 0, ok: false, data: {} }; }
    finally { clearTimeout(timer); controllers.delete(active); }
  }
  async function deliver(entry) {
    if (closed || blocked || !enabled() || entry.owner !== fingerprint(webhook())) return;
    const destination = webhook();
    if (['sin confirmar', 'mensaje no encontrado', 'error'].includes(entry.state)) return;
    if (entry.nextAt && entry.nextAt > Date.now()) { schedule(entry, entry.nextAt - Date.now()); return; }
    const editing = !!entry.messageId;
    const body = entry.desired;
    if (editing && entry.sent === JSON.stringify(body)) { entry.state = 'publicado'; return; }
    if ((entry.attempts || 0) >= MAX_ATTEMPTS) {
      entry.state = 'error'; await save(); notify(); return;
    }
    entry.attempts = (entry.attempts || 0) + 1;
    entry.nextAt = 0;
    // On restart, a persisted in-flight create has an unknown outcome, never another POST.
    entry.state = editing ? 'actualizando' : 'enviando';
    await save(); notify();
    const url = editing ? `${destination}/messages/${entry.messageId}` : `${destination}?wait=true`;
    const response = await request(url, editing ? 'PATCH' : 'POST', body);
    if (closed) return;
    if (response.ok && (editing || (typeof response.data?.id === 'string' && MESSAGE_ID.test(response.data.id)))) {
      if (!editing) entry.messageId = response.data.id;
      entry.sent = JSON.stringify(body); entry.state = 'publicado'; entry.attempts = 0;
      await save(); notify(); return;
    }
    if (editing && response.status === 404) {
      entry.state = 'mensaje no encontrado'; await save(); notify(); return;
    }
    // A create with an unknown result (including 5xx) may already exist remotely.
    const definiteRejection = response.status >= 400 && response.status < 500 && response.status !== 408;
    if (!editing && !definiteRejection) {
      entry.state = 'sin confirmar'; await save(); notify(); return;
    }
    if (entry.attempts >= MAX_ATTEMPTS) {
      entry.state = 'error'; await save(); notify(); return;
    }
    const bodyWait = response.status === 429 ? Number(response.data?.retry_after) * 1000 : 0;
    const headerWait = response.status === 429 ? Number(response.retryAfter) * 1000 : 0;
    const validWait = value => Number.isFinite(value) && value > 0 ? value : 0;
    const backoff = retryDelayMs * 2 ** (entry.attempts - 1);
    entry.nextAt = Date.now() + Math.max(backoff, validWait(bodyWait), validWait(headerWait));
    entry.state = 'esperando'; await save(); notify(); schedule(entry, entry.nextAt - Date.now());
  }
  async function details(data, entry) {
    const yt = data.platforms?.youtube;
    if (yt?.videoId && /^[\w-]{11}$/.test(yt.videoId)) {
      if (!metadata.has(yt.videoId)) metadata.set(yt.videoId, delayResult(() => youtube.api('/videos', { part: 'snippet', id: yt.videoId })));
      const item = (await metadata.get(yt.videoId))?.items?.[0];
      if (item?.snippet?.description) entry.description = excerpt(item.snippet.description);
      if (yt.title || item?.snippet?.title) entry.streamTitle = yt.title || item.snippet.title;
      entry.videoId = yt.videoId;
    }
    if (data.platforms?.twitch?.streamId) {
      const login = twitch.status.user;
      if (typeof login === 'string' && /^[A-Za-z0-9_]{1,25}$/.test(login)) entry.login = login;
      if (!entry.streamTitle && !entry.twitchLookedUp) {
        entry.twitchLookedUp = true;
        const row = await delayResult(() => twitch.helix('GET', `/streams?user_id=${encodeURIComponent(twitch.userId || '')}`));
        if (row?.ok && row.data?.data?.[0]?.title) entry.streamTitle = row.data.data[0].title;
      }
    }
    const links = [];
    const twitchUrl = entry.login && !entry.inactive?.twitch ? `https://twitch.tv/${entry.login}` : null;
    const youtubeUrl = entry.videoId && !entry.inactive?.youtube ? `https://youtu.be/${entry.videoId}` : null;
    if (twitchUrl) links.push(`[Twitch](${twitchUrl})`);
    if (youtubeUrl) links.push(`[YouTube](${youtubeUrl})`);
    const ended = !!data.endedAt;
    const started = Date.parse(data.startedAt);
    const embed = { title: String(entry.streamTitle || data.title || 'Directo').slice(0, 256),
      // Red while live, Discord grey once it ended; the title opens the stream (YouTube first).
      color: ended ? 0x80848E : 0xFF0036,
      ...(youtubeUrl || twitchUrl ? { url: youtubeUrl || twitchUrl } : {}),
      ...(entry.login ? { author: { name: `${entry.login} ${ended ? 'estuvo' : 'está'} en directo` } } : {}),
      fields: [{ name: 'Estado', value: ended ? `Terminado · duró ${duration(started, Date.parse(data.endedAt))}` : 'En directo' }, ...(links.length ? [{ name: 'Plataformas', value: links.join('\n') }] : [])],
      ...(entry.description && !entry.inactive?.youtube ? { description: entry.description } : {}),
      ...(entry.videoId && !entry.inactive?.youtube ? { image: { url: `https://i.ytimg.com/vi/${entry.videoId}/hqdefault.jpg` } } : {}),
      ...(Number.isFinite(started) ? { timestamp: new Date(started).toISOString() } : {}) };
    return { embeds: [embed], allowed_mentions: { parse: [] } };
  }
  function observe(data, { start = false, presence } = {}) {
    if (closed || blocked || !enabled() || !SAFE_ID.test(data?.id || '')) return;
    const snapshot = structuredClone({ id: data.id, title: data.title, startedAt: data.startedAt, endedAt: data.endedAt, platforms: data.platforms });
    void queue(async () => {
      if (!enabled()) return;
      let entry = entries.get(snapshot.id);
      if (!start && !entry && (!snapshot.platforms || !Object.keys(snapshot.platforms).length)) return;
      if (!entry) {
        if (snapshot.endedAt || presence?.live === false) return;
        entry = { sessionId: snapshot.id, owner: fingerprint(webhook()), state: 'preparando', messageId: null, attempts: 0 };
        entries.set(snapshot.id, entry);
      }
      if (entry.owner !== fingerprint(webhook())) return;
      if (presence && ['twitch', 'youtube'].includes(presence.platform)) {
        entry.inactive ||= {};
        entry.inactive[presence.platform] = !presence.live;
      }
      entry.desired = await details(snapshot, entry);
      await save(); notify();
      if (timers.has(entry.sessionId)) return;
      await deliver(entry);
    });
  }
  async function republish(sessionId, confirm) {
    if (confirm !== true) throw httpError(400, 'Confirma antes de volver a publicar.');
    const entry = entries.get(sessionId);
    if (!entry || entry.state !== 'sin confirmar' || !enabled())
      throw httpError(409, 'No hay un aviso sin confirmar para este webhook.');
    const destination = fingerprint(webhook());
    return queue(async () => {
      if (entry.state !== 'sin confirmar' || !enabled() || fingerprint(webhook()) !== destination) return { ok: false };
      entry.owner = destination;
      entry.state = 'preparando'; entry.attempts = 0; entry.nextAt = 0;
      await save(); notify(); await deliver(entry);
      return { ok: true };
    });
  }
  async function test() {
    if (!validDiscordWebhook(webhook())) throw httpError(400, 'Guarda primero un webhook de Discord.');
    const result = await request(`${webhook()}?wait=true`, 'POST', { embeds: [{ title: 'Prueba de antena', description: 'Este es un aviso de prueba.' }], allowed_mentions: { parse: [] } });
    if (!result.ok) throw httpError(400, 'No se pudo enviar la prueba a Discord.');
    return { ok: true };
  }
  async function close() {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear(); for (const active of controllers) active.abort();
    await chain;
  }
  return { load, observe, republish, test, status, close };
}
