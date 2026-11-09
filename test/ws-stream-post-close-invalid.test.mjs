// #67: after the server has sent its close, invalid input from the peer cannot grow the
// receive buffer or hide a later close; a protocol error then closes the socket at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WsResponse } from '../src/ws-stream.mjs';

class Socket extends EventEmitter {
  writableLength = 0; writableEnded = false; destroyed = false;
  write() { return false; }
  end(cb) { this.writableEnded = true; cb?.(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}

test('S4: invalid data after server close cannot grow the receive buffer', () => {
  const socket = new Socket(), res = new WsResponse(socket);
  try {
    res.end();
    const bytes = Buffer.alloc(512 * 1024); bytes[0] = 0x81; // unmasked text header
    res.receive(bytes);
    assert.ok(socket.destroyed || res.buffer.length < 65536);
  } finally { socket.destroy(); }
});

test('S4: a malformed header cannot hide a subsequent client close', () => {
  const socket = new Socket(), res = new WsResponse(socket);
  try {
    res.end();
    res.receive(Buffer.from([0x81, 0x00])); // unmasked text
    if (!socket.destroyed) res.receive(Buffer.from([0x88, 0x82, 1, 2, 3, 4, 2, 234])); // close 1000
    assert.equal(socket.destroyed, true);
  } finally { socket.destroy(); }
});
