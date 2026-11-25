// Social bar in Chrome: the widget renders icon + nick as text, and the panel adds a profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('the social bar shows icon and nick per profile and the panel adds one', { timeout: 120000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-socials-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); assert.equal(r.ok, true, url); return r.json(); };
  let chrome;
  try {
    await call('PUT', '/api/config', { panel: { onboardingDone: true } });
    await call('PUT', '/api/widgets', { socials: { label: 'Sígueme', items: [
      { id: 's1', platform: 'x', handle: '@egdev6' }, { id: 's2', platform: 'github', handle: '<b>egdev6</b>' }, { id: 's3', platform: 'web', handle: 'egdev.es' }] } });
    chrome = await openChromePage(bin, base + '/widget/socials');
    const c = chrome.cdp, ev = s => evaluateChrome(c, s);
    await waitDom(c, `document.querySelectorAll('#root .item').length === 3`, { timeoutMs: 10000 });
    const shown = await ev(`({ label: document.querySelector('#root .label')?.textContent,
      items: [...document.querySelectorAll('#root .item')].map(e => ({ cls: e.className, icon: e.querySelector('svg.ico')?.getAttribute('aria-label'), handle: e.querySelector('.handle').textContent })),
      injected: document.querySelectorAll('#root .handle b').length })`);
    assert.equal(shown.label, 'Sígueme');
    assert.deepEqual(shown.items, [
      { cls: 'item item-x', icon: 'X', handle: '@egdev6' },
      { cls: 'item item-github', icon: 'GitHub', handle: '<b>egdev6</b>' },
      { cls: 'item item-web', icon: 'Web', handle: 'egdev.es' }]);
    assert.equal(shown.injected, 0, 'nicks are text, never markup');

    // Empty list: nothing on screen; the label alone is not shown.
    await call('PUT', '/api/widgets', { socials: { items: [] } });
    await waitDom(c, `document.querySelectorAll('#root .item').length === 0 && !document.querySelector('#root .label')`, { timeoutMs: 8000 });
    await closeChrome(chrome); chrome = null;

    // Panel: add a profile and save it.
    chrome = await openChromePage(bin, base + '/#/widgets/socials');
    const p = chrome.cdp, pev = s => evaluateChrome(p, s);
    const button = text => `[...document.querySelectorAll('main button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    await waitDom(p, `!!(${button('Añadir red')})`, { timeoutMs: 15000 });
    await pev(`${button('Añadir red')}.click(); true`);
    await waitDom(p, `!!document.querySelector('main select[aria-label="Red 1"]') && !!document.querySelector('main input[aria-label="Nick 1"]')`, { timeoutMs: 5000 });
    await pev(`(() => {
      const s = document.querySelector('main select[aria-label="Red 1"]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'instagram'); s.dispatchEvent(new Event('change', { bubbles: true }));
      const i = document.querySelector('main input[aria-label="Nick 1"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, '@egdev6'); i.dispatchEvent(new Event('input', { bubbles: true }));
      return true; })()`);
    const save = `[...document.querySelectorAll('button')].find(b => /^Guardar/.test(b.textContent.trim()) && !b.disabled)`;
    await waitDom(p, `!!(${save})`, { timeoutMs: 5000 });
    await pev(`${save}.click(); true`);
    for (let i = 0; i < 60; i++) {
      const items = (await (await fetch(base + '/api/widgets')).json()).widgets.socials.items;
      if (items.length === 1) { assert.deepEqual(items.map(x => [x.platform, x.handle]), [['instagram', '@egdev6']]); return; }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.fail('the panel did not save the new profile');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
