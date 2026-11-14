import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Program } from '../src/programs/program.mjs';

const actions = [
  'start', 'stop', 'quiesceClose', 'setStatus', 'session', 'showScene', 'setLayer', 'toggleEffect',
  'command', 'streamEvent', 'toggleMute', 'setGain', 'media', 'setProperty', 'call',
];
const status = { state: 'conectado', streaming: false, streamingKnown: true, recording: false,
  recordingKnown: true, recordingWarning: null, version: 2, error: null };

class Example extends Program {
  get status() { return status; }
  session() { return { scenes: [], tracks: [], streaming: false, recording: false }; }
}

test('program contract exposes Meld-compatible status, session and connected', () => {
  const program = new Example();
  assert.ok(program instanceof EventEmitter);
  assert.strictEqual(program.status, status);
  assert.equal(program.connected, true);
  assert.deepEqual(program.session(), { scenes: [], tracks: [], streaming: false, recording: false });
  assert.equal(new (class extends Example { get status() { return { ...status, state: 'reintentando' }; } })().connected, false);
});

test('capabilities are independent sets and unsupported by default', () => {
  const first = new Example(), second = new Example();
  assert.deepEqual(first.capabilities, new Set());
  first.capabilities.add('widget-events');
  assert.deepEqual(second.capabilities, new Set());
});

test('the complete consumer action surface fails explicitly when not implemented', () => {
  const program = new Program();
  assert.throws(() => program.status, /status/);
  for (const method of actions) {
    assert.equal(typeof program[method], 'function', method);
    assert.throws(() => program[method](), new RegExp(method), method);
  }
});

test('program event delivery is synchronous and preserves each payload', () => {
  const program = new Example(), seen = [];
  for (const event of ['status', 'streaming', 'session', 'controlCommand']) {
    const payload = { event };
    program.once(event, value => seen.push(value));
    program.emit(event, payload);
    assert.strictEqual(seen.at(-1), payload);
  }
  assert.equal(seen.length, 4);
});
