// #57: backlog progress is visible through drain-driven writes, not socket byte counters.
// Mock timers make the grace and continuous-backlog cap deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bus } from '../src/bus.mjs';

class Sink extends EventEmitter {
  buffered = 0;
  written = [];
  closed = false;
  get writableLength() { return this.buffered; }
  write(chunk) {
    assert.equal(this.closed, false, 'never write after end');
    this.written.push(chunk);
    this.buffered += Buffer.byteLength(chunk);
    return false;
  }
  end() { this.closed = true; }
  drain() { this.buffered = 0; this.emit('drain'); }
}

const gaps = s => s.written.filter(c => c.startsWith('event: gap\n'))
  .map(c => JSON.parse(c.slice(c.indexOf('data: ') + 6)));
const burst = (bus, n, size = 1000) => {
  for (let i = 0; i < n; i++) bus.send('alert', { id: i, text: 'x'.repeat(size) });
};
const window = (t, ms = 100) => { t.mock.timers.tick(ms); t.mock.timers.tick(0); };

test('a client that keeps reading is not cut by a burst bigger than the budget', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, now: () => Date.now() });
  const reader = new Sink();
  bus.addClient(reader, 'panel');
  burst(bus, 60);
  assert.equal(reader.written.length, 1, 'only one write while blocked');
  for (let i = 0; i < 6; i++) {
    for (let n = 0; n < 10; n++) reader.drain();
    window(t);
    assert.equal(reader.closed, false, 'a progressing reader keeps its connection');
  }
  assert.deepEqual(gaps(reader), []);
  assert.deepEqual(reader.written.map(c => JSON.parse(c.split('data: ')[1]).id), Array.from({ length: 60 }, (_, i) => i));
  assert.ok(reader.writableLength <= 10_000, 'it caught up below the budget');
});

test('a stalled client is still cut after one grace window, with the cause', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, now: () => Date.now() });
  const stalled = new Sink();
  bus.addClient(stalled, 'overlay');
  burst(bus, 30);
  t.mock.timers.tick(99);
  assert.equal(stalled.closed, false, 'never cut inside the grace window');
  window(t, 1);
  assert.equal(stalled.closed, true, 'no progress in one window: cut');
  assert.deepEqual(gaps(stalled), [{ reason: 'slow-client', kind: 'overlay', droppedEphemeral: 29, cause: 'stalled' }]);
  const after = stalled.written.length;
  burst(bus, 5); stalled.drain(); window(t, 1000);
  assert.equal(stalled.written.length, after, 'nothing more is delivered to a cut client');
});

test('one drain gives the configured stall interval, not another single grace window', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, backlogGraceMs: 100, backlogStallMs: 350, now: () => Date.now() });
  const reader = new Sink(); bus.addClient(reader, 'panel'); burst(bus, 4, 200);
  window(t, 40); reader.drain();
  window(t, 200); assert.equal(reader.closed, false, 'no cut 200ms after the drain');
  reader.write(': ping\n\n'); // an external keepalive is not a drain
  window(t, 149); assert.equal(reader.closed, false, 'not before the 350ms stall deadline');
  window(t, 1);
  assert.equal(reader.closed, true);
  assert.deepEqual(gaps(reader), [{ reason: 'slow-client', kind: 'panel', droppedEphemeral: 4, cause: 'stalled' }]);
});

test('a stall deadline shorter than the grace is scheduled precisely after a drain', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, backlogGraceMs: 100, backlogStallMs: 40, now: () => Date.now() });
  const reader = new Sink(); bus.addClient(reader, 'panel'); burst(bus, 4, 200);
  window(t, 10); reader.drain();
  window(t, 39); assert.equal(reader.closed, false);
  window(t, 1);
  assert.deepEqual(gaps(reader), [{ reason: 'slow-client', kind: 'panel', droppedEphemeral: 4, cause: 'stalled' }]);
});

test('backlogStallMs defaults to 1000ms after the most recent drain', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, backlogGraceMs: 100, now: () => Date.now() });
  const reader = new Sink(); bus.addClient(reader, 'overlay'); burst(bus, 4, 200);
  reader.drain();
  window(t, 999); assert.equal(reader.closed, false, 'not before the default stall deadline');
  window(t, 1);
  assert.equal(reader.closed, true);
  assert.deepEqual(gaps(reader), [{ reason: 'slow-client', kind: 'overlay', droppedEphemeral: 4, cause: 'stalled' }]);
});

test('each later drain restarts the stall deadline while the backlog remains over budget', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, backlogGraceMs: 100, backlogStallMs: 350, now: () => Date.now() });
  const reader = new Sink(); bus.addClient(reader, 'panel'); burst(bus, 4, 200);
  reader.drain(); window(t, 300); reader.drain();
  window(t, 349); assert.equal(reader.closed, false);
  window(t, 1);
  assert.deepEqual(gaps(reader), [{ reason: 'slow-client', kind: 'panel', droppedEphemeral: 4, cause: 'stalled' }]);
});

test('a non-multiple backlog cap is enforced at 250ms, not at the next 100ms check', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, backlogGraceMs: 100, backlogMaxMs: 250, now: () => Date.now() });
  const reader = new Sink(); bus.addClient(reader, 'panel'); burst(bus, 4, 200);
  reader.drain(); window(t); reader.drain(); window(t); reader.drain();
  window(t, 49); assert.equal(reader.closed, false);
  window(t, 1);
  assert.equal(reader.closed, true);
  assert.deepEqual(gaps(reader), [{ reason: 'slow-client', kind: 'panel', droppedEphemeral: 4, cause: 'backlog-timeout' }]);
});

test('a client that progresses but never catches up is cut at backlogMaxMs, with the cause', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, backlogMaxMs: 1000, now: () => Date.now() });
  const crawler = new Sink();
  bus.addClient(crawler, 'prompter');
  burst(bus, 60);
  for (let elapsed = 100; elapsed < 1000; elapsed += 100) {
    crawler.drain(); burst(bus, 1); window(t);
    assert.equal(crawler.closed, false, `still allowed at ${elapsed} ms`);
  }
  crawler.drain(); burst(bus, 1); window(t);
  assert.equal(crawler.closed, true, 'over budget for backlogMaxMs: cut to bound memory');
  assert.equal(gaps(crawler)[0].cause, 'backlog-timeout');
});

test('backlogMaxMs defaults to 5000 ms', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 10_000, backlogGraceMs: 100, now: () => Date.now() });
  const crawler = new Sink();
  bus.addClient(crawler, 'panel');
  burst(bus, 60);
  for (let i = 0; i < 49; i++) { crawler.drain(); burst(bus, 1); window(t); }
  assert.equal(crawler.closed, false, 'still connected at 4900 ms');
  crawler.drain(); burst(bus, 1); window(t);
  assert.equal(crawler.closed, true, 'cut at 5000 ms');
  assert.equal(gaps(crawler)[0].cause, 'backlog-timeout');
});
