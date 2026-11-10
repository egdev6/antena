// #116 · S1–S7: the live monitor through the public panel and HTTP API, with synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, buttonByText } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const dom = (c, expression) => evaluateChrome(c.cdp, expression, { timeoutMs: 12000 });
const wait = (c, expression) => waitDom(c.cdp, expression, { timeoutMs: 12000 });
const pulse = platform => `document.querySelector('[data-platform-pulse="${platform}"]')`;
const health = `document.querySelector('[aria-label="Salud y conexiones del directo"]')`;
const api = async (base, method, url, body) => {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.ok, true, `${method} ${url}: ${response.status}`);
  return response.json();
};

async function fixture(t, { gap = true, missing = false, stale = false, goals = true, extraArchives = [], withoutSeries = false, chatOnly = false, emptyEvents = false, ageSeconds = 600 } = {}) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-directo-monitor-'));
  let app, chrome;
  t.after(async () => {
    if (chrome) await closeChrome(chrome);
    if (app) {
      app.viewers.halt(); await app.youtube.quiescePoll(); await app.chat.quiesceChat();
      await app.drainAutoSession(); await app.drainChatMetrics(); await app.session.flush(); await app.closeHttp();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const now = Math.floor(Date.now() / 1000) * 1000, start = now - ageSeconds * 1000;
  const at = seconds => new Date(start + seconds * 1000).toISOString();
  const series = (value, withGap) => ({ samples: [{ at: at(0), value }, ...(!stale ? [{ at: at(withGap ? 420 : 590), value }] : [])],
    gaps: withGap ? [{ from: at(480), to: at(480), reason: 'error' }] : [],
    intervals: [{ from: at(0), seconds: stale ? 60 : 900 }], openGap: withGap });
  const event = (id, type, second, amount) => ({ id, type, at: at(second), vars: { user: id, ...(amount ? { amount } : {}) }, text: id, thanked: false });
  const current = { id: 'current-synthetic', title: 'Directo de prueba', startedAt: at(0), meldAutoSession: !withoutSeries, ...(stale ? { endedAt: at(595) } : {}),
    ...(!withoutSeries ? { platforms: { twitch: { streamId: 'synthetic-twitch' }, youtube: { videoId: 'synthetic-video' } } } : {}),
    events: emptyEvents ? [] : [event('Ana', 'follow', 100), event('Bea', 'superchat', 200, 5)], notes: [], goalOffsets: {},
    ...(!withoutSeries ? { viewers: { twitch: series(48, false), ...(!missing ? { youtube: series(19, gap) } : {}) },
      chatStats: { twitch: { authorIds: ['a', 'b'], minutes: [{ at: at(120), messages: 99 }, { at: at(360), messages: 5 }, { at: at(480), messages: 4 }, { at: at(540), messages: 6 }] },
        ...(!missing ? { youtube: { authorIds: ['c'], minutes: [{ at: at(540), messages: 5 }] } } : {}) } } : {}),
    ...(chatOnly ? { chatStats: { twitch: { authorIds: ['a'], minutes: [{ at: at(540), messages: 5 }] } } } : {}) };
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  await writeFile(path.join(dataDir, 'session-current.json'), JSON.stringify(current));
  await writeFile(path.join(dataDir, 'sessions', 'archive.json'), JSON.stringify({ id: 'archive', title: 'Directo archivado', startedAt: at(-86400), endedAt: at(-86000), events: [], notes: [], goalOffsets: {} }));
  for (const entry of extraArchives) await writeFile(path.join(dataDir, 'sessions', `${entry.id}.json`), JSON.stringify(entry));
  app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  app.viewers.halt();
  // Loading an open session records a restart gap. Resume through the same series writer
  // as the viewer watcher; leave the synthetic YouTube error gap open where requested.
  if (!stale && !withoutSeries) {
    const target = { id: current.id };
    await app.session.recordViewer('twitch', { at: new Date().toISOString(), intervalSec: 900, value: 48, streamId: 'synthetic-twitch' }, target, target);
    if (!gap && !missing) await app.session.recordViewer('youtube', { at: new Date().toISOString(), intervalSec: 900, value: 19, videoId: 'synthetic-video' }, target, target);
  }
  app.store.config.panel = { onboardingDone: true };
  app.store.config.widgets.goals = goals ? [{ id: 'goal', title: 'Comunidad', visible: true, bars: [{ id: 'bar', platform: 'twitch', metric: 'follows', target: 20, visible: true }] }] : [];
  app.meld.status = { ...app.meld.status, state: 'conectado', streaming: true };
  app.chat.status = { ...app.chat.status, state: 'conectado' };
  app.youtube.status = { ...app.youtube.status, state: 'escuchando', liveChatId: 'synthetic-chat' };
  for (const p of ['twitch', 'youtube']) Object.assign(app.viewers.state[p], { live: true, current: p === 'twitch' ? 48 : 19 });
  let overlays = 1; app.bus.overlayCount = () => overlays;
  app.bus.history.unshift({ id: 'alert-1', type: 'follow', at: at(200), text: 'Ana' });
  app.twitch.sendChat = async () => ({ ok: true }); app.youtube.sendChat = async () => ({ ok: true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, setOverlays: n => { overlays = n; app.chat.setStatus({}); }, open: async ({ fastRefresh = false } = {}) => {
    chrome = await openChromePage(bin, `${base}/#/directo`);
    if (fastRefresh) {
      await chrome.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const original = window.setInterval; window.setInterval = (fn, ms, ...args) => original(fn, ms === 30000 ? 200 : ms, ...args);
      })()` });
      await dom(chrome, `window.__monitorOld = true`);
      await chrome.cdp.send('Page.reload');
      await wait(chrome, `window.__monitorOld !== true`);
    }
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(chrome, `!!document.querySelector('[data-tour-view-ready="directo"]')`);
    return chrome;
  } };
}

// S1/S2/S4/S5/S6/S7: separate live platforms, an open gap, sparse minutes and nonzero totals.
test('#116: pulso por plataforma, hueco, resumen, objetivo, historial y anclas', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open();
  await wait(c, `!!${pulse('twitch')} && !!${pulse('youtube')}`);
  const tw = await dom(c, `${pulse('twitch')}.textContent`), yt = await dom(c, `${pulse('youtube')}.textContent`);
  assert.match(tw, /48\s*ahora/i); assert.match(tw, /48(?:,0)?\s*media/i); assert.match(tw, /48\s*pico/i);
  assert.match(tw, /3,0\s*msg\/min/i); assert.match(tw, /2\s*personas únicas/i); assert.match(tw, /Cobertura\s*(?:<100|9\d)\s*%/i);
  assert.match(yt, /no disponible\s*ahora|ahora\s*no disponible/i); assert.match(yt, /19(?:,0)?\s*media/i);
  assert.match(yt, /19\s*pico/i); assert.match(yt, /1,0\s*msg\/min/i); assert.match(yt, /1\s*personas? únicas/i);
  assert.match(yt, /cobertura\s*\d+\s*%/i); assert.doesNotMatch(yt, /0\s*ahora/i);
  assert.equal(await dom(c, `!!${pulse('youtube')}.querySelector('svg [data-gap="youtube"][fill^="url("]')`), true);
  assert.match(await dom(c, `${health}.textContent`), /YouTube.*hueco|hueco.*YouTube/i);
  const summary = await dom(c, `document.querySelector('[data-tour="directo-stats"]').textContent`);
  assert.match(summary, /1\s+seguidor\b/); assert.match(summary, /5\s+super chats/);
  assert.doesNotMatch(summary, /Suscripciones|Bits|Raids|Miembros/i); assert.match(summary, /2\s*por agradecer/i);
  assert.match(await dom(c, `document.querySelector('.goals').textContent`), /Comunidad/);
  assert.match(await dom(c, `document.querySelector('#h-past').closest('section').textContent`), /Último directo:.*Directo archivado/i);
  assert.equal(await dom(c, `document.querySelector('#h-past').closest('section').querySelector('a').getAttribute('href')`), '#/directos');
  for (const anchor of ['directo-head', 'directo-status', 'directo-stats', 'directo-alerts', 'directo-timeline']) {
    assert.equal(await dom(c, `!!document.querySelector('[data-tour="${anchor}"]')?.getClientRects().length`), true, anchor);
  }
});

// S1/S5/S7: healthy means no warnings; connection state (not missing metrics), pause and overlays drive warnings.
test('#116: salud según conexiones reales, pausa y overlays; objetivos ausentes', { timeout: 90000 }, async t => {
  const f = await fixture(t, { gap: false, missing: true, goals: false }); if (!f) return;
  const c = await f.open();
  await wait(c, `!!${health} && !!${pulse('youtube')}`);
  assert.match(await dom(c, `${health}.textContent`), /Todo en orden/);
  assert.doesNotMatch(await dom(c, `${health}.textContent`), /chat no conectado/i);
  assert.match(await dom(c, `${pulse('youtube')}.textContent`), /Sin datos de espectadores ni de chat en este directo/i);
  assert.doesNotMatch(await dom(c, `${pulse('youtube')}.textContent`), /0\s*msg\/min/i);
  assert.equal(await dom(c, `!!document.querySelector('.goals')`), false);
  f.app.chat.setStatus({ state: 'parado' }); f.app.youtube.setStatus({ state: 'error' }); f.setOverlays(0);
  await api(f.base, 'POST', '/api/pause');
  await api(f.base, 'POST', '/api/simulate', { type: 'follow', vars: { user: 'Sintético' } });
  await wait(c, `/Twitch.*chat no conectado/i.test(${health}.textContent) && /YouTube.*chat no conectado/i.test(${health}.textContent) && /alertas.*pausadas/i.test(${health}.textContent) && /1 alerta retenida/i.test(${health}.textContent) && /0 overlays/i.test(${health}.textContent)`);
  assert.doesNotMatch(await dom(c, `${health}.textContent`), /Todo en orden/);
  await api(f.base, 'POST', '/api/resume');
  f.app.chat.setStatus({ state: 'conectado' }); f.app.youtube.setStatus({ state: 'escuchando' }); f.setOverlays(1);
  await wait(c, `/Todo en orden/.test(${health}.textContent)`);
});

// S2: a platform with no viewer or chat data has one compact, truthful empty state.
test('#116: pulso sin datos es compacto y datos parciales conservan el detalle', { timeout: 90000 }, async t => {
  const f = await fixture(t, { withoutSeries: true }); if (!f) return;
  f.app.meld.status.streaming = false;
  f.app.twitch.status = { ...f.app.twitch.status, state: 'desconectado' };
  f.app.chat.status = { ...f.app.chat.status, state: 'parado' };
  f.app.youtube.status = { ...f.app.youtube.status, state: 'parado', liveChatId: null };
  for (const p of ['twitch', 'youtube']) f.app.viewers.observe(p, { live: false, off: true });
  const c = await f.open();
  for (const p of ['twitch', 'youtube']) {
    const card = await dom(c, `${pulse(p)}.textContent`);
    assert.equal((card.match(/Sin datos de espectadores ni de chat en este directo/gi) || []).length, 1);
    assert.match(card, /sin conexión/i);
    assert.doesNotMatch(card, /no disponible|\b0\b|msg\/min/i);
    assert.equal(await dom(c, `${pulse(p)}.querySelectorAll('.dir-number, svg.dx-chart').length`), 0);
  }
  const partial = await fixture(t, { withoutSeries: true, chatOnly: true }); if (!partial) return;
  partial.app.viewers.observe('twitch', { live: false, off: true });
  const d = await partial.open();
  const card = await dom(d, `${pulse('twitch')}.textContent`);
  assert.doesNotMatch(card, /Sin datos de espectadores ni de chat en este directo/i);
  assert.match(card, /1,0\s*msg\/min/i); assert.match(card, /1\s*personas únicas/i);
  assert.match(card, /no disponible\s*ahora/i);
  assert.equal(await dom(d, `${pulse('twitch')}.querySelectorAll('.dir-number').length`), 3);
});

// S4: elapsed time must fit before the event label at wide and narrow viewports.
test('#116: tiempos de cronología multihora no se solapan ni se cortan', { timeout: 90000 }, async t => {
  const f = await fixture(t, { withoutSeries: true, emptyEvents: true, ageSeconds: 200 * 3600 }); if (!f) return;
  const start = Date.parse((await api(f.base, 'GET', '/api/session')).startedAt);
  const offsets = [65, 3906, 172590, 445556];
  for (const [i, seconds] of offsets.entries()) f.app.session.addNote({ kind: 'question', label: `Marca ${i}`, at: new Date(start + seconds * 1000).toISOString() });
  const c = await f.open();
  const rows = `(() => [...document.querySelector('#h-crono').closest('section').querySelectorAll('.eg-timeline__item')].map(row => {
    const time = row.querySelector('.eg-timeline__time'), type = row.querySelector('.eg-timeline__type');
    const a = time.getBoundingClientRect(), b = type.getBoundingClientRect();
    return { text: time.textContent.trim(), label: row.querySelector('.eg-timeline__body').textContent, width: time.clientWidth,
      content: time.scrollWidth, right: a.right, left: b.left, whitespace: getComputedStyle(time).whiteSpace }; }))()`;
  for (const width of [1440, 1024, 500]) {
    await c.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const result = await dom(c, rows);
    assert.deepEqual(result.map(row => row.text), ['123:45:56', '47:56:30', '1:05:06', '1:05']);
    for (const row of result) {
      assert.match(row.label, /Marca/);
      assert.ok(row.content <= row.width + 1, `${width}: tiempo cortado ${JSON.stringify(row)}`);
      assert.ok(row.right <= row.left + 1, `${width}: tiempo y etiqueta se solapan ${JSON.stringify(row)}`);
      assert.equal(row.whitespace, 'nowrap');
    }
  }
});

// S4: each of the six counters agrees with its value and zero totals stay hidden.
test('#116: resumen de totales usa singular y plural en minúsculas', { timeout: 90000 }, async t => {
  const f = await fixture(t, { withoutSeries: true, emptyEvents: true }); if (!f) return;
  const c = await f.open();
  const summary = `document.querySelector('[data-tour="directo-stats"] > span')`;
  assert.equal(await dom(c, `${summary}.textContent`), 'Todavía no hay totales.');
  const singular = '1 seguidor · 1 suscripción · 1 bit · 1 raid · 1 super chat (€) · 1 miembro';
  const plural = '2 seguidores · 2 suscripciones · 2 bits · 2 raids · 2 super chats (€) · 2 miembros';
  const add = round => {
    for (const type of ['follow', 'sub', 'cheer', 'raid', 'superchat', 'member']) {
      f.app.session.record({ id: `${type}-${round}`, type, at: new Date().toISOString(), vars: { user: 'Sintético', amount: 1 }, text: 'Sintético' });
    }
  };
  add(1);
  await wait(c, `${summary}.textContent === ${JSON.stringify(singular)} && /6 por agradecer/.test(document.querySelector('[data-tour="directo-stats"]').textContent)`);
  assert.match(await dom(c, `document.querySelector('[data-tour="directo-stats"]').textContent`), /6 por agradecer/);
  add(2);
  await wait(c, `${summary}.textContent === ${JSON.stringify(plural)} && /12 por agradecer/.test(document.querySelector('[data-tour="directo-stats"]').textContent)`);
  assert.match(await dom(c, `document.querySelector('[data-tour="directo-stats"]').textContent`), /12 por agradecer/);
});

// S1/S7: a stale chat ID must not make an error look like a working connection.
test('#116: error de YouTube con liveChatId antiguo no finge chat conectado', { timeout: 90000 }, async t => {
  const f = await fixture(t, { gap: false }); if (!f) return;
  const c = await f.open();
  const pill = `[...document.querySelectorAll('[aria-label="Conexiones"] .eg-status')].find(e => e.textContent.trim().startsWith('YouTube ·'))`;
  assert.match(await dom(c, `${pill}.textContent`), /leyendo el chat/i);
  f.app.youtube.setStatus({ state: 'error' });
  await wait(c, `/YouTube: chat no conectado/i.test(${health}.textContent)`);
  const status = (await api(f.base, 'GET', '/api/state')).status.youtube;
  assert.equal(status.state, 'error');
  assert.equal(status.liveChatId, 'synthetic-chat');
  assert.equal(await dom(c, `${pill}.textContent.trim()`), 'YouTube · error');
  assert.doesNotMatch(await dom(c, `${pill}.textContent`), /leyendo el chat/i);
  f.app.youtube.setStatus({ state: 'escuchando' });
  await wait(c, `/Todo en orden/.test(${health}.textContent) && /leyendo el chat/i.test(${pill}.textContent)`);
});

// S5/S7: archive identifiers are not necessarily chronological, especially for legacy sessions.
test('#116: último directo usa la fecha y no el orden del identificador archivado', { timeout: 90000 }, async t => {
  const older = { id: 'z-older', title: 'Directo antiguo', startedAt: '2000-01-01T00:00:00.000Z', endedAt: '2000-01-01T01:00:00.000Z', events: [], notes: [], goalOffsets: {} };
  const f = await fixture(t, { extraArchives: [older] }); if (!f) return;
  const past = (await api(f.base, 'GET', '/api/sessions')).past;
  assert.deepEqual(past.map(p => p.id), ['z-older', 'archive']);
  assert.ok(Date.parse(past[0].startedAt) < Date.parse(past[1].startedAt));
  const c = await f.open();
  const footer = `document.querySelector('#h-past').closest('section')`;
  assert.match(await dom(c, `${footer}.textContent`), /Último directo:.*Directo archivado/i);
  assert.doesNotMatch(await dom(c, `${footer}.textContent`), /Directo antiguo/i);
  assert.equal(await dom(c, `${footer}.querySelector('a').getAttribute('href')`), '#/directos');
});

// S1: a stream identity remains a live signal when viewer polling is disabled.
test('#116: chat Twitch parado avisa con identidad en directo y sondeo desactivado', { timeout: 90000 }, async t => {
  const f = await fixture(t, { gap: false }); if (!f) return;
  f.app.store.config.viewers.enabled = false;
  f.app.viewers.observe('twitch', { live: false });
  f.app.chat.status = { ...f.app.chat.status, state: 'parado' };
  const state = await api(f.base, 'GET', '/api/state'), session = await api(f.base, 'GET', '/api/session');
  assert.equal(state.viewers.settings.enabled, false); assert.equal(state.viewers.platforms.twitch.live, false);
  assert.equal(state.status.meld.streaming, true); assert.equal(session.platforms.twitch.streamId, 'synthetic-twitch');
  const c = await f.open();
  assert.match(await dom(c, `${health}.textContent`), /Twitch: chat no conectado/i);
  assert.doesNotMatch(await dom(c, `${health}.textContent`), /Todo en orden/);
  f.app.chat.setStatus({ state: 'conectado' });
  await wait(c, `/Todo en orden/.test(${health}.textContent)`);
});

// S1: ending a session closes its gaps and the monitor must update without another event.
test('#116: al cerrar el directo desaparece el aviso del hueco abierto', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open();
  assert.match(await dom(c, `${health}.textContent`), /YouTube: hueco abierto/i);
  await f.app.session.endCurrent();
  const ended = await api(f.base, 'GET', '/api/session');
  assert.ok(ended.endedAt); assert.equal(ended.viewers.youtube.openGap, false);
  f.app.viewers.observe('twitch', { live: false }); f.app.viewers.observe('youtube', { live: false });
  f.app.viewers.emit('change', f.app.viewers.snapshot());
  f.app.youtube.setStatus({ state: 'parado', liveChatId: null });
  f.app.meld.setStatus({ state: 'conectado', streaming: false });
  await wait(c, `/Todo en orden/.test(${health}.textContent) && !/hueco abierto/i.test(${health}.textContent)`);
});

// S2: a fresh watcher reading is usable without inventing aggregate session metrics.
test('#116: espectadores actuales del sondeo sin serie de sesión', { timeout: 90000 }, async t => {
  const f = await fixture(t, { withoutSeries: true }); if (!f) return;
  f.app.store.config.meld.autoSession = false;
  f.app.viewers.observe('twitch', { live: true, viewers: 42 });
  const session = await api(f.base, 'GET', '/api/session');
  assert.equal(session.viewers, undefined); assert.equal(session.viewerMetrics, undefined);
  const c = await f.open();
  const number = `${pulse('twitch')}.querySelector('.dir-number.now').textContent`;
  assert.match(await dom(c, number), /42\s*ahora/i);
  const card = await dom(c, `${pulse('twitch')}.textContent`);
  assert.match(card, /no disponible\s*media/i); assert.match(card, /no disponible\s*pico/i);
  assert.match(card, /Curva de espectadores no disponible/i);
  f.app.viewers.observe('twitch', { live: true, viewers: 0 });
  f.app.viewers.emit('change', f.app.viewers.snapshot());
  await wait(c, `/^0\\s*ahora/i.test(${number})`);
  const clock = f.app.viewers.now; f.app.viewers.now = () => Date.now() - 61000;
  f.app.viewers.observe('twitch', { live: true, viewers: 42 }); f.app.viewers.now = clock;
  f.app.viewers.emit('change', f.app.viewers.snapshot());
  await wait(c, `/Sin datos de espectadores ni de chat en este directo/i.test(${pulse('twitch')}.textContent)`);
  assert.doesNotMatch(await dom(c, `${pulse('twitch')}.textContent`), /42\s*ahora/i);
});

// S3: the visible five-message window must follow a new message even at a constant length.
test('#116: el sexto mensaje largo queda visible en el chat reducido', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  for (let i = 0; i < 5; i++) await api(f.base, 'POST', '/api/chat/simulate', { user: `usuario${i}`, text: `corto ${i}`, platform: 'twitch' });
  const c = await f.open();
  await c.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(c, `document.querySelectorAll('.dir-chat li').length === 5`);
  await dom(c, `document.querySelector('.dir-chat').scrollTop = 0`);
  await api(f.base, 'POST', '/api/chat/simulate', { user: 'MensajeSeis', text: 'contenido largo '.repeat(12), platform: 'twitch' });
  await wait(c, `document.querySelector('.dir-chat li:last-child')?.textContent.includes('MensajeSeis')`);
  const box = await dom(c, `(() => { const log = document.querySelector('.dir-chat'), last = log.lastElementChild;
    const a = log.getBoundingClientRect(), b = last.getBoundingClientRect();
    return { count: log.children.length, scroll: log.scrollHeight, height: log.clientHeight, top: b.top - a.top, bottom: b.bottom - a.bottom }; })()`);
  assert.equal(box.count, 5);
  assert.ok(box.scroll <= box.height + 1, `el chat no debe recortar sus mensajes: ${JSON.stringify(box)}`);
  assert.ok(box.top >= -1 && box.bottom <= 1, `el último mensaje debe verse entero: ${JSON.stringify(box)}`);
});

// S6: tour prose may mention a control only if the highlighted zone contains it.
test('#116: el texto del tour coincide con el control resaltado', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open();
  await dom(c, `location.hash = '#/general/tour'`);
  await wait(c, `!!${buttonByText('Ver el tour de nuevo')}`);
  await dom(c, `${buttonByText('Ver el tour de nuevo')}.click()`);
  for (const [anchor, progress] of [['nav', 1], ['nav-directo', 2], ['directo-head', 3], ['directo-status', 4], ['directo-stats', 5]]) {
    await wait(c, `document.querySelector('.driver-active-element')?.getAttribute('data-tour') === ${JSON.stringify(anchor)} && document.querySelector('.driver-popover-progress-text')?.textContent.startsWith('${progress} de ')`);
    await dom(c, `document.querySelector('.driver-popover-next-btn').click()`);
  }
  await wait(c, `document.querySelector('.driver-active-element')?.getAttribute('data-tour') === 'directo-alerts' && document.querySelector('.driver-popover-progress-text')?.textContent.startsWith('6 de ')`);
  const text = await dom(c, `document.querySelector('.driver-popover').textContent`);
  const contains = await dom(c, `[...document.querySelector('[data-tour="directo-alerts"]').querySelectorAll('button')].some(b => b.textContent.includes('Marcar momento'))`);
  assert.match(text, /cola/i);
  assert.ok(!text.includes('Marcar momento') || contains, 'el paso menciona un botón que no está en el área resaltada');
});

// S2/S7: an expired sample is unavailable, rather than a fabricated zero or stale current value.
test('#116: muestra caducada no se presenta como espectador actual', { timeout: 90000 }, async t => {
  const f = await fixture(t, { stale: true, gap: false }); if (!f) return;
  const c = await f.open();
  await wait(c, `!!${pulse('twitch')}`);
  const text = await dom(c, `${pulse('twitch')}.textContent`);
  assert.match(text, /no disponible\s*ahora|ahora\s*no disponible/i);
  assert.match(text, /48(?:,0)?\s*media/i); assert.match(text, /48\s*pico/i);
});

// S2/S7: platform activity also refreshes metrics when Meld itself is not streaming.
test('#116: actualiza el pulso con plataforma en directo aunque Meld no emita', { timeout: 90000 }, async t => {
  const f = await fixture(t, { gap: false }); if (!f) return;
  f.app.meld.status.streaming = false;
  const c = await f.open({ fastRefresh: true });
  await api(f.base, 'PUT', '/api/session', { title: 'Actualizado periódicamente' });
  await wait(c, `document.querySelector('.title-input')?.value === 'Actualizado periódicamente'`);
});

// S3/S6/S7: backup actions keep the original endpoints and the recent chat keeps the send destination.
test('#116: controles de respaldo y chat reducido usan las acciones existentes', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  for (let i = 0; i < 7; i++) await api(f.base, 'POST', '/api/chat/simulate', { user: `usuario${i}`, text: `mensaje${i}`, platform: 'twitch' });
  const c = await f.open();
  await wait(c, `!!${buttonByText('Saltar')} && !!document.querySelector('#dir-say')`);
  assert.equal(await dom(c, `document.querySelectorAll('.dir-chat li').length`), 5);
  assert.doesNotMatch(await dom(c, `document.querySelector('.dir-chat').textContent`), /mensaje0|mensaje1/);
  assert.match(await dom(c, `document.querySelector('.dir-chat').textContent`), /mensaje6/);
  await dom(c, `(() => { const original = window.fetch; window.__monitorCalls = []; window.fetch = (...args) => {
    const url = new URL(String(args[0]), location.href);
    const entry = args[1]?.method === 'POST' ? { path: url.pathname, body: args[1].body || null } : null;
    if (entry) window.__monitorCalls.push(entry);
    return original(...args).then(response => { if (entry) entry.status = response.status; return response; });
  }; window.confirm = message => { window.__newConfirm = message; return false; }; return true; })()`);
  assert.equal(await dom(c, `document.querySelector('a[href="/api/session/summary.md"]').textContent.trim()`), 'Resumen (.md)');
  await dom(c, `${buttonByText('Nuevo directo')}.click()`);
  assert.match(await dom(c, `window.__newConfirm`), /Se archiva el directo actual/);
  assert.equal(await dom(c, `window.__monitorCalls.some(x => x.path === '/api/session/new')`), false);
  assert.equal((await api(f.base, 'GET', '/api/session')).title, 'Directo de prueba');
  for (const label of ['Saltar', 'Vaciar cola', 'Repetir', 'Pausar alertas']) await dom(c, `${buttonByText(label)}.click()`);
  await wait(c, `!!${buttonByText('Reanudar alertas')}`);
  await dom(c, `${buttonByText('Reanudar alertas')}.click()`);
  await dom(c, `${buttonByText('Marcar momento')}.click()`);
  await dom(c, `document.querySelector('[role="radio"][aria-label="Solo YouTube"]').click()`);
  await dom(c, `(() => { const e = document.querySelector('#dir-say'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'hola sintético'); e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await dom(c, `document.querySelector('#dir-say').closest('form').requestSubmit()`);
  const paths = ['/api/skip', '/api/clear', '/api/replay', '/api/pause', '/api/resume', '/api/markers', '/api/chat/send'];
  await wait(c, `${JSON.stringify(paths)}.every(path => window.__monitorCalls.some(x => x.path === path && x.status !== undefined))`);
  const calls = await dom(c, `window.__monitorCalls`);
  for (const path of paths) assert.equal(calls.find(x => x.path === path)?.status, 200, path);
  assert.deepEqual(JSON.parse(calls.find(x => x.path === '/api/replay').body), { id: 'alert-1' });
  assert.deepEqual(JSON.parse(calls.find(x => x.path === '/api/chat/send').body), { text: 'hola sintético', to: 'youtube' });
  assert.ok((await api(f.base, 'GET', '/api/timeline')).items.some(item => item.kind === 'marker'));
  await wait(c, `!!${buttonByText('Pausar alertas')}`);
});
