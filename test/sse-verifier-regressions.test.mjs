import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Bus } from '../src/bus.mjs';

class Sink extends EventEmitter {
  bytes = 0; frames = []; ended = false;
  get writableLength() { return this.bytes; }
  write(s) { assert.equal(this.ended, false); this.bytes += Buffer.byteLength(s); this.frames.push(s); return false; }
  end() { this.ended = true; }
  drain() { this.bytes = 0; this.emit('drain'); }
  events() { return this.frames.filter(s => s.startsWith('event: ')).map(s => ({ event: /^event: (.*)$/m.exec(s)[1], data: JSON.parse(/^data: (.*)$/m.exec(s)[1]) })); }
}
const tick = (t, ms) => { t.mock.timers.tick(ms); t.mock.timers.tick(0); };

test('surviving snapshots and ephemerals retain their relative send order', () => {
  const b = new Bus({ byteBudget: 1_000_000 }), s = new Sink(); b.addClient(s, 'panel');
  b.send('chat', { id: 0 }); b.send('status', { n: 1 }); b.send('chat', { id: 2 });
  s.drain(); s.drain();
  assert.deepEqual(s.events().map(x => [x.event, x.data.id ?? x.data.n]), [['chat', 0], ['status', 1], ['chat', 2]]);
});

test('continuous ephemeral traffic cannot starve a pending snapshot', () => {
  const b = new Bus({ byteBudget: 1_000_000 }), s = new Sink(); b.addClient(s, 'panel');
  b.send('chat', { id: 0 }); b.send('status', { n: 1 }); b.send('chat', { id: 1 });
  for (let i = 2; i < 12; i++) { s.drain(); b.send('chat', { id: i }); }
  assert.ok(s.events().some(x => x.event === 'status' && x.data.n === 1));
});

test('gap excludes ephemerals already drained in a previous crossing', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 0 });
  const b = new Bus({ byteBudget: 100, now: () => Date.now() }), s = new Sink(); b.addClient(s, 'panel');
  b.send('chat', { id: 0, text: 'x'.repeat(200) }); s.drain();
  b.send('chat', { id: 1, text: 'x'.repeat(200) }); tick(t, 100);
  const gap = s.events().find(x => x.event === 'gap')?.data;
  assert.equal(gap?.reason, 'slow-client'); assert.equal(gap?.droppedEphemeral, 1);
});

test('closing a client removes its drain listener and prevents later writes', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 0 });
  const b = new Bus({ byteBudget: 100, now: () => Date.now() }), s = new Sink(); b.addClient(s, 'panel');
  b.send('chat', { text: 'x'.repeat(200) }); const count = s.frames.length;
  s.emit('close'); s.drain(); b.send('chat', {}); tick(t, 1000);
  assert.equal(b.clients.size, 0); assert.equal(s.frames.length, count); assert.equal(s.listenerCount('drain'), 0);
});
