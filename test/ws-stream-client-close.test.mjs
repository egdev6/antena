// #67: when the browser sends a close frame and waits (as RFC 6455 lets clients do) for the
// server to close the TCP connection, the server echoes the close and closes the socket at
// once, so a navigated-away page leaves no client registered and shutdown never waits on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WsResponse } from '../src/ws-stream.mjs';
import { Bus } from '../src/bus.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a client close frame closes the server socket promptly and removes the bus client', { timeout: 5000 }, async t => {
  let socket, res;
  const server = net.createServer(s => { socket = s; res = new WsResponse(s); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const peer = net.connect({ port: server.address().port, host: '127.0.0.1', allowHalfOpen: true });
  peer.on('error', () => {});
  t.after(() => { peer.destroy(); socket?.destroy(); server.close(); });
  await once(peer, 'connect');
  while (!res) await wait(1);
  const bus = new Bus();
  bus.addClient(res, 'overlay');
  let closes = 0; res.on('close', () => closes++);
  const received = [];
  peer.on('data', chunk => received.push(chunk));
  // Masked close frame, code 1001 (going away); the peer keeps its side of TCP open.
  const mask = [1, 2, 3, 4], payload = [0x03, 0xe9];
  peer.write(Buffer.from([0x88, 0x80 | payload.length, ...mask, ...payload.map((b, i) => b ^ mask[i % 4])]));
  const started = Date.now();
  while (!socket.destroyed && Date.now() - started < 1000) await wait(10);
  assert.equal(socket.destroyed, true, 'server closes TCP after echoing the close');
  assert.ok(Date.now() - started < 1000);
  assert.equal(closes, 1);
  assert.equal(bus.clients.size, 0);
  const bytes = Buffer.concat(received);
  assert.deepEqual(bytes.subarray(-4), Buffer.from([0x88, 2, 0x03, 0xe9]), 'close frame echoed');
});
