// #126: formato visible independiente del locale, conservando la zona local React.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const stamp = '2026-01-03T00:07:00Z';
test('fechas React: panel local dd/MM/yyyy HH:mm, reloj 24h y duración dock intacta', { timeout: 60000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-date-126-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  app.session.data.startedAt = stamp;
  app.session.list = async () => [{ id: 'synthetic', title: 'Sesión sintética', startedAt: stamp, events: 0 }];
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let chrome;
  try {
    chrome = await openChromePage(bin, base);
    const c = chrome.cdp;
    const ev = expr => evaluateChrome(c, expr);
    await c.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
    await c.send('Emulation.setLocaleOverride', { locale: 'en-US' });
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${Date.parse(stamp) + 65000};` });
    const navigate = async (route, ready) => {
      await c.send('Page.navigate', { url: base + route });
      await waitDom(c, ready, { timeoutMs: 12000 });
    };
    const capture = async name => {
      if (!process.env.EGDEV_DATE_EVIDENCE) return;
      const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.env.EGDEV_DATE_EVIDENCE, name + '.png'), Buffer.from(data, 'base64'));
    };
    await navigate('/#/directo', `document.querySelector('#h-past')?.closest('section').textContent.includes('02/01/2026 19:07')`);
    assert.match(await ev(`document.querySelector('.view-head .crumb').textContent`), /desde las 19:07/);
    assert.match(await ev(`document.querySelector('#h-past').closest('section').textContent`), /02\/01\/2026 19:07/);
    await capture('panel-date');
    await navigate('/prompter', `document.querySelector('.pr-clock')?.textContent === '19:08'`);
    assert.equal(await ev(`document.querySelector('.pr-clock').textContent`), '19:08');
    await capture('prompter-clock');
    await navigate('/dock', `document.querySelector('.d-live b')?.textContent === '1:05'`);
    assert.equal(await ev(`document.querySelector('.d-live b').textContent`), '1:05');
    await capture('dock-duration');
  } finally {
    if (chrome) await closeChrome(chrome);
    await new Promise(r => app.server.close(r));
    await app.session.flush();
    await rm(dataDir, { recursive: true, force: true });
  }
});
