// API del teleprompter con la app de verdad (sin red de plataformas) y clases de cliente SSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-tp-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || r.status), { status: r.status }); return d;
  };
  return { app, base, call, close: () => new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

/** Abre un SSE y devuelve los eventos que llegan en la ventana dada. */
function openSse(base, client, ms = 700) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const events = [];
    fetch(`${base}/api/stream?client=${client}`, { signal: ctrl.signal }).then(async res => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const t = setTimeout(() => { ctrl.abort(); resolve(events); }, ms);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (ev) events.push({ event: ev, data: data || '' });
          }
        }
      } catch { /* abort al cerrar */ }
      clearTimeout(t); ctrl.abort(); resolve(events);
    }).catch(reject);
  });
}

test('teleprompter: guion, control, Stream Deck, widget y estado en /api/state', async () => {
  const { base, call, close } = await start();
  try {
    const st = await call('GET', '/api/state');
    assert.equal(st.teleprompter.activeId, 'ejemplo');
    const c = await call('POST', '/api/teleprompter/scripts', { title: 'Directo', blocks: [{ title: 'A', text: 'uno dos [nota] tres' }, { title: 'B', text: 'cuatro' }] });
    assert.equal(c.script.title, 'Directo');
    assert.equal(c.activeId, c.script.id);
    assert.equal((await call('POST', '/api/teleprompter/control', { action: 'next' })).playback.position, 3);
    assert.equal((await call('POST', '/sd/teleprompter-inicio')).position, 0);
    assert.equal((await call('POST', '/sd/teleprompter-siguiente')).position, 3);
    const s = await call('PUT', '/api/teleprompter/settings', { wpm: 150, mirror: true });
    assert.equal(s.settings.wpm, 150);
    assert.equal((await call('GET', '/api/config')).teleprompter.mirror, true);
    await assert.rejects(call('POST', '/api/teleprompter/control', { action: 'saltar' }), /Acción desconocida/);
    const html = await fetch(base + '/widget/teleprompter').then(r => r.text());
    assert.match(html, /teleprompter/);
    const sources = await call('GET', '/api/sources');
    assert.ok(sources.panels.some(p => p.id === 'teleprompter'));
    const sd = await call('GET', '/api/shortcuts');
    assert.ok(sd.actions.includes('teleprompter'));
    await call('DELETE', `/api/teleprompter/scripts/${c.script.id}`);
    assert.equal((await call('GET', '/api/teleprompter')).activeId, 'ejemplo');
  } finally { await close(); }
});

// ---------- correcciones de revisión (#143): kinds de cliente SSE y errores 400 ----------

test('un cliente widget que no es el teleprompter nunca recibe el texto del guion', async () => {
  const { base, call, close } = await start();
  try {
    const chatSse = openSse(base, 'widget', 900);
    await new Promise(r => setTimeout(r, 150));   // deja que el SSE conecte primero
    await call('POST', '/api/teleprompter/scripts', { title: 'Secreto', blocks: [{ title: 'A', text: 'marca-de-agua-unica-8f2c' }] });
    const events = await chatSse;
    const tp = events.filter(e => e.event === 'teleprompter');
    assert.deepEqual(tp, [], 'ningún evento teleprompter para un widget genérico');
    assert.ok(!events.some(e => e.data.includes('marca-de-agua-unica-8f2c')), 'el texto del guion no se filtra por otro canal');
  } finally { await close(); }
});

test('el cliente teleprompter (y el panel) sí reciben el guion', async () => {
  const { base, call, close } = await start();
  try {
    const tpSse = openSse(base, 'teleprompter', 900);
    await new Promise(r => setTimeout(r, 150));
    await call('POST', '/api/teleprompter/scripts', { title: 'Visible', blocks: [{ title: 'A', text: 'texto-para-el-prompter-3d1a' }] });
    const events = await tpSse;
    assert.ok(events.some(e => e.event === 'teleprompter' && e.data.includes('texto-para-el-prompter-3d1a')), 'llega el snapshot del teleprompter con su texto');
  } finally { await close(); }
});

test('id de guion no decodificable (decodeURIComponent roto) responde 400', async () => {
  const { base, call, close } = await start();
  try {
    for (const method of ['PUT', 'DELETE']) {
      const r = await fetch(base + '/api/teleprompter/scripts/%zz', { method, body: method === 'PUT' ? JSON.stringify({ title: 'x' }) : undefined });
      assert.equal(r.status, 400, method);
    }
  } finally { await close(); }
});
