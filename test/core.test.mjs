import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { matchesConditions, pickVariation, buildAlert, buildCommandAlert, DEFAULT_ALERTS } from '../src/alerts.mjs';
import { cleanText, cleanVars, isBlockedUser } from '../src/filters.mjs';
import { CommandRunner, newCommand, normalizeTrigger } from '../src/commands.mjs';
import { parseIrc, splitEmotes, twitchChatMessage } from '../src/chat.mjs';
import { Session } from '../src/session.mjs';
import { Meld } from '../src/meld.mjs';

test('condiciones de las variaciones', () => {
  assert.ok(matchesConditions({ minAmount: 50 }, { amount: 120 }));
  assert.ok(!matchesConditions({ minAmount: 50 }, { amount: 10 }));
  assert.ok(!matchesConditions({ minAmount: 50 }, {}));
  assert.ok(matchesConditions({ maxAmount: 99 }, { amount: 99 }));
  assert.ok(matchesConditions({ tier: 3 }, { tier: 3 }) && !matchesConditions({ tier: 3 }, { tier: 1 }));
  assert.ok(matchesConditions({ users: 'Midudev, ana' }, { user: 'midudev' }));
  assert.ok(matchesConditions({ messageContains: 'engram, gentle' }, { message: 'Me encanta Engram' }));
  assert.ok(!matchesConditions({ chance: 0 }, {}));
  assert.ok(matchesConditions({ minAmount: '', tier: '' }, {}));
  const vs = [{ id: 'a', enabled: false, conditions: {} }, { id: 'b', conditions: { minAmount: 1000 } }, { id: 'c', conditions: { minAmount: 100 } }];
  assert.equal(pickVariation(vs, { amount: 500 }).id, 'c');
  assert.equal(pickVariation(vs, { amount: 50 }), null);
});

test('la variación sobrescribe solo lo que cambia', () => {
  const config = { alerts: { cheer: { ...DEFAULT_ALERTS.cheer, variations: [{ id: 'v1', name: 'Lluvia', conditions: { minAmount: 1000 }, overrides: { title: 'LLUVIA DE BITS', media: 'lluvia.webm', layout: 'media' } }] } } };
  const big = buildAlert('cheer', { user: 'x', amount: 2000 }, config);
  assert.equal(big.variation.name, 'Lluvia');
  assert.equal(big.title, 'LLUVIA DE BITS');
  assert.equal(big.look.layout, 'media');
  assert.equal(big.sub, '2000 bits');
  const small = buildAlert('cheer', { user: 'x', amount: 100 }, config);
  assert.equal(small.variation, null);
  assert.equal(small.title, 'Bits');
  // probar una variación concreta
  assert.equal(buildAlert('cheer', { user: 'x', amount: 1 }, config, { test: true, variationId: 'v1' }).title, 'LLUVIA DE BITS');
});

test('voz: plantilla, mínimo y límite', () => {
  const config = { tts: { maxChars: 20 }, alerts: { cheer: { ttsEnabled: true, ttsTemplate: '{user} dice: {message}', ttsMinAmount: 100 } } };
  assert.equal(buildAlert('cheer', { user: 'ana', amount: 50, message: 'hola' }, config).tts, null);
  const a = buildAlert('cheer', { user: 'ana', amount: 500, message: 'hola a todo el chat' }, config);
  assert.equal(a.tts.text, 'ana dice: hola a');
});

test('filtros de palabras, enlaces y usuarios', () => {
  const f = { blockedWords: ['tonto', 'spoiler'], blockedUsers: ['@Troll'], replaceWith: '***' };
  assert.equal(cleanText('Eres TONTO, tontó y tontorrón', f), 'Eres ***, *** y tontorrón');
  assert.equal(cleanText('mira https://spam.com y bit.ly/x', f), 'mira [enlace] y [enlace]');
  assert.ok(isBlockedUser('troll', f));
  assert.ok(!isBlockedUser('trolla', f));
  assert.equal(cleanVars({ user: 'ana', message: 'spoiler!', amount: 5 }, f).message, '***!');
  assert.equal(cleanText('x'.repeat(300), { maxMessageLength: 10 }).length, 10);
  assert.equal(cleanText('tonto', { enabled: false, blockedWords: ['tonto'] }), 'tonto');
});

test('comandos: disparador, permisos y cooldown', () => {
  const r = new CommandRunner();
  const cmds = [newCommand({ trigger: 'Engram', cooldownSec: 30, userCooldownSec: 0 }), newCommand({ trigger: '!mod', permission: 'mods' })];
  assert.equal(normalizeTrigger('engram'), '!engram');
  const hit = r.match(cmds, { text: '!ENGRAM memoria larga', user: 'Ana', platform: 'twitch' }, 1000);
  assert.equal(hit.vars.args, 'memoria larga');
  assert.equal(r.match(cmds, { text: '!engram', user: 'Luis', platform: 'twitch' }, 2000), null); // cooldown global
  assert.ok(r.match(cmds, { text: '!engram', user: 'Mod', mod: true, platform: 'twitch' }, 2000)); // los mods se lo saltan
  assert.ok(r.match(cmds, { text: '!engram', user: 'Luis', platform: 'twitch' }, 40000));
  assert.equal(r.match(cmds, { text: '!mod', user: 'x', platform: 'twitch' }), null);
  assert.ok(r.match(cmds, { text: '!mod', user: 'x', mod: true, platform: 'youtube' }));
  const a = buildCommandAlert(cmds[0], { user: 'Ana', args: 'hola' }, {});
  assert.equal(a.type, 'command'); assert.equal(a.sub, 'hola');
});

test('chat de Twitch: IRC con etiquetas y emotes', () => {
  const line = '@badge-info=;badges=moderator/1,subscriber/12;color=#FF0036;display-name=Ana_Dev;emotes=25:0-4;id=abc;mod=1;subscriber=1;tmi-sent-ts=1700000000000 :ana_dev!ana_dev@ana_dev.tmi.twitch.tv PRIVMSG #egdev6 :Kappa hola\\sque tal';
  const m = parseIrc(line);
  assert.equal(m.command, 'PRIVMSG');
  const c = twitchChatMessage(m);
  assert.equal(c.user, 'Ana_Dev'); assert.ok(c.mod); assert.ok(c.member);
  assert.equal(c.parts[0].alt, 'Kappa'); assert.match(c.parts[0].e, /emoticons\/v2\/25\//);
  assert.deepEqual(splitEmotes('😀 Kappa', '25:2-6').map(p => p.t ?? p.alt), ['😀 ', 'Kappa']);
});

test('sesión: totales, objetivos, créditos y resumen', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ses-'));
  const s = await new Session(dir).load();
  const ev = (type, user, vars = {}) => s.record({ id: Math.random() + '', type, at: new Date().toISOString(), vars: { user, ...vars }, text: user, sub: '' });
  ev('follow', 'ana'); ev('follow', 'luis'); ev('giftsub', 'tom', { amount: 5 }); ev('cheer', 'rea', { amount: 300 }); ev('superchat', 'carlos', { amount: 4.5 }); ev('follow', 'ana');
  const t = s.totals();
  assert.equal(t.follows, 3); assert.equal(t.subs, 5); assert.equal(t.bits, 300); assert.equal(t.superchats, 4.5);
  s.addToGoal('follows', 2); assert.equal(s.goalValue('follows'), 5);
  s.setGoalValue('follows', 10); assert.equal(s.goalValue('follows'), 10);
  assert.deepEqual(s.credits().find(g => g.title === 'Nuevos seguidores').names, ['ana', 'luis']);
  assert.match(s.summaryMarkdown(), /Bits: 300/);
  const old = s.data.id;
  await new Promise(r => setTimeout(r, 5));
  await s.startNew('Siguiente');
  assert.equal(s.data.events.length, 0);
  assert.equal((await s.list())[0].id, old);
  assert.equal((await s.get(old)).events.length, 6);
});

import { fakeMeld } from './helpers/fake-meld.mjs';

test('Meld: conecta por QWebChannel, cambia escena y alterna capas por nombre', async () => {
  const { server, state } = fakeMeld();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const meld = new Meld(() => {});
  const ready = new Promise(r => meld.once('session', r));
  meld.start(`ws://127.0.0.1:${server.address().port}`);
  const s = await ready;
  assert.equal(meld.status.state, 'conectado');
  assert.equal(meld.status.version, 2);
  assert.deepEqual(s.scenes.map(x => x.name), ['Cámara', 'Pantalla']);
  await meld.showScene('pantalla');
  assert.deepEqual(state.calls.at(-1), [10, 's2']);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(meld.findScene('Pantalla').current);
  await meld.setLayer(null, 'Alertas', true);
  assert.deepEqual(state.calls.at(-1), [11, 's1', 'l1']);
  await new Promise(r => setTimeout(r, 30));
  const n = state.calls.length;
  await meld.setLayer('Cámara', 'Alertas', true); // ya visible → no hace nada
  assert.equal(state.calls.length, n);
  await meld.streamEvent('CONFETTIPOP_TRIGGER');
  assert.deepEqual(state.calls.at(-1), [13, 'CONFETTIPOP_TRIGGER']);
  await meld.toggleMute('micro');
  assert.deepEqual(state.calls.at(-1), [14, 't1']);
  await assert.rejects(meld.showScene('No existe'), /No encuentro/);
  meld.stop(); server.close();
});

test('cada alerta tiene sus propias variaciones y acciones', async () => {
  const { Store } = await import('../src/store.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'st-'));
  const st = await new Store(dir).load();
  st.config.alerts.raid.variations.push({ id: 'x' });
  st.config.alerts.raid.actions.push({ kind: 'say' });
  assert.equal(st.config.alerts.cheer.variations.length, 0);
  assert.equal(st.config.alerts.cheer.actions.length, 0);
  assert.equal(DEFAULT_ALERTS.raid.variations.length, 0);
  const st2 = await new Store(dir).load();
  assert.equal(st2.config.alerts.follow.variations.length, 0);
});

test('CSS: los estilos de serie van en una capa y el CSS común viaja con cada alerta', async () => {
  const { readFile } = await import('node:fs/promises');
  const { buildAlert } = await import('../src/alerts.mjs');
  const html = await readFile(new URL('../public/overlay.html', import.meta.url), 'utf8');
  const layered = html.slice(html.indexOf('@layer egdev {'), html.indexOf('} /* fin @layer egdev */'));
  assert.ok(layered.includes('.alert-card .alert-name'), 'las reglas de la tarjeta están dentro de la capa');
  assert.ok(html.indexOf('<style id="custom-css">') > html.indexOf('} /* fin @layer egdev */'), 'el CSS propio va fuera de la capa');
  const a = buildAlert('raid', { user: 'x', amount: 5 }, { overlay: { css: '.alert{--accent:#0ff}' }, alerts: { raid: { css: '.alert-name{color:red}' } } });
  assert.equal(a.globalCss, '.alert{--accent:#0ff}');
  assert.equal(a.look.css, '.alert-name{color:red}');
  for (const f of ['chat', 'goal', 'latest', 'ticker', 'credits', 'question', 'tierlist', 'giveaway']) {
    assert.match(await readFile(new URL(`../public/widgets/${f}.html`, import.meta.url), 'utf8'), /@layer egdev \{/, f);
  }
});
