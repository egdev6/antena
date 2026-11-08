import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WsResponse } from '../src/ws-stream.mjs';

class Socket extends EventEmitter {
  writableLength = 23;
  writableEnded = false;
  destroyed = false;
  writes = [];
  write(data) { this.writes.push(data); return false; }
  end(data) { this.writableEnded = true; this.writes.push(data); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('response mirrors backpressure, emits drain, and ends once with a 1000 close', () => {
  const socket = new Socket(), res = new WsResponse(socket);
  let drains = 0, closes = 0, errors = 0;
  res.on('drain', () => drains++); res.on('close', () => closes++); res.on('error', () => errors++);
  assert.equal(res.writableLength, 23); assert.equal(res.writableEnded, false); assert.equal(res.destroyed, false);
  assert.equal(res.write('hola'), false); assert.deepEqual(socket.writes[0], Buffer.from([0x81, 4, 104, 111, 108, 97]));
  socket.emit('drain'); assert.equal(drains, 1);
  res.end(); res.end(); assert.equal(res.writableEnded, true);
  assert.deepEqual(socket.writes[1], Buffer.from([0x88, 2, 3, 232]));
  assert.equal(res.write('too late'), false); assert.equal(socket.writes.length, 2);
  socket.emit('end'); socket.emit('error', new Error('test')); socket.destroy();
  assert.equal(closes, 1); assert.equal(errors, 1); assert.equal(res.destroyed, true);
});

test('remote end prevents writes even before the socket is destroyed', () => {
  const socket = new Socket(), res = new WsResponse(socket);
  let closes = 0; res.on('close', () => closes++);
  socket.emit('end'); socket.emit('close');
  assert.equal(closes, 1); assert.equal(res.destroyed, false);
  assert.equal(res.write('late'), false);
});
