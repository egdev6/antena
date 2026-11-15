import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { createProgram } from '../src/programs/index.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { waitFor } from './helpers/program-contract.mjs';
import { closeChrome, openChromePage, skipIfNoBrowserOrUi, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const inputs = () => [
  { inputName: 'Micro', inputUuid: 'mic', inputVolumeMul: 0.5 },
  { inputName: 'Music', inputUuid: 'music', inputMuted: true, inputVolumeMul: 0.1, monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY' },
  { inputName: 'Boost', inputUuid: 'boost', inputVolumeMul: 2, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
  { inputName: 'Silent', inputUuid: 'silent', inputVolumeMul: 0 },
  { inputName: 'Logo', inputUuid: 'logo', inputKind: 'image_source', audio: false },
  { inputName: 'Audio image', inputUuid: 'audio-image', inputKind: 'image_source', audio: true },
];
const scenes = [{ sceneName: 'Camera', sceneUuid: 'camera', sceneItems: [{ sourceName: 'Micro', sceneItemId: 1 }] }];
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
const url = fake => `ws://127.0.0.1:${fake.server.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'observable state did not arrive'); await delay(5); }
}
async function fixture(t, opts = {}) {
  const fake = fakeObs({ scenes, inputs: inputs(), ...opts });
  const program = createProgram('obs', { retryDelays: [10, 20] });
  t.after(async () => { await program.quiesceClose(); program.dispose(); await fake.close(); });
  await listen(fake.server);
  const ready = waitFor(program, 'status', s => s.state === 'conectado');
  program.start(url(fake)); await ready;
  return { fake, program };
}
const track = (id, name, muted, monitoring, gain) => ({ id, name, muted, monitoring, parent: null, gain });

test('OBS audio enumeration uses capability, linear gain, monitoring and immutable session copies', async t => {
  const { fake, program } = await fixture(t);
  assert.equal(program.capabilities.has('audio-tracks'), true);
  assert.deepEqual(program.session().tracks, [
    track('mic', 'Micro', false, false, 0.5), track('music', 'Music', true, true, 0.1),
    track('boost', 'Boost', false, true, 1), track('silent', 'Silent', false, false, 0),
    track('audio-image', 'Audio image', false, false, 1),
  ]);
  assert.equal(fake.requests.filter(r => r.requestType === 'GetInputAudioTracks').length, 6);
  const copy = program.session(); copy.tracks[0].gain = 0; copy.tracks.pop();
  assert.equal(program.session().tracks[0].gain, 0.5);
  assert.equal(program.session().tracks.length, 5);
});

test('OBS keeps all audio tracks when image and browser inputs have no audio', async t => {
  const { fake, program } = await fixture(t, { inputs: [
    { inputName: 'Mic', inputUuid: 'mic', inputVolumeMul: 0.5 },
    { inputName: 'Picture', inputUuid: 'picture', inputKind: 'image_source' },
    { inputName: 'Music', inputUuid: 'music', inputMuted: true, inputVolumeMul: 0.25 },
    { inputName: 'Browser', inputUuid: 'browser', inputKind: 'browser_source', audio: false },
  ] });
  assert.deepEqual(program.session().tracks, [
    track('mic', 'Mic', false, false, 0.5), track('music', 'Music', true, false, 0.25),
  ]);
  assert.deepEqual(fake.requests.filter(r => r.requestType === 'GetInputAudioTracks').map(r => r.requestData.inputUuid),
    ['mic', 'picture', 'music', 'browser']);
});

test('a rejected audio query for one input does not discard surviving tracks', async t => {
  for (const type of ['GetInputAudioTracks', 'GetInputMute', 'GetInputVolume', 'GetInputAudioMonitorType']) {
    for (const code of [600, 602, 604, 500]) {
      await t.test(`${type}: ${code}`, async t => {
        const fake = fakeObs({ scenes, inputs: [
          { inputName: 'Mic', inputUuid: 'mic', inputVolumeMul: 0.5 },
          { inputName: 'Unavailable', inputUuid: 'bad' },
          { inputName: 'Music', inputUuid: 'music', inputMuted: true, inputVolumeMul: 0.25 },
        ] });
        const program = createProgram('obs', { retryDelays: [10] });
        t.after(async () => { await program.quiesceClose(); program.dispose(); await fake.close(); });
        fake.failRequest(type, { code, comment: 'scoped failure' }, { inputUuid: 'bad' });
        await listen(fake.server);
        const ready = waitFor(program, 'status', s => s.state === 'conectado');
        program.start(url(fake)); await ready;
        assert.deepEqual(program.session().tracks, [
          track('mic', 'Mic', false, false, 0.5), track('music', 'Music', true, false, 0.25),
        ]);
        assert.deepEqual(fake.requests.filter(r => r.requestType === type).map(r => r.requestData.inputUuid), ['mic', 'bad', 'music']);
      });
    }
  }
});

test('OBS mute and gain actions match Meld arguments, results, clamping and errors', async t => {
  const { fake, program } = await fixture(t), before = fake.requests.length;
  assert.equal(await program.toggleMute('mICRO'), undefined);
  assert.equal(program.session().tracks[0].muted, true);
  for (const [value, expected] of [[0, 0], ['0.25', 0.25], [1, 1], [-2, 0], [2, 1]]) {
    assert.equal(await program.setGain('mic', value), expected);
    assert.equal(program.session().tracks[0].gain, expected);
  }
  assert.deepEqual(fake.requests.slice(before), [
    { requestType: 'ToggleInputMute', requestData: { inputUuid: 'mic' } },
    ...[0, 0.25, 1, 0, 1].map(inputVolumeMul => ({ requestType: 'SetInputVolume', requestData: { inputUuid: 'mic', inputVolumeMul } })),
  ]);
  const snapshot = program.session(), count = fake.requests.length;
  await assert.rejects(program.toggleMute('missing'), { message: 'No encuentro la pista «missing»' });
  await assert.rejects(program.setGain('missing', 0.5), { message: 'No encuentro la pista «missing»' });
  assert.equal(fake.requests.length, count); assert.deepEqual(program.session(), snapshot);
  fake.failRequest('SetInputVolume');
  await assert.rejects(program.setGain('mic', 0.2), { message: 'OBS rechazó la petición «SetInputVolume».' });
  assert.deepEqual(program.session(), snapshot);
});

test('unrelated scene request failures retain their previous public error shape', async t => {
  const { fake, program } = await fixture(t), before = program.session();
  fake.failRequest('SetCurrentProgramScene', { code: 600, comment: 'unavailable' });
  await assert.rejects(program.showScene('Camera'), error => {
    assert.equal(error.message, 'OBS rechazó la petición «SetCurrentProgramScene».');
    assert.equal(Object.hasOwn(error, 'obsCode'), false);
    return true;
  });
  assert.deepEqual(program.session(), before);
});

test('each OBS input event updates tracks and publishes exactly one session', async t => {
  const { fake, program } = await fixture(t), snapshots = [];
  program.on('session', s => snapshots.push(s));
  const event = async (emit, check) => {
    const before = snapshots.length, published = waitFor(program, 'session');
    emit(); await published; await delay(30);
    assert.equal(snapshots.length, before + 1);
    assert.deepEqual(snapshots.at(-1), program.session()); check(program.session());
  };
  await event(() => fake.emit('InputMuteStateChanged', { inputUuid: 'mic', inputName: 'Micro', inputMuted: true }),
    s => assert.equal(s.tracks[0].muted, true));
  await event(() => fake.emit('InputVolumeChanged', { inputUuid: 'mic', inputName: 'Micro', inputVolumeMul: 0.25, inputVolumeDb: -12.0412 }),
    s => assert.equal(s.tracks[0].gain, 0.25));
  for (const [monitorType, expected] of [['OBS_MONITORING_TYPE_MONITOR_ONLY', true], ['OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT', true], ['OBS_MONITORING_TYPE_NONE', false]])
    await event(() => fake.emit('InputAudioMonitorTypeChanged', { inputUuid: 'mic', inputName: 'Micro', monitorType }),
      s => assert.equal(s.tracks[0].monitoring, expected));
  await event(() => fake.addInput({ inputName: 'Guest', inputUuid: 'guest', inputVolumeMul: 0.75 }),
    s => assert.deepEqual(s.tracks.at(-1), track('guest', 'Guest', false, false, 0.75)));
  await event(() => fake.renameInput('Micro', 'Voice'), s => {
    assert.equal(s.tracks[0].name, 'Voice'); assert.equal(s.scenes[0].layers[0].name, 'Voice');
  });
  await event(() => fake.removeInput('Guest'), s => assert.equal(s.tracks.some(x => x.id === 'guest'), false));
  await event(() => fake.addInput({ inputName: 'Picture', inputUuid: 'picture', audio: false }),
    s => assert.equal(s.tracks.some(x => x.id === 'picture'), false));
  await event(() => fake.removeInput('Picture'), s => assert.equal(s.tracks.some(x => x.id === 'picture'), false));
});

test('overlapping input renames each publish one updated session', async t => {
  const { fake, program } = await fixture(t), snapshots = [];
  fake.delayRequest('GetSceneItemList', 100);
  program.on('session', s => snapshots.push(s));
  fake.renameInput('Micro', 'Voice'); fake.renameInput('Voice', 'Narrator');
  await until(() => snapshots.length >= 2);
  assert.deepEqual(snapshots.map(s => s.tracks[0].name), ['Narrator', 'Narrator']);
  assert.deepEqual(snapshots.map(s => s.scenes[0].layers[0].name), ['Narrator', 'Narrator']);
  await delay(150);
  assert.equal(snapshots.length, 2);
});

test('input created during initial enumeration is not lost', async t => {
  const fake = fakeObs({ scenes, inputs: inputs() });
  const program = createProgram('obs', { retryDelays: [10] });
  t.after(async () => { await program.quiesceClose(); program.dispose(); await fake.close(); });
  fake.delayRequest('GetInputAudioTracks', 100); await listen(fake.server);
  const ready = waitFor(program, 'status', s => s.state === 'conectado');
  program.start(url(fake));
  await until(() => fake.requests.some(r => r.requestType === 'GetInputAudioTracks'));
  fake.addInput({ inputName: 'Guest', inputUuid: 'guest', inputVolumeMul: 0.75 });
  await ready;
  assert.deepEqual(program.session().tracks.at(-1), track('guest', 'Guest', false, false, 0.75));
});

test('input event during a track re-enumeration is not overwritten by stale values', async t => {
  const fake = fakeObs({ scenes: [{ sceneName: 'S', sceneUuid: 's' }], inputs: [{ inputName: 'Mic', inputUuid: 'mic', inputVolumeMul: 0.5 }] });
  const program = createProgram('obs', { retryDelays: [10] });
  t.after(async () => { await program.quiesceClose(); program.dispose(); await fake.close(); });
  await listen(fake.server);
  const ready = waitFor(program, 'status', s => s.state === 'conectado');
  program.start(url(fake)); await ready;
  fake.delayRequest('GetInputVolume', 150);
  const mark = fake.requests.length;
  fake.addInput({ inputName: 'Guest', inputUuid: 'guest' });
  await until(() => fake.requests.slice(mark).some(r => r.requestType === 'GetInputMute' && r.requestData.inputUuid === 'mic'));
  await delay(20);
  await program.toggleMute('mic');
  fake.delayRequest('GetInputVolume', 0);
  await delay(600);
  assert.deepEqual(program.session().tracks.map(x => [x.id, x.muted]), [['mic', true], ['guest', false]]);
});

test('input removed while volume queries are pending does not discard surviving tracks', async t => {
  const fake = fakeObs({ scenes, inputs: inputs() });
  const program = createProgram('obs', { retryDelays: [10] });
  t.after(async () => { await program.quiesceClose(); program.dispose(); await fake.close(); });
  fake.delayRequest('GetInputVolume', 100); await listen(fake.server);
  const ready = waitFor(program, 'status', s => s.state === 'conectado');
  program.start(url(fake));
  await until(() => fake.requests.some(r => r.requestType === 'GetInputVolume' && r.requestData.inputUuid === 'mic'));
  fake.removeInput('Micro'); await ready;
  assert.deepEqual(program.session().tracks.map(t => t.id), ['music', 'boost', 'silent', 'audio-image']);
});

async function appFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-audio-')), fake = fakeObs({ scenes, inputs: inputs() });
  let app;
  t.after(async () => {
    if (app) { await app.drainAutoSession(); await app.session.flush(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); }
    await fake.close(); await rm(root, { recursive: true, force: true });
  });
  await listen(fake.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, endpoint, body) => {
    const r = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  };
  const ready = waitFor(app.program, 'status', s => s.state === 'conectado');
  assert.equal((await call('PUT', '/api/config', { program: { kind: 'obs' }, obs: { url: url(fake) }, prompter: { micTrack: 'Micro' } })).status, 200);
  await ready;
  return { fake, app, base, call };
}

test('OBS audio works through both HTTP aliases and the prompter session', async t => {
  const { fake, app, call } = await appFixture(t);
  for (const route of ['/api/program', '/api/meld']) {
    const r = await call('GET', route);
    assert.equal(r.status, 200); assert.deepEqual(r.body.tracks, app.program.session().tracks);
  }
  assert.equal((await call('GET', '/api/state')).body.config.prompter.micTrack, 'Micro');
  assert.deepEqual(await call('POST', '/api/program/track', { track: 'mic', action: 'gain', gain: 0.42 }), { status: 200, body: { ok: true } });
  assert.deepEqual(await call('POST', '/api/meld/track', { track: 'Micro' }), { status: 200, body: { ok: true } });
  assert.equal(app.program.session().tracks[0].gain, 0.42);
  assert.equal(app.program.session().tracks[0].muted, true);
  const before = app.program.session(), count = fake.requests.length, persistence = (await call('GET', '/api/status')).body.persistence;
  assert.deepEqual(await call('POST', '/api/program/track', { track: 'missing' }), { status: 500, body: { error: 'No encuentro la pista «missing»' } });
  assert.equal(fake.requests.length, count); assert.deepEqual(app.program.session(), before);
  assert.deepEqual((await call('GET', '/api/status')).body.persistence, persistence);
});

test('dock and prompter render and control OBS audio', { timeout: 60000 }, async t => {
  const bin = await skipIfNoBrowserOrUi(t); if (!bin) return;
  const { app, base, fake } = await appFixture(t);
  const dock = await openChromePage(bin, `${base}/dock`);
  t.after(() => closeChrome(dock));
  await dock.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1256, height: 780, deviceScaleFactor: 1, mobile: false });
  await waitDom(dock.cdp, `document.querySelector('input[aria-label="Volumen de Micro"]')?.value === '50'`);
  await clickWhen(dock.cdp, `document.querySelector('[role="switch"][aria-label="Desactivar Micro"]')`);
  await waitDom(dock.cdp, `document.querySelector('[role="switch"][aria-label="Activar Micro"]')?.getAttribute('aria-checked') === 'false'`);
  const prompter = await openChromePage(bin, `${base}/prompter`);
  t.after(() => closeChrome(prompter));
  await waitDom(prompter.cdp, `document.querySelector('.pr-mic')?.textContent.includes('Micro silenciado')`);
  await evaluateChrome(dock.cdp, `(() => { const el = document.querySelector('input[aria-label="Volumen de Micro"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '75'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(() => fake.requests.some(r => r.requestType === 'SetInputVolume' && r.requestData.inputVolumeMul === 0.75) && app.program.session().tracks[0].gain === 0.75);
  assert.equal(app.program.session().tracks[0].gain, 0.75);
  const panel = await openChromePage(bin, `${base}/#/meld/audio`);
  t.after(() => closeChrome(panel));
  await waitDom(panel.cdp, `!!document.querySelector('[aria-label="Activar Micro"]')`);
  await clickWhen(panel.cdp, `document.querySelector('[aria-label="Activar Micro"]')`);
  await waitDom(dock.cdp, `document.querySelector('[role="switch"][aria-label="Desactivar Micro"]')?.getAttribute('aria-checked') === 'true'`);
  await waitDom(prompter.cdp, `!document.querySelector('.pr-mic')`);
});
