// #57: exercise the owned queue through writes, drains and gap events only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bus } from '../src/bus.mjs';

class Sink extends EventEmitter {
  bytes = 0; written = []; ended = false; ends = 0;
  get writableLength() { return this.bytes; }
  write(chunk) {
    assert.equal(this.ended, false, 'never write after end');
    this.written.push(chunk); this.bytes += Buffer.byteLength(chunk); return false;
  }
  end() { this.ended = true; this.ends++; }
  drain() { this.bytes = 0; this.emit('drain'); }
}
const events = s => s.written.map(chunk => {
  const [, event, data] = /^event: (.+)\ndata: (.+)\n\n$/.exec(chunk);
  return { event, data: JSON.parse(data) };
});
const window = (t, ms = 100) => { t.mock.timers.tick(ms); t.mock.timers.tick(0); };

test('blocked writes resume in FIFO order; latest snapshots follow the queue without being lost', () => {
  const bus = new Bus({ byteBudget: 1_000_000 }); const sink = new Sink(); bus.addClient(sink, 'panel');
  bus.send('chat', { id: 0 });
  bus.send('status', { n: 1 }); bus.send('pause', { n: 1 });
  bus.send('chat', { id: 1 }); bus.send('status', { n: 2 });
  bus.send('chat', { id: 2 }); bus.send('pause', { n: 2 });
  assert.deepEqual(events(sink), [{ event: 'chat', data: { id: 0 } }]);
  for (let count = 2; count <= 5; count++) {
    sink.drain();
    assert.equal(events(sink).length, count, 'stop again as soon as write returns false');
  }
  assert.deepEqual(events(sink), [
    { event: 'chat', data: { id: 0 } }, { event: 'chat', data: { id: 1 } },
    { event: 'chat', data: { id: 2 } }, { event: 'status', data: { n: 2 } },
    { event: 'pause', data: { n: 2 } },
  ]);
  assert.equal(sink.ended, false);
});

test('UTF-8 queued bytes trigger the budget; gap counts at-risk writes and queued ephemerals once', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, backlogGraceMs: 100, now: () => Date.now() });
  const sink = new Sink(); bus.addClient(sink, 'overlay');
  bus.send('chat', { id: 0 });
  bus.send('chat', { id: 1, text: 'á'.repeat(50) });
  bus.send('chat', { id: 2, text: 'á'.repeat(50) });
  assert.equal(sink.written.length, 1);
  sink.drain(); // id 1 is written over budget; id 2 is still queued
  bus.send('chat', { id: 3 });
  window(t); assert.equal(sink.ended, false, 'a drain renewed the grace');
  window(t, 899); assert.equal(sink.ended, false, 'not stalled before 1000ms without drain');
  window(t, 1);
  assert.deepEqual(events(sink).at(-1), {
    event: 'gap', data: { reason: 'slow-client', kind: 'overlay', droppedEphemeral: 3, cause: 'stalled' },
  });
  const count = sink.written.length;
  bus.send('chat', { id: 4 }); sink.drain(); window(t);
  assert.equal(sink.written.length, count);
  assert.equal(sink.ends, 1);
});

test('a retained UTF-8 snapshot counts toward the backlog and triggers the initial grace', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, now: () => Date.now() });
  const sink = new Sink(); bus.addClient(sink, 'panel');
  bus.send('chat', { id: 0 });
  bus.send('status', { text: 'á'.repeat(40) });
  assert.deepEqual(events(sink), [{ event: 'chat', data: { id: 0 } }]);
  window(t, 99); assert.equal(sink.ended, false);
  window(t, 1);
  assert.deepEqual(events(sink).at(-1), {
    event: 'gap', data: { reason: 'slow-client', kind: 'panel', droppedEphemeral: 0, cause: 'stalled' },
  });
  assert.equal(sink.ends, 1);
});

test('replacing a large snapshot with a small one resets a later budget crossing', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'] });
  const bus = new Bus({ byteBudget: 100, now: () => Date.now() });
  const sink = new Sink(); bus.addClient(sink, 'panel');
  bus.send('chat', { id: 0 });
  bus.send('status', { text: 'á'.repeat(40) });
  window(t, 50);
  bus.send('status', { text: '' });
  window(t, 10);
  bus.send('status', { text: 'á'.repeat(40) });
  window(t, 40); assert.equal(sink.ended, false, 'the old crossing cannot cut the new one');
  window(t, 59); assert.equal(sink.ended, false);
  window(t, 1);
  assert.deepEqual(events(sink).at(-1), {
    event: 'gap', data: { reason: 'slow-client', kind: 'panel', droppedEphemeral: 0, cause: 'stalled' },
  });
  assert.equal(sink.ends, 1);
});
