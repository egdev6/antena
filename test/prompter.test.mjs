import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(logs = []) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-pr-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: (...args) => logs.push(args.join(' ')) });
  app.twitch.sendChat = async () => ({ is_sent: true });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status }); return d;
  };
  return { app, call, base, close: () => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); }) };
}

test('cronología: mensajes destacados, marcas, guardados y agradecidos', async () => {
  const { app, call, close } = await start();
  try {
    await call('POST', '/api/simulate', { type: 'raid', vars: { user: 'lucia_codes', amount: 25 } });
    await call('POST', '/api/chat/simulate', { user: 'ana', text: 'mensaje normal' });
    await call('POST', '/api/chat/simulate', { user: 'marta', text: '¡Me encanta Engram!', highlighted: true });
    const { marker } = await call('POST', '/api/markers', { label: 'Explicación del layer de CSS' });
    assert.equal(marker.kind, 'marker');
    assert.ok(!marker.twitchMarker, 'sin Twitch conectado solo queda la marca local');
    await call('POST', '/api/timeline', { kind: 'saved', user: 'ana', text: 'mensaje normal', platform: 'twitch' });
    let tl = await call('GET', '/api/timeline');
    assert.deepEqual(tl.items.map(i => i.kind), ['event', 'highlight', 'marker', 'saved']);
    assert.equal(tl.items[1].user, 'marta');
    assert.equal(tl.pending, 1);
    // el último sin agradecer, desde Stream Deck (GET)
    await call('GET', '/sd/agradecido');
    tl = await call('GET', '/api/timeline');
    assert.equal(tl.pending, 0);
    assert.equal(tl.items[0].done, true);
    // renombrar y borrar notas
    await call('PUT', `/api/timeline/${marker.id}`, { label: 'CSS en capas' });
    await call('DELETE', `/api/timeline/${tl.items[3].id}`);
    tl = await call('GET', '/api/timeline?kinds=marker');
    assert.deepEqual(tl.items.map(i => i.label), ['CSS en capas']);
    // filtrar por tipo de alerta
    assert.equal((await call('GET', '/api/timeline?kinds=raid')).items.length, 1);
    // las preguntas mostradas y los ganadores también quedan
    await call('POST', '/api/questions', { user: 'pepe', text: '¿Qué opinas de los agentes?' });
    await call('POST', '/api/questions/next');
    assert.equal((await call('GET', '/api/timeline?kinds=question')).items[0].user, 'pepe');
    // resumen con las marcas
    const md = app.session.summaryMarkdown();
    assert.match(md, /## Marcas para shorts[\s\S]*CSS en capas/);
    assert.match(md, /Mensaje destacado: \*\*marta\*\*/);
    // y sobrevive a un reinicio
    await app.session.flush();
    assert.equal(app.session.data.notes.length, 3);
  } finally { await close(); }
});

test('prompter: dos pestañas, las retiradas son un no-op registrado y votación/sorteo no cambian de pestaña', async () => {
  const logs = [];
  const { call, close } = await start(logs);
  try {
    const inicial = await call('GET', '/api/prompter');
    assert.deepEqual(inicial.tabs, ['cronologia', 'preguntas']);
    assert.equal(inicial.tab, 'cronologia');

    // S10: las pestañas retiradas (tierlist, sorteo) se aceptan por API sin cambiar de pestaña
    assert.equal((await call('POST', '/api/prompter', { tab: 'tierlist' })).tab, 'cronologia');
    assert.equal((await call('POST', '/api/prompter', { tab: 'sorteo' })).tab, 'cronologia');
    assert.equal((await call('GET', '/api/prompter')).tab, 'cronologia');
    assert.equal(logs.filter(l => /Pestaña retirada/.test(l)).length, 2, 'cada no-op queda en el registro');

    // S10: /sd/prompter/<retirada> también es un no-op (200) y devuelve el estado actual
    assert.equal((await call('GET', '/sd/prompter/sorteo')).tab, 'cronologia');
    assert.equal((await call('GET', '/api/prompter')).tab, 'cronologia');

    // S10: un atajo guardado con una pestaña retirada se guarda y se ejecuta igual
    const { shortcut } = await call('POST', '/api/shortcuts', { name: 'legado', steps: [{ kind: 'builtin', action: 'prompter', arg: 'sorteo' }] });
    const run = await call('POST', `/api/shortcuts/${shortcut.id}/run`);
    assert.equal(run.shortcut, shortcut.id);
    assert.equal(run.results[0].tab, 'cronologia');
    assert.equal((await call('GET', '/api/prompter')).tab, 'cronologia');

    // las dos pestañas nuevas sí cambian
    await call('GET', '/sd/prompter/preguntas');
    assert.equal((await call('GET', '/api/prompter')).tab, 'preguntas');

    // valores desconocidos siguen siendo 400 y no tocan el estado
    await assert.rejects(call('POST', '/api/prompter', { tab: 'nada' }), /Pestaña desconocida/);
    await assert.rejects(call('GET', '/sd/prompter/nada'), /Pestaña desconocida/);
    assert.equal((await call('GET', '/api/prompter')).tab, 'preguntas');

    // S10: abrir una votación o un sorteo ya no salta de pestaña
    const { tierlist } = await call('POST', '/api/tierlists', { title: 'Frameworks', items: ['React', 'Vue'] });
    await call('POST', `/api/tierlists/${tierlist.id}/vote`, { item: 'React' });
    assert.equal((await call('GET', '/api/prompter')).tab, 'preguntas');
    await call('POST', '/api/giveaway/open', {});
    assert.equal((await call('GET', '/api/prompter')).tab, 'preguntas');

    // S10: prompter.autoSwitch se sigue aceptando para que los config.json existentes carguen
    await call('PUT', '/api/config', { prompter: { autoSwitch: false } });
    assert.equal((await call('GET', '/api/state')).config.prompter.autoSwitch, false);

    // atajos de Stream Deck
    assert.ok((await call('GET', '/api/shortcuts')).actions.includes('marca'));
    const p1 = await call('GET', '/sd/pausa'); assert.equal(p1.paused, true);
    const p2 = await call('POST', '/sd/pausa'); assert.equal(p2.paused, false);
    await assert.rejects(call('GET', '/sd/nada'), /Atajo desconocido/);
  } finally { await close(); }
});

test('chat: escribir en Twitch, YouTube o los dos', async () => {
  const { app, call, close } = await start();
  try {
    const sent = { twitch: [], youtube: [] };
    app.twitch.sendChat = async t => { sent.twitch.push(t); return { is_sent: true }; };
    app.youtube.sendChat = async t => { sent.youtube.push(t); return { sent: true }; };
    assert.equal((await call('POST', '/api/chat/send', { text: 'hola' })).to, 'twitch');          // por defecto, Twitch
    await call('POST', '/api/chat/send', { text: 'solo yt', to: 'youtube' });
    await call('PUT', '/api/config', { chat: { sendTo: 'both' } });
    const r = await call('POST', '/api/chat/send', { text: 'a los dos' });
    assert.deepEqual(Object.keys(r.sent).sort(), ['twitch', 'youtube']);
    assert.deepEqual(sent, { twitch: ['hola', 'a los dos'], youtube: ['solo yt', 'a los dos'] });
    // si una falla, la otra se envía y se avisa
    app.youtube.sendChat = async () => { throw new Error('Conecta tu cuenta de YouTube'); };
    const r2 = await call('POST', '/api/chat/send', { text: 'medio' });
    assert.ok(r2.sent.twitch); assert.match(r2.errors.youtube, /Conecta/);
    // si fallan todas, error
    await assert.rejects(call('POST', '/api/chat/send', { text: 'x', to: 'youtube' }), /YouTube: Conecta/);
    // la cuenta de YouTube necesita la app de Google
    await assert.rejects(call('POST', '/api/youtube/auth'), /Client ID/);
    await call('PUT', '/api/config', { youtube: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-x' } });
    const { url } = await call('POST', '/api/youtube/auth');
    const u = new URL(url);
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.force-ssl');
    assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/youtube$/);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    // el secreto no se devuelve entero
    assert.match((await call('GET', '/api/state')).config.youtube.clientSecret, /^••••/);
  } finally { await close(); }
});
