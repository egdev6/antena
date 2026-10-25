// One manual source: prepared intent is separate from edits made after the click.
// Adapters supply domain snapshots/merging; this buffer never schedules an autosave.
import { draftChanged, saveSources, type DraftSource, type PreparedSave } from './draft';
import type { AppState } from './types';

type Options<P extends object, B> = {
  empty: () => P;
  merge: (older: P, newer: P) => P;
  take: () => B;
  persist: (patch: P) => Promise<B>;
  publish: (saved: B, newer: P) => void;
  restore: (saved: B, discarded: P) => void;
  keys?: (patch: P) => string[];
  protect?: (state: AppState, intent: P) => AppState;
};

export class ManualDraft<P extends object, B> implements DraftSource {
  private pending: P;
  private intent: P | undefined;
  private baseline: { value: B } | undefined;
  private active = true;

  constructor(private options: Options<P, B>) { this.pending = options.empty(); }
  dirty = () => !!this.intent || Object.keys(this.pending).length > 0;
  changes = () => this.intent ? this.options.merge(this.intent, this.pending) : this.pending;
  keys = () => this.options.keys?.(this.changes()) ?? Object.keys(this.changes());
  protect = (state: AppState) => this.active && this.dirty() && this.options.protect
    ? this.options.protect(state, this.changes()) : state;

  // Must precede the optimistic mutation, so the first baseline is the saved value.
  push(patch: P) {
    if (!this.baseline) this.baseline = { value: structuredClone(this.options.take()) };
    this.pending = this.options.merge(this.pending, patch);
    draftChanged();
  }

  prepareSave = (): PreparedSave | undefined => {
    if (this.intent || !Object.keys(this.pending).length) return;
    const sent = structuredClone(this.pending);
    this.pending = this.options.empty();
    this.intent = sent;
    let started = false;
    const restoreIntent = () => {
      this.pending = this.options.merge(sent, this.pending); // newer edits win
      this.intent = undefined;
      draftChanged();
    };
    return {
      rollback: () => { if (!started) restoreIntent(); },
      run: async () => {
        started = true;
        try {
          const saved = await this.options.persist(sent);
          this.intent = undefined;
          this.baseline = Object.keys(this.pending).length ? { value: structuredClone(saved) } : undefined;
          if (this.active) this.options.publish(saved, this.pending);
        } catch (error) {
          restoreIntent();
          throw error;
        } finally { draftChanged(); }
      },
    };
  };
  save = () => saveSources([this]);
  discard = () => {
    if (this.intent) return; // an accepted request cannot be cancelled by discarding
    const saved = this.baseline;
    const discarded = this.pending;
    this.pending = this.options.empty();
    this.baseline = undefined;
    if (saved && this.active) this.options.restore(saved.value, discarded);
    draftChanged();
  };
  updateBaseline(update: (saved: B) => B) {
    if (this.baseline) this.baseline = { value: update(this.baseline.value) };
  }
  isActive = () => this.active;
  dispose() { this.active = false; }
}
