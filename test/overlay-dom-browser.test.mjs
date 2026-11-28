// #365: the viewers and credits widgets edit their DOM in place instead of rebuilding it with innerHTML.
// The tests keep references to nodes, drive the real widget through the server's own events and check
// that the same nodes are still on screen (and that their animations were not restarted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Real server + one Chrome page. `open(url)` navigates and waits until that page's widget client connected. */
async function withApp(t, run) {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-overlay-dom-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(r.ok, true, `${method} ${url}`);
    return r.json();
  };
  let chrome;
  try {
    chrome = await openChromePage(bin, 'about:blank');
    const c = chrome.cdp, ev = expression => evaluateChrome(c, expression);
    const widgetClients = () => [...app.bus.clients].filter(client => client.kind === 'widget');
    const open = async url => {
      const known = new Set(widgetClients());
      await c.send('Page.navigate', { url: base + url });
      for (let i = 0; i < 200 && !widgetClients().some(client => !known.has(client)); i++) await sleep(50);
      assert.ok(widgetClients().some(client => !known.has(client)), `the widget at ${url} did not connect`);
    };
    await run({ app, call, c, ev, open });
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => {
      for (const name of ['timers', 'teleprompter', 'viewers', 'meld', 'chat']) app[name].stop();
      app.server.closeAllConnections();
    }, () => app.closeHttp());
  }
}

// ---------- viewers ----------
const platform = (current, peak = current) => ({ live: current > 0, current, peak, record: peak });
const send = (app, twitch, youtube) => app.bus.send('viewers', { twitch, youtube }, ['widget']);
const CARDS = `[...document.querySelectorAll('#root .item')]`;
const ID = `(card => [...card.classList].find(name => name.startsWith('item-')).slice(5))`;
const BIG = id => `document.querySelector('.item-${id} .big')?.textContent`;
// The first reading animates every card (0 → n): wait until those bumps ended and cleared themselves.
const settle = async (c, ev) => {
  await waitDom(c, `document.getAnimations().length === 0`, { timeoutMs: 8000 });
  await ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
};

test('viewers: an event on one platform keeps every card node and animates only the cards that changed', { timeout: 90000 }, t => withApp(t, async ({ app, call, c, ev, open }) => {
  await open('/widget/viewers?peak=1');
  await waitDom(c, `${CARDS}.length === 3`, { timeoutMs: 12000 });
  send(app, platform(100, 120), platform(50, 60));
  await waitDom(c, `${BIG('twitch')} === '100'`);
  await settle(c, ev);
  // From here a bump lasts two minutes, so "still running" cannot race the one-second default.
  const css = '.item.up .big{animation-duration:120s}';
  await call('PUT', '/api/widgets', { viewers: { css } });
  await waitDom(c, `[...document.querySelectorAll('style')].some(style => style.textContent === ${JSON.stringify(css)})`);
  await ev(`(() => {
    window.__kept = ${CARDS}.map(card => [card, ...card.children]);
    window.__log = [];
    const where = node => { const el = node.nodeType === 1 ? node : node.parentElement; const card = el?.closest('.item'); return card ? (${ID})(card) : el?.id || el?.tagName; };
    new MutationObserver(records => { for (const r of records) window.__log.push(where(r.target)); })
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    return true; })()`);

  // twitch 100 → 130; youtube sends exactly what it had.
  send(app, platform(130), platform(50, 60));
  await waitDom(c, `${BIG('twitch')} === '130'`);
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify(window.__kept.map(([card, ...kids], i) => { const now = ${CARDS}[i];
    return card === now && kids.length === now.children.length && kids.every((kid, j) => kid === now.children[j]); }))`)),
  [true, true, true], 'every card and its children are still the same nodes');
  assert.deepEqual([...new Set(JSON.parse(await ev(`JSON.stringify(window.__log)`)))].sort(), ['total', 'twitch'],
    'only the cards whose value changed were written to; nothing else in the document');
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify(Object.fromEntries(${CARDS}.map(card => [(${ID})(card), {
    up: card.classList.contains('up'), animations: card.getAnimations({ subtree: true }).map(a => a.animationName),
    big: card.querySelector('.big').textContent, extra: card.querySelector('.extra')?.textContent ?? null }])))`)), {
    twitch: { up: true, animations: ['up'], big: '130', extra: 'Pico 130' },
    youtube: { up: false, animations: [], big: '50', extra: 'Pico 60' },
    total: { up: true, animations: ['up'], big: '180', extra: 'Pico 190' },
  });

  // Another increase while the bump still runs restarts it, as a fresh card used to.
  await ev(`window.__bump = document.querySelector('.item-twitch .big').getAnimations()[0]; true`);
  send(app, platform(140), platform(50, 60));
  await waitDom(c, `${BIG('twitch')} === '140'`);
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify((() => { const [now] = document.querySelector('.item-twitch .big').getAnimations();
    return { restarted: now !== window.__bump, state: now?.playState }; })())`)), { restarted: true, state: 'running' });

  // An event on youtube neither stops nor restarts the bump that twitch is still playing.
  await ev(`window.__bump = document.querySelector('.item-twitch .big').getAnimations()[0]; true`);
  send(app, platform(140), platform(55, 60));
  await waitDom(c, `${BIG('youtube')} === '55'`);
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify({ same: document.querySelector('.item-twitch .big').getAnimations()[0] === window.__bump,
    up: ${CARDS}.filter(card => card.classList.contains('up')).map(${ID}).sort() })`)), { same: true, up: ['total', 'twitch', 'youtube'] });
}));

test('viewers: an increase plays its bump once and .up goes away when it ends', { timeout: 90000 }, t => withApp(t, async ({ app, c, open }) => {
  await open('/widget/viewers?total=0');
  await waitDom(c, `${CARDS}.length === 2`, { timeoutMs: 12000 });
  send(app, platform(100), platform(50));
  await waitDom(c, `document.querySelector('.item-twitch')?.classList.contains('up')`);
  await waitDom(c, `!document.querySelector('#root .up')`, { timeoutMs: 6000 });
}));

test('viewers: platforms and the peak line follow the config without recreating the cards that stay', { timeout: 90000 }, t => withApp(t, async ({ app, call, c, ev, open }) => {
  await open('/widget/viewers');
  await waitDom(c, `${CARDS}.length === 3`, { timeoutMs: 12000 });
  send(app, platform(100, 120), platform(50, 60));
  await waitDom(c, `${BIG('youtube')} === '50'`);
  await ev(`window.__twitch = document.querySelector('.item-twitch'); window.__bigs = ${CARDS}.map(card => card.querySelector('.big')); true`);
  const stays = () => ev(`document.querySelector('.item-twitch') === window.__twitch && window.__twitch.querySelector('.big') === window.__bigs[0]`);
  const order = () => ev(`JSON.stringify(${CARDS}.map(${ID}))`).then(JSON.parse);

  await call('PUT', '/api/widgets', { viewers: { platforms: ['twitch'] } });
  await waitDom(c, `${CARDS}.length === 1`);
  assert.deepEqual(await order(), ['twitch']);
  assert.equal(await stays(), true, 'twitch kept its node when youtube and total left');

  await call('PUT', '/api/widgets', { viewers: { platforms: ['twitch', 'youtube'] } });
  await waitDom(c, `${CARDS}.length === 3`);
  assert.deepEqual(await order(), ['twitch', 'youtube', 'total']);
  assert.equal(await stays(), true, 'twitch kept its node when youtube and total came back');
  assert.equal(await ev(BIG('youtube')), '50');
  assert.equal(await ev(BIG('total')), '150');

  await call('PUT', '/api/widgets', { viewers: { showPeak: true } });
  await waitDom(c, `document.querySelector('.item-twitch .extra')?.textContent === 'Pico 120'`);
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify(${CARDS}.map(card => card.querySelector('.extra')?.textContent))`)), ['Pico 120', 'Pico 60', 'Pico 180']);
  assert.equal(await stays(), true, 'twitch kept its node when the peak line appeared');

  await call('PUT', '/api/widgets', { viewers: { showPeak: false } });
  await waitDom(c, `!document.querySelector('#root .extra')`);
  assert.equal(await stays(), true, 'twitch kept its node when the peak line went away');
}));

test('viewers: platforms, layout, total, peak and offline platforms render as before', { timeout: 90000 }, t => withApp(t, async ({ app, c, ev, open }) => {
  // `up` is the bump marker: the bump tests above own it, so it is left out of this markup comparison.
  const shown = () => ev(`JSON.stringify({ column: document.getElementById('root').classList.contains('col'), cards: ${CARDS}.map(card => ({
    classes: [...card.classList].filter(name => name !== 'up').sort().join(' '), parts: [...card.children].map(part => part.tagName + '.' + part.className),
    kick: card.querySelector('.kick').textContent, big: card.querySelector('.big').textContent, extra: card.querySelector('.extra')?.textContent ?? null })) })`).then(JSON.parse);
  const card = (id, classes, kick, big, extra = null) => ({ classes, parts: extra ? ['P.kick', 'P.big', 'P.extra'] : ['P.kick', 'P.big'], kick, big, extra });
  const twitch = (big, extra) => card('twitch', 'eg-card item item-twitch pf-twitch soft', 'Twitch', big, extra);
  const youtube = (big, extra) => card('youtube', 'eg-card item item-youtube pf-youtube soft', 'YouTube', big, extra);
  const total = (big, extra) => card('total', 'eg-card item item-total soft', 'Total', big, extra);

  await open('/widget/viewers?demo');
  await waitDom(c, `${CARDS}.length === 3`, { timeoutMs: 12000 });
  assert.deepEqual(await shown(), { column: false, cards: [twitch('132'), youtube('47'), total('179')] });

  await open('/widget/viewers?demo&platforms=youtube&peak=1');
  await waitDom(c, `${CARDS}.length === 1`, { timeoutMs: 12000 });
  assert.deepEqual(await shown(), { column: false, cards: [youtube('47', 'Pico 61')] });

  await open('/widget/viewers?demo&layout=column&total=0');
  await waitDom(c, `${CARDS}.length === 2`, { timeoutMs: 12000 });
  assert.deepEqual(await shown(), { column: true, cards: [twitch('132'), youtube('47')] });

  // Live readings: es-ES thousands, an offline platform shows a dash and no peak line, total counts only live ones.
  await open('/widget/viewers?peak=1');
  await waitDom(c, `${CARDS}.length === 3`, { timeoutMs: 12000 });
  send(app, platform(12345, 15000), { live: false, current: 0, peak: 0, record: 0 });
  await waitDom(c, `${BIG('twitch')} === '12.345'`);
  assert.deepEqual(await shown(), { column: false, cards: [
    twitch('12.345', 'Pico 15.000'),
    { ...youtube('—'), classes: 'eg-card item item-youtube off pf-youtube soft' },
    total('12.345', 'Pico 15.000')] });
}));

// ---------- credits ----------
const GROUPS = `[...document.querySelectorAll('#roll .grp')]`;
const TITLE = `(grp => grp.querySelector('.kick').textContent)`;
const SUMMARY = `JSON.stringify({
  head: [...document.querySelectorAll('#roll .head p')].map(p => p.textContent),
  groups: ${GROUPS}.map(grp => ({ title: (${TITLE})(grp), names: [...grp.querySelectorAll('li')].map(li => li.textContent), list: !!grp.querySelector('ul') })),
  end: [...document.querySelectorAll('#roll .end p')].map(p => p.textContent) })`;
const KEEP = `window.__kept = { roll: document.getElementById('roll'), head: document.querySelector('#roll .head'), end: document.querySelector('#roll .end'),
  groups: Object.fromEntries(${GROUPS}.map(grp => [(${TITLE})(grp), [grp, ...grp.querySelectorAll('li')]])) }; true`;
const SAME = `JSON.stringify({ roll: document.getElementById('roll') === window.__kept.roll, onScreen: document.getElementById('root').children.length,
  head: document.querySelector('#roll .head') === window.__kept.head, end: document.querySelector('#roll .end') === window.__kept.end,
  groups: Object.fromEntries(Object.entries(window.__kept.groups).map(([title, nodes]) => { const grp = ${GROUPS}.find(g => (${TITLE})(g) === title);
    return [title, !!grp && nodes.every((node, i) => node === (i ? grp.querySelectorAll('li')[i - 1] : grp))]; })) })`;

test('credits: playing again keeps the roll and its cards, and rewrites only what changed as plain text', { timeout: 120000 }, t => withApp(t, async ({ app, call, c, ev, open }) => {
  const simulate = (type, user) => call('POST', '/api/simulate', { type, vars: { user } });
  const flush = () => app.engine.flushScheduledSends();
  // speed 10 keeps the scroll running for the whole test
  await call('PUT', '/api/widgets', { credits: { title: 'Gracias <i>todos</i>', subtitle: 'a & b', speed: 10 } });
  await simulate('follow', 'Ana'); await simulate('follow', 'Ben'); await simulate('sub', 'Cleo');
  flush();
  await open('/widget/credits');
  await call('POST', '/api/credits/play');
  await waitDom(c, `${GROUPS}.length === 2`, { timeoutMs: 12000 });
  assert.deepEqual(JSON.parse(await ev(SUMMARY)), {
    head: ['Créditos', 'Gracias <i>todos</i>', 'Directo'],
    groups: [{ title: 'Suscripciones', names: ['Cleo'], list: true }, { title: 'Nuevos seguidores', names: ['Ana', 'Ben'], list: true }],
    end: ['Nos vemos el miércoles', 'a & b'] });
  assert.equal(await ev(`document.querySelectorAll('#roll i').length`), 0, 'a title with markup stays text');

  // Play again with nothing new: same nodes, the scroll starts over.
  const replay = async () => {
    await ev(`window.__scroll = document.getElementById('roll').getAnimations()[0]; true`);
    await call('POST', '/api/credits/play');
    await waitDom(c, `document.getElementById('roll')?.getAnimations()[0] !== window.__scroll`, { timeoutMs: 12000 });
  };
  await ev(KEEP);
  await ev(`window.__written = []; new MutationObserver(records => window.__written.push(...records.map(r => r.type)))
    .observe(document.getElementById('roll'), { subtree: true, childList: true, attributes: true, characterData: true }); true`);
  await replay();
  assert.deepEqual(JSON.parse(await ev(SAME)), { roll: true, onScreen: 1, head: true, end: true, groups: { Suscripciones: true, 'Nuevos seguidores': true } });
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify(window.__written)`)), [], 'nothing inside the roll was written to');

  // A new group goes first and a new name goes last; the groups that were there are the same nodes.
  await simulate('raid', 'Raider'); await simulate('follow', 'Dan'); await simulate('follow', '<b>Zoe</b>');
  flush();
  await replay();
  assert.deepEqual(JSON.parse(await ev(SUMMARY)), {
    head: ['Créditos', 'Gracias <i>todos</i>', 'Directo'],
    groups: [{ title: 'Raids', names: ['Raider'], list: true }, { title: 'Suscripciones', names: ['Cleo'], list: true },
      { title: 'Nuevos seguidores', names: ['Ana', 'Ben', 'Dan', '<b>Zoe</b>'], list: true }],
    end: ['Nos vemos el miércoles', 'a & b'] });
  assert.deepEqual(JSON.parse(await ev(SAME)), { roll: true, onScreen: 1, head: true, end: true, groups: { Suscripciones: true, 'Nuevos seguidores': true } });
  assert.equal(await ev(`document.querySelectorAll('#roll b').length`), 0, 'a name with markup stays text');

  // A new session leaves nobody to thank: the groups go, the roll stays.
  await call('POST', '/api/session/new', { title: 'Otro <u>directo</u>' });
  flush();
  await replay();
  assert.deepEqual(JSON.parse(await ev(SUMMARY)), {
    head: ['Créditos', 'Gracias <i>todos</i>', 'Otro <u>directo</u>'],
    groups: [{ title: 'Y a todo el chat', names: [], list: false }],
    end: ['Nos vemos el miércoles', 'a & b'] });
  assert.deepEqual(JSON.parse(await ev(SAME)), { roll: true, onScreen: 1, head: true, end: true, groups: { Suscripciones: false, 'Nuevos seguidores': false } });
  assert.equal(await ev(`document.querySelectorAll('#roll u').length`), 0, 'a session title with markup stays text');
}));

test('credits: play, stop, the idle line, the empty fallback and loop work as before', { timeout: 120000 }, t => withApp(t, async ({ call, c, ev, open }) => {
  const onScreen = () => ev(`JSON.stringify([...document.getElementById('root').children].map(node => node.id || node.className))`).then(JSON.parse);
  await call('PUT', '/api/widgets', { credits: { speed: 500 } });

  // ?debug shows an idle line while stopped
  await open('/widget/credits?debug');
  await waitDom(c, `document.querySelector('#root .idle')?.textContent === 'Créditos en espera'`);
  assert.deepEqual(await onScreen(), ['idle']);
  await call('POST', '/api/credits/play');
  await waitDom(c, `!!document.getElementById('roll')`);
  assert.deepEqual(JSON.parse(await ev(SUMMARY)), {
    head: ['Créditos', 'Gracias por estar', 'Directo'],
    groups: [{ title: 'Y a todo el chat', names: [], list: false }],
    end: ['Nos vemos el miércoles', 'egdev.es · directos los miércoles a las 19:00'] });
  assert.deepEqual(await onScreen(), ['roll']);
  assert.deepEqual(JSON.parse(await ev(`JSON.stringify((() => { const [a] = document.getElementById('roll').getAnimations();
    return { state: a.playState, fill: a.effect.getTiming().fill, easing: a.effect.getTiming().easing }; })())`)), { state: 'running', fill: 'forwards', easing: 'linear' });
  await call('POST', '/api/credits/stop');
  await waitDom(c, `!document.getElementById('roll') && !!document.querySelector('#root .idle')`);
  assert.deepEqual(await onScreen(), ['idle']);

  // without ?debug nothing is on screen while stopped
  await open('/widget/credits');
  assert.deepEqual(await onScreen(), []);
  await call('POST', '/api/credits/play');
  await waitDom(c, `!!document.getElementById('roll')`);
  await call('POST', '/api/credits/stop');
  await waitDom(c, `document.getElementById('root').children.length === 0`);

  // ?loop starts the scroll over when it finishes
  await open('/widget/credits?loop');
  await call('POST', '/api/credits/play');
  await waitDom(c, `!!document.getElementById('roll')?.getAnimations()[0]`);
  await ev(`window.__scroll = document.getElementById('roll').getAnimations()[0]; true`);
  await waitDom(c, `(document.getElementById('roll')?.getAnimations()[0] ?? window.__scroll) !== window.__scroll`, { timeoutMs: 25000 });
}));
