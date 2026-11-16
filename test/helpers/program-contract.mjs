// Adapter-independent scenarios: makeAdapter(driver.program) wraps the supplied
// fake client; makeDriver() creates an isolated fake server and provides:
// - url, capabilities, initialStatus, connectedStatus, initialSession and
//   changedSession. The session has at least two scenes; changeSession() makes
//   the second current, then emits its session update.
// - actions: method -> [{ args, calls, result?, session?, error?, capability?, syncThrow? }].
//   calls() returns the fake's request log, in the same driver-defined format as
//   each case's calls. An unsupported action supplies an error and capability.
// - ready() waits for connection initialization; settle() waits for the last
//   action's notifications; report({streaming, recording}) injects live state.
// - emit(name, ...args) and on(name, listener) address the underlying emitter;
//   close() releases its connection and fake server, even if never connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

export function waitFor(emitter, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timed out waiting for ${event}`)); }, 5000);
    const listener = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timer); emitter.off(event, listener); resolve(args);
    };
    emitter.on(event, listener);
  });
}

export function programContract(makeAdapter, makeDriver, { statusOnly = false, sessions = !statusOnly } = {}) {
  async function setup(t) {
    const driver = await makeDriver(), program = makeAdapter(driver.program);
    t.after(async () => { if (statusOnly) await program.quiesceClose(); program.dispose(); await driver.close(); });
    return { driver, program };
  }
  async function connect(program, driver) {
    const ready = waitFor(program, 'status', s => s.state === 'conectado');
    program.start(driver.url);
    await ready; await driver.ready();
  }

  test('program contract: status transitions and declared capabilities', async t => {
    const { driver, program } = await setup(t);
    assert.ok(program instanceof EventEmitter);
    assert.ok(program.capabilities instanceof Set);
    assert.deepEqual(program.capabilities, new Set(driver.capabilities));
    assert.deepEqual(program.status, driver.initialStatus);
    assert.equal(program.connected, false);
    await connect(program, driver);
    assert.equal(program.connected, true);
    assert.deepEqual(program.status, driver.connectedStatus);
    const live = waitFor(program, 'status', s => s.streaming === true && s.recording === true);
    driver.report({ streaming: true, recording: true });
    await live;
    assert.equal(program.status.streamingKnown, true);
    assert.equal(program.status.recordingKnown, true);
    const offline = waitFor(program, 'status', s => s.streaming === false && s.recording === false);
    driver.report({ streaming: false, recording: false });
    await offline;
    assert.equal(program.status.streamingKnown, true);
    assert.equal(program.status.recordingKnown, true);
    program.setStatus({ recordingWarning: 'warning', error: 'error' });
    assert.equal(program.status.recordingWarning, 'warning');
    assert.equal(program.status.error, 'error');
    program.setStatus({ recordingWarning: null, error: null });
    assert.equal(program.status.recordingWarning, null);
    assert.equal(program.status.error, null);
    program.setStatus({ state: 'reintentando', streamingKnown: false, recordingKnown: false });
    assert.equal(program.connected, false);
    assert.equal(program.status.streaming, false);
    assert.equal(program.status.recording, false);
    assert.equal(program.status.streamingKnown, false);
    assert.equal(program.status.recordingKnown, false);
    program.stop();
    assert.equal(program.status.state, 'desconectado');
    assert.equal(program.status.recordingWarning, null);
  });

  if (sessions) test('program contract: ordered scenes, layers, effects and tracks follow the session', async t => {
    const { driver, program } = await setup(t);
    await connect(program, driver);
    assert.deepEqual(program.session(), driver.initialSession);
    const changed = waitFor(program, 'session', s => s.scenes[1]?.current === true);
    driver.changeSession();
    const [session] = await changed;
    assert.deepEqual(session, driver.changedSession);
    assert.deepEqual(program.session(), driver.changedSession);
  });

  test('program contract: each action reaches the underlying program', async t => {
    const { driver, program } = await setup(t);
    await connect(program, driver);
    for (const name of ['showScene', 'setLayer', 'toggleEffect', 'command', 'streamEvent', 'toggleMute', 'setGain', 'media', 'setProperty', 'call']) {
      assert.ok(driver.actions[name]?.length, `missing driver scenarios for ${name}`);
      for (const scenario of driver.actions[name]) {
        const before = driver.calls().length;
        if (scenario.error) {
          const status = structuredClone(program.status), session = program.session();
          if (scenario.capability) assert.equal(program.capabilities.has(scenario.capability), false);
          if (scenario.syncThrow) assert.throws(() => program[name](...scenario.args), scenario.error);
          else await assert.rejects(async () => program[name](...scenario.args), scenario.error);
          assert.deepEqual(program.status, status);
          assert.deepEqual(program.session(), session);
        } else {
          const value = await program[name](...scenario.args);
          if (Object.hasOwn(scenario, 'result')) assert.deepEqual(value, scenario.result, name);
        }
        assert.deepEqual(driver.calls().slice(before), scenario.calls, name);
        if (scenario.calls.length) await driver.settle();
        if (scenario.session) assert.deepEqual(program.session(), scenario.session, name);
      }
    }
  });

  if (!statusOnly) test('program contract: all events preserve ordering, arguments and identity', async t => {
    const { driver, program } = await setup(t), seen = [];
    const events = ['status', 'session', 'streaming', 'controlCommand'];
    for (const name of events) program.on(name, (...args) => seen.push([name, ...args]));
    const status = { state: 'conectado' }, session = { scenes: [], tracks: [] }, extra = {};
    const sent = [['status', status, extra], ['streaming', true], ['session', session],
      ['controlCommand', 'meld.stopRecordingAction'], ['streaming', false]];
    for (const [name, ...args] of sent) driver.emit(name, ...args);
    assert.equal(seen.length, sent.length);
    for (let i = 0; i < sent.length; i++) {
      assert.equal(seen[i].length, sent[i].length);
      for (let j = 0; j < sent[i].length; j++) assert.strictEqual(seen[i][j], sent[i][j]);
    }
  });

  if (statusOnly) test('program contract: stop, restart and terminal close', async t => {
    const { driver, program } = await setup(t);
    await connect(program, driver);
    program.stop();
    assert.equal(program.status.state, 'desconectado');
    assert.equal(program.connected, false);
    await connect(program, driver);
    await program.quiesceClose();
    assert.equal(program.status.state, 'desconectado');
    assert.equal(program.connected, false);
  });

  if (!statusOnly) test('program contract: stop, reconnect, terminal close and teardown', async t => {
    const { driver, program } = await setup(t);
    await connect(program, driver);
    const stopped = waitFor(program, 'status', s => s.state === 'desconectado');
    program.stop(); await stopped;
    assert.equal(program.connected, false);
    await connect(program, driver);
    const transient = makeAdapter(driver.program);
    let transientEvents = 0;
    transient.on('status', () => transientEvents++);
    transient.dispose();
    assert.equal(program.connected, true);
    driver.emit('status', {});
    assert.equal(transientEvents, 0);
    const closed = waitFor(program, 'status', s => s.state === 'desconectado');
    await program.quiesceClose(); await closed;
    assert.equal(program.connected, false);
    let forwarded = 0, other = 0;
    program.on('status', () => forwarded++);
    driver.on('status', () => other++);
    driver.emit('status', {});
    program.dispose(); program.dispose();
    driver.emit('status', {});
    assert.equal(forwarded, 1);
    assert.equal(other, 2);
  });
}
