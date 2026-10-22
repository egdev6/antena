// #115 · retirada del panel clásico: prueba diferencial de rutas con y sin app/dist.
// /legacy y /legacy/prompter desaparecen (404); sin app/dist, /, /prompter y /dock responden
// una página estática mínima que explica cómo compilar la interfaz (sin JS).
// /overlay, /probe y /widget/* siguen igual en ambos escenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const APP_DIST = new URL('../app/dist/', import.meta.url);
const conAppDist = existsSync(new URL('index.html', APP_DIST));

async function start({ appDist } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-115-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {}, appDist });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const close = () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
  return { app, base, close };
}

const get = async (base, p) => {
  const res = await fetch(base + p);
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', text };
};

for (const con of [false, true]) {
  test(`rutas tras retirar el clásico (app/dist ${con ? 'presente' : 'ausente'})`, { timeout: 60000 }, async t => {
    // el escenario «ausente» es determinista: un appDist vacío inyectado en createApp
    const opts = con ? {} : { appDist: mkdtempSync(path.join(tmpdir(), 'egdev-115-nodist-')) };
    if (con && !conAppDist) return t.skip('sin app/dist/index.html; compila la interfaz con pnpm app:build para el escenario con interfaz');
    const { base, close } = await start(opts);
    t.after(close);
    // El clásico ya no existe.
    for (const p of ['/legacy', '/legacy/prompter', '/legacy/']) {
      const r = await get(base, p);
      assert.equal(r.status, 404, p);
    }
    // El panel clásico no queda servible por su nombre de fichero.
    for (const p of ['/panel.html', '/panel.js', '/panel.css', '/prompter.html']) {
      const r = await get(base, p);
      assert.equal(r.status, 404, p);
    }
    // Overlays y widgets intactos en ambos escenarios.
    assert.equal((await get(base, '/overlay')).status, 200);
    assert.equal((await get(base, '/probe')).status, 200);
    const w = await get(base, '/widget/chat');
    assert.equal(w.status, 200);
    assert.match(w.type, /text\/html/);
    // Raíz, prompter y dock: interfaz React si está compilada; si no, página mínima sin JS.
    for (const p of ['/', '/prompter', '/dock']) {
      const r = await get(base, p);
      assert.equal(r.status, 200, p);
      assert.match(r.type, /text\/html/, p);
      if (con) {
        assert.match(r.text, /src="\/assets\//, `${p} sirve la interfaz React`);
      } else {
        assert.match(r.text, /pnpm app:build/, `${p} explica cómo compilar la interfaz`);
        assert.doesNotMatch(r.text, /<script/i, `${p} mínima sin JS`);
        assert.doesNotMatch(r.text, /panel\.js|panel\.html/, `${p} ya no apunta al clásico`);
      }
    }
    // La página mínima es el fichero estático servido, sin filtrarse de la app.
    if (!con) {
      const page = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
      assert.match(page, /pnpm app:build/);
      assert.doesNotMatch(page, /<script/i);
    }
  });
}
