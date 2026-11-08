// #57 second independent verification: progress must be what the peer consumed, not what Node
// queued (socket.bytesWritten alone counts queued bytes and HTTP framing), and the yielded
// I/O turn must not cut a fresh crossing or act on a closed client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Bus } from '../src/bus.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = b => b.send('chat', { text: 'x'.repeat(100 * 1024) });

async function socketFixture(t, bus) {
  let response, gap = null, drains = 0, gapAt = 0;
  const writes = [], drainTimes = [];
  const server = http.createServer((req, res) => {
    response = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('retry: 2000\n\n');
    res.on('drain', () => { drains++; drainTimes.push(performance.now()); }); // before the bus resumes
    const write = res.write.bind(res);
    res.write = (chunk, ...args) => {
      if (String(chunk).startsWith('event: gap\n')) { gap = JSON.parse(String(chunk).split('data: ')[1]); gapAt = performance.now(); }
      const ok = write(chunk, ...args);
      writes.push({ chunk: String(chunk), drains, ok });
      return ok;
    };
    bus.addClient(res, 'panel');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const reader = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port }, resolve);
    req.on('error', reject);
  });
  reader.on('error', () => {});
  t.after(() => { reader.destroy(); server.closeAllConnections(); server.close(); });
  return { response, reader, writes, drainTimes, get drains() { return drains; }, get gap() { return gap; }, get gapAt() { return gapAt; } };
}

for (const kind of ['chat', 'ping']) {
  test('a real non-reader remains stalled despite a queued ' + kind, { timeout: 3000 }, async t => {
    const b = new Bus({ byteBudget: 1000, backlogGraceMs: 200, backlogMaxMs: 2000 });
    const f = await socketFixture(t, b); f.reader.pause(); f.response.socket.cork();
    send(b);
    const before = { written: f.response.socket.bytesWritten, backlog: f.response.writableLength };
    await delay(40);
    assert.equal(f.gap, null, 'the grace has not expired');
    if (kind === 'chat') {
      send(b);
      assert.equal(f.response.socket.bytesWritten, before.written, 'blocked chat stays in the bus queue');
      assert.equal(f.response.writableLength, before.backlog, 'the bus does not write again before drain');
    } else {
      f.response.write(': ping\n\n');
      assert.ok(f.response.socket.bytesWritten > before.written, 'Node counts externally queued ping bytes');
      assert.ok(f.response.writableLength > before.backlog, 'the corked ping has not flushed');
    }
    await delay(220);
    assert.equal(f.gap?.cause, 'stalled', 'newly queued bytes are not reader progress');
  });
}

test('a real slow reader is not cut while consuming an oversized burst', { timeout: 5000 }, async t => {
  const b = new Bus(); const f = await socketFixture(t, b); let received = 0;
  const start = performance.now();
  f.reader.on('data', chunk => { received += chunk.length; f.reader.pause(); setTimeout(() => f.reader.resume(), 30); });
  for (let i = 0; i < 200; i++) b.send('chat', { id: i, text: 'x'.repeat(30 * 1024) });
  assert.ok(f.response.writableLength > 0, 'the burst met real backpressure');
  await delay(350);
  assert.ok(received >= 64 * 1024, 'the peer consumed real socket data');
  assert.equal(f.gap, null, `a reading peer must not be called stalled (received=${received}, writes=${f.writes.length}, drains=${f.drainTimes.map(n => Math.round(n - start))}, gap=${Math.round(f.gapAt - start)}ms)`);
});

test('a real reader receives an ordered burst through multiple drain-driven writes', { timeout: 5000 }, async t => {
  const b = new Bus(); const f = await socketFixture(t, b);
  const total = 100, text = 'z'.repeat(30 * 1024), received = [];
  let pending = '', finish;
  const complete = new Promise(resolve => { finish = resolve; });
  f.reader.setEncoding('utf8');
  f.reader.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end); pending = pending.slice(end + 2);
      if (frame.startsWith('event: chat\n')) received.push(JSON.parse(frame.split('data: ')[1]));
    }
    if (received.length >= total) finish();
  });
  for (let id = 0; id < total; id++) b.send('chat', { id, text });
  assert.ok(f.writes.length < total, 'the first false write blocks the rest of the burst');
  assert.equal(f.writes.at(-1).ok, false);
  assert.ok(f.writes.slice(0, -1).every(write => write.ok), 'no further writes after false');
  let guard;
  try {
    await Promise.race([complete, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('burst did not arrive')), 4000); })]);
  } finally { clearTimeout(guard); }
  assert.equal(f.gap, null);
  assert.deepEqual(received, Array.from({ length: total }, (_, id) => ({ id, text })));
  assert.equal(f.writes.length, total);
  assert.ok(f.drains > 2, 'real progress is visible as several drain events');
  for (let i = 1; i < f.writes.length; i++) {
    if (!f.writes[i - 1].ok) {
      assert.ok(f.writes[i].drains > f.writes[i - 1].drains, 'each blocked write waits for another drain');
    }
  }
});

class Sink extends EventEmitter {
  bytes = 0; socket = { bytesWritten: 0, writableLength: 0 }; ended = false; ends = 0; chunks = []; framingBytes = 0;
  get writableLength() { return this.bytes; }
  write(chunk) { const n = Buffer.byteLength(chunk) + this.framingBytes; this.bytes += n; this.socket.bytesWritten += n; this.socket.writableLength += n; this.chunks.push(chunk); return false; }
  end() { this.ended = true; this.ends++; }
  drain() { this.bytes = 0; this.socket.writableLength = 0; this.emit('drain'); }
}
function timers(t) {
  const timeouts = [], immediates = [];
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { timeouts.push({ fn, ms }); return {}; });
  t.mock.method(globalThis, 'setImmediate', fn => { immediates.push(fn); return {}; });
  return { timeouts, immediates };
}

for (const restart of ['send', 'flush']) {
  test('a fresh ' + restart + ' during the yielded I/O turn gets a fresh window', t => {
    const q = timers(t); let now = 0;
    const b = new Bus({ byteBudget: 1000, backlogGraceMs: 100, now: () => now });
    const sink = new Sink(); b.addClient(sink, 'panel'); send(b);
    // A retained snapshot counts in the budget. HTTP framing makes this small one cross on flush.
    if (restart === 'flush') b.send('status', { text: 'x'.repeat(800) });
    now = 100; q.timeouts.shift().fn(); assert.equal(q.immediates.length, 1);
    if (restart === 'flush') sink.framingBytes = 300;
    sink.drain(); if (restart === 'send') send(b);
    assert.ok(sink.bytes > 1000); assert.equal(q.timeouts.length, 1);
    q.immediates.shift()();
    assert.equal(sink.ended, false, 'old immediate must not cut a new crossing at age 0ms');
  });
}

test('close between a grace check and its immediate cannot write or rearm', t => {
  const q = timers(t); let now = 0;
  const b = new Bus({ byteBudget: 1000, now: () => now }); const sink = new Sink();
  b.addClient(sink, 'panel'); send(b); now = 100; q.timeouts.shift().fn();
  assert.equal(q.immediates.length, 1); const count = sink.chunks.length;
  sink.emit('close'); q.immediates.shift()();
  assert.equal(sink.chunks.length, count); assert.equal(sink.ends, 0); assert.equal(q.timeouts.length, 0);
});
