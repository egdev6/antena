// The panel talks only to a synthetic Discord endpoint on loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/SYNTHETIC_BROWSER_TOKEN';
const button = text => `[...document.querySelectorAll('#discord button')].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(20); }
  assert.fail(`timeout: ${label}`);
}
async function fixture(t, responses = []) {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return null;
  const root = await mkdtemp(path.join(tmpdir(), 'antena-discord-browser-'));
  const requests = [], meld = fakeMeld();
  const receiver = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const response = responses.shift() ?? 200;
    if (response === 'disconnect') { req.socket.destroy(); return; }
    res.writeHead(response, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response === 200 ? { id: '987654321' } : { message: WEBHOOK }));
  });
  let app, page;
  t.after(() => closeAll(() => page && closeChrome(page), async () => {
    if (!app) return;
    app.viewers.halt(); await app.youtube.quiescePoll().catch(() => {});
    await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
    await app.session.flush().catch(() => {}); app.program.stop(); app.program.dispose();
    await app.closeHttp();
  }, async () => {
    receiver.closeAllConnections(); meld.server.closeAllConnections();
    await Promise.all([new Promise(resolve => receiver.close(resolve)), new Promise(resolve => meld.server.close(resolve))]);
  }, () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  await Promise.all([new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve)), new Promise(resolve => meld.server.listen(0, '127.0.0.1', resolve))]);
  const origin = `http://127.0.0.1:${receiver.address().port}`;
  const discordFetch = (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.origin, 'https://discord.com');
    return fetch(origin + parsed.pathname + parsed.search, options);
  };
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {}, discordFetch, discordRetryDelayMs: 20 });
  app.twitch.helix = async () => ({ ok: true, data: { data: [{ title: 'Prueba', id: 'tw-stream' }] } });
  app.twitch.setStatus({ user: 'synthetic_channel' });
  app.viewers.readers = { twitch: async () => ({ live: true, streamId: 'tw-stream', viewers: 1 }), youtube: async () => ({ live: false }) };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, endpoint, body) => {
    const res = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.status, 200); return res.json();
  };
  await api('PUT', '/api/config', { panel: { onboardingDone: true } });
  page = await openChromePage(bin, `${base}/#/conexiones/webhooks`);
  const dom = expr => evaluateChrome(page.cdp, expr, { timeoutMs: 8000 });
  const wait = expr => waitDom(page.cdp, expr, { timeoutMs: 6000 });
  await wait(`!!document.querySelector('#discord')`);
  const saveWebhook = async () => {
    await dom(`(() => { const e = document.querySelector('#discord input[type=password]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(WEBHOOK)}); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await clickWhen(page.cdp, button('Guardar webhook'));
    await wait(`document.querySelector('#discord').textContent.includes('Webhook guardado')`);
  };
  const goLive = async () => {
    await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meld.server.address().port}` });
    await until(async () => (await api('GET', '/api/status')).meld.state === 'conectado', 'program connection');
    const old = (await api('GET', '/api/session')).id;
    meld.setStreaming(true);
    await until(async () => (await api('GET', '/api/session')).id !== old, 'session');
    await app.viewers.tick();
  };
  return { page, dom, wait, api, saveWebhook, goLive, requests };
}

test('Conexiones groups Discord under a «Webhooks» tab, apart from the accounts', { timeout: 60000 }, async t => {
  const f = await fixture(t, []); if (!f) return;
  const tabs = `JSON.stringify([...document.querySelectorAll('main [role="tab"]')].map(b => b.textContent.trim()))`;
  await f.wait(`!!document.querySelector('#discord')`);
  assert.deepEqual(JSON.parse(await f.dom(tabs)), ['Cuentas', 'Webhooks']);
  assert.equal(await f.dom(`!!document.querySelector('#programa-emision')`), false, 'accounts are not on the Webhooks tab');
  await clickWhen(f.page.cdp, `[...document.querySelectorAll('main [role="tab"]')].find(b => b.textContent.trim() === 'Cuentas')`);
  await f.wait(`!!document.querySelector('#programa-emision') && !document.querySelector('#discord')`);
  assert.match(await f.dom('location.hash'), /^#\/conexiones\/cuentas$/);
  await clickWhen(f.page.cdp, `[...document.querySelectorAll('main [role="tab"]')].find(b => b.textContent.trim() === 'Webhooks')`);
  await f.wait(`!!document.querySelector('#discord') && !document.querySelector('#programa-emision')`);
  assert.match(await f.dom('location.hash'), /^#\/conexiones\/webhooks$/);
});

test('Discord card masks the saved webhook, enables the switch and reports sample success and failure', { timeout: 60000 }, async t => {
  const f = await fixture(t, [200, 401]); if (!f) return;
  const input = `document.querySelector('#discord input[type=password]')`;
  const toggle = `document.querySelector('#discord input[type=checkbox]')`;
  assert.equal(await f.dom(`${toggle}.disabled`), true);
  assert.equal(await f.dom(`${button('Probar')}.disabled`), true);
  await f.saveWebhook();
  assert.equal(await f.dom(`${input}.value`), '');
  assert.match(await f.dom(`${input}.placeholder`), /•/);
  assert.equal(await f.dom(`document.documentElement.outerHTML.includes(${JSON.stringify(WEBHOOK)})`), false);
  assert.equal(await f.dom(`${toggle}.disabled`), false);
  assert.equal(await f.dom(`${toggle}.checked`), false);
  await clickWhen(f.page.cdp, button('Probar'));
  await f.wait(`document.querySelector('#discord [role=status]')?.textContent.includes('Prueba enviada')`);
  assert.equal(f.requests.length, 1); assert.match(JSON.stringify(f.requests[0].body), /Prueba de antena/);
  await clickWhen(f.page.cdp, button('Probar'));
  await f.wait(`document.querySelector('#discord [role=status]')?.textContent.includes('No se pudo enviar')`);
  assert.equal(await f.dom(`document.documentElement.outerHTML.includes(${JSON.stringify(WEBHOOK)})`), false);
  await clickWhen(f.page.cdp, toggle);
  await f.wait(`${toggle}.checked`);
  assert.equal((await f.api('GET', '/api/config')).discord.enabled, true);
});

test('Discord card saves the platform emoji codes and rejects an invalid one without changing them', { timeout: 60000 }, async t => {
  const f = await fixture(t, []); if (!f) return;
  const field = p => `document.querySelector('#discord [data-discord-emoji="${p}"]')`;
  const type = (p, v) => f.dom(`(() => { const el = ${field(p)}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await f.wait(`!!${field('twitch')} && !!${field('youtube')}`);
  await type('twitch', '<:twitch:123456789012345678>'); await type('youtube', '<:youtube:223456789012345678>');
  await clickWhen(f.page.cdp, `document.querySelector('#discord [data-discord-emoji-save]')`);
  await f.wait(`document.querySelector('#discord [role=status]')?.textContent.includes('Iconos guardados')`);
  let config = (await f.api('GET', '/api/config')).discord;
  assert.equal(config.emojiTwitch, '<:twitch:123456789012345678>'); assert.equal(config.emojiYoutube, '<:youtube:223456789012345678>');
  await type('twitch', '@everyone');
  await clickWhen(f.page.cdp, `document.querySelector('#discord [data-discord-emoji-save]')`);
  await new Promise(r => setTimeout(r, 400));
  config = (await f.api('GET', '/api/config')).discord;
  assert.equal(config.emojiTwitch, '<:twitch:123456789012345678>', 'an invalid code does not replace the saved one');
});

test('unconfirmed publication offers explicit confirmation before manual recovery', { timeout: 60000 }, async t => {
  const f = await fixture(t, ['disconnect', 200]); if (!f) return;
  await f.saveWebhook();
  await clickWhen(f.page.cdp, `document.querySelector('#discord input[type=checkbox]')`);
  await f.wait(`document.querySelector('#discord input[type=checkbox]').checked`);
  await f.goLive();
  await f.wait(`document.querySelector('#discord').textContent.includes('sin confirmar') && !!${button('Volver a publicar')}`);
  await f.dom(`window.__confirmed = ''; window.confirm = message => { window.__confirmed = message; return false; }; true`);
  await clickWhen(f.page.cdp, button('Volver a publicar'));
  assert.match(await f.dom('window.__confirmed'), /podría haberse publicado/);
  assert.equal(f.requests.length, 1);
  await f.dom(`window.confirm = () => true`);
  await clickWhen(f.page.cdp, button('Volver a publicar'));
  await f.wait(`document.querySelector('#discord').textContent.includes('publicado') && !${button('Volver a publicar')}`);
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 2);
});
