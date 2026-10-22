import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, buildAlert, normalizeTwitch, normalizeYouTube, ALERT_TYPES, DEFAULT_ALERTS, SAMPLES } from '../src/alerts.mjs';
import { parseVideoId } from '../src/youtube.mjs';
import { Bus } from '../src/bus.mjs';
import { deepMerge } from '../src/store.mjs';

test('render sustituye variables y limpia separadores huérfanos', () => {
  assert.equal(render('{months} meses · {message}', { months: 3 }), '3 meses');
  assert.equal(render('{a} · {b} · {c}', { b: 'x' }), 'x');
  assert.equal(render('hola {user}', { user: 'Ana' }), 'hola Ana');
});

test('todos los tipos tienen plantilla y ejemplo', () => {
  for (const k of Object.keys(ALERT_TYPES)) {
    assert.ok(DEFAULT_ALERTS[k], k);
    assert.ok(SAMPLES[k], k);
    const a = buildAlert(k, SAMPLES[k], { alerts: DEFAULT_ALERTS }, { test: true });
    assert.ok(a.title && a.text, k);
  }
});

test('buildAlert respeta desactivadas y mínimos (salvo en pruebas)', () => {
  const cfg = { alerts: { cheer: { minAmount: 100 }, follow: { enabled: false } } };
  assert.equal(buildAlert('cheer', { user: 'a', amount: 50 }, cfg), null);
  assert.ok(buildAlert('cheer', { user: 'a', amount: 150 }, cfg));
  assert.equal(buildAlert('follow', { user: 'a' }, cfg), null);
  assert.ok(buildAlert('follow', { user: 'a' }, cfg, { test: true }));
});

test('Twitch: normaliza los eventos de EventSub', () => {
  assert.deepEqual(normalizeTwitch('channel.follow', { user_name: 'Ana' }), { type: 'follow', vars: { user: 'Ana' } });
  assert.equal(normalizeTwitch('channel.subscribe', { user_name: 'x', is_gift: true, tier: '1000' }), null);
  assert.equal(normalizeTwitch('channel.subscribe', { user_name: 'x', tier: '2000' }).vars.tier, 2);
  const gift = normalizeTwitch('channel.subscription.gift', { user_name: null, is_anonymous: true, total: 5, tier: '1000' });
  assert.equal(gift.vars.user, 'Anónimo'); assert.equal(gift.vars.amount, 5);
  const cheer = normalizeTwitch('channel.cheer', { user_name: 'b', bits: 300, message: 'Cheer100 Cheer200 genial' });
  assert.equal(cheer.vars.message, 'genial');
  assert.deepEqual(normalizeTwitch('channel.raid', { from_broadcaster_user_name: 'midu', viewers: 80 }).vars, { user: 'midu', amount: 80 });
  const red = normalizeTwitch('channel.channel_points_custom_reward_redemption.add', { user_name: 'c', user_input: 'hola', reward: { title: 'Hidratarse', cost: 100 } });
  assert.equal(red.vars.reward, 'Hidratarse');
  assert.equal(normalizeTwitch('channel.unknown', {}), null);
});

test('YouTube: normaliza Super Chats y miembros', () => {
  const sc = normalizeYouTube({ id: '1', snippet: { type: 'superChatEvent', superChatDetails: { amountMicros: '5000000', amountDisplayString: '5,00 €', userComment: 'hola' } }, authorDetails: { displayName: 'Ana' } });
  assert.deepEqual(sc.vars, { user: 'Ana', amount: 5, amountText: '5,00 €', message: 'hola', currency: undefined });
  assert.equal(normalizeYouTube({ snippet: { type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Pro' } }, authorDetails: { displayName: 'B' } }).vars.level, 'Pro');
  assert.equal(normalizeYouTube({ snippet: { type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 3 } }, authorDetails: {} }).vars.amount, 3);
  assert.equal(normalizeYouTube({ snippet: { type: 'textMessageEvent' } }), null);
});

test('parseVideoId acepta ids y enlaces', () => {
  assert.equal(parseVideoId('ji4dkxhvMXI'), 'ji4dkxhvMXI');
  assert.equal(parseVideoId('https://www.youtube.com/watch?v=ji4dkxhvMXI&t=3'), 'ji4dkxhvMXI');
  assert.equal(parseVideoId('https://youtube.com/live/ji4dkxhvMXI?si=x'), 'ji4dkxhvMXI');
  assert.equal(parseVideoId('https://youtu.be/ji4dkxhvMXI'), 'ji4dkxhvMXI');
  assert.equal(parseVideoId('nada'), null);
});

test('Bus descarta duplicados y no guarda pruebas en el historial', () => {
  const b = new Bus();
  assert.equal(b.isDuplicate('a'), false);
  assert.equal(b.isDuplicate('a'), true);
  b.alert({ id: 1, test: true }); b.alert({ id: 2 });
  assert.deepEqual(b.history.map(h => h.id), [2]);
});

test('el diseño «media» sin recurso cae a la tarjeta', () => {
  const a = buildAlert('follow', { user: 'x' }, { alerts: { follow: { layout: 'media', media: '' } } });
  assert.equal(a.look.layout, 'card');
  const b = buildAlert('follow', { user: 'x' }, { alerts: { follow: { layout: 'media', media: 'a.gif', fontSize: '72' } } });
  assert.equal(b.look.layout, 'media'); assert.equal(b.look.mediaKind, 'image'); assert.equal(b.look.fontSize, 72);
});

test('deepMerge conserva valores por defecto', () => {
  const m = deepMerge({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 } });
  assert.deepEqual(m, { a: { x: 1, y: 3 }, b: 1 });
});
