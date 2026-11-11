import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { link, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';

const pending = new Map();
const LOCK_MAX_AGE_MS = 10000;

function valid(record, directory) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.id !== 'string' || !/^[0-9a-f]{32}$/.test(record.id)
    || typeof record.createdAt !== 'string' || record.directory !== directory) return false;
  const date = new Date(record.createdAt);
  return Number.isFinite(date.getTime()) && date.toISOString() === record.createdAt;
}

async function readRecord(file, directory) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return { missing: true }; throw err; }
  try {
    const record = JSON.parse(text);
    if (valid(record, directory)) return { id: record.id };
  } catch { /* An invalid JSON document is quarantined below. */ }
  return { invalid: true, text };
}

async function publishExclusive(file, record) {
  const candidate = `${file}.candidate-${randomBytes(16).toString('hex')}`;
  try {
    await writeJson(candidate, record);
    try { await link(candidate, file); return true; }
    catch (err) { if (err.code === 'EEXIST') return false; throw err; }
  } finally {
    await unlink(candidate).catch(err => { if (err.code !== 'ENOENT') throw err; });
  }
}

function ownerAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

function staleLock(text) {
  try {
    const lock = JSON.parse(text);
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !Number.isFinite(lock.createdAt)
      || typeof lock.token !== 'string' || !lock.token) return true;
    const age = Date.now() - lock.createdAt;
    return age < 0 || age >= LOCK_MAX_AGE_MS || !ownerAlive(lock.pid);
  } catch { return true; }
}

// Re-read the token and the document immediately before the synchronous file operation.
function ownsLock(lock, token) {
  try {
    const text = fs.readFileSync(lock, 'utf8');
    return JSON.parse(text).token === token && !staleLock(text);
  } catch (err) { if (err.code === 'ENOENT' || err instanceof SyntaxError) return false; throw err; }
}

function removeStaleLock(lock) {
  try {
    const first = fs.readFileSync(lock, 'utf8');
    if (staleLock(first) && fs.readFileSync(lock, 'utf8') === first) fs.unlinkSync(lock);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

// Known limitation (accepted in #124): the ownership check and the rename below are not atomic.
// An owner paused for longer than LOCK_MAX_AGE_MS between them can resume after its lock was
// reclaimed and move a newly valid identity aside. The file stays valid and consistent, but a
// server that already reported the previous id no longer matches it, so the desktop app shows a
// (false) conflict until that server restarts. No data is lost.
async function quarantineInvalid(file, directory) {
  const lock = `${file}.repair.lock`;
  const token = randomBytes(16).toString('hex');
  const record = { pid: process.pid, createdAt: Date.now(), token };
  if (!(await publishExclusive(lock, record))) {
    removeStaleLock(lock);
    return false;
  }
  try {
    const observed = await readRecord(file, directory);
    if (!observed.invalid || !ownsLock(lock, token)) return true;
    try {
      const latest = fs.readFileSync(file, 'utf8');
      if (latest === observed.text && ownsLock(lock, token)) {
        const target = `${file}.invalid-${Date.now()}-${randomBytes(8).toString('hex')}`;
        fs.renameSync(file, target);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  } finally {
    try { if (ownsLock(lock, token)) fs.unlinkSync(lock); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  return true;
}

async function load(dir) {
  await mkdir(dir, { recursive: true });
  const directory = fs.realpathSync.native(dir);
  const file = path.join(directory, 'instance.json');
  for (;;) {
    const record = await readRecord(file, directory);
    if (record.id) return record.id;
    if (record.missing) {
      const id = randomBytes(16).toString('hex');
      if (await publishExclusive(file, { id, createdAt: new Date().toISOString(), directory })) return id;
    } else if (!(await quarantineInvalid(file, directory))) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

// Concurrent app factories in this process must not replace each other's new identity.
export function instanceId(dir) {
  const resolved = path.resolve(dir);
  if (pending.has(resolved)) return pending.get(resolved);
  const job = load(resolved).finally(() => pending.delete(resolved));
  pending.set(resolved, job);
  return job;
}
