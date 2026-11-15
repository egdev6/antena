import { Meld } from '../meld.mjs';
import { MeldAdapter } from './meld-adapter.mjs';

export { MELD_COMMANDS, MELD_STREAM_EVENTS } from '../meld.mjs';

export function noticeObsUnavailable(log) {
  try { log?.('[programa] OBS aún no está disponible; se mantiene Meld hasta #182.'); } catch { /* aviso no esencial */ }
}

// #182 añadirá el adaptador y el cambio real; elegir OBS no detiene Meld todavía.
export function createProgram(kind, { meld, log } = {}) {
  if (kind === 'obs') noticeObsUnavailable(log);
  if (kind === 'meld' || kind === 'obs') return new MeldAdapter(meld ?? new Meld(log));
  throw new Error(`Unsupported program: ${kind}`);
}
