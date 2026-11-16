import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-neutral-texts-'));
  const app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

test('source audio guidance is neutral while the Meld chat dock stays specific', async t => {
  const api = await fixture(t);
  const result = await api('GET', '/api/sources');
  assert.equal(result.status, 200);
  const overlay = result.body.sources.find(source => source.id === 'overlay');
  assert.equal(overlay.note, 'Configura el audio de la fuente de navegador para oír sonidos y voz.');
  assert.deepEqual([overlay.width, overlay.height], [1920, 1080]);
  const dock = result.body.panels.find(panel => panel.id === 'dock');
  assert.equal(dock.name, 'Dock para Meld');
  assert.equal(dock.note, 'Pégalo en Meld › File › Preferences › User Interface › panel de chat.');
});

test('a disconnected program blocks the scheduled message without changing its counters', async t => {
  const api = await fixture(t);
  const created = await api('POST', '/api/timers', { name: 'Aviso', message: 'Hola', intervalMin: 1, minChatLines: 0, onlyWhenLive: true });
  assert.equal(created.status, 200);
  const id = created.body.timer.id;
  const before = (await api('GET', '/api/timers')).body.find(timer => timer.id === id);
  const result = await api('POST', `/api/timers/${id}/fire`, {});
  assert.deepEqual(result, { status: 409, body: { error: 'No se envía «Aviso»: El programa de emisión no está conectado: no se sabe si estás emitiendo.' } });
  const after = (await api('GET', '/api/timers')).body.find(timer => timer.id === id);
  assert.deepEqual([after.runtime.runs, after.runtime.lines, after.runtime.lastRunAt], [before.runtime.runs, before.runtime.lines, before.runtime.lastRunAt]);
});
