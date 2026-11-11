import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { instanceId } from '../src/instance-id.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-identity-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

for (const [name, contents] of [
  ['empty', async () => ''],
  ['dead owner', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0); assert.equal(signal, null);
    return JSON.stringify({ pid: child.pid, createdAt: Date.now(), token: 'dead-owner' });
  }],
  ['aged owner', async () => JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60000, token: 'old-owner' })],
]) {
  test(`corrupt identity recovers from a ${name} lock`, { timeout: 12000 }, async t => {
    const dir = await fixture(t);
    const file = path.join(dir, 'instance.json');
    await writeFile(file, '{broken');
    await writeFile(file + '.repair.lock', await contents());
    const started = Date.now();
    const id = await instanceId(dir);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).id, id);
    assert.ok(Date.now() - started < 8000, 'stale repair must not block startup');
  });
}

// Known limitation accepted in #124 (see src/instance-id.mjs, quarantineInvalid): a repairer paused
// past LOCK_MAX_AGE_MS may replace the identity created meanwhile. What must still hold is that the
// stored file ends valid and is exactly the id the resumed process reports, never a torn state.
test('a paused stale repairer leaves one consistent valid identity', { timeout: 15000 }, async t => {
  const dir = await fixture(t);
  const file = path.join(dir, 'instance.json');
  const paused = path.join(dir, 'paused'), resume = path.join(dir, 'resume');
  await writeFile(file, '{broken');
  const moduleUrl = new URL('../src/instance-id.mjs', import.meta.url).href;
  const program = `
    import fs from 'node:fs';
    import path from 'node:path';
    const [dir, paused, resume] = process.argv.slice(1);
    const original = fs.renameSync;
    const identity = path.join(fs.realpathSync.native(dir), 'instance.json');
    fs.renameSync = (from, to) => {
      if (from === identity) {
        fs.writeFileSync(paused, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(resume) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 10);
        if (!fs.existsSync(resume)) throw new Error('resume timed out');
      }
      return original(from, to);
    };
    const { instanceId } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(await instanceId(dir));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, dir, paused, resume], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const exit = once(child, 'exit');
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await readFile(paused); break; }
      catch (err) { if (err.code !== 'ENOENT' || Date.now() >= deadline) throw err; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const lockFile = file + '.repair.lock';
    const lock = JSON.parse(await readFile(lockFile, 'utf8'));
    await writeFile(lockFile, JSON.stringify({ ...lock, createdAt: Date.now() - 60000 }));
    const stable = await instanceId(dir);
    await writeFile(resume, 'continue');
    const [code, signal] = await exit;
    assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, '');
    const stored = JSON.parse(await readFile(file, 'utf8')).id;
    assert.match(stable, /^[0-9a-f]{32}$/);
    assert.match(stored, /^[0-9a-f]{32}$/);
    assert.equal(stdout, stored, 'the resumed process reports the id that is stored');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
  }
});

test('a copied data directory receives a distinct directory-bound identity', async t => {
  const root = await fixture(t);
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  await Promise.all([mkdir(a), mkdir(b)]);
  const original = await instanceId(a);
  await copyFile(path.join(a, 'instance.json'), path.join(b, 'instance.json'));
  const copy = await instanceId(b);
  assert.notEqual(copy, original);
  assert.equal((JSON.parse(await readFile(path.join(a, 'instance.json'), 'utf8'))).id, original);
  const record = JSON.parse(await readFile(path.join(b, 'instance.json'), 'utf8'));
  assert.equal(record.id, copy);
  assert.equal(record.directory, realpathSync.native(b));
});
