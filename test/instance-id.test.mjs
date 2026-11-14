import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t, initial) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-instance-'));
  const dataDir = path.join(root, 'data');
  const file = path.join(dataDir, 'instance.json');
  await mkdir(dataDir);
  const apps = [];
  t.after(async () => {
    await Promise.all(apps.map(app => app.closeHttp()));
    await rm(root, { recursive: true, force: true });
  });
  if (initial !== undefined) await writeFile(file, initial);
  const start = async () => {
    const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
    apps.push(app);
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    return { base, close: () => app.closeHttp() };
  };
  return { dataDir, file, start };
}

function validRecord(record, dataDir) {
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'directory', 'id']);
  assert.match(record.id, /^[0-9a-f]{32}$/);
  assert.equal(new Date(record.createdAt).toISOString(), record.createdAt);
  assert.equal(record.directory, realpathSync.native(dataDir));
}

test('startup creates an identity and serves the same in-memory id even if the file changes', async t => {
  const { dataDir, file, start } = await fixture(t);
  const { base } = await start();
  const record = JSON.parse(await readFile(file, 'utf8'));
  validRecord(record, dataDir);
  const response = await fetch(base + '/api/status');
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body).instance, { app: 'antena', id: record.id });
  assert.ok(!body.includes(dataDir));
  await writeFile(file, '{broken');
  assert.deepEqual((await (await fetch(base + '/api/status')).json()).instance, { app: 'antena', id: record.id });
});

test('a valid identity is reused across server restarts without rewriting it', async t => {
  const { dataDir, file, start } = await fixture(t);
  const record = { id: '0123456789abcdef0123456789abcdef', createdAt: '2026-01-02T03:04:05.000Z', directory: realpathSync.native(dataDir) };
  const original = JSON.stringify(record);
  await writeFile(file, original);
  const first = await start();
  assert.deepEqual((await (await fetch(first.base + '/api/status')).json()).instance, { app: 'antena', id: record.id });
  await first.close();
  const second = await start();
  assert.deepEqual((await (await fetch(second.base + '/api/status')).json()).instance, { app: 'antena', id: record.id });
  assert.equal(await readFile(file, 'utf8'), original);
});

test('invalid identities are replaced at startup', async t => {
  for (const invalid of ['{broken', '{}', 'null', '[]', JSON.stringify({ id: 'short', createdAt: '2026-01-02T03:04:05.000Z' }),
    JSON.stringify({ id: 'A'.repeat(32), createdAt: '2026-01-02T03:04:05.000Z' }),
    JSON.stringify({ id: 'a'.repeat(32), createdAt: 'not-a-date' })]) {
    await t.test(invalid, async t => {
      const { dataDir, file, start } = await fixture(t, invalid);
      const { base } = await start();
      const record = JSON.parse(await readFile(file, 'utf8'));
      validRecord(record, dataDir);
      assert.notEqual(record.id, 'a'.repeat(32));
      assert.deepEqual((await (await fetch(base + '/api/status')).json()).instance, { app: 'antena', id: record.id });
    });
  }
});

test('concurrent processes agree on one complete identity', { timeout: 30000 }, async t => {
  for (const [name, initial] of [['missing', undefined], ['corrupt', '{broken']]) {
    await t.test(name, async t => {
      const { dataDir, file } = await fixture(t, initial);
      const moduleUrl = new URL('../src/instance-id.mjs', import.meta.url).href;
      const program = `
        import { instanceId } from ${JSON.stringify(moduleUrl)};
        process.send({ type: 'ready' });
        process.once('message', async () => {
          try {
            const id = await instanceId(process.argv[1]);
            process.send({ type: 'result', id }, () => process.disconnect());
          } catch (error) {
            console.error(error);
            process.exitCode = 1;
            process.disconnect();
          }
        });
      `;
      const children = Array.from({ length: 12 }, () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', program, dataDir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        let output = '', error = '', id, readySeen = false, resolveReady, rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        const done = new Promise((resolve, reject) => {
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { error += chunk; });
          child.on('message', message => {
            if (message.type === 'ready') { readySeen = true; resolveReady(); }
            if (message.type === 'result') id = message.id;
          });
          child.on('error', err => { rejectReady(err); reject(err); });
          child.on('exit', (code, signal) => {
            if (!readySeen) rejectReady(new Error(`child exited before ready: ${code}, ${signal}; ${error}`));
            if (code !== 0 || signal !== null || output || error || typeof id !== 'string')
              reject(new Error(`child failed: ${code}, ${signal}; stdout=${output}; stderr=${error}`));
            else resolve(id);
          });
        });
        done.catch(() => {});
        return { child, ready, done };
      });
      try {
        await Promise.all(children.map(({ ready }) => ready));
        for (const { child } of children) child.send('go');
        const ids = await Promise.all(children.map(({ done }) => done));
        const record = JSON.parse(await readFile(file, 'utf8'));
        validRecord(record, dataDir);
        assert.deepEqual([...new Set(ids)], [record.id]);
      } finally {
        for (const { child } of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        await Promise.allSettled(children.map(({ done }) => done));
      }
    });
  }
});

test('unsupported hard links still publish one identity across processes', { timeout: 60000 }, async t => {
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']) {
    await t.test(code, async t => {
      const { dataDir, file } = await fixture(t);
      const moduleUrl = new URL('../src/instance-id.mjs', import.meta.url).href;
      const program = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        let calls = 0;
        fs.promises.link = async () => { calls++; throw Object.assign(new Error('unsupported'), { code: process.argv[2] }); };
        syncBuiltinESMExports();
        const { instanceId } = await import(${JSON.stringify(moduleUrl)});
        const id = await instanceId(process.argv[1]);
        console.log(JSON.stringify({ id, calls }));
      `;
      const run = async () => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', program, dataDir, code], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
        const [exit, signal] = await once(child, 'close');
        assert.equal(exit, 0, stderr); assert.equal(signal, null); assert.equal(stderr, '');
        return JSON.parse(stdout);
      };
      const results = await Promise.allSettled(Array.from({ length: 4 }, run));
      const ids = results.map(result => { if (result.status === 'rejected') throw result.reason; return result.value.id; });
      assert.ok(results.some(result => result.status === 'fulfilled' && result.value.calls > 0));
      const record = JSON.parse(await readFile(file, 'utf8')); validRecord(record, dataDir);
      assert.deepEqual([...new Set(ids)], [record.id]);
    });
  }
});

async function runWithRepairMkdirFault(dataDir, mode) {
  const moduleUrl = new URL('../src/instance-id.mjs', import.meta.url).href;
  const program = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const [dir, mode] = process.argv.slice(1);
    fs.promises.link = async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); };
    syncBuiltinESMExports();
    const mkdir = fs.mkdirSync, rmdir = fs.rmdirSync, rename = fs.renameSync;
    const fault = Object.assign(new Error('synthetic mkdir fault'), { code: mode === 'other' ? 'EACCES' : 'EPERM' });
    let attempts = 0, owners = 0, activeOwners = 0, peakOwners = 0, publications = 0;
    const delays = [];
    let releaseOwner;
    const ownerAcquired = new Promise(resolve => { releaseOwner = resolve; });
    fs.mkdirSync = function(file, ...args) {
      if (String(file).endsWith('.repair.lock')) {
        attempts++;
        if (mode !== 'transient' || attempts === 1) throw fault;
        const result = mkdir.call(this, file, ...args);
        owners++; activeOwners++; peakOwners = Math.max(peakOwners, activeOwners);
        releaseOwner();
        return result;
      }
      return mkdir.call(this, file, ...args);
    };
    fs.rmdirSync = function(file, ...args) {
      const result = rmdir.call(this, file, ...args);
      if (String(file).endsWith('.repair.lock')) activeOwners--;
      return result;
    };
    fs.renameSync = function(from, to) {
      const result = rename.call(this, from, to);
      if (String(to) === path.join(fs.realpathSync.native(dir), 'instance.json')) publications++;
      return result;
    };
    const delay = async ms => { delays.push(ms); if (mode === 'transient') await ownerAcquired; };
    if (mode === 'transient') {
      // Separate module instances have independent pending maps, like separate processes.
      const first = await import(${JSON.stringify(moduleUrl)} + '?fault-first');
      const second = await import(${JSON.stringify(moduleUrl)} + '?fault-second');
      const ids = await Promise.all([first.instanceId(dir, { delay }), second.instanceId(dir, { delay })]);
      console.log(JSON.stringify({ ids, attempts, owners, activeOwners, peakOwners, publications, delays }));
    } else {
      const { instanceId } = await import(${JSON.stringify(moduleUrl)});
      let caught;
      try { await instanceId(dir, { delay }); } catch (error) { caught = error; }
      console.log(JSON.stringify({ sameError: caught === fault, code: caught?.code, attempts, delays, owners }));
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, dataDir, mode],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [exit, signal] = await once(child, 'close');
  assert.equal(exit, 0, stderr); assert.equal(signal, null); assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('transient repair-lock EPERM retries without overlapping owners or publishing twice', async t => {
  const { dataDir, file } = await fixture(t);
  const result = await runWithRepairMkdirFault(dataDir, 'transient');
  const record = JSON.parse(await readFile(file, 'utf8'));
  validRecord(record, dataDir);
  assert.deepEqual(result.ids, [record.id, record.id]);
  assert.ok(result.attempts >= 2);
  assert.ok(result.owners >= 1);
  assert.equal(result.peakOwners, 1);
  assert.equal(result.activeOwners, 0);
  assert.equal(result.publications, 1);
  assert.equal(result.delays.length, 1);
  assert.ok(result.delays[0] > 0 && result.delays[0] <= 100);
  assert.deepEqual(await readdir(dataDir), ['instance.json']);
});

test('persistent repair-lock EPERM is bounded and unrelated errors still fail immediately', async t => {
  for (const mode of ['persistent', 'other']) await t.test(mode, async t => {
    const original = mode === 'persistent' ? '{broken' : undefined;
    const { dataDir, file } = await fixture(t, original);
    const result = await runWithRepairMkdirFault(dataDir, mode);
    assert.equal(result.sameError, true);
    assert.equal(result.code, mode === 'other' ? 'EACCES' : 'EPERM');
    assert.equal(result.owners, 0);
    if (mode === 'persistent') {
      assert.ok(result.attempts > 1 && result.attempts <= 10);
      assert.equal(result.delays.length, result.attempts - 1);
      assert.ok(result.delays.every(ms => ms > 0 && ms <= 100));
      assert.equal(await readFile(file, 'utf8'), original);
      assert.deepEqual(await readdir(dataDir), ['instance.json']);
    } else {
      assert.equal(result.attempts, 1);
      assert.deepEqual(result.delays, []);
      assert.deepEqual(await readdir(dataDir), []);
    }
  });
});

test('different data directories receive different ids', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  await first.start();
  await second.start();
  const a = JSON.parse(await readFile(first.file, 'utf8'));
  const b = JSON.parse(await readFile(second.file, 'utf8'));
  validRecord(a, first.dataDir); validRecord(b, second.dataDir);
  assert.notEqual(a.id, b.id);
});

test('a repair lock pending deletion is not stolen and does not abort startup', { timeout: 15000 }, async t => {
  const { dataDir: rawDir, file: rawFile } = await fixture(t);
  // instanceId() canonicalises the directory; Windows short paths would not match the injection.
  const dataDir = fs.realpathSync.native(rawDir), file = `${dataDir}${rawFile.slice(rawDir.length)}`;
  const lock = `${file}.repair.lock`;
  await writeFile(file, '{broken');
  // Stale by age, so it would be reclaimed once it can be read.
  await writeFile(lock, JSON.stringify({ pid: 2 ** 22, createdAt: 0, token: 'synthetic-lock' }));
  const { instanceId } = await import('../src/instance-id.mjs');
  const original = fs.readFileSync;
  let reads = 0;
  // Windows reports EPERM when opening a file another process already unlinked.
  fs.readFileSync = function patched(target, ...rest) {
    if (String(target) === lock && reads++ === 0) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM', syscall: 'open', path: lock });
    }
    return original.call(this, target, ...rest);
  };
  t.after(() => { fs.readFileSync = original; });
  const id = await instanceId(dataDir);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).id, id);
  assert.equal((await readdir(dataDir)).some(name => name.includes('.repair.lock')), false, 'lock released');
  assert.equal(reads > 0, true);
});
