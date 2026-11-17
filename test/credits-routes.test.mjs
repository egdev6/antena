import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

test('credits play and stop return success and reach widget clients in order', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-credits-routes-'));
  const abort = new AbortController();
  let app;
  t.after(async () => {
    abort.abort();
    if (app) await app.closeHttp();
    await rm(root, { recursive: true, force: true });
  });
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const stream = await fetch(`${base}/api/stream?client=widget`, { signal: abort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();

  for (const action of ['play', 'stop']) {
    const response = await fetch(`${base}/api/credits/${action}`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"ok":true}');
  }
  let text = '';
  const decoder = new TextDecoder();
  while ((text.match(/event: credits\ndata: [^\n]*\n\n/g) || []).length < 2) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.deepEqual([...text.matchAll(/event: credits\ndata: ([^\n]*)\n\n/g)].map(match => JSON.parse(match[1])), [
    { action: 'play' }, { action: 'stop' },
  ]);
});
