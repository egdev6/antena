// Interview dock and catalog (#295): real panel/dock, live state and unchanged defaults.
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
  version: 1, id: 'prueba', title: 'Entrevista de prueba', guest: { name: 'Ana' },
  rounds: [{ id: 'r1', title: 'Inicio', items: [
    { id: 'q1', question: 'Primera pregunta', notes: 'NOTA PRIVADA', aprobado: true },
    { id: 'q2', question: 'Sin aprobar', aprobado: false },
  ] }],
};

async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-interview-catalog-'));
  let app, chrome;
  t.after(async () => {
    await closeAll(() => chrome && closeChrome(chrome), async () => {
      if (app) {
        for (const name of ['timers', 'teleprompter', 'viewers', 'meld', 'chat']) app[name].stop();
        await app.closeHttp();
        await app.interactive.flush();
        await app.store.chain;
      }
    }, () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  });
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
  const open = async route => {
    chrome = await openChromePage(bin, base + route);
    return chrome.cdp;
  };
  return { call, open };
}

const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });

test('interview joins the interactive tabs when enabled; default tabs and control remain unchanged', { timeout: 90000 }, async t => {
  const ctx = await setup(t); if (!ctx) return;
  assert.deepEqual((await ctx.call('GET', '/api/config')).dock, DEFAULT_DOCK, 'the dock defaults stay unchanged');
  const c = await ctx.open('/dock');
  await waitDom(c, `!!document.querySelector('#d-i-preguntas')`, { timeoutMs: 20000 });
  const tabLabels = `Array.from(document.querySelectorAll('.d-itabs [role="tab"]'), x => x.firstChild.textContent.trim())`;
  assert.deepEqual(await dom(c, tabLabels), ['Preguntas', 'Tier list', 'Sorteo']);
  assert.ok(await dom(c, `!!document.querySelector('#d-ip-preguntas [aria-label="Añadir una pregunta a mano"]')`), 'existing questions control is retained');

  const dock = structuredClone(DEFAULT_DOCK);
  dock.modules.find(x => x.id === 'interview').enabled = true;
  await ctx.call('PUT', '/api/config', { dock });
  await waitDom(c, `!!document.querySelector('#d-i-entrevista')`, { timeoutMs: 4000 });
  assert.deepEqual(await dom(c, tabLabels), ['Preguntas', 'Tier list', 'Sorteo', 'Entrevista']);
  await waitDom(c, `!!document.querySelector('#d-ip-entrevista .d-card[aria-label="Entrevista"]')`, { timeoutMs: 9000 });
  assert.equal(await dom(c, `document.querySelectorAll('#d-ip-entrevista .d-card[aria-label="Entrevista"]').length`), 1, 'the card is inside the interactive tab');
  assert.equal(await dom(c, `document.querySelectorAll('.d-card[aria-label="Entrevista"]').length`), 1, 'no separate interview module is rendered outside the tab');
  await clickWhen(c, `document.querySelector('#d-i-entrevista')`);
  await waitDom(c, `!document.querySelector('#d-ip-entrevista').hidden && /Sin entrevista activa/.test(document.querySelector('#d-ip-entrevista').textContent)`, { timeoutMs: 9000 });
  assert.equal(await dom(c, `document.querySelectorAll('#d-ip-entrevista [data-interview-act]').length`), 0);

  await ctx.call('POST', '/api/interviews/import', PACK);
  await ctx.call('POST', '/api/interviews/select', { id: 'prueba' });
  await waitDom(c, `document.querySelector('#d-i-entrevista .d-badge')?.textContent === '0/1'`, { timeoutMs: 9000 });
  await clickWhen(c, `document.querySelector('#d-ip-entrevista [data-interview-act="next"]')`);
  await waitDom(c, `document.querySelector('#d-i-entrevista .d-badge')?.textContent === '1/1' && document.querySelector('#d-ip-entrevista [data-interview-current]')?.textContent === 'Primera pregunta'`, { timeoutMs: 9000 });
  assert.match(await dom(c, `document.querySelector('#d-ip-entrevista [data-interview-notes]').textContent`), /NOTA PRIVADA/);
  assert.deepEqual((await ctx.call('GET', '/api/interview-control')).progress, { index: 1, total: 1 });
});

test('interview card is a live-managed widget with accurate counts and live status', { timeout: 90000 }, async t => {
  const ctx = await setup(t); if (!ctx) return;
  const c = await ctx.open('/#/widgets');
  await waitDom(c, `!!document.querySelector('main .lv-groups') && !!document.querySelector('#nav a[href="#/widgets"]')`, { timeoutMs: 20000 });
  const liveGroup = `document.querySelector('main section[aria-label="Se manejan en directo"]')`;
  const layerGroup = `document.querySelector('main section[aria-label="Capas de pantalla"]')`;
  const card = `${liveGroup}.querySelector('a.lv-hit[href="#/entrevista"]')?.closest('.lv-card')`;
  assert.ok(await dom(c, `!!(${card})`), 'the live-managed interview card links to its own page');
  assert.equal(await dom(c, `${layerGroup}.querySelectorAll('a.lv-hit[href="#/widgets/interview"]').length`), 0);
  assert.equal(await dom(c, `${layerGroup}.querySelectorAll('.lv-card').length`), 8);
  assert.equal(await dom(c, `${layerGroup}.querySelector('.lv-group-h .n').textContent`), '8');
  assert.equal(await dom(c, `${liveGroup}.querySelectorAll('.lv-card').length`), 5);
  assert.equal(await dom(c, `${liveGroup}.querySelector('.lv-group-h .n').textContent`), '5');
  assert.match(await dom(c, `document.querySelector('main .view-head .crumb').textContent`), /13 widgets/);
  assert.equal(await dom(c, `document.querySelector('#nav a[href="#/widgets"] .nav-n').textContent`), '13');
  await waitDom(c, `(${card})?.querySelector('.lv-dot')?.textContent.includes('Sin entrevista activa')`, { timeoutMs: 9000 });
  assert.ok(await dom(c, `!!${liveGroup}.querySelector('a.lv-hit[href="#/preguntas"]')`), 'existing live cards remain');
  await ctx.call('POST', '/api/interviews/import', PACK);
  await ctx.call('POST', '/api/interviews/select', { id: 'prueba' });
  await waitDom(c, `(${card})?.querySelector('.lv-dot')?.textContent.includes('Lista · 0 / 1')`, { timeoutMs: 9000 });
  await ctx.call('POST', '/api/interview-control/next');
  await waitDom(c, `(${card})?.querySelector('.lv-dot')?.textContent.includes('En pantalla · 1 / 1')`, { timeoutMs: 9000 });
  assert.doesNotMatch(await dom(c, `(${card}).textContent`), /NOTA PRIVADA/);
  await ctx.call('POST', '/api/interview-control/hide');
  await waitDom(c, `(${card})?.querySelector('.lv-dot')?.textContent.includes('Lista · 0 / 1')`, { timeoutMs: 9000 });
});
