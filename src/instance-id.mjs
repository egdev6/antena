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
// staleness, so inspecting it must neither abort startup nor count as ownership; the caller
// retries. Only inspection is covered: deletion errors keep their previous behaviour.
const TRANSIENT_LOCK_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const LOCK_RELEASE_RETRIES = 5;

function lockFile(lock) { return fs.lstatSync(lock).isDirectory() ? path.join(lock, 'owner.json') : lock; }
// null means "could not inspect right now": not a directory lock, not a stale lock.
function lockFileOrNull(lock) {
  try { return lockFile(lock); }
  catch (err) { if (TRANSIENT_LOCK_ERRORS.has(err.code) || err.code === 'ENOENT') return null; throw err; }
}
function unlinkLock(lock, file) { fs.unlinkSync(file); if (file !== lock) fs.rmdirSync(lock); }

// Re-read the token and the document immediately before the synchronous file operation.
function ownsLock(lock, token) {
  try {
    const file = lockFileOrNull(lock);
    if (!file) return false;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (err) { if (TRANSIENT_LOCK_ERRORS.has(err.code)) return false; throw err; }
    return JSON.parse(text).token === token && !staleLock(text);
  } catch (err) { if (TRANSIENT_LOCK_ERRORS.has(err.code) || err instanceof SyntaxError) return false; throw err; }
}

function removeStaleLock(lock) {
  const file = lockFileOrNull(lock);
  if (!file) return;
  try {
    let first;
    try { first = fs.readFileSync(file, 'utf8'); }
    catch (err) {
      if (TRANSIENT_LOCK_ERRORS.has(err.code)) return;
      if (err.code !== 'ENOENT') throw err;
      let age;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; }
      catch (statErr) { if (TRANSIENT_LOCK_ERRORS.has(statErr.code) || statErr.code === 'ENOENT') return; throw statErr; }
      if (file !== lock && age >= LOCK_MAX_AGE_MS) fs.rmdirSync(lock);
      return;
    }
    if (file !== lock) {
      try { JSON.parse(first); } catch { if (Date.now() - fs.statSync(lock).mtimeMs < LOCK_MAX_AGE_MS) return; }
    }
    let again;
    try { again = fs.readFileSync(file, 'utf8'); }
    catch (err) { if (TRANSIENT_LOCK_ERRORS.has(err.code)) return; throw err; }
    if (staleLock(first) && again === first) unlinkLock(lock, file);
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

// Releasing must not abandon our own lock just because one read failed while the previous
// owner's removal was still pending: retry the ownership check a bounded number of times.
async function releaseOwnedLock(lock, token, delay) {
  for (let attempt = 0; ; attempt++) {
    let owned;
    try { owned = ownsLock(lock, token); }
    catch (err) { if (err.code === 'ENOENT') return; throw err; }
    if (owned) {
      let file;
      try { file = lockFile(lock); }
      catch (err) {
        if (err.code === 'ENOENT') return;
        if (!TRANSIENT_LOCK_ERRORS.has(err.code)) throw err;
        file = null; // inspected a moment too early; retry below instead of abandoning our lock
      }
      if (file) { unlinkLock(lock, file); return; }
    }
    let present;
    try { fs.lstatSync(lock); present = true; }
    catch (err) { if (TRANSIENT_LOCK_ERRORS.has(err.code) || err.code === 'ENOENT') present = false; else throw err; }
    if (!present || attempt >= LOCK_RELEASE_RETRIES) return;
    await delay(LOCK_EPERM_DELAY_MS);
  }
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
  finally { await releaseOwnedLock(lock, token, delay); }
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
