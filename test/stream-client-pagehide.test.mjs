// #67: a page entering the back/forward cache keeps no WebSocket open (the server would keep
// counting it as a live layer); when it is restored the stream reconnects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AntenaStream } from '../public/stream-client.js';

test('pagehide closes the socket; pageshow from bfcache reconnects', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = { WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, location: globalThis.location, addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener };
  const page = new EventTarget();
  const sockets = [];
  class Socket extends EventTarget {
    constructor() { super(); this.closed = false; sockets.push(this); }
    open() { this.dispatchEvent(new Event('open')); }
    frame(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
  }
  let fallback = 0;
  Object.assign(globalThis, {
    WebSocket: Socket, EventSource: class { constructor() { fallback++; } }, location: { href: 'http://localhost/' },
    addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page),
  });
  const stream = new AntenaStream('/api/stream?client=overlay');
  t.after(() => { stream.close(); Object.assign(globalThis, saved); });
  const messages = []; let opens = 0, errors = 0;
  stream.onopen = () => opens++;
  stream.onerror = () => errors++;
  stream.addEventListener('pause', e => messages.push(e.data));
  sockets[0].open();
  page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
  assert.equal(sockets[0].closed, true, 'pagehide closes the socket');
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, 1, 'no reconnect while the page is hidden');
  assert.equal(errors, 0, 'hiding the page is not an error');
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(sockets.length, 2, 'pageshow from bfcache reconnects');
  sockets[1].open(); sockets[1].frame('event: pause\ndata: {"paused":false}\n\n');
  assert.equal(opens, 2);
  assert.deepEqual(messages, ['{"paused":false}']);
  assert.equal(fallback, 0);
  stream.close();
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(sockets.length, 2, 'a closed stream does not reconnect on pageshow');
});
