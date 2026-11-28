import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInto } from '../scripts/perf.mjs';
import { createApp } from '../src/server.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { clickWhen, closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';

const scratch = () => mkdtemp(path.join(tmpdir(), 'antena-panel-lazy-'));
const cleanup = dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
let build;
let buildDir;
after(() => buildDir && cleanup(buildDir));
async function productionBuild() {
  buildDir = await scratch();
  await buildInto(buildDir);
  return buildDir;
}

const home = `!!document.querySelector('[data-tour-view-ready="directo"]')`;
const heading = title => `document.querySelector('main h1')?.textContent === ${JSON.stringify(title)}`;
const sidebar = `document.querySelector('.side')`;
const active = `document.querySelector('#nav a[aria-current="page"]')?.getAttribute('href')`;
const link = (where, route) => `document.querySelector(${JSON.stringify(`${where} a[href="#/${route}"]`)})`;
const loading = `document.querySelector('main [role="status"]')?.textContent === 'Cargando vista…'`;
const loadError = `document.querySelector('main [role="alert"]')?.textContent === 'No se pudo cargar esta vista.'`;

async function fixture(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('no local Chrome; set CHROME_PATH'); return null; }
  const appDist = await (build ||= productionBuild());
  const dir = await scratch();
  const assets = [];
  let app, chrome, gate, rejectScripts = false, stateRequested = false;
  const release = () => { gate?.resolve(); gate = undefined; };
  t.after(() => closeAll(release,
    () => chrome && closeChrome(chrome),
    async () => {
      if (!app) return;
      app.viewers.halt(); app.timers.stop();
      await app.drainAutoSession(); await app.drainChatMetrics(); await app.session.flush();
    },
    () => app?.closeHttp(),
    () => cleanup(dir),
  ));
  app = await createApp({ appDist, dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  app.viewers.stop();
  app.store.config.panel = { onboardingDone: true };
  // Only fault injection bypasses the real /assets handler. Successful responses are served by Antena.
  const [serve] = app.server.listeners('request');
  app.server.off('request', serve);
  app.server.on('request', (req, res) => {
    if (req.url === '/api/state') stateRequested = true;
    if (!/^\/assets\/[^/]+\.js$/.test(req.url)) return serve(req, res);
    const entry = { url: req.url, afterState: stateRequested };
    assets.push(entry);
    res.on('finish', () => { entry.status = res.statusCode; });
    if (rejectScripts) return res.writeHead(404).end();
    return gate ? gate.promise.then(() => serve(req, res)) : serve(req, res);
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  chrome = await openChromePage(bin, 'about:blank');
  const { cdp } = chrome;
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['https://*'] });
  await cdp.send('Page.navigate', { url: `${base}/` });
  const ev = expression => evaluateChrome(cdp, expression, { timeoutMs: 5000 });
  const wait = (expression, timeoutMs) => waitDom(cdp, expression, { timeoutMs });
  await wait(home);
  await ev(`void (window.originalSidebar = ${sidebar})`);
  return { assets, base, ev, wait, release,
    holdScripts: () => { gate = Promise.withResolvers(); },
    rejectScripts: on => { rejectScripts = on; },
    click: expression => clickWhen(cdp, expression),
    hover: async route => {
      const point = await ev(`(() => { const { left, top, width, height } = ${link('#nav', route)}.getBoundingClientRect();
        return { x: left + width / 2, y: top + height / 2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    },
  };
}

const browser = { timeout: 90000 };

test('Directo starts eagerly and hovering Chat loads it without navigating or flashing a fallback on click', browser, async t => {
  const f = await fixture(t); if (!f) return;
  assert.equal(await f.ev(active), '#/directo');
  assert.ok(f.assets.some(asset => /^\/assets\/panel-/.test(asset.url)), 'the production entry was served');
  assert.ok(f.assets.every(asset => !asset.afterState), 'Directo did not require a chunk after the initial state request');
  const bootAssets = f.assets.length;
  const bootUrls = JSON.stringify(f.assets.map(asset => asset.url));
  await f.ev(`window.sawLoading = false; new MutationObserver(records => {
    if (records.some(r => [...r.addedNodes].some(n => n.textContent === 'Cargando vista…'))) window.sawLoading = true;
  }).observe(document.querySelector('main'), { childList: true, subtree: true });`);
  await f.hover('chat');
  await f.wait(`performance.getEntriesByType('resource').some(e => {
    const pathname = new URL(e.name).pathname;
    return pathname.startsWith('/assets/') && pathname.endsWith('.js') && !${bootUrls}.includes(pathname);
  })`, 5000);
  await f.ev('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const warmed = f.assets.length;
  assert.ok(warmed > bootAssets, 'the sidebar hover requested a lazy chunk');
  assert.equal(await f.ev('location.hash'), '');
  assert.equal(await f.ev(home), true);
  await f.click(link('#nav', 'chat'));
  await f.wait(heading('Chat'));
  assert.equal(await f.ev(active), '#/chat');
  assert.equal(await f.ev(`window.originalSidebar === ${sidebar}`), true);
  assert.equal(await f.ev('window.sawLoading'), false);
  assert.equal(f.assets.length, warmed, 'navigation used the hover import');
});

test('an unprefetched view shows a loading status while its chunk is pending, without replacing the sidebar', browser, async t => {
  const f = await fixture(t); if (!f) return;
  f.holdScripts();
  await f.click(link('#nav', 'chat'));
  await f.wait(loading, 5000);
  assert.ok(f.assets.some(asset => asset.afterState && asset.status === undefined), 'a route chunk is held');
  assert.equal(await f.ev(active), '#/chat');
  assert.equal(await f.ev(`window.originalSidebar === ${sidebar}`), true);
  f.release();
  await f.wait(heading('Chat'));
  assert.equal(await f.ev(loading), false);
  assert.equal(await f.ev(`window.originalSidebar === ${sidebar}`), true);
});

test('a missing chunk leaves navigation working and can recover the requested deep link after reload', browser, async t => {
  const f = await fixture(t); if (!f) return;
  f.rejectScripts(true);
  await f.ev(`location.hash = '#/general/copia'`);
  await f.wait(loadError, 5000);
  assert.ok(f.assets.some(asset => asset.afterState && asset.status === 404));
  assert.equal(await f.ev(active), '#/general');
  assert.equal(await f.ev(`window.originalSidebar === ${sidebar}`), true);
  await f.click(link('#nav', 'directo'));
  await f.wait(home);
  assert.equal(await f.ev(`window.originalSidebar === ${sidebar}`), true);
  await f.ev(`location.hash = '#/general/copia'`);
  await f.wait(loadError);
  f.rejectScripts(false);
  const reload = `[...document.querySelectorAll('main button')].find(button => button.textContent === 'Recargar panel')`;
  await f.click(reload);
  await f.wait(heading('General'));
  assert.equal(await f.ev('location.hash'), '#/general/copia');
  assert.equal(await f.ev(`document.querySelector('main [role="tab"][aria-selected="true"]')?.textContent`), 'Copia');
  assert.equal(await f.ev(loadError), false);
});

test('all panel views open from the production server with external HTTPS blocked', browser, async t => {
  const f = await fixture(t); if (!f) return;
  for (const [route, title] of [
    ['chat', 'Chat'], ['alertas', 'Alertas'], ['comandos', 'Comandos de chat'],
    ['mensajes', 'Mensajes programados'], ['widgets', 'Widgets'], ['overlays', 'Personalizados'],
    ['atajos', 'Atajos y Stream Deck'], ['fuentes', 'Fuentes'], ['meld', 'Programa de emisión'],
    ['prompter', 'Paneles'], ['historial', 'Historial de alertas'], ['directos', 'Directos anteriores'],
    ['archivos', 'Archivos'], ['apariencia', 'Apariencia'], ['conexiones', 'Conexiones'],
    ['filtros', 'Filtros y voz'], ['general', 'General'], ['acerca', 'Acerca de'],
  ]) {
    await f.click(link('#nav', route));
    await f.wait(heading(title));
    assert.equal(await f.ev(active), `#/${route}`);
  }
  for (const [route, title] of [
    ['preguntas', 'Preguntas'], ['tierlist', 'Tier list'], ['sorteo', 'Sorteo'],
    ['entrevista', 'Entrevista'], ['teleprompter', 'Teleprompter'],
  ]) {
    await f.click(link('#nav', 'widgets'));
    await f.wait(heading('Widgets'));
    await f.click(link('main', route));
    await f.wait(heading(title));
    assert.equal(await f.ev(active), '#/widgets');
  }
  await f.ev(`location.hash = '#/constructor'`);
  await f.wait(home);
  assert.equal(await f.ev(active), undefined, 'unknown hashes still fall back to Directo');
  assert.equal(await f.ev(`window.originalSidebar === ${sidebar}`), true);
  const chunks = f.assets.filter(asset => asset.afterState);
  assert.ok(chunks.length > 0, 'views made on-demand requests to /assets/');
  for (const { url, status } of chunks) {
    assert.equal(status, 200, `browser loaded ${url} from the loopback server`);
    const response = await fetch(f.base + url, { method: 'HEAD' });
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8', url);
  }
});
