import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.mjs';

const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await delay(10); }
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-ws-'));
  const app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), log: () => {} });
  const sockets = new Set();
  app.server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.closeHttp(); for (const socket of sockets) socket.destroy(); await rm(root, { recursive: true, force: true }); });
  return { app, port: app.server.address().port, sockets };
}
function clientFrame(opcode, payload = '', masked = true) {
  const data = Buffer.from(payload), mask = Buffer.from([1, 2, 3, 4]);
  const extra = data.length < 126 ? 0 : 2;
  const frame = Buffer.alloc(2 + extra + (masked ? 4 : 0) + data.length);
  frame[0] = 0x80 | opcode;
  frame[1] = (masked ? 0x80 : 0) | (extra ? 126 : data.length);
  if (extra) frame.writeUInt16BE(data.length, 2);
  const start = 2 + extra;
  if (masked) mask.copy(frame, start);
  for (let i = 0; i < data.length; i++) frame[start + (masked ? 4 : 0) + i] = data[i] ^ (masked ? mask[i % 4] : 0);
  return frame;
}
async function connect(port, { target = '/api/stream?client=widget', headers = {}, method = 'GET', head } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', resolve));
  const all = { host: `127.0.0.1:${port}`, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': KEY, ...headers };
  const request = `${method} ${target} HTTP/1.1\r\n${Object.entries(all).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
  let buffer = Buffer.alloc(0), handshake, frameWaiters = [], frames = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('handshake timeout')); }, 5000);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    handshake = bytes => {
      const end = bytes.indexOf('\r\n\r\n');
      if (end < 0) return false;
      const lines = bytes.subarray(0, end).toString().split('\r\n');
      const status = Number(lines.shift().split(' ')[1]);
      const responseHeaders = Object.fromEntries(lines.map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]; }));
      buffer = bytes.subarray(end + 4);
      clearTimeout(timer); resolve({ status, headers: responseHeaders });
      return true;
    };
  });
  function parse() {
    while (buffer.length >= 2) {
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + length) return;
      const frame = { opcode: buffer[0] & 15, fin: !!(buffer[0] & 128), masked: !!(buffer[1] & 128), data: buffer.subarray(offset, offset + length) };
      buffer = buffer.subarray(offset + length);
      if (frameWaiters.length) frameWaiters.shift()(frame); else frames.push(frame);
    }
  }
  let connected = false;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!connected) { if (!handshake(buffer)) return; connected = true; }
    parse();
  });
  socket.write(head ? Buffer.concat([Buffer.from(request), head]) : request);
  const response = await ready;
  if (response.status !== 101) socket.destroy();
  return {
    ...response, socket, closed,
    async next() {
      if (frames.length) return frames.shift();
      let timer, waiter;
      try {
        return await Promise.race([
          new Promise(resolve => { waiter = resolve; frameWaiters.push(resolve); }),
          closed.then(() => { throw new Error('socket closed before frame'); }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('frame timeout')), 5000); }),
        ]);
      } finally { clearTimeout(timer); frameWaiters = frameWaiters.filter(w => w !== waiter); }
    },
  };
}
async function text(ws) {
  const frame = await ws.next();
  assert.equal(frame.opcode, 1); assert.equal(frame.fin, true); assert.equal(frame.masked, false);
  return frame.data.toString();
}
async function sse(port, target = '/api/stream?client=widget', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target, headers }, res => {
      let buf = '', chunks = [], waiters = [];
      res.on('data', data => {
        buf += data.toString();
        for (let end; (end = buf.indexOf('\n\n')) !== -1;) {
          const chunk = buf.slice(0, end + 2); buf = buf.slice(end + 2);
          if (waiters.length) waiters.shift()(chunk); else chunks.push(chunk);
        }
      });
      resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy(), next: () => chunks.length ? Promise.resolve(chunks.shift()) : new Promise(r => waiters.push(r)) });
    });
    req.on('error', reject);
  });
}

test('handshake validates key and version before adding a bus client', async t => {
  const { app, port } = await fixture(t);
  for (const headers of [{ 'sec-websocket-key': null }, { 'sec-websocket-key': 'not-base64' }, { 'sec-websocket-version': null }, { 'sec-websocket-version': '12' }]) {
    const bad = await connect(port, { headers });
    assert.equal(bad.status, 400); await bad.closed; assert.equal(app.bus.clients.size, 0);
  }
  const ws = await connect(port);
  assert.equal(ws.status, 101);
  assert.equal(ws.headers['sec-websocket-accept'], createHash('sha1').update(KEY + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'));
  assert.equal(ws.headers['sec-websocket-extensions'], undefined); assert.equal(ws.headers['sec-websocket-protocol'], undefined);
  assert.equal(app.bus.clients.size, 1); ws.socket.destroy(); await ws.closed;
});

test('widget snapshots and broadcasts are identical to SSE, including retry and frame lengths', async t => {
  const { app, port } = await fixture(t);
  const stream = await sse(port); t.after(stream.close);
  assert.equal(stream.status, 200); assert.match(stream.headers['content-type'], /^text\/event-stream/);
  const expected = []; for (let i = 0; i < 6; i++) expected.push(await stream.next());
  assert.deepEqual(expected.map(v => v.match(/^(?:event: (\w+)|retry:)/)?.[1] || 'retry'), ['retry', 'widgets', 'interactive', 'viewers', 'customOverlayVersions', 'theme']);
  const ws = await connect(port); assert.equal(ws.status, 101);
  for (const frame of expected) assert.equal(await text(ws), frame);
  for (const size of [1, 200, 70000]) {
    const data = { text: 'x'.repeat(size) }; app.bus.send('chat', data, ['widget']);
    const event = `event: chat\ndata: ${JSON.stringify(data)}\n\n`;
    assert.equal(await text(ws), event); assert.equal(await stream.next(), event);
  }
  ws.socket.destroy();
});

test('loopback panel is keyless; origin, host, path and admission gate upgrades', async t => {
  const { app, port } = await fixture(t);
  const stream = await sse(port, '/api/stream?client=panel');
  assert.equal(stream.status, 200); assert.equal(await stream.next(), 'retry: 2000\n\n'); assert.match(await stream.next(), /^event: status\n/); stream.close();
  const ws = await connect(port, { target: '/api/stream?client=panel', headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(ws.status, 101); assert.equal(await text(ws), 'retry: 2000\n\n'); assert.match(await text(ws), /^event: status\n/);
  const count = app.bus.clients.size;
  for (const kind of ['panel', 'widget', 'overlay']) {
    const bad = await connect(port, { target: `/api/stream?client=${kind}`, headers: { origin: 'http://evil.example' } });
    assert.equal(bad.status, 403); await bad.closed; assert.equal(app.bus.clients.size, count);
  }
  for (const opts of [{ headers: { host: 'evil.example' } }, { target: '/api/state' }, { method: 'POST' }]) {
    const bad = await connect(port, opts); assert.ok([403, 404, 405].includes(bad.status)); await bad.closed; assert.equal(app.bus.clients.size, count);
  }
  await app.stopAdmission();
  const late = await connect(port); assert.equal(late.status, 503); await late.closed; assert.equal(app.bus.clients.size, count);
  ws.socket.destroy();
});

test('only an absent or same-origin HTTP Origin is accepted', async t => {
  const { app, port } = await fixture(t);
  for (const origin of ['', 'null', 'file:///tmp/test', `http://127.0.0.1:${port + 1}`, `http://127.0.0.1:${port}/path`]) {
    const ws = await connect(port, { headers: { origin } });
    assert.equal(ws.status, 403, JSON.stringify(origin)); await ws.closed; assert.equal(app.bus.clients.size, 0);
  }
  const ws = await connect(port, { headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(ws.status, 101); ws.socket.destroy();
});

test('LAN authorization matches HTTP for keyless, query, header and cookie requests', async t => {
  const { app, port } = await fixture(t);
  app.store.config.access.lan = true;
  app.server.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '192.0.2.1' }));
  const key = app.store.config.access.key;
  for (const [target, headers, expected] of [
    ['/api/stream?client=panel', {}, 401],
    [`/api/stream?client=panel&key=${encodeURIComponent(key)}`, {}, 200],
    ['/api/stream?client=panel', { 'x-egdev-key': key }, 200],
    ['/api/stream?client=panel', { cookie: `egk=${key}` }, 200],
  ]) {
    const before = app.bus.clients.size, httpStream = await sse(port, target, headers);
    assert.equal(httpStream.status, expected); httpStream.close();
    await until(() => app.bus.clients.size === before);
    const ws = await connect(port, { target, headers });
    assert.equal(ws.status, expected === 200 ? 101 : expected);
    if (expected === 200) { assert.match(await text(ws), /^retry:/); assert.match(await text(ws), /^event: status\n/); }
    if (target.includes('&key=')) assert.match(ws.headers['set-cookie'], /^egk=.*HttpOnly/);
    ws.socket.destroy(); await ws.closed; await until(() => app.bus.clients.size === before);
  }
  app.store.config.access.lan = false;
  const denied = await connect(port, { headers: { 'x-egdev-key': key } }); assert.equal(denied.status, 401); assert.equal(app.bus.clients.size, 0);
});

test('preview, overlay and teleprompter snapshots and theme drafts match SSE', async t => {
  const { port } = await fixture(t);
  const response = await fetch(`http://127.0.0.1:${port}/api/theme/draft`, { method: 'PUT', body: '{}' });
  assert.equal(response.status, 200);
  for (const [kind, names] of [['preview', ['theme']], ['overlay', ['pause', 'theme']], ['teleprompter', ['teleprompter', 'theme']]]) {
    const target = `/api/stream?client=${kind}&themeDraft=1`, stream = await sse(port, target), ws = await connect(port, { target });
    assert.equal(ws.status, 101); assert.equal(await text(ws), await stream.next());
    for (const name of names) {
      const value = await text(ws), sseValue = await stream.next(); assert.match(value, new RegExp(`^event: ${name}\\n`));
      if (name === 'teleprompter') {
        const a = JSON.parse(value.split('data: ')[1]), b = JSON.parse(sseValue.split('data: ')[1]);
        assert.ok(Math.abs(a.playback.serverNow - b.playback.serverNow) < 3000); a.playback.serverNow = b.playback.serverNow;
        assert.deepEqual(a, b);
      } else assert.equal(value, sseValue);
      if (name === 'theme') assert.equal(JSON.parse(value.split('data: ')[1]).draft, true);
    }
    stream.close(); ws.socket.destroy();
  }
});

test('custom-overlay tests stay on widgets and websocket overlays preserve alert ACKs', async t => {
  const { app, port } = await fixture(t), base = `http://127.0.0.1:${port}`;
  const post = async (url, body) => { const res = await fetch(base + url, { method: 'POST', body: JSON.stringify(body) }); assert.equal(res.status, 200); return res.json(); };
  const { overlay } = await post('/api/custom-overlays', { name: 'WS' });
  const { variation } = await post('/api/alerts/raid/variations', { name: 'WS', overrides: { actions: [{ kind: 'scene', scene: 'WS' }] } });
  const widget = await connect(port), layer = await connect(port, { target: '/api/stream?client=overlay' });
  assert.equal(widget.status, 101); assert.equal(layer.status, 101);
  for (let i = 0; i < 6; i++) await text(widget);
  for (let i = 0; i < 3; i++) await text(layer);
  const data = { text: 'only this overlay id' };
  await post(`/api/custom-overlays/${overlay.id}/test`, { event: 'chat', data });
  const custom = await text(widget); assert.deepEqual(JSON.parse(custom.split('data: ')[1]), { id: overlay.id, event: 'chat', data });
  app.bus.send('control', { action: 'clear' }, ['overlay']);
  assert.equal(await text(layer), 'event: control\ndata: {"action":"clear"}\n\n');
  let runs = 0; app.engine.runActions = async () => { runs++; };
  const result = await post('/api/test', { type: 'raid', variationId: variation.id });
  const alert = await text(layer); assert.equal(JSON.parse(alert.split('data: ')[1]).id, result.alert.id);
  assert.match(await text(widget), /^event: publicAlert\n/); assert.equal(runs, 0);
  assert.deepEqual(await post('/api/overlay/shown', { id: result.alert.id }), { ok: true });
  assert.equal(runs, 1); widget.socket.destroy(); layer.socket.destroy();
});

test('eight websocket layers receive the same broadcast', async t => {
  const { app, port } = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 8 }, () => connect(port)));
  for (const ws of clients) { assert.equal(ws.status, 101); for (let i = 0; i < 6; i++) await text(ws); }
  assert.equal(app.bus.clients.size, 8);
  app.bus.send('chat', { text: 'eight' }, ['widget']);
  for (const ws of clients) { assert.equal(await text(ws), 'event: chat\ndata: {"text":"eight"}\n\n'); ws.socket.destroy(); }
});

test('head, split and coalesced masked frames, ping/pong, close and protocol errors', async t => {
  const { app, port } = await fixture(t);
  const ws = await connect(port, { head: clientFrame(9, 'head') }); assert.equal(ws.status, 101);
  for (let i = 0; i < 6; i++) await text(ws);
  let frame = await ws.next(); assert.equal(frame.opcode, 10); assert.equal(frame.data.toString(), 'head');
  const first = clientFrame(9, 'split'); ws.socket.write(first.subarray(0, 1));
  await delay(10); ws.socket.write(Buffer.concat([first.subarray(1), clientFrame(1, 'ignored'), clientFrame(9, 'joined')]));
  for (const expected of ['split', 'joined']) { frame = await ws.next(); assert.equal(frame.opcode, 10); assert.equal(frame.data.toString(), expected); }
  ws.socket.write(clientFrame(8, Buffer.from([3, 232])));
  frame = await ws.next(); assert.equal(frame.opcode, 8); assert.equal(frame.data.readUInt16BE(), 1000);
  await ws.closed; await until(() => app.bus.clients.size === 0);
  for (const [bad, code] of [[clientFrame(1, 'bad', false), 1002], [Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 1, 0, 1]), 1009]]) {
    const other = await connect(port); assert.equal(other.status, 101); for (let i = 0; i < 6; i++) await text(other);
    other.socket.write(bad); frame = await other.next(); assert.equal(frame.opcode, 8); assert.equal(frame.data.readUInt16BE(), code);
    await other.closed; await until(() => app.bus.clients.size === 0);
  }
});

test('a slow websocket receives the bus gap before closing', async t => {
  const { app, port, sockets } = await fixture(t);
  app.bus.byteBudget = 1024; app.bus.backlogGraceMs = 20; app.bus.backlogStallMs = 40; app.bus.backlogMaxMs = 100;
  const ws = await connect(port); assert.equal(ws.status, 101); for (let i = 0; i < 6; i++) await text(ws);
  const serverSocket = [...sockets][0]; ws.socket.pause(); serverSocket.cork();
  for (let i = 0; i < 20; i++) app.bus.send('chat', { i, text: 'x'.repeat(8192) }, ['widget']);
  await until(() => serverSocket.writableEnded); serverSocket.uncork(); ws.socket.resume();
  let gap;
  for (;;) { const frame = await ws.next(); if (frame.opcode === 8) break; if (frame.data.toString().startsWith('event: gap\n')) gap = frame.data.toString(); }
  assert.ok(gap); assert.equal(JSON.parse(gap.split('data: ')[1]).reason, 'slow-client');
  await ws.closed; await until(() => app.bus.clients.size === 0);
});

test('closeHttp closes an open websocket and removes its bus client', async t => {
  const { app, port } = await fixture(t);
  const ws = await connect(port); assert.equal(ws.status, 101); assert.equal(app.bus.clients.size, 1);
  await app.closeHttp(); await ws.closed; await until(() => app.bus.clients.size === 0);
});

test('client close clears the ping so a standalone server exits naturally', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-ws-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL('../src/server.mjs', import.meta.url).href;
  const program = `import { createApp } from ${JSON.stringify(module)};
    const app = await createApp({ dataDir: process.argv[1], mediaDir: process.argv[1] + '/media', log: () => {} });
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    const ws = new WebSocket('ws://127.0.0.1:' + app.server.address().port + '/api/stream?client=widget');
    ws.onopen = () => ws.close();
    ws.onclose = () => app.server.close(() => console.log('CLOSED'));
    ws.onerror = () => { console.error('WS-ERROR'); process.exitCode = 1; app.server.closeAllConnections(); app.server.close(); };`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  let timer; const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const result = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]); clearTimeout(timer);
  if (!result) { child.kill(); await exit; }
  assert.deepEqual(result, { code: 0, signal: null }, output); assert.match(output, /CLOSED/);
});

test('default HTTP and HTTPS ports differ', async t => {
  const { app, port } = await fixture(t);
  const ws = await connect(port, { headers: { host: 'localhost', origin: 'https://localhost' } });
  assert.equal(ws.status, 403);
  assert.equal(app.bus.clients.size, 0);
});

test('HTTP origins normalize host case and default port, and HTTPS is always rejected', async t => {
  const { app, port } = await fixture(t);
  for (const [host, origin] of [['localhost', 'http://LOCALHOST:80'], ['LOCALHOST:80', 'http://localhost']]) {
    const ws = await connect(port, { headers: { host, origin } });
    assert.equal(ws.status, 101); assert.equal(await text(ws), 'retry: 2000\n\n');
    ws.socket.destroy(); await ws.closed; await until(() => app.bus.clients.size === 0);
  }
  const ws = await connect(port, { headers: { host: 'localhost:80', origin: 'https://localhost:80' } });
  assert.equal(ws.status, 403); await ws.closed; assert.equal(app.bus.clients.size, 0);
});

test('non-reading websocket is cut', async t => {
  const { app, port, sockets } = await fixture(t);
  Object.assign(app.bus, { byteBudget: 1024, backlogGraceMs: 20, backlogStallMs: 40, backlogMaxMs: 100 });
  const ws = await connect(port);
  assert.equal(ws.status, 101);
  for (let i = 0; i < 6; i++) await text(ws);
  const server = [...sockets][0];
  let closes = 0; server.on('close', () => closes++);
  // 8 MB do not fit in the loopback kernel buffers: bytes stay pending in the process and do
  // not go down, which is what marks a peer that does not read (a smaller backlog that the
  // kernel absorbs is indistinguishable from a slow reader and waits for the 30 s cap).
  ws.socket.pause();
  app.bus.send('chat', { i: 0, text: 'x'.repeat(8 * 1024 * 1024) }, ['widget']);
  for (let i = 1; i < 4; i++) app.bus.send('chat', { i, text: 'x'.repeat(8192) }, ['widget']);
  await until(() => server.writableEnded);
  assert.ok(server.writableLength > 0, 'backlog pending in the process');
  await delay(2500);
  assert.equal(server.destroyed, true);
  assert.equal(app.bus.clients.size, 0);
  assert.equal(closes, 1);
  ws.socket.destroy();
});

test('keyed LAN widget upgrades and unkeyed LAN rejection matches HTTP', async t => {
  const { app, port } = await fixture(t);
  app.store.config.access.lan = true;
  app.server.on('connection', s => Object.defineProperty(s, 'remoteAddress', { value: '192.0.2.1' }));
  const stream = await sse(port); assert.equal(stream.status, 401); stream.close();
  const denied = await connect(port); assert.equal(denied.status, stream.status);
  await denied.closed; assert.equal(app.bus.clients.size, 0);
  const ws = await connect(port, { target: `/api/stream?client=widget&key=${encodeURIComponent(app.store.config.access.key)}` });
  assert.equal(ws.status, 101); assert.match(ws.headers['set-cookie'], /^egk=.*HttpOnly/);
  for (const name of ['retry', 'widgets', 'interactive', 'viewers', 'customOverlayVersions', 'theme']) {
    assert.match(await text(ws), new RegExp(`^${name === 'retry' ? 'retry:' : `event: ${name}\\n`}`));
  }
  ws.socket.destroy(); await ws.closed; await until(() => app.bus.clients.size === 0);
});

test('keyed LAN upgrade outside stream does not crash', async t => {
  const { app, port } = await fixture(t);
  app.store.config.access.lan = true;
  app.server.on('connection', s => Object.defineProperty(s, 'remoteAddress', { value: '192.0.2.1' }));
  const ws = await connect(port, { target: `/?key=${encodeURIComponent(app.store.config.access.key)}` });
  assert.equal(ws.status, 404);
  assert.equal(app.bus.clients.size, 0);
});

test('other upgrade paths return 404 even with a foreign Origin or Host', async t => {
  const { app, port } = await fixture(t);
  for (const headers of [{ origin: 'http://evil.example' }, { host: 'evil.example' }]) {
    const ws = await connect(port, { target: '/other', headers });
    assert.equal(ws.status, 404); await ws.closed; assert.equal(app.bus.clients.size, 0);
  }
});

test('UTF-8 validation works across frames on a real connection', async t => {
  const { app, port } = await fixture(t);
  for (const fragmented of [false, true]) {
    const ws = await connect(port); assert.equal(ws.status, 101);
    for (let i = 0; i < 6; i++) await text(ws);
    const start = clientFrame(1, Buffer.from([0xe2])); start[0] &= 0x7f;
    ws.socket.write(Buffer.concat([start, clientFrame(9, 'ok'), clientFrame(0, Buffer.from([0x82, 0xac]))]));
    const pong = await ws.next(); assert.equal(pong.opcode, 10); assert.equal(pong.data.toString(), 'ok');
    if (fragmented) {
      const first = clientFrame(1, Buffer.from([0xe2])); first[0] &= 0x7f;
      ws.socket.write(Buffer.concat([first, clientFrame(0, '(')]));
    } else ws.socket.write(clientFrame(1, Buffer.from([0xff])));
    const close = await ws.next(); assert.equal(close.opcode, 8); assert.equal(close.data.readUInt16BE(), 1007);
    await ws.closed; await until(() => app.bus.clients.size === 0);
  }
});
