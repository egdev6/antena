// S1–S4: real panel bundled into isolated test data, without app/dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const card = name => `([...document.querySelectorAll('.lv-conn')].find(e => e.querySelector('b')?.textContent.trim() === ${JSON.stringify(name)}))`;
const radio = name => `([...document.querySelectorAll('[role="radiogroup"][aria-label="Programa de emisión"] [role="radio"]')].find(e => e.textContent.trim() === ${JSON.stringify(name)}))`;
const button = (scope, text) => `([...${scope}.querySelectorAll('button')].find(e => e.textContent.trim() === ${JSON.stringify(text)}))`;
const switchInput = text => `([...document.querySelectorAll('label')].find(e => e.textContent.trim() === ${JSON.stringify(text)})?.querySelector('input'))`;
let panelBuild;
async function fixture(t, route = '#/conexiones') {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH'); return null; }
  const root = await mkdtemp(path.join(tmpdir(), 'antena-obs-panel-ux-'));
  const obs = fakeObs(), meld = fakeMeld();
  let app, page;
  t.after(() => closeAll(() => page && closeChrome(page), async () => {
    if (app) {
      await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose();
      app.program.stop(); app.meld.stop(); app.program.dispose(); await app.closeHttp();
    }
  }, () => obs.close(), () => new Promise(resolve => meld.server.close(resolve)),
  () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  await Promise.all([new Promise(resolve => obs.server.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve))]);
  panelBuild ||= build({ entryPoints: [fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url))],
    outfile: path.join(tmpdir(), 'antena-obs-panel-ux.js'), bundle: true, format: 'esm', minify: true, write: false,
    target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/ds/*'], logLevel: 'silent' });
  const dist = path.join(root, 'dist'), assets = path.join(dist, 'assets');
  await mkdir(assets, { recursive: true });
  const built = await panelBuild;
  await Promise.all([...built.outputFiles.map(file => writeFile(path.join(assets, 'panel' + path.extname(file.path)), file.contents)),
    writeFile(path.join(dist, 'index.html'), '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/ds/tokens.css"><link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/assets/panel.css"></head><body><div id="root"></div><script type="module" src="/assets/panel.js"></script></body></html>')]);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const obsUrl = `ws://127.0.0.1:${obs.server.address().port}`;
  const meldUrl = `ws://127.0.0.1:${meld.server.address().port}`;
  const api = async (method, endpoint, body) => {
    const response = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true }, meld: { url: meldUrl }, obs: { url: obsUrl } });
  page = await openChromePage(bin, 'about:blank');
  await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const fetch0 = window.fetch; window.__requests = [];
    window.fetch = (...args) => { window.__requests.push({ path: new URL(String(args[0]), location.href).pathname, method: args[1]?.method || 'GET' }); return fetch0(...args); };
  })()` });
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.cdp.send('Page.navigate', { url: base + '/' + route });
  const dom = expression => evaluateChrome(page.cdp, expression, { timeoutMs: 12000 });
  const wait = expression => waitDom(page.cdp, expression, { timeoutMs: 10000 });
  const click = expression => clickWhen(page.cdp, expression);
  await wait(`!!document.querySelector('main .view-head') && !!document.querySelector('#nav')`);
  return { page, dom, wait, click, api, obsUrl, meldUrl };
}

test('S1: incluir directos usa un control compacto en la misma fila y conserva el valor', async t => {
  const f = await fixture(t, '#/general/copia'); if (!f) return;
  const input = switchInput('Incluir directos pasados');
  await f.wait(`!!${input}`);
  const measure = await f.dom(`(() => {
    const input = ${input}, label = input.closest('label'), control = label.querySelector('i') || input;
    const node = [...label.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().includes('Incluir'));
    const range = document.createRange(); range.selectNodeContents(node);
    const a = control.getBoundingClientRect(), b = range.getBoundingClientRect();
    return { height: a.height, controlY: (a.top + a.bottom) / 2, labelY: (b.top + b.bottom) / 2, checked: input.checked, disabled: input.disabled };
  })()`);
  assert.ok(measure.height > 0 && measure.height < 48, JSON.stringify(measure));
  assert.ok(Math.abs(measure.controlY - measure.labelY) < 12, JSON.stringify(measure));
  assert.equal(measure.checked, true); assert.equal(measure.disabled, false);
  await f.click(input); assert.equal(await f.dom(`${input}.checked`), false);
});

test('S2-S3: marca y navegación caben y conservan sus rutas y el título de Fuentes', async t => {
  const f = await fixture(t, '#/general/copia'); if (!f) return;
  await f.dom('document.fonts.ready');
  const actual = await f.dom(`(() => {
    const brand = document.querySelector('.brand-name small'), source = document.querySelector('#nav a[href="#/fuentes"] .eg-menu__label');
    const program = document.querySelector('#nav a[href="#/meld"]');
    const size = e => ({ text: e.textContent.trim(), scroll: e.scrollWidth, width: e.clientWidth, scrollHeight: e.scrollHeight, height: e.clientHeight });
    return { brand: size(brand), brandRight: brand.getBoundingClientRect().right, sideRight: document.querySelector('.side').getBoundingClientRect().right,
      source: size(source), program: program.querySelector('.eg-menu__label').textContent.trim(), programHref: program.getAttribute('href') };
  })()`);
  assert.equal(actual.brand.text, 'Alertas y control del directo');
  assert.ok(actual.brand.scroll <= actual.brand.width && actual.brandRight <= actual.sideRight, JSON.stringify(actual.brand));
  assert.equal(actual.source.text, 'Fuentes');
  // Truncation is horizontal (ellipsis); Windows font metrics add 1 px of vertical scroll to every nav label.
  assert.ok(actual.source.scroll <= actual.source.width, JSON.stringify(actual.source));
  assert.equal(actual.program, 'Programa de emisión'); assert.equal(actual.programHref, '#/meld');
  await f.click(`document.querySelector('#nav a[href="#/fuentes"]')`);
  await f.wait(`document.querySelector('main h1')?.textContent.trim() === 'Fuentes'`);
});

test('S3: el paso del tour usa el nombre neutral del programa', async t => {
  const f = await fixture(t, '#/general/tour'); if (!f) return;
  await f.click(`([...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Ver el tour de nuevo'))`);
  for (let i = 0; i < 16; i++) {
    await f.wait(`!!document.querySelector('.driver-popover-next-btn') && !!document.querySelector('.driver-active-element[data-tour]')`);
    const anchor = await f.dom(`document.querySelector('.driver-active-element').getAttribute('data-tour')`);
    if (anchor === 'meld-head') break;
    const progress = await f.dom(`document.querySelector('.driver-popover-progress-text').textContent`);
    await f.click(`document.querySelector('.driver-popover-next-btn')`);
    await f.wait(`document.querySelector('.driver-popover-progress-text')?.textContent !== ${JSON.stringify(progress)}`);
  }
  assert.equal(await f.dom(`document.querySelector('.driver-active-element')?.getAttribute('data-tour')`), 'meld-head');
  assert.equal(await f.dom(`document.querySelector('.driver-popover-title').textContent.trim()`), 'Programa de emisión');
  assert.doesNotMatch(await f.dom(`document.querySelector('.driver-popover-description').textContent`), /Meld/);
});

test('S4: al cambiar pestaña la tarjeta cambia sin atribuir el estado de Meld a OBS', async t => {
  const f = await fixture(t); if (!f) return;
  await f.wait(`!!${card('Meld Studio')}`);
  await f.click(button(card('Meld Studio'), 'Conectar'));
  await f.wait(`/Conectado/.test(${card('Meld Studio')}.textContent)`);
  await f.click(radio('OBS'));
  await f.wait(`!!${card('OBS Studio')}`);
  assert.equal((await f.api('GET', '/api/config')).program.kind, 'meld');
  assert.equal(await f.dom(`!!${card('Meld Studio')}`), false);
  const text = await f.dom(`${card('OBS Studio')}.textContent`);
  assert.ok(text.includes(f.obsUrl)); assert.doesNotMatch(text, /Conectado|Escenas, capas y efectos/);
  assert.equal(await f.dom(`${button(card('OBS Studio'), 'Conectar')}.disabled`), true);
  assert.equal(await f.dom(`${button(card('OBS Studio'), 'Desconectar')}.disabled`), true);
  await f.click(radio('Meld'));
  await f.wait(`!!${card('Meld Studio')} && /Conectado/.test(${card('Meld Studio')}.textContent)`);
  assert.equal(await f.dom(`!!${card('OBS Studio')}`), false);
});

test('S4: OBS muestra URL, error y estado vivo; conectar y desconectar usan el programa activo', async t => {
  const f = await fixture(t); if (!f) return;
  await f.api('PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: f.obsUrl } });
  await f.wait(`!!${card('OBS Studio')} && /Conectado/.test(${card('OBS Studio')}.textContent)`);
  assert.ok((await f.dom(`${card('OBS Studio')}.textContent`)).includes(f.obsUrl));
  await f.click(button(card('OBS Studio'), 'Desconectar'));
  await f.wait(`/Desconectado/.test(${card('OBS Studio')}.textContent)`);
  assert.equal((await f.api('GET', '/api/status')).meld.state, 'desconectado');
  await f.click(button(card('OBS Studio'), 'Conectar'));
  await f.wait(`/Conectado/.test(${card('OBS Studio')}.textContent)`);
  assert.equal((await f.api('GET', '/api/status')).meld.state, 'conectado');
  const requests = await f.dom(`window.__requests.filter(r => r.method === 'POST' && r.path.startsWith('/api/program/'))`);
  assert.deepEqual(requests.map(r => r.path), ['/api/program/disconnect', '/api/program/connect']);
  await f.api('PUT', '/api/config', { obs: { url: 'ws://127.0.0.1:1' } });
  await f.wait(`/No se puede conectar con OBS/.test(${card('OBS Studio')}?.textContent || '')`);
  const error = await f.dom(`${card('OBS Studio')}.textContent`);
  assert.match(error, /Reintentando|Error/); assert.match(error, /ws:\/\/127\.0\.0\.1:1/);
});

test('S4: opciones compartidas funcionan en OBS y no se anuncian como exclusivas de Meld', async t => {
  const f = await fixture(t); if (!f) return;
  await f.api('PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: f.obsUrl } });
  await f.wait(`!!${card('OBS Studio')} && /Conectado/.test(${card('OBS Studio')}.textContent)`);
  await f.dom(`location.hash = '#/meld/conexion'`);
  const session = switchInput('Empezar un directo nuevo en el panel al empezar a emitir');
  const record = switchInput('Grabar al empezar el directo');
  await f.wait(`!!${session} && !!${record}`);
  assert.equal(await f.dom(`document.querySelector('main h1').textContent.trim()`), 'Programa de emisión');
  assert.doesNotMatch(await f.dom(`document.querySelector('main .view-head .hint').textContent`), /Meld/);
  assert.doesNotMatch(await f.dom(`document.querySelector('main').textContent`), /Esta página es solo para Meld|Allow remote connections/);
  assert.equal(await f.dom(`${session}.disabled || ${record}.disabled`), false);
  const before = (await f.api('GET', '/api/config')).meld;
  await f.click(session); await f.click(record);
  await f.click(button(`document.querySelector('.lv-savebar')`, 'Guardar'));
  await f.wait(`!document.querySelector('.lv-savebar.is-open')`);
  const after = (await f.api('GET', '/api/config')).meld;
  assert.equal(after.autoSession, !before.autoSession); assert.equal(after.recordOnStart, !before.recordOnStart);
  await f.dom(`location.hash = '#/meld/escenas'`);
  await f.wait(`!!${button('document', 'Confeti')}`);
  assert.equal(await f.dom(`${button('document', 'Confeti')}.disabled`), true);
  assert.match(await f.dom(`document.querySelector('main').textContent`), /solo funcionan con Meld/);
  await f.api('POST', '/api/program/disconnect');
  await f.wait(`!!${session} && !!${record}`);
  assert.equal(await f.dom(`${session}.disabled || ${record}.disabled`), false, 'las opciones también se pueden editar con OBS desconectado');
  assert.equal(await f.dom(`document.querySelector('main h1').textContent.trim()`), 'Programa de emisión');
});
