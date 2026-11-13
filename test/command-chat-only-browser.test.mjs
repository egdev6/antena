// Browser coverage for command creation and editing; only the public HTTP API and rendered DOM are observed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const quote = JSON.stringify;
const tile = text => `[...document.querySelectorAll('.lv-drawer [role="radio"]')].find(b => b.querySelector('b')?.textContent.trim() === ${quote(text)})`;
const button = text => `[...document.querySelectorAll('.lv-drawer button')].find(b => b.textContent.trim() === ${quote(text)})`;
const tabs = `[...document.querySelectorAll('.lv-drawer [role="tab"]')].map(b => b.textContent.trim())`;

async function panel(run) {
  await stat(new URL('../app/dist/index.html', import.meta.url));
  const bin = await findChrome();
  assert.ok(bin, 'Chrome is required');
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-chat-only-browser-'));
  let app, chrome;
  try {
    app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const api = async (method, endpoint, body) => {
      const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
      assert.equal(response.status, 200, `${method} ${endpoint}`);
      return response.json();
    };
    await api('PUT', '/api/config', { panel: { onboardingDone: true } });
    chrome = await openChromePage(bin, `${base}/#/comandos/nuevo`);
    const c = chrome.cdp;
    const dom = expression => evaluateChrome(c, expression, { timeoutMs: 6000 });
    await waitDom(c, `!!document.querySelector('.lv-drawer input.mono') && !!(${button('Crear comando')})`, { timeoutMs: 15000 });
    await run({ c, dom, api });
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), async () => {
      if (app) { app.timers.stop(); app.server.closeAllConnections(); await app.closeHttp(); }
    }, () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
}

async function create(c, dom, template, trigger) {
  await dom(`(() => { const input = document.querySelector('.lv-drawer input.mono'); input.focus(); input.select(); return true; })()`);
  await c.send('Input.insertText', { text: trigger });
  await clickWhen(c, tile(template));
  await clickWhen(c, button('Crear comando'));
  await waitDom(c, `!!document.querySelector('.lv-drawer input[aria-label="Disparador"]')`, { timeoutMs: 12000 });
}

test('chat-only editor exposes a reply and hides alert controls and preview', { timeout: 90000 }, () => panel(async ({ c, dom, api }) => {
  assert.equal(await dom(`!!(${tile('Solo chat')})`), true, 'creation offers Solo chat');
  await create(c, dom, 'Solo chat', '!onlychat');
  assert.equal(await dom(`document.querySelector('[aria-label="Modo de salida"]').value`), 'chat');
  assert.equal(await dom(`!!document.querySelector('[data-field="chatReply"] textarea')`), true);
  assert.match(await dom(`document.querySelector('#tp-cmd').textContent`), /chat real/);
  assert.equal(await dom(`!!document.querySelector('.lv-drawer .preview-col')`), false);
  assert.equal(await dom(`${tabs}.some(t => /Diseño|Sonido|Acciones|CSS/.test(t))`), false);
  assert.equal(await dom(`!!(${button('Probar en el directo')})`), false);
  const [created] = await api('GET', '/api/commands');
  assert.equal(created.outputMode, 'chat');

  await dom(`(() => { const s = document.querySelector('[aria-label="Modo de salida"]'); s.value = 'alert'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitDom(c, `!!document.querySelector('.lv-drawer .preview-col') && ${tabs}.includes('Diseño')`);
  await dom(`(() => { const s = document.querySelector('[aria-label="Modo de salida"]'); s.value = 'chat'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitDom(c, `!document.querySelector('.lv-drawer .preview-col') && !!document.querySelector('[data-field="chatReply"] textarea')`);
  const reply = 'Hello {user}: {args}';
  await dom(`document.querySelector('[data-field="chatReply"] textarea').focus(); document.querySelector('[data-field="chatReply"] textarea').select(); true`);
  await c.send('Input.insertText', { text: reply });
  await clickWhen(c, button('Guardar'));
  await waitDom(c, `document.querySelector('.lv-dirty')?.textContent.trim() === 'Todo guardado'`);
  const [saved] = await api('GET', '/api/commands');
  assert.equal(saved.outputMode, 'chat');
  assert.equal(saved.chatReply, reply);
}));

test('alert-and-reply template remains distinct from chat-only', { timeout: 90000 }, () => panel(async ({ c, dom, api }) => {
  assert.equal(await dom(`!!(${tile('Alerta y respuesta')}) && !!(${tile('Solo chat')})`), true);
  assert.match(await dom(`(${tile('Alerta y respuesta')}).textContent`), /Alerta y respuesta/);
  assert.match(await dom(`(${tile('Solo chat')}).textContent`), /Sin alerta/i);
  await create(c, dom, 'Alerta y respuesta', '!both');
  assert.equal(await dom(`document.querySelector('[aria-label="Modo de salida"]').value`), 'alert');
  assert.equal(await dom(`!!document.querySelector('.lv-drawer .preview-col')`), true);
  assert.equal(await dom(`${tabs}.includes('Diseño')`), true);
  assert.equal(await dom(`${tabs}.some(t => t.startsWith('Acciones al salir'))`), true);
  const [created] = await api('GET', '/api/commands');
  assert.ok(created.outputMode === undefined || created.outputMode === 'alert');
  assert.deepEqual(created.actions.map(({ kind, destination }) => ({ kind, destination })), [{ kind: 'chat', destination: 'both' }]);
}));
