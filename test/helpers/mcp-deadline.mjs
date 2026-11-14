// Preloaded only by the startup deadline probe. Leave unrelated application timers real.
const mcpUrl = new URL('../../src/mcp.mjs', import.meta.url).href;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const deadlines = new Set();
let now = 0;

globalThis.setTimeout = function (callback, delay, ...args) {
  const caller = new Error().stack?.split('\n')[2] ?? '';
  if (!caller.includes(`${mcpUrl}:`)) return nativeSetTimeout(callback, delay, ...args);

  const timer = {
    callback, delay, args, due: now + delay, active: true,
    ref() { return this; },
    unref() { return this; },
    hasRef() { return true; },
    refresh() { console.error('FIXTURE:DEADLINE:REFRESH'); return this; },
  };
  deadlines.add(timer);
  console.error('FIXTURE:DEADLINE:REGISTER:' + delay);
  return timer;
};

globalThis.clearTimeout = function (timer) {
  if (!deadlines.has(timer)) return nativeClearTimeout(timer);
  console.error('FIXTURE:DEADLINE:CLEAR');
  timer.active = false;
};

// A deferred marker confirms readline has handled EOF before the clock advances.
process.stdin.once('end', () => setImmediate(() => console.error('FIXTURE:DEADLINE:EOF')));
process.on('message', message => {
  const match = /^advance:(\d+)$/.exec(message);
  if (!match) return;
  const amount = Number(match[1]);
  now += amount;
  console.error('FIXTURE:DEADLINE:ADVANCE:' + amount);
  for (const timer of deadlines) {
    if (!timer.active || timer.due > now) continue;
    timer.active = false;
    console.error('FIXTURE:DEADLINE:EXPIRE');
    timer.callback.apply(timer, timer.args);
  }
});
