import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url = url; this.closed = false; FakeSocket.instances.push(this); }
  open() { this.dispatchEvent(new Event('open')); }
  frame(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
  fail() { this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('close')); }
  close() { this.closed = true; }
}
class FakeSource extends EventTarget {
  static instances = [];
  constructor(url) { super(); this.url = url; this.readyState = 0; this.closed = false; FakeSource.instances.push(this); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(type, data) { this.dispatchEvent(new MessageEvent(type, { data })); }
  close() { this.closed = true; this.readyState = 2; }
}
async function setup(t, WebSocket = FakeSocket, protocol = 'http:') {
  FakeSocket.instances = []; FakeSource.instances = [];
  const saved = { WebSocket: globalThis.WebSocket, EventSource: globalThis.EventSource, location: globalThis.location };
  Object.assign(globalThis, { WebSocket, EventSource: FakeSource, location: { protocol, host: 'localhost:4500' } });
  t.after(() => Object.assign(globalThis, saved));
  const { AntenaStream } = await import('../public/stream-client.js');
  return AntenaStream;
}

test('S5: SSE frames dispatch named and default MessageEvents with multiline data; comments and id are ignored', async t => {
  const Stream = await setup(t);
  const stream = new Stream('/api/stream?client=widget&themeDraft=1');
  t.after(() => stream.close());
  const ws = FakeSocket.instances[0];
  assert.equal(ws.url, 'ws://localhost:4500/api/stream?client=widget&themeDraft=1');
  const named = [], messages = [], onmessages = [], gaps = [];
  stream.addEventListener('gap', e => gaps.push(JSON.parse(e.data)));
  stream.addEventListener('status', e => named.push([e instanceof MessageEvent, e.data]));
  stream.addEventListener('message', e => messages.push(e.data));
  stream.onmessage = e => onmessages.push(e.data);
  ws.open();
  ws.frame(': ping\n\nretry: 8\n\nid: ignored\nevent: status\ndata: one\ndata:  two\n\ndata: default\n\ndata:\n\n');
  assert.deepEqual(named, [[true, 'one\n two']]);
  assert.deepEqual(messages, ['default', '']);
  assert.deepEqual(onmessages, messages);
  ws.frame('event: status\r\ndata: crlf\r\n\r\n');
  assert.deepEqual(named.at(-1), [true, 'crlf']);
  ws.frame('event: gap\ndata: {"reason":"slow-client","droppedEphemeral":2}\n\n');
  assert.deepEqual(gaps, [{ reason: 'slow-client', droppedEphemeral: 2 }]);
});

test('S4: open fires again on reconnect using retry delay; close cancels pending reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Stream = await setup(t, FakeSocket, 'https:');
  const stream = new Stream('/api/stream?client=panel&key=a%2Bb');
  t.after(() => stream.close());
  const ws = FakeSocket.instances[0];
  assert.equal(ws.url, 'wss://localhost:4500/api/stream?client=panel&key=a%2Bb');
  assert.equal(stream.readyState, 0);
  let opens = 0, errors = 0;
  stream.onopen = () => opens++;
  stream.onerror = () => errors++;
  ws.open();
  assert.equal(stream.readyState, 1);
  ws.frame('retry: 37\n\n');
  ws.frame('retry: invalid\n\n');
  ws.fail();
  assert.equal(stream.readyState, 0);
  assert.equal(errors, 1);
  t.mock.timers.tick(36);
  assert.equal(FakeSocket.instances.length, 1);
  t.mock.timers.tick(1);
  assert.equal(FakeSocket.instances.length, 2);
  FakeSocket.instances[1].open();
  assert.equal(opens, 2);
  FakeSocket.instances[1].fail();
  stream.close();
  assert.equal(stream.readyState, 2);
  t.mock.timers.tick(100);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(FakeSource.instances.length, 0, 'after a successful open, reconnect over WebSocket');
});

test('S4: default reconnect delay is 2000 ms; close while connecting stops it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Stream = await setup(t);
  const stream = new Stream('/api/stream?client=overlay');
  const ws = FakeSocket.instances[0];
  ws.open(); ws.fail();
  t.mock.timers.tick(1999);
  assert.equal(FakeSocket.instances.length, 1);
  t.mock.timers.tick(1);
  const reconnect = FakeSocket.instances[1];
  assert.ok(reconnect);
  stream.close();
  assert.equal(reconnect.closed, true);
  reconnect.fail();
  t.mock.timers.tick(5000);
  assert.equal(FakeSocket.instances.length, 2);
  assert.equal(FakeSource.instances.length, 0);
});

test('S4: a stalled initial WebSocket upgrade falls back once and ignores late socket events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Stream = await setup(t);
  const stream = new Stream('/api/stream?client=preview');
  t.after(() => stream.close());
  const ws = FakeSocket.instances[0];
  let opens = 0, errors = 0;
  stream.onopen = () => opens++;
  stream.onerror = () => errors++;
  t.mock.timers.tick(1999);
  assert.equal(stream.transport, 'websocket');
  assert.equal(FakeSource.instances.length, 0);
  t.mock.timers.tick(1);
  assert.equal(stream.transport, 'sse');
  assert.equal(ws.closed, true);
  assert.equal(FakeSource.instances.length, 1);
  ws.open(); ws.fail();
  assert.equal(opens, 0);
  assert.equal(FakeSource.instances.length, 1);
  FakeSource.instances[0].open();
  assert.equal(stream.readyState, 1);
  assert.equal(opens, 1);
  assert.equal(errors, 1);
});

test('S4: initial upgrade deadline is cancelled by an open or explicit close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const Stream = await setup(t);
  const connected = new Stream('/api/stream?client=overlay');
  FakeSocket.instances[0].open();
  t.mock.timers.tick(2000);
  assert.equal(connected.transport, 'websocket');
  assert.equal(connected.readyState, 1);
  assert.equal(FakeSource.instances.length, 0);
  connected.close();
  const cancelled = new Stream('/api/stream?client=widget');
  cancelled.close();
  t.mock.timers.tick(2000);
  assert.equal(cancelled.readyState, 2);
  assert.equal(FakeSource.instances.length, 0);
});

for (const mode of ['unavailable', 'throws', 'fails before open']) {
  test(`S4: ${mode} falls back to native SSE with original URL and listeners`, async t => {
    const Socket = mode === 'unavailable' ? null : mode === 'throws' ? class { constructor() { throw Error('unavailable'); } } : FakeSocket;
    const Stream = await setup(t, Socket);
    const url = '/api/stream?client=panel&themeDraft=1&key=a%2Bb';
    const stream = new Stream(url);
    t.after(() => stream.close());
    const events = [];
    stream.addEventListener('status', e => events.push(['status', e.data]));
    stream.addEventListener('message', e => events.push(['message', e.data]));
    stream.onmessage = e => events.push(['onmessage', e.data]);
    stream.onopen = () => events.push(['open']);
    if (mode === 'fails before open') FakeSocket.instances[0].fail();
    assert.equal(FakeSource.instances.length, 1);
    const source = FakeSource.instances[0];
    assert.equal(source.url, url);
    source.open();
    source.message('status', '{"ok":true}');
    source.message('message', 'hello');
    assert.equal(stream.readyState, 1);
    assert.deepEqual(events, [['open'], ['status', '{"ok":true}'], ['message', 'hello'], ['onmessage', 'hello']]);
    let late = 0;
    const listener = () => late++;
    stream.addEventListener('theme', listener);
    source.message('theme', '{}');
    stream.removeEventListener('theme', listener);
    source.message('theme', '{}');
    assert.equal(late, 1, 'listeners added after fallback are removable');
    stream.close();
    assert.equal(stream.readyState, 2);
    assert.equal(source.closed, true);
  });
}
