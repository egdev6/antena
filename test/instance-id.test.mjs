import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
