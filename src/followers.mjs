// Persistent offline/live follower registry; YouTube reads can emit live discoveries.
import { EventEmitter } from 'node:events';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';
import { youtubeAvatarUrl } from './alerts.mjs';

export const FOLLOWERS_FILE = 'followers.json';
const PLATFORMS = ['twitch', 'youtube'];
const MAX_TIMER_MS = 2_147_483_647;
const blank = () => ({ lastSync: null, total: null, totalSource: null, knownIds: [], entries: [], anonymous: [] });
const validTotal = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const lower = name => String(name || '').toLowerCase();
// The same identity rule drives both selective writes and shown-selection checks.
export const matchesFollowerSelection = (platform, entry, selected) => selected.platform === platform
  && (Object.hasOwn(selected, 'id') ? entry.id === selected.id : entry.id === null && entry.name === selected.name);
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
    this.busy = {}; this.halted = false; this.youtubePeriod = null; this.youtubeGeneration = 0;
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
        const avatar = ['default', 'medium', 'high'].map(size => youtubeAvatarUrl(snippet.thumbnails?.[size]?.url)).find(Boolean);
        items.push({ id: String(snippet.channelId), name: snippet.title, followedAt: publishedAt, ...(avatar ? { avatar } : {}) });
      }
      cursor = response.nextPageToken;
      if (!cursor) break;
      if (page === maxPages - 1) truncated = true;
    }
    // The subscriber list belongs to the OAuth account, which may differ from the configured
    // channel used by ChannelTotals. Missing, hidden or invalid statistics cannot imply growth.
    let total = null, ownerChannelId = null;
    try {
      const response = await y.api('/channels', { part: 'statistics', mine: 'true' }, { auth: true });
      const channel = response?.items?.[0], stats = channel?.statistics, raw = stats?.subscriberCount;
      if (typeof channel?.id === 'string' && channel.id.trim()) ownerChannelId = channel.id;
      if (!stats?.hiddenSubscriberCount && typeof raw === 'string' && /^\d+$/.test(raw)) {
        const value = Number(raw);
        if (Number.isSafeInteger(value)) total = value;
      }
    } catch (err) {
      if (err?.reason === 'quotaExceeded') throw err;
      // Named subscribers can still be recorded without a usable total.
    }
    return { items, truncated, total, ownerChannelId };
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

  // Select once for both the public widget and the panel's exact bulk action.
  thanksSelection(config = {}, lastStreamCutoff = null) {
    const list = this.list({ pending: true });
    const platforms = config.platforms || [];
    const cutoff = config.window === 'days' ? this.now() - config.days * 86_400_000
      : config.window === 'lastStream' ? lastStreamCutoff : null;
    const inWindow = at => {
      if (cutoff == null || at == null) return true;
      const time = Date.parse(at);
      return !Number.isFinite(time) || time >= cutoff;
    };
    const when = at => { const n = at == null ? NaN : Date.parse(at); return Number.isFinite(n) ? n : -Infinity; };
    const entries = list.entries.filter(e => e.source === 'offline' && platforms.includes(e.platform) && inWindow(e.followedAt))
      .sort((a, b) => when(a.followedAt) - when(b.followedAt)).slice(-config.maxNames);
    const anonymous = config.showAnonymous && platforms.includes('youtube') ? list.anonymous.filter(a => inWindow(a.at)) : [];
    return { entries, anonymous };
  }

  // The route validates the complete selection before entering this method.
  markSelected({ entries = [], anonymous = [] }) {
    if (this.readOnly) throw Object.assign(new Error(this.loadError), { status: 503 });
    let touched = false;
    for (const p of PLATFORMS) {
      for (const e of this.platforms[p].entries) {
        const selected = entries.some(s => matchesFollowerSelection(p, e, s));
        if (!e.thanked && selected) { e.thanked = true; touched = true; }
      }
    }
    for (const a of this.platforms.youtube.anonymous) if (!a.thanked && anonymous.includes(a.at)) { a.thanked = true; touched = true; }
    if (touched) this.changed();
    return this.list();
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

  // Capture ownership when work is admitted, including the offline interval between periods.
  captureYouTubeActivity() {
    const generation = this.youtubeGeneration;
    return () => this.youtubeGeneration === generation;
  }

  sync(platform, { live, active = () => true, establish = false } = {}) {
    if (!PLATFORMS.includes(platform)) return Promise.reject(new Error('Plataforma desconocida.'));
    const owner = platform === 'youtube' ? this.captureYouTubeActivity() : () => true;
    const admitted = () => !this.halted && owner() && active() && !(platform === 'youtube' && this.youtubePeriod?.quota);
    if (!admitted()) return Promise.resolve();
    const run = async () => {
      if (!admitted()) return;
      const period = platform === 'youtube' ? this.youtubePeriod : null;
      // Startup refreshes share the same reader: once the listening baseline exists,
      // they must not silently consume a subscriber before the next scheduled poll.
      const enabled = () => Number(this.youtube?.cfg?.subscriberPollSeconds ?? 120) !== 0;
      const liveRead = platform === 'youtube' && (live ?? !!(period?.ready && enabled()));
      const current = () => admitted() && (!liveRead || (period && this.youtubePeriod === period && enabled()));
      const state = this.platforms[platform], startedAt = new Date(this.now()).toISOString();
      let result;
      try { result = await this.readers[platform](state.lastSync); } catch (err) {
        if (!current()) return;
        const quota = platform === 'youtube' && err?.reason === 'quotaExceeded';
        if (quota && this.youtubePeriod) {
          this.youtubePeriod.quota = true;
          clearTimeout(this.youtubePeriod.timer); this.youtubePeriod.timer = null;
        }
        this.states[platform] = { status: quota ? 'quota' : 'error', error: err?.message || String(err) };
        this.log(`[seguidores] ${platform}: ${this.states[platform].error}`);
        if (this.dirty && this.lastWriteError) this.changed(); else this.emit('change', this.snapshot());
        return this.states[platform].status;
      }
      if (!current()) return;
      if (result == null) {
        this.states[platform] = { status: 'needs_account', error: null };
        if (this.dirty && this.lastWriteError) this.changed(); else this.emit('change', this.snapshot());
        return this.states[platform].status;
      }
      const baseline = !state.lastSync, discovered = [];
      if (platform === 'youtube') {
        const known = new Set(state.knownIds), seen = new Set(); let named = 0;
        for (const item of result.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const afterLastSync = item.followedAt == null || Date.parse(item.followedAt) > Date.parse(state.lastSync);
          if (!baseline && !known.has(item.id) && afterLastSync) {
            named++;
            const before = state.entries.length;
            const { avatar: _avatar, ...entry } = item; // Thumbnail URLs are transient, never registry data.
            this.add(platform, { ...entry, followedAt: item.followedAt ?? null, source: liveRead ? 'live' : 'offline', thanked: false });
            if (liveRead && state.entries.length > before) discovered.push(item);
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
      // Mark the baseline before releasing the busy queue to any already-queued refresh.
      if (establish && period && this.youtubePeriod === period) period.ready = true;
      this.changed();
      for (const item of discovered) {
        if (!current()) break;
        const avatar = youtubeAvatarUrl(item.avatar);
        this.emit('liveFollow', { platform, id: item.id, name: item.name,
          ...(avatar ? { avatar } : {}), ...(result.ownerChannelId ? { ownerChannelId: result.ownerChannelId } : {}) });
      }
      return this.states[platform].status;
    };
    const next = (this.busy[platform] || Promise.resolve()).then(run, run);
    const tracked = next.finally(() => { if (this.busy[platform] === tracked) delete this.busy[platform]; });
    this.busy[platform] = tracked;
    return next;
  }

  // Each listening transition owns its baseline and its timer. The next timer is armed
  // only after the preceding sync settles, so slow requests never build a backlog.
  beginYouTubeListening(baseline) {
    this.endYouTubeListening();
    if (this.halted) return;
    const period = { ready: false, quota: false, pending: true, timer: null, deadline: 0 };
    this.youtubePeriod = period;
    const active = () => this.youtubePeriod === period;
    const finish = status => {
      if (!active() || this.halted) return;
      period.pending = false;
      if (status === 'ok' || status === 'partial') period.ready = true;
      this.updateYouTubePolling();
    };
    Promise.resolve(baseline(active)).then(finish, () => finish());
  }

  updateYouTubePolling() {
    const period = this.youtubePeriod;
    if (!period) return;
    clearTimeout(period.timer); period.timer = null;
    if (this.halted || period.quota || period.pending) return;
    const configured = Number(this.youtube?.cfg?.subscriberPollSeconds ?? 120);
    if (configured === 0) return;
    const seconds = Number.isFinite(configured) ? Math.max(60, configured) : 120;
    period.deadline = Math.min(Number.MAX_VALUE, Date.now() + seconds * 1000);
    const active = () => this.youtubePeriod === period;
    const schedule = () => {
      const delay = Math.min(MAX_TIMER_MS, Math.max(0, period.deadline - Date.now()));
      period.timer = setTimeout(() => {
        period.timer = null;
        if (!active() || this.halted || period.quota) return;
        if (Date.now() < period.deadline) { schedule(); return; }
        period.pending = true;
        this.sync('youtube', { live: period.ready, establish: !period.ready, active }).then(status => {
          if (!active() || this.halted) return;
          period.pending = false;
          if (status === 'ok' || status === 'partial') period.ready = true;
          this.updateYouTubePolling();
        }, () => {
          if (!active() || this.halted) return;
          period.pending = false;
          this.updateYouTubePolling();
        });
      }, delay);
      period.timer.unref?.();
    };
    schedule();
  }

  endYouTubeListening() {
    this.youtubeGeneration++;
    if (this.youtubePeriod) clearTimeout(this.youtubePeriod.timer);
    this.youtubePeriod = null;
  }

  halt() { this.halted = true; this.endYouTubeListening(); }

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
