// Interview live control (#278), server side: next/previous/go-to/media/hide over HTTP and as Stream
// Deck shortcuts, the widget SSE payload (no notes), the presenter view (notes, n / total), the
// timeline mark per shown question and the warnings without an active interview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const PACK = {
  version: 1, id: 'directo', title: 'Entrevista en directo', guest: { name: 'Ana' },
  rounds: [
    { id: 'r1', title: 'Calentamiento', items: [
      { id: 'a', question: '¿Primera pregunta?', media: { type: 'image', file: 'foto.jpg' }, source: { url: 'https://example.com/x', date: '2026-03-14' }, notes: 'NOTA-PRIVADA-A', aprobado: true },
      { id: 'b', question: 'Sin aprobar', notes: 'NOTA-PRIVADA-B', aprobado: false },
      { id: 'c', question: 'Solo texto', notes: 'NOTA-PRIVADA-C', aprobado: true },
    ] },
    { id: 'r2', title: 'Final', items: [
      { id: 'd', question: '¿Última?', media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, aprobado: true },
    ] },
  ],
};
const NOTES = /NOTA-PRIVADA/;

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-interview-control-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  t.after(() => new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }));
  return { app, base, api };
}

/** Keeps the events of one SSE client (`widget` or `panel`) by name, raw text included. */
async function listen(base, client, name) {
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
          if (block.startsWith(`event: ${name}\n`)) events.push(JSON.parse(block.split('\ndata: ')[1]));
        }
      }
    } catch { /* closed */ }
  })();
  const last = async (pred, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = events.findLast(pred);
      if (hit || Date.now() > end) return hit;
      await new Promise(r => setTimeout(r, 20));
    }
  };
  return { events, raw: () => raw, last, close: () => ctl.abort() };
}

async function active(api, itemId) {
  assert.equal((await api('POST', '/api/interviews/import', PACK)).status, 200);
  assert.equal((await api('POST', '/api/interviews/select', { id: 'directo', ...(itemId && { itemId }) })).status, 200);
}
const marks = async api => (await api('GET', '/api/timeline?kinds=question')).body.items;

test('without an active interview every action warns (409 + message) and changes nothing', async t => {
  const { api, app } = await start(t);
  assert.equal((await api('POST', '/api/interviews/import', PACK)).status, 200);   // stored but not active
  const before = JSON.stringify(app.store.config.interviews);
  const sd = ['entrevista-siguiente', 'entrevista-anterior', 'entrevista-ir/a', 'entrevista-mostrar-media', 'entrevista-ocultar-media', 'entrevista-ocultar'];
  const calls = [
    ['POST', '/api/interview-control/next'], ['POST', '/api/interview-control/previous'],
    ['POST', '/api/interview-control/goto', { itemId: 'a' }], ['POST', '/api/interview-control/media', { visible: false }],
    ['POST', '/api/interview-control/hide'], ...sd.map(a => ['POST', '/sd/' + a]),
  ];
  for (const [m, u, b] of calls) {
    const r = await api(m, u, b);
    assert.equal(r.status, 409, u);
    assert.match(r.body.error, /No hay entrevista activa/, u);
  }
  assert.equal(JSON.stringify(app.store.config.interviews), before, 'nothing changed');
  assert.deepEqual(await marks(api), [], 'no timeline mark');
  const view = (await api('GET', '/api/interview-control')).body;
  assert.equal(view.active, false); assert.equal(view.current, null);
});

test('next / previous walk the approved items in round order and skip unapproved ones', async t => {
  const { api } = await start(t);
  await active(api);
  const step = async (path, body) => (await api('POST', '/api/interview-control/' + path, body));
  let r = await step('next');
  assert.equal(r.status, 200); assert.equal(r.body.current.id, 'a'); assert.deepEqual(r.body.progress, { index: 1, total: 3 });
  r = await step('next'); assert.equal(r.body.current.id, 'c', 'skips the unapproved b'); assert.equal(r.body.progress.index, 2);
  r = await step('next'); assert.equal(r.body.current.id, 'd', 'crosses into the next round'); assert.equal(r.body.next, null);
  r = await step('next');
  assert.equal(r.status, 409); assert.match(r.body.error, /último/);
  assert.equal((await api('GET', '/api/interview-control')).body.current.id, 'd', 'a rejected step changes nothing');
  r = await step('previous'); assert.equal(r.body.current.id, 'c');
  r = await step('previous'); r = await step('previous');
  assert.equal(r.status, 409); assert.match(r.body.error, /primer/);
  assert.equal((await api('GET', '/api/interview-control')).body.current.id, 'a');
});

test('go-to: any approved item; unknown, unapproved and missing ids are rejected without changes', async t => {
  const { api } = await start(t);
  await active(api, 'a');
  let r = await api('POST', '/api/interview-control/goto', { itemId: 'd' });
  assert.equal(r.status, 200); assert.equal(r.body.current.id, 'd');
  for (const [id, status, re] of [['b', 409, /no está aprobado/], ['zzz', 404, /No existe el ítem/], ['', 400, /Falta el id/]]) {
    r = await api('POST', '/api/interview-control/goto', { itemId: id });
    assert.equal(r.status, status, id); assert.match(r.body.error, re, id);
  }
  assert.equal((await api('GET', '/api/interview-control')).body.current.id, 'd');
});

test('widget SSE follows every action and never carries the private notes', async t => {
  const { api, base } = await start(t);
  const widget = await listen(base, 'widget', 'interview');
  t.after(() => widget.close());
  await active(api);
  const seen = async id => widget.last(e => e.item?.id === id);
  await api('POST', '/api/interview-control/next');
  assert.deepEqual((await seen('a')).item, { id: 'a', question: '¿Primera pregunta?', media: { type: 'image', file: 'foto.jpg' }, source: { url: 'https://example.com/x', date: '2026-03-14' } });
  // media hidden: the widget gets the plain question
  assert.equal((await api('POST', '/api/interview-control/media', { visible: false })).body.mediaHidden, true);
  assert.deepEqual((await widget.last(e => e.item?.id === 'a' && !e.item.media)).item, { id: 'a', question: '¿Primera pregunta?' });
  assert.equal((await api('POST', '/api/interview-control/media', { visible: true })).body.mediaHidden, false);
  assert.ok((await widget.last(e => e.item?.id === 'a' && e.item.media)).item.media);
  // hidden media resets when the item changes
  await api('POST', '/api/interview-control/media', { visible: false });
  await api('POST', '/api/interview-control/goto', { itemId: 'd' });
  assert.equal((await seen('d')).item.media.type, 'youtube');
  assert.equal((await api('GET', '/api/interview-control')).body.mediaHidden, false);
  await api('POST', '/api/interview-control/previous');
  assert.equal((await seen('c')).item.question, 'Solo texto');
  // hide widget: empty state, the interview stays active
  assert.equal((await api('POST', '/api/interview-control/hide')).status, 200);
  assert.ok(await widget.last(e => e.item === null));
  assert.equal((await api('GET', '/api/interview-control')).body.active, true);
  assert.doesNotMatch(widget.raw(), NOTES);
  // media and hide need an item on screen
  for (const [p, b] of [['media', { visible: false }], ['hide'], ['previous']]) {
    const r = await api('POST', '/api/interview-control/' + p, b);
    assert.equal(r.status, 409, p); assert.match(r.body.error, /No hay ningún ítem/, p);
  }
  assert.equal((await api('POST', '/api/interview-control/next')).body.current.id, 'a', 'next from empty starts at the first');
  assert.equal((await api('POST', '/api/interview-control/media', { visible: 'no' })).status, 400);
});

test('presenter view: progress, current and next with private notes; the panel SSE carries them, the widget does not', async t => {
  const { api, base } = await start(t);
  const panel = await listen(base, 'panel', 'interviewControl');
  const widget = await listen(base, 'widget', 'interview');
  t.after(() => { panel.close(); widget.close(); });
  await active(api);
  await api('POST', '/api/interview-control/goto', { itemId: 'a' });
  const view = (await api('GET', '/api/interview-control')).body;
  assert.equal(view.title, 'Entrevista en directo');
  assert.deepEqual(view.progress, { index: 1, total: 3 });
  assert.deepEqual(view.current, { id: 'a', question: '¿Primera pregunta?', notes: 'NOTA-PRIVADA-A', round: 'Calentamiento', media: 'image' });
  assert.deepEqual(view.next, { id: 'c', question: 'Solo texto', notes: 'NOTA-PRIVADA-C', round: 'Calentamiento', media: null });
  assert.deepEqual(view.items.map(x => x.id), ['a', 'c', 'd']);
  const pushed = await panel.last(e => e.current?.id === 'a');
  assert.equal(pushed.current.notes, 'NOTA-PRIVADA-A');
  assert.doesNotMatch(widget.raw(), NOTES);
});

test('each shown question adds one timeline mark with its text and item id; media and hide do not', async t => {
  const { api } = await start(t);
  await active(api);
  const go = (p, b) => api('POST', '/api/interview-control/' + p, b);
  await go('next'); await go('next'); await go('previous');
  await go('media', { visible: false }); await go('media', { visible: true });
  await go('goto', { itemId: 'd' });
  await go('hide');
  await go('goto', { itemId: 'zzz' });
  const items = await marks(api);
  assert.deepEqual(items.map(i => i.itemId), ['a', 'c', 'a', 'd']);
  assert.deepEqual(items.map(i => i.text), ['¿Primera pregunta?', 'Solo texto', '¿Primera pregunta?', '¿Última?']);
  assert.ok(items.every(i => i.kind === 'question' && i.interviewId === 'directo'));
  assert.doesNotMatch(JSON.stringify(items), NOTES, 'notes never reach the timeline');
});

test('Stream Deck shortcuts run the same actions (go-to takes the item id) and are listed', async t => {
  const { api, base } = await start(t);
  await active(api);
  const widget = await listen(base, 'widget', 'interview');
  t.after(() => widget.close());
  const sd = (a, m = 'POST') => api(m, '/sd/' + a);
  assert.equal((await sd('entrevista-siguiente')).body.current.id, 'a');
  assert.equal((await sd('entrevista-siguiente', 'GET')).body.current.id, 'c');
  assert.equal((await sd('entrevista-anterior')).body.current.id, 'a');
  assert.equal((await sd('entrevista-ir/d')).body.current.id, 'd');
  assert.equal((await sd('entrevista-ocultar-media')).body.mediaHidden, true);
  assert.ok(await widget.last(e => e.item?.id === 'd' && !e.item.media));
  assert.equal((await sd('entrevista-mostrar-media')).body.mediaHidden, false);
  assert.equal((await sd('entrevista-ocultar')).body.current, null);
  assert.ok(await widget.last(e => e.item === null));
  const list = (await api('GET', '/api/shortcuts')).body;
  for (const a of ['entrevista-siguiente', 'entrevista-anterior', 'entrevista-ir', 'entrevista-mostrar-media', 'entrevista-ocultar-media', 'entrevista-ocultar']) assert.ok(list.builtins.includes(a), a);
  // custom shortcut with an argument
  const sc = await api('POST', '/api/shortcuts', { name: 'Ir a la última', steps: [{ kind: 'builtin', action: 'entrevista-ir', arg: 'd' }] });
  assert.equal(sc.status, 200);
  assert.equal((await api('POST', `/api/shortcuts/${sc.body.shortcut.id}/run`)).status, 200);
  assert.equal((await api('GET', '/api/interview-control')).body.current.id, 'd');
});

test('prompter tab «entrevista» is accepted; the other tabs and the old actions still behave', async t => {
  const { api } = await start(t);
  assert.deepEqual((await api('GET', '/api/prompter')).body.tabs, ['cronologia', 'preguntas', 'entrevista']);
  assert.equal((await api('POST', '/api/prompter', { tab: 'entrevista' })).body.tab, 'entrevista');
  assert.equal((await api('POST', '/sd/prompter/preguntas')).body.tab, 'preguntas');
  assert.equal((await api('POST', '/api/prompter', { tab: 'nope' })).status, 400);
  assert.equal((await api('POST', '/sd/marca/loquesea')).status, 200, 'an extra path segment is still ignored by the other actions');
});
