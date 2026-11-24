// Rotating messages widget: pure rotation order and timing, shared by the widget page and tests.

export const ROTATOR_DEFAULTS = { intervalSec: 240, durationSec: 12 };
const DEMO_TIMING = { intervalMs: 5000, durationMs: 4000 };

/** Interval (start to start) and visible time in ms. The visible time never exceeds the interval.
 *  The demo preview uses a fast cadence so every message can be seen in seconds. */
export function rotatorTiming(cfg = {}, { demo = false } = {}) {
  if (demo) return { ...DEMO_TIMING };
  const intervalSec = Number(cfg.intervalSec) > 0 ? Number(cfg.intervalSec) : ROTATOR_DEFAULTS.intervalSec;
  const durationSec = Number(cfg.durationSec) > 0 ? Number(cfg.durationSec) : ROTATOR_DEFAULTS.durationSec;
  return { intervalMs: intervalSec * 1000, durationMs: Math.min(durationSec, intervalSec) * 1000 };
}

/** Returns { next() } giving the items in order. 'sequential' follows the list and loops;
 *  'random' shuffles every round (each item once per round) and never repeats an item twice in a
 *  row, also across rounds. An empty list gives null. */
export function createRotation(items, order = 'sequential', random = Math.random) {
  const list = [...items];
  let index = -1, bag = [], last;
  const shuffle = () => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    // The first item of a new round must differ from the last one shown.
    if (out.length > 1 && out[0] === last) [out[0], out[out.length - 1]] = [out[out.length - 1], out[0]];
    return out;
  };
  return {
    next() {
      if (!list.length) return null;
      if (order !== 'random') { index = (index + 1) % list.length; return (last = list[index]); }
      if (!bag.length) bag = shuffle();
      return (last = bag.shift());
    },
  };
}
