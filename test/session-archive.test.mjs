// ODD-06b.3 · Archivo concurrente de Session (tests primero).
// El Session actual escribe el archivo con `writeFile` directo (ignora el writer
// inyectado), no expone `archiveState()`/`getPending()`, colisiona los ids en el
// mismo milisegundo y sobrescribe un archivo preexistente. Estos casos describen el
// contrato que implementará el PADRE y fallan contra el fuente actual (RED real).
// Unidad tests-only: no se toca src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Session } from '../src/session.mjs';
import { createJsonWriter, writeJson } from '../src/json-file.mjs';
import { useVirtualClock } from './helpers/clock.mjs';

// Directorio propio por caso: cada test limpia solo lo que creó.
async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-session-archive-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
// El reloj falso de node:test no controla setImmediate; se cede el turno real unas
// cuantas veces para drenar micro/macrotareas ya disparadas. No son sleeps.
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const readJson = async f => JSON.parse(await fsp.readFile(f, 'utf8'));
const primaryOf = dir => path.join(dir, 'session-current.json');
const backupOf = dir => path.join(dir, 'session-current.backup.json');
const archiveOf = (dir, id) => path.join(dir, 'sessions', id + '.json');
const SAFE_ID = /^[\w-]+$/;
const LEGACY_ID = '2026-01-02T03-04-05-006Z';

// Dominio "pagado" completo: importes, agradecimientos, notas, goalOffsets con
// métrica desconocida + null y campos extra en raíz/evento/nota. El archivo debe
// conservarlo íntegro, sin normalizar ni filtrar.
function fullOldDomain() {
  return {
    ...Session.fresh('directo viejo'),
    id: LEGACY_ID,
    startedAt: new Date(1_700_000_000_000).toISOString(),
    events: [
      { id: 'ev:1', type: 'cheer', at: new Date(1_700_000_001_000).toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '', thanked: true, extra: 'keep-event' },
      { id: 'ev:2', type: 'follow', at: new Date(1_700_000_002_000).toISOString(), vars: { user: 'bea' }, text: 'bea', sub: '' },
    ],
    notes: [{ id: 'note:1', kind: 'winner', user: 'bea', label: 'premio', extra: 'keep-note' }],
    goalOffsets: { bits: 10, 'metrica-desconocida': 7, otros: null },
    customRoot: 'keep-root',
  };
}
// Writer real envuelto: registra la instantánea síncrona al aceptar la llamada (como
// la utilidad compartida) y entra la cola atómica REAL de inmediato. La puerta corre
// DENTRO del job ya encolado (`after`), de modo que el FIFO por ruta no se esconde y
// un job retenido bloquea de verdad al siguiente. `gate`/`fault` aceptan
// `match(file, snap)` o un `name` de basename.
function harness({ gate = null, fault = null } = {}) {
  const base = createJsonWriter();
  const calls = [];
  const hit = (spec, file, snap) => (spec.matches ? spec.matches(file, snap) : path.basename(file) === spec.name);
  const writer = (file, data, opts = {}) => {
    const snap = JSON.parse(JSON.stringify(data));
    calls.push({ file, data: snap });
    const after = Promise.resolve(opts.after).then(() => {
      if (gate && hit(gate, file, snap)) { gate.entered.resolve(); return gate.promise; }
      if (fault && hit(fault, file, snap) && fault.armed) throw fault.error();
    });
    return base(file, snap, { after });   // enqueue síncrono: sin await previo al job
  };
  writer.calls = calls;
  return writer;
}
const alert = (id, user, type = 'follow', vars = {}) => ({ id, type, at: new Date().toISOString(), vars: { user, ...vars }, text: user, sub: '' });
// Session con debounce/maxWait largos: ningún auto-flush interfiere con las puertas.
const quietSession = async (dir, opts = {}) => new Session(dir, { debounceMs: 60000, maxWaitMs: 60000, ...opts }).load();

test('Session.fresh con el mismo reloj produce ids distintos con UUID y formato seguro', t => {
  const clock = useVirtualClock(t, 1_700_000_000_000);
  if (!clock) return;
  const a = Session.fresh();
  const b = Session.fresh();
  assert.match(a.id, SAFE_ID);
  assert.match(b.id, SAFE_ID);
  assert.notEqual(a.id, b.id);   // RED: el fuente actual colisiona en el mismo ms
  assert.match(a.id, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test('un id legacy se carga y sigue recuperable por get/list', async t => {
  const dir = await ownDir(t);
  await writeJson(primaryOf(dir), fullOldDomain());
  await writeJson(backupOf(dir), fullOldDomain());
  const s = await new Session(dir).load();
  assert.equal(s.data.id, LEGACY_ID);
  assert.equal(s.data.events.length, 2);
  const got = await s.get(LEGACY_ID);
  assert.equal(got.id, LEGACY_ID);
  assert.equal(got.events[0].vars.amount, 300);
});

test('startNew archiva el directo anterior completo por el writer compartido y deja el nuevo actual', async t => {
  const dir = await ownDir(t);
  const domain = fullOldDomain();
  await writeJson(primaryOf(dir), domain);
  await writeJson(backupOf(dir), domain);
  const writer = harness();
  const s = await new Session(dir, { writer }).load();

  const next = await s.startNew('Next');
  assert.notEqual(next.id, LEGACY_ID);
  assert.match(next.id, SAFE_ID);
  assert.equal(s.data.id, next.id);
  assert.equal(s.data.events.length, 0);
  assert.equal(s.data.title, 'Next');

  const arc = archiveOf(dir, LEGACY_ID);
  const archived = await readJson(arc);
  assert.equal(archived.id, LEGACY_ID);
  assert.equal(typeof archived.endedAt, 'string');
  assert.equal(archived.events.length, 2);
  assert.equal(archived.notes[0].extra, 'keep-note');
  assert.deepEqual(archived.goalOffsets, domain.goalOffsets);
  assert.equal(archived.customRoot, 'keep-root');
  assert.ok(writer.calls.some(c => c.file === arc), 'el archivo debe enrutarse por el writer compartido');
  if (process.platform === 'linux') assert.equal((await fsp.stat(arc)).mode & 0o777, 0o600);

  const past = await s.list();
  const row = past.find(r => r.id === LEGACY_ID);
  assert.ok(row, 'list() debe incluir el directo archivado');
  assert.ok(!row.pending);
  assert.equal(row.events, 2);
  const got = await s.get(LEGACY_ID);
  assert.equal(got.id, LEGACY_ID);
  assert.equal(got.events.length, 2);
  const current = await readJson(primaryOf(dir));
  assert.equal(current.id, next.id);
  assert.equal(current.events.length, 0);
});

test('archiveState y getPending arrancan limpios y devuelven copia defensiva', async t => {
  const dir = await ownDir(t);
  const writer = harness();
  const s = await quietSession(dir, { writer });
  t.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });
  assert.deepEqual(s.archiveState(), { pendingCount: 0, sessionId: null, error: null });
  assert.equal(s.getPending() ?? null, null);
});

test('mientras el archivo está retenido el directo anterior se conserva y lo nuevo va al directo nuevo', async t => {
  const dir = await ownDir(t);
  const domain = fullOldDomain();
  await writeJson(primaryOf(dir), domain);
  await writeJson(backupOf(dir), domain);
  const release = deferred();
  const gate = { name: LEGACY_ID + '.json', entered: deferred(), promise: release.promise };
  const writer = harness({ gate });
  const s = await quietSession(dir, { writer });
  t.after(() => { release.resolve(); clearTimeout(s.saveT); clearTimeout(s.maxT); });
  await s.flush();                                   // checkpoint OLD en disco

  const pending = s.startNew('Next').then(r => ({ ok: true, r }), e => ({ ok: false, e }));
  const first = await Promise.race([gate.entered.promise.then(() => ({ entered: true })), pending]);
  assert.equal(first.entered, true, 'el archivo OLD debe enrutarse por el writer compartido');   // RED

  assert.notEqual(s.data.id, LEGACY_ID);             // cutover en memoria ya ocurrió
  s.record(alert('new1', 'neo', 'cheer', { amount: 50 }));
  s.addNote({ kind: 'marker', label: 'nuevo' });
  s.addToGoal('bits', 5);
  s.data.title = 'Next directo';                     // mutación directa (compat 06a)

  const pend = s.getPending();
  assert.ok(pend, 'getPending debe exponer el directo anterior retenido');
  assert.equal(pend.id, LEGACY_ID);
  assert.equal(typeof pend.endedAt, 'string');
  assert.equal(pend.events.length, 2);
  assert.equal(pend.notes[0].extra, 'keep-note');
  assert.equal(s.archiveState().pendingCount, 1);
  assert.equal(s.archiveState().sessionId, LEGACY_ID);
  pend.events.push({ id: 'mut' });                   // copia defensiva: mutar no toca el interno
  pend.id = 'mut';
  assert.equal(s.getPending().events.length, 2);
  assert.equal(s.getPending().id, LEGACY_ID);
  const gs = s.archiveState(); gs.pendingCount = 9; gs.sessionId = 'mut';
  assert.equal(s.archiveState().pendingCount, 1);    // copia defensiva del estado
  assert.equal(s.archiveState().sessionId, LEGACY_ID);
  const past = await s.list();
  assert.ok(past.some(r => r.id === LEGACY_ID && r.pending === true), 'list() marca el pendiente');
  assert.equal((await readJson(primaryOf(dir))).id, LEGACY_ID);   // sin IO del nuevo todavía

  release.resolve();
  const done = await pending;
  assert.equal(done.ok, true);
  assert.equal(done.r.id, s.data.id);
  await s.flush();
  const archived = await readJson(archiveOf(dir, LEGACY_ID));
  assert.equal(archived.id, LEGACY_ID);
  assert.equal(archived.events.length, 2);
  assert.equal(archived.customRoot, 'keep-root');
  assert.deepEqual(s.archiveState(), { pendingCount: 0, sessionId: null, error: null });
  const cur = await readJson(primaryOf(dir));
  assert.equal(cur.id, s.data.id);
  assert.equal(cur.events.length, 1);
});

test('si el archivo falla: error 500 seguro, OLD visible y NEW aceptado sin escribir el nuevo', async t => {
  const dir = await ownDir(t);
  const domain = fullOldDomain();
  await writeJson(primaryOf(dir), domain);
  await writeJson(backupOf(dir), domain);
  const fault = { name: LEGACY_ID + '.json', armed: true, error: () => Object.assign(new Error(`archivo CANARY-ARCHIVE-SECRET ${primaryOf(dir)}`), { code: 'CANARY_FAULT' }) };
  const writer = harness({ fault });
  const s = await quietSession(dir, { writer });
  t.after(() => { fault.armed = false; clearTimeout(s.saveT); clearTimeout(s.maxT); });
  await s.flush();

  await assert.rejects(s.startNew('Next'), err => {
    assert.equal(err.status, 500);
    assert.equal(err.code, 'SESSION_PERSISTENCE_FAILED');
    assert.doesNotMatch(err.message, /CANARY-ARCHIVE-SECRET|session-current|\.json|\/tmp|CANARY_FAULT/);
    return true;
  });

  const pend = s.getPending();
  assert.equal(pend.id, LEGACY_ID);
  assert.equal(pend.events.length, 2);               // dominio intacto
  const st = s.archiveState();
  assert.equal(st.pendingCount, 1);
  assert.equal(st.sessionId, LEGACY_ID);
  assert.ok(st.error === null || typeof st.error === 'string');
  assert.doesNotMatch(JSON.stringify(st), /CANARY-ARCHIVE-SECRET|\/tmp|\.json/);
  st.sessionId = 'mut';                              // copia defensiva
  assert.equal(s.archiveState().sessionId, LEGACY_ID);

  s.record(alert('n1', 'neo'));                      // el nuevo sigue aceptado en memoria
  assert.equal(s.data.events.length, 1);
  await assert.rejects(s.flush(), err => err.code === 'SESSION_PERSISTENCE_FAILED');   // no escribe el nuevo
  assert.equal((await readJson(primaryOf(dir))).id, LEGACY_ID);

  fault.armed = false;                               // reparación: reintento archiva OLD y persiste NEW
  await s.flush();
  const archived = await readJson(archiveOf(dir, LEGACY_ID));
  assert.equal(archived.events.length, 2);
  assert.equal(typeof archived.endedAt, 'string');
  assert.equal(archived.notes[0].kind, 'winner');
  const cur = await readJson(primaryOf(dir));
  assert.equal(cur.id, s.data.id);
  assert.equal(cur.events.length, 1);
  assert.deepEqual(s.archiveState(), { pendingCount: 0, sessionId: null, error: null });
});

test('un archivo legacy preexistente nunca se sobrescribe y el directo actual no se modifica', async t => {
  const dir = await ownDir(t);
  const domain = fullOldDomain();
  await writeJson(primaryOf(dir), domain);
  await writeJson(backupOf(dir), domain);
  const sentinel = `{"sentinel":true,"id":"${LEGACY_ID}","bytes":"CANARY-LEGACY-BYTES"}`;
  const arc = archiveOf(dir, LEGACY_ID);
  await fsp.mkdir(path.dirname(arc), { recursive: true });
  await fsp.writeFile(arc, sentinel);
  const writer = harness();
  const s = await quietSession(dir, { writer });
  t.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });

  await assert.rejects(s.startNew('Next'), err => {
    assert.equal(err.code, 'SESSION_PERSISTENCE_FAILED');
    assert.equal(err.status, 500);
    return true;
  });
  assert.equal(await fsp.readFile(arc, 'utf8'), sentinel);   // bytes íntegros, sin sobrescritura
  assert.equal(s.data.id, LEGACY_ID);                        // sin cutover
  assert.equal(s.data.endedAt, undefined);                   // sin endedAt añadido
  assert.equal((await readJson(primaryOf(dir))).id, LEGACY_ID);
});

test('fallo NEW seguido de reinicio reutiliza sólo el archivo OLD idéntico sin reescribirlo', async t => {
  for (const role of ['session-current.backup.json', 'session-current.json']) {
    await t.test(role, async st => {
      const dir = await ownDir(st);
      const domain = fullOldDomain();
      await writeJson(primaryOf(dir), domain);
      await writeJson(backupOf(dir), domain);
      const fault = {
        armed: true, error: () => new Error('NEW checkpoint failure'),
        matches: (file, snap) => path.basename(file) === role && snap.id !== LEGACY_ID,
      };
      const s = await quietSession(dir, { writer: harness({ fault }) });
      st.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });
      await assert.rejects(s.startNew('Failed'), { code: 'SESSION_PERSISTENCE_FAILED' });
      const arc = archiveOf(dir, LEGACY_ID);
      const bytes = await fsp.readFile(arc, 'utf8');
      const mode = (await fsp.stat(arc)).mode;
      const old = JSON.parse(bytes);
      const retryFault = {
        armed: true, error: () => new Error('Retry checkpoint failure'),
        matches: (file, snap) => path.basename(file) === 'session-current.backup.json' && snap.id !== LEGACY_ID,
      };
      const retryWriter = harness({ fault: retryFault });
      const retry = await quietSession(dir, { writer: retryWriter });
      st.after(() => { clearTimeout(retry.saveT); clearTimeout(retry.maxT); });
      assert.deepEqual(retry.data, old, 'el primary válido sigue siendo OLD');
      await assert.rejects(retry.startNew('Retry'), { code: 'SESSION_PERSISTENCE_FAILED' });
      assert.equal(retryWriter.calls.some(c => c.file === arc), false, 'no rearchivar OLD');
      const writer = harness();
      const restarted = await quietSession(dir, { writer });
      st.after(() => { clearTimeout(restarted.saveT); clearTimeout(restarted.maxT); });
      const next = await restarted.startNew('Recovered');
      assert.notEqual(next.id, LEGACY_ID);
      assert.equal(next.title, 'Recovered');
      assert.equal(writer.calls.some(c => c.file === arc), false);
      assert.equal(await fsp.readFile(arc, 'utf8'), bytes, 'bytes y endedAt originales intactos');
      assert.equal((await fsp.stat(arc)).mode, mode);
      assert.deepEqual(await readJson(primaryOf(dir)), next);
      assert.deepEqual(await readJson(backupOf(dir)), next);
      assert.deepEqual(restarted.archiveState(), { pendingCount: 0, sessionId: null, error: null });
      const reloaded = await quietSession(dir);
      assert.equal(reloaded.data.id, next.id);
      assert.deepEqual(await reloaded.get(LEGACY_ID), old);
    });
  }
});

test('la reconciliación rechaza archivos distintos, inválidos o sin cierre confirmado', async t => {
  for (const variant of ['distinto', 'corrupto', 'sin endedAt', 'endedAt inválido']) {
    await t.test(variant, async st => {
      const dir = await ownDir(st);
      const domain = { ...fullOldDomain(), endedAt: '2026-01-02T04:00:00.000Z' };
      if (variant === 'sin endedAt') delete domain.endedAt;
      if (variant === 'endedAt inválido') domain.endedAt = 'invalid';
      await writeJson(primaryOf(dir), domain);
      await writeJson(backupOf(dir), domain);
      const arc = archiveOf(dir, LEGACY_ID);
      await fsp.mkdir(path.dirname(arc), { recursive: true });
      const bytes = variant === 'corrupto' ? '{ CANARY' : JSON.stringify({
        ...domain, ...(variant === 'distinto' ? { customRoot: 'unrelated archive' } : {}),
      });
      await fsp.writeFile(arc, bytes);
      const writer = harness();
      const s = await quietSession(dir, { writer });
      const before = structuredClone(s.data);
      await assert.rejects(s.startNew('Blocked'), { code: 'SESSION_PERSISTENCE_FAILED', status: 500 });
      assert.deepEqual(s.data, before, 'sin cutover ni pérdida de eventos aceptados');
      assert.equal(await fsp.readFile(arc, 'utf8'), bytes);
      assert.equal(writer.calls.some(c => c.file === arc), false);
    });
  }
});

test('dos startNew seguidos conservan los tres directos con ids distintos', async t => {
  const clock = useVirtualClock(t, 1_700_000_000_000);
  if (!clock) return;
  const dir = await ownDir(t);
  const writer = harness();
  const s = await quietSession(dir, { writer });
  t.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });
  s.record(alert('a', 'ana', 'cheer', { amount: 100 }));
  const p1 = s.startNew('Next1');
  s.record(alert('b', 'bea'));
  const p2 = s.startNew('Next2');
  s.record(alert('c', 'carol'));
  const results = await Promise.allSettled([p1, p2]);
  assert.ok(results.every(r => r.status === 'fulfilled'), JSON.stringify(results.map(r => r.status)));
  await settle();

  const files = await fsp.readdir(path.join(dir, 'sessions')).catch(() => []);
  const ids = new Set();
  for (const f of files) ids.add((await readJson(path.join(dir, 'sessions', f))).id);
  ids.add(s.data.id);
  assert.equal(ids.size, 3, 'los tres directos deben conservar ids distintos');
  assert.ok([...ids].every(id => SAFE_ID.test(id)));
});

// Grupo A · Un archivo OLD retenido no debe duplicar el checkpoint OLD ni adelantar
// el NEW: dos flush concurrentes comparten el MINTMO intento y su instantánea es la
// del momento de la llamada. Con el FIFO real, un enqueue OLD tardío o detrás del NEW
// produce deadlock o pérdida de lo ya guardado (el timeout es solo guarda).
test('archivo retenido + dos flush concurrentes: un solo intento OLD y snapshot del nuevo al llamar', { timeout: 8000 }, async t => {
  const dir = await ownDir(t);
  const domain = fullOldDomain();
  await writeJson(primaryOf(dir), domain);
  await writeJson(backupOf(dir), domain);
  const release = deferred();
  const gate = { name: LEGACY_ID + '.json', entered: deferred(), promise: release.promise };
  const writer = harness({ gate });
  const s = await quietSession(dir, { writer });
  t.after(() => { release.resolve(); clearTimeout(s.saveT); clearTimeout(s.maxT); });
  await s.flush();                                   // checkpoint OLD inicial (sin endedAt)

  const starting = s.startNew('Next').then(r => ({ ok: true, r }), e => ({ ok: false, e }));
  const first = await Promise.race([gate.entered.promise.then(() => ({ entered: true })), starting]);
  assert.equal(first.entered, true, 'el archivo OLD debe enrutarse por el writer compartido');   // RED

  const ev = s.record(alert('n1', 'neo'));           // aceptado en el directo nuevo
  s.setThanked(ev.id, true);
  s.setGoalValue('bits', 5);                          // objetivo absoluto, no un delta
  assert.equal(s.goalValue('bits'), 5);
  const flush1 = s.flush().catch(e => e);             // snapshot 1, al llamar
  s.data.title = 'después de flush1';                 // mutación directa posterior a la llamada
  s.record(alert('n2', 'paz'));                       // segundo estado aceptado
  const flush2 = s.flush().catch(e => e);             // snapshot 2, al llamar
  const newId = s.data.id;
  const arc = archiveOf(dir, LEGACY_ID);
  await settle();

  assert.equal(writer.calls.filter(c => c.file === arc).length, 1, 'un solo intento de archivo');
  const olds = writer.calls.filter(c => (c.file === s.file || c.file === backupOf(dir)) && c.data.id === LEGACY_ID && c.data.endedAt !== undefined);
  assert.equal(olds.filter(c => c.file === s.file).length, 1);         // checkpoint OLD una vez
  assert.equal(olds.filter(c => c.file === backupOf(dir)).length, 1);  // no se re-encola tras el NEW
  const newPrim = writer.calls.filter(c => c.file === s.file && c.data.id === newId);
  assert.equal(newPrim[0].data.events.length, 0, 'el auto-flush del nuevo se encola antes');
  assert.ok(newPrim.some(c => c.data.events.length === 1), 'flush1 capturó su estado al llamar');
  assert.equal(newPrim.at(-1).data.events.length, 2, 'flush2 captura el estado al llamar, no el final');

  release.resolve();
  await Promise.allSettled([flush1, flush2, starting]);
  await s.flush();
  const reloaded = await new Session(dir).load();
  assert.equal(reloaded.data.id, newId);
  assert.equal(reloaded.data.events.length, 2);
  assert.equal(reloaded.data.events.find(e => e.id === 'n1').thanked, true);
  assert.equal(reloaded.data.goalOffsets.bits, 5 - reloaded.data.events.reduce((n, e) => n + (e.type === 'cheer' ? Number(e.vars?.amount) || 0 : 0), 0));
  const archived = await readJson(arc);
  assert.equal(archived.id, LEGACY_ID);
  assert.equal(archived.events.length, 2);
  assert.deepEqual(archived.goalOffsets, domain.goalOffsets);
  assert.equal(archived.customRoot, 'keep-root');
});

// Grupo B · Matriz de fallos de checkpoint. Predicado por rol (backup/primary) y por
// payload: el checkpoint OLD pendiente lleva `id` legacy + `endedAt`; el checkpoint
// NEW lleva el id fresco. Cada rol verifica error seguro, estado retenido y reintento.
test('matriz de fallos de checkpoint OLD/NEW: error seguro, estado retenido y reintento sin pérdida', async t => {
  const phases = [
    { name: 'OLD backup', role: 'session-current.backup.json', old: true },
    { name: 'OLD primary', role: 'session-current.json', old: true },
    { name: 'NEW backup', role: 'session-current.backup.json', old: false },
    { name: 'NEW primary', role: 'session-current.json', old: false },
  ];
  for (const ph of phases) {
    await t.test(ph.name, async st => {
      const dir = await ownDir(st);
      const domain = fullOldDomain();
      await writeJson(primaryOf(dir), domain);
      await writeJson(backupOf(dir), domain);
      const fault = { armed: true, error: () => Object.assign(new Error(`fallo CANARY-MATRIX ${primaryOf(dir)}`), { code: 'CANARY_FAULT' }) };
      fault.matches = (file, snap) => path.basename(file) === ph.role
        && (ph.old ? (snap.id === LEGACY_ID && snap.endedAt !== undefined) : snap.id !== LEGACY_ID);
      const writer = harness({ fault });
      const reports = [];
      const s = await quietSession(dir, { writer, report: m => reports.push(m) });
      st.after(() => { fault.armed = false; clearTimeout(s.saveT); clearTimeout(s.maxT); });
      await s.flush();                               // checkpoint OLD inicial (sin endedAt)

      await assert.rejects(s.startNew('Next'), err => {
        assert.equal(err.status, 500);
        assert.equal(err.code, 'SESSION_PERSISTENCE_FAILED');
        assert.doesNotMatch(err.message, /CANARY-MATRIX|\/tmp|session-current|\.json|EACCES/);
        return true;
      });
      assert.equal(reports.length, 1);               // reporta una sola vez
      const arc = archiveOf(dir, LEGACY_ID);

      if (ph.old) {                                  // el corte ya ocurrió; OLD retenido y visible
        assert.notEqual(s.data.id, LEGACY_ID);
        const pend = s.getPending();
        assert.equal(pend.id, LEGACY_ID);
        assert.equal(pend.events.length, 2);
        assert.equal(typeof pend.endedAt, 'string');
        assert.equal(s.archiveState().pendingCount, 1);
        assert.equal(s.archiveState().sessionId, LEGACY_ID);
        assert.equal((await readJson(primaryOf(dir))).id, LEGACY_ID);   // canonical sigue OLD
        await assert.rejects(fsp.readFile(arc), { code: 'ENOENT' });    // el archivo no se alcanzó
      } else {                                       // el archivo ya existe completo; pending limpio
        assert.equal((await readJson(arc)).events.length, 2);
        assert.equal(s.getPending() ?? null, null);
        assert.equal(s.archiveState().pendingCount, 0);
      }

      const ev = s.record(alert('n1', 'neo'));
      s.setThanked(ev.id, true);
      s.addToGoal('bits', 7);
      fault.armed = false;                           // reparación
      await s.flush();
      if (ph.old) assert.equal((await readJson(arc)).events.length, 2);   // reintento archiva OLD
      const primary = await readJson(primaryOf(dir));
      const backup = await readJson(backupOf(dir));
      assert.deepEqual(primary, s.data);
      assert.deepEqual(backup, s.data);
      assert.equal(primary.events.find(e => e.id === 'n1').thanked, true);
      assert.equal(primary.goalOffsets.bits, 7);
      assert.equal(reports.length, 1);               // un éxito no vuelve a reportar
      const reloaded = await new Session(dir).load();
      assert.equal(reloaded.data.id, s.data.id);
      assert.equal(reloaded.data.events.length, 1);
    });
  }
});

// ODD-06b.3 · Regresión de la puerta OLD huérfana (tests-only, RED antes del fix).
// `_oldPipeline` devuelve `Promise.all([prior, raw])`; si el writer NEW lanza de forma
// síncrona antes de enganchar `after`, ese `oldGate` queda sin consumidor y Node lo
// reporta como rechazo no manejado (exit 1) pese a que el productor recibe el error
// tipado. El hijo lo prueba en aislamiento con un writer propio y errores falsos.
test('un fallo síncrono del writer NEW no deja huérfana la puerta OLD (sin rechazo no manejado)', { timeout: 10000 }, async t => {
  const dir = await ownDir(t);
  const sessionUrl = new URL('../src/session.mjs', import.meta.url).href;
  const jsonUrl = new URL('../src/json-file.mjs', import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import { Session } from ${JSON.stringify(sessionUrl)};
    import { writeJson } from ${JSON.stringify(jsonUrl)};
    const dir = process.argv[1];
    let oldId;
    const writer = (file, data, opts = {}) => {
      if (data.id !== oldId) throw new Error('CANARY_SYNC');               // fallo síncrono del writer NEW
      if (file.endsWith(oldId + '.json')) return Promise.reject(new Error('CANARY_OLD'));   // archivo OLD
      return writeJson(file, data, opts);                                   // backup/primary reales
    };
    const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000, writer }).load();
    oldId = s.data.id;
    s.data.events = [{ id: 'e1', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' }];
    await assert.rejects(s.startNew('Next'), err =>
      err.status === 500 && err.code === 'SESSION_PERSISTENCE_FAILED' && !/CANARY/.test(err.message));
    assert.equal(s.getPending().events.length, 1);                         // OLD retenido
    assert.notEqual(s.data.id, oldId);                                     // NEW actual
    console.log('SAFE_REJECTION');
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', program, dir], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);   // RED actual: exit 1 por el rechazo no manejado del oldGate
  assert.match(child.stdout, /SAFE_REJECTION/);
  assert.doesNotMatch(child.stderr, /CANARY_OLD/);
});

// ODD-06b.3 · Lector de archivo: un JSON archivado inválido debe fallar tipado y
// constante, sin eco del contenido. Hoy `get(id)` parsea directamente y propaga el
// SyntaxError crudo; el contrato exige un error público acotado y conservar los bytes.
test('get de un archivo archivado con JSON inválido falla tipado, constante y sin tocar los bytes', async t => {
  const dir = await ownDir(t);
  const target = archiveOf(dir, 'broken');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const bytes = '{ "CANARY_ARCHIVE":';
  await fsp.writeFile(target, bytes);
  const s = await quietSession(dir);
  await assert.rejects(s.get('broken'), { code: 'SESSION_ARCHIVE_READ_FAILED', status: 500, message: 'No se pudo leer el directo archivado.' });
  assert.equal(await fsp.readFile(target, 'utf8'), bytes);
});
