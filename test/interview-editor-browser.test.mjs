// Interview list and editor (#295): exercise the public panel and HTTP API together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const PACK = {
  version: 1, id: 'preparada', title: 'Entrevista preparada', guest: { name: 'Ana', bio: 'Biografía inicial' },
  rounds: [{ id: 'inicio', title: 'Inicio', items: [
    { id: 'q1', question: 'Pregunta inicial', notes: 'Notas privadas', aprobado: true, source: { url: 'https://example.com/antes', date: '2026-01-01' } },
    { id: 'q2', question: 'Pregunta de vídeo', aprobado: false },
    { id: 'q3', question: 'Pregunta de YouTube', aprobado: true },
    { id: 'q4', question: 'Pregunta de post', aprobado: true },
  ] }],
};
const q = JSON.stringify;
const item = id => `document.querySelector('[data-interview-item="${id}"]')`;
const outline = id => `document.querySelector('[data-interview-outline-item="${id}"]')`;
const field = (id, key) => `${item(id)}.querySelector('[data-field="${key}"]')`;
const button = text => `[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === ${q(text)})`;

async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-interview-editor-'));
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
  const open = async route => {
    chrome = await openChromePage(bin, `${base}/${route}`);
    const c = chrome.cdp;
    await waitDom(c, `!!document.querySelector('main .view-head')`, { timeoutMs: 20000 });
    assert.equal(await evaluateChrome(c, `document.querySelector('main h1')?.textContent.trim()`), 'Entrevista');
    return c;
  };
  return { base, call, open };
}
const dom = (c, expr) => evaluateChrome(c, expr, { timeoutMs: 12000 });
const click = (c, expr) => clickWhen(c, expr);
const set = (c, expr, value) => dom(c, `(() => {
  const el = ${expr}; if (!el) throw Error('missing field');
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true;
})()`);
const save = async c => {
  await click(c, `document.querySelector('.lv-savebar button:last-child')`);
  await waitDom(c, `!document.querySelector('.lv-savebar.is-open')`, { timeoutMs: 12000 });
};

test('S2/S4: list, live refresh and creation show the interview without losing a rejected draft', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open('#/entrevista');
  await waitDom(c, `document.querySelector('.lv-list')?.textContent.includes('Entrevista preparada')`, { timeoutMs: 12000 });
  assert.match(await dom(c, `document.querySelector('.lv-list').textContent`), /Ana/);
  assert.ok(await dom(c, `!!document.querySelector('.lv-list a[href="#/entrevista/preparada"]')`));
  assert.ok(await dom(c, `!!document.querySelector('#nav a[href="#/widgets"][aria-current="page"]')`));
  await f.call('POST', '/api/interviews/select', { id: 'preparada' });
  await waitDom(c, `document.querySelector('.lv-list a[href="#/entrevista/preparada"]')?.closest('tr').textContent.includes('Lista')`, { timeoutMs: 12000 });
  await f.call('POST', '/api/interview-control/next');
  await waitDom(c, `document.querySelector('.lv-list a[href="#/entrevista/preparada"]')?.closest('tr').textContent.includes('En pantalla')`, { timeoutMs: 12000 });
  await f.call('POST', '/api/interviews', { title: 'Creada desde la API', guest: { name: 'Otra persona' } });
  await waitDom(c, `document.querySelector('.lv-list')?.textContent.includes('Creada desde la API')`, { timeoutMs: 12000 });
  const before = await f.call('GET', '/api/interviews');
  await click(c, button('+ Nueva entrevista'));
  await set(c, `document.querySelector('[data-interview-create-title]')`, 'Nueva desde el panel');
  await click(c, button('Crear entrevista'));
  await waitDom(c, `document.querySelector('[data-interview-create-error]')?.textContent.includes('guest.name')`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `document.querySelector('[data-interview-create-title]').value`), 'Nueva desde el panel');
  assert.deepEqual(await f.call('GET', '/api/interviews'), before, 'a rejected create changes nothing');
  await set(c, `document.querySelector('[data-interview-create-guest]')`, 'Bea');
  await click(c, button('Crear entrevista'));
  await waitDom(c, `location.hash.startsWith('#/entrevista/') && !!document.querySelector('[data-interview-editor]')`, { timeoutMs: 12000 });
  const created = (await f.call('GET', '/api/interviews')).interviews.find(x => x.title === 'Nueva desde el panel');
  assert.equal(created.guest, 'Bea');
  assert.equal(await dom(c, `location.hash`), `#/entrevista/${created.id}`);
  await dom(c, `location.hash = '#/entrevista'; true`);
  await waitDom(c, `document.querySelector('.lv-list')?.textContent.includes('Nueva desde el panel')`, { timeoutMs: 12000 });
});

test('S5: whole-interview draft, exact field error, retry and private notes', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open('#/entrevista/preparada');
  await waitDom(c, `!!document.querySelector('[data-interview-editor]') && !!${item('q1')}`, { timeoutMs: 12000 });
  assert.ok(await dom(c, `!!document.querySelector('#nav a[href="#/widgets"][aria-current="page"]')`));
  const before = (await f.call('GET', '/api/interviews/preparada')).interview;
  await set(c, `document.querySelector('[data-interview-title]')`, 'Título editado');
  await set(c, `document.querySelector('[data-interview-guest]')`, 'Invitada editada');
  await set(c, `document.querySelector('[data-interview-bio]')`, 'Biografía editada');
  await set(c, field('q1', 'question'), 'Pregunta editada');
  await set(c, field('q1', 'notes'), 'Nota privada editada');
  await set(c, field('q1', 'source-url'), 'http://example.com/insegura');
  await set(c, field('q1', 'source-date'), '2026-03-14');
  await click(c, field('q1', 'approved'));
  await dom(c, `window.confirm = () => true; true`);
  await click(c, outline('q4'));
  await click(c, field('q4', 'delete'));
  await click(c, `document.querySelector('[data-interview-round="inicio"] [data-round-menu] summary')`);
  await click(c, button('+ Añadir pregunta'));
  await set(c, `document.querySelector('[data-interview-item] [data-field="question"]')`, 'Pregunta añadida');
  await click(c, outline('q1'));
  assert.deepEqual((await f.call('GET', '/api/interviews/preparada')).interview, before, 'nothing is saved on input');
  await click(c, `document.querySelector('.lv-savebar button:last-child')`);
  await waitDom(c, `document.querySelector('[data-interview-error]')?.textContent.includes('rounds[0].items[0].source.url')`, { timeoutMs: 12000 });
  assert.deepEqual((await f.call('GET', '/api/interviews/preparada')).interview, before, 'rejected PUT changes nothing');
  assert.equal(await dom(c, `${field('q1', 'question')}.value`), 'Pregunta editada');
  assert.equal(await dom(c, `${field('q1', 'notes')}.value`), 'Nota privada editada');
  assert.equal(await dom(c, `document.querySelector('[data-interview-title]').value`), 'Título editado');
  assert.equal(await dom(c, `${field('q1', 'approved')}.checked`), false);
  await set(c, field('q1', 'source-url'), 'https://example.com/nueva');
  await save(c);
  const saved = (await f.call('GET', '/api/interviews/preparada')).interview;
  assert.equal(saved.title, 'Título editado');
  assert.deepEqual(saved.guest, { name: 'Invitada editada', bio: 'Biografía editada' });
  assert.equal(saved.rounds[0].items[0].question, 'Pregunta editada');
  assert.equal(saved.rounds[0].items[0].notes, 'Nota privada editada');
  assert.equal(saved.rounds[0].items[0].aprobado, false);
  assert.deepEqual(saved.rounds[0].items[0].source, { url: 'https://example.com/nueva', date: '2026-03-14' });
  assert.equal(saved.rounds[0].items.some(x => x.id === 'q4'), false);
  assert.equal(saved.rounds[0].items.at(-1).question, 'Pregunta añadida');
});

test('S6: choose and upload local media and edit YouTube and post fields in the draft', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const uploaded = await fetch(`${f.base}/api/media/upload?name=existente.png`, { method: 'POST', body: 'image fixture' });
  assert.equal(uploaded.status, 200);
  const c = await f.open('#/entrevista/preparada');
  await waitDom(c, `!!${outline('q4')}`, { timeoutMs: 12000 });
  const before = (await f.call('GET', '/api/interviews/preparada')).interview;
  await set(c, field('q1', 'media-type'), 'image');
  await waitDom(c, `!!${field('q1', 'media-file')}?.querySelector('option[value="existente.png"]')`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `${field('q1', 'media-type')}.value`), 'image');
  assert.deepEqual(await dom(c, `Array.from(${field('q1', 'media-file')}.options, option => option.value)`), ['', 'existente.png'], 'the existing image is selectable');
  await set(c, field('q1', 'media-file'), 'existente.png');
  await click(c, outline('q2'));
  await set(c, field('q2', 'media-type'), 'video');
  await dom(c, `(() => { const el = ${field('q2', 'media-upload')}, dt = new DataTransfer(); dt.items.add(new File(['video fixture'], 'subido.mp4', { type: 'video/mp4' })); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitDom(c, `${field('q2', 'media-file')}?.value === 'subido.mp4'`, { timeoutMs: 12000 });
  await click(c, outline('q3'));
  await set(c, field('q3', 'media-type'), 'youtube');
  await set(c, field('q3', 'youtube-url'), 'https://youtu.be/dQw4w9WgXcQ');
  await set(c, field('q3', 'youtube-start'), '12');
  await click(c, outline('q4'));
  await set(c, field('q4', 'media-type'), 'post');
  await set(c, field('q4', 'post-author'), '@ana');
  await set(c, field('q4', 'post-text'), 'Un post de prueba');
  await set(c, field('q4', 'post-date'), '2026-05-20');
  await set(c, field('q4', 'post-url'), 'https://example.com/post');
  assert.deepEqual((await f.call('GET', '/api/interviews/preparada')).interview, before);
  await save(c);
  const saved = (await f.call('GET', '/api/interviews/preparada')).interview.rounds[0].items;
  assert.deepEqual(saved[0].media, { type: 'image', file: 'existente.png' });
  assert.deepEqual(saved[1].media, { type: 'video', file: 'subido.mp4' });
  assert.deepEqual(saved[2].media, { type: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ', startMinute: 12 });
  assert.deepEqual(saved[3].media, { type: 'post', author: '@ana', text: 'Un post de prueba', date: '2026-05-20', url: 'https://example.com/post' });
  assert.ok((await f.call('GET', '/api/media')).some(x => x.name === 'subido.mp4'));
});

test('S2: delete asks for confirmation and refreshes the list', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open('#/entrevista/preparada');
  await waitDom(c, `!!document.querySelector('[data-interview-editor]')`, { timeoutMs: 12000 });
  await dom(c, `window.confirm = () => false; true`);
  await click(c, button('Borrar entrevista…'));
  assert.ok((await f.call('GET', '/api/interviews')).interviews.some(x => x.id === 'preparada'));
  await dom(c, `window.confirm = () => true; true`);
  await click(c, button('Borrar entrevista…'));
  await waitDom(c, `location.hash === '#/entrevista' && !document.querySelector('.lv-list')?.textContent.includes('Entrevista preparada')`, { timeoutMs: 12000 });
  assert.equal((await f.call('GET', '/api/interviews')).interviews.some(x => x.id === 'preparada'), false);
});
