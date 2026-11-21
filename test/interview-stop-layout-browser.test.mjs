// Interview dock card and stopping a live interview from the dock or panel (S10/S11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_DOCK } from '../src/dock-layout.mjs';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const PACK = {
  version: 1, id: 'directo', title: 'Conversación con Ana', guest: { name: 'Ana' },
  rounds: [{ id: 'inicio', title: 'Inicio', items: [
    { id: 'q1', question: 'Primera pregunta', notes: 'NOTA PRIVADA UNO', media: { type: 'image', file: 'foto.jpg' }, aprobado: true },
    { id: 'q2', question: 'No aprobada', notes: 'NOTA PRIVADA NO APROBADA', aprobado: false },
    { id: 'q3', question: 'Siguiente pregunta', notes: 'NOTA PRIVADA DOS', aprobado: true },
  ] }],
};
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const card = `document.querySelector('#d-ip-entrevista .d-interview.d-card')`;

async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-interview-stop-layout-'));
  let app; const pages = [];
  t.after(() => closeAll(...pages.map(page => () => closeChrome(page)), async () => {
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
  const dock = structuredClone(DEFAULT_DOCK);
  dock.modules.find(x => x.id === 'interview').enabled = true;
  await call('PUT', '/api/config', { dock, panel: { onboardingDone: true } });
  await call('POST', '/api/interviews/import', PACK);
  const open = async route => {
    const page = await openChromePage(bin, base + route); pages.push(page); return page.cdp;
  };
  return { call, open };
}

test('S10/S11: dock card presents private controls and stopping clears the widget without deleting', { timeout: 120000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open('/dock');
  await waitDom(c, `!!document.querySelector('#d-i-entrevista')`, { timeoutMs: 20000 });
  await clickWhen(c, `document.querySelector('#d-i-entrevista')`);
  await waitDom(c, `!!${card} && /Sin entrevista activa/.test(${card}.textContent)`, { timeoutMs: 12000 });
  assert.match(await dom(c, `${card}.textContent`), /activa.*panel/i);
  assert.equal(await dom(c, `${card}.querySelectorAll('[data-interview-act]').length`), 0);

  const widget = await f.open('/widget/interview');
  await f.call('POST', '/api/interviews/select', { id: 'directo' });
  await waitDom(c, `${card}?.querySelector('[data-interview-progress]')?.textContent === '0 / 2'`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-name]').textContent`), PACK.title);
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-guest]').textContent`), 'Ana');
  assert.deepEqual(await dom(c, `Array.from(${card}.querySelectorAll('[data-interview-section]'), el => el.textContent.trim())`), ['En pantalla', 'Siguiente']);
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-current]').textContent`), 'Nada en pantalla');
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-next]').textContent`), 'Primera pregunta');
  assert.match(await dom(c, `${card}.querySelector('[data-interview-next-notes]').textContent`), /privad.*NOTA PRIVADA UNO/i);
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-act="previous"]').disabled`), true);
  assert.ok(await dom(c, `${card}.querySelector('[data-interview-act="next"]').classList.contains('pri')`));
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-act="media"]').disabled`), true);
  assert.equal(await dom(c, `${card}.querySelector('[data-interview-act="hide"]').disabled`), true);
  assert.deepEqual(await dom(c, `Array.from(${card}.querySelector('[data-interview-goto]').options, o => o.value)`), ['', 'q1', 'q3']);
  assert.ok(await dom(c, `(() => { const h = ${card}.querySelector('.d-card-h'), p = h.querySelector('[data-interview-progress]'); return p.getBoundingClientRect().right > h.getBoundingClientRect().left + h.getBoundingClientRect().width / 2; })()`), 'progress is aligned to the right');
  assert.ok(await dom(c, `(() => { const s = ${card}.querySelector('[data-interview-goto]').getBoundingClientRect(), b = ${card}.getBoundingClientRect(); return s.width >= b.width - 24; })()`), 'go-to fills the card width');
  assert.equal(await dom(c, `document.querySelector('#d-i-entrevista .d-badge').textContent`), '0/2');

  await clickWhen(c, `${card}.querySelector('[data-interview-act="next"]')`);
  await waitDom(widget, `document.querySelector('#text')?.textContent === 'Primera pregunta' && document.querySelector('#root').classList.contains('on')`, { timeoutMs: 12000 });
  await waitDom(c, `${card}.querySelector('[data-interview-current]')?.textContent === 'Primera pregunta'`, { timeoutMs: 12000 });
  assert.match(await dom(c, `${card}.querySelector('[data-interview-notes]').textContent`), /privad.*NOTA PRIVADA UNO/i);
  assert.match(await dom(c, `${card}.querySelector('[data-interview-next-notes]').textContent`), /privad.*NOTA PRIVADA DOS/i);
  assert.equal(await dom(widget, `document.documentElement.outerHTML.includes('NOTA PRIVADA')`), false);
  const before = await f.call('GET', '/api/interviews/directo');
  await clickWhen(c, `${card}.querySelector('[data-interview-act="stop"]')`);
  await waitDom(widget, `!document.querySelector('#root').classList.contains('on')`, { timeoutMs: 12000 });
  await waitDom(c, `/Sin entrevista activa/.test(${card}.textContent)`, { timeoutMs: 12000 });
  const list = await f.call('GET', '/api/interviews');
  assert.equal(list.activeId, ''); assert.equal(list.activeItemId, '');
  assert.equal((await f.call('GET', '/api/interview-control')).active, false);
  assert.deepEqual(await f.call('GET', '/api/interviews/directo'), before);
  assert.equal(await dom(c, `!!document.querySelector('#d-i-entrevista .d-badge')`), false);
});

test('S11/S8: panel selects its own interview, then stops it without deleting or losing the draft', { timeout: 120000 }, async t => {
  const f = await setup(t); if (!f) return;
  await f.call('POST', '/api/interviews/import', { ...PACK, id: 'otra', title: 'Otra' });
  await f.call('POST', '/api/interviews/select', { id: 'otra', itemId: 'q1' });
  const widget = await f.open('/widget/interview');
  const c = await f.open('/#/entrevista/directo');
  await waitDom(c, `!!document.querySelector('[data-interview-editor]')`, { timeoutMs: 20000 });
  const select = `document.querySelector('.lv-shead [data-interview-select]')`;
  assert.equal(await dom(c, `${select}.textContent.trim()`), 'Usar en directo');
  assert.ok(await dom(c, `Array.from(document.querySelectorAll('.lv-shead [data-interview-act]')).every(b => b.disabled)`));
  await clickWhen(c, select);
  await waitDom(c, `${select}?.textContent.trim() === 'Parar entrevista' && !${select}.disabled`, { timeoutMs: 12000 });
  assert.equal((await f.call('GET', '/api/interview-control')).interviewId, 'directo');
  await clickWhen(c, `document.querySelector('.lv-shead [data-interview-act="next"]')`);
  await waitDom(widget, `document.querySelector('#text')?.textContent === 'Primera pregunta' && document.querySelector('#root').classList.contains('on')`, { timeoutMs: 12000 });
  const before = await f.call('GET', '/api/interviews/directo');
  await dom(c, `(() => { const el = document.querySelector('[data-interview-title]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Borrador sin guardar'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await clickWhen(c, select);
  await waitDom(widget, `!document.querySelector('#root').classList.contains('on')`, { timeoutMs: 12000 });
  await waitDom(c, `${select}?.textContent.trim() === 'Usar en directo'`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `document.querySelector('[data-interview-title]').value`), 'Borrador sin guardar');
  assert.equal((await f.call('GET', '/api/interview-control')).active, false);
  const list = await f.call('GET', '/api/interviews');
  assert.equal(list.activeId, ''); assert.equal(list.activeItemId, '');
  assert.deepEqual(list.interviews.map(x => x.id), ['directo', 'otra']);
  assert.deepEqual(await f.call('GET', '/api/interviews/directo'), before);
});
