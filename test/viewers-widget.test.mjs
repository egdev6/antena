import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-viewers-widget-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  return { app, base, call, close: async () => {
    await new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

/** Opens an SSE stream and returns a reader that resolves the next payload of a given event. */
async function sse(url) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  async function next(name, pred = () => true, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = events.findIndex(e => e.event === name && pred(e.data));
      if (i >= 0) return events.splice(i, 1)[0].data;
      if (Date.now() > deadline) throw new Error(`no "${name}" event within ${timeoutMs} ms`);
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 100))]);
      if (done) throw new Error('stream closed');
      if (!value) continue;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  }
  return { next, close: () => ctrl.abort() };
}

test('GET /widget/viewers serves the viewers widget page', async () => {
  const { base, close } = await start();
  try {
    const r = await fetch(base + '/widget/viewers');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const html = await r.text();
    assert.match(html, /\/widgets\/widget\.js/);
    assert.match(html, /viewers/);
  } finally { await close(); }
});

test('widget SSE clients get a slim viewers snapshot on connect and on every change', async () => {
  const { base, call, close } = await start();
  const s = await sse(base + '/api/stream?client=widget');
  try {
    const first = await s.next('viewers');
    assert.deepEqual(Object.keys(first).sort(), ['twitch', 'youtube']);
    for (const p of ['twitch', 'youtube']) assert.deepEqual(Object.keys(first[p]).sort(), ['current', 'live', 'peak', 'record']);
    assert.equal(first.twitch.record, 0);
    await call('PUT', '/api/viewers/records/twitch', { value: 42 });
    const changed = await s.next('viewers', d => d.twitch.record === 42);
    assert.equal(changed.youtube.record, 0);
    assert.equal('settings' in changed, false);
  } finally { s.close(); await close(); }
});

test('overlay SSE clients never receive viewers events', async () => {
  const { base, call, close } = await start();
  const s = await sse(base + '/api/stream?client=overlay');
  try {
    await call('PUT', '/api/viewers/records/twitch', { value: 7 });
    await assert.rejects(s.next('viewers', () => true, 400), /no "viewers" event/);
  } finally { s.close(); await close(); }
});

test('widgets.viewers config has defaults and is editable through PUT /api/widgets', async () => {
  const { call, close } = await start();
  try {
    const before = await call('GET', '/api/widgets');
    assert.deepEqual(before.widgets.viewers, { platforms: ['twitch', 'youtube'], showTotal: true, showPeak: false, css: '' });
    await call('PUT', '/api/widgets', { viewers: { platforms: ['youtube'], showTotal: false, css: '.root{gap:4px}' } });
    const after = await call('GET', '/api/widgets');
    assert.deepEqual(after.widgets.viewers, { platforms: ['youtube'], showTotal: false, showPeak: false, css: '.root{gap:4px}' });
  } finally { await close(); }
});

// #64: with "Color de cada plataforma" on, each platform card takes its own theme color
// (like the goal bars, via pf-<platform>), and the total card keeps the general accent.
test('viewers widget paints each platform card with its theme color', { timeout: 90000 }, async t => {
  const { closeChrome, findChrome, openChromePage, waitDom } = await import('./helpers/react-browser.mjs');
  const { evaluateChrome } = await import('./helpers/chrome-dom.mjs');
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const { base, call, close } = await start();
  let chrome;
  try {
    await call('PUT', '/api/theme', { accent: '#00ff00', platformAccent: true, twitchColor: '#9146ff', youtubeColor: '#ff0000' });
    chrome = await openChromePage(bin, `${base}/widget/viewers?demo`);
    const c = chrome.cdp;
    await waitDom(c, `document.querySelectorAll('.item').length === 3`, { timeoutMs: 12000 });
    await waitDom(c, `getComputedStyle(document.querySelector('.item-total')).getPropertyValue('--red').trim().toLowerCase() === '#00ff00'`, { timeoutMs: 5000 });
    const red = await evaluateChrome(c, `JSON.stringify(Object.fromEntries(['twitch', 'youtube', 'total'].map(id =>
      [id, getComputedStyle(document.querySelector('.item-' + id)).getPropertyValue('--red').trim().toLowerCase()])))`);
    assert.deepEqual(JSON.parse(red), { twitch: '#9146ff', youtube: '#ff0000', total: '#00ff00' });
  } finally { if (chrome) await closeChrome(chrome); await close(); }
});
