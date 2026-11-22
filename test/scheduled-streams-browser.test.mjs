// The browser talks to a loopback calendar fake; no external service is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const TOKEN = 'SYNTHETIC_BROWSER_CALENDAR_310';
const button = text => `[...document.querySelectorAll('#schedule-calendar button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
test('Programación tab saves and masks the credential, tests the calendar and gates the switch', { timeout: 60000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return;
  const root = await mkdtemp(path.join(tmpdir(), 'ant-schedule-browser-'));
  const requests = [];
  const calendar = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ eventId: 'event-310', criterioEventId: null, youtube: { broadcastId: 'AbCdEfGhI12', url: null },
      title: 'Prueba programada', scheduledStart: '2026-01-01T12:00:00.000Z', durationMin: 60, state: 'scheduled',
      twitch: { title: null, category: null, categoryId: null } }));
  });
  let app, page;
  t.after(() => closeAll(() => page && closeChrome(page), async () => {
    if (!app) return;
    app.viewers.halt(); await app.youtube.quiescePoll(); await app.drainAutoSession(); await app.drainChatMetrics();
    await app.session.flush(); app.program.stop(); app.program.dispose(); await app.closeHttp();
  }, async () => { calendar.closeAllConnections(); await new Promise(resolve => calendar.close(resolve)); },
  () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  await new Promise(resolve => calendar.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const setup = await fetch(base + '/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ panel: { onboardingDone: true } }) });
  assert.equal(setup.status, 200);
  page = await openChromePage(bin, `${base}/#/conexiones/programacion`);
  const dom = expr => evaluateChrome(page.cdp, expr, { timeoutMs: 8000 });
  const wait = expr => waitDom(page.cdp, expr, { timeoutMs: 6000 });
  await wait(`!!document.querySelector('#schedule-calendar')`);
  assert.deepEqual(JSON.parse(await dom(`JSON.stringify([...document.querySelectorAll('main [role=tab]')].map(x => x.textContent.trim()))`)), ['Cuentas', 'Webhooks', 'Programación']);
  assert.equal(await dom('location.hash'), '#/conexiones/programacion');
  const field = `document.querySelector('#schedule-calendar input[type=password]')`;
  const url = `document.querySelector('#schedule-calendar input:not([type=password]):not([type=checkbox])')`;
  const toggle = `document.querySelector('#schedule-calendar input[type=checkbox]')`;
  assert.equal(await dom(`${toggle}.disabled`), true);
  assert.equal(await dom(`${toggle}.checked`), false);
  const set = (selector, value) => dom(`(() => { const e = ${selector}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await set(url, `http://127.0.0.1:${calendar.address().port}`); await set(field, TOKEN);
  await clickWhen(page.cdp, button('Guardar'));
  await wait(`document.querySelector('#schedule-calendar').textContent.includes('Credencial guardada')`);
  assert.equal(await dom(`${field}.value`), ''); assert.match(await dom(`${field}.placeholder`), /•/);
  assert.equal(await dom(`document.documentElement.outerHTML.includes(${JSON.stringify(TOKEN)})`), false);
  assert.equal(await dom(`${toggle}.disabled`), false);
  await clickWhen(page.cdp, button('Probar'));
  await wait(`document.querySelector('#schedule-calendar [role=status]')?.textContent.includes('Evento: Prueba programada')`);
  assert.equal(requests.length, 1); assert.equal(requests[0].authorization, `Bearer ${TOKEN}`);
  assert.match(requests[0].url, /^\/api\/v1\/live-events\/current\?at=\d+$/);
  await clickWhen(page.cdp, toggle); await wait(`${toggle}.checked`);
  assert.equal((await (await fetch(base + '/api/config')).json()).scheduleCalendar.enabled, true);
});
