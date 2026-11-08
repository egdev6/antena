// #57 independent regressions: only drain is progress, a fresh crossing restarts the cap,
// the cap uses a monotonic clock, and blocked event loops get an I/O turn before a stall cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Bus } from '../src/bus.mjs';

class Sink extends EventEmitter {
  bytes = 0; chunks = []; ended = false; ends = 0; framingBytes = 0;
  get writableLength() { return this.bytes; }
  write(chunk) { assert.equal(this.ended, false); this.chunks.push(chunk); this.bytes += Buffer.byteLength(chunk) + this.framingBytes; return false; }
  end() { this.ended = true; this.ends++; }
  consume(n) { this.bytes = Math.max(0, this.bytes - n); }
  drain() { this.consume(this.bytes); this.emit('drain'); }
  gaps() { return this.chunks.filter(c => c.startsWith('event: gap\n')).map(c => JSON.parse(c.slice(c.indexOf('data: ') + 6))); }
}
const clock = t => t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate', 'Date'], now: 1_700_000_000_000 });
const bus = opts => new Bus({ now: () => Date.now(), ...opts });
const send = b => b.send('chat', { text: 'á'.repeat(800) });
const window = (t, ms = 100) => { t.mock.timers.tick(ms); t.mock.timers.tick(0); };

test('drain progress with new UTF-8 writes times out once at the cap', t => {
  clock(t); const b = bus({ byteBudget: 1000, backlogGraceMs: 100, backlogMaxMs: 400 });
  const s = new Sink(); b.addClient(s, 'panel'); send(b); send(b);
  for (let i = 0; i < 3; i++) { s.drain(); send(b); window(t); assert.equal(s.ended, false); }
  s.drain(); send(b); window(t);
  assert.deepEqual(s.gaps(), [{ reason: 'slow-client', kind: 'panel', droppedEphemeral: 6, cause: 'backlog-timeout' }]);
  const count = s.chunks.length; b.send('chat', {}); s.emit('drain'); window(t, 1000);
  assert.equal(s.chunks.length, count); assert.equal(s.ends, 1);
});

test('a stalled reader is cut once after exactly one window and the loss count is exact', t => {
  clock(t); const b = bus({ byteBudget: 1000, backlogGraceMs: 100 }); const s = new Sink(); b.addClient(s, 'overlay');
  b.send('chat', { text: 'small' }); for (let i = 0; i < 3; i++) send(b);
  t.mock.timers.tick(99); assert.equal(s.ended, false); window(t, 1);
  assert.deepEqual(s.gaps(), [{ reason: 'slow-client', kind: 'overlay', droppedEphemeral: 3, cause: 'stalled' }]);
  const count = s.chunks.length; b.send('chat', {}); s.emit('drain'); window(t, 1000);
  assert.equal(s.chunks.length, count); assert.equal(s.ends, 1);
});

test('a direct keepalive write cannot conceal drain progress', t => {
  clock(t); const b = bus({ byteBudget: 1000, backlogGraceMs: 100 }); const s = new Sink(); b.addClient(s, 'panel');
  send(b); send(b); s.drain(); s.write(': ping\n\n'); window(t);
  assert.equal(s.ended, false, 'the reader drained even though the server wrote a ping');
});

test('a direct keepalive write cannot fake drain progress', t => {
  clock(t); const b = bus({ byteBudget: 1000, backlogGraceMs: 100 }); const s = new Sink(); b.addClient(s, 'panel');
  send(b); s.write(': ping\n\n'); window(t);
  assert.equal(s.ended, true);
  assert.equal(s.gaps()[0].cause, 'stalled');
});

for (const restart of ['drain then send', 'drain then flush', 'dip then send']) {
  test('a new budget crossing starts a fresh cap: ' + restart, t => {
    clock(t); const b = bus({ byteBudget: 1000, backlogGraceMs: 100, backlogMaxMs: 300 }); const s = new Sink(); b.addClient(s, 'panel');
    send(b); send(b); send(b);
    // The pending snapshot is below budget; simulated HTTP framing makes its flush cross it.
    if (restart === 'drain then flush') b.send('status', { text: 'x'.repeat(850) });
    for (let i = 0; i < 2; i++) { s.drain(); window(t); }
    t.mock.timers.tick(99);
    if (restart === 'drain then flush') s.framingBytes = 200;
    if (restart === 'dip then send') s.consume(s.bytes); else s.drain();
    if (restart !== 'drain then flush') send(b);
    window(t, 1);
    assert.equal(s.ended, false, 'new backlog has been over budget for only 1ms');
    window(t, 99);
    assert.equal(s.ended, true, 'progress in the old episode cannot extend the new grace');
    assert.equal(s.gaps()[0].cause, 'stalled');
    assert.equal(s.ends, 1);
  });
}

test('wall-clock rollback does not extend the continuous backlog cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] }); let wall = 10_000_000, elapsed = 0;
  t.mock.method(Date, 'now', () => wall); t.mock.method(performance, 'now', () => elapsed);
  const b = new Bus({ byteBudget: 1000, backlogGraceMs: 100, backlogMaxMs: 300 }); const s = new Sink(); b.addClient(s, 'panel'); send(b); send(b);
  const advance = () => { s.drain(); send(b); wall += 100; elapsed += 100; window(t); };
  advance(); advance(); wall -= 3_600_000;
  for (let i = 0; i < 10 && !s.ended; i++) advance();
  assert.equal(s.ended, true, 'continuous backlog exceeded the monotonic cap');
  assert.equal(s.gaps()[0].cause, 'backlog-timeout');
});

test('a real active reader survives when a burst delays the event loop', { timeout: 5000 }, async t => {
  const b = new Bus(); let response, ended = false;
  const server = http.createServer((req, res) => {
    response = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); b.addClient(res, 'panel');
    const end = res.end.bind(res); res.end = (...args) => { ended = true; return end(...args); };
    res.write('retry: 2000\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const reader = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port }, resolve); req.on('error', reject);
  });
  reader.on('data', () => {}); t.after(() => reader.destroy());
  for (let i = 0; i < 200; i++) b.send('chat', { id: i, text: 'x'.repeat(30 * 1024) });
  assert.ok(response.writableLength > 0, 'the burst encountered real backpressure');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ended, false, 'the event loop must give a reading socket an opportunity to progress');
});
