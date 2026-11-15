import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Meld } from '../src/meld.mjs';
import { MeldAdapter } from '../src/programs/meld-adapter.mjs';
import { createProgram } from '../src/programs/index.mjs';
import { fakeMeldRecording } from './helpers/fake-meld-recording.mjs';
import { programContract, waitFor } from './helpers/program-contract.mjs';

const capabilities = ['scene-layers', 'layer-effects', 'audio-tracks', 'streaming', 'recording',
  'widget-events', 'confetti', 'clips', 'media-controls', 'raw-meld-rpc'];
const initialStatus = { state: 'desconectado', streaming: false, streamingKnown: false, recording: false,
  recordingKnown: false, recordingWarning: null, version: null, error: null };
const connectedStatus = { ...initialStatus, state: 'conectado', streamingKnown: true, recordingKnown: true, version: 2 };
const initialSession = {
  scenes: [
    { id: 's1', name: 'Cámara', current: true, staged: false, layers: [
      { id: 'l1', name: 'Alertas', visible: false, url: '', effects: [{ id: 'e1', name: 'Blur', enabled: true }] },
      { id: 'l2', name: 'Fondo', visible: true, url: '', effects: [] },
    ] },
    { id: 's2', name: 'Pantalla', current: false, staged: false, layers: [] },
  ],
  tracks: [{ id: 't1', name: 'Micro', muted: false, monitoring: false, parent: null, gain: null }],
  streaming: false, recording: false,
};
const changedSession = structuredClone(initialSession);
changedSession.scenes[0].current = false; changedSession.scenes[1].current = true;
const layerSession = structuredClone(changedSession);
layerSession.scenes[0].layers[0].visible = true;
const mutedSession = structuredClone(layerSession);
mutedSession.tracks[0].muted = true;
const gainSession = structuredClone(mutedSession);
gainSession.tracks[0].gain = 0.25;
const items = {
  s2: { type: 'scene', name: 'Pantalla', index: 1, current: false },
  s1: { type: 'scene', name: 'Cámara', index: 0, current: true },
  l2: { type: 'layer', parent: 's1', name: 'Fondo', index: 1, visible: true },
  l1: { type: 'layer', parent: 's1', name: 'Alertas', index: 0, visible: false },
  e1: { type: 'effect', parent: 'l1', name: 'Blur', enabled: true },
  t1: { type: 'track', name: 'Micro', muted: false },
};
const actions = {
  showScene: [
    { args: ['Pantalla'], calls: [[10, 's2']], session: changedSession },
    { args: ['missing'], calls: [], error: { name: 'Error', message: 'No encuentro la escena «missing» en Meld' } },
  ],
  setLayer: [
    { args: ['Cámara', 'Alertas', true], calls: [[11, 's1', 'l1']], session: layerSession },
    { args: ['Cámara', 'Alertas', true], calls: [], session: layerSession },
  ],
  toggleEffect: [{ args: ['Cámara', 'Alertas', 'Blur'], calls: [[15, 's1', 'l1', 'e1']], result: undefined }],
  command: [{ args: ['meld.startRecordingAction'], calls: [[12, 'meld.startRecordingAction']], result: null }],
  streamEvent: [
    { args: ['COUNTER_INCREMENT', { amount: 2 }], calls: [[13, 'COUNTER_INCREMENT', { amount: 2 }]], result: null },
    { args: ['CONFETTIPOP_TRIGGER'], calls: [[13, 'CONFETTIPOP_TRIGGER']], result: null },
  ],
  toggleMute: [{ args: ['Micro'], calls: [[14, 't1']], result: undefined, session: mutedSession }],
  setGain: [{ args: ['Micro', 0.25], calls: [[16, 't1', 0.25]], result: 0.25, session: gainSession }],
  media: [
    { args: ['Alertas', 'play'], calls: [[20, 'l1', 'play']], result: null },
    { args: ['Alertas', 'seekTo', 2], calls: [[19, 'l1', 'seekTo', [2]]], result: null },
  ],
  setProperty: [{ args: ['l1', 'x', 42], calls: [[21, 'l1', 'x', 42]], result: null }],
  call: [{ args: ['sendCommand', 'custom.command'], calls: [[12, 'custom.command']], result: null }],
};

// Extend only the fake's advertised methods and observe every client WebChannel
// frame, including init, signal subscriptions, observer RPCs and idle messages.
function observeWire(server) {
  const messages = [], payloads = [], notify = new EventEmitter(), held = [];
  let holding = false;
  server.prependListener('upgrade', (_req, socket) => {
    const write = socket.write.bind(socket);
    socket.write = (chunk, ...args) => {
      if (Buffer.isBuffer(chunk) && chunk[0] === 0x81) {
        const offset = (chunk[1] & 127) === 126 ? 4 : 2;
        const message = JSON.parse(chunk.subarray(offset).toString());
        if (holding && message.type === 2) { held.push(() => write(chunk, ...args)); return true; }
        if (message.data?.meld) {
          message.data.meld.methods.push(['callFunctionWithArgs', 19], ['callFunction', 20], ['setProperty', 21]);
          const data = Buffer.from(JSON.stringify(message));
          const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
          chunk = Buffer.concat([head, data]);
        }
      }
      return write(chunk, ...args);
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        assert.notEqual(size, 127);
        if (buffer.length < offset + 4 + size) return;
        assert.ok(buffer[1] & 128);
        const mask = buffer.subarray(offset, offset + 4);
        const body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size).map((b, i) => b ^ mask[i % 4]));
        const opcode = buffer[0] & 15;
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 1) { payloads.push(body); messages.push(JSON.parse(body.toString())); notify.emit('message'); }
        else assert.ok(opcode >= 8);
      }
    });
  });
  const idle = () => messages.filter(m => m.type === 4).length;
  return {
    messages, payloads, idle,
    async until(predicate) { if (!predicate()) await waitFor(notify, 'message', predicate); },
    holdUpdates() { holding = true; },
    // Flush before asserting so a failed check can never leave the fake holding updates and hang teardown.
    releaseUpdates() { holding = false; const pending = held.splice(0); for (const send of pending) send(); assert.equal(pending.length, 1); },
  };
}

async function makeDriver() {
  const fake = fakeMeldRecording(), wire = observeWire(fake.server), program = new Meld(() => {});
  fake.state.session.items = structuredClone(items);
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  let settled = 0;
  return {
    program, wire, capabilities, initialStatus, connectedStatus, initialSession, changedSession, actions,
    url: `ws://127.0.0.1:${fake.server.address().port}`,
    async ready() { await wire.until(() => wire.idle() >= 2); settled = wire.idle(); },
    async settle() { await wire.until(() => wire.idle() > settled); settled = wire.idle(); },
    calls: () => fake.state.calls,
    report: values => fake.report(values),
    changeSession: () => fake.setCurrentScenes(['s2']),
    emit: (...args) => program.emit(...args),
    on: (...args) => program.on(...args),
    async close() { await program.quiesceClose(); await new Promise(resolve => fake.server.close(resolve)); },
  };
}

programContract(program => new MeldAdapter(program), makeDriver);

test('Meld adapter exposes its raw instance read-only for diagnostics', () => {
  const log = () => {}, supplied = new Meld(log);
  for (const [adapter, expected] of [[new MeldAdapter(supplied), supplied], [createProgram('meld', { log }), null]]) {
    const raw = adapter.raw;
    assert.ok(raw instanceof Meld);
    if (expected) assert.strictEqual(raw, expected);
    assert.strictEqual(raw.log, log);
    assert.throws(() => { adapter.raw = new Meld(log); }, TypeError);
    assert.strictEqual(adapter.raw, raw);
    adapter.dispose();
  }
});

test('Meld adapter delegates arguments, receiver, return/promise identity and failures', async () => {
  const meld = new Meld(() => {}), adapter = new MeldAdapter(meld), other = new MeldAdapter(new Meld(() => {}));
  const methods = ['start', 'stop', 'quiesceClose', 'setStatus', 'session', 'showScene', 'setLayer', 'toggleEffect',
    'command', 'streamEvent', 'toggleMute', 'setGain', 'media', 'setProperty', 'call'];
  const args = [{ value: 1 }, undefined, 'extra'], value = Promise.resolve({ value: 2 });
  for (const name of methods) {
    meld[name] = function (...received) {
      assert.strictEqual(this, meld); assert.deepEqual(received, args); assert.strictEqual(received[0], args[0]); return value;
    };
    assert.strictEqual(adapter[name](...args), value, name);
  }
  assert.strictEqual(adapter.status, meld.status);
  meld.status = { ...meld.status, state: 'conectado' };
  assert.equal(adapter.connected, meld.connected);
  adapter.capabilities.add('test-only');
  assert.equal(other.capabilities.has('test-only'), false);
  const failure = new Error('failure');
  meld.command = () => { throw failure; };
  assert.throws(() => adapter.command('x'), e => e === failure);
  const rejected = Promise.reject(failure);
  meld.call = () => rejected;
  assert.strictEqual(adapter.call('x'), rejected);
  await assert.rejects(rejected, e => e === failure);
  adapter.dispose(); other.dispose();
});

test('raw Meld and the adapter produce identical WebChannel messages and events', { timeout: 30000 }, async t => {
  const raw = await makeDriver(), wrapped = await makeDriver(), adapter = new MeldAdapter(wrapped.program);
  t.after(async () => { adapter.dispose(); await raw.close(); await wrapped.close(); });
  async function trace(driver, program) {
    const events = [], results = [];
    for (const name of ['status', 'session', 'streaming', 'controlCommand'])
      program.on(name, (...args) => events.push([name, ...structuredClone(args)]));
    const connected = waitFor(program, 'status', s => s.state === 'conectado');
    program.start(driver.url); await connected; await driver.ready();
    for (const name of Object.keys(actions)) for (const { args, calls, error } of actions[name]) {
      if (error || name === 'setGain') continue;
      const count = driver.wire.idle();
      results.push(await program[name](...args));
      if (calls.length) await driver.wire.until(() => driver.wire.idle() > count);
    }
    let count = driver.wire.idle();
    driver.report({ streaming: true, recording: true });
    await driver.wire.until(() => driver.wire.idle() > count);
    count = driver.wire.idle();
    driver.report({ streaming: false, recording: false });
    await driver.wire.until(() => driver.wire.idle() > count);
    let failure;
    try { await program.showScene('missing'); } catch (error) { failure = [error.name, error.message]; }
    assert.deepEqual(failure, ['Error', 'No encuentro la escena «missing» en Meld']);
    results.push(failure);
    // Hold the fake's session update until stop and cross Meld's 50ms throttle:
    // the gain event is immediate and cannot race the update or a pending timer.
    await new Promise(resolve => setTimeout(resolve, 60));
    driver.wire.holdUpdates();
    results.push(await program.setGain(...actions.setGain[0].args));
    program.stop();
    driver.wire.releaseUpdates();
    return { messages: driver.wire.payloads, events, results };
  }
  assert.deepEqual(await trace(raw, raw.program), await trace(wrapped, adapter));
});

test("adapter adds one listener per event and dispose restores the baseline", () => {
  const meld = new Meld(() => {}), names = ["status", "session", "streaming", "controlCommand"];
  const base = names.map(n => meld.listenerCount(n)), adapter = new MeldAdapter(meld);
  assert.deepEqual(names.map(n => meld.listenerCount(n)), base.map(c => c + 1));
  adapter.stop(); adapter.stop();
  assert.deepEqual(names.map(n => meld.listenerCount(n)), base.map(c => c + 1));
  adapter.dispose();
  assert.deepEqual(names.map(n => meld.listenerCount(n)), base);
});
