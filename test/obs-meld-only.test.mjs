// S3: the public HTTP/MCP contracts and saved-action behavior with a real fake OBS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { createProgram, MELD_COMMANDS, MELD_STREAM_EVENTS } from '../src/programs/index.mjs';
import { fakeObs } from './helpers/fake-obs.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const MESSAGE = 'Esta acción solo está disponible con Meld.';
const DISCONNECTED = 'El programa de emisión no está conectado. Conéctalo en Conexiones.';
const OBS_CAPABILITIES = ['audio-tracks', 'layer-effects', 'media-controls', 'recording', 'scene-layers', 'streaming'];
const MELD_CAPABILITIES = ['audio-tracks', 'clips', 'confetti', 'layer-effects', 'media-controls', 'raw-meld-rpc', 'recording', 'scene-layers', 'streaming', 'widget-events'];
const COMMANDS = [
  ['meld.startStreamingAction', 'StartStream'], ['meld.toggleStreamingAction', 'ToggleStream'],
  ['meld.toggleStreamingAction', 'ToggleStream'], ['meld.stopStreamingAction', 'StopStream'],
  ['meld.startRecordingAction', 'StartRecord'], ['meld.toggleRecordingAction', 'ToggleRecord'],
  ['meld.toggleRecordingAction', 'ToggleRecord'], ['meld.stopRecordingAction', 'StopRecord'],
];
const supported = new Set(COMMANDS.map(([command]) => command));
const unsupported = [...MELD_COMMANDS.filter(command => !supported.has(command)), 'meld.unknownAction', 'toString'];
const cases = [
  ['event', MELD_STREAM_EVENTS.map(event => ({ event, amount: 2 }))],
  ['property', [{ id: 'l1', property: 'x', value: 42 }]],
  ['call', [{ method: 'setStagedScene', args: ['s1'] }, { method: 'showStagedScene', args: [] }]],
  ['command', unsupported.map(command => ({ command }))],
];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) { assert.ok(Date.now() < deadline, label); await delay(10); }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'obs-meld-only-'));
  const obs = fakeObs(), meld = fakeMeld(), logs = [];
  let app;
  t.after(async () => {
    try {
      if (app) {
        await app.drainAutoSession(); await app.session.flush();
        await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
      }
      await obs.close();
      await new Promise((resolve, reject) => meld.server.close(error => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
      }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await listen(obs.server); await listen(meld.server);
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: (...args) => logs.push(args.join(' ')) });
  await listen(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text() };
  };
  const json = async (method, url, body, headers) => {
    const result = await api(method, url, body, headers);
    return { status: result.status, body: JSON.parse(result.body) };
  };
  const snapshot = async () => ({ config: (await api('GET', '/api/config')).body, session: (await api('GET', '/api/session')).body,
    requests: structuredClone(obs.requests), meldCalls: structuredClone(meld.state.calls) });
  const connectObs = async () => {
    const result = await json('PUT', '/api/config', { program: { kind: 'obs' },
      obs: { url: `ws://127.0.0.1:${obs.server.address().port}` }, meld: { autoSession: false } });
    assert.equal(result.status, 200);
    await until(() => app.program.connected, 'OBS connection');
  };
  return { app, obs, meld, logs, base, api, json, snapshot, connectObs };
}

function mcp(t, base) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH || '', TMPDIR: tmpdir(), ANTENA_URL: base, ANTENA_NO_EMBED: '1' },
  });
  let buffer = '', stderr = '', id = 0;
  const pending = new Map(), exited = once(child, 'exit');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => { child.stdin.end(); assert.deepEqual(await exited, [0, null]); assert.equal(stderr, ''); });
  return (method, params) => new Promise(resolve => {
    const next = ++id; pending.set(next, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
  });
}

test('S3: connected OBS rejects Meld-only routes and preserves data and request counters', async t => {
  const f = await fixture(t); await f.connectObs();
  for (const prefix of ['/api/program', '/api/meld']) for (const [suffix, bodies] of cases) {
    await t.test(`${prefix}/${suffix}`, async () => {
      for (const body of bodies) {
        const before = await f.snapshot();
        assert.deepEqual(await f.api('POST', `${prefix}/${suffix}`, body),
          { status: 409, body: JSON.stringify({ error: MESSAGE }) });
        assert.deepEqual(await f.snapshot(), before);
      }
    });
  }
});

test('S3: non-string commands cannot coerce to an allowed OBS command or reach OBS', async t => {
  const f = await fixture(t); await f.connectObs();
  for (const prefix of ['/api/program', '/api/meld']) for (const [name, body] of [
    ['missing', {}], ['null', { command: null }], ['number', { command: 1 }],
    ['array', { command: ['meld.toggleRecordingAction'] }],
    ['uncoercible object', { command: { toString: null, valueOf: null } }],
  ]) await t.test(`${prefix}: ${name}`, async () => {
    const before = await f.snapshot();
    assert.deepEqual(await f.api('POST', `${prefix}/command`, body),
      { status: 409, body: JSON.stringify({ error: MESSAGE }) });
    assert.deepEqual(await f.snapshot(), before);
  });
});

test('S3: disconnection wins over unsupported-action errors on both route aliases', async t => {
  const f = await fixture(t); await f.connectObs();
  assert.equal((await f.json('POST', '/api/program/disconnect', {})).status, 200);
  const before = await f.snapshot();
  for (const prefix of ['/api/program', '/api/meld']) for (const [suffix, bodies] of cases) {
    assert.deepEqual(await f.api('POST', `${prefix}/${suffix}`, bodies[0]),
      { status: 409, body: JSON.stringify({ error: DISCONNECTED }) });
    assert.deepEqual(await f.snapshot(), before);
  }
});

test('S3: all six supported OBS stream/record commands still reach OBS through both aliases', async t => {
  const f = await fixture(t); await f.connectObs();
  const before = f.obs.requests.length;
  for (const prefix of ['/api/program', '/api/meld']) for (const [command] of COMMANDS) {
    assert.deepEqual(await f.json('POST', `${prefix}/command`, { command }), { status: 200, body: { ok: true } });
  }
  assert.deepEqual(f.obs.requests.slice(before), [...COMMANDS, ...COMMANDS].map(([, requestType]) => ({ requestType, requestData: {} })));
  assert.deepEqual(f.meld.state.calls, []);
});

test('S3: saved alert and shortcut actions log unsupported commands/events and continue to chat', async t => {
  const f = await fixture(t); await f.connectObs();
  const sent = [];
  f.app.twitch.sendChat = async text => { sent.push(text); return { is_sent: true }; };
  for (const action of [{ kind: 'command', command: 'meld.recordClip' }, { kind: 'streamEvent', event: 'CONFETTIPOP_TRIGGER' }]) {
    await t.test(`alert ${action.kind}`, async () => {
      const before = f.obs.requests.length, logStart = f.logs.length, index = sent.length;
      const actions = [action, { kind: 'chat', text: `alert-${action.kind}` }];
      assert.equal((await f.json('PUT', '/api/alerts/follow', { actions })).status, 200);
      const result = await f.json('POST', '/api/test', { type: 'follow' });
      assert.equal(result.status, 200); assert.equal(result.body.ok, true);
      await until(() => sent.length > index, 'following alert chat action');
      assert.equal(sent[index], `alert-${action.kind}`);
      assert.ok(f.logs.slice(logStart).some(line => line.includes(MESSAGE)), action.kind);
      assert.equal(f.obs.requests.length, before);
    });
  }
  for (const action of [{ kind: 'command', command: 'meld.screenshot' }, { kind: 'streamEvent', event: 'COUNTER_INCREMENT' }]) {
    await t.test(`shortcut ${action.kind}`, async () => {
      const before = f.obs.requests.length, logStart = f.logs.length, index = sent.length;
      const steps = [action, { kind: 'chat', text: `shortcut-${action.kind}` }];
      const created = await f.json('POST', '/api/shortcuts', { name: `S3-${action.kind}`, steps });
      assert.equal(created.status, 200); assert.deepEqual(created.body.shortcut.steps, steps);
      const result = await f.json('POST', `/api/shortcuts/${created.body.shortcut.id}/run`, {});
      assert.equal(result.status, 200); assert.equal(result.body.ok, true);
      assert.equal(sent[index], `shortcut-${action.kind}`);
      assert.ok(f.logs.slice(logStart).some(line => line.includes(MESSAGE)), action.kind);
      assert.equal(f.obs.requests.length, before);
    });
  }
});

test('S3: direct OBS methods synchronously throw the same 409 without changing state', async t => {
  const program = createProgram('obs');
  t.after(() => program.dispose());
  for (const [method, args] of [
    ['command', ['meld.recordClip']], ['streamEvent', ['CONFETTIPOP_TRIGGER']],
    ['setProperty', ['l1', 'x', 1]], ['call', ['setStagedScene', 's1']],
  ]) await t.test(method, () => {
    const status = structuredClone(program.status), session = program.session();
    assert.throws(() => program[method](...args), { message: MESSAGE, status: 409 });
    assert.deepEqual(program.status, status); assert.deepEqual(program.session(), session);
  });
});

test('S3: real MCP program and Meld aliases surface the same OBS error', async t => {
  const f = await fixture(t); await f.connectObs();
  const rpc = mcp(t, f.base);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const before = await f.snapshot();
  for (const prefix of ['programa', 'meld']) for (const [name, args] of [
    ['evento', { evento: 'CONFETTIPOP_TRIGGER' }], ['comando', { comando: 'meld.recordClip' }],
    ['propiedad', { id: 'l1', propiedad: 'x', valor: 1 }], ['llamar', { metodo: 'setStagedScene', args: ['s1'] }],
  ]) {
    const response = await rpc('tools/call', { name: `${prefix}_${name}`, arguments: args });
    assert.deepEqual(response.result, { content: [{ type: 'text', text: `Error: ${MESSAGE}` }], isError: true });
    assert.deepEqual(await f.snapshot(), before);
  }
});

test('S3: status exposes the active kind and sorted capabilities without changing meld', async t => {
  const f = await fixture(t);
  async function check(kind, capabilities) {
    const status = await f.json('GET', '/api/status');
    const program = await f.json('GET', '/api/program');
    assert.equal(status.status, 200); assert.equal(program.status, 200);
    assert.deepEqual(status.body.program, { kind, capabilities });
    assert.deepEqual(status.body.meld, program.body.status);
  }
  await t.test('Meld', () => check('meld', MELD_CAPABILITIES));
  await f.connectObs();
  await t.test('OBS', () => check('obs', OBS_CAPABILITIES));
  assert.equal((await f.json('PUT', '/api/config', { program: { kind: 'meld' } })).status, 200);
  await t.test('Meld after switching back', () => check('meld', MELD_CAPABILITIES));
});

test('S3 regression: with Meld connected the event route still invokes Meld', async t => {
  const f = await fixture(t);
  const connected = await f.json('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${f.meld.server.address().port}` });
  assert.equal(connected.status, 200);
  await until(() => f.app.program.connected, 'Meld connection');
  assert.deepEqual(await f.json('POST', '/api/program/event', { event: 'COUNTER_INCREMENT', amount: 2 }),
    { status: 200, body: { ok: true } });
  assert.deepEqual(f.meld.state.calls, [[13, 'COUNTER_INCREMENT', { amount: 2 }]]);
  assert.deepEqual(f.obs.requests, []);
});
