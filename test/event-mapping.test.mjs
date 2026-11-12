// Event → alert mapping (#130): one test per platform event type, with payloads shaped like
// the official EventSub reference and YouTube liveChatMessages docs. Synthetic names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTwitch, normalizeYouTube, buildAlert, ALERT_TYPES } from '../src/alerts.mjs';
import { Twitch } from '../src/twitch.mjs';
import { Bus } from '../src/bus.mjs';

const tw = (type, event) => normalizeTwitch(type, event);
const yt = (type, details = {}, author = { displayName: 'Ana' }) => normalizeYouTube({ id: 'm1', snippet: { type, ...details }, authorDetails: author });

// ---------- Twitch EventSub ----------

test('S2 Twitch channel.follow v2 → follow', () => {
  assert.deepEqual(tw('channel.follow', { user_id: '1', user_login: 'ana', user_name: 'Ana', broadcaster_user_id: '9', followed_at: '2026-11-12T10:00:00Z' }),
    { type: 'follow', vars: { user: 'Ana' } });
});

test('S2 Twitch channel.subscribe → sub; gifted subs are left to the gift alert', () => {
  assert.deepEqual(tw('channel.subscribe', { user_name: 'Ana', tier: '2000', is_gift: false }), { type: 'sub', vars: { user: 'Ana', tier: 2 } });
  assert.equal(tw('channel.subscribe', { user_name: 'Bea', tier: '1000', is_gift: true }), null);
});

test('S2 Twitch channel.subscription.message → resub with months and message', () => {
  assert.deepEqual(tw('channel.subscription.message', { user_name: 'Ana', tier: '3000', cumulative_months: 15, streak_months: 3, duration_months: 1, message: { text: 'Love the stream!', emotes: [] } }),
    { type: 'resub', vars: { user: 'Ana', tier: 3, months: 15, message: 'Love the stream!' } });
});

test('S2 Twitch channel.subscription.gift → giftsub; anonymous gifter shows as «Anónimo»', () => {
  assert.deepEqual(tw('channel.subscription.gift', { user_name: 'Ana', total: 5, tier: '1000', cumulative_total: 20, is_anonymous: false }),
    { type: 'giftsub', vars: { user: 'Ana', amount: 5, tier: 1 } });
  assert.equal(tw('channel.subscription.gift', { user_name: null, total: 1, tier: '1000', cumulative_total: null, is_anonymous: true }).vars.user, 'Anónimo');
});

test('S2 Twitch channel.cheer → cheer without cheermotes; anonymous cheer', () => {
  assert.deepEqual(tw('channel.cheer', { is_anonymous: false, user_name: 'Ana', message: 'Cheer100 pogchamp', bits: 100 }),
    { type: 'cheer', vars: { user: 'Ana', amount: 100, message: 'pogchamp' } });
  assert.equal(tw('channel.cheer', { is_anonymous: true, user_name: null, message: '', bits: 1000 }).vars.user, 'Anónimo');
});

test('S2 Twitch channel.raid → raid with viewers', () => {
  assert.deepEqual(tw('channel.raid', { from_broadcaster_user_name: 'Ana', to_broadcaster_user_name: 'egdev', viewers: 9001 }),
    { type: 'raid', vars: { user: 'Ana', amount: 9001 } });
});

test('S2 Twitch channel points redemption → redemption with reward and input', () => {
  assert.deepEqual(tw('channel.channel_points_custom_reward_redemption.add', { user_name: 'Ana', user_input: 'pogchamp', status: 'unfulfilled', reward: { id: 'r', title: 'Hidratarse', cost: 100, prompt: '' } }),
    { type: 'redemption', vars: { user: 'Ana', reward: 'Hidratarse', cost: 100, input: 'pogchamp' } });
});

test('S1/S3 Twitch channel.bits.use: Power-ups alert as bits; plain cheers stay with channel.cheer (no duplicate)', () => {
  assert.deepEqual(tw('channel.bits.use', { user_name: 'Ana', bits: 50, type: 'power_up', power_up: { type: 'gigantify_an_emote', emote: { id: '1', name: 'Kappa' } }, message: null }),
    { type: 'cheer', vars: { user: 'Ana', amount: 50, message: '', powerUp: 'gigantify_an_emote' } });
  assert.deepEqual(tw('channel.bits.use', { user_name: 'Bea', bits: 100, type: 'power_up', power_up: { type: 'message_effect' }, message: { text: 'hola', fragments: [] } }).vars.message, 'hola');
  assert.deepEqual(tw('channel.bits.use', { user_name: 'Cris', bits: 200, type: 'custom_power_up', message: null }).vars.powerUp, 'custom_power_up');
  assert.equal(tw('channel.bits.use', { user_name: 'Ana', bits: 100, type: 'cheer', message: { text: 'Cheer100' } }), null);
});

test('S1 Twitch subscribes to channel.bits.use v1 with the existing bits:read scope', async () => {
  const t = new Twitch({ config: { twitch: { clientId: 'c' } }, secrets: {} }, () => {});
  t.userId = '9'; t.stopped = false; t._terminal = false;
  const calls = [];
  t._subscribeWithRetry = async (type, version, condition) => { calls.push([type, version, condition]); return { ok: true, data: {} }; };
  await t.subscribeAll('s', t._epoch);
  assert.deepEqual(calls.find(c => c[0] === 'channel.bits.use'), ['channel.bits.use', '1', { broadcaster_user_id: '9' }]);
});

test('S2 Twitch unknown types never alert', () => {
  for (const type of ['channel.update', 'channel.chat.message', 'channel.unknown']) assert.equal(tw(type, { user_name: 'Ana' }), null, type);
});

// ---------- YouTube liveChatMessages ----------

test('S2 YouTube superChatEvent → superchat in currency units', () => {
  assert.deepEqual(yt('superChatEvent', { superChatDetails: { amountMicros: '5000000', currency: 'EUR', amountDisplayString: '5,00 €', userComment: 'hola', tier: 2 } }),
    { type: 'superchat', vars: { user: 'Ana', amount: 5, amountText: '5,00 €', message: 'hola', currency: 'EUR' } });
});

test('S2 YouTube superStickerEvent → supersticker with its alt text', () => {
  assert.deepEqual(yt('superStickerEvent', { superStickerDetails: { amountMicros: '2000000', currency: 'EUR', amountDisplayString: '2,00 €', superStickerMetadata: { stickerId: 's', altText: 'Gato bailando', language: 'es' } } }),
    { type: 'supersticker', vars: { user: 'Ana', amount: 2, amountText: '2,00 €', sticker: 'Gato bailando' } });
});

test('S2 YouTube newSponsorEvent → member (level and upgrade)', () => {
  assert.deepEqual(yt('newSponsorEvent', { newSponsorDetails: { memberLevelName: 'Pro', isUpgrade: true } }),
    { type: 'member', vars: { user: 'Ana', level: 'Pro', upgrade: true } });
  assert.equal(yt('newSponsorEvent', {}).vars.level, 'miembro');
});

test('S2 YouTube memberMilestoneChatEvent → milestone with months', () => {
  assert.deepEqual(yt('memberMilestoneChatEvent', { memberMilestoneChatDetails: { userComment: 'un año', memberMonth: 12, memberLevelName: 'Pro' } }),
    { type: 'milestone', vars: { user: 'Ana', months: 12, level: 'Pro', message: 'un año' } });
});

test('S2 YouTube membershipGiftingEvent → giftmember; each giftMembershipReceivedEvent does not alert again', () => {
  assert.deepEqual(yt('membershipGiftingEvent', { membershipGiftingDetails: { giftMembershipsCount: 3, giftMembershipsLevelName: 'Pro' } }),
    { type: 'giftmember', vars: { user: 'Ana', amount: 3, level: 'Pro' } });
  assert.equal(yt('giftMembershipReceivedEvent', { giftMembershipReceivedDetails: { memberLevelName: 'Pro', gifterChannelId: 'UC1', associatedMembershipGiftingMessageId: 'm0' } }), null);
});

test('S1/S5 YouTube types without an alert design stay ignored (giftEvent, polls, chat, system)', () => {
  for (const type of ['giftEvent', 'pollDetails', 'textMessageEvent', 'tombstone', 'userBannedEvent', 'chatEndedEvent', 'sponsorOnlyModeStartedEvent', 'messageDeletedEvent']) {
    assert.equal(yt(type), null, type);
  }
});

// ---------- alert fields and deduplication ----------

test('S2 every mapped type is a known alert of its platform and renders with its sample vars', () => {
  const mapped = { follow: 'twitch', sub: 'twitch', resub: 'twitch', giftsub: 'twitch', cheer: 'twitch', raid: 'twitch', redemption: 'twitch',
    superchat: 'youtube', supersticker: 'youtube', member: 'youtube', milestone: 'youtube', giftmember: 'youtube' };
  for (const [type, platform] of Object.entries(mapped)) {
    assert.equal(ALERT_TYPES[type]?.platform, platform, type);
    const a = buildAlert(type, { user: 'Ana', amount: 5, months: 3, reward: 'R', level: 'Pro', message: 'm', sticker: 's' }, { alerts: {} });
    assert.ok(a && a.text && !/\{\w+\}/.test(a.text + (a.sub || '')), `${type}: ${a?.text} ${a?.sub}`);
  }
});

test('S2 a redelivered EventSub message keeps its id and the bus drops the second copy', () => {
  const t = new Twitch({ config: { twitch: { clientId: 'c' } }, secrets: {} }, () => {});
  const events = [];
  t.on('event', e => events.push(e));
  t.emitEvent('msg-1', 'channel.follow', { user_name: 'Ana' });
  t.emitEvent('msg-1', 'channel.follow', { user_name: 'Ana' });
  assert.deepEqual(events.map(e => e.externalId), ['tw:msg-1', 'tw:msg-1']);
  const bus = new Bus();
  assert.deepEqual(events.map(e => bus.isDuplicate(e.externalId)), [false, true]);
});
