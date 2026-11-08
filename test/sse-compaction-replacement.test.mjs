// #57: after the queue compacts its delivered slots, a pending snapshot is still replaced
// in place (the index keeps entry references) and byte accounting stays exact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bus } from '../src/bus.mjs';

test('S3: replacement survives queue compaction', () => {
  const b = new Bus({ byteBudget: Infinity }), s = new EventEmitter(), sent = [];
  s.write = x => (sent.push(x), false);
  const c = b.addClient(s, 'panel');
  b.send('chat', 0);
  for (let i = 0; i < 1024; i++) b.send('chat', i);
  b.send('history', 'old'); b.send('chat', 'tail');
  for (let i = 0; i < 1024; i++) s.emit('drain');
  assert.equal(c.queueHead, 0);
  const entry = c.queue[0];
  b.send('history', 'á');
  assert.strictEqual(c.lastReplaceable.get('history'), entry);
  assert.equal(c.queueBytes, c.queue.reduce((n, e) => n + Buffer.byteLength(e.msg), 0));
  s.emit('drain'); s.emit('drain');
  assert.deepEqual(sent.slice(-2), [
    'event: history\ndata: "á"\n\n', 'event: chat\ndata: "tail"\n\n',
  ]);
  s.emit('close');
});
