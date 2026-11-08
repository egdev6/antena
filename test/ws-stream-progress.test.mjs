// #67: after the bus cuts a WebSocket client (gap + close), a peer that is still reading
// must not be destroyed before it receives the rest, including the gap frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WsResponse } from '../src/ws-stream.mjs';
import { Bus } from '../src/bus.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('active slow reader is not destroyed while the bus gap drains', { timeout: 6000 }, async t => {
  let socket, res;
  const server = net.createServer(s => { socket = s; res = new WsResponse(s); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const peer = net.connect(server.address().port, '127.0.0.1');
  t.after(() => { peer.destroy(); socket?.destroy(); server.close(); });
  await once(peer, 'connect');
  while (!res) await delay(1);
  const bus = new Bus({ byteBudget: 1024, backlogGraceMs: 20, backlogStallMs: 40, backlogMaxMs: 100 });
  bus.addClient(res, 'widget'); socket.cork();
  bus.send('widgets', { text: 'x'.repeat(64 * 1024) }, ['widget']);
  for (let i = 0; i < 200 && !res.writableEnded; i++) await delay(5);
  assert.equal(res.writableEnded, true);
  socket.uncork(); let received = 0, reads = 0;
  for (let i = 0; i < 50; i++) {
    const chunk = peer.read(512);
    if (chunk) { received += chunk.length; reads++; }
    await delay(25);
  }
  assert.ok(received > 0 && received < 64 * 1024 && reads > 5);
  assert.equal(socket.destroyed, false, 'do not cut a progressing reader');
});
