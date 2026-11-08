// #57: with snapshots always pending the queue never becomes empty; delivered slots must
// still be released so its storage stays bounded by what is actually pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bus } from '../src/bus.mjs';

test('S3: a continuously nonempty snapshot queue stays bounded', t => {
  class Sink extends EventEmitter {
    bytes = 0;
    get writableLength() { return this.bytes; }
    write(s) { this.bytes += Buffer.byteLength(s); return false; }
    end() {}
    drain() { this.bytes = 0; this.emit('drain'); }
  }
  const bus = new Bus({ byteBudget: 1024 * 1024 }), sink = new Sink();
  const client = bus.addClient(sink, 'panel');
  t.after(() => sink.emit('close'));
  const text = 'x'.repeat(96 * 1024);
  bus.send('chat', { text });
  bus.send('history', { text }); bus.send('widgets', { text });
  for (let n = 0; n < 5000; n++) {
    sink.drain();
    bus.send(n % 2 ? 'widgets' : 'history', { n, text });
  }
  assert.equal(client.lastReplaceable.size, 2);
  const pending = client.queue.length - client.queueHead;
  assert.ok(client.queue.length <= pending + 2048,
    `retained ${client.queue.length - pending} delivered queue slots with ${pending} pending`);
});
