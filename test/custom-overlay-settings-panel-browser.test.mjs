// Panel (#344): the values form generated from the declared fields and the fields JSON editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('the panel edits overlay values with a generated form and the fields as JSON', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-overlay-settings-panel-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); assert.equal(r.ok, true, p); return r.json(); };
  await call('PUT', '/api/config', { panel: { onboardingDone: true } });
  const fields = [
    { key: 'title', label: 'Título', type: 'text', default: 'Hola' },
    { key: 'show', label: 'Mostrar', type: 'toggle', default: true },
    { key: 'side', label: 'Lado', type: 'select', options: ['left', 'right'] },
    { key: 'lines', label: 'Líneas', type: 'list' },
  ];
  const { overlay } = await call('POST', '/api/custom-overlays', { name: 'Con ajustes', fields });
  const stored = async () => (await call('GET', '/api/custom-overlays/' + overlay.id)).overlay;
  let chrome;
  try {
    chrome = await openChromePage(bin, base + '/#/overlays/' + overlay.id);
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    await waitDom(c, `document.querySelectorAll('[data-settings] [data-field]').length === 4`, { timeoutMs: 15000 });
    assert.equal(await ev(`document.getElementById('ajuste-title').value`), 'Hola', 'the default shows when there is no value');
    assert.equal(await ev(`document.querySelector('[data-field="side"] select').value`), 'left');
    await ev(`(() => {
      const set = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
      set(document.getElementById('ajuste-title'), 'Sígueme');
      set(document.querySelector('[data-field="side"] select'), 'right');
      set(document.getElementById('ajuste-lines'), 'uno\\ndos');
      return true; })()`);
    const save = `[...document.querySelectorAll('button')].find(b => /^Guardar/.test(b.textContent.trim()) && !b.disabled)`;
    await waitDom(c, `!!(${save})`, { timeoutMs: 5000 });
    await ev(`${save}.click(); true`);
    await waitDom(c, `document.querySelector('.lv-dirty')?.textContent === 'Todo guardado'`, { timeoutMs: 8000 });
    const saved = await stored();
    assert.deepEqual(saved.values, { title: 'Sígueme', side: 'right', lines: ['uno', 'dos'] });
    assert.equal(saved.updatedAt, overlay.updatedAt, 'saving values does not reload the layer');

    // A value changed by the agent (MCP/API) reaches the open editor.
    await call('PUT', '/api/custom-overlays/' + overlay.id, { values: { title: 'Desde el agente' } });
    await waitDom(c, `document.getElementById('ajuste-title').value === 'Desde el agente'`, { timeoutMs: 8000 });

    // Fields as JSON: invalid JSON is flagged and not saved; a valid list is saved.
    await ev(`[...document.querySelectorAll('[role=tab], .tab, button')].find(b => b.textContent.trim() === 'Campos').click(); true`);
    await waitDom(c, `!!document.querySelector('textarea[data-code="fields"]')`, { timeoutMs: 5000 });
    const type = v => ev(`(() => { const el = document.querySelector('textarea[data-code="fields"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await type('[{ "key": ');
    await waitDom(c, `!!document.querySelector('[data-fields-error]')`, { timeoutMs: 3000 });
    await type(JSON.stringify([fields[0], { key: 'color', label: 'Color', type: 'color', default: '#ff0036' }]));
    await waitDom(c, `!document.querySelector('[data-fields-error]') && !!(${save})`, { timeoutMs: 5000 });
    await ev(`${save}.click(); true`);
    await waitDom(c, `document.querySelector('.lv-dirty')?.textContent === 'Todo guardado'`, { timeoutMs: 8000 });
    const after = await stored();
    assert.deepEqual(after.fields.map(field => field.key), ['title', 'color']);
    assert.deepEqual(after.values, { title: 'Desde el agente' }, 'values of removed fields are dropped, matching ones stay');
    assert.ok(after.updatedAt > overlay.updatedAt, 'changing fields reloads the layer');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
