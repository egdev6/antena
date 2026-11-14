import { Meld } from '../meld.mjs';
import { MeldAdapter } from './meld-adapter.mjs';

export { MELD_COMMANDS, MELD_STREAM_EVENTS } from '../meld.mjs';

// The server can supply its existing Meld while consumers still use it directly.
export function createProgram(kind, { meld, log } = {}) {
  if (kind === 'meld') return new MeldAdapter(meld ?? new Meld(log));
  throw new Error(`Unsupported program: ${kind}`);
}
