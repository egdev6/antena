// #114 · S1–S6: synthetic archives exercised through the panel and its public HTTP API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { serveSourcePanel } from './charts-style-browser.test.mjs';

const start = Date.parse('2026-11-18T18:00:00.000Z');
const at = (seconds, base = start) => new Date(base + seconds * 1000).toISOString();
const series = (samples, gaps = [], openGap = false) => ({ samples: samples.map(([s, value]) => ({ at: at(s), value })),
  gaps: gaps.map(([from, to]) => ({ from: at(from), to: at(to), reason: 'error' })),
  intervals: [{ from: at(0), seconds: 60 }], openGap });
const archived = (id, title, startedAt = at(0), extra = {}) => ({ id, title, startedAt,
  endedAt: new Date(Date.parse(startedAt) + 240_000).toISOString(), events: [], notes: [], goalOffsets: {}, ...extra });
const auto = archived('z-auto', 'Directo automático', at(0), { meldAutoSession: true,
  events: [{ id: 'e1', at: at(30), type: 'follow', user: 'Ana' },
    { id: 'e2', at: at(150), type: 'superchat', user: 'Bea' },
    { id: 'e3', at: at(200), type: 'desconocido', user: 'Cruz' }],
  notes: [{ id: 'm1', at: at(90), kind: 'marker', label: 'Marca de prueba' }],
  viewers: { twitch: series([[0, 10], [60, 20], [120, 30], [180, 40]]),
    youtube: series([[0, 2], [60, 4], [180, 6]], [[90, 180]]) },
  chatStats: { twitch: { authorIds: ['a', 'b'], minutes: [{ at: at(0), messages: 3 }, { at: at(120), messages: 2 }] },
    youtube: { authorIds: ['c'], minutes: [{ at: at(60), messages: 1 }] } } });
const partial = archived('y-partial', 'Directo parcial', at(0, start - 86_400_000), { meldAutoSession: true,
  // An open gap extends to the end, even when its stored `to` is still its start.
  viewers: { twitch: { samples: [{ at: at(0, start - 86_400_000), value: 8 }],
    gaps: [{ from: at(60, start - 86_400_000), to: at(60, start - 86_400_000), reason: 'error' }],
    intervals: [{ from: at(0, start - 86_400_000), seconds: 60 }], openGap: true } },
  chatStats: { twitch: { authorIds: ['d'], minutes: [{ at: at(0, start - 86_400_000), messages: 1 }] } } });
const legacy = archived('x-legacy', 'Directo antiguo', at(0, start - 2 * 86_400_000));
const nearStart = start - 3 * 86_400_000;
const nearFull = archived('b-near', 'Cobertura casi completa', at(0, nearStart), { meldAutoSession: true,
  viewers: { twitch: { samples: [0, 60, 120, 180].map(s => ({ at: at(s, nearStart), value: 8 })),
    gaps: [{ from: at(119.5, nearStart), to: at(120, nearStart), reason: 'error' }],
    intervals: [{ from: at(0, nearStart), seconds: 60 }] } } });
const archives = [auto, partial, legacy, nearFull, ...Array.from({ length: 8 }, (_, i) =>
  archived(`a-${i}`, `Directo de relleno ${i}`, at(0, start - (4 + i) * 86_400_000)))];
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const dom = (chrome, expression) => evaluateChrome(chrome.cdp, expression, { timeoutMs: 12000 });
const wait = (chrome, expression) => waitDom(chrome.cdp, expression, { timeoutMs: 12000 });
const row = title => `[...document.querySelectorAll('[role="region"][aria-label*="directos"] article')].find(e => e.querySelector('h3')?.textContent.trim() === ${JSON.stringify(title)})`;
const select = title => `${row(title)}.querySelector('button[aria-controls="detalle"]').click()`;
const setSearch = value => `(() => { const e = document.querySelector('input[type="search"][placeholder="Buscar por título o fecha"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)});
  e.dispatchEvent(new Event('input', { bubbles: true })); })()`;

async function fixture(t, { current, extraArchives = [], archiveEntries = archives } = {}) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local'); return null; }
  const root = await mkdtemp(path.join(tmpdir(), 'antena-directos-metricas-'));
  let app, chrome, proxy;
  const releases = [];
  t.after(async () => {
    releases.forEach(release => release());
    if (chrome) await closeChrome(chrome);
    if (proxy) await proxy.close();
    if (app) { app.viewers.halt(); await app.youtube.quiescePoll(); await app.chat.quiesceChat();
      await app.drainAutoSession(); await app.drainChatMetrics(); await app.session.flush(); await app.closeHttp(); }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  for (const entry of [...archiveEntries, ...extraArchives]) await writeFile(path.join(dataDir, 'sessions', `${entry.id}.json`), JSON.stringify(entry));
  if (current) await writeFile(path.join(dataDir, 'session-current.json'), JSON.stringify(current));
  app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  app.store.config.panel = { onboardingDone: true };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  proxy = await serveSourcePanel(app);
  const base = proxy.base;
  const requests = [];
  const get = app.session.get.bind(app.session);
  app.session.get = async id => { requests.push(id); return get(id); };
  return { app, base, requests, releases, open: async (hash = '#/directos') => {
    chrome = await openChromePage(bin, base + '/' + hash);
    await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    return chrome;
  } };
}

// S1/S2/S5/S6: comparisons come from the list; only the chosen detail requests a summary.
test('#114: métricas por plataforma, huecos, chat y momentos sin sumar ni inventar datos', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open();
  await wait(c, `!!${row('Directo automático')} && !!document.querySelector('#detalle svg[role="img"]')`);
  assert.deepEqual(f.requests, ['z-auto']);
  const selected = `${row('Directo automático')}.querySelector('button[aria-controls="detalle"]')`;
  assert.equal(await dom(c, `${selected}.getAttribute('aria-pressed')`), 'true');
  const table = `${row('Directo automático')}.querySelector('table')`;
  assert.deepEqual(await dom(c, `[...${table}.querySelectorAll('thead th')].map(x => x.textContent.trim())`),
    ['Canal', 'Media', 'Pico', 'Únicos', 'Msg/min', 'Cobertura']);
  const cells = platform => `[...${table}.querySelectorAll('tbody tr')].find(r => r.textContent.includes(${JSON.stringify(platform)})).querySelectorAll('td,th')`;
  assert.deepEqual(await dom(c, `[...${cells('Twitch')}].map(x => x.textContent.trim())`), ['Twitch', '25,0', '40', '2', '1,3', '100 %']);
  const youtube = await dom(c, `[...${cells('YouTube')}].map(x => x.textContent.trim())`);
  assert.deepEqual(youtube.slice(0, 5), ['YouTube', '4,0', '6', '1', '0,3']);
  assert.match(youtube[5], /63\s*%.*parcial/i);
  assert.match(await dom(c, `${row('Cobertura casi completa')}.textContent`), /<100\s*%.*parcial/i);
  assert.equal(await dom(c, `(() => { const e = [...${table}.querySelectorAll('td')].find(x => /parcial/i.test(x.textContent));
    return [e, ...e.querySelectorAll('*')].some(x => getComputedStyle(x).color === 'rgb(255, 178, 36)'); })()`), true);
  assert.match(await dom(c, `${row('Directo antiguo')}.textContent`), /Sin métricas/i);
  assert.doesNotMatch(await dom(c, `${row('Directo antiguo')}.textContent`), /manual/i);
  assert.equal(await dom(c, `!!${row('Directo antiguo')}.querySelector('table')`), false);

  // The renderer exposes the actual temporal span of plotted segments on the SVG paths.
  const viewer = `document.querySelector('#detalle svg[aria-label="Evolución de espectadores"]')`;
  assert.equal(await dom(c, `!!${viewer}.querySelector('title') && !!${viewer}.querySelector('desc')`), true);
  const description = await dom(c, `${viewer}.querySelector('desc').textContent`);
  assert.match(description, /Twitch.*10.*40/i); assert.match(description, /YouTube.*2.*6/i);
  assert.match(description, /hueco|sin muestras/i);
  assert.ok(await dom(c, `${viewer}.querySelectorAll('text').length >= 2`), 'el eje muestra horas');
  assert.match(await dom(c, `document.querySelector('#detalle').textContent`), /Twitch.*YouTube/s);
  const gap = `${viewer}.querySelector('[data-gap="youtube"]')`;
  assert.equal(await dom(c, `!!${gap}`), true);
  assert.equal(await dom(c, `${gap}.getAttribute('data-from')`), at(90));
  assert.equal(await dom(c, `${gap}.getAttribute('data-to')`), at(180));
  const spans = await dom(c, `[...${viewer}.querySelectorAll('path[data-series="youtube"]')].map(p => [p.dataset.from, p.dataset.to])`);
  assert.ok(spans.length >= 1);
  assert.ok(spans.every(([from, to]) => from && to && (Date.parse(to) <= Date.parse(at(90)) || Date.parse(from) >= Date.parse(at(180)))), 'ningún segmento atraviesa el hueco ni lo dibuja como cero');
  assert.equal(await dom(c, `!!${viewer}.querySelector('circle.dx-youtube[data-at="${at(180)}"]')`), true, 'la muestra aislada después del hueco sigue visible');
  const chat = `document.querySelector('#detalle svg[aria-label="Mensajes por minuto"]')`;
  assert.equal(await dom(c, `${chat}.querySelectorAll('[data-chat-bar]').length`), 8);
  assert.deepEqual(await dom(c, `[...${chat}.querySelectorAll('[data-chat-bar="twitch"]')].map(e => Number(e.dataset.value))`), [3, 0, 2, 0]);
  assert.deepEqual(await dom(c, `[...${chat}.querySelectorAll('[data-chat-bar="youtube"]')].map(e => Number(e.dataset.value))`), [0, 1, 0, 0]);
  assert.match(await dom(c, `document.querySelector('#detalle').textContent`), /Momentos del directo/);
  const moments = await dom(c, `[...document.querySelectorAll('#detalle .dx-moments li')].map(e => e.textContent)`);
  assert.match(moments.find(x => x.includes('Nuevo seguidor')), /Twitch/);
  assert.match(moments.find(x => x.includes('Super Chat')), /YouTube/);
  assert.doesNotMatch(moments.find(x => x.includes('desconocido')), /Twitch|YouTube/);
  assert.doesNotMatch(await dom(c, `document.querySelector('#detalle').textContent`), /chat conectado/i);

  await dom(c, select('Directo parcial'));
  await wait(c, `document.querySelector('#detalle h2')?.textContent.includes('Directo parcial') && document.querySelector('#detalle').textContent.includes('sin datos de chat')`);
  assert.deepEqual(f.requests, ['z-auto', 'y-partial']);
  const partialRow = row('Directo parcial');
  const missing = await dom(c, `[...${partialRow}.querySelectorAll('[aria-label="sin dato"]')].map(e => e.textContent.trim())`);
  assert.equal(missing.length, 5); assert.ok(missing.every(s => s === '—'));
  assert.match(await dom(c, `${partialRow}.textContent`), /25\s*%.*parcial/i);
  assert.equal(await dom(c, `document.querySelector('#detalle [data-gap="twitch"]')?.getAttribute('data-to')`), partial.endedAt);
  assert.equal(await dom(c, `document.querySelectorAll('#detalle [data-chat-bar="youtube"]').length`), 0);
  await dom(c, select('Directo antiguo'));
  await wait(c, `document.querySelector('#detalle').textContent.includes('no son valores cero')`);
  assert.match(await dom(c, `document.querySelector('#detalle').textContent`), /Sin métricas.*iniciado manualmente o anterior a las métricas/i);
  assert.deepEqual(f.requests, ['z-auto', 'y-partial', 'x-legacy']);
});

// S1/S3/S4/S6: the existing archive slide, tabs and search remain usable at both widths.
test('#114: lista desplazable, búsqueda, resumen completo y diseño adaptable', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const c = await f.open();
  await wait(c, `!!${row('Directo automático')} && !!document.querySelector('#detalle a[href*="/directos/"]')`);
  assert.equal(await dom(c, `document.querySelector('.dx-list .lv-panel-h p').textContent.trim()`), '12 directos · más recientes primero');
  assert.match(await dom(c, `${row('Directo automático')}.textContent`), /4 min/);
  assert.match(await dom(c, `document.querySelector('#detalle .dx-detail-head p').textContent`), /4 min/);
  const region = `document.querySelector('[role="region"][aria-label*="directos"]')`;
  assert.equal(await dom(c, `(() => { const e = ${region}; e.focus(); return document.activeElement === e; })()`), true);
  const layout = await dom(c, `(() => { const r = ${region}, list = r.closest('section'), detail = document.querySelector('#detalle');
    return { list: list.getBoundingClientRect().height, detail: detail.getBoundingClientRect().height,
      client: r.clientHeight, scroll: r.scrollHeight, overflow: getComputedStyle(r).overflowY }; })()`);
  assert.ok(layout.list <= layout.detail + 1, JSON.stringify(layout));
  assert.ok(layout.scroll > layout.client && ['auto', 'scroll'].includes(layout.overflow), JSON.stringify(layout));
  await dom(c, setSearch('antiguo'));
  await wait(c, `!!${row('Directo antiguo')} && !${row('Directo automático')}`);
  assert.equal(await dom(c, `${region}.querySelectorAll('article').length`), 1);
  await dom(c, setSearch(''));
  await wait(c, `!!${row('Directo automático')}`);
  await dom(c, `document.querySelector('#detalle a[href*="/directos/"]').click()`);
  await wait(c, `!!document.querySelector('.lv-slide') && location.hash.startsWith('#/directos/z-auto') && document.querySelector('.lv-slide').textContent.includes('Gracias a')`);
  const tabs = `[...document.querySelectorAll('.lv-slide [role="tab"]')]`;
  assert.deepEqual(await dom(c, `${tabs}.map(e => e.textContent.trim().replace(/\\d+$/, ''))`), ['Resumen', 'Cronología', 'Marcas', 'Exportar']);
  assert.match(await dom(c, `document.querySelector('.lv-slide').textContent`), /Gracias a/);
  assert.match(await dom(c, `document.querySelector('.lv-slide aside .hint').textContent`), /Duración: 4 min/);
  for (const [name, text] of [['Cronología', 'Nuevo seguidor'], ['Marcas', 'Marca de prueba'], ['Exportar', 'Resumen en Markdown']]) {
    await dom(c, `${tabs}.find(e => e.textContent.trim().startsWith(${JSON.stringify(name)})).click()`);
    await wait(c, `document.querySelector('.lv-slide').textContent.includes(${JSON.stringify(text)})`);
  }
  await dom(c, `document.querySelector('.lv-slide a[aria-label="Volver"]').click()`);
  await wait(c, `!document.querySelector('.lv-slide')`);
  await c.cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrow = await dom(c, `(() => { const r = ${region}, list = r.closest('section').getBoundingClientRect(), detail = document.querySelector('#detalle').getBoundingClientRect();
    r.scrollTop = r.scrollHeight;
    return { listBottom: list.bottom, detailTop: detail.top, maxHeight: getComputedStyle(r).maxHeight,
      viewportHeight: innerHeight, client: r.clientHeight, scroll: r.scrollHeight, scrollTop: r.scrollTop, overflow: getComputedStyle(r).overflowY }; })()`);
  assert.ok(narrow.detailTop >= narrow.listBottom, JSON.stringify(narrow));
  assert.ok(parseFloat(narrow.maxHeight) <= narrow.viewportHeight * 0.6 + 1, JSON.stringify(narrow));
  assert.ok(narrow.scroll > narrow.client && narrow.scrollTop > 0 && ['auto', 'scroll'].includes(narrow.overflow), JSON.stringify(narrow));
});

// S3/S6: a single short archive keeps the original rounding and singular labels.
test('#114: duración y singular en directo único y resumen', { timeout: 90000 }, async t => {
  const short = archived('single-short', 'Único directo', at(0), {
    endedAt: at(59.6), events: [{ id: 'e1', at: at(30), type: 'follow', user: 'Ana' }],
    notes: [{ id: 'm1', at: at(40), kind: 'marker', label: 'Marca de prueba' }],
  });
  const f = await fixture(t, { archiveEntries: [short] }); if (!f) return;
  const c = await f.open();
  await wait(c, `!!${row('Único directo')} && document.querySelector('#detalle h2')?.textContent === 'Único directo'`);
  assert.equal(await dom(c, `document.querySelector('main .view-head .crumb').textContent.trim()`), 'Registro · 1 directo');
  assert.equal(await dom(c, `document.querySelector('.dx-list .lv-panel-h p').textContent.trim()`), '1 directo · más recientes primero');
  assert.match(await dom(c, `${row('Único directo')}.textContent`), /1 min/);
  assert.match(await dom(c, `${row('Único directo')}.textContent`), /1 evento/);
  assert.match(await dom(c, `document.querySelector('#detalle .dx-detail-head p').textContent`), /1 min · 1 evento/);
  await dom(c, `document.querySelector('#detalle a[href*="/directos/"]').click()`);
  await wait(c, `!!document.querySelector('.lv-slide aside .hint')`);
  const data = await dom(c, `document.querySelector('.lv-slide aside .hint').textContent`);
  assert.match(data, /Duración: 1 min/);
  assert.match(data, /1 evento · 1 marca/);
});

// S2/S5: loading, failed summaries and stale responses must not misrepresent the selection.
test('#114: carga, error recuperable y respuestas obsoletas de la selección', { timeout: 90000 }, async t => {
  const f = await fixture(t); if (!f) return;
  const listGate = deferred(), summaryGate = deferred(), summaryEntered = deferred();
  f.releases.push(listGate.release, summaryGate.release);
  const list = f.app.session.list.bind(f.app.session), get = f.app.session.get.bind(f.app.session);
  f.app.session.list = async () => { await listGate.promise; return list(); };
  f.app.session.get = async id => { if (id === 'z-auto') { summaryEntered.release(); await summaryGate.promise; } return get(id); };
  const c = await f.open();
  await wait(c, `document.querySelector('main h1')?.textContent.includes('Directos anteriores') && document.querySelector('main').textContent.includes('Cargando')`);
  assert.doesNotMatch(await dom(c, `document.querySelector('main').textContent`), /Todavía no hay directos archivados/);
  listGate.release();
  await wait(c, `!!${row('Directo parcial')}`);
  await summaryEntered.promise;
  await dom(c, select('Directo parcial'));
  await wait(c, `document.querySelector('#detalle h2')?.textContent.includes('Directo parcial') && document.querySelector('#detalle').textContent.includes('sin datos de chat')`);
  // Wait for the delayed response to be parsed and the next frame, not a wall-clock sleep.
  await dom(c, `(() => { const json = Response.prototype.json; window.__staleSummaryRendered = false;
    Response.prototype.json = function() { return json.call(this).then(data => {
      if (data?.id === 'z-auto') requestAnimationFrame(() => { window.__staleSummaryRendered = true; });
      return data;
    }); }; })()`);
  summaryGate.release();
  await wait(c, `window.__staleSummaryRendered`);
  assert.match(await dom(c, `document.querySelector('#detalle h2').textContent`), /Directo parcial/);
  assert.deepEqual(f.requests, ['y-partial', 'z-auto']);
  // Failure of a summary, including a direct Slide route, is visible rather than endless loading.
  f.app.session.get = async id => { if (id === 'x-legacy') throw new Error('fallo sintético'); return get(id); };
  await dom(c, select('Directo antiguo'));
  await wait(c, `!!document.querySelector('#detalle [role="alert"]')`);
  assert.match(await dom(c, `document.querySelector('#detalle [role="alert"]').textContent`), /no se pudo cargar/i);
  f.app.session.get = get;
  await dom(c, `[...document.querySelectorAll('#detalle button')].find(b => /reintentar/i.test(b.textContent)).click()`);
  await wait(c, `document.querySelector('#detalle').textContent.includes('no son valores cero')`);
  await dom(c, `location.hash = '#/directos/ausente/resumen'`);
  await wait(c, `!!document.querySelector('.lv-slide [role="alert"]')`);
  assert.doesNotMatch(await dom(c, `document.querySelector('.lv-slide').textContent`), /Cargando…/);
});

// S1/S5: a finished current session is history, while a live current session is not.
test('#114: directo actual terminado aparece una vez y el directo en curso queda fuera', { timeout: 90000 }, async t => {
  const currentStart = start + 86_400_000;
  const ended = archived('current-ended', 'Directo recién finalizado', at(0, currentStart), {
    meldAutoSession: true,
    viewers: { twitch: { samples: [{ at: at(0, currentStart), value: 42 }], gaps: [], intervals: [{ from: at(0, currentStart), seconds: 240 }] } },
    chatStats: { twitch: { authorIds: ['synthetic-author'], minutes: [{ at: at(0, currentStart), messages: 2 }] } },
  });
  const f = await fixture(t, { current: ended, extraArchives: [{ ...ended, title: 'Duplicado archivado' }] });
  if (!f) return;
  const c = await f.open();
  await wait(c, `!!${row('Directo recién finalizado')} && document.querySelector('#detalle h2')?.textContent === 'Directo recién finalizado' && !!document.querySelector('#detalle svg')`);
  const rows = `[...document.querySelectorAll('[role="region"][aria-label*="directos"] article')]`;
  assert.equal(await dom(c, `${rows}[0].querySelector('h3').textContent`), 'Directo recién finalizado');
  assert.equal(await dom(c, `${row('Directo recién finalizado')}.querySelector('button').getAttribute('aria-pressed')`), 'true');
  assert.equal(await dom(c, `${rows}.length`), 13);
  assert.equal(await dom(c, `!!${row('Duplicado archivado')}`), false);
  assert.equal(await dom(c, `document.querySelector('main .view-head .crumb').textContent.trim()`), 'Registro · 13 directos');
  assert.deepEqual(await dom(c, `[...${row('Directo recién finalizado')}.querySelectorAll('tbody tr')[0].querySelectorAll('td')].map(e => e.textContent.trim())`), ['42,0', '42', '1', '0,5', '100 %']);
  assert.deepEqual(f.requests, ['current-ended']);

  const live = { ...ended, id: 'current-live', title: 'Directo en curso' };
  delete live.endedAt;
  const g = await fixture(t, { current: live });
  if (!g) return;
  const c2 = await g.open();
  await wait(c2, `!!${row('Directo automático')} && document.querySelector('#detalle h2')?.textContent === 'Directo automático' && !!document.querySelector('#detalle svg')`);
  assert.equal(await dom(c2, `!!${row('Directo en curso')}`), false);
  assert.equal(await dom(c2, `${rows}.length`), 12);
  assert.equal(await dom(c2, `document.querySelector('main .view-head .crumb').textContent.trim()`), 'Registro · 12 directos');
  assert.equal(await dom(c2, `${row('Directo automático')}.querySelector('button').getAttribute('aria-pressed')`), 'true');
  assert.deepEqual(g.requests, ['z-auto']);
});
