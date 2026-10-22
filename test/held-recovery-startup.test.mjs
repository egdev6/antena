// Real app/consumer on POSIX. Emulated Windows failures do not credit native ACLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const SERVER = new URL('../src/server.mjs', import.meta.url).href;
const PROGRAM = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
const scenario = process.argv[1], dir = process.env.ANTENA_DATA;
const root = path.join(dir, 'held-recovery'), logs = [], originals = new Map();
let external = 0, journalReads = 0, journalWrites = 0, sends = 0, executions = 0;
const realFetch = globalThis.fetch;
globalThis.WebSocket = class { constructor() { external++; throw Error('CANARY-WS'); } };
globalThis.fetch = () => { external++; throw Error('CANARY-FETCH'); };
const { createHeldRecovery } = await import(new URL('./held-recovery.mjs', ${JSON.stringify(SERVER)}));
const consumer = createHeldRecovery({ dir, maxAlertBytes: 256 * 1024, maxBatchBytes: 8 * 1024 * 1024 });
const alert = { id: 'CANARY-ID', type: 'custom', text: 'CANARY-TEXT',
  vars: { private: 'CANARY-VARS', url: 'https://CANARY.invalid/private' },
  actions: [{ kind: 'chat', text: 'CANARY-ACTION' }, { kind: 'scene', scene: 'CANARY-SCENE' }] };
const saved = [];
if (!['empty', 'io-fail', 'list-throw', 'windows-missing', 'gate', 'counted'].includes(scenario)) {
  const n = scenario === 'overflow' ? 101 : ['multiple', 'mixed'].includes(scenario) ? 3 : 1;
  for (let i = 0; i < n; i++) saved.push(await consumer.save([alert]));
  const file = path.join(root, saved[0].batchId, 'batch.json');
  if (['corrupt', 'mixed'].includes(scenario)) await fs.writeFile(file, 'CANARY-CORRUPT');
  if (scenario === 'version') {
    const batch = JSON.parse(await fs.readFile(file)); batch.version = 99;
    await fs.writeFile(file, JSON.stringify(batch));
  }
  if (scenario === 'temporary') await fs.writeFile(path.join(root, saved[0].batchId, '.batch.tmp'), 'CANARY-TEMP', { mode: 0o600 });
  for (const b of saved) for (const leaf of await fs.readdir(path.join(root, b.batchId))) {
    const p = path.join(root, b.batchId, leaf); originals.set(p, await fs.readFile(p, 'utf8'));
  }
}
// Observe from BEFORE boot, not just after it: any replay attempt is a failure.
const { Engine } = await import(new URL('./engine.mjs', ${JSON.stringify(SERVER)}));
const { Bus } = await import(new URL('./bus.mjs', ${JSON.stringify(SERVER)}));
for (const key of ['deliver', 'custom', 'send']) Engine.prototype[key] = () => {
  executions++; throw Error('CANARY-EXECUTE');
};
const send = Bus.prototype.send;
let published;
Bus.prototype.send = function (type, ...args) {
  if (['alert', 'say'].includes(type)) sends++;
  if (type === 'status') published = args[0].heldRecovery;
  return send.call(this, type, ...args);
};
const { createApp, startServer } = await import(${JSON.stringify(SERVER)});
const log = message => { logs.push(message); if (scenario === 'logger-throw') throw Error('CANARY-LOGGER'); };
const io = { ...fs };
for (const method of ['lstat', 'opendir', 'open']) io[method] = async (...args) => {
  journalReads++;
  if (scenario === 'io-fail') throw Error('CANARY-IO-PATH');
  if (scenario === 'list-throw') throw new Proxy({}, { get() { throw Error('CANARY-GETTER'); } });
  return fs[method](...args);
};
for (const method of ['mkdir', 'link', 'unlink', 'writeFile', 'rename']) io[method] = async () => {
  journalWrites++; throw Error('CANARY-WRITE');
};
const options = { log, quiet: true, handleSignals: false };
if (['io-fail', 'list-throw', 'counted', 'gate'].includes(scenario) || scenario.startsWith('windows-')) options.heldRecoveryIO = io;
let release, entered;
if (scenario === 'gate') {
  const gate = new Promise(resolve => { release = resolve; });
  entered = new Promise(resolve => {
    const lstat = io.lstat;
    io.lstat = async (...args) => { resolve(); await gate; return lstat(...args); };
  });
}
if (scenario.startsWith('windows-')) {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  // Ambient strings must NOT become privacy inputs.
  process.env.SystemRoot = 'C:\\Windows'; process.env.TEMP = 'C:\\ambient';
  if (scenario === 'windows-invalid') options.heldRecoveryWindows = { systemRoot: 'invalid', tempDir: 'invalid' };
}
const listen = net.Server.prototype.listen;
let listens = 0;
net.Server.prototype.listen = function (port, host, cb) { listens++; return listen.call(this, 0, host, cb); };
let ready = false;
const boot = scenario === 'create-app'
  ? createApp({ ...options, dataDir: dir, mediaDir: process.env.ANTENA_MEDIA })
  : startServer(options);
boot.then(() => { ready = true; });
let beforeGate;
if (scenario === 'gate') {
  await entered; await new Promise(resolve => setImmediate(resolve));
  beforeGate = { ready, listens }; release();
}
const app = await boot;
if (scenario === 'create-app') await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
net.Server.prototype.listen = listen;
const base = 'http://127.0.0.1:' + app.server.address().port;
const readStatus = async () => {
  const response = await realFetch(base + '/api/status');
  if (!response.ok) throw Error('HTTP status ' + response.status);
  return (await response.json()).heldRecovery;
};
const status = await readStatus(), readsAtReady = journalReads;
app.twitch.emit('status', app.twitch.status);
const frozen = !!published && Object.isFrozen(published) && Object.isFrozen(published.batches)
  && published.batches.every(Object.isFrozen);
let rejectsMutation = false;
try { published.state = 'empty'; } catch { rejectsMutation = true; }
// A frozen boot snapshot must not refresh on subsequent HTTP or MCP reads.
if (scenario === 'counted') await consumer.save([alert]);
const again = await readStatus();
let mcp;
if (scenario === 'pending') {
  process.env.ANTENA_URL = base;
  globalThis.fetch = (url, options) => {
    if (!String(url).startsWith(base + '/')) { external++; throw Error('CANARY-NETWORK'); }
    return realFetch(url, options);
  };
  const { TOOLS } = await import(new URL('./mcp.mjs', ${JSON.stringify(SERVER)}));
  mcp = (await TOOLS.find(t => t.name === 'estado').call({})).heldRecovery;
}
// Count only journal operations during close: old batches are NOT live held.
app.recoveryIO = io;
const held = app.engine.held.length;
const closeCode = scenario === 'create-app' ? (await app.closeHttp(), 0) : await app.close();
const intact = (await Promise.all([...originals].map(async ([p, text]) => (await fs.readFile(p, 'utf8')) === text))).every(Boolean);
let entries = null;
try { entries = await fs.readdir(root); } catch (e) { if (e.code !== 'ENOENT') throw e; }
console.log(JSON.stringify({ status, again, mcp, logs, saved, held, closeCode, intact, entries,
  external, sends, executions, journalReads, readsAtReady, journalWrites, beforeGate, frozen, rejectsMutation }));
`;

async function run(t, scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'boot-'));
  const dir = path.join(root, 'data'); await mkdir(dir, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    ANTENA_DATA: dir, ANTENA_MEDIA: path.join(root, 'media'), PORT: '0' };
  const result = await exec(process.execPath, ['--input-type=module', '-e', PROGRAM, scenario], { env, timeout: 12000 });
  if (process.env.HELD_STARTUP_EVIDENCE) await writeFile(path.join(process.env.HELD_STARTUP_EVIDENCE, scenario + '.json'), JSON.stringify({ root, ...result }), { mode: 0o600 });
  assert.equal(result.stderr, '');
  t.diagnostic('scratch=' + root);
  return JSON.parse(result.stdout);
}
const posix = { skip: process.platform === 'win32' ? 'POSIX-only: real app boot with POSIX file modes; Windows ACL equivalent in held-recovery-windows-storage.test.mjs' : false, timeout: 15000 };
function safe(r) {
  assert.equal(r.held, 0); assert.equal(r.closeCode, 0); assert.equal(r.intact, true);
  assert.equal(r.external, 0); assert.equal(r.sends, 0); assert.equal(r.executions, 0);
  assert.equal(r.journalWrites, 0); assert.equal(r.journalReads, r.readsAtReady);
  assert.deepEqual(r.again, r.status); assert.equal(r.frozen, true); assert.equal(r.rejectsMutation, true);
  assert.doesNotMatch(JSON.stringify({ status: r.status, logs: r.logs }), /CANARY|https?:|batch\.json|\/tmp\/|cause|stack|payload/);
  assert.deepEqual(Object.keys(r.status).sort(), ['batches', 'complete', 'limited', 'state']);
  for (const b of r.status.batches) assert.deepEqual(Object.keys(b).sort(), ['batchId', 'count', 'createdAt', 'state']);
}

test('pendiente: el arranque real publica metadatos antes de ready; HTTP/MCP coinciden sin repetición', posix, async t => {
  const r = await run(t, 'pending');
  assert.equal(r.status?.state, 'pending'); // RED must be a feature assertion, not a setup TypeError.
  safe(r);
  assert.deepEqual(r.status, { state: 'pending', batches: r.saved, limited: false, complete: true });
  assert.deepEqual(r.mcp, r.status); assert.equal(r.logs.length, 1); assert.equal(r.entries.length, 1);
  assert.equal(r.logs[0], '[recuperación] Alertas retenidas pendientes de revisión; sin ejecución automática.');
});

for (const scenario of ['create-app', 'logger-throw', 'multiple']) {
  test(scenario + ': el consumidor real por defecto conserva los originales independientes', posix, async t => {
    const r = await run(t, scenario); safe(r); assert.equal(r.status.state, 'pending');
    assert.deepEqual([...r.status.batches].sort((a, b) => a.batchId.localeCompare(b.batchId)), [...r.saved].sort((a, b) => a.batchId.localeCompare(b.batchId)));
    assert.equal(r.entries.length, r.saved.length); assert.equal(r.logs.length, 1);
  });
}
for (const scenario of ['empty', 'counted', 'gate']) {
  test(scenario + ': un único descubrimiento de solo lectura esperado, el namespace ausente sigue ausente', posix, async t => {
    const r = await run(t, scenario); safe(r);
    assert.deepEqual(r.status, { state: 'empty', batches: [], limited: false, complete: true });
    assert.deepEqual(r.logs, []);
    if (scenario !== 'counted') assert.equal(r.entries, null);
    if (scenario === 'gate') assert.deepEqual(r.beforeGate, { ready: false, listens: 0 });
    if (scenario === 'counted') assert.ok(r.readsAtReady > 0);
  });
}
test('mixto: los metadatos válidos independientes siguen explícitamente incompletos junto a un lote corrupto', posix, async t => {
  const r = await run(t, 'mixed'); safe(r);
  assert.equal(r.status.state, 'blocked'); assert.equal(r.status.complete, false); assert.equal(r.status.limited, false);
  assert.equal(r.status.batches.length, 2); assert.equal(r.entries.length, 3); assert.equal(r.logs.length, 1);
});
for (const scenario of ['corrupt', 'version', 'temporary', 'io-fail', 'list-throw']) {
  test(scenario + ': metadatos bloqueados, aviso constante seguro, sin reparación', posix, async t => {
    const r = await run(t, scenario); safe(r);
    assert.deepEqual(r.status, { state: 'blocked', batches: [], limited: false, complete: false });
    assert.deepEqual(r.logs, ['[recuperación] Revisión de alertas retenidas bloqueada o no disponible; sin ejecución automática.']);
  });
}
test('desbordamiento: un listado acotado de 100 queda bloqueado/limitado, nunca un total completo', posix, async t => {
  const r = await run(t, 'overflow'); safe(r);
  assert.equal(r.status.state, 'blocked'); assert.equal(r.status.limited, true); assert.equal(r.status.complete, false);
  assert.equal(r.status.batches.length, 100); assert.equal(r.entries.length, 101);
  assert.ok(r.status.batches.every(b => b.count === 1)); assert.equal(r.logs.length, 1);
});
for (const scenario of ['windows-missing', 'windows-invalid']) {
  test(scenario + ': el contrato POSIX emulado falla cerrado, NO es validación de Windows nativo', posix, async t => {
    const r = await run(t, scenario); safe(r);
    assert.deepEqual(r.status, { state: 'unavailable', batches: [], limited: false, complete: false });
    assert.equal(r.entries?.length ?? 0, scenario === 'windows-invalid' ? 1 : 0);
    assert.equal(r.journalReads, 0); assert.equal(r.logs.length, 1);
  });
}
