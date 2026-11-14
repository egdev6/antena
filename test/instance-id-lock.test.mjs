// #173: the instance-identity repair lock is a hard-linked file or a directory. Another process
// removing it makes Windows report EPERM/EACCES/EBUSY instead of ENOENT. Inspecting the lock must
// tolerate that (no abort, no stealing), while deletion errors and everything else keep surfacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { instanceId } = await import(new URL('../src/instance-id.mjs', import.meta.url).href);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, shape = 'file') {
  const dir = await mkdtemp(path.join(tmpdir(), 'lock-independent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'instance.json'), lock = file + '.repair.lock';
  const corrupt = Buffer.from('{broken');
  fs.writeFileSync(file, corrupt);
  if (shape === 'directory') fs.mkdirSync(lock);
  const owner = shape === 'directory' ? path.join(lock, 'owner.json') : lock;
  const lockBytes = Buffer.from(JSON.stringify({ pid: process.pid, createdAt: 0, token: 'stale' }));
  fs.writeFileSync(owner, lockBytes);
  return { dir, file, lock, owner, corrupt, lockBytes };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) for (const shape of ['file', 'directory']) {
  test(`stale ${shape} deletion ${code} surfaces unchanged`, async t => {
    const f = await fixture(t, shape), original = fs.unlinkSync;
    const error = Object.assign(new Error(`synthetic ${code} unlink`), { code });
    let calls = 0;
    fs.unlinkSync = function (target, ...args) {
      if (String(target) === f.owner && calls++ === 0) throw error;
      return original.call(this, target, ...args);
    };
    try {
      await assert.rejects(instanceId(f.dir), err => err === error);
      assert.deepEqual(fs.readFileSync(f.file), f.corrupt);
      assert.deepEqual(fs.readFileSync(f.owner), f.lockBytes);
    } finally { fs.unlinkSync = original; }
  });
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`old empty directory removal ${code} surfaces unchanged`, async t => {
    const f = await fixture(t, 'directory'), unlink = fs.unlinkSync;
    unlink(f.owner);
    fs.utimesSync(f.lock, new Date(0), new Date(0));
    const original = fs.rmdirSync;
    const error = Object.assign(new Error(`synthetic ${code} rmdir`), { code });
    let calls = 0;
    fs.rmdirSync = function (target, ...args) {
      if (String(target) === f.lock && calls++ === 0) throw error;
      return original.call(this, target, ...args);
    };
    try {
      await assert.rejects(instanceId(f.dir), err => err === error);
      assert.deepEqual(fs.readFileSync(f.file), f.corrupt);
      assert.deepEqual(fs.readdirSync(f.lock), []);
    } finally { fs.rmdirSync = original; }
  });
}

test('a one-time EPERM during the final ownership check releases our lock', async t => {
  const f = await fixture(t), read = fs.readFileSync;
  fs.unlinkSync(f.lock);
  let reads = 0, injected = false;
  fs.readFileSync = function (target, ...args) {
    if (String(target) === f.lock && ++reads === 3) {
      injected = true;
      throw Object.assign(new Error('synthetic EPERM final read'), { code: 'EPERM' });
    }
    return read.call(this, target, ...args);
  };
  try {
    const id = await instanceId(f.dir);
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.equal(injected, true);
    await pause(150);
    assert.equal(fs.existsSync(f.lock), false, 'our uncontended lock must not be abandoned');
  } finally { fs.readFileSync = read; }
});

test('a stale lock pending deletion is reclaimed instead of aborting startup', async t => {
  for (const shape of ['file', 'directory']) {
    const f = await fixture(t, shape), read = fs.readFileSync;
    let injected = false;
    fs.readFileSync = function (target, ...args) {
      if (!injected && (String(target) === f.lock || String(target) === f.owner)) {
        injected = true;
        throw Object.assign(new Error(`synthetic EPERM ${shape}`), { code: 'EPERM' });
      }
      return read.call(this, target, ...args);
    };
    try {
      const id = await instanceId(f.dir);
      assert.match(id, /^[0-9a-f]{32}$/);
      assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).id, id);
      assert.equal(fs.existsSync(f.lock), false, `${shape}: lock released`);
    } finally { fs.readFileSync = read; }
  }
});
