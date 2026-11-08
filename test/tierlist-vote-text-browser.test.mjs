import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function start(t) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return null;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-tier-text-'));
  const pages = [];
  let app;
  t.after(async () => {
    for (const page of pages) await closeChrome(page);
    if (app) { app.timers.stop(); await app.closeHttp(); await app.interactive.flush(); }
    await rm(dataDir, { recursive: true, force: true });
  });
  app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, `${method} ${url}`);
    return response.json();
  };
  const open = async url => { const page = await openChromePage(bin, base + url); pages.push(page); return page.cdp; };
  return { call, open };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(100); }
  assert.fail('timed out waiting for the API update');
}
const setInput = (label, value) => `(() => {
  const input = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

async function reloadTierInputs(c) {
  // Page.reload can be acknowledged while the old document still matches the values.
  await evaluateChrome(c, 'window.__tierVoteBeforeReload = true');
  await c.send('Page.reload');
  await waitDom(c, `window.__tierVoteBeforeReload !== true && document.querySelector('input[aria-label="Texto de voto del tier 1"]')?.value === 'Excellent' && !!document.querySelector('input[aria-label="Texto de voto del tier 2"]')`, { timeoutMs: 12000 });
}

test('tier vote text: reload readiness cannot be satisfied by the previous document', { timeout: 30000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const html = '<input aria-label="Texto de voto del tier 1" value="Excellent"><input aria-label="Texto de voto del tier 2" value="">';
  const chrome = await openChromePage(bin, `data:text/html,${encodeURIComponent(html)}`);
  t.after(() => closeChrome(chrome));
  const real = chrome.cdp;
  await waitDom(real, `document.querySelector('input[aria-label="Texto de voto del tier 1"]')?.value === 'Excellent'`);
  await evaluateChrome(real, 'window.__previousTierDocument = true');
  let release, checked;
  const firstCheck = new Promise(resolve => { checked = resolve; });
  // Model a reload acknowledged before navigation commits, keeping the real old DOM available.
  const c = { ...real, send(method, params) {
    if (method === 'Page.reload') { release = () => real.send(method, params); return Promise.resolve({}); }
    const result = real.send(method, params);
    if (method === 'Runtime.evaluate' && params.expression.includes('Texto de voto del tier 1')) result.then(() => setImmediate(checked));
    return result;
  } };
  let finished = false;
  const reloaded = reloadTierInputs(c).then(() => { finished = true; });
  await firstCheck;
  try {
    assert.equal(finished, false, 'the old inputs must not satisfy reload readiness before navigation commits');
  } finally {
    await release();
    await reloaded;
  }
  assert.equal(await evaluateChrome(real, 'window.__previousTierDocument === undefined'), true);
});

test('tier vote text: panel edits every tier and retains the changes', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { call, open } = ctx;
  await call('PUT', '/api/config', { panel: { onboardingDone: true } });
  const { tierlist } = await call('POST', '/api/tierlists', { title: 'Panel', items: ['One'], tiers: [
    { id: 's', label: 'S', color: '#ff0036' }, { id: 'a', label: 'A', color: '#ff6a3d' },
  ] });
  const c = await open(`/#/tierlist/${tierlist.id}/niveles`);
  await waitDom(c, `document.querySelectorAll('.tiers-ed li').length === 2`, { timeoutMs: 12000 });
  assert.equal(await evaluateChrome(c, `document.querySelectorAll('.tiers-ed input[aria-label^="Texto de voto del tier"]').length`), 2);
  assert.equal(await evaluateChrome(c, `document.querySelector('.tiers-ed').parentElement.textContent.includes('solo se muestra')`), true);
  const tiers = async () => (await call('GET', '/api/interactive')).tierlists.find(l => l.id === tierlist.id).tiers;
  await evaluateChrome(c, setInput('Texto de voto del tier 1', 'Excellent'));
  await until(async () => (await tiers())[0].voteText === 'Excellent');
  await evaluateChrome(c, setInput('Texto de voto del tier 2', 'Good'));
  await until(async () => (await tiers())[1].voteText === 'Good');
  await evaluateChrome(c, setInput('Nombre del tier 1', 'Superior'));
  await until(async () => (await tiers())[0].label === 'Superior');
  assert.deepEqual((await tiers()).map(tier => tier.voteText), ['Excellent', 'Good']);
  await evaluateChrome(c, setInput('Texto de voto del tier 2', ''));
  await until(async () => (await tiers())[1].voteText === '');
  await reloadTierInputs(c);
  assert.equal(await evaluateChrome(c, `document.querySelector('input[aria-label="Texto de voto del tier 2"]').value`), '');
});

test('tier vote text: overlay renders custom text and preserves empty fallbacks', { timeout: 90000 }, async t => {
  const ctx = await start(t);
  if (!ctx) return;
  const { call, open } = ctx;
  const custom = 'Fantastic <img src=x onerror=alert(1)> & "quoted"';
  const { tierlist } = await call('POST', '/api/tierlists', { title: 'Overlay', items: ['One'], tiers: [
    { id: 's', label: 'S', color: '#ff0036', voteText: custom },
    { id: 'a', label: 'A', color: '#ff6a3d', voteText: '' },
    { id: 'b', label: 'B', color: '#ffb547' },
  ] });
  await call('PUT', '/api/interactive/config', { tierlist: { command: '!rank', acceptBare: true } });
  await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'One' });
  const c = await open('/widget/tierlist');
  await waitDom(c, `document.querySelector('#vitem')?.textContent === 'One' && document.querySelectorAll('#bars .bar').length === 3`, { timeoutMs: 12000 });
  const bars = `Array.from(document.querySelectorAll('#bars .bar > span:first-child')).map(e => e.textContent)`;
  const how = `document.querySelector('#how').textContent`;
  assert.deepEqual(await evaluateChrome(c, bars), [custom, 'A', 'B']);
  assert.equal(await evaluateChrome(c, how), `Escribe S (${custom}) A B o !rank S · 0 votos`);
  assert.deepEqual(await evaluateChrome(c, `Array.from(document.querySelectorAll('#rows .tier')).map(e => e.textContent)`), ['S', 'A', 'B']);
  assert.equal(await evaluateChrome(c, `document.querySelectorAll('#bars img, #how img').length`), 0);
  await call('PUT', '/api/interactive/config', { tierlist: { acceptBare: false } });
  await waitDom(c, `${how} === ${JSON.stringify(`Escribe !rank S · S: ${custom} · 0 votos`)}`);
  const fallbackTiers = tierlist.tiers.map(({ voteText, ...tier }) => tier);
  fallbackTiers[0].voteText = '';
  await call('PUT', `/api/tierlists/${tierlist.id}`, { tiers: fallbackTiers });
  await waitDom(c, `${bars}[0] === 'S' && ${how} === 'Escribe !rank S · 0 votos'`);
  assert.deepEqual(await evaluateChrome(c, bars), ['S', 'A', 'B']);
  await call('PUT', '/api/interactive/config', { tierlist: { acceptBare: true } });
  await waitDom(c, `${how} === 'Escribe S A B o !rank S · 0 votos'`);
});
