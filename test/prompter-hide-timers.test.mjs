// Scheduled messages come back through the chat as your own messages: the server tags their echo
// with `timer: true` so the prompter can hide them (prompter.hideTimers). Fake providers, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-hide-timers-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  let gate = null;
  const sent = [], ytSent = [], announced = [];
  const fake = { twFail: false };
  app.twitch.sendChat = async text => {
    if (gate) await gate;
    if (fake.twFail) throw new Error('Twitch down');
    sent.push(text);
    return { message_id: sent.length === 1 ? 'abc' : `abc${sent.length}`, is_sent: true };
  };
  app.twitch.sendAnnouncement = async text => { announced.push(text); return { announced: true }; };
  app.twitch.status.user = 'egdev6';
  app.youtube.sendChat = async text => { ytSent.push(text); return { id: 'yt-1', sent: true }; };
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  t.after(async () => {
    await new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const timer = async fields => (await call('POST', '/api/timers', { message: 'Follow the channel', intervalMin: 5, minChatLines: 0, onlyWhenLive: false, ...fields })).timer;
  const own = (id, text, platform = 'twitch') => ({ id, at: Date.now(), platform, user: 'egdev6', login: 'egdev6', text, owner: true });
  const chat = async () => {
    const d = await call('GET', '/api/chat');
    return Array.isArray(d) ? d : d.chat || d.messages;
  };
  return { app, call, timer, own, chat, sent, ytSent, announced, fake, hold: () => { let open; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; } };
}

test('the echo of a scheduled message is tagged timer: true (matched by id)', async t => {
  const { app, timer, own, chat } = await start(t);
  const tm = await timer({});
  await app.timers.fire(tm.id);
  app.engine.handleChat(own('tw:abc', 'Follow the channel'), { source: 'twitch' });
  const m = (await chat()).find(x => x.id === 'tw:abc');
  assert.equal(m.timer, true);
});

test('the echo is tagged even when it arrives before the send resolves (matched by text)', async t => {
  const { app, timer, own, chat, hold } = await start(t);
  const tm = await timer({});
  const release = hold();
  const firing = app.timers.fire(tm.id);
  await new Promise(r => setTimeout(r, 20));
  app.engine.handleChat(own('tw:other', 'Follow the channel'), { source: 'twitch' });
  release();
  await firing;
  assert.equal((await chat()).find(x => x.id === 'tw:other').timer, true);
});

test('YouTube echo of a scheduled message is tagged too', async t => {
  const { app, timer, own, chat } = await start(t);
  const tm = await timer({ destination: 'youtube' });
  await app.timers.fire(tm.id);
  app.engine.handleChat(own('yt:whatever', 'Follow the channel', 'youtube'), { source: 'youtube' });
  assert.equal((await chat()).find(x => x.id === 'yt:whatever').timer, true);
});

test('a message you type with the same text is not tagged once the echo was used', async t => {
  const { app, timer, own, chat } = await start(t);
  const tm = await timer({});
  await app.timers.fire(tm.id);
  app.engine.handleChat(own('tw:abc', 'Follow the channel'), { source: 'twitch' });
  app.engine.handleChat(own('tw:typed', 'Follow the channel'), { source: 'twitch' });
  const list = await chat();
  assert.equal(list.find(x => x.id === 'tw:typed').timer, undefined);
});

test('regression: own messages and viewer messages without a scheduled send are not tagged', async t => {
  const { app, own, chat } = await start(t);
  app.engine.handleChat(own('tw:mine', 'Hello chat'), { source: 'twitch' });
  app.engine.handleChat({ id: 'tw:viewer', at: Date.now(), platform: 'twitch', user: 'ana', login: 'ana', text: 'Hello chat' }, { source: 'twitch' });
  const list = await chat();
  assert.equal(list.find(x => x.id === 'tw:mine').timer, undefined);
  assert.equal(list.find(x => x.id === 'tw:viewer').timer, undefined);
});

test('a viewer repeating the scheduled text is not tagged', async t => {
  const { app, timer, chat } = await start(t);
  const tm = await timer({});
  await app.timers.fire(tm.id);
  app.engine.handleChat({ id: 'tw:copycat', at: Date.now(), platform: 'twitch', user: 'ana', login: 'ana', text: 'Follow the channel' }, { source: 'twitch' });
  assert.equal((await chat()).find(x => x.id === 'tw:copycat').timer, undefined);
});

test('prompter.hideTimers is off by default and can be saved', async t => {
  const { call } = await start(t);
  assert.equal((await call('GET', '/api/config')).prompter.hideTimers, false);
  await call('POST', '/api/config/set', { path: 'prompter.hideTimers', value: true });
  assert.equal((await call('GET', '/api/config')).prompter.hideTimers, true);
});

const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert.fail('condition not met in time'); await new Promise(r => setTimeout(r, 10)); }
};

test('a failed send leaves no echo: a later own message with the same text is not tagged', async t => {
  const { app, timer, own, chat, fake } = await start(t);
  const tm = await timer({});
  fake.twFail = true;
  const out = await app.timers.fire(tm.id);
  assert.equal(out.platforms.twitch.ok, false);
  app.engine.handleChat(own('tw:typed', 'Follow the channel'), { source: 'twitch' });
  assert.equal((await chat()).find(x => x.id === 'tw:typed').timer, undefined);
});

test('an echo that arrives after two minutes is not tagged', async t => {
  const { app, timer, own, chat } = await start(t);
  const tm = await timer({});
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await app.timers.fire(tm.id);
  t.mock.timers.tick(2 * 60_000 + 1);
  app.engine.handleChat(own('tw:abc', 'Follow the channel'), { source: 'twitch' });
  assert.equal((await chat()).find(x => x.id === 'tw:abc').timer, undefined);
});

test('a Twitch announcement registers no echo; with both destinations YouTube is still tagged', async t => {
  const { app, timer, own, chat, announced, ytSent } = await start(t);
  const tm = await timer({ announce: true, destination: 'both' });
  await app.timers.fire(tm.id);
  assert.deepEqual(announced, ['Follow the channel']);
  assert.deepEqual(ytSent, ['Follow the channel']);
  app.engine.handleChat(own('tw:typed', 'Follow the channel'), { source: 'twitch' });
  app.engine.handleChat(own('yt:echo', 'Follow the channel', 'youtube'), { source: 'youtube' });
  const list = await chat();
  assert.equal(list.find(x => x.id === 'tw:typed').timer, undefined);
  assert.equal(list.find(x => x.id === 'yt:echo').timer, true);
});

test('with both destinations each platform echo is tagged once', async t => {
  const { app, timer, own, chat } = await start(t);
  const tm = await timer({ destination: 'both' });
  await app.timers.fire(tm.id);
  app.engine.handleChat(own('tw:abc', 'Follow the channel'), { source: 'twitch' });
  app.engine.handleChat(own('yt:1', 'Follow the channel', 'youtube'), { source: 'youtube' });
  app.engine.handleChat(own('yt:2', 'Follow the channel', 'youtube'), { source: 'youtube' });
  const list = await chat();
  assert.equal(list.find(x => x.id === 'tw:abc').timer, true);
  assert.equal(list.find(x => x.id === 'yt:1').timer, true);
  assert.equal(list.find(x => x.id === 'yt:2').timer, undefined);
});

test('regression: the echo of a chat-reply command is not tagged', async t => {
  const { app, call, own, chat, sent } = await start(t);
  const { command } = await call('POST', '/api/commands', { trigger: '!web', cooldownSec: 0, userCooldownSec: 0, outputMode: 'chat', chatReply: 'see egdev.dev' });
  assert.ok(command.id);
  await call('POST', '/api/chat/simulate', { user: 'Ana', text: '!web', platform: 'twitch' });
  await waitFor(() => sent.length === 1);
  assert.deepEqual(sent, ['see egdev.dev']);
  app.engine.handleChat(own('tw:reply', 'see egdev.dev'), { source: 'twitch' });
  assert.equal((await chat()).find(x => x.id === 'tw:reply').timer, undefined);
});

test('regression: viewers still count toward minChatLines and the timer echo does not', async t => {
  const { app, call, timer, own } = await start(t);
  const tm = await timer({});
  await app.timers.fire(tm.id);
  const lines = async () => (await call('GET', '/api/timers')).find(x => x.id === tm.id).runtime.lines;
  assert.equal(await lines(), 0);
  app.engine.handleChat(own('tw:abc', 'Follow the channel'), { source: 'twitch' });
  assert.equal(await lines(), 0);
  app.engine.handleChat({ id: 'tw:v', at: Date.now(), platform: 'twitch', user: 'ana', login: 'ana', text: 'hi' }, { source: 'twitch' });
  assert.equal(await lines(), 1);
});
