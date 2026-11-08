// #67: a reconnect whose WebSocket upgrade stalls (never opens nor closes) must be retired and
// retried, like EventSource recovers; after a successful WS open it never falls back to SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntenaStream } from '../public/stream-client.js';

test('S3/S4: one stalled reconnect is retired and a later WS delivers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = { WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, location: globalThis.location };
  const sockets = [];
  class Socket extends EventTarget {
    constructor() { super(); this.closed = false; sockets.push(this); }
    open() { this.dispatchEvent(new Event('open')); }
    frame(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    fail() { this.dispatchEvent(new Event('close')); }
    close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
  }
  let fallback = 0;
  Object.assign(globalThis, { WebSocket: Socket, EventSource: class { constructor() { fallback++; } },
    location: { href: 'http://localhost/' } });
  const stream = new AntenaStream('/api/stream?client=widget');
  t.after(() => { stream.close(); Object.assign(globalThis, saved); });
  let opens = 0;
  const messages = [];
  stream.onopen = () => opens++;
  stream.addEventListener('viewers', e => messages.push(e.data));
  sockets[0].open();
  sockets[0].frame('retry: 37\n\n');
  sockets[0].fail();
  t.mock.timers.tick(37);
  const stalled = sockets[1];
  assert.ok(stalled, 'first reconnect started');
  for (let ms = 0; ms < 30000 && sockets.length < 3; ms += 10) t.mock.timers.tick(10);
  assert.equal(stalled.closed, true, 'stalled reconnect must be retired');
  assert.equal(sockets.length, 3, 'a fresh websocket must be attempted');
  stalled.open(); stalled.frame('event: viewers\ndata: stale\n\n');
  sockets[2].open(); sockets[2].frame('event: viewers\ndata: fresh\n\n');
  assert.equal(opens, 2);
  assert.deepEqual(messages, ['fresh']);
  assert.equal(fallback, 0, 'never switch to SSE after a successful WS open');
  stream.close();
  t.mock.timers.tick(30000);
  assert.equal(sockets.length, 3, 'close cancels retries');
});
