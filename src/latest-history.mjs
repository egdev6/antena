// #357: the last supporter of each «Últimos» type across all streams, kept apart from sessions.
// One entry per type (bounded size), updated with every real event and never cleared when a
// stream starts. Simulated alerts are tests and never enter it.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isSystemType } from './alerts.mjs';
import { writeJson } from './json-file.mjs';

export const LATEST_FILE = 'latest-history.json';
// Same grouping as the per-stream «Últimos» (Session#latest).
export const LATEST_GROUPS = {
  follow: ['follow', 'ytsub'], sub: ['sub', 'resub', 'giftsub'], cheer: ['cheer'], raid: ['raid'],
  superchat: ['superchat', 'supersticker'], member: ['member', 'milestone', 'giftmember'],
};
export const LATEST_KEYS = [...Object.keys(LATEST_GROUPS), 'any'];

/** «Últimos» keys an event type counts for. */
export const latestKeys = type => [
  ...Object.keys(LATEST_GROUPS).filter(k => LATEST_GROUPS[k].includes(type)),
  ...(type && !isSystemType(type) ? ['any'] : []),
];

/** Last event of each «Últimos» type in a list ordered oldest first. */
export function latestOf(events = []) {
  const out = Object.fromEntries(LATEST_KEYS.map(k => [k, null]));
  for (const e of events) for (const k of latestKeys(e?.type)) out[k] = e;
  return out;
}

const validEntry = e => !!e && typeof e === 'object' && typeof e.type === 'string' && typeof e.at === 'string';

export class LatestHistory {
  constructor({ dir, write = writeJson, log = () => {} } = {}) {
    this.file = path.join(dir, LATEST_FILE);
    this.write = write; this.log = log;
    this.entries = Object.fromEntries(LATEST_KEYS.map(k => [k, null]));
    this.loaded = false;
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      for (const k of LATEST_KEYS) this.entries[k] = validEntry(data?.entries?.[k]) ? data.entries[k] : null;
      this.loaded = true;
    } catch (err) {
      if (err?.code !== 'ENOENT') this.log(`[últimos] no se pudo leer ${LATEST_FILE}: ${err.message}; se reconstruye`);
      this.loaded = false;
    }
    return this;
  }

  /** True when there is no saved record yet (first run or unreadable): rebuild it from the archives. */
  get needsBackfill() { return !this.loaded; }

  #apply(ev) {
    if (!validEntry(ev) || ev.simulated) return false;
    let changed = false;
    for (const k of latestKeys(ev.type)) {
      const cur = this.entries[k];
      if (!cur || ev.at >= cur.at) { this.entries[k] = { ...ev }; changed = true; }
    }
    return changed;
  }

  /** A new real event: keep it when it is the newest of its types. */
  observe(ev) {
    const changed = this.#apply(ev);
    if (changed) this.save();
    return changed;
  }

  /** Several events (backfill, imported streams): newest wins, one write. */
  merge(events = []) {
    for (const ev of events) this.#apply(ev);
    this.loaded = true;
    return this.save();
  }

  snapshot() { return { ...this.entries }; }

  save() {
    const data = { version: 1, entries: this.entries };
    this.writing = this.writing.then(() => this.write(this.file, data)).catch(err => this.log(`[últimos] no se pudo guardar ${LATEST_FILE}: ${err.message}`));
    return this.writing;
  }

  flush() { return this.writing; }
}
