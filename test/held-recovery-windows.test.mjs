import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsHeldRecovery, windowsHeldEnvironment } from '../src/held-recovery-windows.mjs';
import { ELEVATED_SKIP, windowsElevated } from './helpers/windows-elevation.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const base = 'C:\\private data\\literal;$value';
const systemRoot = 'C:\\Windows';
const ok = '{"version":1,"ok":true}';
const tempDir = 'C:\\heldwin26-private';
const config = runner => ({ base, systemRoot, tempDir, runner });
const blocked = { message: 'Windows held recovery unavailable', code: 'EHELDWINDOWS' };
function fixtureCall({ exe, fixture, target, mode, env }, runner = execFile) {
  if (!env) throw new Error('Scratch fixture environment required');
  return new Promise((resolve, reject) => runner(exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-Target', target, '-Mode', mode],
    { shell: false, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', env: { ...env } },
    // el motivo (stderr acotado) queda en el error: sin él no se puede diagnosticar el runner (#83)
    (error, stdout, stderr) => error
      ? reject(new Error('Scratch fixture failed: ' + String(stderr || error.message).trim().slice(0, 800)))
      : resolve(stdout)));
}

test('el entorno del hijo excluye un canario heredado y solo admite entradas fijas de Windows/compilador', async () => {
  process.env.HELD_WINDOWS_CANARY_SECRET = 'canarySECRET';
  try {
    let options;
    const api = createWindowsHeldRecovery(config((_exe, _args, opts, callback) => { options = opts; callback(null, ok, ''); }));
    await api.createNamespace();
    const childCanary = options.env === undefined ? process.env.HELD_WINDOWS_CANARY_SECRET : options.env.HELD_WINDOWS_CANARY_SECRET;
    assert.equal(childCanary, undefined, 'child must not inherit the parent canary');
    assert.deepEqual(options.env, {
      SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: tempDir, TMP: tempDir,
      PATH: [path.win32.join(systemRoot, 'System32'), path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
        path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
        path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319')].join(';'),
      PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    });
    for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'HELD_WINDOWS_CANARY_SECRET']) {
      assert.equal(Object.hasOwn(options.env, key), false);
    }
  } finally { delete process.env.HELD_WINDOWS_CANARY_SECRET; }
});

test('la prueba usa una política de ejecución solo del proceso, argumentos separados y el entorno aislado dado', async () => {
  const env = windowsHeldEnvironment({ systemRoot, tempDir });
  const input = { exe: 'fixed.exe', fixture: 'literal;$fixture.ps1', target: 'literal;$target', mode: 'audit', env };
  await fixtureCall(input, (exe, args, options, callback) => {
    assert.equal(exe, input.exe);
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', input.fixture, '-Target', input.target, '-Mode', input.mode]);
    assert.deepEqual(options.env, env); assert.equal(options.shell, false);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4096);
    callback(null, '');
  });
});

// Node añade NODE_V8_COVERAGE al env del hijo con --experimental-test-coverage; un env congelado lanza TypeError.
const coverageExecFile = (_exe, _args, options, callback) => { options.env.NODE_V8_COVERAGE = 'coverage'; callback(null, ok, ''); };

test('el arnés entrega al execFile una copia mutable del entorno aislado congelado', async () => {
  const env = windowsHeldEnvironment({ systemRoot, tempDir });
  assert.equal(Object.isFrozen(env), true);
  await fixtureCall({ exe: 'fixed.exe', fixture: 'f.ps1', target: 't', mode: 'audit', env }, coverageExecFile);
  assert.equal(Object.hasOwn(env, 'NODE_V8_COVERAGE'), false);
});

test('el corredor recibe una copia mutable del entorno aislado por llamada y el contrato público sigue congelado', async () => {
  const seen = [];
  const api = createWindowsHeldRecovery(config((...args) => { seen.push(args[2].env); coverageExecFile(...args); }));
  await api.createNamespace();
  await api.createTemp(id);
  assert.notEqual(seen[0], seen[1]);
  for (const env of seen) assert.equal(env.NODE_V8_COVERAGE, 'coverage');
  assert.equal(Object.isFrozen(windowsHeldEnvironment({ systemRoot, tempDir })), true);
});

test('ejecutable de confianza fijo, script fijo, argumentos literales separados y corredor acotado sin shell', async () => {
  const calls = [];
  const api = createWindowsHeldRecovery(config((...args) => { calls.push(args); args[3](null, ok, ''); }));
  assert.equal(await api.createNamespace(), path.win32.join(base, 'held-recovery'));
  assert.equal(await api.createBatch(id), path.win32.join(base, 'held-recovery', id));
  await api.verifyDirectory(); await api.verifyDirectory(id);
  await api.verifyFile(id, 'batch.json'); await api.verifyFile(id, '.batch.tmp');
  assert.equal(calls.length, 6);
  for (const [exe, args, options] of calls) {
    assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(args[args.indexOf('-Base') + 1], base);
    assert.match(args[args.indexOf('-File') + 1], /[\\/]src[\\/]held-recovery-windows\.ps1$/);
    assert.ok(!args.includes('-Command') && !args.includes('-EncodedCommand'));
    assert.equal(options.shell, false); assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 4096); assert.equal(options.windowsHide, true);
  }
  assert.deepEqual(calls.map(c => c[1][c[1].indexOf('-Operation') + 1]),
    ['create-namespace', 'create-batch', 'verify-directory', 'verify-directory', 'verify-file', 'verify-file']);
});

test('createTemp fija la hoja UUID, no envía payload y usa el corredor aislado y acotado', async () => {
  const calls = [];
  const api = createWindowsHeldRecovery(config((...args) => { calls.push(args); args[3](null, ok, ''); }));
  assert.equal(await api.createTemp(id), path.win32.join(base, 'held-recovery', id, '.batch.tmp'));
  assert.equal(calls.length, 1);
  const [exe, args, options] = calls[0];
  assert.equal(calls[0].length, 4); // no stdin/payload channel
  assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    args[6], '-Operation', 'create-temp', '-Base', base, '-Batch', id, '-Leaf', '.batch.tmp']);
  assert.match(args[6], /[\\/]src[\\/]held-recovery-windows\.ps1$/);
  assert.deepEqual(options, { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096,
    encoding: 'utf8', env: windowsHeldEnvironment({ systemRoot, tempDir }) });
});

test('createTemp comunica un EEXIST simulado de forma genérica, sin reintentar ni tocar el original', async () => {
  let calls = 0, file;
  const original = Object.freeze({ contents: 'PRIVATE original', inode: 26 });
  const api = createWindowsHeldRecovery(config((_exe, _args, _options, callback) => {
    calls++;
    if (file) callback(Object.assign(new Error('PRIVATE C:\\secret'), { code: 'EEXIST' }), '', 'PRIVATE');
    else { file = original; callback(null, ok, ''); }
  }));
  await api.createTemp(id);
  await assert.rejects(api.createTemp(id), blocked);
  assert.equal(calls, 2);
  assert.equal(file, original); // mock identity/content preserved; real proof is Windows-only
});

test('raíces inválidas, destinos arbitrarios, traversals, UUIDs y nombres de fichero nunca llegan al corredor', async () => {
  let calls = 0;
  const runner = () => { calls++; };
  for (const root of [undefined, '', 'Windows', 'C:Windows', '\\\\host\\Windows', 'C:\\Windows\\..\\evil', 'C:\\Windows\\', 'C:\\evil']) {
    assert.throws(() => createWindowsHeldRecovery({ base, systemRoot: root, tempDir, runner }), blocked);
  }
  for (const value of ['relative', 'C:relative', '\\\\host\\share', 'C:\\base\\..\\other', 'C:\\base.', 'C:\\NUL', 'C:\\a:stream', 'C:\\a\\', 'C:\\a\u0000b']) {
    assert.throws(() => createWindowsHeldRecovery({ base: value, systemRoot, tempDir, runner }), blocked);
  }
  for (const value of [undefined, '', 'C:\\', '/tmp/private', 'C:\\a\\..\\b', '\\\\host\\share']) {
    assert.throws(() => createWindowsHeldRecovery({ base, systemRoot, tempDir: value, runner }), blocked);
  }
  const api = createWindowsHeldRecovery(config(runner));
  for (const value of ['', '../escape', 'x', undefined, null]) {
    await assert.rejects(api.createBatch(value), blocked);
    await assert.rejects(api.createTemp(value), blocked);
    if (value !== undefined) await assert.rejects(api.verifyDirectory(value), blocked);
    await assert.rejects(api.verifyFile(value, 'batch.json'), blocked);
  }
  for (const leaf of ['../outside', 'other', 'batch.json:stream', undefined]) await assert.rejects(api.verifyFile(id, leaf), blocked);
  assert.equal(calls, 0);
});

test('los fallos del corredor y las respuestas malformadas fallan cerrado, sin rutas crudas ni diagnóstico', async () => {
  const responses = [
    [new Error('PRIVATE payload C:\\secret'), ok, ''],
    [null, ok, 'PRIVATE warning'], [null, '', ''], [null, 'garbage', ''],
    [null, '{"version":1,"ok":false}', ''], [null, '{"version":2,"ok":true}', ''],
    [null, '{"version":1,"ok":true,"path":"PRIVATE"}', ''],
    [null, '{"version":1,"ok":true,"state":"valid"}', ''],
    [null, ' '.repeat(4097) + ok, ''], [null, Buffer.from(ok), ''],
  ];
  for (const response of responses) {
    const api = createWindowsHeldRecovery(config((_exe, _args, _options, callback) => callback(...response)));
    await assert.rejects(api.createNamespace(), blocked);
    await assert.rejects(api.createTemp(id), blocked);
  }
  await assert.rejects(createWindowsHeldRecovery(config(() => { throw new Error('PRIVATE'); })).createNamespace(), blocked);
  await assert.rejects(createWindowsHeldRecovery(config(() => { throw new Error('PRIVATE'); })).createTemp(id), blocked);
});

test('inspectNamespace solo devuelve ausente/válido con una operación fija y sin lote/hoja', async () => {
  for (const state of ['absent', 'valid']) {
    let calls = 0;
    const api = createWindowsHeldRecovery(config((exe, args, options, callback) => {
      calls++;
      assert.equal(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
      assert.deepEqual(args.slice(7), ['-Operation', 'inspect-namespace', '-Base', base]);
      assert.equal(options.shell, false); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4096);
      assert.deepEqual(options.env, windowsHeldEnvironment({ systemRoot, tempDir }));
      callback(null, JSON.stringify({ version: 1, ok: true, state }), '');
    }));
    assert.equal(await api.inspectNamespace('../ignored', 'arbitrary'), state);
    assert.equal(calls, 1);
  }
});

test('inspectNamespace nunca trata fallos ni estados sin versión/extra/desconocidos como ausencia', async () => {
  for (const response of [
    ...[2, 3, 5, 32, 'ENOENT', 'EACCES'].map(code => [Object.assign(new Error('PRIVATE'), { code }), '', '']),
    [null, ok, ''], [null, '', ''], [null, 'garbage', ''],
    ...[null, [], { version: 1, ok: false, state: 'absent' }, { version: 2, ok: true, state: 'absent' },
      { version: 1, ok: true, state: 'missing' }, { version: 1, ok: true, state: null },
      { version: 1, ok: true, state: 'valid', path: 'PRIVATE' }].map(value => [null, JSON.stringify(value), '']),
    [null, '{"version":1,"ok":true,"state":"absent"}', 'PRIVATE'],
    [null, ' '.repeat(4097), ''], [null, Buffer.from(ok), ''],
  ]) {
    let calls = 0;
    const api = createWindowsHeldRecovery(config((_exe, _args, _options, cb) => { calls++; cb(...response); }));
    await assert.rejects(api.inspectNamespace(), blocked);
    assert.equal(calls, 1);
  }
  await assert.rejects(createWindowsHeldRecovery(config(() => { throw new Error('PRIVATE'); })).inspectNamespace(), blocked);
});

test('el corredor por defecto no puede ejecutarse fuera de Windows', { skip: process.platform === 'win32' ? 'Linux-only platform guard' : false }, async () => {
  await assert.rejects(createWindowsHeldRecovery({ base, systemRoot, tempDir }).createNamespace(), blocked);
  await assert.rejects(createWindowsHeldRecovery({ base, systemRoot, tempDir }).createTemp(id), blocked);
  await assert.rejects(createWindowsHeldRecovery({ base, systemRoot, tempDir }).inspectNamespace(), blocked);
});

// This test alone exercises real ACLs. Linux injected runners do NOT establish Windows privacy.
test('helper real de Windows: ACL propias de trabajo, política de SID, dueño protegido, colisiones y rechazo de reparse',
  { skip: process.platform !== 'win32' ? 'Requires Windows PowerShell 5.1 and real NTFS ACLs; not established on Linux'
    : windowsElevated() ? ELEVATED_SKIP : false }, async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'heldwin26-'));
    const fixture = path.join(scratch, 'fixture.ps1');
    await fs.writeFile(fixture, `param([string]$Target,[string]$Mode)
$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
if($Mode -eq 'file') {
  $a=New-Object System.Security.AccessControl.FileSecurity
  $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false)
  @($sid.Value,'S-1-5-18','S-1-5-32-544') | Select-Object -Unique | ForEach-Object {
    $s=New-Object System.Security.Principal.SecurityIdentifier($_)
    $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','Allow')))
  }
  $f=New-Object System.IO.FileStream($Target,[System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl,[System.IO.FileShare]::None,4096,[System.IO.FileOptions]::None,$a)
  $f.Dispose(); exit 0
}
if($Mode -eq 'audit-file') { $a=[System.IO.File]::GetAccessControl($Target) }
else { $a=[System.IO.Directory]::GetAccessControl($Target) }
if($Mode -in @('audit','audit-file')) {
  @{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; current=$sid.Value;
    protected=$a.AreAccessRulesProtected; rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights; flags=[int]$_.InheritanceFlags; inherited=$_.IsInherited;
        type=[int]$_.AccessControlType; propagation=[int]$_.PropagationFlags}
    }); canonical=$a.AreAccessRulesCanonical; raw=@((New-Object System.Security.AccessControl.RawSecurityDescriptor($a.GetSecurityDescriptorBinaryForm(),0)).DiscretionaryAcl | ForEach-Object {
      @{type=[int]$_.AceType; flags=[int]$_.AceFlags; mask=$_.AccessMask}
    })} | ConvertTo-Json -Compress -Depth 4
  exit 0
}
if($Mode -eq 'everyone') {
  $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
  $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'Read','Allow')))
} elseif($Mode -eq 'inherit') { $a.SetAccessRuleProtection($false,$true) }
elseif($Mode -eq 'missing') { $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); $a.PurgeAccessRules($s) }
else { throw 'invalid fixture' }
[System.IO.Directory]::SetAccessControl($Target,$a)
`);
    const windowsRoot = process.env.SystemRoot; // explicit trusted harness input, not OS authentication
    const env = windowsHeldEnvironment({ systemRoot: windowsRoot, tempDir: scratch });
    const exe = path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const mutate = (target, mode) => fixtureCall({ exe, fixture, target, mode, env });
    const adapter = dir => createWindowsHeldRecovery({ base: dir, systemRoot: windowsRoot, tempDir: scratch });
    const snapshot = async dir => ({ acl: JSON.parse(await mutate(dir, 'audit')),
      names: await fs.readdir(dir), mtime: (await fs.stat(dir)).mtimeMs });
    const inspect = async (api, dir, state) => {
      const before = await snapshot(dir);
      const root = path.join(dir, 'held-recovery');
      const stat = await fs.lstat(root).catch(error => { assert.equal(error.code, 'ENOENT'); return null; });
      const rootSnapshot = async () => stat?.isDirectory() ? snapshot(root) :
        { acl: JSON.parse(await mutate(root, 'audit-file')), contents: await fs.readFile(root, 'utf8') };
      const rootBefore = stat && !stat.isSymbolicLink() ? await rootSnapshot() : null;
      if (state) assert.equal(await api.inspectNamespace(), state);
      else await assert.rejects(api.inspectNamespace(), blocked);
      assert.deepEqual(await snapshot(dir), before);
      if (rootBefore) assert.deepEqual(await rootSnapshot(), rootBefore);
      if (!stat) await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
      else { // Exclude read-induced atime, not identity/type/content timestamps.
        const identity = s => [s.dev, s.ino, s.mode, s.size, s.birthtimeMs, s.mtimeMs];
        assert.deepEqual(identity(await fs.lstat(root)), identity(stat));
      }
    };
    const missingBase = path.join(scratch, 'missing-base');
    await assert.rejects(adapter(missingBase).inspectNamespace(), blocked);
    await assert.rejects(fs.lstat(missingBase), { code: 'ENOENT' });
    const fileBase = path.join(scratch, 'file-base'); await fs.writeFile(fileBase, 'scratch');
    await assert.rejects(adapter(fileBase).inspectNamespace(), blocked);
    for (const mode of ['valid', 'everyone', 'inherit', 'missing', 'reparse', 'root-reparse', 'root-file', 'file-reparse', 'batch-insecure', 'temp-directory']) {
      const dir = path.join(scratch, mode); await fs.mkdir(dir);
      const api = adapter(dir);
      await inspect(api, dir, 'absent'); // no namespace is created; base names/ACL remain identical
      const root = await api.createNamespace();
      await inspect(api, dir, 'valid');
      assert.equal(await api.createNamespace(), root);
      const folder = await api.createBatch(id);
      const audit = JSON.parse(await mutate(folder, 'audit'));
      assert.equal(audit.owner, audit.current); assert.equal(audit.protected, true);
      assert.deepEqual(audit.rules.map(r => r.sid).sort(), [...new Set([audit.current, 'S-1-5-18', 'S-1-5-32-544'])].sort());
      for (const rule of audit.rules) {
        assert.equal(rule.rights, 2032127); assert.equal(rule.flags, 3); assert.equal(rule.inherited, false);
      }
      await api.verifyDirectory(id);
      const temp = path.join(folder, '.batch.tmp');
      assert.equal(await api.createTemp(id), temp); // production helper, NOT fixture-created
      const identity = async target => {
        const s = await fs.lstat(target, { bigint: true });
        return [s.dev, s.ino, s.size, s.birthtimeNs, s.mtimeNs]; // exclude read-induced atime
      };
      const empty = await identity(temp);
      assert.equal(empty[2], 0n);
      const fileAudit = JSON.parse(await mutate(temp, 'audit-file'));
      assert.equal(fileAudit.owner, fileAudit.current);
      assert.equal(fileAudit.protected, true); assert.equal(fileAudit.canonical, true);
      assert.deepEqual(fileAudit.rules.map(r => r.sid).sort(), [...new Set([fileAudit.current, 'S-1-5-18', 'S-1-5-32-544'])].sort());
      assert.equal(fileAudit.raw.length, fileAudit.rules.length);
      for (const rule of fileAudit.rules) assert.deepEqual(
        [rule.rights, rule.flags, rule.inherited, rule.type, rule.propagation], [2032127, 0, false, 0, 0]);
      for (const ace of fileAudit.raw) assert.deepEqual([ace.type, ace.flags, ace.mask], [0, 0, 2032127]);
      await api.verifyFile(id, '.batch.tmp');
      // A second invocation must preserve even an empty original; no replacement.
      await assert.rejects(api.createTemp(id), blocked);
      assert.deepEqual(await identity(temp), empty);
      await fs.writeFile(temp, 'scratch sentinel'); // future consumer is outside the adapter
      const written = await identity(temp);
      await assert.rejects(api.createTemp(id), blocked);
      await api.verifyFile(id, '.batch.tmp');
      assert.deepEqual(await identity(temp), written);
      assert.equal(await fs.readFile(temp, 'utf8'), 'scratch sentinel');
      assert.deepEqual(JSON.parse(await mutate(temp, 'audit-file')), fileAudit);
      await fs.rename(temp, path.join(folder, 'protected-original'));
      await assert.rejects(api.createBatch(id), blocked);
      await mutate(path.join(folder, 'batch.json'), 'file');
      await api.verifyFile(id, 'batch.json');
      await fs.writeFile(path.join(folder, '.batch.tmp'), ''); // inherited, unprotected ACL must fail
      await assert.rejects(api.verifyFile(id, '.batch.tmp'), blocked);
      await fs.rename(path.join(folder, '.batch.tmp'), path.join(folder, 'unprotected'));
      await fs.link(path.join(folder, 'batch.json'), path.join(folder, '.batch.tmp'));
      await api.verifyFile(id, '.batch.tmp');
      if (mode === 'valid') {
        for (const extra of [['-Batch', id], ['-Batch', ''], ['-Leaf', 'batch.json'], ['-Leaf', ''], ['-Unexpected', 'x']]) {
          const before = await snapshot(dir), rootBefore = await snapshot(root);
          await new Promise((resolve, reject) => execFile(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
            fileURLToPath(new URL('../src/held-recovery-windows.ps1', import.meta.url)),
            '-Operation', 'inspect-namespace', '-Base', dir, ...extra],
          { shell: false, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', env: { ...env } }, (error, stdout, stderr) => {
            try {
              assert.equal(error?.code, 1); assert.equal(stderr, '');
              assert.deepEqual(JSON.parse(stdout), { version: 1, ok: false }); resolve();
            } catch (failure) { reject(failure); }
          }));
          assert.deepEqual(await snapshot(dir), before); assert.deepEqual(await snapshot(root), rootBefore);
        }
        continue;
      }
      await fs.rename(temp, path.join(folder, 'linked-original')); // preserve every original
      if (mode === 'batch-insecure') {
        await mutate(folder, 'everyone');
        const before = await mutate(folder, 'audit');
        await assert.rejects(api.createTemp(id), blocked);
        assert.equal(await mutate(folder, 'audit'), before);
        await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
      } else if (mode === 'temp-directory') {
        await fs.mkdir(temp);
        const before = await identity(temp);
        await assert.rejects(api.createTemp(id), blocked);
        assert.deepEqual(await identity(temp), before);
      } else if (mode === 'root-file') {
        await fs.rename(root, path.join(dir, 'original'));
        await fs.writeFile(root, 'scratch sentinel');
        await inspect(api, dir);
        assert.equal(await fs.readFile(root, 'utf8'), 'scratch sentinel');
      } else if (mode === 'root-reparse') {
        await fs.rename(root, path.join(dir, 'original'));
        await fs.symlink(path.join(dir, 'original'), root, 'junction');
        await inspect(api, dir);
        await assert.rejects(api.createNamespace(), blocked);
        await assert.rejects(api.createTemp(id), blocked);
        await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
      } else if (mode === 'file-reparse') {
        await fs.rename(path.join(folder, 'batch.json'), path.join(folder, 'original'));
        await fs.symlink(folder, path.join(folder, 'batch.json'), 'junction');
        await assert.rejects(api.verifyFile(id, 'batch.json'), blocked);
        await fs.symlink(path.join(folder, 'protected-original'), temp, 'file');
        const before = await identity(temp);
        await assert.rejects(api.createTemp(id), blocked);
        await assert.rejects(api.verifyFile(id, '.batch.tmp'), blocked);
        assert.deepEqual(await identity(temp), before);
        assert.equal(await fs.readFile(path.join(folder, 'protected-original'), 'utf8'), 'scratch sentinel');
      } else if (mode === 'reparse') {
        await fs.rename(folder, path.join(root, 'original'));
        await fs.symlink(path.join(root, 'original'), folder, 'junction');
        await assert.rejects(api.verifyDirectory(id), blocked);
        await assert.rejects(api.verifyFile(id, 'batch.json'), blocked);
        await assert.rejects(api.createTemp(id), blocked);
        await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
        const alias = path.join(scratch, 'alias'); await fs.symlink(dir, alias, 'junction');
        const aliased = createWindowsHeldRecovery({ base: alias, systemRoot: windowsRoot, tempDir: scratch });
        await assert.rejects(aliased.inspectNamespace(), blocked);
        await assert.rejects(aliased.createNamespace(), blocked);
        await assert.rejects(aliased.createTemp(id), blocked);
        await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
      } else {
        await mutate(root, mode);
        const before = await fs.stat(root);
        const aclBefore = await mutate(root, 'audit');
        await inspect(api, dir);
        await assert.rejects(api.createNamespace(), blocked);
        await assert.rejects(api.verifyDirectory(id), blocked);
        await assert.rejects(api.createBatch('00000000-0000-4000-8000-000000000002'), blocked);
        await assert.rejects(api.createTemp(id), blocked);
        await assert.rejects(fs.lstat(temp), { code: 'ENOENT' });
        assert.equal((await fs.stat(root)).mtimeMs, before.mtimeMs);
        assert.equal(await mutate(root, 'audit'), aclBefore);
      }
    }
  });
