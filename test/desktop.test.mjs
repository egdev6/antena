import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(opts = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-desk-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
  };
  return { app, base, call, close: () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('fuentes de Meld: cada capa con URL y tamaño, un objetivo por cada objetivo configurado', async () => {
  const { call, base, close } = await start();
  try {
    const s = await call('GET', '/api/sources');
    assert.equal(s.base, base);
    const ids = s.sources.map(x => x.id);
    for (const id of ['overlay', 'chat', 'goal-principal', 'latest', 'ticker', 'credits', 'question', 'tierlist', 'giveaway']) assert.ok(ids.includes(id), id);
    const ov = s.sources.find(x => x.id === 'overlay');
    assert.deepEqual([ov.url, ov.width, ov.height], [base + '/overlay', 1920, 1080]);
    assert.deepEqual(s.panels.map(p => p.id), ['dock', 'prompter', 'teleprompter']);
    // las URL responden
    for (const x of s.sources) assert.equal((await fetch(x.url)).status, 200, x.url);
  } finally { await close(); }
});

test('atajos personalizados: crear, lanzar por API y por Stream Deck, validar y borrar', async () => {
  const { app, call, base, close } = await start();
  try {
    const said = [];
    app.engine.say = t => { said.push(t); return { ok: true }; };
    const { shortcut } = await call('POST', '/api/shortcuts', { name: 'Momento top', steps: [{ kind: 'builtin', action: 'marca' }, { kind: 'builtin', action: 'prompter', arg: 'cronologia' }, { kind: 'say', text: 'guardado' }] });
    assert.equal(shortcut.steps.length, 3);
    const r = await call('POST', `/api/shortcuts/${shortcut.id}/run`);
    assert.equal(r.ok, true);
    assert.equal((await call('GET', '/api/timeline?kinds=marker')).items.length, 1);
    assert.deepEqual(said, ['guardado']);
    // Stream Deck (GET) por id y por nombre
    assert.equal((await fetch(`${base}/sd/custom/${shortcut.id}`)).status, 200);
    assert.equal((await fetch(`${base}/sd/custom/${encodeURIComponent('momento top')}`)).status, 200);
    assert.equal((await call('GET', '/api/timeline?kinds=marker')).items.length, 3);
    // aparece en la lista con su ruta
    const list = await call('GET', '/api/shortcuts');
    assert.equal(list.custom[0].path, `/sd/custom/${shortcut.id}`);
    assert.ok(list.builtins.includes('sortear'));
    // validación
    await assert.rejects(call('POST', '/api/shortcuts', { name: 'x', steps: [{ kind: 'builtin', action: 'nada' }] }), /Acción desconocida/);
    await assert.rejects(call('POST', '/api/shortcuts', { name: 'x', steps: [{ kind: 'rm' }] }), /Tipo de paso desconocido/);
    await assert.rejects(call('POST', '/api/shortcuts', { name: 'x', steps: [{ kind: 'chat', text: 'a', destination: 'kick' }] }), /Destino/);
    await assert.rejects(call('POST', '/api/shortcuts', { name: '', steps: [] }), /nombre/);
    // editar y borrar
    await call('PUT', `/api/shortcuts/${shortcut.id}`, { name: 'Clip', steps: [{ kind: 'builtin', action: 'saltar' }] });
    assert.equal((await call('GET', '/api/shortcuts')).custom[0].name, 'Clip');
    await call('DELETE', `/api/shortcuts/${shortcut.id}`);
    assert.equal((await call('GET', '/api/shortcuts')).custom.length, 0);
    assert.equal((await fetch(`${base}/sd/custom/${shortcut.id}`)).status, 404);
  } finally { await close(); }
});

test('interfaz: la app React si está compilada; /legacy retirada (#115)', async () => {
  const { base, close } = await start();
  try {
    assert.equal((await fetch(base + '/legacy')).status, 404);
    assert.equal((await fetch(base + '/legacy/prompter')).status, 404);
    const home = await (await fetch(base + '/')).text();
    if (existsSync(new URL('../app/dist/index.html', import.meta.url))) assert.match(home, /\/assets\//);
    else {
      // sin app/dist: página mínima que explica cómo compilar, sin JS
      assert.match(home, /pnpm app:build/);
      assert.doesNotMatch(home, /<script/i);
      for (const p of ['/prompter', '/dock']) {
        const r = await (await fetch(base + p)).text();
        assert.match(r, /pnpm app:build/);
      }
    }
  } finally { await close(); }
});

test('apagado por API: solo si el proceso lo permite', async () => {
  const { app, call, close } = await start();
  try {
    await assert.rejects(call('POST', '/api/shutdown'), /no se puede apagar/);
    let asked = 0;
    app.requestShutdown = () => { asked++; };
    assert.equal((await call('POST', '/api/shutdown')).ok, true);
    await new Promise(r => setTimeout(r, 120));
    assert.equal(asked, 1);
  } finally { await close(); }
});

test('app React compilada: panel, prompter y dock con sus assets', { skip: !existsSync(new URL('../app/dist/index.html', import.meta.url)) && 'sin app/dist (pnpm app:build)' }, async () => {
  const { base, close } = await start({ ui: 'app' });
  try {
    for (const p of ['/', '/prompter', '/dock']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      const html = await r.text();
      assert.match(html, /<div id="root"><\/div>/, p);
      for (const a of html.matchAll(/\/assets\/[\w.-]+\.(?:js|css)/g)) assert.equal((await fetch(base + a[0])).status, 200, a[0]);
    }
    assert.equal((await fetch(base + '/assets/../src/server.mjs')).status === 200, false);
  } finally { await close(); }
});
