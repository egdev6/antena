// #161 · S4: detail headers share the page hierarchy without losing navigation or dialog semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const quote = JSON.stringify;
const drawer = `[...document.querySelectorAll('main .lv-drawer')].at(-1)`;
const head = `${drawer}.querySelector('.lv-shead')`;
const control = label => `${head}.querySelector('a[aria-label="${label}"]')`;
const dom = (c, expression) => evaluateChrome(c, expression, { timeoutMs: 12000 });
const wait = (c, expression) => waitDom(c, expression, { timeoutMs: 15000 });

// Compare the rendered roles and their actual separation, not stylesheet declarations.
const probe = `(() => {
  const d = ${drawer}, header = d.querySelector('.lv-shead'), slide = d.querySelector('.lv-slide');
  const ref = document.querySelector('main > .view-head'), refText = ref.firstElementChild;
  const text = header.querySelector('.lv-stitle');
  const crumb = text.querySelector('.crumb, .lv-crumb'), title = text.querySelector('h2'), desc = text.querySelector('p.hint');
  const refCrumb = refText.querySelector('.crumb'), refTitle = refText.querySelector('h1'), refDesc = refText.querySelector('p.hint');
  const style = el => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return Object.fromEntries(['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color',
      'marginTop', 'marginRight', 'marginBottom', 'marginLeft'].map(key => [key, s[key]]));
  };
  const gap = (a, b) => Math.round((b.getBoundingClientRect().top - a.getBoundingClientRect().bottom) * 100) / 100;
  const hs = getComputedStyle(header), rs = getComputedStyle(ref), ts = getComputedStyle(title), cs = getComputedStyle(text);
  const input = title.querySelector('input');
  return {
    dialog: { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: d.getAttribute('aria-label') },
    tag: title.tagName, crumb: style(crumb), refCrumb: style(refCrumb), title: style(title), refTitle: style(refTitle),
    desc: style(desc), refDesc: style(refDesc), description: desc?.textContent.trim() ?? null,
    descriptionCount: desc ? [...slide.querySelectorAll('p')].filter(p => p.textContent.trim() === desc.textContent.trim()).length : 0,
    bodyDescriptionCount: desc ? [...slide.querySelectorAll('.lv-sbody p')].filter(p => p.textContent.trim() === desc.textContent.trim()).length : 0,
    titleGap: gap(crumb, title), refTitleGap: gap(refCrumb, refTitle),
    descGap: desc && refDesc ? gap(title, desc) : null, refDescGap: desc && refDesc ? gap(refTitle, refDesc) : null,
    input: input ? { fontSize: getComputedStyle(input).fontSize, color: getComputedStyle(input).color, disabled: input.disabled, readOnly: input.readOnly } : null,
    box: { top: hs.borderTopWidth, right: hs.borderRightWidth, left: hs.borderLeftWidth, bottom: hs.borderBottomWidth,
      refBottom: rs.borderBottomWidth, background: hs.backgroundColor, refBackground: rs.backgroundColor, shadow: hs.boxShadow,
      titleBottom: ts.borderBottomWidth, textBottom: cs.borderBottomWidth,
      width: header.getBoundingClientRect().width, slideWidth: slide.clientWidth },
    overflow: header.scrollWidth > header.clientWidth + 1,
    controls: ['Volver', 'Cerrar'].map(label => {
      const el = header.querySelector('a[aria-label="' + label + '"]'), r = el.getBoundingClientRect();
      return { href: el.getAttribute('href'), tabIndex: el.tabIndex, visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
    }),
  };
})()`;

async function open(c, hash, selector) {
  await dom(c, `location.hash = ${quote(hash)}; true`);
  await wait(c, `location.hash === ${quote(hash)} && !!document.querySelector(${quote(selector)})`);
}

async function activate(c, label, target, remaining = 0) {
  assert.equal(await dom(c, `(() => { const el = ${control(label)}; el.focus(); return document.activeElement === el; })()`), true, `${label} receives keyboard focus`);
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(c, `location.hash === ${quote(target)} && document.querySelectorAll('main .lv-drawer').length === ${remaining}`);
}

function assertHeader(p, { description, back, close, editable, label }) {
  assert.deepEqual(p.dialog, { role: 'dialog', modal: 'true', label }, 'dialog retains its accessible name and modality');
  assert.equal(p.tag, 'H2', 'the detail heading remains h2');
  assert.deepEqual(p.crumb, p.refCrumb, 'breadcrumb typography and margins match the page header');
  assert.deepEqual(p.title, p.refTitle, 'title typography and margins match the page header');
  assert.equal(p.titleGap, p.refTitleGap, 'breadcrumb-to-title spacing matches');
  if (description) {
    assert.equal(p.description, description);
    assert.deepEqual(p.desc, p.refDesc, 'description typography and margins match the page header');
    assert.equal(p.descGap, p.refDescGap, 'title-to-description spacing matches');
    assert.equal(p.descriptionCount, 1, 'description appears exactly once in the detail');
    assert.equal(p.bodyDescriptionCount, 0, 'description is not repeated in the body');
  } else {
    assert.equal(p.description, null, 'pages without descriptions do not gain one');
  }
  if (editable) assert.deepEqual(p.input, { fontSize: p.refTitle.fontSize, color: p.refTitle.color, disabled: false, readOnly: false });
  assert.deepEqual([p.box.top, p.box.right, p.box.left, p.box.titleBottom, p.box.textBottom], ['0px', '0px', '0px', '0px', '0px'], 'no box or rule separates title and description');
  assert.equal(p.box.bottom, p.box.refBottom, 'only the same bottom rule as a main page remains');
  assert.equal(p.box.background, p.box.refBackground);
  assert.equal(p.box.shadow, 'none');
  assert.ok(Math.abs(p.box.width - p.box.slideWidth) <= 1, 'header spans the content width');
  assert.equal(p.overflow, false, 'header does not overflow horizontally');
  assert.deepEqual(p.controls.map(x => x.href), [back, close]);
  for (const item of p.controls) {
    assert.equal(item.tabIndex, 0, 'control stays in the tab order');
    assert.equal(item.visible, true, 'control is visible within the viewport');
  }
}

test('#161: page-style headers preserve descriptions and navigation on detail pages', { timeout: 180000 }, async t => {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador'); return; }
  const built = await stat(new URL('../app/dist/index.html', import.meta.url)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
  assert.ok(built, 'Chrome está disponible pero falta app/dist/index.html; compila el panel antes de probar #161');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-detail-header-'));
  let app, chrome;
  t.after(async () => {
    try { if (chrome) await closeChrome(chrome); }
    finally {
      try { if (app) { app.timers.stop(); app.server.closeAllConnections(); await app.closeHttp(); } }
      finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    }
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, endpoint, body) => {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000) });
    assert.equal(response.status, 200, `${method} ${endpoint}`);
    return response.json();
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true } });
  const { overlay } = await api('POST', '/api/custom-overlays', { name: 'Marco sintético' });
  const { command } = await api('POST', '/api/commands', { trigger: '!sintetico', title: 'Sintético', text: '{user}' });
  const { goal } = await api('POST', '/api/goals', { title: 'Meta sintética', platform: 'twitch', metric: 'follows', target: 10 });
  chrome = await openChromePage(bin, `${base}/#/widgets`);
  const c = chrome.cdp;
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await wait(c, `!!document.querySelector('main > .view-head h1')`);
  const cases = [
    { name: 'chat', hash: '#/widgets/chat', selector: '.lv-slide .chat-variant-editor', back: '#/widgets', close: '#/widgets', label: 'Chat en pantalla', description: 'El chat de Twitch y YouTube juntos, con tu estilo. Ideal para la escena de solo cámara.' },
    { name: 'últimos y ticker', hash: '#/widgets/latest', selector: '.lv-slide iframe[src="/widget/ticker?demo"]', back: '#/widgets', close: '#/widgets', label: 'Últimos y ticker', description: 'Último seguidor, sub, bits… y una banda que recorre los últimos apoyos.' },
    { name: 'overlay', hash: `#/overlays/${encodeURIComponent(overlay.id)}`, selector: '.lv-slide input[aria-label="Nombre del overlay"]', back: '#/overlays', close: '#/overlays', label: 'Detalle', editable: true },
    { name: 'comando', hash: `#/comandos/${encodeURIComponent(command.id)}`, selector: '.lv-slide input[aria-label="Disparador"]', back: '#/comandos', close: '#/comandos', label: 'Detalle', editable: true },
    { name: 'espectadores', hash: '#/widgets/viewers', selector: '.lv-slide iframe[src="/widget/viewers?demo"]', back: '#/widgets', close: '#/widgets', label: 'Espectadores', description: 'Espectadores a la vez en Twitch y YouTube, por separado y en total. Se actualiza solo mientras emites.' },
    { name: 'agradecimientos', hash: '#/widgets/thanks', selector: '.lv-slide iframe[src="/widget/thanks?demo"]', back: '#/widgets', close: '#/widgets', label: 'Agradecimientos', description: 'Agradece a quienes te siguieron mientras antena estaba cerrada.' },
    { name: 'créditos', hash: '#/widgets/credits', selector: '.lv-slide iframe[src="/widget/credits?demo"]', back: '#/widgets', close: '#/widgets', label: 'Créditos', description: 'Créditos finales con todos los que han apoyado en el directo.' },
    { name: 'nueva tier list', hash: '#/tierlist/nueva', selector: '.lv-slide input[placeholder="Frameworks frontend"]', back: '#/tierlist', close: '#/tierlist', label: 'Nueva tier list' },
    { name: 'nuevo guion', hash: '#/teleprompter/guiones/nuevo', selector: '.lv-slide input[placeholder="Directo · Agent Teams"]', back: '#/teleprompter/guiones', close: '#/teleprompter/guiones', label: 'Nuevo guion' },
    { name: 'nuevo atajo', hash: '#/atajos/nuevo', selector: '.lv-slide input[placeholder="Empezar el directo"]', back: '#/atajos', close: '#/atajos', label: 'Nuevo atajo' },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await open(c, item.hash, item.selector);
    for (const width of [1440, 390]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assertHeader(await dom(c, probe), item);
    }
    if (item.name === 'comando') assert.equal(await dom(c, `!!${head}.querySelector('[role="tablist"][aria-label="Partes"]')`), true, 'editor tabs remain available');
    if (item.name === 'overlay') assert.equal(await dom(c, `!!${head}.querySelector('button.danger')`), true, 'overlay action remains available');
    await activate(c, 'Volver', item.back);
    await open(c, item.hash, item.selector);
    await activate(c, 'Cerrar', item.close);
  });
  await t.test('nested goal keeps distinct back and close destinations', async () => {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const hash = `#/widgets/objetivos/${encodeURIComponent(goal.id)}`;
    await open(c, hash, '[data-tour="goals-editor"]');
    assertHeader(await dom(c, probe), { back: '#/widgets/objetivos', close: '#/widgets', label: 'Meta sintética' });
    await activate(c, 'Volver', '#/widgets/objetivos', 1);
    await open(c, hash, '[data-tour="goals-editor"]');
    await activate(c, 'Cerrar', '#/widgets');
  });
  await t.test('Escape closes the dialog except while editing a field', async () => {
    await open(c, '#/widgets/chat', '.lv-slide .chat-variant-editor input');
    await dom(c, `document.querySelector('.lv-slide .chat-variant-editor input').focus(); true`);
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await dom(c, 'location.hash'), '#/widgets/chat');
    await dom(c, `${control('Volver')}.focus(); true`);
    for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(c, `location.hash === '#/widgets' && !document.querySelector('main .lv-drawer')`);
  });
});
