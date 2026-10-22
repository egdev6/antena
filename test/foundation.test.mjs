import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

// Prueba acotada: el servidor sirve los artefactos de EGDEV Foundation en /ds/
// con el content-type correcto. Sin red real: la app escucha en 127.0.0.1 y se
// apaga y limpia siempre al terminar.
async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-foundation-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = async () => {
    await new Promise(r => { app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  };
  return { base, close };
}

test('sirve los tokens y el bundle de EGDEV Foundation como CSS', async () => {
  const { base, close } = await start();
  try {
    const tokens = await fetch(base + '/ds/tokens.css');
    assert.equal(tokens.status, 200);
    assert.match(tokens.headers.get('content-type'), /^text\/css\b/);
    const tokensBody = await tokens.text();
    assert.match(tokensBody, /EGDEV Foundation/);
    assert.match(tokensBody, /--color-primitive-red-neon:#FF0036/);

    const bundle = await fetch(base + '/ds/bundle.css');
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type'), /^text\/css\b/);
    const bundleBody = await bundle.text();
    assert.match(bundleBody, /EGDEV Foundation/);
    assert.match(bundleBody, /\.eg-menu__item/);
    assert.match(bundleBody, /\.eg-status-dot/);
  } finally {
    await close();
  }
});
