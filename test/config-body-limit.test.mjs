import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.mjs';

// The larger import limit must not change how existing routes treat an oversized body.
test('an oversized PUT /api/config still resets the connection; import routes answer 413', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-body-limit-'));
  const app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.meld.stop(); app.program.dispose(); await app.closeHttp(); await rm(dir, { recursive: true, force: true }); });
  const port = app.server.address().port;
  const send = (method, url, size) => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-type': 'application/json' } }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', error => resolve({ error: error.code }));
    req.end(JSON.stringify({ pad: 'x'.repeat(size) }));
  });
  const put = await send('PUT', '/api/config', 3e6);
  assert.ok(put.error === 'ECONNRESET' || put.error === 'EPIPE', `expected a reset, got ${JSON.stringify(put).slice(0, 120)}`);
  const imp = await send('POST', '/api/config/import/preview', 8.1e6);
  assert.equal(imp.status, 413);
  assert.deepEqual(JSON.parse(imp.body), { error: 'El cuerpo de la petición es demasiado grande' });
});
