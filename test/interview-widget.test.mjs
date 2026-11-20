// Interview widget (#277), server side: the widget is registered like the others and the active
// item reaches widgets over SSE (`interview`) on connect, select, edit and delete, without notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, WIDGETS } from '../src/server.mjs';

const PACK = {
  version: 1, id: 'demo-entrevista', title: 'Entrevista de prueba', guest: { name: 'Ana' },
  rounds: [{ id: 'r1', title: 'Ronda', items: [
    { id: 'a', question: '¿Primera pregunta?', media: { type: 'image', file: 'foto.jpg' }, source: { url: 'https://example.com/x', date: '2026-03-14' }, notes: 'NOTA-PRIVADA-A', aprobado: true },
    { id: 'b', question: 'Sin aprobar', notes: 'NOTA-PRIVADA-B', aprobado: false },
    { id: 'c', question: 'Solo texto', aprobado: true },
  ] }],
};

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-interview-widget-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { app, base, api, close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

/** Opens the SSE stream of a widget client and keeps every `interview` event it receives. */
async function listen(base, client = 'widget') {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/stream?client=${client}`, { signal: ctl.signal });
  const decoder = new TextDecoder();
  const events = []; let raw = '', buf = '';
  (async () => {
    try {
      for await (const chunk of res.body) {
        const text = decoder.decode(chunk, { stream: true }); raw += text; buf += text;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith('event: interview\n')) events.push(JSON.parse(block.split('\ndata: ')[1]));
        }
      }
    } catch { /* closed */ }
  })();
  const waitFor = async (n, ms = 4000) => {
    const end = Date.now() + ms;
    while (events.length < n && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    return events.length >= n;
  };
  /** Waits until some event after position `from` satisfies `pred`; returns it (or undefined). */
  const next = async (pred, from = 0, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.slice(from).find(pred);
      if (hit || Date.now() > end) return hit;
      await new Promise(r => setTimeout(r, 20));
    }
  };
  return { events, raw: () => raw, waitFor, next, close: () => ctl.abort() };
}

test('interview is a registered widget, served at /widget/interview and listed as a 1920×1080 browser source', async t => {
  assert.ok(WIDGETS.includes('interview'));
  const { base, api, close } = await start(t);
  try {
    const page = await fetch(`${base}/widget/interview`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /antena · entrevista/);
    const { body } = await api('GET', '/api/sources');
    const src = body.sources.find(s => s.id === 'interview');
    assert.deepEqual({ path: src.path, width: src.width, height: src.height }, { path: '/widget/interview', width: 1920, height: 1080 });
  } finally { await close(); }
});

test('the active item is pushed to widgets on connect, select, edit and delete, and notes never travel', async t => {
  const { api, base, close } = await start(t);
  const sse = await listen(base);
  try {
    assert.ok(await sse.waitFor(1), 'initial snapshot on connect');
    assert.deepEqual(sse.events[0], { item: null });
    assert.equal((await api('POST', '/api/interviews/import', PACK)).status, 200);

    assert.equal((await api('POST', '/api/interviews/select', { id: 'demo-entrevista', itemId: 'a' })).status, 200);
    assert.deepEqual(await sse.next(e => e.item?.id === 'a'), { item: {
      id: 'a', question: '¿Primera pregunta?', media: { type: 'image', file: 'foto.jpg' }, source: { url: 'https://example.com/x', date: '2026-03-14' },
    } });

    const before = sse.events.length;
    assert.equal((await api('POST', '/api/interviews/select', { id: 'demo-entrevista', itemId: 'b' })).status, 409);
    await new Promise(r => setTimeout(r, 150));
    assert.equal(sse.events.length, before, 'a rejected select pushes nothing');

    const iv = (await api('GET', '/api/interviews/demo-entrevista')).body.interview;
    iv.rounds[0].items[0].question = 'Editada';
    assert.equal((await api('PUT', '/api/interviews/demo-entrevista', { rounds: iv.rounds })).status, 200);
    assert.equal((await sse.next(e => e.item?.question === 'Editada', before))?.item.id, 'a');

    const mid = sse.events.length;
    iv.rounds[0].items[0].aprobado = false;
    assert.equal((await api('PUT', '/api/interviews/demo-entrevista', { rounds: iv.rounds })).status, 200);
    assert.deepEqual(await sse.next(e => e.item === null, mid), { item: null }, 'un-approving the active item clears the widget');

    await api('POST', '/api/interviews/select', { id: 'demo-entrevista', itemId: 'c' });
    assert.deepEqual(await sse.next(e => e.item?.id === 'c', mid), { item: { id: 'c', question: 'Solo texto' } });
    const last = sse.events.length;
    await api('DELETE', '/api/interviews/demo-entrevista');
    assert.deepEqual(await sse.next(e => e.item === null, last), { item: null }, 'deleting the interview clears the widget');

    assert.ok(!sse.raw().includes('NOTA-PRIVADA'), 'private notes never reach the widget stream');
  } finally { sse.close(); await close(); }
});

test('a widget that connects later gets the active item at once; panel clients do not get the event', async t => {
  const { api, base, close } = await start(t);
  let late, panel;
  try {
    await api('POST', '/api/interviews/import', PACK);
    await api('POST', '/api/interviews/select', { id: 'demo-entrevista', itemId: 'a' });
    late = await listen(base);
    assert.ok(await late.waitFor(1));
    assert.equal(late.events[0].item.id, 'a');
    panel = await listen(base, 'panel');
    await new Promise(r => setTimeout(r, 200));
    assert.equal(panel.events.length, 0);
  } finally { late?.close(); panel?.close(); await close(); }
});
