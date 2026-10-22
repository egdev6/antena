import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-int-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  const sent = [];
  app.twitch.sendChat = async text => { sent.push(text); return { is_sent: true }; };
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
  };
  const chat = (user, text, extra = {}) => call('POST', '/api/chat/simulate', { user, text, ...extra });
  return { app, sent, call, chat, dataDir, close: () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('preguntas: entran por el chat, se ordenan, se muestran y se responden', async () => {
  const { app, call, chat, close } = await start();
  try {
    await chat('ana', '!pregunta ¿Qué opinas de Engram frente a RAG?');
    await chat('luis', '!pregunta corta');                 // demasiado corta
    await chat('marta', '!pregunta ¿Cómo testeáis los agentes?');
    await chat('ana', '!pregunta ¿Qué opinas de Engram frente a RAG?'); // repetida
    let s = await call('GET', '/api/interactive');
    assert.deepEqual(s.questions.list.map(q => q.user), ['ana', 'marta']);
    // límite por persona
    await call('PUT', '/api/interactive/config', { questions: { maxPerUser: 1 } });
    await chat('ana', '!pregunta Otra pregunta más de Ana');
    assert.equal((await call('GET', '/api/interactive')).questions.pending, 2);
    // subir la de marta y sacar la siguiente
    const marta = s.questions.list[1];
    await call('POST', `/api/questions/${marta.id}/move`, { dir: -1 });
    const { question } = await call('POST', '/api/questions/next');
    assert.equal(question.user, 'marta');
    s = await call('GET', '/api/interactive');
    assert.equal(s.questions.current.user, 'marta');
    // al sacar la siguiente, la anterior queda como respondida
    await call('POST', '/api/questions/next');
    s = await call('GET', '/api/interactive');
    assert.equal(s.questions.list.find(q => q.user === 'marta').status, 'answered');
    assert.equal(s.questions.current.user, 'ana');
    await call('POST', '/api/questions/hide');
    assert.equal((await call('GET', '/api/interactive')).questions.current, null);
    // también se añaden a mano y se limpian las respondidas
    await call('POST', '/api/questions', { text: 'Pregunta que me llegó por Discord' });
    await call('POST', '/api/questions/clear', {});
    assert.equal((await call('GET', '/api/interactive')).questions.list.length, 1);
  } finally { await close(); }
});

test('tier list: el chat vota con «S» o «!tier A» y gana el más votado', async () => {
  const { call, chat, close } = await start();
  try {
    const { tierlist } = await call('POST', '/api/tierlists', { title: 'Frameworks', items: ['React', 'Vue', 'Svelte'] });
    assert.deepEqual(tierlist.tiers.map(t => t.label), ['S', 'A', 'B', 'C', 'D']);
    // sin votación abierta, «S» es un mensaje normal
    await chat('ana', 'S');
    await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'react' });
    await chat('ana', 's');
    await chat('luis', '!tier A');
    await chat('marta', 'S');
    await chat('pepe', 'Z');           // no existe
    await chat('ana', 'A');            // cambia su voto
    await chat('juan', 'A');
    let s = await call('GET', '/api/interactive');
    assert.equal(s.vote.total, 4);
    assert.equal(s.vote.counts[tierlist.tiers[1].id], 3);
    const { result } = await call('POST', '/api/vote/close', {});
    assert.equal(result.winner, tierlist.tiers[1].id);
    s = await call('GET', '/api/interactive');
    const react = s.tierlists[0].items.find(i => i.label === 'React');
    assert.equal(s.tierlists[0].placements[react.id], tierlist.tiers[1].id);
    assert.equal(s.vote, null);
    // colocar a mano, por nombre de tier
    await call('POST', `/api/tierlists/${tierlist.id}/place`, { item: 'Vue', tier: 'S' });
    // empate → gana el tier más alto
    await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'Svelte' });
    await chat('a', 'B'); await chat('b', 'C');
    assert.equal((await call('POST', '/api/vote/close', {})).result.winner, tierlist.tiers[2].id);
    // editar tiers: los que desaparecen sueltan sus elementos
    await call('PUT', `/api/tierlists/${tierlist.id}`, { tiers: tierlist.tiers.slice(0, 2) });
    s = await call('GET', '/api/interactive');
    assert.equal(Object.keys(s.tierlists[0].placements).length, 2);
  } finally { await close(); }
});

test('sorteo: entran con el comando, sin repetidos, y el ganador sale en el chat', async () => {
  const { app, sent, call, chat, dataDir, close } = await start();
  try {
    await call('PUT', '/api/interactive/config', { giveaway: { command: '!yo', prize: 'una camiseta EGDEV', rollSeconds: 1 } });
    await chat('ana', '!yo');                       // aún cerrado
    await call('POST', '/api/giveaway/open', {});
    assert.match(sent.at(-1), /camiseta EGDEV · Escribe !yo/);
    await chat('ana', '!yo'); await chat('ana', '!yo'); await chat('luis', '!YO'); await chat('marta', '!yo');
    let g = await call('GET', '/api/giveaway');
    assert.deepEqual(g.entries.map(e => e.user), ['ana', 'luis', 'marta']);
    await call('POST', '/api/giveaway/close');
    await chat('pepe', '!yo');
    assert.equal((await call('GET', '/api/giveaway')).count, 3);
    const winners = new Set();
    for (let i = 0; i < 3; i++) winners.add((await call('POST', '/api/giveaway/draw')).winner);
    assert.equal(winners.size, 3, 'no repite ganador');
    await assert.rejects(call('POST', '/api/giveaway/draw'), /Ya han ganado todos/);
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(sent.some(t => /Enhorabuena @/.test(t)));
    // el estado se guarda en disco
    await app.interactive.flush();
    const app2 = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
    assert.equal(app2.interactive.giveaway.entries.length, 3);
    assert.ok(app2.interactive.s.giveawayHistory.length >= 1);
  } finally { await close(); }
});

test('sorteo ponderado: los subs y miembros cuentan más', async () => {
  const { app, call, close } = await start();
  try {
    await call('PUT', '/api/interactive/config', { giveaway: { memberLuck: 50, excludeWinners: false, announceInChat: false } });
    await call('POST', '/api/giveaway/open', {});
    await call('POST', '/api/giveaway/join', { user: 'sub', member: true });
    await call('POST', '/api/giveaway/join', { user: 'normal' });
    let subs = 0;
    for (let i = 0; i < 60; i++) if ((await app.interactive.draw()).winner === 'sub') subs++;
    assert.ok(subs > 45, `el sub gana casi siempre (${subs}/60)`);
  } finally { await close(); }
});
