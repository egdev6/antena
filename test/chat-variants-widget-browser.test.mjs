// #126 · El widget real, por HTTP/SSE y Chrome; nunca usa la configuración interna del servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const ROUTE = '/api/widgets/chat/variants';
const opts = { timeoutMs: 10000, intervalMs: 20 };
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 10000 });
const wait = (c, expression) => waitDom(c, expression, opts);
const q = value => JSON.stringify(value);
const has = text => `Array.from(document.querySelectorAll('.msg')).some(e => e.textContent.includes(${q(text)}))`;

async function fixture(t) {
  const bin = await findChrome();
  assert.ok(bin, 'Chrome es obligatorio para esta regresión');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-126-widget-'));
  let app;
  const pages = [];
  t.after(async () => {
    await closeAll(...pages.map(page => () => closeChrome(page)), async () => {
      if (app) {
        app.teleprompter.stop(); app.viewers.stop(); app.meld.stop(); app.timers.stop();
        app.engine.flushScheduledSends(); app.server.closeAllConnections();
        await new Promise(resolve => app.server.close(resolve));
      }
    }, () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const port = app.server.address().port;
  assert.notEqual(port, 4500);
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const result = await r.json();
    assert.equal(r.status, 200, `${method} ${url}: ${JSON.stringify(result)}`);
    return result;
  };
  const create = async name => (await request('POST', ROUTE, { name })).variant.id;
  const update = (id, fields) => request('PUT', `${ROUTE}/${id}`, fields);
  const send = (text, fields = {}) => request('POST', '/api/chat/simulate', { user: 'Viewer', text, platform: 'twitch', ...fields });
  const page = async query => {
    const chrome = await openChromePage(bin, `${base}/widget/chat${query}`);
    pages.push(chrome);
    await wait(chrome.cdp, `!!document.getElementById('root')?.dataset.animIn`);
    return chrome.cdp;
  };
  return { request, create, update, send, page };
}

async function shot(c, name) {
  if (!process.env.CHAT_VARIANT_SHOTS) return;
  const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(process.env.CHAT_VARIANT_SHOTS, name), Buffer.from(data, 'base64'));
}
const resize = (c, width, height) => c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

// S2/S8: sin selector y con ids desconocidos se conserva el chat anterior; layout no es un parámetro.
test('chat: URL predeterminada, ids exactos y layout independiente ignorado', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const id = await f.create('En vivo');
  await f.update(id, { layout: 'horizontal', fontSize: 41, animIn: 'none' });
  for (const query of ['', '?layout=horizontal', '?variant=desconocida', '?variant=EN-VIVO', '?variant=']) {
    const c = await f.page(query);
    assert.equal(await dom(c, `getComputedStyle(document.querySelector('#root')).flexDirection`), 'column', query);
    assert.equal(await dom(c, `getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim()`), '26px', query);
    assert.equal(await dom(c, `document.querySelector('#root').dataset.animIn`), 'slide', query);
    assert.equal(await dom(c, `document.querySelector('#root').classList.contains('horizontal')`), false, query);
  }
  const c = await f.page('');
  await f.send('legado');
  await wait(c, has('legado'));
  assert.equal(await dom(c, `document.querySelector('.msg').classList.contains('a-slide')`), true);
  assert.equal(await dom(c, `!!document.querySelector('.msg .pf svg')`), true);
  await shot(c, 'legacy.png');
  const scaled = await f.page(`?variant=${id}&scale=0.8`);
  assert.equal(await dom(scaled, `document.documentElement.style.getPropertyValue('--scale')`), '0.8');
  assert.equal(await dom(scaled, `Math.round(new DOMMatrix(getComputedStyle(document.querySelector('#root')).transform).a * 10)`), 8);
});

// Cada aplicación resuelve la variante completa de nuevo; los cambios llegan por el SSE existente.
test('chat: selección, independencia de filtros/CSS y fallback al borrar en vivo', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  await f.request('PUT', '/api/widgets', { chat: { fontSize: 24, platforms: ['twitch'], css: '.msg{border-right:3px solid rgb(0,0,255)}' } });
  const id = await f.create('Invitado');
  await f.update(id, { layout: 'horizontal', fontSize: 42, platforms: ['youtube'], hideCommands: false, hideOwner: false, showPlatform: false, reverse: true, animIn: 'none', animOut: 'none', maxMessages: 5, css: '.msg{border-right:7px solid rgb(0,255,0)} .text{letter-spacing:7px}' });
  const c = await f.page(`?variant=${id}`);
  await resize(c, 1832, 360); // Tres mensajes caben a la vez: el tope por ancho se prueba aparte.
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim()`), '42px');
  assert.equal(await dom(c, `document.querySelector('#root').classList.contains('horizontal') && document.querySelector('#root').classList.contains('reverse')`), true);
  for (const [text, fields] of [['uno', { platform: 'youtube' }], ['ignorado', {}], ['!comando', { platform: 'youtube' }], ['dueño', { platform: 'youtube', owner: true }]]) await f.send(text, fields);
  await wait(c, `${has('uno')} && ${has('!comando')} && ${has('dueño')}`);
  assert.equal(await dom(c, has('ignorado')), false);
  assert.equal(await dom(c, `document.querySelectorAll('.msg .pf').length`), 0);
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg')).borderRightColor`), 'rgb(0, 255, 0)');
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.text')).letterSpacing`), '7px');
  await f.request('PUT', '/api/widgets', { chat: { fontSize: 31, css: '.msg{border-right:9px solid rgb(0,0,255)}' } });
  // Se espera un evento de widgets distinto en la capa sin leer cfg ni estado interno.
  await f.update(id, { name: 'Renombrado' });
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim()`), '42px');
  await f.update(id, { platforms: ['twitch'], hideCommands: true, hideOwner: true, showPlatform: true, reverse: false, fontSize: 35, css: '.msg{border-right:4px solid rgb(255,0,0)}' });
  await wait(c, `getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim() === '35px' && !document.querySelector('.msg')`);
  await f.send('conservado'); await f.send('!oculto'); await f.send('propio oculto', { owner: true });
  await wait(c, has('conservado'));
  assert.equal(await dom(c, has('!oculto')), false);
  assert.equal(await dom(c, has('propio oculto')), false);
  assert.equal(await dom(c, `!!document.querySelector('.msg .pf svg')`), true);
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg')).borderRightColor`), 'rgb(255, 0, 0)');
  assert.notEqual(await dom(c, `getComputedStyle(document.querySelector('.text')).letterSpacing`), '7px');
  await f.update(id, { css: '.msg{border-right:4px solid rgb(255,0,0)} .text{letter-spacing:7px}' });
  await wait(c, `getComputedStyle(document.querySelector('.text')).letterSpacing === '7px'`);
  await f.request('DELETE', `${ROUTE}/${id}`);
  await wait(c, `getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim() === '31px'`);
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('#root')).flexDirection`), 'column');
  assert.equal(await dom(c, `document.querySelector('#root').classList.contains('reverse')`), false);
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg')).borderRightColor`), 'rgb(0, 0, 255)');
  assert.notEqual(await dom(c, `getComputedStyle(document.querySelector('.text')).letterSpacing`), '7px');
});

// La medida se hace sobre DOM retenido, no solo sobre tarjetas visualmente ocultas.
test('chat horizontal: geometría, recorte, resize, tope y espejo', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const id = await f.create('Fila');
  await f.update(id, { layout: 'horizontal', maxMessages: 12, animIn: 'none', animOut: 'none', hideOwner: false });
  const c = await f.page(`?variant=${id}&debug`);
  await resize(c, 1832, 160);
  for (let n = 0; n < 12; n++) await f.send(`fila-${n} ` + (n === 11 ? 'palabralarga'.repeat(24) : 'hola'));
  await wait(c, has('fila-11'));
  const geometry = () => dom(c, `(() => { const r = document.querySelector('#root'), box = r.getBoundingClientRect();
    const cards = [...r.querySelectorAll('.msg')].map(e => { const b = e.getBoundingClientRect(); return {left:b.left, right:b.right, top:b.top, height:b.height, width:b.width, text:e.textContent}; });
    return {left:box.left, right:box.right, top:box.top, bottom:box.bottom, cards, mask:getComputedStyle(r).maskImage}; })()`);
  let g = await geometry();
  await shot(c, 'horizontal-1832.png');
  assert.ok(g.cards.length > 1 && g.cards.length <= 6, JSON.stringify(g));
  assert.ok(g.cards.every(card => card.width <= 380.5 && card.right > g.left && card.left < g.right), 'sin tarjetas totalmente fuera');
  assert.ok(g.cards.every(card => Math.abs(card.height - g.cards[0].height) < 1 && Math.abs(card.top - g.cards[0].top) < 1), 'una fila de altura común');
  assert.ok(g.cards.at(-1).text.includes('fila-11') && g.cards.at(-1).left > g.cards.at(-2).left, 'lo nuevo a la derecha');
  assert.match(g.mask, /linear-gradient\(to right, rgba\(0, 0, 0, 0\).*rgb\(0, 0, 0\)/, 'el borde izquierdo se desvanece');
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg:last-child .text')).webkitLineClamp`), '2');
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg:last-child .text')).overflow`), 'hidden');
  assert.ok(await dom(c, `(() => { const e=document.querySelector('.msg:last-child .text'); return e.getBoundingClientRect().height <= parseFloat(getComputedStyle(e).lineHeight)*2+1; })()`), 'dos líneas visibles');
  // La caja puede ser incluso más estrecha que su padding; tampoco conserva historia oculta.
  await resize(c, 24, 360);
  await wait(c, `document.querySelectorAll('.msg').length === 1`);
  assert.equal(await dom(c, has('fila-11')), true, 'el último sobrevive en un ancho extremo');
  await resize(c, 220, 360);
  await wait(c, `document.querySelectorAll('.msg').length <= 2`);
  g = await geometry();
  assert.ok(g.cards.every(card => card.width <= 220 && card.right > g.left && card.left < g.right));
  await f.update(id, { reverse: true, fontSize: 80, maxMessages: 2 });
  await wait(c, `document.querySelector('#root').classList.contains('reverse') && getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim() === '80px'`);
  g = await geometry();
  assert.ok(g.cards.length <= 2 && g.cards.every(card => card.width <= 220 && card.right > g.left && card.left < g.right), '80px también cabe en una capa estrecha');
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg')).fontSize`), '80px', 'se respeta la fuente si hay altura');
  assert.ok(await dom(c, `(() => { const e=document.querySelector('.msg:last-child .text'); return e.getBoundingClientRect().bottom <= e.closest('.msg').getBoundingClientRect().bottom; })()`));
  await shot(c, 'horizontal-narrow-80px.png');
  await resize(c, 220, 160);
  await wait(c, `innerHeight === 160`);
  g = await geometry();
  await shot(c, 'horizontal-narrow-short-80px.png');
  assert.ok(g.cards.every(card => card.top >= g.top - 1 && card.top + card.height <= g.bottom + 1), 'fuente grande también cabe en una fila de 160px');
  assert.ok(await dom(c, `parseFloat(getComputedStyle(document.querySelector('.msg')).fontSize) < 80`), 'la fuente se adapta solo si falta altura');
  await resize(c, 1832, 360);
  for (let n = 12; n < 17; n++) await f.send(`fila-${n} ` + 'largo'.repeat(40));
  await wait(c, has('fila-16'));
  g = await geometry();
  await shot(c, 'horizontal-reverse-80px.png');
  assert.equal(g.cards.length, 2, 'maxMessages también limita con ancho disponible');
  assert.ok(g.cards.at(-1).text.includes('fila-16') && g.cards.at(-1).right < g.cards.at(-2).right, 'lo nuevo a la izquierda');
  assert.ok(g.cards.every(card => card.width <= 380.5 && Math.abs(card.height - g.cards[0].height) < 1));
  assert.match(g.mask, /linear-gradient\(to left, rgba\(0, 0, 0, 0\).*rgb\(0, 0, 0\)/, 'el borde derecho se desvanece');
  assert.ok(await dom(c, `(() => { const e=document.querySelector('.msg:last-child .text'); return e.getBoundingClientRect().height <= parseFloat(getComputedStyle(e).lineHeight)*2+1 && e.getBoundingClientRect().bottom <= e.closest('.msg').getBoundingClientRect().bottom; })()`), '80px sin desbordar la tarjeta');
  // Salidas animadas durante una ráfaga no dejan un montón de tarjetas fuera del viewport.
  await resize(c, 620, 360);
  await f.update(id, { animOut: 'fade', maxMessages: 12 });
  await wait(c, `document.querySelector('#root').dataset.animOut === 'fade'`);
  for (let n = 17; n < 32; n++) await f.send(`fila-${n}`);
  await wait(c, has('fila-31'));
  g = await geometry();
  assert.ok(g.cards.length <= 4, `DOM acotado incluso durante las salidas: ${g.cards.length}`);
  assert.ok(g.cards.every(card => card.right > g.left && card.left < g.right), 'ninguna tarjeta retenida totalmente fuera');
});

// La tarjeta y sus dos líneas deben caber en la zona útil, también con una capa más baja.
test('chat horizontal: capas bajas conservan tarjetas y contenido dentro de la fila', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const id = await f.create('Capa baja');
  await f.update(id, { layout: 'horizontal', fontSize: 20, animIn: 'none', animOut: 'none' });
  const c = await f.page(`?variant=${id}&debug`);
  await resize(c, 1832, 120);
  for (let n = 0; n < 3; n++) await f.send(`altura ${n}: ` + 'muchas palabras visibles '.repeat(10), { user: `Autora ${n}` });
  await wait(c, has('altura 2'));

  const geometry = () => dom(c, `(() => {
    const r = document.querySelector('#root'), s = getComputedStyle(r);
    const box = e => { const b = e.getBoundingClientRect(); return {left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:b.width, height:b.height}; };
    const lines = node => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].filter(b => b.width && b.height).map(b => ({left:b.left, right:b.right, top:b.top, bottom:b.bottom})); };
    return {root:box(r), paddingTop:parseFloat(s.paddingTop), paddingBottom:parseFloat(s.paddingBottom), direction:s.flexDirection,
      cards:[...r.querySelectorAll('.msg')].map(e => { const body=e.querySelector('.body'), who=e.querySelector('.who'), text=e.querySelector('.text');
        return {card:box(e), body:box(body), who:box(who), author:who.textContent, authorLines:lines(who.firstChild),
          icon:box(who.querySelector('.pf')), text:box(text), textLines:lines(text), message:text.textContent,
          lineHeight:parseFloat(getComputedStyle(text).lineHeight), clamp:getComputedStyle(text).webkitLineClamp, fontSize:parseFloat(getComputedStyle(e).fontSize)}; })};
  })()`);
  const within = (inner, outer) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
  for (const [height, fontSize] of [[120, 20], [120, 80], [100, 80], [160, 20], [160, 80]]) {
    await resize(c, 1832, height);
    await f.update(id, { fontSize });
    await wait(c, `innerHeight === ${height} && getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim() === '${fontSize}px'`);
    const g = await geometry(), label = `${height}px / fontSize ${fontSize}: ${JSON.stringify(g)}`;
    if (height === 120 && fontSize === 20) await shot(c, 'horizontal-120.png');
    assert.equal(g.direction, 'row', label);
    assert.equal(g.cards.length, 3, label);
    assert.ok(g.cards.every((v, i) => v.author.includes(`Autora ${i}`) && v.message.startsWith(`altura ${i}:`)), label);
    assert.ok(g.cards.every((v, i) => !i || v.card.left > g.cards[i - 1].card.left), label);
    assert.ok(g.cards.every(v => v.card.width <= 380.5 && Math.abs(v.card.height - g.cards[0].card.height) < 1 && Math.abs(v.card.top - g.cards[0].card.top) < 1), label);
    assert.ok(g.cards.every(v => within(v.card, { ...g.root, top: g.root.top + g.paddingTop, bottom: g.root.bottom - g.paddingBottom })), `tarjetas dentro de la zona útil: ${label}`);
    for (const v of g.cards) {
      assert.ok(within(v.body, v.card) && within(v.who, v.body) && within(v.icon, v.body), `autor dentro de la tarjeta: ${label}`);
      assert.ok(v.authorLines.length && v.authorLines.every(line => within(line, v.body)), `nombre visible: ${label}`);
      assert.equal(v.clamp, '2', label);
      assert.ok(v.text.height >= v.lineHeight * 2 - 1 && v.text.height <= v.lineHeight * 2 + 1, `dos líneas: ${label}`);
      assert.ok(within(v.text, v.body) && v.textLines.length >= 2 && v.textLines.slice(0, 2).every(line => within(line, v.body)), `mensaje dentro de la tarjeta: ${label}`);
    }
    if (height === 160 && fontSize === 20) {
      assert.ok(g.cards.every(v => Math.abs(v.card.height - 104) < 1 && v.fontSize === 20), `referencia de 160px: ${label}`);
    }
    if (height === 160 && fontSize === 80) assert.ok(g.cards.every(v => v.fontSize > 25 && v.fontSize < 80), label);
  }

  const legacy = await f.page('');
  await resize(legacy, 600, 900);
  await wait(legacy, has('altura 2'));
  assert.deepEqual(await dom(legacy, `(() => { const r=getComputedStyle(document.querySelector('#root')), m=getComputedStyle(document.querySelector('.msg'));
    return [r.flexDirection, r.paddingTop, r.paddingBottom, m.fontSize, m.paddingTop, m.paddingBottom]; })()`), ['column', '18px', '18px', '26px', '12px', '13px'], 'geometría vertical predeterminada sin cambios');
});

// Las familias son sufijos reales de public/fonts.css; el CSS de la variante fuerza el fallback
// también cuando Barlow está instalado. Se comprueban las cajas que realmente recortan texto.
test('chat horizontal: líneas contenidas con las familias fallback declaradas', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const id = await f.create('Fuentes de reserva');
  await f.update(id, { layout: 'horizontal', fontSize: 20, animIn: 'none', animOut: 'none' });
  const c = await f.page(`?variant=${id}`);
  await resize(c, 1832, 120);
  for (let n = 0; n < 3; n++) await f.send(`reserva ${n}: ` + 'muchas palabras visibles '.repeat(10), { user: `Ana ${n}` });
  await wait(c, has('reserva 2'));

  const geometry = () => dom(c, `(() => {
    const root = document.querySelector('#root'), rs = getComputedStyle(root);
    const box = e => { const b=e.getBoundingClientRect(); return {left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:b.width, height:b.height}; };
    const lines = node => { const range=document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].filter(b => b.width && b.height).map(b => ({left:b.left, right:b.right, top:b.top, bottom:b.bottom})); };
    return {root:box(root), paddingTop:parseFloat(rs.paddingTop), paddingBottom:parseFloat(rs.paddingBottom), direction:rs.flexDirection,
      cards:[...root.querySelectorAll('.msg')].map(e => { const body=e.querySelector('.body'), who=e.querySelector('.who'), text=e.querySelector('.text');
        return {card:box(e), body:box(body), who:box(who), author:who.firstChild.textContent, authorLines:lines(who.firstChild), icon:box(who.querySelector('.pf')),
          text:box(text), textLines:lines(text), message:text.textContent, clamp:getComputedStyle(text).webkitLineClamp,
          lineHeight:parseFloat(getComputedStyle(text).lineHeight), fontSize:parseFloat(getComputedStyle(e).fontSize)}; })};
  })()`);
  const within = (inner, outer) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1 && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
  for (const cond of ["'Arial Narrow',sans-serif", "'DejaVu Sans Condensed',sans-serif", 'sans-serif']) {
    for (const body of ["'Segoe UI',system-ui,sans-serif", 'system-ui,sans-serif', 'sans-serif']) {
      await f.update(id, { css: `:root{--f-cond:${cond};--f-body:${body}}` });
      await wait(c, `getComputedStyle(document.querySelector('#root')).getPropertyValue('--f-cond').trim() === ${q(cond)} && getComputedStyle(document.querySelector('#root')).getPropertyValue('--f-body').trim() === ${q(body)}`);
      for (const [height, fontSize] of [[100, 20], [100, 80], [120, 20], [120, 80], [160, 20], [160, 80], [360, 80]]) {
        await resize(c, 1832, height);
        await f.update(id, { fontSize });
        await wait(c, `innerHeight === ${height} && getComputedStyle(document.querySelector('#root')).getPropertyValue('--fs').trim() === '${fontSize}px'`);
        const g = await geometry(), label = `${cond} / ${body} / ${height}px / fontSize ${fontSize}: ${JSON.stringify(g)}`;
        assert.equal(g.direction, 'row', label);
        assert.equal(g.cards.length, 3, label);
        assert.ok(g.cards.every((v, i) => v.author === `Ana ${i}` && v.message.startsWith(`reserva ${i}:`) && (!i || v.card.left > g.cards[i - 1].card.left)), label);
        assert.ok(g.cards.every(v => v.card.width <= 380.5 && Math.abs(v.card.height - g.cards[0].card.height) < 1 && Math.abs(v.card.top - g.cards[0].card.top) < 1), label);
        assert.ok(g.cards.every(v => within(v.card, { ...g.root, top:g.root.top + g.paddingTop, bottom:g.root.bottom - g.paddingBottom })), label);
        for (const v of g.cards) {
          assert.ok(within(v.body, v.card) && within(v.who, v.body) && within(v.icon, v.who), label);
          assert.ok(v.authorLines.length && v.authorLines.every(line => within(line, v.who) && within(line, v.body)), `nombre sin recorte: ${label}`);
          assert.equal(v.clamp, '2', label);
          assert.ok(v.text.height >= v.lineHeight * 2 - 1 && v.text.height <= v.lineHeight * 2 + 1, label);
          assert.ok(within(v.text, v.body) && v.textLines.length >= 2 && v.textLines.slice(0, 2).every(line => within(line, v.text) && within(line, v.body)), `dos líneas sin recorte: ${label}`);
          if (height === 160 && fontSize === 20) assert.ok(Math.abs(v.card.height - 104) < 1 && v.fontSize === 20, label);
          if (height === 360) assert.equal(v.fontSize, 80, label);
          if (fontSize === 80 && height <= 160) assert.ok(v.fontSize < 80, label);
        }
      }
      assert.equal((await f.request('GET', ROUTE)).find(v => v.id === id).fontSize, 80, 'el ajuste guardado no cambia al adaptar la fuente');
    }
  }
});

// Muestrea matrices de las animaciones reales del navegador, no nombres internos de keyframes.
test('chat horizontal: matrices direccionales, efectos neutros y movimiento reducido', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const id = await f.create('Animaciones');
  await f.update(id, { layout: 'horizontal', maxMessages: 1, fadeAfterSec: 0 });
  const c = await f.page(`?variant=${id}`);
  await resize(c, 1000, 300);
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  assert.equal(await dom(c, `matchMedia('(prefers-reduced-motion: no-preference)').matches`), true);
  assert.equal(await dom(c, `matchMedia('(prefers-reduced-motion: reduce)').matches`), false);
  const sample = async (selector, end) => dom(c, `(() => {
    const el = document.querySelector(${q(selector)}), a = el.getAnimations().find(x => x.effect?.target === el);
    if (!a) return {name:getComputedStyle(el).animationName};
    a.pause(); a.currentTime = ${end ? 'Math.max(0, a.effect.getComputedTiming().duration - 1)' : '1'};
    const s = getComputedStyle(el), m = new DOMMatrix(s.transform === 'none' ? undefined : s.transform);
    return {name:s.animationName, x:m.m41, y:m.m42, rotationY:m.m13, rotationX:m.m23, origin:s.transformOrigin};
  })()`);
  let n = 0;
  for (const reverse of [false, true]) {
    for (const anim of ['slide', 'bounce', 'drop', 'flip', 'fade', 'pop', 'zoom', 'blur', 'none']) {
      await f.request('POST', '/api/chat/clear', {});
      await wait(c, `!document.querySelector('.msg')`);
      await f.update(id, { reverse, animIn: anim, animOut: anim });
      await wait(c, `document.querySelector('#root').dataset.animIn === ${q(anim)} && document.querySelector('#root').dataset.animOut === ${q(anim)} && document.querySelector('#root').classList.contains('reverse') === ${reverse}`);
      const first = `efecto-${++n}`, second = `efecto-${++n}`;
      await f.send(first);
      await wait(c, has(first));
      const incoming = await sample('.msg:last-child', false);
      if (anim === 'none') assert.equal(incoming.name, 'none');
      else assert.notEqual(incoming.name, 'none', `entrada ${anim}`);
      await f.send(second);
      await wait(c, has(second));
      if (anim === 'none') {
        await wait(c, `!${has(first)}`);
        continue;
      }
      await wait(c, `!!document.querySelector('.msg.out')`);
      const outgoing = await sample('.msg.out', true);
      if (['slide', 'bounce', 'drop'].includes(anim)) {
        assert.ok((reverse ? incoming.x < -1 : incoming.x > 1), `entrada ${anim} reverse=${reverse}: ${JSON.stringify(incoming)}`);
        assert.ok((reverse ? outgoing.x > 1 : outgoing.x < -1), `salida ${anim} reverse=${reverse}: ${JSON.stringify(outgoing)}`);
        assert.ok(Math.abs(incoming.y) < 1 && Math.abs(outgoing.y) < 1, `${anim} sin eje Y`);
      } else if (anim === 'flip') {
        assert.ok(Math.abs(incoming.rotationY) > .5 && Math.abs(outgoing.rotationY) > .5, 'flip sobre Y');
        assert.ok(Math.abs(incoming.rotationX) < .01 && Math.abs(outgoing.rotationX) < .01, 'sin flip sobre X');
        assert.ok(reverse ? incoming.rotationY > .5 && outgoing.rotationY < -.5 : incoming.rotationY < -.5 && outgoing.rotationY > .5, 'flip entra y sale por bordes opuestos, en espejo');
      } else {
        const names = { fade: ['inF', 'outF'], pop: ['inP', 'outP'], zoom: ['inZ', 'outZ'], blur: ['inBl', 'outBl'] };
        assert.deepEqual([incoming.name, outgoing.name], names[anim], `${anim} conserva sus efectos`);
      }
    }
  }
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await dom(c, `matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  assert.equal(await dom(c, `matchMedia('(prefers-reduced-motion: no-preference)').matches`), false);
  await f.update(id, { animIn: 'slide', animOut: 'slide' });
  await wait(c, `document.querySelector('#root').dataset.animIn === 'slide'`);
  await f.send('sin movimiento');
  await wait(c, has('sin movimiento'));
  assert.equal(await dom(c, `getComputedStyle(document.querySelector('.msg:last-child')).animationName`), 'none');
  await f.send('segundo reducido');
  await wait(c, has('segundo reducido'));
  await wait(c, `!${has('sin movimiento')}`);
});

test('chat: caducidad propia de la variante se aplica en vivo', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const id = await f.create('Temporal');
  await f.update(id, { fadeAfterSec: 1, animIn: 'none', animOut: 'none' });
  const selected = await f.page(`?variant=${id}`), legacy = await f.page('');
  await f.send('temporal');
  await wait(selected, has('temporal')); await wait(legacy, has('temporal'));
  await wait(selected, `!${has('temporal')}`);
  assert.equal(await dom(legacy, has('temporal')), true, 'el default conserva fadeAfterSec=0');
  await f.update(id, { fadeAfterSec: 0 });
  await wait(selected, `document.querySelector('#root').dataset.fade === '0'`);
  await f.send('permanente');
  await wait(selected, has('permanente'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(await dom(selected, has('permanente')), true);
});
