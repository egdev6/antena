// ODD-06b.1 · Contrato del backup de Session (tests primero).
// El Session actual escribe SOLO el primary: no tiene `backupFile`, no escribe la
// segunda copia y no rechaza el productor cuando el backup falla. Estos casos
// describen el seam que implementará el PADRE y fallan contra el fuente actual
// (RED real: la copia de respaldo aún no existe). La recuperación automática
// (b2) y el archivo concurrente (b3) quedan fuera de esta unidad.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { createJsonWriter, writeJson } from '../src/json-file.mjs';

// Directorio propio por caso: cada test limpia solo lo que creó.
async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-session-backup-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
// El reloj falso de node:test no controla setImmediate; se cede el turno real unas
// cuantas veces para drenar micro/macrotareas ya disparadas. No son sleeps.
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
// Resolver inicializado de forma ansiosa: permite retener la cola sin carrera.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// Ruta esperada calculada desde el fixture, no desde el Session (que aún no expone
// `backupFile`); así el RED es un ENOENT significativo de la copia, no un TypeError.
const backupPathOf = dir => path.join(dir, 'session-current.backup.json');
// IO real que falla el rename SOLO cuando el destino es `targetName`; el primer
// fallo se agota, de modo que el reintento válido posterior renombra con normalidad.
function faultRenameTo(targetName, arm) {
  const opened = [];
  return {
    opened,
    mkdir: (p, o) => fsp.mkdir(p, o),
    open: (f, flags, mode) => { opened.push(path.basename(f)); return fsp.open(f, flags, mode); },
    rename: (a, b) => {
      if (arm.on && !arm.failed && path.basename(b) === targetName) {
        arm.failed = true;
        const err = new Error(`rename falló CANARY-SESSION-SECRET en ${a} -> ${b}`);
        err.code = 'CANARY_FAULT';
        return Promise.reject(err);
      }
      return fsp.rename(a, b);
    },
    unlink: p => fsp.unlink(p),
  };
}
const alert = (id, user, type = 'follow', vars = {}) => ({ id, type, at: new Date().toISOString(), vars: { user, ...vars }, text: user, sub: '' });
const seed = events => ({ ...Session.fresh(), events });
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));

test('flush escribe backup y primary idénticos, completos y en modo 600 (Linux)', async t => {
  const dir = await ownDir(t);
  const backupFile = backupPathOf(dir);
  const s = new Session(dir);                    // writer real por defecto
  await assert.rejects(fsp.readFile(backupFile), err => err.code === 'ENOENT');   // RED: aún no hay copia

  s.record(alert('a', 'ana', 'cheer', { amount: 300 }));
  s.addNote({ kind: 'winner', user: 'bea', label: 'premio' });
  s.setThanked('a', true);
  s.addToGoal('bits', 10);
  await s.flush();

  const primary = await readJson(s.file);
  const backup = await readJson(backupFile);
  assert.deepEqual(backup, primary);             // copia íntegra e idéntica
  assert.equal(primary.events.length, 1);        // dominio pagado preservado
  assert.equal(primary.events[0].vars.amount, 300);
  assert.equal(primary.events[0].thanked, true); // agradecimientos
  assert.equal(primary.notes[0].kind, 'winner'); // notas
  assert.equal(primary.goalOffsets.bits, 10);    // goalOffsets
  if (process.platform === 'linux') {
    assert.equal((await fsp.stat(s.file)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(backupFile)).mode & 0o777, 0o600);
  }
});

test('la instantánea se toma antes de esperar la cola: mutar data después no cambia las copias', async t => {
  const dir = await ownDir(t);
  const gate = deferred();
  const s = new Session(dir);
  s.chain = gate.promise;                        // retención ansiosa de la cola previa
  s.data.events.push({ ...alert('a', 'ana'), thanked: true });
  const p = s.flush().catch(err => err);         // instantánea síncrona al aceptar la llamada
  s.data.events.push({ ...alert('b', 'bea') });  // mutación posterior SIN save()
  gate.resolve();
  await p;
  await settle();                                // drena el IO en vuelo; sin flush de limpieza

  const primary = await readJson(s.file);
  const backup = await readJson(backupPathOf(dir));
  assert.deepEqual(primary.events.map(e => e.id), ['a']);
  assert.deepEqual(backup.events.map(e => e.id), ['a']);   // RED: backup ausente
  assert.equal(backup.events[0].thanked, true);
});

test('fallo del rename del backup rechaza sin IO del primary y conserva ambas copias previas', async t => {
  const dir = await ownDir(t);
  const primaryFile = path.join(dir, 'session-current.json');
  const backupFile = backupPathOf(dir);
  await writeJson(primaryFile, seed([alert('old', 'old')]));   // semilla con el helper real
  await writeJson(backupFile, seed([alert('old', 'old')]));

  const arm = { on: true, failed: false };
  const io = faultRenameTo('session-current.backup.json', arm);
  const writer = createJsonWriter(io);
  const reports = [];
  const s = new Session(dir, { writer, report: m => reports.push(m) });

  s.record(alert('a', 'ana'));
  await assert.rejects(s.flush(), err => {
    assert.equal(err.status, 500);
    assert.equal(err.code, 'SESSION_PERSISTENCE_FAILED');
    assert.doesNotMatch(err.message, /CANARY-SESSION-SECRET|session-current|\.tmp|rename/);
    assert.ok(err.cause && /CANARY-SESSION-SECRET/.test(err.cause.message));
    return true;
  });
  assert.equal(reports.length, 1);
  assert.ok(s.lastSaveError);
  assert.equal(io.opened.filter(n => n.startsWith('.session-current.json.')).length, 0);   // gate: sin IO del primary
  assert.equal((await readJson(primaryFile)).events[0].id, 'old');   // copias previas intactas
  assert.equal((await readJson(backupFile)).events[0].id, 'old');

  arm.on = false;                                // reparación: reintento válido escribe ambas
  await s.flush();
  assert.equal(s.lastSaveError, null);
  assert.equal(reports.length, 1);               // reporta una sola vez
  assert.ok((await readJson(primaryFile)).events.some(e => e.id === 'a'));
  assert.ok((await readJson(backupFile)).events.some(e => e.id === 'a'));
});

test('fallo del rename del primary rechaza dejando el backup nuevo y el primary anterior válido', async t => {
  const dir = await ownDir(t);
  const primaryFile = path.join(dir, 'session-current.json');
  const backupFile = backupPathOf(dir);
  await writeJson(primaryFile, seed([alert('old', 'old')]));
  await writeJson(backupFile, seed([alert('old', 'old')]));

  const arm = { on: true, failed: false };
  const writer = createJsonWriter(faultRenameTo('session-current.json', arm));
  const s = new Session(dir, { writer });
  s.record(alert('a', 'ana'));
  await assert.rejects(s.flush(), err => err.code === 'SESSION_PERSISTENCE_FAILED');

  // El backup se escribió ANTES del fallo del primary: queda con el estado nuevo.
  assert.deepEqual((await readJson(backupFile)).events.map(e => e.id), ['a']);   // RED: sigue 'old'
  // El primary previo sobrevive al rename atómico: no hay rollback de las dos copias.
  assert.deepEqual((await readJson(primaryFile)).events.map(e => e.id), ['old']);
});
