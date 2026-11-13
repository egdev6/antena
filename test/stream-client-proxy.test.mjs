import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';

test('a proxy that never finishes the initial WebSocket upgrade falls back to SSE', { timeout: 20000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-stream-proxy-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const streams = [];
  const proxy = http.createServer((req, res) => {
    if (req.url.startsWith('/api/stream')) streams.push(req.headers.upgrade ? 'upgrade' : 'sse');
    const up = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } }, upstream => {
      res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let chrome;
  try {
    chrome = await openChromePage(bin, `http://127.0.0.1:${proxy.address().port}/probe.html`);
    try {
      await waitDom(chrome.cdp, `document.querySelector('#list')?.textContent.includes('conectado (SSE)')`, { timeoutMs: 5000 });
    } catch (error) { error.message += `; stream requests: ${JSON.stringify(streams)}`; throw error; }
    assert.ok(streams.includes('sse'));
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => proxy.closeAllConnections(), () => app.closeHttp(),
      () => new Promise(resolve => proxy.close(resolve)), () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
});
