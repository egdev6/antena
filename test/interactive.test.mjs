import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start({ dataDir, keepData = false } = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), 'egdev-int-'));
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
  return { app, sent, call, chat, dataDir, close: async () => {
    app.timers.stop();
    await app.closeHttp();
    await app.interactive.flush();
    if (!keepData) await rm(dataDir, { recursive: true, force: true });
  } };
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

test('tier vote text: legacy and custom lists survive updates and restart', async () => {
  const first = await start({ keepData: true });
  let closed = false, second;
  try {
    const legacy = (await first.call('POST', '/api/tierlists', { title: 'Legacy', items: ['One'] })).tierlist;
    await first.call('POST', `/api/tierlists/${legacy.id}/place`, { item: 'One', tier: 'A' });
    const created = (await first.call('POST', '/api/tierlists', {
      title: 'Custom', items: ['Two'], tiers: [
        { id: 'top', label: 'S', color: '#ff0036', voteText: 'Excellent' },
        { id: 'good', label: 'A', color: '#ff6a3d', voteText: '' },
        { id: 'mid', label: 'B', color: '#ffb547' },
      ],
    })).tierlist;
    assert.deepEqual(created.tiers.map(t => t.voteText), ['Excellent', '', undefined]);
    const updated = (await first.call('PUT', `/api/tierlists/${created.id}`, { tiers: [
      { ...created.tiers[0], voteText: 'Outstanding' }, created.tiers[1], created.tiers[2],
    ] })).tierlist;
    assert.deepEqual(updated.tiers.map(t => t.voteText), ['Outstanding', '', undefined]);
    await first.call('PUT', `/api/tierlists/${created.id}`, { title: 'Custom renamed' });
    await first.close(); closed = true;
    second = await start({ dataDir: first.dataDir });
    const lists = (await second.call('GET', '/api/interactive')).tierlists;
    const old = lists.find(l => l.id === legacy.id);
    const custom = lists.find(l => l.id === created.id);
    assert.deepEqual(old.tiers, legacy.tiers);
    assert.equal(old.placements[legacy.items[0].id], legacy.tiers[1].id);
    assert.equal(custom.title, 'Custom renamed');
    assert.deepEqual(custom.tiers.map(t => t.voteText), ['Outstanding', '', undefined]);
    await second.call('POST', `/api/tierlists/${legacy.id}/vote`, { item: 'One' });
    await second.chat('ana', '!tier S');
    assert.equal((await second.call('GET', '/api/interactive')).vote.counts[legacy.tiers[0].id], 1);
  } finally {
    if (second) await second.close();
    else { if (!closed) await first.close(); await rm(first.dataDir, { recursive: true, force: true }); }
  }
});

test('tier vote text: chat parser still accepts labels and ids, not display text', async () => {
  const { call, chat, close } = await start();
  try {
    const tiers = [
      { id: 'top', label: 'Superior', color: '#ff0036', voteText: 'Amazing' },
      { id: 'good', label: 'Bueno', color: '#ff6a3d', voteText: 'Great' },
    ];
    const { tierlist } = await call('POST', '/api/tierlists', { title: 'Parser', tiers, items: ['One'] });
    assert.deepEqual(tierlist.tiers, tiers);
    await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'One' });
    await chat('ana', '!tier top');
    await chat('bea', 'top');
    await chat('carl', '!tier bueno');
    await chat('dana', 'SUPERIOR');
    const before = await call('GET', '/api/interactive');
    assert.deepEqual(before.vote.counts, { top: 3, good: 1 });
    assert.equal(before.vote.total, 4);
    await chat('ana', 'Great');
    await chat('ed', '!tier Amazing');
    const after = await call('GET', '/api/interactive');
    assert.deepEqual(after.vote, before.vote);
    assert.deepEqual(after.tierlists, before.tierlists);
    await chat('ana', '!tier good');
    const changed = (await call('GET', '/api/interactive')).vote;
    assert.deepEqual(changed.counts, { top: 2, good: 2 });
    assert.equal(changed.total, 4);
    assert.equal(changed.winner, 'top');
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
