import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Bus } from '../src/bus.mjs';
import { WsResponse } from '../src/ws-stream.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
test('S4: a reading peer with pending backlog receives gap and close', { timeout: 10000 }, async t => {
  let socket, res;
  const server = net.createServer(s => { socket = s; res = new WsResponse(s); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const peer = net.connect(server.address().port, '127.0.0.1');
  peer.pause(); peer.on('error', () => {});
  t.after(() => { peer.destroy(); socket?.destroy(); server.close(); });
  await once(peer, 'connect'); while (!res) await wait(5);
  const bus = new Bus({ byteBudget: 1024, backlogGraceMs: 20, backlogStallMs: 40, backlogMaxMs: 100 });
  bus.addClient(res, 'widget');
  bus.send('chat', { text: 'x'.repeat(8 * 1024 * 1024) }, ['widget']);
  while (!res.writableEnded) await wait(5);
  assert.ok(res.writableLength > 0);
  let bytes = 0, tail = Buffer.alloc(0);
  const collect = c => { bytes += c.length; tail = Buffer.concat([tail, c]).subarray(-256); };
  for (let i = 0; i < 130; i++) { const c = peer.read(16384); if (c) collect(c); await wait(10); }
  assert.ok(bytes > 128 * 1024);
  assert.equal(socket.destroyed, false, 'do not cut an active reader before its gap');
  const ended = once(peer, 'end'); peer.on('data', collect); peer.resume(); await ended;
  assert.ok(tail.includes('event: gap\n'));
  assert.deepEqual(tail.subarray(-4), Buffer.from([0x88, 2, 3, 0xe8]));
});
