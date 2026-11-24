// Chat preview in the real sources: API contract, auto-off and no chat history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-chat-preview-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { base, call };
}

/** Collects the chatPreview frames of a widget SSE stream. */
async function listen(base) {
  const ctrl = new AbortController(), frames = [];
  const res = await fetch(base + '/api/stream?client=widget', { signal: ctrl.signal });
  (async () => {
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith('event: chatPreview\n')) frames.push(JSON.parse(block.split('\ndata: ')[1]));
        }
      }
    } catch {}
  })();
  return { frames, close: () => ctrl.abort() };
}
const until = async (cond, ms = 4000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };

test('the chat preview starts, reaches widget sources, stops and stores nothing', async t => {
  const { base, call } = await start(t);
  assert.deepEqual((await call('GET', '/api/chat/preview')).body, { on: false, until: null });
  const chatBefore = (await call('GET', '/api/chat')).body.length;

  const sse = await listen(base);
  t.after(() => sse.close());
  const on = await call('POST', '/api/chat/preview', { on: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.on, true);
  assert.ok(Date.parse(on.body.until) - Date.now() > 110000 && Date.parse(on.body.until) - Date.now() <= 120000, 'auto-off after 120 s by default');
  await until(() => sse.frames.some(f => f.on === true));
  assert.deepEqual((await call('GET', '/api/chat/preview')).body, on.body);

  const late = await listen(base);   // a source loaded mid-preview joins it
  t.after(() => late.close());
  await until(() => late.frames.length > 0);
  assert.deepEqual(late.frames[0], on.body);

  const off = await call('POST', '/api/chat/preview', { on: false });
  assert.deepEqual(off.body, { on: false, until: null });
  await until(() => sse.frames.at(-1)?.on === false);
  assert.equal((await call('GET', '/api/chat')).body.length, chatBefore, 'nothing is added to the chat history');
});

test('the chat preview turns itself off and rejects invalid requests unchanged', async t => {
  const { base, call } = await start(t);
  const sse = await listen(base);
  t.after(() => sse.close());
  const on = await call('POST', '/api/chat/preview', { on: true, seconds: 1 });
  assert.equal(on.body.on, true);
  await until(() => sse.frames.at(-1)?.on === false, 3000);
  assert.deepEqual((await call('GET', '/api/chat/preview')).body, { on: false, until: null });

  for (const bad of [{}, { on: 'yes' }, { on: true, seconds: 0 }, { on: true, seconds: 601 }, { on: true, seconds: 'x' }]) {
    const r = await call('POST', '/api/chat/preview', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /vista previa/);
  }
  assert.deepEqual((await call('GET', '/api/chat/preview')).body, { on: false, until: null }, 'rejected requests change nothing');
});
