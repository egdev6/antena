// #159: empaqueta el panel y el dock candidatos en memoria para cada fixture aislado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { fakeMeldRecording } from './helpers/fake-meld-recording.mjs';
import { findChrome, closeAll, closeChrome, openChromePage, waitDom, buttonByText, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const dom = (chrome, expression) => evaluateChrome(chrome.cdp, expression, { timeoutMs: 12000 });
const button = text => buttonByText(text);
const setting = `Array.from(document.querySelectorAll('label.switch')).find(l => l.textContent.trim() === 'Grabar al empezar el directo')?.querySelector('input')`;
const saveButton = text => `Array.from(document.querySelectorAll('.lv-savebar button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const dialog = `document.querySelector('dialog[open]')`;
const calls = meld => meld.state.calls.filter(c => c[0] === 12).map(c => c[1]);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`No llegó: ${label}`); await tick(); }
}
function nextWhere(emitter, predicate) {
  return new Promise(resolve => {
    const on = value => { if (predicate(value)) { emitter.off('status', on); resolve(value); } };
    emitter.on('status', on);
  });
}

let uiBuild;
async function setup(t) {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH'); return null; }
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-recording-browser-'));
  const meld = fakeMeldRecording(), pages = [];
  let app;
  t.after(async () => {
    await closeAll(...pages.map(page => () => closeChrome(page)), async () => {
      if (app) {
        await app.drainAutoSession().catch(() => {});
        await app.session.flush().catch(() => {});
        app.meld.stop(); await app.closeHttp().catch(() => {});
      }
    }, () => new Promise(resolve => meld.server.close(resolve)), () => rm(dir, { recursive: true, force: true }));
  });
  await new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve));
  const appDist = path.join(dir, 'dist'), assets = path.join(appDist, 'assets');
  await mkdir(assets, { recursive: true });
  uiBuild ||= build({ entryPoints: {
    panel: fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url)),
    dock: fileURLToPath(new URL('../app/src/dock/main.tsx', import.meta.url)),
  }, outdir: path.join(dir, 'virtual'), bundle: true, format: 'esm', minify: true, write: false,
  target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  external: ['/fonts/*', '/ds/*'], logLevel: 'silent' });
  const built = await uiBuild;
  await Promise.all(built.outputFiles.map(file => writeFile(path.join(assets, path.basename(file.path)), file.contents)));
  for (const [name, entry] of [['index', 'panel'], ['dock', 'dock']])
    await writeFile(path.join(appDist, `${name}.html`), `<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/ds/tokens.css"><link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/assets/${entry}.css"></head><body><div id="root"></div><script type="module" src="/assets/${entry}.js"></script></body></html>`);
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), appDist, push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    const data = await response.json(); assert.equal(response.status, 200, data.error); return data;
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true } });
  const ready = nextWhere(app.meld, st => st.state === 'conectado');
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` }); await ready;
  const report = async values => {
    const changed = nextWhere(app.meld, st => st.state === 'conectado'
      && (!Object.hasOwn(values, 'streaming') || st.streaming === values.streaming)
      && (!Object.hasOwn(values, 'recording') || st.recording === values.recording));
    meld.report(values); await changed;
  };
  const open = async (route, narrow = false) => {
    const page = await openChromePage(bin, 'about:blank'); pages.push(page);
    if (narrow) await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 780, deviceScaleFactor: 1, mobile: false });
    await page.cdp.send('Page.navigate', { url: base + route });
    return page;
  };
  return { app, meld, api, report, open };
}

test('record-on-start switch discards, saves and persists without reconnecting Meld', { timeout: 60000 }, async t => {
  const f = await setup(t); if (!f) return;
  let disconnected = 0;
  f.app.meld.on('status', st => { if (st.state !== 'conectado') disconnected++; });
  const page = await f.open('/#/meld/conexion');
  await waitDom(page.cdp, `!!(${setting})`, { timeoutMs: 20000 });
  assert.equal(await dom(page, `(${setting}).checked`), false);
  await clickWhen(page.cdp, setting);
  await waitDom(page.cdp, `(${setting}).checked && !!document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await f.api('GET', '/api/config')).program.recordOnStart, false);
  await clickWhen(page.cdp, saveButton('Descartar'));
  await waitDom(page.cdp, `!(${setting}).checked && !document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await f.api('GET', '/api/config')).program.recordOnStart, false);
  await clickWhen(page.cdp, setting); await clickWhen(page.cdp, saveButton('Guardar'));
  await waitDom(page.cdp, `(${setting}).checked && !document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await f.api('GET', '/api/config')).program.recordOnStart, true);
  assert.equal(disconnected, 0); assert.deepEqual(calls(f.meld), []);
  await dom(page, `window.__recordingOldPage = true`);
  await page.cdp.send('Page.reload');
  await waitDom(page.cdp, `!window.__recordingOldPage && !!(${setting}) && (${setting}).checked`, { timeoutMs: 20000 });
  assert.equal(disconnected, 0);
});

test('existing manual recording button still sends its toggle command', { timeout: 60000 }, async t => {
  const f = await setup(t); if (!f) return;
  const page = await f.open('/#/meld/escenas');
  await waitDom(page.cdp, `!!(${button('Grabar')})`, { timeoutMs: 20000 });
  await clickWhen(page.cdp, button('Grabar'));
  await until(() => calls(f.meld).length === 1, 'primer toggle manual');
  assert.deepEqual(calls(f.meld), ['meld.toggleRecordingAction']);
  await f.report({ recording: true });
  await waitDom(page.cdp, `!!(${button('Parar grabación')})`);
  await clickWhen(page.cdp, button('Parar grabación'));
  await until(() => calls(f.meld).length === 2, 'segundo toggle manual');
  assert.deepEqual(calls(f.meld), ['meld.toggleRecordingAction', 'meld.toggleRecordingAction']);
  await f.report({ recording: false });
  await waitDom(page.cdp, `!!(${button('Grabar')})`);
});

test('asynchronous recording failure stays visible in the dock while live, including outside Control', { timeout: 60000 }, async t => {
  const f = await setup(t); if (!f) return;
  await f.api('PUT', '/api/config', { meld: { recordOnStart: true } });
  let reject;
  const gate = new Promise((_resolve, no) => { reject = no; });
  gate.catch(() => {});
  const original = f.app.meld.command.bind(f.app.meld);
  f.app.meld.command = command => command === 'meld.startRecordingAction' ? original(command).then(() => gate) : original(command);
  try {
    const page = await f.open('/dock', true);
    await waitDom(page.cdp, `!!(${button('Iniciar directo')})`, { timeoutMs: 20000 });
    await clickWhen(page.cdp, button('Iniciar directo'));
    await waitDom(page.cdp, `!!${dialog}`);
    await clickWhen(page.cdp, `${dialog}.querySelector('[data-confirm-stream]')`);
    await until(() => calls(f.meld).length === 1, 'inicio de emisión');
    assert.deepEqual(calls(f.meld), ['meld.startStreamingAction']);
    await f.report({ streaming: true });
    await until(() => calls(f.meld).length === 2, 'solicitud de grabación');
    await waitDom(page.cdp, `!!(${button('Terminar directo')}) && document.querySelector('.d-live').textContent.includes('En directo')`);
    await clickWhen(page.cdp, `document.querySelector('#d-t-audio')`);
    await waitDom(page.cdp, `document.querySelector('#d-p-control').hidden`);
    reject(new Error('fallo simulado'));
    await waitDom(page.cdp, `document.querySelector('.d-top [role="status"]')?.textContent.includes('No se pudo iniciar la grabación')`);
    assert.equal((await f.api('GET', '/api/status')).meld.streaming, true);
    assert.deepEqual(calls(f.meld), ['meld.startStreamingAction', 'meld.startRecordingAction']);
    await clickWhen(page.cdp, `document.querySelector('#d-t-control')`);
    await waitDom(page.cdp, `document.querySelector('.d-top [role="status"]')?.textContent.includes('No se pudo iniciar la grabación')`);
  } finally { reject(new Error('fin de prueba')); }
});
