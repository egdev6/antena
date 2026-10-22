import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTube } from '../src/youtube.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const store = {
    config: { youtube: { apiKey: 'fake', video: 'abcdefghijk' } }, secrets: {},
    async setSecret(key, value) { this.secrets[key] = value; },
  };
  const yt = new YouTube(store, () => {});
  yt.running = true;
  yt.primed = true;
  yt.status.liveChatId = 'chat';
  return yt;
}
function pendingApi(yt) {
  const entered = deferred(), result = deferred(), calls = [];
  yt.api = async path => { calls.push(path); entered.resolve(); return result.promise; };
  return { entered: entered.promise, result, calls };
}
const response = { items: [{ id: 'one', snippet: { type: 'textMessageEvent', displayMessage: 'hola',
  textMessageDetails: { messageText: 'hola' } }, authorDetails: { displayName: 'Ada', channelId: 'author' } }], nextPageToken: 'next' };
const videoResponse = { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat' }, snippet: { title: 'Live' } }] };
async function isPending(promise) {
  const sentinel = {};
  assert.equal(await Promise.race([promise, Promise.resolve(sentinel)]), sentinel);
}

test('pending poll completes chat then closes, with no next timer or admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture(), io = pendingApi(yt), chats = [];
  yt.on('chat', chat => chats.push(chat));
  const poll = yt.poll();
  await io.entered;
  const closed = yt.quiescePoll();
  assert.equal(yt.quiescePoll(), closed);
  assert.equal(yt.running, false);
  await isPending(closed);
  await yt.start();
  await yt.poll();
  io.result.resolve(response);
  await Promise.all([poll, closed]);
  assert.equal(chats.length, 1);
  assert.equal(yt.pageToken, 'next');
  assert.equal(yt.status.polls, 1);
  t.mock.timers.tick(60_000);
  assert.deepEqual(io.calls, ['/liveChat/messages']);
});

test('pending priming response still suppresses historical chat', async () => {
  const yt = fixture(), io = pendingApi(yt);
  yt.primed = false;
  let emitted = 0;
  yt.on('chat', () => emitted++);
  yt.on('event', () => emitted++);
  const poll = yt.poll();
  await io.entered;
  const closed = yt.quiescePoll();
  io.result.resolve(response);
  await Promise.all([poll, closed]);
  assert.equal(emitted, 0);
  assert.equal(yt.primed, true);
});

test('cut before the first start continuation admits no IO', async () => {
  const yt = fixture(), io = pendingApi(yt);
  const start = yt.start();
  const closed = yt.quiescePoll();
  await Promise.all([start, closed]);
  assert.deepEqual(io.calls, []);
});

for (const phase of ['search', 'videos']) {
  test(`cut during ${phase} waits existing IO but opens no next resource`, async () => {
    const yt = fixture(), io = pendingApi(yt);
    if (phase === 'search') Object.assign(yt.cfg, { video: '', channelId: 'channel' });
    const start = yt.start();
    await io.entered;
    const closed = yt.quiescePoll();
    await isPending(closed);
    io.result.resolve(phase === 'search' ? { items: [{ id: { videoId: 'abcdefghijk' } }] } : videoResponse);
    await Promise.all([start, closed]);
    assert.deepEqual(io.calls, ['/' + phase]);
    assert.equal(yt.running, false);
    assert.notEqual(yt.status.state, 'escuchando');
  });
}

test('existing timer and stale callback cannot initiate another poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture();
  let calls = 0;
  yt.api = async () => { calls++; return response; };
  await yt.poll();
  assert.equal(calls, 1);
  await yt.quiescePoll();
  t.mock.timers.tick(60_000);
  await yt.poll();
  assert.equal(calls, 1);
});

test('status reentry gets cached close and cannot restart', async () => {
  const yt = fixture(), io = pendingApi(yt), reentries = [];
  let nested;
  yt.on('status', status => {
    if (status.state === 'parado') {
      nested = yt.quiescePoll();
      reentries.push(yt.start(), yt.poll());
    }
  });
  const closed = yt.quiescePoll();
  await closed;
  await Promise.all(reentries);
  assert.equal(nested, closed);
  assert.deepEqual(io.calls, []);
});

for (const reason of ['quotaExceeded', 'temporary']) {
  test(`pending provider failure ${reason} retains existing handling`, async () => {
    const yt = fixture(), io = pendingApi(yt);
    const poll = yt.poll();
    await io.entered;
    const closed = yt.quiescePoll();
    io.result.reject(Object.assign(new Error('provider failed'), { reason }));
    await Promise.all([poll, closed]);
    assert.equal(yt.running, false);
    // #63: la cuota ya no es fatal; tras el corte ordenado queda «parado» en ambos casos.
    assert.equal(yt.status.state, 'parado');
    assert.notEqual(yt.status.state, 'error');
  });
}

test('unexpected rejection waits other work and caches rejected close', async () => {
  const yt = fixture(), first = deferred(), second = deferred(), entered = deferred();
  let calls = 0;
  yt.api = () => { if (++calls === 2) entered.resolve(); return calls === 1 ? first.promise : second.promise; };
  yt.log = () => { throw new Error('logger failed'); };
  const a = yt.poll(), b = yt.poll();
  const aRejected = assert.rejects(a, /logger failed/);
  await entered.promise;
  const closed = yt.quiescePoll();
  const rejected = assert.rejects(closed, AggregateError);
  first.reject(new Error('IO failed'));
  await aRejected;
  await isPending(closed);
  second.resolve(response);
  await Promise.all([b, rejected]);
  assert.equal(yt.quiescePoll(), closed);
});

test('poll close includes causal token refresh, persistence and response body', async t => {
  const yt = fixture(), saving = deferred(), saved = deferred(), reading = deferred(), body = deferred();
  yt.cfg.apiKey = '';
  yt.store.secrets.youtube = { access: 'old', refresh: 'refresh', expiresAt: 0 };
  yt.store.setSecret = async (key, value) => { saving.resolve(); await saved.promise; yt.store.secrets[key] = value; };
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    paths.push(String(url));
    if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'new', expires_in: 3600 }) };
    reading.resolve();
    return { ok: true, json: () => body.promise };
  });
  const poll = yt.poll();
  await saving.promise;
  const closed = yt.quiescePoll();
  await isPending(closed);
  saved.resolve();
  await reading.promise;
  await isPending(closed);
  body.resolve(response);
  await Promise.all([poll, closed]);
  assert.equal(paths.length, 2);
  assert.equal(yt.token.access, 'new');
  assert.equal(yt.status.polls, 1);
});

test('ordinary stop remains restartable and terminal cut leaves outbound available', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture(), paths = [];
  yt.api = async (path, params, options) => {
    paths.push([path, options?.method]);
    return path === '/videos' ? videoResponse : response;
  };
  await yt.stop();
  await yt.start();
  await yt.quiescePoll();
  assert.equal(paths[0][0], '/videos');
  assert.equal((await yt.sendChat('still accepted')).sent, true);
  assert.deepEqual(paths.at(-1), ['/liveChat/messages', 'POST']);
});
