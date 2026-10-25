// Optimistic widget/interactive edits. Manual saves freeze their intent at click time;
// only automatic saves outside a manual editing unit retain exponential retries.
import { api } from './api';
import { deepMerge, live } from './live';
import { toast } from './ui';
import { flushSources, holding, registerDraft, type DraftSource } from './draft';
import { ManualDraft } from './manual-draft';
import type { AppState, WidgetsConfig } from './types';

type Patch = Record<string, unknown>;
type Snapshot<B extends object> = {
  take: () => B;
  restore: (saved: B) => void;
  persist?: (sent: Patch) => Promise<B>;
  protect: (state: AppState, intent: Patch) => AppState;
};
export function patcher<B extends object>(method: string, url: string, snap: Snapshot<B>, ms = 400) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const buffer = new ManualDraft<Patch, B>({
    empty: () => ({}), merge: deepMerge, take: snap.take,
    persist: async sent => {
      const response = snap.persist ? await snap.persist(sent) : await api<B>(method, url, sent);
      failures = 0;
      return response;
    },
    publish: (saved, newer) => snap.restore(deepMerge(saved, newer)),
    restore: snap.restore, protect: snap.protect,
  });
  const sendAutomatic = async () => {
    clearTimeout(timer);
    // A timer queued outside manual mode must not save a newly opened manual draft.
    if (holding()) return;
    try {
      await buffer.save();
      if (buffer.dirty() && !holding()) timer = setTimeout(flushQuietly, ms);
    } catch (error) {
      if (!failures++) toast(error instanceof Error ? error.message : 'No se pudo guardar', true);
      if (!holding()) timer = setTimeout(flushQuietly, Math.min(30000, 2000 * 2 ** (failures - 1)));
    }
  };
  const flush = () => { chain = chain.then(sendAutomatic, sendAutomatic); return chain; };
  const flushQuietly = () => { void flush(); };
  const push = (patch: Patch) => {
    buffer.push(patch); // snapshot precedes the caller's optimistic mutation (S1)
    clearTimeout(timer);
    if (!holding()) timer = setTimeout(flushQuietly, ms);
  };
  const discard = () => { clearTimeout(timer); buffer.discard(); };
  const source: DraftSource = {
    dirty: buffer.dirty, keys: buffer.keys, protect: buffer.protect,
    prepareSave: () => { clearTimeout(timer); return buffer.prepareSave(); }, discard,
  };
  registerDraft(url, source);
  return { push, flush, discard, source };
}

const W = patcher('PUT', '/api/widgets', {
  take: () => live.state!.config.widgets,
  restore: saved => live.update(s => ({ config: { ...s.config, widgets: saved } })),
  persist: async sent => (await api<{ widgets: WidgetsConfig }>('PUT', '/api/widgets', sent)).widgets,
  protect: (state, intent) => ({ ...state, config: { ...state.config, widgets: deepMerge(state.config.widgets, intent) } }),
});
export function patchWidgets(patch: Patch) {
  W.push(patch); // captures the original before mutating live; later edits keep that copy
  live.update(s => ({ config: { ...s.config, widgets: deepMerge(s.config.widgets, patch) } }));
}

const IX = patcher('PUT', '/api/interactive/config', {
  take: () => live.state!.interactive.config,
  restore: saved => live.update(s => ({ interactive: { ...s.interactive, config: saved } })),
  protect: (state, intent) => ({ ...state, interactive: { ...state.interactive, config: deepMerge(state.interactive.config, intent) } }),
});
export function patchIx(section: string, patch: Patch) {
  IX.push({ [section]: patch }); // capture before the first optimistic edit (S1)
  live.update(s => ({ interactive: { ...s.interactive, config: { ...s.interactive.config, [section]: { ...s.interactive.config[section], ...patch } } } }));
}
export const flushAll = () => flushSources([live.configSource, W.source, IX.source]);
