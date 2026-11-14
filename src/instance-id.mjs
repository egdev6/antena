import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { link, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json-file.mjs';

const pending = new Map();
const LOCK_MAX_AGE_MS = 10000;
const LOCK_EPERM_RETRIES = 5;
const LOCK_EPERM_DELAY_MS = 20;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function publishExclusive(file, record, delay) {
  const candidate = `${file}.candidate-${randomBytes(16).toString('hex')}`;
  try {
    await writeJson(candidate, record);
    try { await link(candidate, file); return true; }
    catch (err) {
      if (err.code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(err.code)) throw err;
      if (file.endsWith('.repair.lock')) {
        for (let retries = 0; ; retries++) {
          try { fs.mkdirSync(file); break; }
          catch (e) {
            if (e.code === 'EEXIST') return false;
            // Windows may report EPERM while a removed directory is still pending deletion.
            if (e.code !== 'EPERM' || retries >= LOCK_EPERM_RETRIES) throw e;
            await delay(LOCK_EPERM_DELAY_MS);
          }
        }
        try { fs.writeFileSync(path.join(file, 'owner.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
        catch (e) { fs.rmdirSync(file); throw e; }
        return true;
      }
      return await withRepairLock(file, async (lock, token) => {
        if (!(await readRecord(file, record.directory)).missing || !ownsLock(lock, token)) return false;
        fs.renameSync(candidate, file);
        return true;
      }, delay);
    }
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

// A lock is a hard-linked file or a directory. Another process may be removing it while we
// inspect it: Windows then reports EPERM/EACCES/EBUSY instead of ENOENT. That says nothing about
// staleness, so it must neither abort startup nor count as ownership; the caller retries.
const TRANSIENT_LOCK_ERRORS = new Set(['ENOENT', 'EPERM', 'EACCES', 'EBUSY']);

function lockFile(lock) { return fs.lstatSync(lock).isDirectory() ? path.join(lock, 'owner.json') : lock; }
function unlinkLock(lock, file) { fs.unlinkSync(file); if (file !== lock) fs.rmdirSync(lock); }

// Re-read the token and the document immediately before the synchronous file operation.
function ownsLock(lock, token) {
  try {
    const text = fs.readFileSync(lockFile(lock), 'utf8');
    return JSON.parse(text).token === token && !staleLock(text);
  } catch (err) { if (TRANSIENT_LOCK_ERRORS.has(err.code) || err instanceof SyntaxError) return false; throw err; }
}

function removeStaleLock(lock) {
  try {
    const file = lockFile(lock);
    let first;
    try { first = fs.readFileSync(file, 'utf8'); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (file !== lock && Date.now() - fs.statSync(lock).mtimeMs >= LOCK_MAX_AGE_MS) fs.rmdirSync(lock);
      return;
    }
    if (file !== lock) {
      try { JSON.parse(first); } catch { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MAX_AGE_MS) return; }
    }
    if (staleLock(first) && fs.readFileSync(file, 'utf8') === first) unlinkLock(lock, file);
  } catch (err) { if (!TRANSIENT_LOCK_ERRORS.has(err.code)) throw err; }
}

// Known limitation (accepted in #124): the ownership check and the rename below are not atomic.
// An owner paused for longer than LOCK_MAX_AGE_MS between them can resume after its lock was
// reclaimed and move a newly valid identity aside. The file stays valid and consistent, but a
// server that already reported the previous id no longer matches it, so the desktop app shows a
// (false) conflict until that server restarts. No data is lost.
async function withRepairLock(file, action, delay) {
  const lock = `${file}.repair.lock`;
  const token = randomBytes(16).toString('hex');
  if (!(await publishExclusive(lock, { pid: process.pid, createdAt: Date.now(), token }, delay))) {
    removeStaleLock(lock);
    return false;
  }
  try { return await action(lock, token); }
  finally {
    try { if (ownsLock(lock, token)) unlinkLock(lock, lockFile(lock)); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

async function quarantineInvalid(file, directory, delay) {
  return withRepairLock(file, async (lock, token) => {
    const observed = await readRecord(file, directory);
    if (!observed.invalid || !ownsLock(lock, token)) return true;
    try {
      const latest = fs.readFileSync(file, 'utf8');
      if (latest === observed.text && ownsLock(lock, token)) {
        const target = `${file}.invalid-${Date.now()}-${randomBytes(8).toString('hex')}`;
        fs.renameSync(file, target);
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return true;
  }, delay);
}

async function load(dir, delay) {
  await mkdir(dir, { recursive: true });
  const directory = fs.realpathSync.native(dir);
  const file = path.join(directory, 'instance.json');
  for (;;) {
    const record = await readRecord(file, directory);
    if (record.id) return record.id;
    if (record.missing) {
      const id = randomBytes(16).toString('hex');
      if (await publishExclusive(file, { id, createdAt: new Date().toISOString(), directory }, delay)) return id;
    } else if (!(await quarantineInvalid(file, directory, delay))) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}

// Concurrent app factories in this process must not replace each other's new identity.
export function instanceId(dir, { delay = wait } = {}) {
  const resolved = path.resolve(dir);
  if (pending.has(resolved)) return pending.get(resolved);
  const job = load(resolved, delay).finally(() => pending.delete(resolved));
  pending.set(resolved, job);
  return job;
}
