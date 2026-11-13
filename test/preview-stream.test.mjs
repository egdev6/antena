import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

async function withProxy(t, run) {
  const bin = await skipIfNoBrowserOrUi(t);
  if (!bin) return;
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-preview-stream-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port, requests = [], pending = new Set();
  const proxy = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    requests.push(`${req.method} ${pathname}`);
    const pass = () => {
      const up = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } }, upstream => {
        res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => up.destroy());
      req.pipe(up);
    };
    if (pathname === '/stream-client.js') {
      const timer = setTimeout(() => { pending.delete(timer); pass(); }, 1800);
      pending.add(timer);
    } else pass();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let chrome;
  try {
    const base = `http://127.0.0.1:${proxy.address().port}`;
    chrome = await openChromePage(bin, base + '/probe.html');
    await waitDom(chrome.cdp, `!!document.querySelector('#list')`);
    await run(chrome.cdp, requests, base);
  } finally {
    for (const timer of pending) clearTimeout(timer);
    await closeAll(() => chrome && closeChrome(chrome), () => proxy.closeAllConnections(), () => app.closeHttp(),
      () => new Promise(resolve => proxy.close(resolve)), () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  }
}

test('preview sample waits for the initial stream to be ready, including SSE fallback', { timeout: 40000 }, t => withProxy(t, async (c, requests) => {
  await evaluateChrome(c, `(() => {
    const frame = document.createElement('iframe');
    frame.src = '/overlay?preview&mute';
    frame.onload = async () => {
      await frame.contentWindow.antenaPreviewReady;
      window.__samplePosts = (window.__samplePosts || 0) + 1;
      await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'follow', target: 'preview' }) });
    };
    document.body.append(frame);
    return true;
  })()`);
  await waitDom(c, `(() => { const d = document.querySelector('iframe')?.contentDocument; return !!d && !d.getElementById('hint') && !!d.querySelector('.alert.type-follow'); })()`, { timeoutMs: 8000 });
  assert.equal(await evaluateChrome(c, 'window.__samplePosts'), 1);
  assert.equal(requests.filter(req => req === 'POST /api/test').length, 1);
}));

test('Apariencia renders the sample with a delayed module and an HTTP-only proxy', { timeout: 40000 }, t => withProxy(t, async (c, _requests, base) => {
  await c.send('Page.navigate', { url: base + '/#/apariencia' });
  await waitDom(c, `!!document.querySelector('.ap-preview .preview iframe[src*="/overlay?preview"]')`, { timeoutMs: 12000 });
  await waitDom(c, `(() => { const d = document.querySelector('.ap-preview .preview iframe')?.contentDocument; return !!d && !d.getElementById('hint') && !!d.querySelector('.alert.type-follow'); })()`, { timeoutMs: 8000 });
}));
