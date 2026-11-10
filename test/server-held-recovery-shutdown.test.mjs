// POSIX real SIGINT + fault injection. Windows native ACL/bootstrap remain uncredited.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';

const SERVER = new URL('../src/server.mjs', import.meta.url).href;
const PROGRAM = String.raw`
import fs from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
const scenario = process.argv[1], dir = process.env.ANTENA_DATA;
const mark = (event, data = {}) => appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ event, ...data }) + '\n', { mode: 0o600 });
globalThis.WebSocket = class { constructor() { mark('external'); throw Error('forbidden'); } };
globalThis.fetch = () => { mark('external'); throw Error('forbidden'); };
const { startServer } = await import(${JSON.stringify(SERVER)});
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, cb) { return listen.call(this, 0, host, cb); };
const app = await startServer({ quiet: true, log: message => {
  mark('log', { message });
  if (scenario === 'io-fail') throw Error('SECRET-LOGGER');
} });
net.Server.prototype.listen = listen;
let release;
const gate = new Promise(resolve => { release = resolve; });
let sends = 0, closing = false;
const send = app.bus.send.bind(app.bus);
app.bus.send = (type, ...args) => { if (['alert', 'say'].includes(type)) sends++; return send(type, ...args); };
await app.engine.pause();
app.session.addNote({ kind: 'marker', text: 'session-independent' });
app.interactive.addQuestion({ text: 'interactive-independent' });
const custom = n => app.engine.custom({ text: 'SECRET-TEXT-' + n, image: 'private/image.png',
  actions: [{ kind: 'chat', text: 'SECRET-ACTION', platform: 'twitch' }] },
  { user: 'Fixture', privateRef: 'SECRET-REF-' + n, nested: { full: ['private', n] } });
if (scenario !== 'empty') {
  const first = custom(1); custom(2); app.engine.deliver(first); // duplicate ID via delivery, never held.push
}
if (scenario === 'previous') {
  const { createHeldRecovery } = await import(new URL('./held-recovery.mjs', ${JSON.stringify(SERVER)}));
  const previous = await createHeldRecovery({ dir, maxAlertBytes: 256 * 1024, maxBatchBytes: 8 * 1024 * 1024 }).save([app.engine.held[0]]);
  mark('previous', previous);
}
if (scenario === 'alert-limit') custom('limit').vars.privateRef = 'x'.repeat(256 * 1024);
if (scenario === 'batch-limit') for (let n = 0; n < 36; n++) custom(n).vars.privateRef = 'x'.repeat(240 * 1024);
// Synthetic late caller checks the FINAL capture boundary, not a claim of a producer bug.
const meld = app.meld.quiesceClose.bind(app.meld);
app.meld.quiesceClose = async () => { await meld(); if (scenario === 'late-meld') custom(3); mark('meld'); };
for (const [name, owner] of [['session', app.session], ['interactive', app.interactive]]) {
  const flush = owner.flush.bind(owner);
  // Count shutdown attempts separately from legitimate pre-signal debounce flushes.
  owner.flush = () => { mark(closing ? name : 'before-' + name); return flush(); };
}
const closeHttp = app.closeHttp.bind(app);
app.closeHttp = () => { mark('http'); return closeHttp(); };
const stop = app.stopAdmission.bind(app);
app.stopAdmission = () => {
  closing = true;
  const idle = stop(); mark('cut');
  if (scenario === 'io-fail') {
    // A new Store write must be attempted even if journal and logger fail.
    app.store.patchConfig({ stream: { title: 'store-independent' } });
  }
  return idle;
};
app.recoveryIO = { ...fs,
  lstat: async (...args) => {
    mark('journal-io');
    if (scenario === 'io-fail') throw Object.assign(Error('SECRET-PATH'), { code: 'EACCES' });
    if (scenario === 'deadline') await gate;
    return fs.lstat(...args);
  },
  link: async (...args) => {
    mark('link');
    if (scenario === 'concurrent') { mark('gated'); await gate; }
    if (scenario === 'link-unknown') { await fs.link(...args); throw Error('SECRET-LINK'); }
    return fs.link(...args);
  },
  unlink: async (...args) => {
    mark('unlink');
    if (scenario === 'unlink') throw Error('SECRET-UNLINK');
    return fs.unlink(...args);
  },
};
if (scenario === 'preserve') delete app.recoveryIO; // default real consumer/IO
if (typeof app.captureHeldRecovery === 'function') {
  const capture = app.captureHeldRecovery.bind(app);
  app.captureHeldRecovery = () => {
    mark('capture');
    writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(app.engine.held), { mode: 0o600 });
    if (scenario === 'verify-final') return Promise.reject({ phase: 'verify-final', publication: 'published', message: 'SECRET-VERIFY' });
    const saving = capture();
    if (scenario === 'snapshot') app.engine.held[0].vars.nested.full[0] = 'changed-after-save-call';
    return saving;
  };
}
if (scenario === 'windows-unavailable') Object.defineProperty(process, 'platform', { value: 'win32' });
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  while (input.includes('\n')) {
    const end = input.indexOf('\n'), command = input.slice(0, end); input = input.slice(end + 1);
    if (command === 'release') release();
    if (command === 'close') mark('shared', { same: app.close() === app.close() });
  }
});
process.once('exit', code => mark('exit', { code, sends, held: app.engine.held.length, state: app.heldRecoveryState }));
mark('ready');
`;

async function readEvents(file, { strict = false } = {}) {
  try {
    const lines = (await readFile(file, 'utf8')).split('\n');
    const fragment = lines.pop();
    if (strict && fragment) throw new SyntaxError('Unterminated events.jsonl record');
    return lines.map(JSON.parse);
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

test('events: polling ignores a trailing fragment but final reads and complete lines remain strict', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'held-events-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'events.jsonl');
  assert.deepEqual(await readEvents(file), []);
  await writeFile(file, '{"event":"ready"}\n{"event":"cap');
  assert.deepEqual(await readEvents(file), [{ event: 'ready' }]);
  await assert.rejects(readEvents(file, { strict: true }), SyntaxError);
  await appendFile(file, 'ture"}\n');
  assert.deepEqual(await readEvents(file), [{ event: 'ready' }, { event: 'capture' }]);
  assert.deepEqual(await readEvents(file, { strict: true }), [{ event: 'ready' }, { event: 'capture' }]);
  await appendFile(file, '{bad}\n{"event":"part');
  await assert.rejects(readEvents(file), SyntaxError);
  await assert.rejects(readEvents(file, { strict: true }), SyntaxError);
});

async function launch(t, scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'held-close-'));
  const dir = path.join(root, 'data'); await mkdir(dir, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    ANTENA_DATA: dir, ANTENA_MEDIA: path.join(root, 'media'), PORT: '0' };
  const child = await launchSignalChild(process.execPath, ['--input-type=module', '-e', PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '', result;
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  child.stdin.on('error', () => {});
  const ending = new Promise(resolve => child.once('close', (code, signal) => { result = { code, signal }; resolve(result); }));
  const events = () => readEvents(path.join(dir, 'events.jsonl'), { strict: !!result });
  const until = async predicate => {
    const end = Date.now() + 8500;
    while (!await predicate()) {
      assert.ok(Date.now() < end && !result, 'watchdog/early exit: ' + JSON.stringify(result) + out + err);
      await delay(10);
    }
  };
  const wait = event => until(async () => (await events()).some(e => e.event === event));
  t.after(async () => {
    try {
      if (!result) child.kill('SIGKILL');
      await ending;
      const finalEvents = await readEvents(path.join(dir, 'events.jsonl'), { strict: true });
      const evidence = process.env.HELD_CLOSE_EVIDENCE;
      if (evidence) await writeFile(path.join(evidence, scenario + '.json'), JSON.stringify({ root, result, events: finalEvents, out, err }, null, 2), { mode: 0o600 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  await wait('ready');
  const exit = async () => { await until(() => !!result); return ending; };
  t.diagnostic('scratch=' + root);
  return { dir, child, events, wait, exit, stderr: () => err };
}
async function batches(c, required = true) {
  let names;
  try { names = await readdir(path.join(c.dir, 'held-recovery')); }
  catch (e) {
    if (e.code === 'ENOENT' && !required) return [];
    assert.fail('real recovery batch must exist: ' + e.code);
  }
  return Promise.all(names.map(async name => JSON.parse(await readFile(path.join(c.dir, 'held-recovery', name, 'batch.json'), 'utf8'))));
}
const event = (events, name) => { const found = events.find(e => e.event === name); assert.ok(found, name); return found; };
function final(events, state, held = 3) {
  const exit = event(events, 'exit');
  assert.equal(exit.code, held ? 1 : 0); assert.equal(exit.sends, 0); assert.equal(exit.held, held);
  assert.deepEqual(exit.state, { state });
  for (const name of ['capture', 'session', 'interactive', 'http']) assert.equal(events.filter(e => e.event === name).length, name === 'capture' && !held ? 0 : 1, name);
  assert.ok(!events.some(e => e.event === 'external'));
  assert.ok(events.indexOf(event(events, 'meld')) < events.indexOf(event(events, 'session')));
  for (const e of events.filter(e => e.event === 'log')) assert.doesNotMatch(e.message, /SECRET|held-close-|private|drenado agotado|\[error\]/);
}
const posix = { skip: process.platform === 'win32' ? 'POSIX-only: real SIGINT shutdown with POSIX file modes; Windows ACL equivalent in held-recovery-windows-storage.test.mjs' : false, timeout: 18000 };

test('production-save: SIGINT preserves complete ordered duplicate alerts, exit 1, no dispatch', posix, async t => {
  const c = await launch(t, 'preserve'); await interruptSignalChild(c.child, 'SIGINT');
  assert.deepEqual(await c.exit(), { code: 1, signal: null });
  const [batch, ...extra] = await batches(c); assert.equal(extra.length, 0);
  const expected = JSON.parse(await readFile(path.join(c.dir, 'expected.json'), 'utf8'));
  assert.deepEqual(batch.records.map(r => r.alert), expected);
  assert.deepEqual(batch.records.map(r => r.ordinal), [0, 1, 2]);
  assert.equal(batch.records[0].id, batch.records[2].id);
  assert.notEqual(batch.records[0].id, batch.records[1].id);
  assert.equal((await stat(path.join(c.dir, 'held-recovery', batch.batchId, 'batch.json'))).mode & 0o077, 0);
  assert.ok(JSON.parse(await readFile(path.join(c.dir, 'session-current.json'), 'utf8')).notes.some(n => n.text === 'session-independent'));
  final(await c.events(), 'preserved'); assert.equal(c.stderr(), '[parada] alertas retenidas\n');
});

for (const scenario of ['snapshot', 'late-meld', 'previous']) {
  test(`${scenario}: final synchronous snapshot, independent batches`, posix, async t => {
    const c = await launch(t, scenario); await interruptSignalChild(c.child, 'SIGINT');
    assert.deepEqual(await c.exit(), { code: 1, signal: null });
    const saved = await batches(c), events = await c.events();
    const previous = scenario === 'previous' ? event(events, 'previous').batchId : null;
    const batch = saved.find(b => b.batchId !== previous);
    assert.equal(saved.length, previous ? 2 : 1);
    if (previous) assert.equal(saved.find(b => b.batchId === previous).records.length, 1);
    assert.deepEqual(batch.records.map(r => r.alert), JSON.parse(await readFile(path.join(c.dir, 'expected.json'), 'utf8')));
    final(events, 'preserved', scenario === 'late-meld' ? 4 : 3);
    assert.ok(events.indexOf(event(events, 'meld')) < events.indexOf(event(events, 'capture')));
  });
}

test('concurrent close and repeated signals publish only one batch', posix, async t => {
  const c = await launch(t, 'concurrent'); await interruptSignalChild(c.child, 'SIGINT');
  await c.wait('gated');
  await interruptSignalChild(c.child, 'SIGINT'); c.child.stdin.write('close\n'); await c.wait('shared');
  assert.equal(event(await c.events(), 'shared').same, true);
  assert.equal((await c.events()).filter(e => e.event === 'session').length, 1);
  c.child.stdin.write('release\n');
  assert.deepEqual(await c.exit(), { code: 1, signal: null });
  assert.equal((await batches(c)).length, 1); final(await c.events(), 'preserved');
});

test('empty held does not initialize recovery or perform journal IO', posix, async t => {
  const c = await launch(t, 'empty'); await interruptSignalChild(c.child, 'SIGINT');
  assert.deepEqual(await c.exit(), { code: 0, signal: null });
  assert.deepEqual(await batches(c, false), []);
  const events = await c.events(); final(events, 'idle', 0);
  assert.ok(!events.some(e => e.event === 'journal-io')); assert.equal(c.stderr(), '');
});

const outcomes = [
  ['io-fail', 'failed', '[parada] No se pudieron preservar las alertas retenidas.'],
  ['unlink', 'preserved-cleanup-pending', '[parada] Alertas retenidas preservadas; limpieza pendiente.'],
  ['verify-final', 'unknown', '[parada] Conservación de alertas retenidas incierta.'],
  ['link-unknown', 'unknown', '[parada] Conservación de alertas retenidas incierta.'],
  ['windows-unavailable', 'failed', '[parada] No se pudieron preservar las alertas retenidas.'],
  ['alert-limit', 'failed', '[parada] No se pudieron preservar las alertas retenidas.'],
  ['batch-limit', 'failed', '[parada] No se pudieron preservar las alertas retenidas.'],
];
for (const [scenario, state, message] of outcomes) {
  test(`${scenario}: closed outcome, constant diagnostics, independent persistence, no retry`, posix, async t => {
    const c = await launch(t, scenario); await interruptSignalChild(c.child, 'SIGINT');
    assert.deepEqual(await c.exit(), { code: 1, signal: null });
    const events = await c.events(); final(events, state, scenario === 'alert-limit' ? 4 : scenario === 'batch-limit' ? 39 : 3);
    assert.deepEqual(events.filter(e => e.event === 'log').map(e => e.message), [message]);
    assert.equal(c.stderr(), '[parada] alertas retenidas\n');
    assert.ok(JSON.parse(await readFile(path.join(c.dir, 'session-current.json'), 'utf8')).notes.some(n => n.text === 'session-independent'));
    assert.equal(JSON.parse(await readFile(path.join(c.dir, 'interactive.json'), 'utf8')).questions[0].text, 'interactive-independent');
    if (scenario === 'io-fail') assert.equal(JSON.parse(await readFile(path.join(c.dir, 'config.json'), 'utf8')).stream.title, 'store-independent');
    if (['unlink', 'link-unknown'].includes(scenario)) {
      assert.equal((await batches(c)).length, 1); assert.equal(events.filter(e => e.event === 'link').length, 1);
      assert.equal(events.filter(e => e.event === 'unlink').length, scenario === 'unlink' ? 1 : 0);
    } else assert.deepEqual(await batches(c, false), []);
    if (['windows-unavailable', 'alert-limit', 'batch-limit'].includes(scenario)) assert.ok(!events.some(e => e.event === 'journal-io'));
  });
}

test('hung journal does not defer flush attempts or reset the global 5000ms deadline', posix, async t => {
  const c = await launch(t, 'deadline'); const start = Date.now();
  await interruptSignalChild(c.child, 'SIGINT'); await c.wait('journal-io');
  await c.wait('session'); await c.wait('interactive');
  assert.deepEqual(await c.exit(), { code: 1, signal: null });
  const events = await c.events();
  assert.ok(Date.now() - start >= 4500);
  assert.equal(event(events, 'exit').sends, 0);
  assert.equal(event(events, 'exit').state.state, 'saving');
  assert.deepEqual(events.filter(e => e.event === 'log').map(e => e.message), ['[parada] drenado agotado']);
  for (const name of ['capture', 'session', 'interactive']) assert.equal(events.filter(e => e.event === name).length, 1);
  assert.ok(!events.some(e => e.event === 'http'));
  assert.ok(JSON.parse(await readFile(path.join(c.dir, 'session-current.json'), 'utf8')).notes.some(n => n.text === 'session-independent'));
  assert.equal(JSON.parse(await readFile(path.join(c.dir, 'interactive.json'), 'utf8')).questions[0].text, 'interactive-independent');
});
