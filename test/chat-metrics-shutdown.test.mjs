// #102: cierre real del proceso con IO YouTube y contabilidad todavía pendientes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('el cierre drena el mensaje aceptado después del corte de identidad y antes del checkpoint', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-chat-metrics-close-'));
  const source = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { createServer } from 'node:net';
    import path from 'node:path';
    import { createApp, startServer } from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};
    const dir = process.env.ANTENA_DATA;
    await mkdir(dir, { recursive: true });
    await mkdir(process.env.ANTENA_MEDIA, { recursive: true });
    const reserve = createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ port, access: { lan: false },
      meld: { enabled: false, autoSession: true }, chat: { twitchChannel: '' }, viewers: { enabled: false } }));
    let outsideRequests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname !== '127.0.0.1') { outsideRequests++; return Promise.reject(new Error('Sin red externa en el test')); }
      return originalFetch(input, ...args);
    };
    globalThis.WebSocket = class { constructor() { outsideRequests++; throw new Error('Sin plataformas reales en el test'); } };
    const app = await startServer({ quiet: true, log: () => {}, handleSignals: false, shutdownTimeoutMs: 10000 });
    app.viewers.halt();
    app.youtube.start = async () => {};
    app.meld.setStatus({ state: 'conectado', streaming: true });
    await app.session.transitionChain;
    app.youtube.setStatus({ state: 'escuchando', videoId: 'video-1', liveChatId: 'chat-1' });
    await app.session.transitionChain;
    let releasePoll, apiEntered, sealReached, releaseWrite;
    const response = new Promise(resolve => { releasePoll = resolve; });
    const entered = new Promise(resolve => { apiEntered = resolve; });
    const sealed = new Promise(resolve => { sealReached = resolve; });
    const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    const record = app.session.recordChat.bind(app.session);
    app.session.recordChat = (...args) => writeGate.then(() => record(...args));
    const begin = app.beginAutoSessionDrain;
    app.beginAutoSessionDrain = () => { begin(); sealReached(); };
    let accountingDrained = false;
    const drain = app.drainChatMetrics;
    app.drainChatMetrics = () => { accountingDrained = true; releaseWrite(); return drain(); };
    app.youtube.api = async url => { assert.equal(url, '/liveChat/messages'); apiEntered(); return response; };
    app.youtube.running = true; app.youtube.primed = true;
    const poll = app.youtube.poll();
    await entered;
    const close = app.close();
    await sealed;
    releasePoll({ items: [{ id: 'late', snippet: { type: 'textMessageEvent', displayMessage: 'mensaje sintético' },
      authorDetails: { channelId: 'late-author', displayName: 'Autor' } }] });
    const [, code] = await Promise.all([poll, close]);
    const reopened = await createApp({ dataDir: dir, mediaDir: process.env.ANTENA_MEDIA, log: () => {} });
    await new Promise(resolve => reopened.server.listen(0, '127.0.0.1', resolve));
    const responseJson = await fetch('http://127.0.0.1:' + reopened.server.address().port + '/api/session');
    assert.equal(responseJson.status, 200);
    const current = await responseJson.json();
    await reopened.drainAutoSession(); await reopened.drainChatMetrics();
    await reopened.session.flush(); await reopened.closeHttp();
    process.stdout.write(JSON.stringify({ code, accountingDrained, outsideRequests,
      messages: current.chatMetrics?.youtube?.messages, uniqueChatters: current.chatMetrics?.youtube?.uniqueChatters,
      privateState: current.chatStats !== undefined || JSON.stringify(current).includes('late-author') }));
  `;
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP'].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...env, TMPDIR: root, ANTENA_DATA: path.join(root, 'data'), ANTENA_MEDIA: path.join(root, 'media') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
    await rm(root, { recursive: true, force: true });
  });
  const [code] = await closed;
  assert.equal(code, 0, stderr + '\n' + stdout);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), { code: 0, accountingDrained: true, outsideRequests: 0,
    messages: 1, uniqueChatters: 1, privateState: false });
});
