// Issue #74: the Widgets catalog owns the four interactive destinations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const destinations = [
  ['#/preguntas', 'Preguntas'],
  ['#/tierlist', 'Tier list'],
  ['#/sorteo', 'Sorteo'],
  ['#/teleprompter', 'Teleprompter'],
];
const json = JSON.stringify;
const card = route => `document.querySelector(${json(`main .lv-hit[href="${route}"]`)})?.closest('.lv-card')`;
const widgetsTail = `document.querySelector('#nav a[href="#/widgets"] .nav-n')`;

async function setup(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-sidebar-74-'));
  let app, chrome;
  t.after(async () => {
    if (chrome) await closeChrome(chrome);
    if (app) {
      for (const name of ['timers', 'teleprompter', 'viewers', 'meld', 'chat']) app[name].stop();
      await app.closeHttp();
      await app.interactive.flush();
      await app.store.chain;
    }
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, route, body) => {
    const response = await fetch(base + route, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${method} ${route}`);
    return response.json();
  };
  await call('PUT', '/api/config', { panel: { onboardingDone: true } });
  const open = async route => {
    chrome = await openChromePage(bin, base + '/' + route);
    await waitDom(chrome.cdp, `!!document.querySelector('#nav a') && !!document.querySelector('main .view-head')`, { timeoutMs: 15000 });
    return chrome.cdp;
  };
  return { base, call, open };
}

async function view(c, route, title) {
  await evaluateChrome(c, `location.hash = ${json(route)}; true`);
  await waitDom(c, `location.hash === ${json(route)} && document.querySelector('main h1')?.textContent.trim() === ${json(title)}`, { timeoutMs: 12000 });
}

test('sidebar omits the four interactive entries and keeps the other navigation', { timeout: 90000 }, async t => {
  const ctx = await setup(t);
  if (!ctx) return;
  const c = await ctx.open('#/directo');
  const links = await evaluateChrome(c, `Array.from(document.querySelectorAll('#nav a'), a => ({ hash: a.hash, label: a.querySelector('.eg-menu__label')?.textContent.trim() }))`);
  for (const [route, label] of destinations) {
    assert.equal(links.some(link => link.hash === route || link.label === label), false, `${label} is not in the sidebar`);
  }
  assert.deepEqual(links.slice(0, 2).map(link => link.hash), ['#/directo', '#/chat']);
  assert.equal(links.filter(link => link.hash === '#/widgets').length, 1);
});

test('all four views open from Widgets and from direct URLs', { timeout: 90000 }, async t => {
  const ctx = await setup(t);
  if (!ctx) return;
  const c = await ctx.open('#/widgets');
  for (const [route, title] of destinations) {
    await view(c, '#/widgets', 'Widgets');
    assert.equal(await evaluateChrome(c, `!!${card(route)}`), true, `${title} has a catalog card`);
    await evaluateChrome(c, `document.querySelector(${json(`main .lv-hit[href="${route}"]`)}).click(); true`);
    await waitDom(c, `location.hash === ${json(route)} && document.querySelector('main h1')?.textContent.trim() === ${json(title)}`, { timeoutMs: 12000 });
    await c.send('Page.navigate', { url: `${ctx.base}/#/directo` });
    await waitDom(c, `location.hash === '#/directo' && !!document.querySelector('[data-tour="directo-head"]')`, { timeoutMs: 12000 });
    await c.send('Page.navigate', { url: `${ctx.base}/${route}` });
    await waitDom(c, `location.hash === ${json(route)} && document.querySelector('main h1')?.textContent.trim() === ${json(title)}`, { timeoutMs: 12000 });
  }
});

test('interactive routes and nested pages select Widgets, while other pages keep their active entry', { timeout: 90000 }, async t => {
  const ctx = await setup(t);
  if (!ctx) return;
  const c = await ctx.open('#/directo');
  const routes = [
    ...destinations,
    ['#/preguntas/ajustes', 'Preguntas'], ['#/tierlist/nueva', 'Tier list'],
    ['#/sorteo/ajustes', 'Sorteo'], ['#/teleprompter/guiones/nuevo', 'Teleprompter'],
    ['#/widget/questions', 'Preguntas'], ['#/widget/tierlist', 'Tier list'],
    ['#/widget/giveaway', 'Sorteo'], ['#/widget/teleprompter', 'Teleprompter'],
    ['#/widgets', 'Widgets'], ['#/widgets/chat', 'Widgets'],
  ];
  for (const [route, title] of routes) {
    await view(c, route, title);
    const active = await evaluateChrome(c, `Array.from(document.querySelectorAll('#nav a[aria-current]'), a => ({ hash: a.hash, current: a.getAttribute('aria-current'), marked: a.classList.contains('on') }))`);
    assert.deepEqual(active, [{ hash: '#/widgets', current: 'page', marked: true }], route);
  }
  for (const [route, title, expected] of [['#/chat', 'Chat', '#/chat'], ['#/alertas/follow', 'Alertas', '#/alertas']]) {
    await view(c, route, title);
    assert.deepEqual(await evaluateChrome(c, `Array.from(document.querySelectorAll('#nav a[aria-current]'), a => a.hash)`), [expected], route);
  }
});

test('Widgets cards retain live states and the sidebar warns about votes and giveaways', { timeout: 120000 }, async t => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { call } = ctx;
  await call('PUT', '/api/interactive/config', { giveaway: { announceInChat: false } });
  await call('POST', '/api/questions', { text: 'A synthetic question for the queue?' });
  const { tierlist } = await call('POST', '/api/tierlists', { title: 'Test list', items: ['One'] });
  await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'One' });
  await call('POST', '/api/giveaway/open', {});
  await call('POST', '/api/giveaway/join', { user: 'test-viewer' });
  await call('POST', '/api/teleprompter/scripts', { title: 'Test script', blocks: [{ title: 'One', text: 'word '.repeat(500) }] });
  await call('POST', '/api/teleprompter/control', { action: 'play' });
  const c = await ctx.open('#/widgets');
  await waitDom(c, `${card('#/preguntas')}?.textContent.includes('1 en cola') && ${card('#/tierlist')}?.textContent.includes('Votando') && ${card('#/sorteo')}?.textContent.includes('Abierto · 1') && !!${card('#/teleprompter')}`, { timeoutMs: 12000 });
  const reading = await evaluateChrome(c, `${card('#/teleprompter')}.textContent`);
  assert.match(reading, /Leyendo/, 'the teleprompter card shows its active reading state');
  assert.match(reading, /Solo lo ves tú/, 'the privacy label remains visible');
  assert.deepEqual(await evaluateChrome(c, `({ text: ${widgetsTail}.textContent, live: ${widgetsTail}.classList.contains('is-live'), label: ${widgetsTail}.getAttribute('aria-label') })`),
    { text: '2 activos', live: true, label: 'votación en curso y sorteo abierto' });

  await view(c, '#/chat', 'Chat');
  assert.equal(await evaluateChrome(c, `${widgetsTail}.getAttribute('aria-label')`), 'votación en curso y sorteo abierto', 'the warning remains visible on another view');
  await view(c, '#/widgets', 'Widgets');
  await call('POST', '/api/vote/cancel');
  await waitDom(c, `${widgetsTail}?.textContent === 'sorteo' && ${card('#/tierlist')}?.textContent.includes('En pantalla')`, { timeoutMs: 12000 });
  assert.equal(await evaluateChrome(c, `${widgetsTail}.getAttribute('aria-label')`), 'sorteo abierto');
  assert.equal(await evaluateChrome(c, `${widgetsTail}.classList.contains('is-live')`), true);
  await call('POST', '/api/giveaway/close');
  await waitDom(c, `${widgetsTail}?.textContent === '10' && ${card('#/sorteo')}?.textContent.includes('Cerrado')`, { timeoutMs: 12000 });
  assert.equal(await evaluateChrome(c, `${widgetsTail}.classList.contains('is-live')`), false);
  await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'One' });
  await waitDom(c, `${widgetsTail}?.textContent === 'votando' && ${card('#/tierlist')}?.textContent.includes('Votando')`, { timeoutMs: 12000 });
  assert.equal(await evaluateChrome(c, `${widgetsTail}.getAttribute('aria-label')`), 'votación en curso');
  assert.equal(await evaluateChrome(c, `${widgetsTail}.classList.contains('is-live')`), true);
  await call('POST', '/api/vote/cancel');
  await call('POST', '/api/questions/clear', { all: true });
  await call('POST', '/api/teleprompter/control', { action: 'pause' });
  await waitDom(c, `${widgetsTail}?.textContent === '10' && ${card('#/preguntas')}?.textContent.includes('Cola vacía') && !${card('#/teleprompter')}?.textContent.includes('Leyendo')`, { timeoutMs: 12000 });
  assert.equal(await evaluateChrome(c, `${card('#/teleprompter')}.textContent.includes('Solo lo ves tú')`), true);
});
