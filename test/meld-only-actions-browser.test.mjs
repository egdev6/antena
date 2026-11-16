// S4: el panel se compila en un directorio temporal, sin depender de app/dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const supported = [
  'meld.startStreamingAction', 'meld.stopStreamingAction', 'meld.toggleStreamingAction',
  'meld.startRecordingAction', 'meld.stopRecordingAction', 'meld.toggleRecordingAction',
];
const warning = 'Esta acción solo funciona con Meld; con OBS no hace nada.';
const actions = [
  { kind: 'streamEvent', event: 'CONFETTIPOP_TRIGGER', amount: 1, delaySec: 0 },
  { kind: 'command', command: 'meld.recordClip', delaySec: 0 },
  { kind: 'command', command: 'meld.toggleRecordingAction', delaySec: 0 },
  { kind: 'chat', text: 'hola', destination: 'twitch', delaySec: 0 },
];
const meldButtons = ['Guardar clip y marcar', 'Confeti', 'Lluvia de confeti', 'Girar ruleta', 'Captura'];
const button = text => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const row = index => `document.querySelectorAll('.lv-slide .action')[${index}]`;
const kind = index => `${row(index)}.querySelector('select[aria-label="Qué hace"]')`;
const option = (index, value) => `${kind(index)}.querySelector('option[value="${value}"]')`;
const command = index => `${row(index)}.querySelector('.afields label select')`;
const confetti = `([...document.querySelectorAll('label.switch')].find(l => l.textContent.includes('Confeti en el programa de emisión')))`;
const dom = (page, expression) => evaluateChrome(page.cdp, expression, { timeoutMs: 12000 });
const wait = (page, expression) => waitDom(page.cdp, expression, { timeoutMs: 15000 });
const selectValue = (selector, value) => `(() => { const e = ${selector}; e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`;
let panelBuild;
async function buildPanel(dist) {
  panelBuild ||= build({ entryPoints: [fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url))],
    outfile: path.join(tmpdir(), 'antena-meld-only-panel.js'), bundle: true, format: 'esm', minify: true, write: false,
    target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/ds/*'], logLevel: 'silent' });
  const assets = path.join(dist, 'assets');
  await mkdir(assets, { recursive: true });
  const result = await panelBuild;
  await Promise.all([...result.outputFiles.map(file => writeFile(path.join(assets, 'panel' + path.extname(file.path)), file.contents)),
    writeFile(path.join(dist, 'index.html'), '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/ds/tokens.css"><link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/assets/panel.css"></head><body><div id="root"></div><script type="module" src="/assets/panel.js"></script></body></html>')]);
}
async function fixture(t, program = 'obs') {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH'); return null; }
  const root = await mkdtemp(path.join(tmpdir(), 'antena-meld-only-'));
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
  const dist = path.join(root, 'dist'); await buildPanel(dist);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, endpoint, body) => {
    const response = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const json = await response.json(); assert.equal(response.status, 200, `${method} ${endpoint}: ${json.error}`); return json;
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true },
    meld: { url: `ws://127.0.0.1:${meld.server.address().port}` }, obs: { url: `ws://127.0.0.1:${obs.server.address().port}` } });
  await api('PUT', '/api/alerts/follow', { actions });
  const { shortcut } = await api('POST', '/api/shortcuts', { name: 'Acciones guardadas', steps: actions });
  await api('PUT', '/api/interactive/config', { giveaway: { meldConfetti: true } });
  if (program === 'obs') await api('PUT', '/api/config', { program: { kind: 'obs' } });
  else await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
  for (let i = 0; i < 200 && (await api('GET', '/api/status')).meld.state !== 'conectado'; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal((await api('GET', '/api/status')).meld.state, 'conectado');
  page = await openChromePage(bin, `${base}/#/alertas/follow`);
  return { page, api, obs, meld, shortcut };
}
async function showAlertActions(page) {
  await wait(page, `[...document.querySelectorAll('.lv-slide [role=tab]')].some(t => t.textContent.startsWith('Acciones al salir'))`);
  await dom(page, `[...document.querySelectorAll('.lv-slide [role=tab]')].find(t => t.textContent.startsWith('Acciones al salir')).click()`);
  await wait(page, `document.querySelectorAll('.lv-slide .action').length === 4`);
}
async function showShortcut(page, shortcut) {
  await dom(page, `location.hash = '#/atajos/${shortcut.id}'`);
  await wait(page, `document.querySelector('.lv-slide input[aria-label="Nombre del atajo"]')?.value === 'Acciones guardadas' && document.querySelectorAll('.lv-slide .action').length === 4`);
}
async function checkObsPicker(page) {
  for (const i of [0, 1, 2, 3]) {
    assert.deepEqual(await dom(page, `({ disabled: ${option(i, 'streamEvent')}.disabled, text: ${option(i, 'streamEvent')}.textContent })`),
      { disabled: true, text: 'Evento de widget de Meld (solo con Meld)' });
    assert.deepEqual(await dom(page, `({ disabled: ${option(i, 'command')}.disabled, text: ${option(i, 'command')}.textContent })`),
      { disabled: false, text: 'Comando del programa (en OBS: emitir y grabar)' });
  }
  for (const i of [0, 1]) assert.match(await dom(page, `${row(i)}.textContent`), new RegExp(warning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const i of [2, 3]) assert.equal(await dom(page, `${row(i)}.textContent.includes(${JSON.stringify(warning)})`), false);
  assert.match(await dom(page, `${row(1)}.textContent`), /meld\.recordClip/);
  assert.deepEqual(await dom(page, `[...${command(2)}.options].map(o => o.value).filter(Boolean)`), supported);
  await dom(page, selectValue(kind(3), 'command'));
  await wait(page, `!!${command(3)} && ${kind(3)}.value === 'command'`);
  assert.deepEqual(await dom(page, `[...${command(3)}.options].map(o => o.value).filter(Boolean)`), supported);
  assert.equal(await dom(page, `${row(3)}.textContent.includes(${JSON.stringify(warning)})`), false);
  await dom(page, selectValue(command(3), supported[0]));
  assert.equal(await dom(page, `${command(3)}.value`), supported[0]);
}

test('OBS: selector y acciones guardadas en el editor de alertas', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await showAlertActions(f.page);
  await checkObsPicker(f.page);
  assert.deepEqual((await f.api('GET', '/api/alerts/follow')).config.actions, actions, 'el borrador no cambia lo guardado');
  await wait(f.page, `!document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`);
  await dom(f.page, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').click()`);
  await wait(f.page, `document.querySelector('.lv-slide .lv-sfoot [role="status"]')?.textContent === 'Todo guardado'`);
  const saved = (await f.api('GET', '/api/alerts/follow')).config.actions;
  assert.deepEqual(saved.slice(0, 3), actions.slice(0, 3), 'las acciones anteriores no se pierden al guardar');
  assert.equal(saved[3].command, supported[0]);
});

test('OBS: selector y pasos guardados en Atajos', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await showShortcut(f.page, f.shortcut);
  await checkObsPicker(f.page);
  assert.deepEqual((await f.api('GET', '/api/shortcuts')).custom[0].steps, actions);
  await wait(f.page, `!document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').disabled`);
  await dom(f.page, `document.querySelector('.lv-slide .lv-sfoot .eg-btn--secondary').click()`);
  await wait(f.page, `document.querySelector('.lv-slide .lv-sfoot [role="status"]')?.textContent === 'Todo guardado'`);
  const saved = (await f.api('GET', '/api/shortcuts')).custom[0].steps;
  assert.deepEqual(saved.slice(0, 3), actions.slice(0, 3));
  assert.equal(saved[3].command, supported[0]);
});

test('OBS: el desplegable solo ofrece los seis comandos de emisión y grabación', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await showAlertActions(f.page);
  assert.deepEqual(await dom(f.page, `[...${command(2)}.options].map(o => o.value).filter(Boolean)`), supported);
  for (const value of supported) {
    await dom(f.page, selectValue(command(2), value));
    assert.equal(await dom(f.page, `${command(2)}.value`), value);
    assert.equal(await dom(f.page, `${row(2)}.textContent.includes(${JSON.stringify(warning)})`), false);
  }
});

test('OBS: las acciones guardadas exclusivas de Meld tienen una explicación', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await showAlertActions(f.page);
  for (const i of [0, 1]) assert.equal(await dom(f.page, `${row(i)}.textContent.includes(${JSON.stringify(warning)})`), true);
  assert.match(await dom(f.page, `${row(1)}.textContent`), /meld\.recordClip/);
  for (const i of [2, 3]) assert.equal(await dom(f.page, `${row(i)}.textContent.includes(${JSON.stringify(warning)})`), false);
  assert.deepEqual((await f.api('GET', '/api/alerts/follow')).config.actions, actions);
});

test('OBS: los cinco botones exclusivos de Meld están desactivados', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await dom(f.page, `location.hash = '#/meld/escenas'`);
  await wait(f.page, `!!${button('Guardar clip y marcar')}`);
  for (const name of meldButtons) assert.equal(await dom(f.page, `${button(name)}.disabled`), true, name);
});

test('los selectores y avisos siguen el cambio de programa sin perder acciones', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'meld'); if (!f) return;
  await showAlertActions(f.page);
  assert.equal(await dom(f.page, `${option(0, 'streamEvent')}.disabled`), false);
  assert.equal(await dom(f.page, `${command(1)}.value`), 'meld.recordClip');
  await f.api('PUT', '/api/config', { program: { kind: 'obs' } });
  await wait(f.page, `${option(0, 'streamEvent')}.disabled && ${row(1)}.textContent.includes(${JSON.stringify(warning)})`);
  assert.deepEqual(await dom(f.page, `[...${command(1)}.options].map(o => o.value).filter(Boolean)`), supported);
  await f.api('PUT', '/api/config', { program: { kind: 'meld' } });
  await wait(f.page, `!${option(0, 'streamEvent')}.disabled && ${command(1)}.value === 'meld.recordClip'`);
  assert.equal(await dom(f.page, `${row(1)}.textContent.includes(${JSON.stringify(warning)})`), false);
  assert.deepEqual((await f.api('GET', '/api/alerts/follow')).config.actions, actions);
});

test('OBS: el confeti del sorteo queda desactivado y explica por qué', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await dom(f.page, `location.hash = '#/sorteo/ajustes'`);
  await wait(f.page, `!!${confetti}`);
  assert.equal(await dom(f.page, `${confetti}.querySelector('input').checked`), true);
  assert.equal(await dom(f.page, `${confetti}.querySelector('input').matches(':disabled')`), true);
  assert.equal(await dom(f.page, `getComputedStyle(${confetti}).cursor`), 'not-allowed');
  assert.ok(Number(await dom(f.page, `getComputedStyle(${confetti}).opacity`)) < 1);
  assert.match(await dom(f.page, `${confetti}.parentElement.textContent`), /solo con Meld/);
  await dom(f.page, `${confetti}.querySelector('input').click()`);
  assert.equal(await dom(f.page, `${confetti}.querySelector('input').checked`), true);
  assert.equal((await f.api('GET', '/api/interactive')).config.giveaway.meldConfetti, true);
  const other = `([...document.querySelectorAll('label.switch')].find(l => l.textContent.includes('No repetir ganador')).querySelector('input'))`;
  assert.equal(await dom(f.page, `${other}.matches(':disabled')`), false);
});

test('OBS: aviso y botones Meld inactivos; la grabación sigue funcionando', { timeout: 60000 }, async t => {
  const f = await fixture(t); if (!f) return;
  await dom(f.page, `location.hash = '#/meld/escenas'`);
  await wait(f.page, `!!${button('Guardar clip y marcar')} && !!${button('Grabar')}`);
  assert.match(await dom(f.page, `document.querySelector('main').textContent`), /Estás usando OBS\. Esta página es solo para Meld\./);
  await dom(f.page, `(() => { const original = window.fetch; window.__posts = []; window.fetch = (...args) => { if (args[1]?.method === 'POST') window.__posts.push([String(args[0]), args[1].body]); return original(...args); }; })()`);
  for (const name of meldButtons) {
    assert.equal(await dom(f.page, `${button(name)}.disabled`), true, name);
    await dom(f.page, `${button(name)}.click()`);
  }
  assert.deepEqual(await dom(f.page, 'window.__posts'), []);
  assert.equal(await dom(f.page, `${button('Grabar')}.disabled`), false);
  await dom(f.page, `${button('Grabar')}.click()`);
  await wait(f.page, `!!${button('Parar grabación')}`);
  assert.deepEqual(await dom(f.page, `window.__posts.map(([url, body]) => [url, JSON.parse(body)])`),
    [['/api/meld/command', { command: 'meld.toggleRecordingAction' }]]);
  assert.equal(f.obs.requests.filter(request => request.requestType === 'ToggleRecord').length, 1);
  assert.equal((await f.api('GET', '/api/status')).meld.recording, true);
});

test('Meld conserva los selectores, el confeti y los controles de Meld', { timeout: 60000 }, async t => {
  const f = await fixture(t, 'meld'); if (!f) return;
  await showAlertActions(f.page);
  for (const i of [0, 1, 2, 3]) {
    assert.deepEqual(await dom(f.page, `({ disabled: ${option(i, 'streamEvent')}.disabled, text: ${option(i, 'streamEvent')}.textContent })`),
      { disabled: false, text: 'Evento de widget de Meld' });
    assert.deepEqual(await dom(f.page, `({ disabled: ${option(i, 'command')}.disabled, text: ${option(i, 'command')}.textContent })`),
      { disabled: false, text: 'Comando de Meld' });
    assert.equal(await dom(f.page, `${row(i)}.textContent.includes(${JSON.stringify(warning)})`), false);
  }
  assert.deepEqual(await dom(f.page, `[...${command(1)}.options].map(o => o.value).filter(Boolean)`), (await f.api('GET', '/api/state')).meld.commands);
  assert.equal(await dom(f.page, `${command(1)}.value`), 'meld.recordClip');
  await showShortcut(f.page, f.shortcut);
  assert.equal(await dom(f.page, `${option(0, 'streamEvent')}.disabled`), false);
  assert.equal(await dom(f.page, `${option(1, 'command')}.textContent`), 'Comando de Meld');
  await dom(f.page, `location.hash = '#/sorteo/ajustes'`); await wait(f.page, `!!${confetti}`);
  assert.equal(await dom(f.page, `${confetti}.querySelector('input').disabled`), false);
  assert.equal(await dom(f.page, `${confetti}.parentElement.textContent.includes('solo con Meld')`), false);
  await dom(f.page, `${confetti}.querySelector('input').click()`);
  await wait(f.page, `!${confetti}.querySelector('input').checked && !!document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await f.api('GET', '/api/interactive')).config.giveaway.meldConfetti, true);
  await dom(f.page, `[...document.querySelectorAll('.lv-savebar button')].find(b => b.textContent.trim() === 'Guardar').click()`);
  await wait(f.page, `!document.querySelector('.lv-savebar.is-open')`);
  assert.equal((await f.api('GET', '/api/interactive')).config.giveaway.meldConfetti, false);
  await dom(f.page, `location.hash = '#/meld/escenas'`); await wait(f.page, `!!${button('Grabar')}`);
  assert.equal(await dom(f.page, `document.querySelector('main').textContent.includes('Estás usando OBS.')`), false);
  for (const name of meldButtons) assert.equal(await dom(f.page, `${button(name)}.disabled`), false, name);
  await dom(f.page, `${button('Grabar')}.click()`);
  await wait(f.page, `window.fetch !== undefined`);
  for (let i = 0; i < 100 && !f.meld.state.calls.some(call => call[0] === 12); i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(f.meld.state.calls.filter(call => call[0] === 12).map(call => call[1]), ['meld.toggleRecordingAction']);
});
