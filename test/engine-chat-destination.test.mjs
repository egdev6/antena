// MVP-BOT-01 (#44), T3b: destino y resultado por plataforma de las acciones de chat de alertas
// y comandos (S1, S2, S6, S7, S11). Proveedores falsos: sin red externa ni cuentas reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(t, { youtubeError } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-chat-dest-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  const sent = [], ytSent = [], results = [], failures = [];
  app.twitch.sendChat = async text => { sent.push(text); return { is_sent: true }; };
  app.youtube.sendChat = async text => {
    if (youtubeError) throw new Error(youtubeError);
    ytSent.push(text); return { id: 'yt1', sent: true };
  };
  app.engine.on('chatResult', r => results.push(r));
  app.engine.on('actionError', e => failures.push(e));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const raw = (method, p, body) => fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (method, p, body) => {
    const r = await raw(method, p, body);
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  t.after(async () => {
    await new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  // Sin overlay las acciones se ejecutan ya; el drenaje espera a que terminen (y recoge sus fallos).
  const settle = () => app.engine.drainActions().catch(e => e);
  const followWith = async action => {
    await call('PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: '{user}', ...action }] });
    await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'ana' } });
    return settle();
  };
  return { app, sent, ytSent, results, failures, raw, call, settle, followWith };
}

// ---------- S1 · destino ----------

test('S1 regresión: una acción de chat sin destino sigue enviando solo a Twitch', async t => {
  const { sent, ytSent, followWith } = await start(t);
  await followWith({ text: 'Gracias {user}' });
  assert.deepEqual(sent, ['Gracias ana']);
  assert.deepEqual(ytSent, []);
});

test('S1: una acción de chat con destino YouTube envía solo por YouTube', async t => {
  const { sent, ytSent, followWith } = await start(t);
  await followWith({ text: 'Gracias {user}', destination: 'youtube' });
  assert.deepEqual(ytSent, ['Gracias ana']);
  assert.deepEqual(sent, []);
});

test('S1: un destino desconocido se rechaza con 400 en todo lugar donde se guardan acciones', async t => {
  const { app, raw, call } = await start(t);
  const bad = [{ kind: 'chat', text: 'x', destination: 'tiktok' }];
  const { variation } = await call('POST', '/api/alerts/follow/variations', { name: 'v' });
  const { command } = await call('POST', '/api/commands', { trigger: '!ok' });
  const attempts = [
    ['PUT', '/api/alerts/follow', { actions: bad }],
    ['PUT', '/api/alerts/follow', { variations: [{ ...variation, overrides: { actions: bad } }] }],
    ['POST', '/api/alerts/follow/variations', { overrides: { actions: bad } }],
    ['PUT', `/api/alerts/follow/variations/${variation.id}`, { overrides: { actions: bad } }],
    ['POST', '/api/commands', { trigger: '!nuevo', actions: bad }],
    ['PUT', `/api/commands/${command.id}`, { actions: bad }],
    ['POST', '/api/timers', { message: 'Hola', actions: bad }],
    ['POST', '/api/actions/run', { actions: bad }],
  ];
  for (const [method, p, body] of attempts) {
    const r = await raw(method, p, body);
    assert.equal(r.status, 400, `${method} ${p}`);
    assert.match((await r.json()).error, /twitch, youtube o both/);
  }
  const cfg = app.store.config;
  assert.deepEqual(cfg.alerts.follow.actions, [], 'nada se guarda');
  assert.equal(cfg.alerts.follow.variations.length, 1);
  assert.equal(cfg.alerts.follow.variations[0].overrides.actions, undefined);
  assert.equal(cfg.commands.length, 1);
  assert.equal(cfg.commands[0].actions.length, 0);
  assert.equal((cfg.timers || []).length, 0);
  // los destinos válidos se guardan tal cual
  await call('PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: 'x', destination: 'both' }] });
  assert.equal(cfg.alerts.follow.actions[0].destination, 'both');
});

// ---------- S2 · S7 · resultado por plataforma y plataforma no disponible ----------

test('S2/S7: con «ambos», YouTube no disponible es un fallo parcial visible y Twitch no se reenvía', async t => {
  const { sent, ytSent, results, failures, followWith } = await start(t, { youtubeError: 'YouTube sin directo' });
  await followWith({ text: 'Gracias {user}', destination: 'both' });
  assert.deepEqual(sent, ['Gracias ana'], 'Twitch recibe una sola vez');
  assert.deepEqual(ytSent, []);
  assert.equal(results.length, 1);
  const { ok, platforms } = results[0];
  assert.equal(ok, false, 'un fallo parcial nunca es un éxito completo');
  assert.deepEqual(platforms.twitch, { ok: true, kind: 'message', result: { is_sent: true } });
  assert.deepEqual(platforms.youtube, { ok: false, kind: 'message', error: 'YouTube sin directo' });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error, 'YouTube: YouTube sin directo');
  assert.deepEqual(failures[0].platforms, platforms);
});

test('S2: con «ambos» y los dos proveedores bien, el resultado es un éxito por plataforma', async t => {
  const { sent, ytSent, results, failures, followWith } = await start(t);
  await followWith({ text: 'Hola', destination: 'both' });
  assert.deepEqual(sent, ['Hola']);
  assert.deepEqual(ytSent, ['Hola']);
  assert.equal(results[0].ok, true);
  assert.deepEqual(Object.keys(results[0].platforms), ['twitch', 'youtube']);
  assert.deepEqual(failures, []);
});

// ---------- S6 · límites del texto final ----------

test('S6: el texto final que supera el límite de YouTube no se envía ahí ni se corta', async t => {
  const { sent, ytSent, results, failures, followWith } = await start(t);
  const long = 'a'.repeat(250);
  await followWith({ text: `${long}{user}`, destination: 'both' });
  assert.deepEqual(sent, [long + 'ana'], 'Twitch recibe el texto entero');
  assert.deepEqual(ytSent, []);
  assert.equal(results.length, 1);
  assert.equal(results[0].platforms.youtube.ok, false);
  assert.match(results[0].platforms.youtube.error, /no cabe \(253\/200/);
  assert.match(failures[0].error, /^YouTube: el texto no cabe/);
});

test('S6: más de 500 caracteres no salen por Twitch y el fallo lleva el motivo', async t => {
  const { sent, results, failures, followWith } = await start(t);
  await followWith({ text: 'b'.repeat(501) });
  assert.deepEqual(sent, []);
  assert.equal(results[0].ok, false);
  assert.match(failures[0].error, /^el texto no cabe \(501\/500/);
});

// ---------- S11 · comandos ----------

test('S11: un comando con acción de chat sigue la misma política por plataforma', async t => {
  const { sent, ytSent, results, call, settle } = await start(t, { youtubeError: 'YouTube sin directo' });
  await call('POST', '/api/commands', { trigger: '!web', actions: [{ kind: 'chat', text: 'egdev.es para {user}', destination: 'both' }] });
  await call('POST', '/api/chat/simulate', { user: 'luis', text: '!web' });
  await settle();
  assert.deepEqual(sent, ['egdev.es para luis']);
  assert.deepEqual(ytSent, []);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].platforms.youtube.error, 'YouTube sin directo');
});

// ---------- pausa: sin cambios ----------

test('regresión: en pausa la acción de chat espera y sale a ambas plataformas al reanudar', async t => {
  const { sent, ytSent, call, settle } = await start(t);
  await call('PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: 'Hola {user}', destination: 'both' }] });
  await call('POST', '/api/pause');
  await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'ana' } });
  await settle();
  assert.deepEqual([sent, ytSent], [[], []], 'retenida mientras dura la pausa');
  await call('POST', '/api/resume');
  await settle();
  assert.deepEqual([sent, ytSent], [['Hola ana'], ['Hola ana']]);
});

// ---------- S2 · S12 · el panel recibe el resultado de una acción de chat que falla ----------

// Lee eventos SSE del canal del panel hasta encontrar `name` y devuelve los que llegaron.
async function panelEvents(base, t) {
  const ctrl = new AbortController(); t.after(() => ctrl.abort());
  const res = await fetch(base + '/api/stream?client=panel', { signal: ctrl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder(), seen = [];
  let buf = '';
  return async name => {
    const deadline = setTimeout(() => ctrl.abort(), 3000); // sin el evento, falla en vez de colgarse
    try { return await read(name); } finally { clearTimeout(deadline); }
  };
  async function read(name) {
    for (;;) {
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev) seen.push({ ev, data: JSON.parse(data) });
        if (ev === name) return seen;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE cerrado sin ' + name);
      buf += dec.decode(value, { stream: true });
    }
  }
}

test('S2/S12: el panel recibe el fallo parcial de una acción de alerta con su origen y detalle por plataforma', async t => {
  let ytFail = false;
  const { app, results, call, settle } = await start(t);
  app.youtube.sendChat = async () => { if (ytFail) throw new Error('YouTube sin directo'); return { id: 'yt', sent: true }; };
  const next = await panelEvents(`http://127.0.0.1:${app.server.address().port}`, t);
  await call('PUT', '/api/alerts/follow', { actions: [{ kind: 'chat', text: 'Gracias {user}', destination: 'both' }] });
  await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'ana' } });
  await settle();
  ytFail = true;
  await call('POST', '/api/simulate', { type: 'follow', vars: { user: 'eva' } });
  await settle();
  const seen = (await next('chatResult')).filter(e => e.ev === 'chatResult');
  assert.equal(seen.length, 1, 'el éxito no se reenvía al panel');
  const r = seen[0].data;
  assert.equal(r.ok, false);
  assert.deepEqual(r.origin, { kind: 'alert', type: 'follow', id: results[1].origin.id });
  assert.equal(results[0].origin.type, 'follow', 'el evento del engine también lleva el origen');
  assert.equal(r.platforms.twitch.ok, true);
  assert.deepEqual(r.platforms.youtube, { ok: false, kind: 'message', error: 'YouTube sin directo' });
});

test('S11/S12: el fallo de una acción de comando llega al panel con el disparador del comando', async t => {
  const { app, call, settle } = await start(t, { youtubeError: 'YouTube sin directo' });
  const next = await panelEvents(`http://127.0.0.1:${app.server.address().port}`, t);
  const { command } = await call('POST', '/api/commands', { trigger: '!web', actions: [{ kind: 'chat', text: 'web', destination: 'youtube' }] });
  await call('POST', '/api/chat/simulate', { user: 'luis', text: '!web' });
  await settle();
  const r = (await next('chatResult')).find(e => e.ev === 'chatResult').data;
  assert.equal(r.ok, false);
  assert.equal(r.origin.kind, 'command');
  assert.equal(r.origin.commandId, command.id);
  assert.equal(r.origin.trigger, '!web');
  assert.equal(r.platforms.youtube.error, 'YouTube sin directo');
});
