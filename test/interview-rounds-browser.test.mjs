// Interview round management, JSON import and live controls (#295).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const PACK = {
  version: 1, id: 'rondas', title: 'Conversación', guest: { name: 'Ana' },
  rounds: [
    { id: 'inicio', title: 'Inicio', items: [
      { id: 'q1', question: 'Primera pregunta', notes: 'NOTA PRIVADA', aprobado: true, media: { type: 'image', file: 'foto.jpg' } },
      { id: 'q2', question: 'Sin aprobar', aprobado: false },
    ] },
    { id: 'final', title: 'Final', items: [{ id: 'q3', question: 'Última pregunta', aprobado: true }] },
  ],
};
const q = JSON.stringify;
const round = id => `document.querySelector('[data-interview-round="${id}"]')`;
const item = id => `document.querySelector('[data-interview-item="${id}"]')`;
const outline = id => `document.querySelector('[data-interview-outline-item="${id}"]')`;
const field = (id, name) => `${item(id)}.querySelector('[data-field="${name}"]')`;
const button = text => `[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === ${q(text)})`;
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const click = (c, expression) => clickWhen(c, expression);
const set = (c, expression, value) => dom(c, `(() => {
  const el = ${expression}; if (!el) throw Error('missing field');
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(value)});
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true;
})()`);
const selectFile = (c, value) => dom(c, `(() => {
  const el = document.querySelector('[data-interview-import]'), dt = new DataTransfer();
  dt.items.add(new File([${q(JSON.stringify(value))}], 'pack.json', { type: 'application/json' }));
  el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true })); return true;
})()`);

async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-interview-rounds-'));
  let app, chrome, widget;
  t.after(() => closeAll(() => widget && closeChrome(widget), () => chrome && closeChrome(chrome), async () => {
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
    await waitDom(c, `document.querySelector('main h1')?.textContent.trim() === 'Entrevista'`, { timeoutMs: 20000 });
    return c;
  };
  const openWidget = async () => {
    widget = await openChromePage(bin, `${base}/widget/interview`);
    await waitDom(widget.cdp, `!!document.querySelector('#root') && !!document.querySelector('#text')`, { timeoutMs: 15000 });
    return widget.cdp;
  };
  return { base, call, open, openWidget };
}

test('S7: create, rename, reorder and delete rounds and move a question in the draft', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open('#/entrevista/rondas');
  await waitDom(c, `!!document.querySelector('[data-interview-editor]')`, { timeoutMs: 12000 });
  assert.ok(await dom(c, `!!(${button('+ Añadir ronda')})`), 'the editor can create rounds');
  const before = (await f.call('GET', '/api/interviews/rondas')).interview;
  await click(c, button('+ Añadir ronda'));
  const order = `[...document.querySelectorAll('[data-interview-round]')].map(x => x.dataset.interviewRound)`;
  await waitDom(c, `${order}.length === 3`, { timeoutMs: 12000 });
  const added = (await dom(c, order))[2];
  await click(c, `${round(added)}.querySelector('[data-round-menu] summary')`);
  await set(c, `${round(added)}.querySelector('[data-round-field="title"]')`, 'Ronda nueva');
  await click(c, `${round('inicio')}.querySelector('[data-round-menu] summary')`);
  await set(c, `${round('inicio')}.querySelector('[data-round-field="title"]')`, 'Inicio editado');
  await click(c, `${round(added)}.querySelector('[data-round-act="up"]')`);
  await click(c, `${round(added)}.querySelector('[data-round-act="up"]')`);
  assert.deepEqual(await dom(c, order), [added, 'inicio', 'final']);
  assert.equal(await dom(c, `${round(added)}.querySelector('[data-round-act="up"]').disabled`), true);
  assert.equal(await dom(c, `${round('final')}.querySelector('[data-round-act="down"]').disabled`), true);
  await click(c, outline('q1'));
  await set(c, field('q1', 'move-round'), added);
  await waitDom(c, `!!${round(added)}.querySelector('[data-interview-outline-item="q1"]')`, { timeoutMs: 12000 });
  await click(c, `${round('final')}.querySelector('[data-round-menu] summary')`);
  await dom(c, `window.confirm = () => false; true`);
  await click(c, `${round('final')}.querySelector('[data-round-act="delete"]')`);
  assert.ok(await dom(c, `!!${round('final')}`), 'cancelling deletion keeps the round and its questions');
  await dom(c, `window.confirm = () => true; true`);
  await click(c, `${round('final')}.querySelector('[data-round-act="delete"]')`);
  assert.equal(await dom(c, `!!${round('final')}`), false);
  assert.deepEqual((await f.call('GET', '/api/interviews/rondas')).interview, before, 'round operations are not autosaved');
  await click(c, `document.querySelector('.lv-savebar button:last-child')`);
  await waitDom(c, `!document.querySelector('.lv-savebar.is-open')`, { timeoutMs: 12000 });
  const saved = (await f.call('GET', '/api/interviews/rondas')).interview;
  assert.deepEqual(saved.rounds.map(x => [x.id, x.title]), [[added, 'Ronda nueva'], ['inicio', 'Inicio editado']]);
  assert.deepEqual(saved.rounds.map(x => x.items.map(it => it.id)), [['q1'], ['q2']]);
  assert.equal(saved.rounds[0].items[0].notes, 'NOTA PRIVADA');
});

test('S7: import valid and invalid JSON packs, retaining stored data on rejection', { timeout: 90000 }, async t => {
  const f = await setup(t); if (!f) return;
  const c = await f.open('#/entrevista');
  assert.ok(await dom(c, `!!document.querySelector('[data-interview-import]')`), 'the panel provides a JSON pack picker');
  const before = await f.call('GET', '/api/interviews');
  const invalid = { ...PACK, id: 'importada', title: 'Importada', rounds: [{ ...PACK.rounds[0], items: [{ ...PACK.rounds[0].items[0], question: '' }] }] };
  await selectFile(c, invalid);
  await waitDom(c, `!!document.querySelector('[data-interview-import-error]')`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `document.querySelector('[data-interview-import-error]').textContent.trim()`), 'Paquete de entrevista no válido: rounds[0].items[0].question: no puede estar vacío');
  assert.deepEqual(await f.call('GET', '/api/interviews'), before, 'a rejected pack changes neither interviews nor active ids');
  const valid = { ...PACK, id: 'importada', title: 'Importada' };
  await selectFile(c, valid);
  await waitDom(c, `document.querySelector('.lv-list')?.textContent.includes('Importada')`, { timeoutMs: 12000 });
  assert.equal(await dom(c, `!!document.querySelector('[data-interview-import-error]')`), false);
  assert.deepEqual((await f.call('GET', '/api/interviews/importada')).interview, valid);
});

test('S7/S8: select the detail interview and drive only its approved items in the widget', { timeout: 120000 }, async t => {
  const f = await setup(t); if (!f) return;
  await f.call('POST', '/api/interviews/import', { ...PACK, id: 'otra', title: 'Otra entrevista' });
  await f.call('POST', '/api/interviews/select', { id: 'otra', itemId: 'q1' });
  const c = await f.open('#/entrevista/rondas');
  await waitDom(c, `!!document.querySelector('[data-interview-editor]')`, { timeoutMs: 12000 });
  const head = `document.querySelector('.lv-slide .lv-shead')`;
  assert.ok(await dom(c, `!!${head}.querySelector('[data-interview-select]')`), 'the detail can select its own interview');
  assert.equal(await dom(c, `${head}.querySelectorAll('[data-interview-act]').length`), 4, 'the detail shows its live controls');
  assert.equal(await dom(c, `Array.from(${head}.querySelectorAll('[data-interview-act]')).every(b => b.disabled)`), true, 'controls must not drive a different active interview');
  const widget = await f.openWidget();
  await click(c, `${head}.querySelector('[data-interview-select]')`);
  await waitDom(c, `!!${head}.querySelector('[data-interview-act="next"]') && !${head}.querySelector('[data-interview-act="next"]').disabled`, { timeoutMs: 12000 });
  assert.equal((await f.call('GET', '/api/interview-control')).interviewId, 'rondas');
  assert.equal(await dom(c, `${head}.querySelector('[data-interview-select]').textContent.trim()`), 'Parar entrevista', 'active interviews can be stopped instead of reselected');
  assert.equal(await dom(c, `${head}.querySelector('[data-interview-select]').disabled`), false);
  await click(c, `${head}.querySelector('[data-interview-act="next"]')`);
  await waitDom(widget, `document.querySelector('#text')?.textContent === 'Primera pregunta' && document.querySelector('#root').classList.contains('on')`, { timeoutMs: 12000 });
  await waitDom(c, `${head}.querySelector('[data-interview-progress]')?.textContent === '1 / 2'`, { timeoutMs: 12000 });
  assert.equal(await dom(widget, `document.documentElement.outerHTML.includes('NOTA PRIVADA')`), false);
  await waitDom(widget, `!!document.querySelector('#full img.fg')`, { timeoutMs: 12000 });
  await click(c, `${head}.querySelector('[data-interview-act="media"]')`);
  await waitDom(c, `${head}.querySelector('[data-interview-act="media"]')?.textContent === 'Mostrar media'`, { timeoutMs: 12000 });
  assert.equal((await f.call('GET', '/api/interview-control')).mediaHidden, true);
  await waitDom(widget, `!document.querySelector('#full img.fg')`, { timeoutMs: 12000 });
  await click(c, `${head}.querySelector('[data-interview-act="media"]')`);
  await waitDom(c, `${head}.querySelector('[data-interview-act="media"]')?.textContent === 'Ocultar media'`, { timeoutMs: 12000 });
  await waitDom(widget, `!!document.querySelector('#full img.fg')`, { timeoutMs: 12000 });
  await click(c, `${head}.querySelector('[data-interview-act="next"]')`);
  await waitDom(widget, `document.querySelector('#text')?.textContent === 'Última pregunta'`, { timeoutMs: 12000 });
  await click(c, `${head}.querySelector('[data-interview-act="previous"]')`);
  await waitDom(widget, `document.querySelector('#text')?.textContent === 'Primera pregunta'`, { timeoutMs: 12000 });
  await click(c, `${head}.querySelector('[data-interview-act="hide"]')`);
  await waitDom(widget, `!document.querySelector('#root').classList.contains('on')`, { timeoutMs: 12000 });
  assert.equal((await f.call('GET', '/api/interview-control')).current, null);
});
