// #67: stream client timers: cleared on open, close and close(); a healthy long-lived
// connection never sees a spurious reconnect; first-attempt SSE fallback timing unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntenaStream as Current } from '../public/stream-client.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = { WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, location: globalThis.location };
  const clear = globalThis.clearTimeout, cleared = [], sockets = [], sources = [];
  globalThis.clearTimeout = id => { cleared.push(id); return clear(id); };
  class Socket extends EventTarget {
    constructor() { super(); this.closed = false; sockets.push(this); }
    open() { this.dispatchEvent(new Event('open')); }
    fail() { this.dispatchEvent(new Event('close')); }
    frame(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { this.closed = true; this.fail(); }
  }
  class Source extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; sources.push(this); }
    close() { this.readyState = 2; }
  }
  Object.assign(globalThis, { WebSocket: Socket, EventSource: Source, location: { href: 'http://localhost/' } });
  t.after(() => { globalThis.clearTimeout = clear; Object.assign(globalThis, saved); });
  return { sockets, sources, cleared };
}

test('S3/S4: open cancels deadlines, including slow reconnect; healthy WS survives 50s', t => {
  const { sockets, sources, cleared } = setup(t);
  const stream = new Current('/api/stream?client=widget');
  let opens = 0, errors = 0;
  stream.onopen = () => opens++;
  stream.onerror = () => errors++;
  const initial = stream.timer;
  sockets[0].open();
  assert.ok(cleared.includes(initial));
  t.mock.timers.tick(50000);
  assert.deepEqual([opens, errors, sockets.length, sources.length, stream.readyState], [1, 0, 1, 0, 1]);
  sockets[0].fail();
  assert.equal(errors, 1);
  t.mock.timers.tick(2000);
  assert.equal(sockets.length, 2);
  const deadline = stream.timer;
  t.mock.timers.tick(9999);
  assert.equal(sockets[1].closed, false);
  sockets[1].open();
  assert.ok(cleared.includes(deadline));
  t.mock.timers.tick(50000);
  assert.deepEqual([opens, errors, sockets.length, sources.length, stream.readyState], [2, 1, 2, 0, 1]);
  stream.close();
});

test('S3/S4: socket close and explicit close clear pending attempt and retry timers', t => {
  const { sockets, sources, cleared } = setup(t);
  const stream = new Current('/api/stream?client=panel');
  sockets[0].open(); sockets[0].fail();
  t.mock.timers.tick(2000);
  const firstDeadline = stream.timer;
  sockets[1].fail();
  assert.ok(cleared.includes(firstDeadline));
  t.mock.timers.tick(2000);
  const secondDeadline = stream.timer;
  stream.close();
  assert.ok(cleared.includes(secondDeadline));
  t.mock.timers.tick(30000);
  assert.deepEqual([sockets.length, sources.length, stream.readyState], [3, 0, 2]);
  const pending = new Current('/api/stream?client=overlay');
  sockets[3].open(); sockets[3].fail();
  const retry = pending.timer;
  pending.close();
  assert.ok(cleared.includes(retry));
  t.mock.timers.tick(30000);
  assert.deepEqual([sockets.length, sources.length, pending.readyState], [4, 0, 2]);
});

test('S3/S4: reconnect deadline uses max(retry, 10s), then retry; late events ignored', t => {
  const { sockets, sources } = setup(t);
  const stream = new Current('/api/stream?client=widget');
  let errors = 0, opens = 0, messages = 0;
  stream.onerror = () => errors++; stream.onopen = () => opens++;
  stream.onmessage = () => messages++;
  sockets[0].open(); sockets[0].frame('retry: 15000\n\n'); sockets[0].fail();
  t.mock.timers.tick(15000);
  t.mock.timers.tick(14999);
  assert.deepEqual([sockets.length, sockets[1].closed, errors], [2, false, 1]);
  t.mock.timers.tick(1);
  assert.deepEqual([sockets.length, sockets[1].closed, errors], [2, true, 2]);
  sockets[1].open(); sockets[1].frame('data: stale\n\n'); sockets[1].fail();
  t.mock.timers.tick(14999);
  assert.equal(sockets.length, 2);
  t.mock.timers.tick(1);
  sockets[2].open(); sockets[2].frame('data: fresh\n\n');
  assert.deepEqual([opens, errors, messages, sockets.length, sources.length], [2, 2, 1, 3, 0]);
  stream.close();
});

test('S3/S4: initial timeout and close-before-open preserve fallback', t => {
  const { sockets, sources, cleared } = setup(t);
  const observations = [];
  for (const Stream of [Current]) {
    const n = sockets.length, s = sources.length;
    const stream = new Stream('/api/stream?client=preview');
    let errors = 0; stream.onerror = () => errors++;
    t.mock.timers.tick(1999);
    const before = [stream.transport, sockets[n].closed, sources.length - s, errors];
    t.mock.timers.tick(1);
    const after = [stream.transport, sockets[n].closed, sources.length - s, errors, sources[s].url];
    sockets[n].open(); sockets[n].fail();
    observations.push([before, after, sources.length - s, stream.readyState]);
    stream.close();
    const closed = new Stream('/api/stream?client=preview');
    const deadline = closed.timer; closed.close();
    assert.ok(cleared.includes(deadline));
    t.mock.timers.tick(3000);
    assert.equal(sources.length - s, 1);
  }
  assert.deepEqual(observations[0], [ ['websocket', false, 0, 0], ['sse', true, 1, 1, '/api/stream?client=preview'], 1, 0 ]);
});
