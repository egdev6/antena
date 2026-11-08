import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Bus } from '../src/bus.mjs';
import { createApp } from '../src/server.mjs';
import { WsResponse } from '../src/ws-stream.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('timed out'); await wait(5); }
}

// Adaptado del probe independiente: se exige progreso real y entrega antes del límite L9.
async function slowReader(t, bytesPerRead, intervalMs, durationMs, allowStall = false) {
  let socket, res, completed = 0, lastCompletedAt = 0, finishedAt = 0, closedAt = 0, gap;
  const server = net.createServer(s => {
    socket = s; const write = s.write.bind(s);
    s.on('close', () => { closedAt = performance.now(); });
    s.write = (chunk, cb) => write(chunk, error => { if (!error) { completed++; lastCompletedAt = performance.now(); } cb(error); });
    res = new WsResponse(s);
    const end = res.end.bind(res), send = res.write.bind(res);
    res.end = () => { finishedAt = performance.now(); return end(); };
    res.write = text => { if (text.startsWith('event: gap\n')) gap = text; return send(text); };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const peer = net.connect(server.address().port, '127.0.0.1'); peer.pause(); peer.on('error', () => {});
  t.after(() => { peer.destroy(); socket?.destroy(); server.close(); });
  await once(peer, 'connect'); await until(() => !!res);
  const bus = new Bus({ byteBudget: 1024, backlogGraceMs: 20, backlogStallMs: 40, backlogMaxMs: 100 });
  const data = { text: 'x'.repeat(8 * 1024 * 1024) };
  bus.addClient(res, 'widget'); bus.send('chat', data, ['widget']);
  await until(() => res.writableEnded); assert.ok(res.writableLength > 0);
  const atCut = completed, chunks = []; let received = 0;
  const start = Date.now();
  while (Date.now() - start < durationMs && !socket.destroyed) {
    const chunk = peer.read(bytesPerRead); if (chunk) { chunks.push(chunk); received += chunk.length; }
    await wait(intervalMs);
  }
  assert.ok(received > 128 * 1024);
  assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'slow-client');
  // Un lector de 1 KiB puede agotar la gracia si el kernel no completa ningún chunk:
  // L9 permite ese corte incluso mientras la aplicación sigue leyendo.
  if (socket.destroyed && allowStall) {
    await until(() => closedAt > 0); const stalledMs = closedAt - Math.max(finishedAt, lastCompletedAt);
    assert.ok(stalledMs >= 4900 && stalledMs < 6500, `no chunk completed for ${stalledMs} ms`);
    assert.equal(bus.clients.size, 0); return;
  }
  assert.ok(completed > atCut, 'chunks complete while the peer reads');
  // The socket may already be closed because delivery finished normally; the frame check
  // below proves the reader was not cut before receiving the data, the gap and the close.
  for (let c; (c = peer.read()) !== null;) chunks.push(c);
  if (!peer.readableEnded) { const ended = once(peer, 'end'); peer.on('data', chunk => chunks.push(chunk)); peer.resume(); await ended; }
  const bytes = Buffer.concat(chunks); let offset = 0; const frames = [];
  while (offset < bytes.length) {
    const op = bytes[offset++] & 15; let length = bytes[offset++] & 127;
    if (length === 126) { length = bytes.readUInt16BE(offset); offset += 2; }
    else if (length === 127) { length = Number(bytes.readBigUInt64BE(offset)); offset += 8; }
    assert.ok(offset + length <= bytes.length, 'no truncated frame');
    frames.push([op, bytes.subarray(offset, offset + length)]); offset += length;
  }
  assert.deepEqual(frames.map(([op]) => op), [1, 1, 8]);
  assert.equal(frames[0][1].toString(), `event: chat\ndata: ${JSON.stringify(data)}\n\n`);
  assert.equal(JSON.parse(frames[1][1].toString().split('data: ')[1]).reason, 'slow-client');
  assert.deepEqual(frames[2][1], Buffer.from([3, 232]));
}
// The steady reader drains the whole 8 MiB, so chunks complete whatever the kernel buffer
// size is (a slower reader can stay inside a large loopback buffer and see no completion).
test('S4: a steady reader with pending data receives the complete data, gap and close', { timeout: 12000 }, t => slowReader(t, 65536, 20, 4000));
test('S4: a 1 KiB/25 ms reader follows the bounded stall policy', { timeout: 15000 }, t => slowReader(t, 1024, 25, 7000, true));

class Socket extends EventEmitter {
  writableLength = 0; writableEnded = false; destroyed = false; callbacks = [];
  write(bytes, cb) { this.writableLength += bytes.length; this.callbacks.push(cb); return false; }
  step() { const cb = this.callbacks.shift(); assert.ok(cb); this.writableLength = 0; this.emit('drain'); cb(); }
  end(cb) { this.writableEnded = true; if (typeof cb === 'function') cb(); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
function clock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const original = Object.getOwnPropertyDescriptor(performance, 'now'); let now = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
  t.after(() => { if (original) Object.defineProperty(performance, 'now', original); else delete performance.now; });
  return ms => { now += ms; t.mock.timers.tick(ms); };
}

// Adaptado del probe de cap: L9 mide el límite desde finish, incluso con progreso continuo.
test('stalled peer closes 200 ms after its last completed chunk', t => {
  const advance = clock(t), socket = new Socket(); t.after(() => socket.destroy());
  const res = new WsResponse(socket, Buffer.alloc(0), { closeStallMs: 200, closeMaxMs: 1000 });
  let closes = 0; res.on('close', () => closes++);
  res.write('x'.repeat(256 * 1024)); res.end(); advance(100); socket.step();
  advance(199); assert.equal(socket.destroyed, false);
  advance(1); assert.equal(socket.destroyed, true); assert.equal(closes, 1);
});

test('total cap closes a still-progressing peer 500 ms after finish', t => {
  const advance = clock(t), socket = new Socket(); t.after(() => socket.destroy());
  const res = new WsResponse(socket, Buffer.alloc(0), { closeStallMs: 200, closeMaxMs: 500 });
  let closes = 0; res.on('close', () => closes++);
  res.write('x'.repeat(1024 * 1024)); res.end();
  for (let i = 0; i < 6; i++) { advance(80); socket.step(); assert.equal(socket.destroyed, false); }
  assert.ok(res.writableLength > 0); advance(19); assert.equal(socket.destroyed, false);
  advance(1); assert.equal(socket.destroyed, true); assert.equal(closes, 1);
});

test('total cap also bounds an idle peer after close is handed to the kernel', t => {
  const advance = clock(t), socket = new Socket(); t.after(() => socket.destroy());
  const res = new WsResponse(socket, Buffer.alloc(0), { closeStallMs: 200, closeMaxMs: 500 });
  res.end(); socket.step(); assert.equal(socket.writableEnded, true); assert.equal(res.writableLength, 0);
  advance(499); assert.equal(socket.destroyed, false);
  advance(1); assert.equal(socket.destroyed, true);
});

function maskedPing(payload) {
  const mask = Buffer.from([1, 2, 3, 4]), frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x89; frame[1] = 0x80 | payload.length; mask.copy(frame, 2);
  for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
  return frame;
}

// Adaptado del probe de endpoint: L9 coalesce pongs, no exige cortar una conexión sana.
test('10,000 pings keep at most one queued pong and preserve the latest payload', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-pong-l9-'));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  let serverSocket; app.server.on('connection', socket => { serverSocket = socket; });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, peer = net.connect(port, '127.0.0.1'); peer.on('error', () => {});
  t.after(async () => { peer.destroy(); await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  let buffer = Buffer.alloc(0), handshake = false; const frames = [];
  peer.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshake) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString(), /^HTTP\/1\.1 101/);
      buffer = buffer.subarray(end + 4); handshake = true;
    }
    while (buffer.length >= 2) {
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + length) return;
      frames.push({ opcode: buffer[0] & 15, payload: buffer.subarray(offset, offset + length) });
      buffer = buffer.subarray(offset + length);
    }
  });
  await once(peer, 'connect');
  peer.write(`GET /api/stream?client=widget HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await until(() => handshake && frames.filter(frame => frame.opcode === 1).length >= 6);
  const response = [...app.bus.clients][0].res;
  await until(() => response.writableLength === 0 && !response.writing);
  peer.pause(); let received = 0, peak = 0;
  serverSocket.on('data', chunk => { received += chunk.length; peak = Math.max(peak, response.writableLength); });
  const last = Buffer.from('last-ping');
  const input = Buffer.concat(Array.from({ length: 10000 }, (_, i) => maskedPing(i === 9999 ? last : Buffer.alloc(i % 2 ? 125 : 1, i % 256))));
  await new Promise((resolve, reject) => peer.write(input, error => error ? reject(error) : resolve()));
  await until(() => received === input.length);
  assert.ok(peak <= 254, `at most one in-flight and one queued pong: ${peak}`);
  assert.equal(app.bus.clients.size, 1); assert.equal(serverSocket.destroyed, false);
  peer.resume(); app.bus.send('chat', { text: 'healthy' }, ['widget']);
  await until(() => frames.some(frame => frame.opcode === 10 && frame.payload.equals(last)) &&
    frames.some(frame => frame.opcode === 1 && frame.payload.toString().includes('event: chat\n')));
});
