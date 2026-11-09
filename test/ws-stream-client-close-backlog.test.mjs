// #67: a client close arriving while outbound data is still queued (peer not reading) closes
// the server socket promptly; the peer has left, so the pending data is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WsResponse } from '../src/ws-stream.mjs';
import { Bus } from '../src/bus.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));

test('client close with a blocked outbound queue closes promptly', { timeout: 4000 }, async t => {
  let socket, res, closes = 0; const bus = new Bus();
  const server = net.createServer(s => {
    socket = s; res = new WsResponse(s); bus.addClient(res, 'overlay');
    res.on('close', () => closes++);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const peer = net.connect({ host: '127.0.0.1', port: server.address().port, allowHalfOpen: true });
  peer.on('error', () => {});
  t.after(() => { peer.destroy(); socket?.destroy(); server.close(); });
  await once(peer, 'connect'); while (!res) await wait(1);
  peer.pause(); res.write('x'.repeat(8 * 1024 * 1024)); assert.ok(res.queuedBytes > 0);
  peer.write(Buffer.from([0x88, 0x82, 1, 2, 3, 4, 2, 234])); // masked close 1000
  await wait(1500);
  assert.equal(res.ended, true); assert.equal(socket.destroyed, true);
  assert.equal(bus.clients.size, 0); assert.equal(closes, 1);
});
