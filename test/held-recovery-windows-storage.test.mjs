import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHeldRecovery } from '../src/held-recovery.mjs';
import { windowsHeldEnvironment } from '../src/held-recovery-windows.mjs';
import { buildCustomAlert } from '../src/alerts.mjs';
import { ELEVATED_SKIP, windowsElevated } from './helpers/windows-elevation.mjs';

const ids = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const now = () => '2026-10-17T12:00:00.000Z';
const alert = () => buildCustomAlert({ text: '{message}', actions: [{ kind: 'command', command: 'PRIVATE-COMMAND' }] }, { message: 'PRIVATE-TEXT' }, {});
// Real filesystem operations, injected ACL capability only: NOT a native privacy test.
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'held-connect-'));
  const calls = [];
  const local = p => process.platform === 'win32' ? p : p.replaceAll('\\', '/');
  const io = { ...fs };
  for (const key of ['lstat', 'opendir', 'open', 'mkdir', 'unlink', 'link']) io[key] = (...args) => {
    calls.push(key === 'open' ? `open:${args[1]}` : key);
    return fs[key](local(args[0]), ...(key === 'link' ? [local(args[1])] : args.slice(1)));
  };
  const root = path.join(dir, 'held-recovery');
  const folder = id => path.join(root, id);
  const file = (id, leaf = 'batch.json') => path.join(folder(id), leaf);
  const adapter = {
    inspectNamespace: async () => { calls.push('inspect'); return fs.lstat(root).then(() => 'valid', e => { if (e.code === 'ENOENT') return 'absent'; throw e; }); },
    createNamespace: async () => { calls.push('namespace'); await fs.mkdir(root, { recursive: true }); },
    createBatch: async id => { calls.push('batch'); await fs.mkdir(folder(id)); },
    createTemp: async id => { calls.push('temp'); await fs.writeFile(file(id, '.batch.tmp'), '', { flag: 'wx' }); },
    verifyDirectory: async () => { calls.push('directory'); },
    verifyFile: async (_id, leaf) => { calls.push(`verify:${leaf}`); },
  };
  let next = 0;
  const config = { dir, platform: 'win32', windows: { systemRoot: 'C:\\Windows', tempDir: 'C:\\private' }, windowsFactory: () => adapter,
    io, maxAlertBytes: 8192, maxBatchBytes: 32768, uuid: () => ids[next++], now };
  return { config, adapter, calls, io, root, file, api: createHeldRecovery(config) };
}
const list = api => api.list({ limit: 10 });
const unavailable = () => Object.assign(new Error('PRIVATE-PATH PRIVATE-TEXT'), { code: 'EHELDWINDOWS', cause: 'PRIVATE' });
function failure(phase, publication, code = 'EIO') {
  return e => {
    assert.deepEqual([e.name, e.message, e.phase, e.publication, e.code], ['HeldRecoverySaveError', 'Held recovery save failed', phase, publication, code]);
    assert.equal(Object.hasOwn(e, 'cause'), false);
    assert.doesNotMatch(JSON.stringify(e, Object.getOwnPropertyNames(e)), /PRIVATE/);
    return true;
  };
}

test('un guardado de Windows inyectado usa helpers, temporal vacío existente, r+ y verificación alrededor de la publicación', async () => {
  const h = await setup();
  const originalOpen = h.io.open;
  h.io.open = async (...args) => {
    assert.equal(args[1], 'r+'); assert.equal(args.length, 2);
    assert.equal((await fs.stat(h.file(ids[0], '.batch.tmp'))).size, 0);
    return originalOpen(...args);
  };
  const input = alert(), pending = h.api.save([input, input]);
  input.vars.message = 'CHANGED';
  assert.deepEqual(await pending, { batchId: ids[0], createdAt: now(), state: 'pending', count: 2 });
  assert.deepEqual(h.calls, ['namespace', 'batch', 'temp', 'verify:.batch.tmp', 'open:r+', 'verify:.batch.tmp', 'link', 'verify:batch.json', 'unlink']);
  const saved = JSON.parse(await fs.readFile(h.file(ids[0]), 'utf8'));
  assert.equal(saved.records[0].alert.vars.message, 'PRIVATE-TEXT');
  assert.equal(saved.records[0].id, saved.records[1].id);
  assert.deepEqual(saved.records.map(r => r.ordinal), [0, 1]);
  const raw = await fs.readFile(h.file(ids[0]));
  h.io.open = originalOpen; // The r+ assertion applies to save, not the reader's r.
  h.calls.length = 0;
  const result = await list(h.api);
  assert.equal(result.state, 'ok'); assert.equal(result.batches[0].count, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|actions|vars|records/);
  assert.deepEqual(h.calls, ['inspect', 'opendir', 'directory', 'lstat', 'opendir', 'verify:batch.json', 'lstat', 'open:r', 'verify:batch.json']);
  assert.deepEqual(await fs.readFile(h.file(ids[0])), raw);
  assert.deepEqual(Object.keys(h.api).sort(), ['list', 'save']);
});

test('la selección de Windows valida plataforma, fábrica real por defecto y entradas explícitas, nunca un repliegue privado falso', async () => {
  const h = await setup();
  for (const platform of ['', 'windows', null, 1]) assert.throws(() => createHeldRecovery({ ...h.config, platform }));
  for (const windows of [{}, { systemRoot: 'C:\\evil', tempDir: 'C:\\private' }, { systemRoot: 'C:\\Windows', tempDir: 'relative' }]) {
    assert.throws(() => createHeldRecovery({ ...h.config, dir: 'C:\\private', windowsFactory: undefined, windows }));
  }
  for (const key of Object.keys(h.adapter)) {
    assert.throws(() => createHeldRecovery({ ...h.config, windowsFactory: () => ({ ...h.adapter, [key]: undefined }) }));
  }
  let received;
  createHeldRecovery({ ...h.config, windowsFactory: options => { received = options; return h.adapter; } });
  assert.deepEqual(received, { base: path.win32.resolve(h.config.dir), ...h.config.windows });
  if (process.platform !== 'win32') {
    const api = createHeldRecovery({ ...h.config, dir: 'C:\\private', windowsFactory: undefined });
    await assert.rejects(api.save([alert()]), failure('access', 'not-published'));
  }
  assert.deepEqual(h.calls, []);
});

test('Windows rechaza instantáneas no seguras y límites de bytes antes del helper o la IO del sistema de ficheros', async () => {
  const h = await setup();
  const getter = alert(); Object.defineProperty(getter, 'text', { enumerable: true, get() { throw new Error('getter ran'); } });
  for (const value of [getter, { ...alert(), actions: [() => {}] }, { ...alert(), vars: { text: 'x'.repeat(8193) } }]) await assert.rejects(h.api.save([value]));
  await assert.rejects(createHeldRecovery({ ...h.config, maxBatchBytes: 10 }).save([alert()]));
  assert.deepEqual(h.calls, []);
});

for (const [method, phase, published] of [
  ['createNamespace', 'access'], ['createBatch', 'mkdir'], ['createTemp', 'create-temp'],
  ['verifyFile', 'verify-temp-before-open'], ['verifyTemp', 'verify-temp-before-link'], ['verifyFinal', 'verify-final', true],
]) test(`el fallo del helper de Windows en ${phase} es cerrado y deja evidencia, no un reintento`, async () => {
  const h = await setup(); await h.api.save([alert()]);
  const original = await fs.readFile(h.file(ids[0]));
  let calls = 0;
  if (method === 'verifyTemp' || method === 'verifyFinal') h.adapter.verifyFile = async (_id, leaf) => {
    if (method === 'verifyFinal' ? leaf === 'batch.json' : leaf === '.batch.tmp' && ++calls === 2) throw unavailable();
  };
  else h.adapter[method] = async id => {
    calls++;
    if (method === 'createTemp') await fs.writeFile(h.file(id, '.batch.tmp'), '', { flag: 'wx' });
    throw unavailable();
  };
  await assert.rejects(h.api.save([alert()]), failure(phase, published ? 'published' : 'not-published'));
  assert.deepEqual(await fs.readFile(h.file(ids[0])), original);
  if (method === 'createTemp') assert.equal((await fs.stat(h.file(ids[1], '.batch.tmp'))).size, 0);
  if (published) { assert.ok((await fs.stat(h.file(ids[1]))).size > 0); assert.equal((await list(h.api)).state, 'blocked'); }
});

for (const stage of ['missing', 'nonempty', 'not-file', 'write-close', 'close', 'link-before', 'link-after', 'unlink', 'collision']) test(`IO de Windows en ${stage}: sin recreación, sobrescritura, limpieza ni error primario perdido`, async () => {
  const h = await setup(); await h.api.save([alert()]);
  const original = await fs.readFile(h.file(ids[0]));
  let closes = 0;
  const open = h.io.open;
  if (stage === 'missing') h.adapter.createTemp = async () => {};
  if (stage === 'nonempty') h.adapter.createTemp = async id => fs.writeFile(h.file(id, '.batch.tmp'), 'original', { flag: 'wx' });
  h.io.open = async (...args) => {
    const handle = await open(...args);
    return { stat: async () => stage === 'not-file' ? { isFile: () => false, size: 0 } : handle.stat(),
      writeFile: async text => { if (stage === 'write-close') throw Object.assign(unavailable(), { code: 'ENOSPC' }); return handle.writeFile(text); },
      close: async () => { closes++; await handle.close(); if (['write-close', 'close'].includes(stage)) throw unavailable(); } };
  };
  const link = h.io.link;
  h.io.link = async (...args) => {
    if (stage === 'link-before') throw unavailable();
    if (stage === 'collision') await fs.writeFile(h.file(ids[1]), 'original', { flag: 'wx' });
    await link(...args);
    if (stage === 'link-after') throw unavailable();
  };
  if (stage === 'unlink') h.io.unlink = async () => { throw unavailable(); };
  const phase = stage === 'missing' ? 'open' : ['nonempty', 'not-file'].includes(stage) ? 'verify-open' : stage === 'write-close' ? 'write' : stage === 'close' ? 'close' : stage === 'unlink' ? 'unlink' : 'link';
  const publication = phase === 'link' ? 'unknown' : phase === 'unlink' ? 'published' : 'not-published';
  await assert.rejects(h.api.save([alert()]), failure(phase, publication, stage === 'missing' ? 'ENOENT' : stage === 'collision' ? 'EEXIST' : stage === 'write-close' ? 'ENOSPC' : 'EIO'));
  assert.equal(closes, stage === 'missing' ? 0 : 1);
  assert.deepEqual(await fs.readFile(h.file(ids[0])), original);
  if (stage === 'missing') await assert.rejects(fs.stat(h.file(ids[1], '.batch.tmp')), { code: 'ENOENT' });
  if (stage === 'nonempty') assert.equal(await fs.readFile(h.file(ids[1], '.batch.tmp'), 'utf8'), 'original');
  if (stage === 'collision') assert.equal(await fs.readFile(h.file(ids[1]), 'utf8'), 'original');
});

test('el listado de Windows es de solo lectura, ausencia solo cerrada; los fallos de invalid/helper bloquean sin IO', async () => {
  const h = await setup();
  for (const state of ['absent', undefined, null, {}, 'missing']) {
    h.adapter.inspectNamespace = async () => state; h.calls.length = 0;
    assert.deepEqual(await list(h.api), { state: state === 'absent' ? 'ok' : 'blocked', batches: [], limited: false });
    assert.deepEqual(h.calls, []);
  }
  h.adapter.inspectNamespace = async () => { throw Object.assign(unavailable(), { code: 'ENOENT' }); };
  assert.equal((await list(h.api)).state, 'blocked');
  await assert.rejects(fs.lstat(h.root), { code: 'ENOENT' });
});

test('el lector acotado de metadatos de Windows rechaza fallos de esquema, corrupción, temporal, tamaño y verificación sin mutación', async () => {
  for (const change of ['corrupt', 'schema', 'temporary', 'oversized', 'directory', 'file', 'reverify', 'fstat', 'growth']) {
    const h = await setup(); await h.api.save([alert()]); const file = h.file(ids[0]);
    if (change === 'corrupt') await fs.writeFile(file, '{');
    if (change === 'schema') await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"pending"', '"unknown"'));
    if (change === 'oversized') await fs.writeFile(file, ' '.repeat(32769));
    if (change === 'temporary') await fs.writeFile(h.file(ids[0], '.batch.tmp'), '');
    if (change === 'directory') h.adapter.verifyDirectory = async () => { throw unavailable(); };
    let checks = 0;
    if (['file', 'reverify'].includes(change)) h.adapter.verifyFile = async () => { if (++checks === (change === 'file' ? 1 : 2)) throw unavailable(); };
    if (['fstat', 'growth'].includes(change)) {
      const open = h.io.open;
      h.io.open = async (...args) => {
        const handle = await open(...args);
        return { stat: async () => ({ isFile: () => true, size: change === 'fstat' ? 32769 : 1 }), read: (...a) => handle.read(...a), close: () => handle.close() };
      };
    }
    const before = await fs.readFile(file); h.calls.length = 0;
    assert.equal((await list(h.api)).state, 'blocked', change);
    assert.deepEqual(await fs.readFile(file), before);
    assert.ok(!h.calls.some(c => ['namespace', 'batch', 'temp', 'mkdir', 'link', 'unlink'].includes(c)));
  }
  const h = await setup(); await h.api.save([alert()]); await h.api.save([alert()]);
  const result = await h.api.list({ limit: 1 });
  assert.equal(result.state, 'blocked'); assert.equal(result.limited, true); assert.equal(result.batches.length, 1);
  await assert.rejects(createHeldRecovery({ ...h.config, uuid: () => ids[0] }).save([alert()]), failure('mkdir', 'not-published', 'EEXIST'));
});

// Only this test establishes anything about native ACLs; Linux injection cannot.
test('almacenamiento NTFS real y aislado de Windows: helper por defecto, alerta privada completa, DACL, no-replace y evidencia bloqueada',
  { skip: process.platform !== 'win32' ? 'Requires real Windows/NTFS/PowerShell ACLs; NOT validated on Linux'
    : windowsElevated() ? ELEVATED_SKIP : false }, async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'heldconnect26-'));
    const systemRoot = 'C:\\Windows'; // Explicit standard-installation harness trust, no ambient environment copy.
    const env = windowsHeldEnvironment({ systemRoot, tempDir: scratch });
    const exe = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const fixture = path.join(scratch, 'audit.ps1');
    await fs.writeFile(fixture, `param([string]$Target)
$ErrorActionPreference='Stop'
$a=Get-Acl -LiteralPath $Target
@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
protected=$a.AreAccessRulesProtected; canonical=$a.AreAccessRulesCanonical;
rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
@{sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; inherited=$_.IsInherited; type=[int]$_.AccessControlType; flags=[int]$_.InheritanceFlags}
})} | ConvertTo-Json -Compress -Depth 4
`);
    const audit = target => new Promise((resolve, reject) => execFile(exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Target', target],
      { shell: false, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', env: { ...env } }, (error, stdout, stderr) => {
        if (error || stderr) return reject(new Error('Isolated ACL audit failed'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid ACL audit')); }
      }));
    let next = 0;
    const config = { dir: scratch, windows: { systemRoot, tempDir: scratch }, maxAlertBytes: 8192, maxBatchBytes: 32768, uuid: () => ids[next++], now };
    const api = createHeldRecovery(config); // No platform override, adapter, factory or runner.
    const before = await fs.readdir(scratch);
    assert.deepEqual(await list(api), { state: 'ok', batches: [], limited: false });
    assert.deepEqual(await fs.readdir(scratch), before);
    const original = alert();
    const a = await api.save([original, original]), b = await api.save([alert()]);
    const root = path.join(scratch, 'held-recovery');
    const file = id => path.join(root, id, 'batch.json');
    const raw = await fs.readFile(file(a.batchId), 'utf8');
    const records = JSON.parse(raw).records;
    assert.deepEqual(records.map(r => r.alert), [original, original].map(v => JSON.parse(JSON.stringify(v))));
    assert.deepEqual(records.map(r => [r.ordinal, r.state]), [[0, 'not-dispatched'], [1, 'not-dispatched']]);
    assert.notEqual(a.batchId, b.batchId);
    for (const target of [root, path.dirname(file(a.batchId)), file(a.batchId)]) {
      const acl = await audit(target), directory = (await fs.stat(target)).isDirectory();
      assert.equal(acl.owner, acl.current); assert.equal(acl.protected, true); assert.equal(acl.canonical, true);
      assert.deepEqual(acl.rules.map(r => r.sid).sort(), [...new Set([acl.current, 'S-1-5-18', 'S-1-5-32-544'])].sort());
      for (const rule of acl.rules) assert.deepEqual([rule.rights, rule.inherited, rule.type, rule.flags], [2032127, false, 0, directory ? 3 : 0]);
    }
    const meta = await list(api); assert.equal(meta.state, 'ok'); assert.equal(meta.batches.length, 2);
    assert.doesNotMatch(JSON.stringify(meta), /PRIVATE|actions|vars|records/);
    await assert.rejects(createHeldRecovery({ ...config, uuid: () => ids[0] }).save([alert()]), failure('mkdir', 'not-published'));
    assert.equal(await fs.readFile(file(ids[0]), 'utf8'), raw);
    await fs.writeFile(file(ids[0]), '{');
    assert.equal((await list(api)).state, 'blocked');
    assert.equal(await fs.readFile(file(ids[0]), 'utf8'), '{');
    await fs.writeFile(file(ids[0]), raw);
    assert.equal((await list(api)).state, 'ok');
    const collision = createHeldRecovery({ ...config, uuid: () => ids[2], io: { ...fs, link: async (temp, target) => {
      await fs.link(file(ids[0]), target); return fs.link(temp, target);
    } } });
    await assert.rejects(collision.save([alert()]), failure('link', 'unknown', 'EEXIST'));
    assert.equal(await fs.readFile(file(ids[2]), 'utf8'), raw);
    assert.equal((await list(api)).state, 'blocked'); // own protected temp remains
    assert.equal(await fs.readFile(file(ids[0]), 'utf8'), raw);
    assert.equal(JSON.parse(await fs.readFile(file(ids[1]), 'utf8')).batchId, ids[1]);
    assert.deepEqual(Object.keys(api).sort(), ['list', 'save']); // no replay surface
  });
