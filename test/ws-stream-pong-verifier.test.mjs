// #67: a ping flood keeps at most one queued pong, exact byte accounting and data frames
// that are never split by a pong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WsResponse } from '../src/ws-stream.mjs';

class Socket extends EventEmitter {
  writableLength = 0; writableEnded = false; destroyed = false; chunks = []; callbacks = [];
  write(b, cb) { this.chunks.push(b); this.callbacks.push([b.length, cb]); this.writableLength += b.length; return false; }
  step() { const [n, cb] = this.callbacks.shift(); this.writableLength -= n; this.emit('drain'); cb(); }
}

test('S4/S5: pong flood preserves exact bytes and complete data frames', () => {
  const s = new Socket(), r = new WsResponse(s);
  const ping = n => { const b = Buffer.alloc(6 + n, 97); b.set([137, 128 | n, 0, 0, 0, 0]); return b; };
  r.write('x'.repeat(70000));
  for (let i = 0; i < 10000; i++) { const n = [0, 125, 3][i % 3]; r.receive(ping(n)); assert.equal(r.writableLength, 70012 + n); }
  r.write('z'); r.receive(ping(7));
  while (s.callbacks.length) s.step();
  const b = Buffer.concat(s.chunks);
  assert.equal(b[0], 129); assert.equal(b.readBigUInt64BE(2), 70000n);
  assert.equal(b.subarray(10, 70010).toString(), 'x'.repeat(70000));
  assert.deepEqual(b.subarray(70010), Buffer.from([138, 7, ...Array(7).fill(97), 129, 1, 122]));
  assert.equal(r.writableLength, 0);
});
