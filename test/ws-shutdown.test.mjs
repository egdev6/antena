import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), 1200);
    })]);
  } finally { clearTimeout(timer); }
}

for (const closeAll of [false, true]) {
  test(`HTTP close ${closeAll ? 'after closeAllConnections ' : ''}closes upgraded streams promptly`, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'antena-ws-shutdown-'));
    const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
    let ws;
    t.after(async () => {
      await app.closeHttp();
      ws?.close();
      await rm(dir, { recursive: true, force: true });
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    ws = new WebSocket(base.replace('http:', 'ws:') + '/api/stream?client=overlay');
    const closed = new Promise(resolve => ws.addEventListener('close', resolve, { once: true }));
    await within(new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    }), 'WebSocket did not open');
    assert.equal((await fetch(base + '/api/status').then(r => r.json())).overlays, 1);
    if (closeAll) app.server.closeAllConnections();
    const stopped = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    await within(stopped, 'HTTP server.close() stayed pending with an upgraded stream');
    await within(closed, 'upgraded stream remained open');
    assert.equal(ws.readyState, WebSocket.CLOSED);
    assert.equal(app.server.listening, false);
  });
}
