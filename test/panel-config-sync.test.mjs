// #351: every config section the panel edits reaches it when it changes outside the panel
// (MCP, another window, generic config API, import), and keeps travelling in later config
// events because the bus retains only the latest 'config' snapshot per client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

function sink() {
  const res = new EventEmitter();
  res.frames = [];
  res.writableLength = 0;
  res.write = frame => { res.frames.push(frame); return true; };
  res.events = name => res.frames.filter(f => f.startsWith(`event: ${name}\n`)).map(f => JSON.parse(f.split('\ndata: ')[1]));
  return res;
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-panel-config-sync-'));
  const app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  t.after(() => app.closeHttp());
  const panel = sink(), widget = sink();
  app.bus.addClient(panel, 'panel');
  app.bus.addClient(widget, 'widget');
  return { app, panel, widget, last: () => panel.events('config').at(-1) };
}

const CHANGES = [
  ['overlay', { overlay: { css: '.alert { color: red; }', volume: 0.4 } }, c => c.overlay.css === '.alert { color: red; }' && c.overlay.volume === 0.4],
  ['commands', { commands: [{ id: 'hola', trigger: '!hola', response: 'Hola' }] }, c => c.commands?.[0]?.trigger === '!hola'],
  ['timers', { timers: [{ id: 't1', message: 'Sígueme', intervalMin: 10, enabled: true }] }, c => c.timers?.[0]?.message === 'Sígueme'],
  ['filters', { filters: { blockedWords: ['spoiler'] } }, c => c.filters?.blockedWords?.[0] === 'spoiler'],
  ['tts', { tts: { rate: 1.2 } }, c => c.tts?.rate === 1.2],
  ['meld', { meld: { autoSession: true } }, c => c.meld?.autoSession === true],
  ['panel', { panel: { onboardingDone: true } }, c => c.panel?.onboardingDone === true],
];

test('each panel-edited section changed outside the panel reaches it and keeps travelling', async t => {
  const { app, panel, widget, last } = await fixture(t);
  for (const [name, patch, check] of CHANGES) {
    const before = panel.events('config').length;
    await app.store.patchConfig(patch);
    assert.ok(panel.events('config').length > before, `${name}: a config event reaches the panel`);
    assert.ok(check(last()), `${name}: the panel gets the new value`);
  }
  // Sticky: the latest snapshot still carries every section changed before it.
  for (const [name, , check] of CHANGES) assert.ok(check(last()), `${name}: still present in the latest config event`);
  assert.equal(widget.events('config').length, 0, 'config stays panel-only');
});

test('secrets stay masked in the config sections sent to the panel', async t => {
  const { app, last } = await fixture(t);
  await app.store.patchConfig({ youtube: { apiKey: 'SYNTHETIC_YT_KEY_1234' } });
  const sent = last();
  assert.ok(sent.youtube, 'youtube settings reach the panel');
  assert.notEqual(sent.youtube.apiKey, 'SYNTHETIC_YT_KEY_1234');
  assert.match(sent.youtube.apiKey, /^••••/);
  assert.doesNotMatch(JSON.stringify(sent), /SYNTHETIC_YT_KEY_1234/);
});

test('a timers change also refreshes the timers list the panel shows', async t => {
  const { app, panel } = await fixture(t);
  const before = panel.events('timers').length;
  await app.store.patchConfig({ timers: [{ id: 't1', message: 'Sígueme', intervalMin: 10, enabled: true }] });
  assert.ok(panel.events('timers').length > before, 'the timers snapshot reaches the panel');
});

test('config import (all) sends every panel-edited section at once', async t => {
  const { app, last } = await fixture(t);
  app.store.emit('change', { all: true });
  const sent = last();
  for (const key of ['prompter', 'chat', 'alerts', 'overlay', 'commands', 'timers', 'filters', 'tts', 'meld', 'youtube', 'twitch', 'panel', 'sessions']) {
    assert.ok(Object.hasOwn(sent, key), `${key} is part of the full snapshot`);
  }
});

test('interactive, teleprompter and viewers settings written through the generic config reach the panel', async t => {
  const { app, panel } = await fixture(t);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (const [section, event] of [['interactive', 'interactive'], ['teleprompter', 'teleprompter'], ['viewers', 'viewers']]) {
    const before = panel.events(event).length;
    await app.store.patchConfig({ [section]: {} });   // e.g. PUT /api/config or /api/config/set from MCP
    await wait(250);   // interactive snapshots are burst-coalesced
    assert.ok(panel.events(event).length > before, `${section}: the panel gets a fresh ${event} snapshot`);
  }
});

test('meld connect/disconnect and OBS password writes reach the panel with correct passwordSet and no secret in any client', async t => {
  const { app, panel, widget } = await fixture(t);
  for (const o of [app.meld, app.program, app.obs].filter(Boolean)) o.start = () => {};   // never touch a real Meld/OBS
  await new Promise((r, j) => { app.server.once('error', j); app.server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (m, u, b) => fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) });
  const last = () => panel.events('config').at(-1);
  assert.equal((await call('PUT', '/api/config', { obs: { password: 'SYNTH_OBS_PW_1' } })).status, 200);
  assert.equal(last().obs.passwordSet, true);
  assert.equal((await call('POST', '/api/config/set', { path: 'obs.password', value: '' })).status, 200);
  assert.equal(last().obs.passwordSet, false);
  assert.equal((await call('POST', '/api/meld/connect')).status, 200);
  assert.equal(last().meld.enabled, true);
  assert.equal((await call('POST', '/api/meld/disconnect')).status, 200);
  assert.equal(last().meld.enabled, false);
  for (const f of [...panel.frames, ...widget.frames]) assert.doesNotMatch(f, /SYNTH_OBS_PW_1/);
});

test('viewers written through the generic config send only the public projection to widgets', async t => {
  const { app, panel, widget } = await fixture(t);
  await app.store.patchConfig({ viewers: {} });
  assert.deepEqual(Object.keys(widget.events('viewers').at(-1)).sort(), ['twitch', 'youtube']);
  assert.ok(Object.hasOwn(panel.events('viewers').at(-1), 'settings'));
});
