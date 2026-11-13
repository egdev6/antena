// #150: exercise the production panel bundle and its computed SVG styles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

let panelAssets;
async function sourceAssets() {
  if (!panelAssets) panelAssets = build({
    entryPoints: [fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url))],
    outfile: path.join(tmpdir(), 'antena-chart-panel.js'), write: false,
    bundle: true, format: 'esm', target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, external: ['/fonts/*', '/ds/*'],
    logLevel: 'silent',
  }).then(result => Object.fromEntries(result.outputFiles.map(file => [path.extname(file.path), file.contents])));
  return panelAssets;
}

// The existing server provides all real APIs and static DS assets. Only the panel entry
// is served from an in-memory source build, so these tests do not depend on stale app/dist.
export async function serveSourcePanel(app) {
  const assets = await sourceAssets();
  const html = '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/ds/tokens.css">' +
    '<link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/chart-panel.css">' +
    '</head><body><div id="root"></div><script type="module" src="/chart-panel.js"></script></body></html>';
  const proxy = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/' || pathname === '/chart-panel.js' || pathname === '/chart-panel.css') {
      const ext = pathname === '/' ? 'html' : pathname.endsWith('.js') ? 'js' : 'css';
      res.writeHead(200, { 'content-type': { html: 'text/html', js: 'text/javascript', css: 'text/css' }[ext] });
      res.end(ext === 'html' ? html : assets[`.${ext}`]);
      return;
    }
    const upstream = request({ host: '127.0.0.1', port: app.server.address().port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${proxy.address().port}`, close: () => new Promise(resolve => proxy.close(resolve)) };
}

const start = Date.parse('2026-11-18T18:00:00.000Z');
const at = seconds => new Date(start + seconds * 1000).toISOString();
const series = (pairs, gaps = [], openGap = false) => ({
  samples: pairs.map(([seconds, value]) => ({ at: at(seconds), value })),
  gaps: gaps.map(([from, to]) => ({ from: at(from), to: at(to), reason: 'error' })),
  intervals: [{ from: at(0), seconds: 60 }], openGap,
});
const archive = (viewers, chatStats) => ({ id: 'chart-style', title: 'Gráficas de prueba', startedAt: at(0), endedAt: at(480),
  meldAutoSession: true, events: [], notes: [], goalOffsets: {}, viewers, ...(chatStats ? { chatStats } : {}) });
const viewers = {
  twitch: series([[0, 0], [60, 300], [120, 600], [180, 900], [240, 1200], [360, 600], [420, 1200]]),
  youtube: series([[0, 100], [60, 200], [120, 300], [180, 400], [240, 500], [360, 600], [420, 700]], [[90, 180]]),
};
const chatStats = {
  twitch: { authorIds: ['a'], minutes: [{ at: at(0), messages: 4 }, { at: at(120), messages: 2 }] },
  youtube: { authorIds: ['b'], minutes: [{ at: at(60), messages: 1 }] },
};
const dom = (chrome, expression) => evaluateChrome(chrome.cdp, expression, { timeoutMs: 12000 });
const wait = (chrome, expression) => waitDom(chrome.cdp, expression, { timeoutMs: 12000 });
const chart = kind => `document.querySelector('#detalle svg.dx-${kind}-chart')`;

async function fixture(t, entry = archive(viewers, chatStats), current = false) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local'); return null; }
  await access(fileURLToPath(new URL('../app/dist/index.html', import.meta.url)));
  const root = await mkdtemp(path.join(tmpdir(), 'antena-chart-style-'));
  let app, chrome;
  t.after(async () => {
    if (chrome) await closeChrome(chrome);
    if (app) { app.viewers.halt(); await app.youtube.quiescePoll(); await app.chat.quiesceChat();
      await app.drainAutoSession(); await app.drainChatMetrics(); await app.session.flush(); await app.closeHttp(); }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  await writeFile(path.join(dataDir, current ? 'session-current.json' : 'sessions/chart-style.json'), JSON.stringify(entry));
  app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  app.viewers.halt();
  app.store.config.panel = { onboardingDone: true };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  chrome = await openChromePage(bin, `${base}/#/${current ? 'directo' : 'directos'}`);
  await chrome.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(chrome, current ? `!!document.querySelector('[data-platform-pulse="youtube"] svg.dx-viewer-chart')` : `!!${chart('viewer')}`);
  return chrome;
}

// When imported by the existing metrics suite, only the memory-build helper is loaded.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('#150: colores y leyenda de las dos curvas en el historial', { timeout: 90000 }, async t => {
    const c = await fixture(t); if (!c) return;
    const colors = await dom(c, `(() => {
      const svg = ${chart('viewer')};
      return Object.fromEntries(['twitch', 'youtube'].map(p => [p, {
        stroke: getComputedStyle(svg.querySelector('path.dx-' + p)).stroke,
        fill: getComputedStyle(svg.querySelector('circle.dx-' + p)).fill,
        opacity: getComputedStyle(svg.querySelector('circle.dx-' + p)).opacity,
        swatch: getComputedStyle(document.querySelector('#detalle .dx-chart-caption .dx-' + p), '::before').borderTopColor,
      }]));
    })()`);
    assert.deepEqual(colors, {
      twitch: { stroke: 'rgb(145, 70, 255)', fill: 'rgb(145, 70, 255)', opacity: '1', swatch: 'rgb(145, 70, 255)' },
      youtube: { stroke: 'rgb(255, 0, 0)', fill: 'rgb(255, 0, 0)', opacity: '1', swatch: 'rgb(255, 0, 0)' },
    });
    assert.match(await dom(c, `document.querySelector('#detalle .dx-chart-caption').textContent`), /Twitch.*YouTube/s);
    assert.notEqual(await dom(c, `getComputedStyle(${chart('viewer')}.querySelector('path.dx-twitch')).strokeDasharray`),
      await dom(c, `getComputedStyle(${chart('viewer')}.querySelector('path.dx-youtube')).strokeDasharray`), 'las series comparadas se distinguen también sin color');
  });

  test('#150: muestras reales como puntos y segmentos rectos sin atravesar huecos ni intervalos caducados', { timeout: 90000 }, async t => {
    const c = await fixture(t); if (!c) return;
    const plotted = await dom(c, `(() => {
      const svg = ${chart('viewer')};
      return Object.fromEntries(['twitch', 'youtube'].map(p => [p, {
        dots: [...svg.querySelectorAll('circle.dx-' + p)].map(e => [e.dataset.at, Number(e.dataset.value), Number(e.getAttribute('r'))]),
        paths: [...svg.querySelectorAll('path[data-series="' + p + '"]')].map(e => [e.dataset.from, e.dataset.to, e.getAttribute('d')]),
      }]));
    })()`);
    assert.deepEqual(plotted.twitch.dots.map(([time, value]) => [time, value]), viewers.twitch.samples.map(s => [s.at, s.value]));
    assert.deepEqual(plotted.youtube.dots.map(([time, value]) => [time, value]), viewers.youtube.samples.filter(s => s.at !== at(120)).map(s => [s.at, s.value]));
    assert.ok([...plotted.twitch.dots, ...plotted.youtube.dots].every(([, , r]) => r > 0));
    assert.deepEqual(plotted.youtube.paths.map(([from, to]) => [from, to]), [[at(0), at(60)], [at(180), at(240)], [at(360), at(420)]]);
    assert.deepEqual(plotted.twitch.paths.map(([from, to]) => [from, to]), [[at(0), at(60)], [at(60), at(120)], [at(120), at(180)], [at(180), at(240)], [at(360), at(420)]]);
    assert.ok([...plotted.twitch.paths, ...plotted.youtube.paths].every(([, , d]) => /^M\s/.test(d) && /\sL\s/.test(d) && !/[HV]/i.test(d)), 'líneas rectas, sin escalones');
  });

  test('#150: hueco abierto y muestra aislada no inventan líneas ni puntos', { timeout: 90000 }, async t => {
    const data = { twitch: series([[0, 10], [60, 20], [180, 40], [240, 50]], [[90, 90]], true), youtube: series([[180, 7]]) };
    const c = await fixture(t, archive(data)); if (!c) return;
    const plotted = await dom(c, `(() => { const svg = ${chart('viewer')}; return {
      twitch: [...svg.querySelectorAll('circle.dx-twitch')].map(e => e.dataset.at),
      youtube: [...svg.querySelectorAll('circle.dx-youtube')].map(e => e.dataset.at),
      paths: [...svg.querySelectorAll('path[data-series]')].map(e => [e.dataset.series, e.dataset.from, e.dataset.to]),
      gap: svg.querySelector('[data-gap="twitch"]').dataset.to,
    }; })()`);
    assert.deepEqual(plotted.twitch, [at(0), at(60)]);
    assert.deepEqual(plotted.youtube, [at(180)]);
    assert.deepEqual(plotted.paths, [['twitch', at(0), at(60)]]);
    assert.equal(plotted.gap, at(480));
  });

  test('#150: barras de chat conservan los recuentos y usan colores por plataforma', { timeout: 90000 }, async t => {
    const c = await fixture(t); if (!c) return;
    const bars = await dom(c, `(() => { const svg = ${chart('chat')}; return Object.fromEntries(['twitch', 'youtube'].map(p => [p,
      [...svg.querySelectorAll('[data-chat-bar="' + p + '"]')].map(e => [Number(e.dataset.value), getComputedStyle(e).fill])])); })()`);
    assert.deepEqual(bars.twitch, [4, 0, 2, 0, 0, 0, 0, 0].map(value => [value, 'rgb(145, 70, 255)']));
    assert.deepEqual(bars.youtube, [0, 1, 0, 0, 0, 0, 0, 0].map(value => [value, 'rgb(255, 0, 0)']));
  });

  test('#150: ambas gráficas tienen cuadrícula discontinua, ejes finos y etiquetas numéricas', { timeout: 90000 }, async t => {
    const c = await fixture(t); if (!c) return;
    for (const kind of ['viewer', 'chat']) {
      const axes = await dom(c, `(() => { const svg = ${chart(kind)}; return {
        grid: [...svg.querySelectorAll('.dx-gridline')].map(e => getComputedStyle(e).strokeDasharray),
        axes: [...svg.querySelectorAll('.dx-axis-line')].map(e => [getComputedStyle(e).stroke, parseFloat(getComputedStyle(e).strokeWidth)]),
        labels: [...svg.querySelectorAll('.dx-axis-y')].map(e => e.textContent.trim()),
      }; })()`);
      assert.equal(axes.grid.length, 5, kind);
      assert.ok(axes.grid.every(dash => dash !== 'none' && dash !== '0px'), kind);
      assert.equal(axes.axes.length, 2, kind);
      assert.ok(axes.axes.every(([stroke, width]) => stroke !== 'none' && width > 0 && width <= 1.5), kind);
      assert.deepEqual(axes.labels, kind === 'viewer' ? ['0', '300', '600', '900', '1200'] : ['0', '1', '2', '3', '4']);
    }
  });

  test('#150: colores contrastan con el fondo oscuro de ambas gráficas', { timeout: 90000 }, async t => {
    const c = await fixture(t); if (!c) return;
    const luminance = color => {
      const channels = color.match(/\d+/g).slice(0, 3).map(Number).map(value => {
        const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const ratio = (a, b) => { const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (light + 0.05) / (dark + 0.05); };
    for (const kind of ['viewer', 'chat']) {
      const colors = await dom(c, `(() => { const svg = ${chart(kind)}; return {
        background: getComputedStyle(svg).backgroundColor,
        twitch: getComputedStyle(svg.querySelector('${kind === 'viewer' ? 'path' : 'rect'}.dx-twitch')).${kind === 'viewer' ? 'stroke' : 'fill'},
        youtube: getComputedStyle(svg.querySelector('${kind === 'viewer' ? 'path' : 'rect'}.dx-youtube')).${kind === 'viewer' ? 'stroke' : 'fill'},
        label: getComputedStyle(svg.querySelector('.dx-axis-y')).fill,
      }; })()`);
      assert.equal(colors.background, 'rgb(20, 21, 24)', kind);
      assert.ok(ratio(colors.twitch, colors.background) >= 3, `${kind}: contraste Twitch`);
      assert.ok(ratio(colors.youtube, colors.background) >= 3, `${kind}: contraste YouTube`);
      assert.ok(ratio(colors.label, colors.background) >= 4.5, `${kind}: contraste de etiquetas`);
    }
  });

  test('#150: pulso independiente conserva etiquetas, colores y línea sólida en cada plataforma', { timeout: 90000 }, async t => {
    const c = await fixture(t, archive(viewers, chatStats), true); if (!c) return;
    const pulses = await dom(c, `Object.fromEntries(['twitch', 'youtube'].map(p => { const card = document.querySelector('[data-platform-pulse="' + p + '"]');
      const line = card.querySelector('path.dx-' + p), dot = card.querySelector('circle.dx-' + p), label = card.querySelector('.dx-platform');
      return [p, { label: label.textContent.trim(), swatch: getComputedStyle(label, '::before').borderTopColor,
        stroke: getComputedStyle(line).stroke, dash: getComputedStyle(line).strokeDasharray, fill: getComputedStyle(dot).fill }]; }))`);
    assert.deepEqual(pulses, {
      twitch: { label: 'Twitch', swatch: 'rgb(145, 70, 255)', stroke: 'rgb(145, 70, 255)', dash: 'none', fill: 'rgb(145, 70, 255)' },
      youtube: { label: 'YouTube', swatch: 'rgb(255, 0, 0)', stroke: 'rgb(255, 0, 0)', dash: 'none', fill: 'rgb(255, 0, 0)' },
    });
    const labelHeights = await dom(c, `[...document.querySelectorAll('[data-platform-pulse] .dx-axis-y')].map(e => e.getBoundingClientRect().height)`);
    assert.equal(labelHeights.length, 10);
    assert.ok(labelHeights.every(height => height >= 9), `etiquetas legibles en el pulso: ${labelHeights}`);
  });
}
