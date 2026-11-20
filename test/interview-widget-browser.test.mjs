// Interview widget (#277), browser side: every state at 1920×1080 with short and long texts, the
// source line on media items only, pack text shown as text, live updates over SSE, hidden when
// nothing approved is active and the Widgets › Entrevista demo preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const LONG_Q = ('Cuando miras atrás, a esos primeros meses sin audiencia, sin dinero y con muchísimas dudas sobre si merecía la pena seguir, ¿qué decisión concreta lo cambió todo? ').repeat(3).slice(0, 500).trim();
const LONG_POST = 'Hoy hace un año publiqué mi primer proyecto abierto. Tuvo tres estrellas, dos de ellas de mi familia. Lo cuento porque a veces olvidamos que todo lo que ahora parece sólido empezó siendo una cosa pequeña, torpe y bastante fea. '.repeat(3).trim();
const SVG = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#356"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="#e8b36a"/></svg>`;
const INJECT = '<img src=x onerror="window.__pwn=1"> <b id="pwn">negrita</b> <script>window.__pwn=2</script>';

const item = (id, question, extra = {}) => ({ id, question, aprobado: true, notes: 'NOTA-PRIVADA-' + id, ...extra });
const PACK = {
  version: 1, id: 'cine', title: 'Entrevista de prueba', guest: { name: 'Ana' },
  rounds: [{ id: 'r', title: 'Ronda', items: [
    item('solo-corto', '¿Qué harías distinto?'),
    item('solo-largo', LONG_Q),
    item('img-retrato', '¿Dónde se hizo esta foto?', { media: { type: 'image', file: 'retrato.svg' }, source: { url: 'https://example.com/archivo', date: '2026-03-14' } }),
    item('img-largo', LONG_Q, { media: { type: 'image', file: 'paisaje.svg' } }),
    item('video', '¿Cómo grabasteis esta demo?', { media: { type: 'video', file: 'demo.mp4' } }),
    item('yt', '¿Qué pasa en esta parte de la charla?', { media: { type: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', startMinute: 12 } }),
    item('post-corto', '¿Sigues pensando lo mismo?', { media: { type: 'post', author: '@marta', text: 'Acabo de lanzar la versión 2.0.', date: '2026-05-20T10:30:00Z', url: 'https://example.com/post/1' } }),
    item('post-largo', LONG_Q, { media: { type: 'post', author: '@marta_con_un_nombre_bastante_largo', text: LONG_POST, date: '2026-05-20', url: 'https://example.com/post/1' } }),
    item('inyeccion', INJECT, { media: { type: 'post', author: '<b id="a">autor</b>', text: INJECT, date: '2026-05-20', url: 'https://example.com/post/2' }, source: { url: 'https://example.com/s', date: '2026-01-01' } }),
    { ...item('sin-aprobar', 'Pregunta sin aprobar'), aprobado: false },
  ] }],
};

async function start(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH para ejecutar las pruebas de navegador'); return null; }
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-interview-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const mediaDir = path.join(dataDir, 'media');
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, 'retrato.svg'), SVG(900, 1200));
  await writeFile(path.join(mediaDir, 'paisaje.svg'), SVG(1600, 900));
  const app = await createApp({ dataDir, mediaDir, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { bin, base, api, close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

/** Chrome at 1920×1080 pointed at `url`. */
async function open(bin, url) {
  const chrome = await openChromePage(bin, 'about:blank');
  const c = chrome.cdp;
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errors = []; addEventListener('error', e => window.__errors.push(String(e.message)));` });
  await c.send('Page.navigate', { url });
  return chrome;
}
const run = (c, expr) => evaluateChrome(c, expr);
const settle = () => new Promise(r => setTimeout(r, 450));
// The widget flags data-fitted="1" once fonts are loaded and the final fit() pass ran.
const FITTED = `document.getElementById('root')?.dataset.fitted === '1'`;

/** Everything visible has to sit inside the canvas and no text box may clip its content. */
const REPORT = `(() => {
  const vis = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && parseFloat(getComputedStyle(e).opacity) > 0;
  const inside = e => { const r = e.getBoundingClientRect(); return r.left >= -0.5 && r.top >= -0.5 && r.right <= 1920.5 && r.bottom <= 1080.5; };
  const boxes = ['q', 'post', 'src', 'full'].map(id => document.getElementById(id)).filter(vis);
  const clipped = [...document.querySelectorAll('#q, #q .inner, #post, #pt, #pn, #pu, #text')].filter(vis).filter(e => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).map(e => e.id || e.className);
  const q = document.getElementById('q'), post = document.getElementById('post');
  return JSON.stringify({
    outside: boxes.filter(e => !inside(e)).map(e => e.id),
    clipped,
    overlap: vis(post) && !document.getElementById('root').classList.contains('solo') ? post.getBoundingClientRect().bottom > q.getBoundingClientRect().top + 0.5 : false,
    hScroll: document.documentElement.scrollWidth > 1920,
    cards: [...document.querySelectorAll('.eg-card')].filter(vis).map(e => e.id + ':' + e.textContent.trim().length),
    src: vis(document.getElementById('src')) ? document.getElementById('srcText').textContent : null,
    text: document.getElementById('text').textContent,
    size: parseFloat(getComputedStyle(document.getElementById('text')).fontSize),
  });
})()`;
const report = async c => JSON.parse(await run(c, REPORT));
const shown = (text) => `document.getElementById('root').classList.contains('on') && document.getElementById('text').textContent === ${JSON.stringify(text)}`;

test('demo: every sample state fits 1920×1080 without cuts, with the source on media items only', { timeout: 180000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const { bin, base, close } = ctx;
  let chrome;
  try {
    // [item N, has media]
    const states = [[1, false], [2, false], [3, true], [4, true], [5, true], [6, true], [7, true], [8, true]];
    chrome = await open(bin, `${base}/widget/interview?demo&item=1`);
    const c = chrome.cdp;
    for (const [n, media] of states) {
      await c.send('Page.navigate', { url: `${base}/widget/interview?demo&item=${n}` });
      await waitDom(c, `document.getElementById('root')?.classList.contains('on') && ${FITTED}`, { timeoutMs: 15000 });
      await settle();
      const r = await report(c);
      assert.deepEqual({ outside: r.outside, clipped: r.clipped, overlap: r.overlap, hScroll: r.hScroll }, { outside: [], clipped: [], overlap: false, hScroll: false }, `demo item ${n}`);
      assert.equal(r.src !== null, media, `demo item ${n}: source line only with media`);
      if (media) assert.ok(r.src.length > 0, `demo item ${n}: source line has text`);
      // only the cards of this state are visible, none of them empty: the question card, plus the post card on post items
      const ids = r.cards.map(x => x.split(':')[0]);
      assert.deepEqual(ids, n >= 7 ? ['post', 'q'] : ['q'], `demo item ${n}: visible cards`);
      assert.ok(r.cards.every(x => Number(x.split(':')[1]) > 0), `demo item ${n}: no empty card`);
    }
    assert.deepEqual(await run(c, `window.__errors`), []);
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('live: each pack state renders from the API, long texts autosize and nothing is cut', { timeout: 240000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const { bin, base, api, close } = ctx;
  let chrome;
  try {
    assert.equal((await api('POST', '/api/interviews/import', PACK)).status, 200);
    chrome = await open(bin, `${base}/widget/interview?tuckMs=700`);
    const c = chrome.cdp;
    const select = id => api('POST', '/api/interviews/select', { id: 'cine', itemId: id });
    const go = async (id, question) => {
      assert.equal((await select(id)).status, 200, id);
      await waitDom(c, `${shown(question)} && ${FITTED}`, { timeoutMs: 15000 });
      await settle();
      return report(c);
    };
    const clean = (r, id) => assert.deepEqual({ outside: r.outside, clipped: r.clipped, overlap: r.overlap, hScroll: r.hScroll }, { outside: [], clipped: [], overlap: false, hScroll: false }, id);

    let r = await go('solo-corto', '¿Qué harías distinto?');
    clean(r, 'solo-corto'); assert.equal(r.src, null, 'text-only item: no source line');
    assert.equal(await run(c, `document.getElementById('root').classList.contains('solo')`), true);
    const shortSize = r.size;
    r = await go('solo-largo', LONG_Q);
    clean(r, 'solo-largo'); assert.equal(r.src, null);
    assert.ok(r.size < shortSize, 'long text autosizes below the short text size');

    r = await go('img-retrato', '¿Dónde se hizo esta foto?');
    clean(r, 'img-retrato'); assert.equal(r.src, 'example.com · 14 mar 2026');
    const img = JSON.parse(await run(c, `JSON.stringify({ fg: getComputedStyle(document.querySelector('#full .fg')).objectFit, bg: getComputedStyle(document.querySelector('#full .bg')).filter, same: document.querySelector('#full .fg').src === document.querySelector('#full .bg').src, src: new URL(document.querySelector('#full .fg').src).pathname })`));
    assert.equal(img.fg, 'contain', 'the picture is never cropped');
    assert.match(img.bg, /blur/, 'a blurred copy fills the canvas behind it');
    assert.equal(img.same, true); assert.equal(img.src, '/media/retrato.svg');
    assert.equal(await run(c, `document.getElementById('root').classList.contains('solo')`), false);

    r = await go('img-largo', LONG_Q);
    clean(r, 'img-largo'); assert.equal(r.src, 'Archivo local · paisaje.svg', 'no pack source: where the media comes from');

    r = await go('video', '¿Cómo grabasteis esta demo?');
    clean(r, 'video'); assert.equal(r.src, 'Archivo local · demo.mp4');
    assert.equal(await run(c, `new URL(document.querySelector('#full video.fg').src).pathname`), '/media/demo.mp4');

    r = await go('yt', '¿Qué pasa en esta parte de la charla?');
    clean(r, 'yt'); assert.equal(r.src, 'YouTube · desde 12:00');
    assert.equal(await run(c, `document.querySelector('#full iframe').src`), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=720&autoplay=1&rel=0&playsinline=1');
    assert.equal(await run(c, `document.querySelector('#full iframe').getAttribute('sandbox').includes('allow-top-navigation')`), false);
    await waitDom(c, `document.getElementById('q').classList.contains('tuck')`, { timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 800));
    assert.ok(await run(c, `document.getElementById('q').getBoundingClientRect().top >= 1080`), 'the question card leaves the player uncovered');
    // the next item brings the card back
    r = await go('img-retrato', '¿Dónde se hizo esta foto?');
    assert.equal(await run(c, `document.getElementById('q').classList.contains('tuck')`), false);
    assert.equal(await run(c, `!!document.querySelector('#full iframe')`), false, 'the player is removed when the item changes');

    r = await go('post-corto', '¿Sigues pensando lo mismo?');
    clean(r, 'post-corto');
    assert.equal(r.src, 'example.com · @marta');
    assert.deepEqual(JSON.parse(await run(c, `JSON.stringify([pn.textContent, pu.textContent, pt.textContent, pd.textContent])`)), ['@marta', 'example.com', 'Acabo de lanzar la versión 2.0.', '20 may 2026, 10:30']);
    r = await go('post-largo', LONG_Q);
    clean(r, 'post-largo');
    assert.ok(await run(c, `parseFloat(getComputedStyle(pt).fontSize) < 44`), 'long post text autosizes');

    assert.deepEqual(await run(c, `window.__errors`), []);
    assert.equal(await run(c, `document.documentElement.outerHTML.includes('NOTA-PRIVADA')`), false, 'private notes are never in the page');
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('pack text is shown as text: no element is injected and no script runs', { timeout: 120000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const { bin, base, api, close } = ctx;
  let chrome;
  try {
    await api('POST', '/api/interviews/import', PACK);
    chrome = await open(bin, `${base}/widget/interview`);
    const c = chrome.cdp;
    await api('POST', '/api/interviews/select', { id: 'cine', itemId: 'inyeccion' });
    await waitDom(c, shown(INJECT), { timeoutMs: 15000 });
    const dom = JSON.parse(await run(c, `JSON.stringify({
      injected: document.querySelectorAll('#root img[onerror], #root b, #root script').length,
      pwn: window.__pwn === undefined,
      author: pn.textContent, text: pt.textContent,
      images: document.querySelectorAll('#root img').length,
    })`));
    assert.deepEqual(dom, { injected: 0, pwn: true, author: '<b id="a">autor</b>', text: INJECT, images: 0 });
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('hidden without an approved active item; selecting through the API updates the widget live', { timeout: 150000 }, async t => {
  const ctx = await start(t); if (!ctx) return;
  const { bin, base, api, close } = ctx;
  let chrome;
  try {
    await api('POST', '/api/interviews/import', PACK);
    chrome = await open(bin, `${base}/widget/interview`);
    const c = chrome.cdp;
    await settle();
    const hidden = `getComputedStyle(document.getElementById('root')).opacity === '0' && !document.getElementById('root').classList.contains('on')`;
    assert.equal(await run(c, hidden), true, 'nothing active: the widget paints nothing');

    await api('POST', '/api/interviews/select', { id: 'cine', itemId: 'solo-corto' });
    await waitDom(c, shown('¿Qué harías distinto?'), { timeoutMs: 15000 });
    await api('POST', '/api/interviews/select', { id: 'cine', itemId: 'post-corto' });
    await waitDom(c, shown('¿Sigues pensando lo mismo?'), { timeoutMs: 15000 });

    // an unapproved item cannot be activated: the widget keeps showing the previous one
    assert.equal((await api('POST', '/api/interviews/select', { id: 'cine', itemId: 'sin-aprobar' })).status, 409);
    await settle();
    assert.equal(await run(c, `document.getElementById('text').textContent`), '¿Sigues pensando lo mismo?');
    assert.equal(await run(c, `document.documentElement.outerHTML.includes('sin aprobar')`), false);

    // editing the active item repaints it; un-approving it hides the widget
    const iv = (await api('GET', '/api/interviews/cine')).body.interview;
    iv.rounds[0].items.find(x => x.id === 'post-corto').question = 'Pregunta editada';
    await api('PUT', '/api/interviews/cine', { rounds: iv.rounds });
    await waitDom(c, shown('Pregunta editada'), { timeoutMs: 15000 });
    iv.rounds[0].items.find(x => x.id === 'post-corto').aprobado = false;
    await api('PUT', '/api/interviews/cine', { rounds: iv.rounds });
    await waitDom(c, hidden, { timeoutMs: 15000 });

    await api('POST', '/api/interviews/select', { id: 'cine', itemId: 'solo-corto' });
    await waitDom(c, shown('¿Qué harías distinto?'), { timeoutMs: 15000 });
    await api('DELETE', '/api/interviews/cine');
    await waitDom(c, hidden, { timeoutMs: 15000 });
    assert.deepEqual(await run(c, `window.__errors`), []);
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});

test('Widgets › Entrevista shows the demo preview and the card is in the catalog', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return;
  const ctx = await start(t); if (!ctx) return;
  const { base, close } = ctx;
  let chrome;
  try {
    chrome = await openChromePage(bin, `${base}/#/widgets/interview`);
    const c = chrome.cdp;
    const src = `document.querySelector('main .preview-col .eg-stage iframe')?.getAttribute('src') || ''`;
    await waitDom(c, `(${src}) === '/widget/interview?demo'`, { timeoutMs: 15000 });
    assert.match(await run(c, `document.querySelector('main .preview-col .eg-stage__bar').textContent`), /Datos de ejemplo/);
    assert.match(await run(c, `document.querySelector('main .browser-source')?.textContent || ''`), /\/widget\/interview/);
    assert.match(await run(c, `document.querySelector('main').textContent`), /1920×1080/);
    await c.send('Page.navigate', { url: `${base}/#/widgets` });
    await waitDom(c, `[...document.querySelectorAll('main a[href="#/widgets/interview"]')].length > 0`, { timeoutMs: 15000 });
  } finally { await closeAll(() => chrome && closeChrome(chrome), close); }
});
