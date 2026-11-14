// Characterize the automatic-session lifecycle on the unchanged Meld consumer.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/server.mjs';
import { YouTubeAutoConnect } from '../../src/youtube-auto.mjs';
import { fakeMeldRecording } from './fake-meld-recording.mjs';
import { observeWire } from './meld-trace.mjs';
import { observeStatusConsumers } from './meld-trace-order.mjs';

export async function autoSessionTrace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ant-auto-trace-'));
  const fake = fakeMeldRecording({ streaming: true }), wire = observeWire(fake.server), trace = [];
  let app, release = () => {}, capture = false, statusDepth = 0;
  const begin = YouTubeAutoConnect.prototype.begin, end = YouTubeAutoConnect.prototype.end;
  t.after(async () => {
    release();
    YouTubeAutoConnect.prototype.begin = begin; YouTubeAutoConnect.prototype.end = end;
    if (app) { await app.drainAutoSession(); await app.session.flush(); app.meld.stop(); await app.closeHttp(); }
    await new Promise(resolve => fake.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  app = await createApp({ dataDir: path.join(dir, 'data'), mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const api = async (method, url, body) => {
    const result = await request(method, url, body);
    assert.equal(result.status, 200, `${method} ${url}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const sessionWhere = async predicate => {
    const deadline = performance.now() + 5000;
    for (;;) {
      const value = await api('GET', '/api/session');
      if (predicate(value)) return value;
      assert.ok(performance.now() < deadline, 'automatic session did not settle');
    }
  };
  const add = event => { if (capture) trace.push(event); };
  observeStatusConsumers(app, label => { if (label === 'recording-status') add(label); });
  const send = app.bus.send.bind(app.bus), setStatus = app.meld.setStatus.bind(app.meld);
  app.meld.setStatus = (...args) => { statusDepth++; try { return setStatus(...args); } finally { statusDepth--; } };
  app.bus.send = (name, data, kinds) => {
    if (statusDepth && name === 'status') add(`broadcast:${data.meld.state}:${data.meld.streaming}`);
    return send(name, data, kinds);
  };
  for (const [method, label] of [['startNew', 'session-start'], ['endCurrent', 'session-end'], ['captureIdentity', 'identity-check']]) {
    const original = app.session[method].bind(app.session);
    app.session[method] = (...args) => { add(label); return original(...args); };
  }
  YouTubeAutoConnect.prototype.begin = function (...args) { add('youtube-begin'); return begin.apply(this, args); };
  YouTubeAutoConnect.prototype.end = function (...args) { add('youtube-end'); return end.apply(this, args); };
  app.meld.on('streaming', live => add(`later-raw-streaming:${live}`));
  await api('POST', '/api/config/set', { path: 'meld.autoSession', value: true });
  const initial = await api('GET', '/api/session');

  // onInit publishes only status, not streaming, when Meld is already live.
  trace.push('connect-already-live'); capture = true;
  let idle = wire.idleCount();
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
  await wire.waitIdleAfter(idle);
  const first = await sessionWhere(s => s.id !== initial.id && s.meldAutoSession === true);
  capture = false;
  trace.push({ currentChanged: first.id !== initial.id, auto: first.meldAutoSession, ended: !!first.endedAt });

  // Reconnection while live must capture an identity boundary, not create another session.
  await api('POST', '/api/meld/disconnect');
  trace.push('reconnect-live'); capture = true; idle = wire.idleCount();
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
  await wire.waitIdleAfter(idle);
  const reconnected = await api('GET', '/api/session'); capture = false;
  assert.equal(reconnected.id, first.id);
  trace.push({ sameId: reconnected.id === first.id, auto: reconnected.meldAutoSession, ended: !!reconnected.endedAt });

  // A status-only offline observation closes the running automatic session.
  trace.push('status-offline'); capture = true;
  app.meld.setStatus({ state: 'conectado', streaming: false, streamingKnown: true });
  const ended = await sessionWhere(s => s.id === first.id && !!s.endedAt); capture = false;
  trace.push({ sameId: ended.id === first.id, auto: ended.meldAutoSession, ended: !!ended.endedAt });

  // Hold a real manual close at its durable flush, then announce the next live twice.
  app.meld.setStatus({ state: 'conectado', streaming: true });
  const second = await sessionWhere(s => s.id !== first.id && s.meldAutoSession === true);
  app.meld.setStatus({ state: 'reintentando' });
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const flush = app.session.flush.bind(app.session); let held = false;
  app.session.flush = async (...args) => { if (!held) { held = true; entered(); await gate; } return flush(...args); };
  trace.push('manual-close-pending-new-live'); capture = true;
  const closing = request('POST', '/api/session/end', { id: second.id });
  await Promise.race([waiting, closing.then(result => { throw new Error(`manual close was not held: ${result.status}`); })]);
  app.meld.setStatus({ state: 'conectado', streaming: true });
  app.meld.setStatus({ state: 'conectado', streaming: true });
  release();
  const closed = await closing;
  assert.equal(closed.status, 200); assert.equal(closed.body.session.id, second.id); assert.ok(closed.body.session.endedAt);
  const third = await sessionWhere(s => s.id !== second.id && s.meldAutoSession === true);
  const history = await api('GET', '/api/sessions');
  const archive = await api('GET', `/api/session/summary?format=json&id=${second.id}`);
  capture = false;
  trace.push({ closedSameId: closed.body.session.id === second.id, archivedOnce: history.past.filter(s => s.id === second.id).length === 1,
    archiveEnded: archive.endedAt === closed.body.session.endedAt, nextChanged: third.id !== second.id, auto: third.meldAutoSession, ended: !!third.endedAt });

  // Real fake-Meld updates exercise streaming before status and YouTube begin/end.
  trace.push('streaming-stop'); capture = true; idle = wire.idleCount();
  fake.report({ streaming: false }); await wire.waitIdleAfter(idle);
  const stopped = await sessionWhere(s => s.id === third.id && !!s.endedAt); capture = false;
  trace.push({ sameId: stopped.id === third.id, ended: !!stopped.endedAt });
  trace.push('streaming-start'); capture = true; idle = wire.idleCount();
  fake.report({ streaming: true }); await wire.waitIdleAfter(idle);
  const fourth = await sessionWhere(s => s.id !== third.id && s.meldAutoSession === true); capture = false;
  trace.push({ nextChanged: fourth.id !== third.id, auto: fourth.meldAutoSession, ended: !!fourth.endedAt });

  // Start a separate reading trace after the previous session is fully stopped.
  idle = wire.idleCount(); fake.report({ streaming: false }); await wire.waitIdleAfter(idle);
  await sessionWhere(s => s.id === fourth.id && !!s.endedAt);
  await new Promise(resolve => setImmediate(resolve));
  app.store.config.meld.autoSession = false;
  app.store.config.youtube = { ...app.store.config.youtube, apiKey: 'fake', channelId: 'UCcanal' };
  const youtube = [], yt = app.youtube, start = yt.start.bind(yt), stop = yt.stop.bind(yt);
  let failStop = false, stopRejected;
  yt.start = (...args) => { youtube.push('start'); return start(...args); };
  yt.stop = (...args) => {
    youtube.push('stop');
    if (failStop) { youtube.push('stop-rejected'); stopRejected(); return Promise.reject(new Error('simulated stop failure')); }
    return stop(...args);
  };
  yt.api = async name => {
    if (name === '/channels') return { items: [] }; // unrelated channel totals
    youtube.push(`api:${name}`);
    if (name === '/search') return { items: [{ id: { videoId: 'abcdefghijk' } }] };
    if (name === '/videos') return { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-1' }, snippet: { title: 'Directo' } }] };
    throw new Error(`unexpected fake YouTube API: ${name}`);
  };
  yt.poll = () => { youtube.push('poll'); return Promise.resolve(); };
  yt.on('status', status => youtube.push(`state:${status.state}`));
  YouTubeAutoConnect.prototype.begin = function (...args) { youtube.push('begin'); return begin.apply(this, args); };
  YouTubeAutoConnect.prototype.end = function (...args) { youtube.push('end'); return end.apply(this, args); };
  const snapshot = ({ state, videoId, liveChatId, notice, retryAt, errors }) =>
    ({ state, videoId, liveChatId, notice: notice ?? null, retryAt: retryAt ?? null, errors });
  const youtubeWhere = async predicate => {
    const deadline = performance.now() + 5000;
    for (;;) {
      const status = (await api('GET', '/api/status')).youtube;
      if (predicate(status)) return snapshot(status);
      assert.ok(performance.now() < deadline, 'YouTube reading did not settle');
    }
  };
  const stream = async live => { const count = wire.idleCount(); fake.report({ streaming: live }); await wire.waitIdleAfter(count); };
  const listening = s => s.state === 'escuchando' && s.liveChatId === 'chat-1';
  const cleared = s => s.state === 'parado' && s.videoId === null && s.liveChatId === null;

  youtube.push('stream-start'); await stream(true); youtube.push(await youtubeWhere(listening));
  youtube.push('repeated-live-status'); app.meld.setStatus({ state: 'conectado', streaming: true });
  youtube.push(await youtubeWhere(listening));
  const rejected = new Promise(resolve => { stopRejected = resolve; });
  youtube.push('stream-stop-failure'); failStop = true; await stream(false); await rejected;
  await new Promise(resolve => setImmediate(resolve)); // an unhandled end rejection fails node:test
  youtube.push(snapshot((await api('GET', '/api/status')).youtube));
  youtube.push('recover-live'); failStop = false; await stream(true); youtube.push(await youtubeWhere(listening));
  youtube.push('stream-stop'); await stream(false); youtube.push(await youtubeWhere(cleared));
  await api('POST', '/api/meld/disconnect');
  youtube.push('connect-already-live'); idle = wire.idleCount();
  await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${fake.server.address().port}` });
  await wire.waitIdleAfter(idle); youtube.push(await youtubeWhere(listening));
  youtube.push('stop-after-connect'); await stream(false); youtube.push(await youtubeWhere(cleared));
  return { trace, youtube };
}
