import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInto } from '../scripts/perf.mjs';
import { createApp } from '../src/server.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';
import { clickWhen, closeAll, closeChrome, findChrome, openChromePage, waitDom } from './helpers/react-browser.mjs';
import { runRenderScenario } from './render-scenario.mjs';
import { SURFACES } from './render-surfaces.mjs';

const clocks = {
  dock: ['dock/ElapsedClock'],
  prompter: ['prompter/ElapsedClock', 'prompter/WallClock'],
};
const surfaces = SURFACES.filter(s => Object.hasOwn(clocks, s.page))
  .map(s => ({ ...s, components: [...s.components, ...clocks[s.page]] }));

test('dock and prompter isolate clock ticks and ordinary chat', { timeout: 120000 }, async t => {
  if (!await findChrome()) return t.skip('sin Chrome local; define CHROME_PATH');
  const { pages: [dock, prompter] } = await runRenderScenario({ surfaces, messages: 1, viewersEvery: 1, ticks: 3 });
  for (const page of [dock, prompter]) assert.deepEqual(page.events, { chat: 1, viewers: 1 });
  const renders = { ...dock.components, ...prompter.components };
  const headers = ['dock/Status', 'prompter/Top', 'prompter/Eventos'];

  await t.test('the burst does not render either header or the event lists', () => {
    assert.deepEqual(headers.map(label => renders[label].burst), [0, 0, 0]);
  });
  await t.test('only the header clock leaves render on every manual tick', () => {
    const labels = [...headers, 'prompter/Chat', ...Object.values(clocks).flat()];
    assert.deepEqual(labels.map(label => renders[label].clock), [0, 0, 0, 0, 3, 3, 3]);
  });
  await t.test('one chat message at the bottom causes just one Chat render', () => {
    assert.equal(renders['prompter/Chat'].burst, 1);
  });
});

test('prompter keeps both event lists newest-first and clears a real unread count', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH');
  const root = await mkdtemp(path.join(tmpdir(), 'antena-prompter-render-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const appDist = path.join(root, 'dist');
  await buildInto(appDist);
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), appDist, push: {}, log: () => {} });
  let chrome;
  try {
    app.viewers.stop();
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async (url, data) => {
      const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      assert.equal(response.status, 200, url);
      await response.json();
    };
    const note = (kind, text, user = '') => post('/api/timeline', { kind, text, user });
    await note('question', 'First question');
    await note('saved', 'Older message', 'Synthetic');
    chrome = await openChromePage(bin, base + '/prompter');
    const cdp = chrome.cdp;
    const lists = `Array.from(document.querySelectorAll('.ev-block'), section => Array.from(section.querySelectorAll('.ev-txt'), row => row.textContent))`;
    const expectLists = order => waitDom(cdp, `JSON.stringify(${lists}) === ${JSON.stringify(JSON.stringify(order))}`);
    await expectLists([['Pregunta «First question»'], ['Synthetic Older message']]);
    await note('question', 'Second question');
    await note('highlight', 'Newer message', 'Synthetic');
    await expectLists([['Pregunta «Second question»', 'Pregunta «First question»'], ['Synthetic Newer message', 'Synthetic Older message']]);

    await evaluateChrome(cdp, `document.querySelector('.msgs').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await post('/api/chat/simulate', { user: 'Synthetic', text: 'While reading chat' });
    await waitDom(cdp, `document.querySelector('.eg-timeline__more')?.textContent === '1 mensaje nuevo'`);
    await clickWhen(cdp, `document.querySelector('.eg-timeline__more')`);
    await waitDom(cdp, `!document.querySelector('.eg-timeline__more') && document.querySelector('.msgs').textContent.includes('While reading chat')`);
  } finally {
    await closeAll(
      () => chrome && closeChrome(chrome),
      () => { app.meld.stop(); app.timers.stop(); },
      () => app.closeHttp(),
      () => app.session.flush(),
    );
  }
});
