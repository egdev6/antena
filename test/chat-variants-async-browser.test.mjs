// Independent S2/S3/S6/S9 public-panel regressions: real built React, real loopback API/SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const route = '/api/widgets/chat/variants';
const q = x => JSON.stringify(x);
const field = text => `Array.from(document.querySelectorAll('main label')).find(l => l.textContent.trim().startsWith(${q(text)}))?.querySelector('input,select,textarea')`;
const button = text => `Array.from(document.querySelectorAll('main button')).find(b => b.textContent.trim() === ${q(text)})`;
const select = field('Variante de chat');
const font = field('Tamaño de letra');
const bar = `document.querySelector('.lv-savebar')`;
const frame = `document.querySelector('main .preview-col iframe')`;
const previewState = `(() => { const f = ${frame}; return {
  variant: ${select}?.value ?? null, layout: ${field('Disposición')}?.value ?? null,
  bar: ${bar}?.querySelector('.lv-dirty')?.textContent ?? null,
  source: document.querySelector('main .browser-source code')?.textContent ?? null,
  hint: document.querySelector('main .browser-source .overlay-url .hint')?.textContent ?? null,
  src: f?.getAttribute('src') ?? null, width: f?.style.width ?? null, height: f?.style.height ?? null,
}; })()`;
const dom = (c, expr) => evaluateChrome(c, expr, { timeoutMs: 12000 });
const wait = (c, expr) => waitDom(c, expr, { timeoutMs: 12000 });
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Installed before navigation via toString(), so these regexes are not cooked by a template.
// It observes real traffic and holds the original response, without changing its payload.
function observeReconnect() {
  if (window.top !== window) return;
  const p = window.__stateProbe = { sockets: [], frames: [], requests: [], opens: 0, gate: null };
  const fetchReal = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = String(options.method || 'GET').toUpperCase();
    const tracked = ['/api/state', '/api/widgets', '/api/timeline', '/api/prompter'].includes(url.pathname);
    const entry = tracked ? { method, path: url.pathname, opens: p.opens, status: null, body: options.body || null } : null;
    if (entry) p.requests.push(entry);
    const gate = method === 'GET' && url.pathname === '/api/state' ? p.gate : null;
    const response = await fetchReal(input, options);
    if (entry) entry.status = response.status;
    if (gate && !gate.hit) {
      gate.status = response.status;
      gate.body = await response.clone().json();
      gate.hit = true;
      await new Promise(resolve => { gate.release = resolve; });
      gate.delivered = true;
    }
    return response;
  };
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      if (protocols === undefined) super(url); else super(url, protocols);
      const u = new URL(String(url), location.href);
      if (u.pathname !== '/api/stream' || u.searchParams.get('client') !== 'panel') return;
      p.sockets.push(this);
      this.addEventListener('open', () => { p.opens++; });
      this.addEventListener('message', e => {
        if (typeof e.data !== 'string' || !/^event: widgets\r?$/m.test(e.data)) return;
        const raw = /^data: (.*)\r?$/m.exec(e.data)?.[1];
        if (raw) p.frames.push(JSON.parse(raw));
      });
    }
  };
}

async function fixture(t) {
  const bin = await findChrome();
  assert.ok(bin, 'Chrome is required; no skip or source fallback');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-independent-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  let chrome;
  t.after(async () => {
    if (chrome) await closeChrome(chrome);
    app.teleprompter.stop(); app.viewers.stop(); app.meld.stop(); app.timers.stop();
    app.engine.flushScheduledSends(); app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve);
  });
  const port = app.server.address().port;
  assert.notEqual(port, 4500);
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const ok = async (method, url, body) => {
    const r = await request(method, url, body);
    assert.equal(r.status, 200, `${method} ${url}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const open = async ({ hash = '#/widgets/chat', ready = `!!(${font}) && !!(${select}) && !(${select}).disabled`, observe = false } = {}) => {
    await ok('PUT', '/api/config', { panel: { onboardingDone: true } });
    chrome = await openChromePage(bin, observe ? 'about:blank' : `${base}/${hash}`);
    const c = chrome.cdp;
    if (observe) {
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${observeReconnect.toString()})()` });
      const navigation = await c.send('Page.navigate', { url: `${base}/${hash}` });
      assert.ok(!navigation.errorText, `navigation: ${navigation.errorText}`);
    }
    await wait(c, ready);
    assert.ok(await dom(c, `performance.getEntriesByType('resource').some(x => /\\/assets\\/panel-[A-Za-z0-9_-]+\\.js$/.test(x.name))`), 'actual compiled panel bundle was loaded');
    if (observe) await wait(c, `window.__stateProbe.opens >= 1 && window.__stateProbe.requests.some(r => r.path === '/api/state' && r.opens >= 1 && r.status === 200) && window.__stateProbe.requests.some(r => r.path === '/api/prompter' && r.status === 200)`);
    // Gate a single matching real fetch only AFTER its real HTTP response has arrived.
    await dom(c, `(() => {
      window.__probe = { events: [], gate: null };
      const original = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const response = await original(url, options);
        const method = String(options.method || 'GET').toUpperCase();
        const path = String(url).split('?')[0];
        if (path.startsWith('/api/widgets')) window.__probe.events.push({ method, path, status: response.status, body: options.body || null });
        const gate = window.__probe.gate;
        if (gate && !gate.hit && gate.method === method && gate.path === path) {
          gate.status = response.status; gate.body = await response.clone().json(); gate.hit = true;
          await new Promise(resolve => { gate.release = resolve; });
          if (gate.fail) return new Response(JSON.stringify({error:'fallo simulado'}), {status:503, headers:{'Content-Type':'application/json'}});
        }
        return response;
      };
      return true;
    })()`);
    return c;
  };
  return { dir, base, ok, request, open };
}
async function setValue(c, name, value) {
  await dom(c, `(() => {
    const el = ${field(name)}; if (!el || el.disabled) throw Error('field missing or disabled');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(String(value))});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); return true;
  })()`);
}
async function click(c, text) {
  await wait(c, `!!(${button(text)}) && !(${button(text)}).disabled`);
  await dom(c, `${button(text)}.click()`);
}
async function choose(c, id) {
  await setValue(c, 'Variante de chat', id);
  await wait(c, `${select}?.value === ${q(id)} && !(${select}).disabled`);
}
async function gate(c, method, url, fail = false) {
  await dom(c, `window.__probe.gate = { method:${q(method)}, path:${q(url)}, fail:${fail}, hit:false }; true`);
}
async function hit(c) { await wait(c, `window.__probe.gate?.hit && typeof window.__probe.gate.release === 'function'`); }
async function release(c) { await dom(c, `window.__probe.gate.release(); true`); }
async function seeded(f) {
  const a = (await f.ok('POST', route, { name: 'Alfa' })).variant;
  const b = (await f.ok('POST', route, { name: 'Beta' })).variant;
  const initial = (await f.ok('GET', '/api/widgets')).widgets.chat;
  return { a, b, initial };
}

test('S6/S9: reconnect snapshot cannot undo a newer saved default preview', { timeout: 90000 }, async t => {
  const f = await fixture(t); const c = await f.open({ observe: true });
  const expected = { variant: 'default', layout: 'horizontal', bar: 'Todo guardado',
    source: `${f.base}/widget/chat`, hint: '1832×160', src: '/widget/chat?demo', width: '1832px', height: '160px' };
  const initial = await dom(c, previewState);
  assert.deepEqual(initial, { ...expected, layout: 'vertical', hint: '600×900', width: '600px', height: '900px' });
  assert.equal((await f.ok('GET', '/api/widgets')).widgets.chat.layout, 'vertical');

  // Disconnect the actual panel transport; its real reconnect starts a fresh /api/state.
  await dom(c, `(() => { const p = window.__stateProbe; const s = p.sockets.findLast(x => x.readyState === 1);
    if (!s) throw Error('no open panel socket'); p.gate = { hit: false }; s.close(1000); return true; })()`);
  await wait(c, `window.__stateProbe.opens >= 2 && window.__stateProbe.gate?.hit && typeof window.__stateProbe.gate.release === 'function'`);
  assert.equal(await dom(c, `window.__stateProbe.gate.status`), 200);
  assert.equal(await dom(c, `window.__stateProbe.gate.body.widgets.widgets.chat.layout`), 'vertical', 'actual reconnect snapshot is old');

  await setValue(c, 'Disposición', 'horizontal');
  await sleep(600); // the existing automatic-save debounce is 400 ms
  assert.equal((await f.ok('GET', '/api/widgets')).widgets.chat.layout, 'vertical', 'no autosave');
  assert.equal(await dom(c, `window.__stateProbe.requests.filter(r => r.method === 'PUT' && r.path === '/api/widgets').length`), 0);
  assert.deepEqual(await dom(c, previewState), { ...initial, layout: 'horizontal', bar: 'Cambios sin guardar' });

  await click(c, 'Guardar');
  await wait(c, `${bar}?.textContent.includes('Todo guardado') && window.__stateProbe.frames.some(w => w.widgets?.chat?.layout === 'horizontal')`);
  await wait(c, `(${previewState}).hint === '1832×160' && (${previewState}).width === '1832px' && (${previewState}).height === '160px'`);
  assert.deepEqual(await dom(c, previewState), expected);
  assert.equal((await f.ok('GET', '/api/widgets')).widgets.chat.layout, 'horizontal');
  let writes = await dom(c, `window.__stateProbe.requests.filter(r => r.method === 'PUT' && r.path === '/api/widgets')`);
  assert.equal(writes.length, 1); assert.equal(writes[0].status, 200);
  assert.deepEqual(JSON.parse(writes[0].body), { chat: { layout: 'horizontal' } });

  // Observe every DOM mutation for the full original 8 s bound, including transient reversions.
  // The new timeline request also proves load() continued beyond applying the held snapshot.
  await dom(c, `(() => {
    const p = window.__stateProbe, expected = ${q(expected)};
    p.timelineBefore = p.requests.filter(r => r.path === '/api/timeline').length;
    p.violations = [];
    const check = () => { const actual = ${previewState};
      if (Object.keys(expected).some(k => actual[k] !== expected[k])) p.violations.push(actual); };
    const observer = new MutationObserver(check);
    observer.observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true, attributes: true });
    check(); p.gate.release();
    setTimeout(() => { check(); observer.disconnect(); p.guardDone = true; }, 8000);
    return true;
  })()`);
  await wait(c, `window.__stateProbe.guardDone && window.__stateProbe.gate.delivered && window.__stateProbe.requests.filter(r => r.path === '/api/timeline').length > window.__stateProbe.timelineBefore`);
  assert.deepEqual(await dom(c, `window.__stateProbe.violations`), [], 'preview must remain saved throughout the guard');
  assert.deepEqual(await dom(c, previewState), expected);
  assert.equal((await f.ok('GET', '/api/widgets')).widgets.chat.layout, 'horizontal');
  writes = await dom(c, `window.__stateProbe.requests.filter(r => r.method === 'PUT' && r.path === '/api/widgets')`);
  assert.equal(writes.length, 1); assert.equal(writes[0].status, 200);
});

test('a reconnect without a newer widgets frame loads a missed goal value and still accepts later updates', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const goal = (await f.ok('POST', '/api/goals', { id: 'preserve', title: 'Meta', platform: 'twitch', metric: 'bits', target: 10 })).goal;
  const endpoint = `/api/goals/${goal.id}/bars/${goal.bars[0].id}/set`;
  const c = await f.open({ observe: true, hash: `#/widgets/objetivos/${goal.id}`, ready: `!!document.querySelector('.goal-card .gval')` });
  assert.equal(await dom(c, `document.querySelector('.goal-card .gval').textContent`), '0', 'initial snapshot');
  await dom(c, `(() => { const p = window.__stateProbe; const s = p.sockets.findLast(x => x.readyState === 1);
    if (!s) throw Error('no open panel socket'); p.gate = { hit: false }; p.framesBefore = p.frames.length; s.close(1000); return true; })()`);
  await wait(c, `window.__stateProbe.sockets[0].readyState === 3`);
  assert.equal((await f.ok('POST', endpoint, { value: 7 })).value, 7);
  await wait(c, `window.__stateProbe.opens >= 2 && window.__stateProbe.gate?.hit && typeof window.__stateProbe.gate.release === 'function'`);
  assert.equal(await dom(c, `window.__stateProbe.gate.status`), 200);
  assert.equal(await dom(c, `window.__stateProbe.gate.body.widgets.goals.find(g => g.id === 'preserve').bars[0].value`), 7);
  assert.equal(await dom(c, `window.__stateProbe.frames.length`), await dom(c, `window.__stateProbe.framesBefore`), 'no newer widgets frame');
  assert.equal(await dom(c, `document.querySelector('.goal-card .gval').textContent`), '0');
  await dom(c, `window.__stateProbe.gate.release(); true`);
  await wait(c, `document.querySelector('.goal-card .gval')?.textContent === '7'`);
  assert.equal(await dom(c, `window.__stateProbe.frames.length`), await dom(c, `window.__stateProbe.framesBefore`));
  assert.equal((await f.ok('POST', endpoint, { value: 9 })).value, 9);
  await wait(c, `window.__stateProbe.frames.some(w => w.goals?.some(g => g.id === 'preserve' && g.bars[0].value === 9)) && document.querySelector('.goal-card .gval')?.textContent === '9'`);
  assert.equal((await f.ok('GET', '/api/widgets')).goals.find(g => g.id === goal.id).bars[0].value, 9);
});

test('S2/S3/S6/S9: delayed save stays on its id, preserves newer edit and external sibling', { timeout: 90000 }, async t => {
  const f = await fixture(t); const { a, b, initial } = await seeded(f); const c = await f.open();
  await choose(c, a.id); await setValue(c, 'Tamaño de letra', 39);
  await gate(c, 'PUT', `${route}/${a.id}`); await click(c, 'Guardar'); await hit(c);
  assert.equal(await dom(c, 'window.__probe.gate.status'), 200);
  assert.equal(await dom(c, `${select}.disabled`), true, 'selection cannot move during save');
  assert.equal((await f.ok('GET', route)).find(x => x.id === a.id).fontSize, 39);
  await setValue(c, 'Tamaño de letra', 41); // edit after click while the first response is held
  await f.ok('PUT', `${route}/${b.id}`, { name: 'Beta actualizada', fontSize: 47 });
  await wait(c, `Array.from(${select}.options).some(o => o.value === ${q(b.id)} && o.textContent === 'Beta actualizada')`);
  await release(c);
  await wait(c, `${bar}?.textContent.includes('Cambios sin guardar') && ${font}?.value === '41'`);
  assert.equal(await dom(c, `${select}.disabled`), true, 'newer draft still blocks selection');
  let variants = await f.ok('GET', route);
  assert.deepEqual(variants.find(x => x.id === a.id), { ...a, fontSize: 39 });
  assert.deepEqual(variants.find(x => x.id === b.id), { ...b, name: 'Beta actualizada', fontSize: 47 });
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, initial);
  await click(c, 'Guardar'); await wait(c, `${bar}?.textContent.includes('Todo guardado')`);
  variants = await f.ok('GET', route);
  assert.deepEqual(variants.find(x => x.id === a.id), { ...a, fontSize: 41 });
  assert.deepEqual(variants.find(x => x.id === b.id), { ...b, name: 'Beta actualizada', fontSize: 47 });
  const writes = await dom(c, `window.__probe.events.filter(x => x.method === 'PUT')`);
  assert.deepEqual(writes.map(x => x.path), [`${route}/${a.id}`, `${route}/${a.id}`]);
  assert.deepEqual(writes.map(x => JSON.parse(x.body)), [{fontSize:39}, {fontSize:41}]);
  await choose(c, b.id); assert.equal(await dom(c, `${font}.value`), '47');
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, initial);
});

test('S3/S6/S9: an old list GET cannot undo newer widgets SSE', { timeout: 90000 }, async t => {
  const f = await fixture(t); const { a, b, initial } = await seeded(f); const c = await f.open();
  await gate(c, 'GET', route); await setValue(c, 'Variante de chat', a.id); await hit(c);
  const old = await dom(c, 'window.__probe.gate.body');
  assert.equal(old.find(x => x.id === b.id).name, 'Beta', 'captured response is genuinely stale');
  await f.ok('PUT', `${route}/${b.id}`, { name: 'Beta nueva', fontSize: 44 });
  await wait(c, `Array.from(${select}.options).some(o => o.value === ${q(b.id)} && o.textContent === 'Beta nueva')`);
  await release(c); await wait(c, `${select}?.value === ${q(a.id)} && !(${select}).disabled`);
  assert.equal(await dom(c, `Array.from(${select}.options).find(o => o.value === ${q(b.id)}).textContent`), 'Beta nueva');
  await choose(c, b.id); assert.equal(await dom(c, `${font}.value`), '44');
  const variants = await f.ok('GET', route);
  assert.deepEqual(variants.find(x => x.id === a.id), a);
  assert.deepEqual(variants.find(x => x.id === b.id), { ...b, name: 'Beta nueva', fontSize: 44 });
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, initial);
});

test('S3/S6/S9: externally deleted variant rejects save without losing draft or changing stored bytes', { timeout: 90000 }, async t => {
  const f = await fixture(t); const { a, b, initial } = await seeded(f); const c = await f.open();
  await choose(c, a.id); await setValue(c, 'Tamaño de letra', 49);
  await f.ok('DELETE', `${route}/${a.id}`);
  await wait(c, `Array.from(document.querySelectorAll('[role="alert"]')).some(e => e.textContent.includes('La variante se borró desde otro lugar'))`);
  assert.equal(await dom(c, `${font}.value`), '49');
  assert.equal(await dom(c, `${select}.value`), a.id);
  assert.equal(await dom(c, `${select}.disabled`), true);
  const file = path.join(f.dir, 'config.json'); const before = await sha(file);
  await gate(c, 'PUT', `${route}/${a.id}`); await click(c, 'Guardar'); await hit(c);
  assert.equal(await dom(c, 'window.__probe.gate.status'), 404);
  assert.equal(await dom(c, 'window.__probe.gate.body.error'), `No existe la variante «${a.id}»`);
  assert.equal(await sha(file), before, 'rejected save leaves config byte-identical');
  await release(c);
  await wait(c, `${bar}?.textContent.includes('Cambios sin guardar')`);
  assert.equal(await dom(c, `${font}.value`), '49');
  assert.equal(await dom(c, `${select}.value`), a.id);
  assert.equal(await dom(c, `${select}.disabled`), true);
  assert.equal(await sha(file), before);
  assert.deepEqual(await f.ok('GET', route), [b]);
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, initial);
  await click(c, 'Descartar'); await wait(c, `${select}?.value === 'default' && !(${select}).disabled`);
});

test('S3/S6/S9: successful create and failed refresh cannot invite a duplicate', { timeout: 90000 }, async t => {
  const f = await fixture(t); const initial = (await f.ok('GET', '/api/widgets')).widgets.chat; const c = await f.open();
  await click(c, '+ Nueva variante'); await setValue(c, 'Nombre de la variante', 'Gamma');
  await gate(c, 'GET', route, true); await click(c, 'Crear variante'); await hit(c);
  assert.equal(await dom(c, 'window.__probe.gate.status'), 200, 'real list response captured before simulated failure');
  const created = await f.ok('GET', route); assert.equal(created.length, 1); assert.equal(created[0].name, 'Gamma');
  const file = path.join(f.dir, 'config.json'); const before = await sha(file);
  await release(c);
  await wait(c, `Array.from(document.querySelectorAll('[role="alert"]')).some(e => e.textContent.includes('La variante se creó, pero no se pudo actualizar la lista. Reintenta cargarla.'))`);
  assert.equal(await dom(c, `!!(${button('Crear variante')})`), false, 'creation form is closed');
  assert.equal(await dom(c, `${button('+ Nueva variante')}.disabled`), true);
  assert.equal(await dom(c, `${select}.value`), created[0].id);
  assert.equal(await sha(file), before, 'failed refresh did not alter stored bytes');
  await click(c, 'Reintentar'); await wait(c, `${select}?.value === ${q(created[0].id)} && !(${select}).disabled`);
  assert.equal(await dom(c, `window.__probe.events.filter(e => e.method === 'POST' && e.path === ${q(route)}).length`), 1);
  assert.deepEqual(await f.ok('GET', route), created);
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, initial);
});
