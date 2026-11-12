// Persistent offline/live follower registry. Platform reads never dispatch alerts.
import { EventEmitter } from 'node:events';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';

export const FOLLOWERS_FILE = 'followers.json';
const PLATFORMS = ['twitch', 'youtube'];
const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });
const validTotal = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const lower = name => String(name || '').toLowerCase();
const validPlatform = data => data && typeof data === 'object' && !Array.isArray(data)
  && (data.lastSync === null || (typeof data.lastSync === 'string' && Number.isFinite(Date.parse(data.lastSync))))
  && (data.total === null || validTotal(data.total))
  && Array.isArray(data.knownIds) && data.knownIds.every(id => typeof id === 'string' && !!id)
  && Array.isArray(data.entries) && data.entries.every(e => e && (e.id === null || (typeof e.id === 'string' && !!e.id))
    && typeof e.name === 'string' && !!e.name && (e.followedAt === null || typeof e.followedAt === 'string')
    && ['offline', 'live'].includes(e.source) && typeof e.thanked === 'boolean')
  && Array.isArray(data.anonymous) && data.anonymous.every(a => a && (a.at === null || typeof a.at === 'string')
    && validTotal(a.count) && a.count > 0 && typeof a.thanked === 'boolean');

export class FollowerRegistry extends EventEmitter {
  constructor({ dir, twitch, youtube, log = () => {}, now = Date.now, readers, write = writeJson } = {}) {
    super();
    this.file = path.join(dir, FOLLOWERS_FILE);
    this.twitch = twitch; this.youtube = youtube;
    this.log = log; this.now = now; this.write = write;
    this.readers = readers || { twitch: lastSync => this.readTwitch(lastSync), youtube: lastSync => this.readYouTube(lastSync) };
    this.platforms = { twitch: blank(), youtube: blank() };
    this.states = Object.fromEntries(PLATFORMS.map(p => [p, { status: 'idle', error: null }]));
    this.readOnly = false; this.loadError = null; this.lastWriteError = null;
    this.writeGen = 0; this.dirty = false; this.writing = Promise.resolve();
    this.busy = {}; this.halted = false;
  }

  async load() {
    let text = null;
    try { text = await readFile(this.file, 'utf8'); } catch (err) {
      if (err?.code !== 'ENOENT') this.cannotRead(err);
      return this;
    }
    let raw;
    try { raw = JSON.parse(text); } catch { /* preserve corrupt data below */ }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || !raw.platforms
      || typeof raw.platforms !== 'object' || !PLATFORMS.every(p => validPlatform(raw.platforms[p]))) {
      const backup = `${this.file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
      try {
        await copyFile(this.file, backup);
        this.log(`[seguidores] ${FOLLOWERS_FILE} no es válido; copia guardada en ${path.basename(backup)}`);
      } catch (err) { this.cannotRead(err); }
      return this;
    }
    for (const p of PLATFORMS) {
      const data = raw.platforms[p];
      if (!data || typeof data !== 'object') continue;
      this.platforms[p] = {
        lastSync: typeof data.lastSync === 'string' && Number.isFinite(Date.parse(data.lastSync)) ? data.lastSync : null,
        total: validTotal(data.total) ? data.total : null,
        totalSource: data.totalSource === 'youtube-oauth' ? data.totalSource : null,
        knownIds: Array.isArray(data.knownIds) ? [...new Set(data.knownIds.filter(id => typeof id === 'string' && id))] : [],
        entries: Array.isArray(data.entries) ? data.entries.filter(e => e && typeof e.name === 'string' && e.name && ['offline', 'live'].includes(e.source)).map(e => ({
          id: typeof e.id === 'string' && e.id ? e.id : null, name: e.name, followedAt: e.followedAt || null,
          source: e.source, thanked: e.thanked === true,
        })) : [],
        anonymous: Array.isArray(data.anonymous) ? data.anonymous.filter(a => a && validTotal(a.count) && a.count > 0).map(a => ({ at: a.at || null, count: a.count, thanked: a.thanked === true })) : [],
      };
    }
    return this;
  }

  cannotRead(err) {
    this.readOnly = true;
    this.loadError = `No se puede leer ${FOLLOWERS_FILE} (${err?.code || err?.message}); los seguidores no se guardarán hasta corregirlo y reiniciar.`;
    this.log(`[seguidores] ${this.loadError}`);
  }

  async readTwitch(lastSync) {
    const t = this.twitch;
    if (!t?.userId || !t.token?.access) return null;
    let cursor, truncated = false; const items = [];
    for (let page = 0; page < 10; page++) {
      const query = `broadcaster_id=${encodeURIComponent(t.userId)}&first=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
      const response = await t.helix('GET', `/channels/followers?${query}`);
      if (!response.ok) throw new Error(`Twitch respondió ${response.status} al leer los seguidores`);
      if (!Array.isArray(response.data?.data)) throw new Error('Twitch no devolvió la lista de seguidores');
      let reached = false;
      for (const row of response.data.data) {
        const at = Date.parse(row?.followed_at);
        if (!Number.isFinite(at) || !row?.user_id || !row?.user_name) throw new Error('Twitch devolvió un seguidor no válido');
        if (lastSync && at <= Date.parse(lastSync)) { reached = true; break; }
        items.push({ id: String(row.user_id), name: row.user_name, followedAt: row.followed_at });
      }
      cursor = response.data.pagination?.cursor;
      if (reached || !cursor) break;
      if (page === 9) truncated = true;
    }
    return { items, truncated };
  }

  async readYouTube(lastSync = null) {
    const y = this.youtube;
    if (!y?.token?.access) return null;
    // The baseline reads deeper (20 pages) so existing subscribers are known before later,
    // shorter syncs (4 pages) look for new ones.
    const maxPages = lastSync ? 4 : 20;
    let cursor, truncated = false; const items = [];
    for (let page = 0; page < maxPages; page++) {
      const params = { part: 'snippet,subscriberSnippet', myRecentSubscribers: 'true', maxResults: 50 };
      if (cursor) params.pageToken = cursor;
      const response = await y.api('/subscriptions', params, { auth: true });
      for (const row of response.items || []) {
        const snippet = row?.subscriberSnippet, publishedAt = row?.snippet?.publishedAt ?? null;
        if (!snippet?.channelId || !snippet?.title || (publishedAt !== null
          && (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt)))))
          throw new Error('YouTube devolvió un suscriptor no válido');
        items.push({ id: String(snippet.channelId), name: snippet.title, followedAt: publishedAt });
      }
      cursor = response.nextPageToken;
      if (!cursor) break;
      if (page === maxPages - 1) truncated = true;
    }
    // The subscriber list belongs to the OAuth account, which may differ from the configured
    // channel used by ChannelTotals. Missing, hidden or invalid statistics cannot imply growth.
    let total = null;
    try {
      const response = await y.api('/channels', { part: 'statistics', mine: 'true' }, { auth: true });
      const stats = response?.items?.[0]?.statistics, raw = stats?.subscriberCount;
      if (!stats?.hiddenSubscriberCount && typeof raw === 'string' && /^\d+$/.test(raw)) {
        const value = Number(raw);
        if (Number.isSafeInteger(value)) total = value;
      }
    } catch { /* named subscribers can still be recorded without a usable total */ }
    return { items, truncated, total };
  }

  // Matches ids when both exist; otherwise use the case-insensitive name. An id learned later
  // enriches a live event without changing its source or thank flag.
  add(platform, entry) {
    const entries = this.platforms[platform].entries;
    const existing = (entry.id && entries.find(e => e.id === entry.id))
      || entries.find(e => (!e.id || !entry.id) && lower(e.name) === lower(entry.name));
    if (existing) {
      if (!existing.id && entry.id) { existing.id = entry.id; return true; }
      return false;
    }
    entries.push(entry);
    return true;
  }

  onLiveFollow({ platform, id, name, at } = {}) {
    if (!PLATFORMS.includes(platform) || typeof name !== 'string' || !name.trim()) return;
    const entry = { id: typeof id === 'string' && id ? id : null, name, followedAt: at || new Date(this.now()).toISOString(), source: 'live', thanked: false };
    if (this.add(platform, entry)) this.changed();
  }

  snapshot() {
    const error = this.loadError || (this.lastWriteError ? `No se pudieron guardar los seguidores (${this.lastWriteError.code || this.lastWriteError.message}); se reintentará.` : null);
    return Object.fromEntries(PLATFORMS.map(p => [p, {
      lastSync: this.platforms[p].lastSync, status: this.states[p].status, error: error || this.states[p].error,
      pending: this.platforms[p].entries.filter(e => !e.thanked).length + this.platforms[p].anonymous.filter(a => !a.thanked).reduce((sum, a) => sum + a.count, 0),
    }]));
  }

  list({ pending = false } = {}) {
    return {
      entries: PLATFORMS.flatMap(p => this.platforms[p].entries.filter(e => !pending || !e.thanked).map(e => ({ platform: p, ...e }))),
      anonymous: this.platforms.youtube.anonymous.filter(a => !pending || !a.thanked).map(a => ({ ...a })),
      platforms: this.snapshot(),
    };
  }

  markThanked(ids) {
    if (this.readOnly) throw Object.assign(new Error(this.loadError), { status: 503 });
    const all = ids === 'all';
    if (!all && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())))
      throw Object.assign(new Error('Indica una lista de identificadores o todos los seguidores.'), { status: 400 });
    let touched = false;
    for (const p of PLATFORMS) {
      for (const e of this.platforms[p].entries) if (!e.thanked && (all || (e.id && ids.includes(e.id)))) { e.thanked = true; touched = true; }
      if (all) for (const a of this.platforms[p].anonymous) if (!a.thanked) { a.thanked = true; touched = true; }
    }
    if (touched) this.changed();
    return this.list();
  }

  sync(platform) {
    if (!PLATFORMS.includes(platform)) return Promise.reject(new Error('Plataforma desconocida.'));
    if (this.halted) return Promise.resolve();
    const run = async () => {
      if (this.halted) return;
      const state = this.platforms[platform], startedAt = new Date(this.now()).toISOString();
      let result;
      try { result = await this.readers[platform](state.lastSync); } catch (err) {
        if (this.halted) return;
        this.states[platform] = { status: 'error', error: err?.message || String(err) };
        this.log(`[seguidores] ${platform}: ${this.states[platform].error}`);
        if (this.dirty && this.lastWriteError) this.changed(); else this.emit('change', this.snapshot());
        return;
      }
      if (this.halted) return;
      if (result == null) {
        this.states[platform] = { status: 'needs_account', error: null };
        if (this.dirty && this.lastWriteError) this.changed(); else this.emit('change', this.snapshot());
        return;
      }
      const baseline = !state.lastSync;
      if (platform === 'youtube') {
        const known = new Set(state.knownIds), seen = new Set(); let named = 0;
        for (const item of result.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const afterLastSync = item.followedAt == null || Date.parse(item.followedAt) > Date.parse(state.lastSync);
          if (!baseline && !known.has(item.id) && afterLastSync) {
            named++;
            this.add(platform, { ...item, followedAt: item.followedAt ?? null, source: 'offline', thanked: false });
          }
          known.add(item.id);
        }
        state.knownIds = [...known];
        const total = validTotal(result.total) ? result.total : null;
        // A file written before OAuth-account totals existed may contain another channel's
        // total. Establish a new baseline instead of comparing those unrelated counts.
        if (!baseline && state.totalSource === 'youtube-oauth' && total !== null && state.total !== null) {
          const count = Math.max(0, total - state.total - named);
          if (count > 0) state.anonymous.push({ at: startedAt, count, thanked: false });
        }
        state.total = total; state.totalSource = 'youtube-oauth';
      } else if (!baseline) {
        for (const item of result.items) this.add(platform, { ...item, source: 'offline', thanked: false });
      }
      // A capped Twitch result may not have reached the old checkpoint. Retain it so the
      // next reconnect cannot silently advance past unread followers.
      if (!(platform === 'twitch' && result.truncated && !baseline)) state.lastSync = startedAt;
      this.states[platform] = { status: result.truncated ? 'partial' : 'ok', error: null };
      this.changed();
    };
    const next = (this.busy[platform] || Promise.resolve()).then(run, run);
    const tracked = next.finally(() => { if (this.busy[platform] === tracked) delete this.busy[platform]; });
    this.busy[platform] = tracked;
    return next;
  }

  halt() { this.halted = true; }

  changed() {
    if (this.readOnly) { this.emit('change', this.snapshot()); return; }
    this.dirty = true;
    const data = structuredClone({ version: 1, platforms: this.platforms });
    const gen = ++this.writeGen;
    this.writing = this.writing.then(() => this.write(this.file, data)).then(
      () => { if (gen === this.writeGen) { this.dirty = false; this.lastWriteError = null; } },
      err => { this.lastWriteError = err; this.log(`[seguidores] no se pudo guardar: ${err.message}`); this.emit('change', this.snapshot()); }
    );
    this.emit('change', this.snapshot());
  }

  flush() {
    if (this.lastWriteError && this.dirty && !this.readOnly) this.changed();
    return this.writing.then(() => { if (this.lastWriteError) throw this.lastWriteError; });
  }
}
