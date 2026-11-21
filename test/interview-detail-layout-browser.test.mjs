// Detail master-detail layout, draft preview and validation navigation (#295).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const PACK = {
  version: 1, id: 'guion', title: 'Entrevista de prueba', guest: { name: 'Ana', bio: 'Biografía' },
  rounds: [
    { id: 'inicio', title: 'Inicio', items: [
      { id: 'q1', question: 'Primera pregunta', notes: 'NOTA PRIVADA UNO', aprobado: true },
      { id: 'q2', question: 'Segunda pregunta', notes: 'NOTA PRIVADA DOS', aprobado: false },
    ] },
    { id: 'final', title: 'Final', items: [{ id: 'q3', question: 'Última pregunta', aprobado: true }] },
  ],
};
const q = JSON.stringify;
const outline = id => `document.querySelector('[data-interview-outline-item="${id}"]')`;
const item = id => `document.querySelector('[data-interview-item="${id}"]')`;
const field = (id, name) => `${item(id)}?.querySelector('[data-field="${name}"]')`;
const preview = `document.querySelector('[data-interview-preview]')`;
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const click = (c, expression) => clickWhen(c, expression);
const select = (c, id) => click(c, outline(id));
const set = (c, expression, value) => dom(c, `(() => {
  const el = ${expression}; if (!el) throw Error('missing field');
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true;
})()`);

async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-interview-layout-'));
  let app, chrome;
  t.after(() => closeAll(() => chrome && closeChrome(chrome), async () => {
    if (app) {
      for (const name of ['timers', 'teleprompter', 'viewers', 'meld', 'chat']) app[name].stop();
      await app.closeHttp(); await app.interactive.flush(); await app.store.chain;
    }
  }, () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), log: () => {}, ui: 'react' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
  await call('PUT', '/api/config', { panel: { onboardingDone: true } });
  await call('POST', '/api/interviews/import', PACK);
  chrome = await openChromePage(bin, `${base}/#/entrevista/guion`);
  const c = chrome.cdp;
  await waitDom(c, `!!document.querySelector('[data-interview-editor]')`, { timeoutMs: 20000 });
  return { c, base, call };
}

test('S2/S9: selecting an outline question switches the only rendered editor', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const { c, call } = f;
  const before = await call('GET', '/api/interviews/guion');
  await waitDom(c, `!!${outline('q2')}`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `document.querySelectorAll('[data-interview-item]').length`), 1);
  assert.equal(await dom(c, `document.querySelector('.interview-meta .hint').textContent.trim()`), '2 rondas · 3 preguntas · 2 aprobadas');
  assert.equal(await dom(c, `${field('q1', 'question')}?.value`), 'Primera pregunta');
  assert.match(await dom(c, `${outline('q2')}.textContent`), /Sin aprobar/);
  await select(c, 'q2');
  assert.equal(await dom(c, `${outline('q2')}.getAttribute('aria-current')`), 'true');
  assert.equal(await dom(c, `${field('q2', 'question')}?.value`), 'Segunda pregunta');
  assert.equal(await dom(c, `!!${item('q1')}`), false);
  assert.equal(await dom(c, `document.querySelectorAll('[data-interview-item]').length`), 1);
  assert.match(await dom(c, `${item('q2')}.textContent`), /Pregunta 02/i);
  await select(c, 'q3');
  assert.equal(await dom(c, `${field('q3', 'question')}?.value`), 'Última pregunta');
  assert.match(await dom(c, `${item('q3')}.textContent`), /Final/);
  assert.deepEqual(await call('GET', '/api/interviews/guion'), before);
});

test('S5/S6/S8/S9: preview follows the selected draft and media, never private notes', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const { c, call } = f;
  const before = await call('GET', '/api/interviews/guion');
  await waitDom(c, `!!${outline('q2')}`, { timeoutMs: 12000 });
  await select(c, 'q2');
  await set(c, field('q2', 'question'), 'Pregunta del borrador');
  await set(c, field('q2', 'notes'), 'SECRETO DEL BORRADOR');
  assert.match(await dom(c, `document.querySelector('.interview-save-info').textContent`), /2 cambios sin guardar/);
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-question]').textContent`), 'Pregunta del borrador');
  assert.equal(await dom(c, `${preview}.textContent.includes('SECRETO DEL BORRADOR')`), false);
  assert.equal(await dom(c, `${preview}.textContent.includes('NOTA PRIVADA')`), false);
  await set(c, field('q2', 'media-type'), 'image');
  await dom(c, `(() => { const el = ${field('q2', 'media-upload')}, dt = new DataTransfer(); dt.items.add(new File(['image fixture'], 'imagen.png', { type: 'image/png' })); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitDom(c, `${field('q2', 'media-file')}?.value === 'imagen.png'`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-media]').dataset.previewMedia`), 'image');
  assert.match(await dom(c, `${preview}.querySelector('img')?.getAttribute('src')`), /\/media\/imagen\.png/);
  await set(c, field('q2', 'media-type'), 'video');
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-media]').dataset.previewMedia`), 'video');
  await set(c, field('q2', 'media-type'), 'youtube');
  await set(c, field('q2', 'youtube-url'), 'https://youtu.be/dQw4w9WgXcQ');
  await set(c, field('q2', 'youtube-start'), '12');
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-media]').dataset.previewMedia`), 'youtube');
  assert.match(await dom(c, `${preview}.querySelector('[data-preview-source]').textContent`), /YouTube.*12/);
  await set(c, field('q2', 'media-type'), 'post');
  await set(c, field('q2', 'post-author'), '@ana');
  await set(c, field('q2', 'post-text'), 'Texto público');
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-media]').dataset.previewMedia`), 'post');
  assert.match(await dom(c, `${preview}.textContent`), /Texto público/);
  assert.equal(await dom(c, `${preview}.textContent.includes('SECRETO DEL BORRADOR')`), false);
  await select(c, 'q1');
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-question]').textContent`), 'Primera pregunta');
  await select(c, 'q2');
  assert.equal(await dom(c, `${field('q2', 'question')}.value`), 'Pregunta del borrador');
  assert.deepEqual(await call('GET', '/api/interviews/guion'), before);
  await click(c, `document.querySelector('.lv-savebar button:nth-last-child(2)')`);
  await waitDom(c, `!document.querySelector('.lv-savebar.is-open')`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `${preview}.querySelector('[data-preview-question]').textContent`), 'Segunda pregunta');
  assert.deepEqual(await call('GET', '/api/interviews/guion'), before);
});

test('S5/S9: an incomplete source links to the other question and focuses its missing date', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const { c, call } = f;
  const before = await call('GET', '/api/interviews/guion');
  await waitDom(c, `!!${outline('q2')}`, { timeoutMs: 12000 });
  await select(c, 'q2');
  await set(c, field('q2', 'source-url'), 'https://example.com/fuente');
  assert.match(await dom(c, `${outline('q2')}.textContent`), /Fuente incompleta/);
  await select(c, 'q1');
  assert.equal(await dom(c, `document.querySelector('[data-interview-validation-link]')?.textContent.trim()`), '1 error: Fecha de la fuente');
  await click(c, `document.querySelector('[data-interview-validation-link]')`);
  await waitDom(c, `document.activeElement === ${field('q2', 'source-date')}`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `${field('q2', 'source-url')}.value`), 'https://example.com/fuente');
  assert.equal(await dom(c, `location.hash`), '#/entrevista/guion');
  assert.deepEqual(await call('GET', '/api/interviews/guion'), before);
  await set(c, field('q2', 'source-date'), '2026-03-14');
  assert.equal(await dom(c, `!!document.querySelector('[data-interview-validation-link]')`), false);
  await set(c, field('q2', 'source-url'), '');
  assert.equal(await dom(c, `document.querySelector('[data-interview-validation-link]')?.textContent.trim()`), '1 error: URL de la fuente');
  await select(c, 'q1');
  await click(c, `document.querySelector('[data-interview-validation-link]')`);
  await waitDom(c, `document.activeElement === ${field('q2', 'source-url')}`, { timeoutMs: 12000 });
  assert.deepEqual(await call('GET', '/api/interviews/guion'), before);
});

test('S5/S9: rejected server validation retains the draft and links to the exact field', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const { c, call } = f;
  const before = await call('GET', '/api/interviews/guion');
  const counters = await call('GET', '/api/interviews');
  await waitDom(c, `!!${outline('q2')}`, { timeoutMs: 12000 });
  await select(c, 'q2');
  await set(c, field('q2', 'source-url'), 'http://example.com/insegura');
  await set(c, field('q2', 'source-date'), '2026-03-14');
  await select(c, 'q1');
  await click(c, `document.querySelector('.lv-savebar button:last-child')`);
  await waitDom(c, `document.querySelector('[data-interview-error]')?.textContent.includes('rounds[0].items[1].source.url')`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `document.querySelector('[data-interview-validation-link]')?.textContent.trim()`), '1 error: URL de la fuente');
  assert.deepEqual(await call('GET', '/api/interviews/guion'), before);
  assert.deepEqual(await call('GET', '/api/interviews'), counters);
  await click(c, `document.querySelector('[data-interview-validation-link]')`);
  await waitDom(c, `document.activeElement === ${field('q2', 'source-url')}`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `${field('q2', 'source-url')}.value`), 'http://example.com/insegura');
  await set(c, field('q2', 'source-url'), 'https://example.com/segura');
  await click(c, `document.querySelector('.lv-savebar button:last-child')`);
  await waitDom(c, `!document.querySelector('.lv-savebar.is-open')`, { timeoutMs: 12000 });
  assert.deepEqual((await call('GET', '/api/interviews/guion')).interview.rounds[0].items[1].source, { url: 'https://example.com/segura', date: '2026-03-14' });
});

test('S9: narrow view stacks the outline above the selected editor', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const { c } = f;
  await waitDom(c, `!!${outline('q1')}`, { timeoutMs: 12000 });
  const boxes = `(() => { const o = document.querySelector('[data-interview-outline]').closest('.interview-outline').getBoundingClientRect(), e = document.querySelector('[data-interview-item]').getBoundingClientRect(); return { ox: o.x, oy: o.y, ob: o.bottom, ex: e.x, ey: e.y }; })()`;
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  let size = await dom(c, boxes);
  assert.ok(size.ex > size.ox, `desktop editor is to the right: ${JSON.stringify(size)}`);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  size = await dom(c, boxes);
  assert.ok(size.ey >= size.ob, `narrow editor is below outline: ${JSON.stringify(size)}`);
  assert.ok(Math.abs(size.ex - size.ox) < 2, `narrow columns share the left edge: ${JSON.stringify(size)}`);
});
