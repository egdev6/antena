// #57: the SSE bus cut a client that WAS reading if its backlog had not dropped below the
// budget 100 ms after crossing it (a loaded machine during a stream could cut a live panel).
// The grace is now progress-based: a client whose backlog shrinks between checks keeps its
// connection; a stalled client is cut after one grace window; a client that progresses but
// never catches up is cut once it has stayed over budget for backlogMaxMs. The gap reports why.
// Mock timers make the windows deterministic; the sink lets the test decide how much drains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.mjs';

function sink() {
  let buffered = 0;
  const written = [];
  return {
    written,
    closed: false,
    get writableLength() { return buffered; },
    writableEnded: false,
    destroyed: false,
    write(chunk) {
      if (this.closed) return false;
      written.push(chunk);
      buffered += Buffer.byteLength(chunk);
      return false; // backpressure: the kernel did not take it yet
    },
    on() {},
    end() { this.closed = true; },
    /** The client reads n bytes (partial progress, no 'drain' yet). */
    consume(n) { buffered = Math.max(0, buffered - n); },
  };
}

const gaps = s => s.written.filter(c => c.startsWith('event: gap\n'))
  .map(c => JSON.parse(c.slice(c.indexOf('data: ') + 6)));
const burst = (bus, n, size = 1000) => {
  for (let i = 0; i < n; i++) bus.send('alert', { id: i, text: 'x'.repeat(size) });
};

test('a client that keeps reading is not cut by a burst bigger than the budget', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, now: () => Date.now() });
  const reader = sink();
  bus.addClient(reader, 'panel');
  burst(bus, 60); // ~60 KB, six times the budget, in one tick
  for (let i = 0; i < 6; i++) {
    reader.consume(10_000); // reads 10 KB per window: slower than one window, but progressing
    t.mock.timers.tick(100);
  }
  assert.equal(reader.closed, false, 'a progressing reader keeps its connection');
  assert.deepEqual(gaps(reader), [], 'no gap for a reader that is consuming its queue');
  assert.ok(reader.writableLength <= 10_000, 'it caught up below the budget');
});

test('a stalled client is still cut after one grace window, with the cause', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, now: () => Date.now() });
  const stalled = sink();
  bus.addClient(stalled, 'overlay');
  burst(bus, 30);
  t.mock.timers.tick(99);
  assert.equal(stalled.closed, false, 'never cut inside the grace window');
  t.mock.timers.tick(1);
  t.mock.timers.tick(0); // the bus yields one I/O turn before calling a client stalled
  assert.equal(stalled.closed, true, 'no progress in one window: cut');
  const [gap] = gaps(stalled);
  assert.equal(gap.reason, 'slow-client');
  assert.equal(gap.kind, 'overlay');
  assert.equal(gap.cause, 'stalled');
  assert.equal(typeof gap.droppedEphemeral, 'number');
  const after = stalled.written.length;
  burst(bus, 5);
  assert.equal(stalled.written.length, after, 'nothing more is delivered to a cut client');
});

test('a client that progresses but never catches up is cut at backlogMaxMs, with the cause', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, backlogMaxMs: 1000, now: () => Date.now() });
  const crawler = sink();
  bus.addClient(crawler, 'prompter');
  burst(bus, 60);
  for (let elapsed = 100; elapsed < 1000; elapsed += 100) {
    crawler.consume(100); // tiny progress every window: never gets under the budget
    t.mock.timers.tick(100);
    assert.equal(crawler.closed, false, `still allowed at ${elapsed} ms`);
  }
  crawler.consume(100);
  t.mock.timers.tick(100);
  assert.equal(crawler.closed, true, 'over budget for backlogMaxMs: cut to bound memory');
  assert.equal(gaps(crawler)[0].cause, 'backlog-timeout');
});

test('backlogMaxMs defaults to 5000 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, now: () => Date.now() });
  const crawler = sink();
  bus.addClient(crawler, 'panel');
  burst(bus, 60);
  for (let i = 0; i < 49; i++) { crawler.consume(100); t.mock.timers.tick(100); }
  assert.equal(crawler.closed, false, 'still connected at 4900 ms');
  crawler.consume(100);
  t.mock.timers.tick(100);
  assert.equal(crawler.closed, true, 'cut at 5000 ms');
});
