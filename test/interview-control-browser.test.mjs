// Interview live control (#278) in the browser: the dock module «Entrevista», Widgets › Entrevista
// (panel) and the prompter tab «Entrevista» run the same actions, the widget payload follows, the
// private notes and the «n / total» progress show up in the prompter and the panel/dock, and the
// SSE the widget listens to never carries the notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const PACK = {
  version: 1, id: 'directo', title: 'En directo', guest: { name: 'Ana' },
  rounds: [
    { id: 'r1', title: 'Calentamiento', items: [
      { id: 'a', question: 'Primera pregunta', media: { type: 'image', file: 'foto.jpg' }, notes: 'NOTA-PRIVADA-A', aprobado: true },
      { id: 'b', question: 'Sin aprobar', notes: 'NOTA-PRIVADA-B', aprobado: false },
      { id: 'c', question: 'Segunda pregunta', notes: 'NOTA-PRIVADA-C', aprobado: true },
    ] },
    { id: 'r2', title: 'Final', items: [{ id: 'd', question: 'Tercera pregunta', notes: 'NOTA-PRIVADA-D', aprobado: true }] },
  ],
};
const ids = ['stream', 'alerts', 'marks', 'scenes', 'teleprompter', 'credits', 'audio', 'questions', 'tierlist', 'giveaway', 'shortcuts', 'interview'];

test('dock, panel and prompter drive the interview; widget follows; notes only in prompter, panel and dock', { timeout: 180000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-interview-control-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ui: 'react' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  let chrome;
  try {
    // widget SSE listener: must never see a note
    const ctl = new AbortController(); let widgetRaw = '';
    const sse = await fetch(`${base}/api/stream?client=widget`, { signal: ctl.signal });
    (async () => { try { for await (const ch of sse.body) widgetRaw += Buffer.from(ch).toString(); } catch { /* closed */ } })();
    t.after(() => ctl.abort());

    // no active interview: the module says so and offers no actions
    await call('PUT', '/api/config', { dock: { layout: 'tabs', modules: ids.map(id => ({ id, enabled: id !== 'shortcuts' })), zones: [{ id: 'control', label: 'Control', modules: ['stream', 'interview'] }] } });
    chrome = await openChromePage(bin, `${base}/dock`);
    const c = chrome.cdp;
    const dom = expr => evaluateChrome(c, expr, { timeoutMs: 12000 });
    await waitDom(c, `!!document.querySelector('[aria-label="Entrevista"]')`, { timeoutMs: 20000 });
    assert.match(await dom(`document.querySelector('.d-interview').textContent`), /Sin entrevista activa/);
    assert.equal(await dom(`document.querySelectorAll('.d-interview [data-interview-act]').length`), 0);

    assert.equal((await call('POST', '/api/interviews/import', PACK)).status, 200);
    assert.equal((await call('POST', '/api/interviews/select', { id: 'directo' })).status, 200);
    const widget = () => app.interviews.activeItem();
    const act = a => clickWhen(c, `document.querySelector('[data-interview-act="${a}"]')`);
    const text = sel => dom(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);

    // dock: next / previous / go-to / media / hide
    await waitDom(c, `!!document.querySelector('[data-interview-act="next"]')`, { timeoutMs: 9000 });
    await act('next');
    await waitDom(c, `document.querySelector('[data-interview-current]')?.textContent === 'Primera pregunta'`, { timeoutMs: 9000 });
    assert.equal(widget().id, 'a');
    assert.match(await text('[data-interview-progress]'), /^1 \/ 3$/);
    assert.match(await text('[data-interview-notes]'), /NOTA-PRIVADA-A/, 'dock shows the notes');
    assert.match(await text('[data-interview-next]'), /Segunda pregunta/, 'skips the unapproved item');
    await act('media');
    await waitDom(c, `document.querySelector('[data-interview-act="media"]').textContent === 'Mostrar media'`, { timeoutMs: 9000 });
    assert.deepEqual(widget(), { id: 'a', question: 'Primera pregunta' });
    await act('media');
    await waitDom(c, `document.querySelector('[data-interview-act="media"]').textContent === 'Ocultar media'`, { timeoutMs: 9000 });
    assert.ok(widget().media);
    await act('next'); await act('next');
    await waitDom(c, `document.querySelector('[data-interview-progress]')?.textContent === '3 / 3'`, { timeoutMs: 9000 });
    assert.equal(widget().id, 'd');
    assert.equal(await dom(`document.querySelector('[data-interview-act="next"]').disabled`), true, 'no next after the last item');
    await act('previous');
    await waitDom(c, `document.querySelector('[data-interview-current]')?.textContent === 'Segunda pregunta'`, { timeoutMs: 9000 });
    await dom(`(() => { const s = document.querySelector('[data-interview-goto]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, 'a'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitDom(c, `document.querySelector('[data-interview-current]')?.textContent === 'Primera pregunta'`, { timeoutMs: 9000 });
    assert.equal(widget().id, 'a');
    await act('hide');
    await waitDom(c, `document.querySelector('[data-interview-current]')?.textContent === 'Nada en pantalla'`, { timeoutMs: 9000 });
    assert.equal(widget(), null);

    // panel: Widgets › Entrevista runs the same actions
    await c.send('Page.navigate', { url: `${base}/#/widgets/interview` });
    await waitDom(c, `!!document.querySelector('main [data-interview-act="next"]')`, { timeoutMs: 20000 });
    await act('next');
    await waitDom(c, `document.querySelector('main [data-interview-current]')?.textContent === 'Primera pregunta'`, { timeoutMs: 9000 });
    assert.equal(widget().id, 'a');
    assert.match(await text('main [data-interview-notes]'), /NOTA-PRIVADA-A/, 'panel shows the notes');
    await act('next');
    await waitDom(c, `document.querySelector('main [data-interview-current]')?.textContent === 'Segunda pregunta'`, { timeoutMs: 9000 });
    assert.equal(widget().id, 'c');

    // prompter: tab «Entrevista» with current, next, notes and progress
    await c.send('Page.navigate', { url: `${base}/prompter` });
    await waitDom(c, `!!document.querySelector('.pr-side .tabs .tab')`, { timeoutMs: 20000 });
    assert.deepEqual(JSON.parse(await dom(`JSON.stringify([...document.querySelectorAll('.pr-side .tabs .tab')].map(b => b.textContent.replace(/[\\d/]+/g, '').trim()))`)), ['Eventos', 'Preguntas', 'Entrevista']);
    await clickWhen(c, `[...document.querySelectorAll('.pr-side .tabs .tab')].find(b => b.textContent.startsWith('Entrevista'))`);
    await waitDom(c, `document.querySelector('[data-interview-current]')?.textContent === 'Segunda pregunta'`, { timeoutMs: 9000 });
    assert.match(await text('[data-interview-progress]'), /^2 \/ 3$/);
    assert.match(await text('[data-interview-notes]'), /NOTA-PRIVADA-C/);
    assert.match(await text('[data-interview-next]'), /Tercera pregunta/);
    assert.match(await text('[data-interview-next-notes]'), /NOTA-PRIVADA-D/);
    await act('next');
    await waitDom(c, `document.querySelector('[data-interview-progress]')?.textContent === '3 / 3'`, { timeoutMs: 9000 });
    assert.equal(widget().id, 'd');

    // every shown question left a mark; the widget stream never saw a note
    const marks = (await call('GET', '/api/timeline?kinds=question')).body.items;
    assert.deepEqual(marks.map(m => m.itemId), ['a', 'c', 'd', 'c', 'a', 'a', 'c', 'd'], 'one mark per shown question, in order');
    assert.doesNotMatch(widgetRaw, /NOTA-PRIVADA/);
    assert.match(widgetRaw, /event: interview/);
  } finally { await closeAll(() => chrome && closeChrome(chrome), () => new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); })); }
});
