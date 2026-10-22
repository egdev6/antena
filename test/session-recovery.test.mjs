// ODD-06b.2 · Recuperación y bloqueo ante corrupción (tests primero).
// El Session actual ignora `io`, no fusiona defaults, no valida el esquema, no lee
// el backup al cargar y no expone `recoveryState()`: ante un primary corrupto produce
// datos frescos en silencio (pérdida de historial invisible). Estos casos describen el
// contrato que implementará el PADRE y fallan contra el fuente actual (RED real).
// El archivo concurrente (b3) queda fuera de esta unidad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { writeJson } from '../src/json-file.mjs';

// Directorio propio por caso: cada test limpia solo lo que creó.
async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-session-recovery-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
const primaryOf = dir => path.join(dir, 'session-current.json');
const backupOf = dir => path.join(dir, 'session-current.backup.json');
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));
const CANARY = 'CANARY-RECOVERY-SECRET-9';
const SEED = 'CANARY-RECOVERY-BYTES';
const errno = (code, msg) => Object.assign(new Error(msg), { code });
const entriesCorrupt = async dir => (await fsp.readdir(dir)).filter(n => /^session-current\.corrupt-[\w-]+\.json$/.test(n));

// Dominio "pagado" completo: importes, agradecimientos, notas, goalOffsets con métrica
// desconocida + null y campos extra en raíz/evento/nota. Es lo que un backup válido
// debe devolver íntegro (preservación exacta, sin normalizar ni filtrar).
function fullDomain() {
  return {
    ...Session.fresh('directo de prueba'),
    id: 'legacy-2026-10-10T12-00-00Z',
    startedAt: new Date(1_700_000_000_000).toISOString(),
    events: [
      { id: 'ev:1', type: 'cheer', at: new Date(1_700_000_001_000).toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '', thanked: true, extra: 'keep-event' },
      { id: 'ev:2', type: 'follow', at: new Date(1_700_000_002_000).toISOString(), vars: { user: 'bea' }, text: 'bea', sub: '' },
    ],
    notes: [
      { id: 'note:1', kind: 'winner', at: new Date(1_700_000_003_000).toISOString(), user: 'bea', label: 'premio', extra: 'keep-note' },
      { id: 'note:2', kind: 'marker', at: new Date(1_700_000_004_000).toISOString(), label: 'marca' },
    ],
    goalOffsets: { bits: 10, 'metrica-desconocida': 7, otros: null },
    customRoot: 'keep-root',
  };
}
// El error público de bloqueo debe ser acotado, constante y sin crudo.
function assertSafeBlock(err) {
  assert.ok(err, 'load debe rechazar con bloqueo seguro');
  assert.equal(err.code, 'SESSION_RECOVERY_FAILED');
  assert.equal(err.status, 500);
  assert.ok(typeof err.message === 'string' && err.message.trim().length > 0 && err.message.length < 200);
  assert.doesNotMatch(err.message, /CANARY|session-current|\.json|\/tmp|EACCES|ENOENT|EIO|SyntaxError|Unexpected|errno/);
  assert.equal(err.cause, undefined);              // sin causa cruda ni eco del SyntaxError
}
// IO parcial observable: registra operaciones y permite forzar fallos; el Session debe
// fusionar los métodos ausentes con los defaults reales.
function spyIO(overrides = {}) {
  const calls = [];
  const readFile = (f, ...a) => { calls.push({ op: 'readFile', file: f }); return (overrides.readFile || fsp.readFile)(f, ...a); };
  const rename = (s, d) => { calls.push({ op: 'rename', from: s, to: d }); return (overrides.rename || fsp.rename)(s, d); };
  const readdir = (f, ...a) => { calls.push({ op: 'readdir', file: f }); return (overrides.readdir || fsp.readdir)(f, ...a); };
  return { io: { readFile, rename, readdir }, calls };
}

test('primary válido con backup corrupto: no lee el backup, conserva el dominio y los extras', async t => {
  const dir = await ownDir(t);
  const legacy = {   // sin id ni startedAt: los defaults frescos rellenan (compatibilidad)
    title: 'legado', events: [{ id: 'e:1', type: 'cheer', at: '2026-01-01T00:00:00.000Z', vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '', thanked: true }],
    notes: [{ id: 'n:1', kind: 'winner', user: 'bea', label: 'premio' }], goalOffsets: { bits: 10, 'metrica-rara': 3, otro: null }, extraRoot: 'keep',
  };
  await writeJson(primaryOf(dir), legacy);
  await fsp.writeFile(backupOf(dir), `{ backup roto ${CANARY}`);
  const { io, calls } = spyIO();
  const reports = [];
  const s = await new Session(dir, { io, report: m => reports.push(m) }).load();

  assert.deepEqual(s.data.events, legacy.events);          // dominio primero: el defecto real es la pérdida
  assert.deepEqual(s.data.notes, legacy.notes);
  assert.deepEqual(s.data.goalOffsets, legacy.goalOffsets);
  assert.equal(s.data.extraRoot, 'keep');
  assert.equal(typeof s.data.id, 'string');
  assert.ok(s.data.startedAt);
  assert.deepEqual(s.recoveryState(), { source: 'primary', preservedFiles: 0, message: null });
  assert.equal(calls.filter(c => c.op === 'readFile' && c.file === primaryOf(dir)).length, 1);
  assert.equal(calls.filter(c => c.op === 'readFile' && c.file === backupOf(dir)).length, 0);   // no lee el backup
  assert.deepEqual(reports, []);                            // sin warning en una carga válida
});

test('ambos ficheros ausentes: arranque fresco normal y estado copiable', async t => {
  const dir = await ownDir(t);
  const { io, calls } = spyIO();
  const reports = [];
  const s = await new Session(dir, { io, report: m => reports.push(m) }).load();

  assert.deepEqual(s.data.events, []);
  assert.deepEqual(s.data.notes, []);
  assert.deepEqual(s.data.goalOffsets, {});
  const st = s.recoveryState();
  assert.deepEqual(st, { source: 'fresh', preservedFiles: 0, message: null });
  st.source = 'mutado';                                     // copia defensiva: mutar no cambia el interno
  assert.equal(s.recoveryState().source, 'fresh');
  assert.deepEqual(reports, []);
  assert.equal(calls.filter(c => c.op === 'readFile' && c.file === backupOf(dir)).length, 0);
  await assert.rejects(fsp.readFile(primaryOf(dir)), { code: 'ENOENT' });   // la carga no escribe
});

test('primary ilegible (JSON roto) con backup válido: restaura íntegro y pone en cuarentena el corrupto', async t => {
  const dir = await ownDir(t);
  const raw = `{\n  "events": [ ${CANARY}\n`;
  await fsp.writeFile(primaryOf(dir), raw, { mode: 0o640 });
  await writeJson(backupOf(dir), fullDomain());
  const seen = [];
  const io = { readFile: (f, ...a) => { seen.push(f); return fsp.readFile(f, ...a); } };   // parcial: rename/readdir se fusionan
  const reports = [];
  const s = await new Session(dir, { io, report: m => reports.push(m) }).load();

  assert.deepEqual(s.data, fullDomain());                  // dominio completo restaurado
  const st = s.recoveryState();
  assert.equal(st.source, 'backup');
  assert.equal(st.preservedFiles, 1);
  assert.ok(typeof st.message === 'string' && st.message.trim().length > 0);
  assert.doesNotMatch(st.message, /CANARY|session-current|\.json|\/tmp/);
  assert.equal(reports.length, 1);
  assert.equal(reports[0], st.message);                    // warning constante y acotado
  assert.equal(seen.includes(backupOf(dir)), true);

  await assert.rejects(fsp.readFile(primaryOf(dir)), { code: 'ENOENT' });   // el primary se movió
  const quarantined = await entriesCorrupt(dir);
  assert.equal(quarantined.length, 1);
  const q = path.join(dir, quarantined[0]);
  assert.equal(await fsp.readFile(q, 'utf8'), raw);        // bytes íntegros
  if (process.platform === 'linux') assert.equal((await fsp.stat(q)).mode & 0o777, 0o640);
  assert.deepEqual(await readJson(backupOf(dir)), fullDomain());

  // segundo arranque: primary ausente + backup válido restaura otra vez y NO crea el primary
  const s2 = await new Session(dir).load();
  assert.deepEqual(s2.data, fullDomain());
  assert.equal(s2.recoveryState().source, 'backup');
  assert.equal(s2.recoveryState().preservedFiles, 0);
  await assert.rejects(fsp.readFile(primaryOf(dir)), { code: 'ENOENT' });
});

test('primary ausente con backup válido: restaura sin crear el primary', async t => {
  const dir = await ownDir(t);
  await writeJson(backupOf(dir), fullDomain());
  const s = await new Session(dir).load();
  assert.deepEqual(s.data, fullDomain());
  assert.equal(s.recoveryState().source, 'backup');
  assert.equal(s.recoveryState().preservedFiles, 0);
  assert.doesNotMatch(s.recoveryState().message, /dañad|conservad/);   // el primary solo faltaba: no se afirma daño ni conservación
  await assert.rejects(fsp.readFile(primaryOf(dir)), { code: 'ENOENT' });   // no se escribe el primary
});

test('primary con forma inválida y backup válido: cuarentena íntegra por cada forma', async t => {
  const domain = fullDomain();
  const shapes = {
    'raíz null': 'null',
    'raíz array': '[]',
    'raíz primitiva': '"texto"',
    'events null': JSON.stringify({ ...domain, events: null }),          // no-array es inválido entero
    'events con registro null': JSON.stringify({ ...domain, events: [null] }),
    'id inseguro': JSON.stringify({ ...domain, id: 'a b/c' }),
  };
  for (const [name, raw] of Object.entries(shapes)) {
    await t.test(name, async st => {
      const dir = await ownDir(st);
      await fsp.writeFile(primaryOf(dir), raw);
      await writeJson(backupOf(dir), domain);
      const s = await new Session(dir).load();
      assert.deepEqual(s.data, domain);
      assert.equal(s.recoveryState().source, 'backup');
      assert.equal(s.recoveryState().preservedFiles, 1);
      const q = await entriesCorrupt(dir);
      assert.equal(q.length, 1);
      assert.equal(await fsp.readFile(path.join(dir, q[0]), 'utf8'), raw);   // sin filtrado ni recorte
    });
  }
});

test('sin copia válida: bloqueo seguro, originales intactos y reinicio que sigue bloqueado', async t => {
  const dir = await ownDir(t);
  const rawP = `{ "events": [ ${CANARY}`;
  const rawB = `{ backup roto ${SEED}`;
  await fsp.writeFile(primaryOf(dir), rawP);
  await fsp.writeFile(backupOf(dir), rawB);
  const { io } = spyIO();
  const reports = [];
  const s = new Session(dir, { io, report: m => reports.push(m) });
  const err = await s.load().then(() => null, e => e);
  assertSafeBlock(err);
  const st = s.recoveryState();
  assert.equal(st.source, 'blocked');
  assert.equal(st.preservedFiles, 2);
  assert.ok(typeof st.message === 'string' && st.message.length > 0);
  assert.equal(reports.length, 1);
  assert.equal(reports[0], st.message);
  assert.equal(s.data.events.length, 0);                   // el rechazo no devuelve un dominio parcial

  // los originales siguen IN PLACE con sus bytes exactos; no hay cuarentena ni borrado
  assert.equal(await fsp.readFile(primaryOf(dir), 'utf8'), rawP);
  assert.equal(await fsp.readFile(backupOf(dir), 'utf8'), rawB);
  assert.deepEqual(await entriesCorrupt(dir), []);

  // reinicio: sigue bloqueado con el MISMO mensaje constante, nunca un fresco accidental
  const s2 = new Session(dir, { io });
  const err2 = await s2.load().then(() => null, e => e);
  assertSafeBlock(err2);
  assert.equal(err2.message, err.message);
  assert.equal(await fsp.readFile(primaryOf(dir), 'utf8'), rawP);
});

test('primary corrupto sin backup: bloqueo con el original en su sitio', async t => {
  const dir = await ownDir(t);
  const raw = `{ "notes": [ ${SEED}`;
  await fsp.writeFile(primaryOf(dir), raw);
  const s = new Session(dir, { io: spyIO().io });
  const err = await s.load().then(() => null, e => e);
  assertSafeBlock(err);
  const st = s.recoveryState();
  assert.equal(st.source, 'blocked');
  assert.equal(st.preservedFiles, 1);
  assert.equal(await fsp.readFile(primaryOf(dir), 'utf8'), raw);
});

test('solo una cuarentena previa: bloqueo en vez de arranque fresco', async t => {
  const dir = await ownDir(t);
  const raw = `{ roto ${CANARY}`;
  await fsp.writeFile(path.join(dir, 'session-current.corrupt-abc123.json'), raw);
  const s = new Session(dir, { io: spyIO().io });
  const err = await s.load().then(() => null, e => e);
  assertSafeBlock(err);
  const st = s.recoveryState();
  assert.equal(st.source, 'blocked');                      // hay historial corrupto conocido en la carpeta
  assert.ok(st.preservedFiles >= 1 && st.preservedFiles <= 2);
  assert.equal(await fsp.readFile(path.join(dir, 'session-current.corrupt-abc123.json'), 'utf8'), raw);
});

test('EACCES al leer el primary: bloqueo sin leer ni tocar el backup', async t => {
  const dir = await ownDir(t);
  const rawP = 'EACCES-CURRENT';
  await fsp.writeFile(primaryOf(dir), rawP);
  await writeJson(backupOf(dir), fullDomain());
  const seen = [];
  const io = { readFile: (f, ...a) => { seen.push(f); return f === primaryOf(dir) ? Promise.reject(errno('EACCES', `EACCES ${CANARY} ${f}`)) : fsp.readFile(f, ...a); } };
  const s = new Session(dir, { io });
  const err = await s.load().then(() => null, e => e);
  assertSafeBlock(err);
  assert.doesNotMatch(err.message, /hay datos dañados|no existe una copia válida/);   // EACCES no prueba que la copia sea mala
  assert.equal(s.recoveryState().source, 'blocked');
  assert.equal(seen.includes(backupOf(dir)), false);       // un permiso NO cae al backup
  assert.equal(await fsp.readFile(primaryOf(dir), 'utf8'), rawP);   // no se renombra ni se borra
  assert.deepEqual(await readJson(backupOf(dir)), fullDomain());
  assert.deepEqual(await entriesCorrupt(dir), []);
});

test('fallo al renombrar la cuarentena: bloqueo con el corrupto en su sitio', async t => {
  const dir = await ownDir(t);
  const rawP = `{ corrupto ${CANARY}`;
  await fsp.writeFile(primaryOf(dir), rawP);
  await writeJson(backupOf(dir), fullDomain());
  const io = { readFile: (f, ...a) => fsp.readFile(f, ...a), rename: () => Promise.reject(errno('CANARY_FAULT', `rename ${CANARY}`)) };
  const s = new Session(dir, { io });
  const err = await s.load().then(() => null, e => e);
  assertSafeBlock(err);
  assert.equal(s.recoveryState().source, 'blocked');
  assert.equal(await fsp.readFile(primaryOf(dir), 'utf8'), rawP);   // el corrupto sigue IN PLACE
  assert.deepEqual(await entriesCorrupt(dir), []);
  assert.deepEqual(await readJson(backupOf(dir)), fullDomain());
});

test('fallo de readdir con ambos ficheros ausentes: bloqueo, no arranque fresco', async t => {
  const dir = await ownDir(t);
  const io = { readFile: (f, ...a) => fsp.readFile(f, ...a), readdir: () => Promise.reject(errno('EIO', `EIO ${CANARY}`)) };
  const s = new Session(dir, { io });
  const err = await s.load().then(() => null, e => e);
  assertSafeBlock(err);
  assert.equal(s.recoveryState().source, 'blocked');
});

test('un report que lanza no altera la restauración ni el bloqueo', async t => {
  const boom = () => { throw new Error(`report roto ${CANARY}`); };
  const restore = await ownDir(t);
  await fsp.writeFile(primaryOf(restore), `{ roto ${CANARY}`);
  await writeJson(backupOf(restore), fullDomain());
  const s1 = await new Session(restore, { report: boom }).load();
  assert.deepEqual(s1.data, fullDomain());                 // la restauración no se rompe por el report
  assert.equal(s1.recoveryState().source, 'backup');

  const blocked = await ownDir(t);
  await fsp.writeFile(primaryOf(blocked), `{ roto ${CANARY}`);
  const s2 = new Session(blocked, { report: boom });
  const err = await s2.load().then(() => null, e => e);
  assertSafeBlock(err);
  assert.equal(s2.recoveryState().source, 'blocked');
});
