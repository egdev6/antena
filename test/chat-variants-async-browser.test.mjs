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
const dom = (c, expr) => evaluateChrome(c, expr, { timeoutMs: 12000 });
const wait = (c, expr) => waitDom(c, expr, { timeoutMs: 12000 });
const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex');

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
  const open = async () => {
    await ok('PUT', '/api/config', { panel: { onboardingDone: true } });
    chrome = await openChromePage(bin, `${base}/#/widgets/chat`);
    const c = chrome.cdp;
    await wait(c, `!!(${font}) && !!(${select}) && !(${select}).disabled`);
    assert.ok(await dom(c, `performance.getEntriesByType('resource').some(x => /\\/assets\\/panel-[A-Za-z0-9_-]+\\.js$/.test(x.name))`), 'actual compiled panel bundle was loaded');
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
