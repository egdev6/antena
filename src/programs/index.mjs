import { createRequire } from 'node:module';
import { Meld } from '../meld.mjs';
import { MeldAdapter } from './meld-adapter.mjs';

// Keep Meld-only consumers and copied MCP fixtures independent of the dormant OBS module.
const require = createRequire(import.meta.url);

export { MELD_COMMANDS, MELD_STREAM_EVENTS } from '../meld.mjs';

export function createProgram(kind, { meld, log, ...obsOptions } = {}) {
  if (kind === 'meld') return new MeldAdapter(meld ?? new Meld(log));
  if (kind === 'obs') return new (require('./obs-adapter.mjs').ObsAdapter)(obsOptions);
  throw new Error(`Unsupported program: ${kind}`);
}
