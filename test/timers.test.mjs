import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-timers-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  // Twitch falso: guarda lo que se envía
  const sent = [];
  app.twitch.sendChat = async text => { sent.push({ kind: 'chat', text }); return { is_sent: true }; };
  app.twitch.sendAnnouncement = async (text, color) => { sent.push({ kind: 'announce', text, color }); return { announced: true }; };
  app.twitch.status.user = 'egdev6';
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  return { app, sent, call, close: () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('un mensaje programado sale cuando toca y hay movimiento en el chat', async () => {
  const { app, sent, call, close } = await start();
  try {
    const { timer } = await call('POST', '/api/timers', { name: 'Seguir', message: 'Sígueme en twitch.tv/{channel} · llevamos {uptime}', intervalMin: 10, minChatLines: 3, onlyWhenLive: false });
    const t0 = Date.now();
    // aún no toca
    assert.deepEqual(await app.timers.tick(t0 + 60_000), []);
    // toca por tiempo, pero no hay mensajes en el chat
    assert.deepEqual(await app.timers.tick(t0 + 11 * 60_000), []);
    assert.equal(app.timers.due(timer, t0 + 11 * 60_000), 'poco movimiento en el chat');
    for (const text of ['hola', 'qué tal', 'buenas']) await call('POST', '/api/chat/simulate', { user: 'ana', text });
    // los tuyos no cuentan
    await call('POST', '/api/chat/simulate', { user: 'egdev6', text: 'hola chat', owner: true });
    assert.equal(app.timers.st(timer.id).lines, 3);
    assert.deepEqual(await app.timers.tick(t0 + 11 * 60_000), [timer.id]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^Sígueme en twitch\.tv\/egdev6 · llevamos \d+ min$/);
    // la cuenta vuelve a empezar
    assert.equal(app.timers.st(timer.id).lines, 0);
    assert.deepEqual(await app.timers.tick(Date.now() + 60_000), []);
  } finally { await close(); }
});

test('anuncio destacado, envío manual, alerta en pantalla y «solo mientras emito»', async () => {
  const { app, sent, call, close } = await start();
  try {
    const { timer } = await call('POST', '/api/timers', { name: 'Web', message: 'egdev.es', intervalMin: 1, minChatLines: 0, announce: true, announceColor: 'purple', showAlert: true, title: 'Mi web', text: 'egdev.es', onlyWhenLive: true });
    // «solo mientras emito» exige que Meld confirme el directo, también para «Enviar ahora»
    app.meld.status = { ...app.meld.status, state: 'conectado', streaming: true };
    const r = await call('POST', `/api/timers/${timer.id}/fire`);
    assert.deepEqual(sent.at(-1), { kind: 'announce', text: 'egdev.es', color: 'purple' });
    assert.ok(r.alert, 'saca la alerta en pantalla');
    assert.equal(app.bus.history[0].title, 'Mi web');
    // la vista previa del panel también funciona con mensajes
    const pv = await call('POST', '/api/test', { timerId: timer.id, target: 'preview' });
    assert.equal(pv.alert.title, 'Mi web'); assert.equal(pv.alert.type, 'custom');
    // con Meld conectado y sin emitir, no sale
    app.meld.status = { ...app.meld.status, state: 'conectado', streaming: false };
    assert.equal(app.timers.due(timer, Date.now() + 2 * 60_000), 'no estás emitiendo');
    app.meld.status = { ...app.meld.status, streaming: true };
    assert.equal(app.timers.due(timer, Date.now() + 2 * 60_000), null);
    // la pausa global bloquea el mensaje lleve o no alerta en pantalla
    await call('POST', '/api/pause');
    assert.equal(app.timers.due(timer, Date.now() + 2 * 60_000), 'pausa activa');
    await call('PUT', `/api/timers/${timer.id}`, { showAlert: false });
    assert.equal(app.timers.due(app.store.config.timers[0], Date.now() + 2 * 60_000), 'pausa activa');
    await call('POST', '/api/resume', {});
    // listar con estado, borrar
    const list = await call('GET', '/api/timers');
    assert.equal(list[0].runtime.runs, 1);
    assert.equal((await call('DELETE', `/api/timers/${timer.id}`)).timers.length, 0);
  } finally { await close(); }
});

test('si Twitch falla, el error queda a la vista y no rompe nada', async () => {
  const { app, call, close } = await start();
  try {
    app.twitch.sendChat = async () => { throw new Error('Conecta Twitch para poder escribir en el chat.'); };
    const { timer } = await call('POST', '/api/timers', { message: 'hola', minChatLines: 0, onlyWhenLive: false });
    const r = await call('POST', `/api/timers/${timer.id}/fire`);
    assert.match(r.error, /Conecta Twitch/);
    assert.match((await call('GET', '/api/timers'))[0].runtime.lastError, /Conecta Twitch/);
  } finally { await close(); }
});
