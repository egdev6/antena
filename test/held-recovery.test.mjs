import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAlert, buildCustomAlert } from '../src/alerts.mjs';
import { createHeldRecovery } from '../src/held-recovery.mjs';

// POSIX modes, symlinks and O_NOFOLLOW are this suite's contract. Windows has
// a separate real-helper ACL/storage suite, not a relaxed mode assertion.
const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' ? 'POSIX filesystem contract; native Windows ACL equivalent in held-recovery-windows-storage.test.mjs' : false }, fn);

const ids = [1, 2, 3].map(n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const date = '2026-10-17T12:00:00.000Z';
const fixture = () => buildCustomAlert({ text: '{message}', actions: [{ kind: 'command', command: 'PRIVATE-COMMAND' }], ttsEnabled: true }, { message: 'PRIVATE-TEXT', optional: undefined }, {});
async function setup(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'held-case-'));
  let next = 0;
  const config = { dir, maxAlertBytes: 8192, maxBatchBytes: 32768, uuid: () => ids[next++], now: () => date, ...options };
  return { dir, config, api: createHeldRecovery(config), file: id => path.join(dir, 'held-recovery', id, 'batch.json') };
}
const listing = api => api.list({ limit: 20 });

// Synthetic data only; IO failures must not leak their message, code or cause.
const canary = 'PRIVATE-IO-CANARY';
function safeFailure(error, { phase, publication, code }, dir) {
  assert.equal(error.name, 'HeldRecoverySaveError');
  assert.equal(error.message, 'Held recovery save failed');
  assert.equal(error.phase, phase);
  assert.equal(error.publication, publication);
  assert.equal(error.code, code);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  const rendered = [String(error), JSON.stringify(error), JSON.stringify(error, Object.getOwnPropertyNames(error))].join('\n');
  for (const secret of [canary, dir, 'PRIVATE-COMMAND', 'PRIVATE-TEXT']) assert.equal(rendered.includes(secret), false);
  return true;
}

test('un listado bloquea con base o ancestro configurado ausente, no es una cola vacía', async () => {
  const h = await setup();
  for (const suffix of ['absent', 'absent/child']) {
    const api = createHeldRecovery({ ...h.config, dir: path.join(h.dir, suffix) });
    assert.deepEqual(await listing(api), { state: 'blocked', batches: [], limited: false });
  }
});

test('solo el namespace ausente bajo una base validada es vacío; fallos de tipo y permiso bloquean', async () => {
  const h = await setup();
  assert.deepEqual(await listing(h.api), { state: 'ok', batches: [], limited: false });
  const root = path.join(h.dir, 'held-recovery');
  for (const target of [h.dir, root]) {
    for (const code of ['EACCES', 'ENOTDIR']) {
      const io = { ...fs, lstat: async file => {
        if (file === target) throw Object.assign(new Error(canary), { code });
        return fs.lstat(file);
      } };
      assert.deepEqual(await listing(createHeldRecovery({ ...h.config, io })), { state: 'blocked', batches: [], limited: false });
    }
  }
  await fs.mkdir(root, { mode: 0o755 });
  assert.equal((await listing(h.api)).state, 'blocked');
});

test('un listado bloquea un error IO cuyo getter de code lanza, sin exponer diagnóstico', async () => {
  const h = await setup();
  const raw = Object.assign(new Error(`${canary} ${h.dir}`), { path: h.dir });
  const outer = new Error('fixture namespace failure');
  Object.defineProperty(outer, 'code', { get() { throw raw; } });
  const io = { ...fs, lstat: async target => {
    if (target === path.join(h.dir, 'held-recovery')) throw outer;
    return fs.lstat(target);
  } };
  const result = await listing(createHeldRecovery({ ...h.config, io }));
  assert.deepEqual(result, { state: 'blocked', batches: [], limited: false });
  assert.equal(JSON.stringify(result).includes(canary), false);
});

const failures = [
  { stage: 'access', phase: 'access', publication: 'not-published', code: 'EACCES' },
  { stage: 'mkdir', phase: 'mkdir', publication: 'not-published', code: 'EACCES' },
  { stage: 'open', phase: 'open', publication: 'not-published', code: 'EIO' },
  { stage: 'write', phase: 'write', publication: 'not-published', code: 'ENOSPC' },
  { stage: 'write-close', phase: 'write', publication: 'not-published', code: 'ENOSPC' },
  { stage: 'close', phase: 'close', publication: 'not-published', code: 'EIO' },
  { stage: 'link-before', phase: 'link', publication: 'unknown', code: 'ENOTSUP' },
  { stage: 'link-unknown-code', phase: 'link', publication: 'unknown', code: 'EIO' },
  { stage: 'link-after', phase: 'link', publication: 'unknown', code: 'EIO', published: true },
  { stage: 'unlink-before', phase: 'unlink', publication: 'published', code: 'EIO', published: true },
  { stage: 'unlink-after', phase: 'unlink', publication: 'published', code: 'EIO', published: true },
];
for (const expected of failures) test(`fallo de guardado ${expected.stage}: fase segura y ${expected.publication}, sin reintento`, async () => {
  const h = await setup();
  await h.api.save([fixture()]);
  const before = await fs.readFile(h.file(ids[0]));
  const folder = path.dirname(h.file(ids[1]));
  const calls = { mkdir: 0, open: 0, write: 0, close: 0, link: 0, unlink: 0 };
  const boom = () => Object.assign(new Error(`${canary} ${h.dir} PRIVATE-TEXT PRIVATE-COMMAND`), {
    code: expected.stage === 'link-unknown-code' ? canary : expected.code,
    path: h.dir, payload: fixture(), cause: new Error(canary),
  });
  const io = { ...fs,
    lstat: async file => {
      if (expected.stage === 'access' && file === h.dir) throw boom();
      return fs.lstat(file);
    },
    mkdir: async (file, options) => {
      if (file === folder) {
        calls.mkdir++;
        if (expected.stage === 'mkdir') throw boom();
      }
      return fs.mkdir(file, options);
    },
    open: async (...args) => {
      calls.open++;
      if (expected.stage === 'open') throw boom();
      const handle = await fs.open(...args);
      return {
        writeFile: async text => {
          calls.write++;
          if (expected.phase === 'write') { await handle.writeFile(text.slice(0, 17)); throw boom(); }
          await handle.writeFile(text);
        },
        close: async () => {
          calls.close++;
          await handle.close();
          if (['close', 'write-close'].includes(expected.stage)) throw boom();
        },
      };
    },
    link: async (...args) => {
      calls.link++;
      if (['link-before', 'link-unknown-code'].includes(expected.stage)) throw boom();
      await fs.link(...args);
      if (expected.stage === 'link-after') throw boom();
    },
    unlink: async (...args) => {
      calls.unlink++;
      if (expected.stage === 'unlink-before') throw boom();
      await fs.unlink(...args);
      if (expected.stage === 'unlink-after') throw boom();
    },
  };
  await assert.rejects(createHeldRecovery({ ...h.config, io, uuid: () => ids[1] }).save([fixture()]),
    error => safeFailure(error, expected, h.dir));
  assert.deepEqual(await fs.readFile(h.file(ids[0])), before);
  const phases = ['access', 'mkdir', 'open', 'write', 'close', 'link', 'unlink'];
  for (const key of Object.keys(calls)) {
    // A write failure still closes the handle once; nothing advances to link.
    const reached = phases.indexOf(key) <= phases.indexOf(expected.phase) || (key === 'close' && expected.phase === 'write');
    assert.equal(calls[key], reached ? 1 : 0, key);
  }
  const hasFolder = !['access', 'mkdir'].includes(expected.phase);
  const names = hasFolder ? (await fs.readdir(folder)).sort() : [];
  if (!hasFolder) await assert.rejects(fs.lstat(folder), { code: 'ENOENT' });
  const hasTemp = !['access', 'mkdir', 'open'].includes(expected.phase) && expected.stage !== 'unlink-after';
  assert.deepEqual(names, [hasTemp ? '.batch.tmp' : null, expected.published ? 'batch.json' : null].filter(Boolean));
  const result = await listing(h.api);
  assert.equal(result.state, !hasFolder || expected.stage === 'unlink-after' ? 'ok' : 'blocked');
  assert.equal(result.batches.length, expected.stage === 'unlink-after' ? 2 : 1);
  if (expected.published) {
    const raw = await fs.readFile(h.file(ids[1]), 'utf8');
    assert.equal(JSON.parse(raw).records[0].state, 'not-dispatched');
    if (hasTemp) assert.equal(await fs.readFile(path.join(folder, '.batch.tmp'), 'utf8'), raw);
  }
});

test('ida y vuelta de alertas finalizadas reales, ids duplicados, lotes independientes privados concurrentes; solo metadatos', async () => {
  const h = await setup();
  const alert = fixture();
  assert.ok(Object.hasOwn(alert, 'commandId'));
  const standard = buildAlert('follow', { user: 'PRIVATE-USER' }, {});
  const [a, b] = await Promise.all([h.api.save([alert, alert, standard]), h.api.save([standard])]);
  assert.notEqual(a.batchId, b.batchId);
  const raw = await fs.readFile(h.file(a.batchId), 'utf8');
  const saved = JSON.parse(raw);
  assert.deepEqual(saved, { version: 1, app: 'antena', batchId: a.batchId, createdAt: date, state: 'pending', records: [alert, alert, standard].map((value, ordinal) => ({ id: value.id, ordinal, state: 'not-dispatched', alert: JSON.parse(JSON.stringify(value)) })) });
  for (const target of [path.join(h.dir, 'held-recovery'), path.dirname(h.file(a.batchId))]) assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(h.file(a.batchId))).mode & 0o777, 0o600);
  const meta = await listing(h.api);
  assert.equal(meta.state, 'ok');
  assert.deepEqual(meta.batches.find(x => x.batchId === a.batchId), { batchId: a.batchId, createdAt: date, state: 'pending', count: 3 });
  assert.doesNotMatch(JSON.stringify(meta), /PRIVATE|command|vars|\/|records/);
  assert.equal(await fs.readFile(h.file(a.batchId), 'utf8'), raw);
});

test('la colisión de identidad es un EEXIST visible, nunca se reutiliza ni se reintenta; un UUID inválido no atraviesa', async () => {
  const h = await setup({ uuid: () => ids[0] });
  await h.api.save([fixture()]);
  const before = await fs.readFile(h.file(ids[0]), 'utf8');
  await assert.rejects(h.api.save([fixture()]), error => safeFailure(error,
    { phase: 'mkdir', publication: 'not-published', code: 'EEXIST' }, h.dir));
  assert.equal(await fs.readFile(h.file(ids[0]), 'utf8'), before);
  await assert.rejects(createHeldRecovery({ ...h.config, uuid: () => '../outside' }).save([fixture()]));
});

test('datos no seguros rechazan el lote entero sin invocar getters, toJSON ni acciones', async () => {
  const h = await setup();
  let calls = 0;
  const getter = fixture();
  Object.defineProperty(getter, 'text', { get() { calls++; return 'unsafe'; }, enumerable: true });
  const json = fixture();
  json.toJSON = () => { calls++; return {}; };
  const cycle = fixture(); cycle.vars.self = cycle;
  const proxy = new Proxy({}, { ownKeys() { calls++; return []; } });
  const invalid = [getter, json, cycle, { ...fixture(), vars: proxy }, { ...fixture(), type: 3 }, { ...fixture(), id: '' }, { ...fixture(), actions: {} }, { ...fixture(), vars: [] }];
  for (const value of [NaN, Infinity, 1n, Symbol('x'), () => { calls++; }, new Date(), [undefined], [,], Object.create({ inherited: true })]) invalid.push({ ...fixture(), extra: value });
  invalid.push(Object.assign(fixture(), { [Symbol('hidden')]: 1 }));
  for (const alert of invalid) await assert.rejects(h.api.save([fixture(), alert]));
  assert.equal(calls, 0);
  assert.equal((await listing(h.api)).batches.length, 0);
  const executable = fixture(); executable.actions.push({ kind: 'command', run() { calls++; } });
  await assert.rejects(h.api.save([executable]));
  assert.equal(calls, 0);
});

test('límites de bytes positivos explícitos; una alerta o lote demasiado grande se rechaza, nunca se recorta', async () => {
  const h = await setup();
  for (const value of [undefined, 0, -1, Infinity, 1.2]) {
    assert.throws(() => createHeldRecovery({ ...h.config, maxAlertBytes: value }));
    assert.throws(() => createHeldRecovery({ ...h.config, maxBatchBytes: value }));
  }
  for (const limits of [{ maxAlertBytes: 10 }, { maxBatchBytes: 10 }]) {
    await assert.rejects(createHeldRecovery({ ...h.config, ...limits }).save([fixture()]));
  }
  assert.equal((await listing(h.api)).batches.length, 0);
  await assert.rejects(h.api.list({ limit: 0 }));
});

test('los fallos de write/link conservan el lote previo y dejan la evidencia incompleta bloqueada', async () => {
  for (const stage of ['write', 'link']) {
    const h = await setup();
    await h.api.save([fixture()]);
    const before = await fs.readFile(h.file(ids[0]), 'utf8');
    const io = { ...fs, ...(stage === 'link' ? { link: async () => { throw Object.assign(new Error('unsupported link'), { code: 'ENOTSUP' }); } } : { open: async (...args) => {
      const handle = await fs.open(...args);
      return { writeFile: async () => { throw new Error('write failed'); }, close: () => handle.close() };
    } }) };
    await assert.rejects(createHeldRecovery({ ...h.config, io, uuid: () => ids[1] }).save([fixture()]));
    assert.equal(await fs.readFile(h.file(ids[0]), 'utf8'), before);
    assert.equal((await listing(h.api)).state, 'blocked');
  }
});

test('las entradas corruptas, de versión desconocida, incompletas, demasiado grandes y temporales se bloquean sin reescribir', async () => {
  for (const change of ['corrupt', 'version', 'temporary', 'incomplete', 'oversized', 'record']) {
    const h = await setup();
    await h.api.save([fixture()]);
    const file = h.file(ids[0]);
    let raw = await fs.readFile(file, 'utf8');
    if (change === 'corrupt') raw = '{';
    if (change === 'version') raw = raw.replace('"version":1', '"version":2');
    if (change === 'record') { const data = JSON.parse(raw); data.records[0].ordinal = 9; raw = JSON.stringify(data); }
    if (change === 'oversized') raw = ' '.repeat(32769);
    await fs.writeFile(file, raw);
    if (change === 'temporary') await fs.writeFile(path.join(path.dirname(file), '.own.tmp'), 'private');
    if (change === 'incomplete') await fs.mkdir(path.join(h.dir, 'held-recovery', ids[1]), { mode: 0o700 });
    assert.equal((await listing(h.api)).state, 'blocked', change);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});

test('los enlaces simbólicos en base, raíz, lote y fichero se rechazan sin leer payload externo', async () => {
  for (const level of ['base', 'root', 'batch', 'file']) {
    const h = await setup();
    const external = await setup();
    await external.api.save([fixture()]);
    if (level === 'base') {
      const alias = path.join(h.dir, 'alias'); await fs.symlink(external.dir, alias);
      const api = createHeldRecovery({ ...h.config, dir: alias });
      await assert.rejects(api.save([fixture()]));
      assert.equal((await listing(api)).state, 'blocked');
    } else {
      const root = path.join(h.dir, 'held-recovery');
      if (level !== 'root') await fs.mkdir(root, { mode: 0o700 });
      const batch = path.join(root, ids[0]);
      if (level === 'file') await fs.mkdir(batch, { mode: 0o700 });
      const target = level === 'root' ? root : level === 'batch' ? batch : h.file(ids[0]);
      const source = level === 'root' ? path.join(external.dir, 'held-recovery') : level === 'batch' ? path.dirname(external.file(ids[0])) : external.file(ids[0]);
      await fs.symlink(source, target);
      assert.equal((await listing(h.api)).state, 'blocked');
      await assert.rejects(h.api.save([fixture()]));
    }
    assert.equal((await listing(external.api)).state, 'ok');
  }
});

test('un EEXIST de publicación final nunca sustituye un fichero, y los link no soportados nunca hacen rename', async () => {
  const h = await setup();
  let renames = 0;
  const api = createHeldRecovery({ ...h.config, io: { ...fs,
    link: async (temp, target) => {
      await fs.writeFile(target, 'ORIGINAL', { flag: 'wx', mode: 0o600 });
      return fs.link(temp, target);
    },
    rename: async () => { renames++; },
  } });
  await assert.rejects(api.save([fixture()]), error => safeFailure(error,
    { phase: 'link', publication: 'unknown', code: 'EEXIST' }, h.dir));
  assert.equal(await fs.readFile(h.file(ids[0]), 'utf8'), 'ORIGINAL');
  assert.equal(renames, 0);
  assert.equal((await listing(h.api)).state, 'blocked');
});

test('las instantáneas aceptadas se desacoplan antes de la IO asíncrona', async () => {
  const h = await setup();
  const alert = fixture();
  const pending = h.api.save([alert]);
  alert.actions[0].command = 'changed'; alert.vars.message = 'changed';
  const saved = await pending;
  const data = JSON.parse(await fs.readFile(h.file(saved.batchId), 'utf8'));
  assert.equal(data.records[0].alert.actions[0].command, 'PRIVATE-COMMAND');
  assert.equal(data.records[0].alert.vars.message, 'PRIVATE-TEXT');
});

test('el listado es acotado de forma explícita y nunca repite las acciones guardadas', async () => {
  const h = await setup();
  await h.api.save([fixture()]); await h.api.save([fixture()]);
  const meta = await h.api.list({ limit: 1 });
  assert.equal(meta.state, 'blocked'); assert.equal(meta.limited, true); assert.equal(meta.batches.length, 1);
  assert.deepEqual(Object.keys(h.api).sort(), ['list', 'save']);
});
