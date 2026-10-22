// ODD-06a · Contrato de persistencia de Session en dos unidades causales.
// Fase de tests primero: el Session actual ignora el `writer` inyectado, no tiene
// checkpoint `maxWait` y su `flush` escribe directo. Estos casos fallan contra el
// fuente actual (RED real) y describen el seam que implementará el PADRE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { createJsonWriter } from '../src/json-file.mjs';

// Directorio propio por caso: cada test limpia solo lo que creó.
async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-session-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
// El reloj falso de node:test no controla setImmediate; se cede el turno real unas
// cuantas veces para que terminen los awaits de IO ya disparados por un tick.
// No son sleeps: no espera tiempo, solo deja correr microtareas y macrotareas reales.
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
// IO real que falla el rename solo cuando el test lo arma; el primer fallo se agota,
// de modo que el reintento válido posterior renombra con normalidad.
function armedRenameIO(arm) {
  return {
    mkdir: (p, o) => fsp.mkdir(p, o),
    open: (f, flags, mode) => fsp.open(f, flags, mode),
    rename: (a, b) => {
      if (arm.on && !arm.failed) {
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
// Escritor espía con la API de la utilidad compartida: copia JSON al aceptar la
// llamada (no la referencia mutable), registra la puerta `after` y puede retener
// la primera escritura para observar el drenaje. ODD-06b.1: el flush pasa a escribir
// DOS ficheros (backup + primary); `calls` conserva la cobertura previa sobre el
// primary excluyendo SOLO el basename del backup, de modo que los contadores y la
// puerta del primer primary siguen midiendo lo mismo. Ambos peticiones siguen
// tomando la instantánea JSON ahora y esperando `opts.after`; el backup nunca
// espera la puerta del primer primary (evita el círculo backup->primary->backup).
function spyWriter({ blockFirst } = {}) {
  const calls = [];
  const writer = (file, data, opts = {}) => {
    const snap = JSON.parse(JSON.stringify(data));
    const isBackup = path.basename(file) === 'session-current.backup.json';
    const n = isBackup ? 0 : calls.push({ file, data: snap, after: opts.after });
    return (async () => {
      if (opts.after) await opts.after;
      if (blockFirst && n === 1) { blockFirst.started.resolve(); await blockFirst.gate.promise; }
    })();
  };
  writer.calls = calls;
  return writer;
}
const alert = (id, user, type = 'follow', vars = {}) => ({ id, type, at: new Date().toISOString(), vars: { user, ...vars }, text: user, sub: '' });

test('save() enruta al escritor inyectado tras el debounce', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const writer = spyWriter();
  const s = new Session(dir, { writer });
  t.after(() => clearTimeout(s.saveT));

  s.record(alert('a', 'ana'));
  assert.equal(writer.calls.length, 0);          // todavía dentro del debounce
  t.mock.timers.tick(299);
  await settle();
  assert.equal(writer.calls.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].file, s.file);
  assert.deepEqual(writer.calls[0].data.events.map(e => e.type), ['follow']);
  assert.ok('after' in writer.calls[0]);         // puerta de contabilidad por escritura
});

test('los guardados continuos fuerzan el checkpoint por maxWait con el payload completo', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const writer = spyWriter();
  const s = new Session(dir, { writer, debounceMs: 300, maxWaitMs: 2000 });
  t.after(() => clearTimeout(s.saveT));

  for (let i = 0; i < 9; i++) {
    s.record(i === 0 ? alert('e0', 'u0', 'cheer', { amount: 300 }) : alert('e' + i, 'u' + i));
    t.mock.timers.tick(200);                     // reinicia el debounce, nunca 200 ms de pausa
  }
  s.addNote({ kind: 'marker', label: 'importante' });
  s.setThanked('e2', true);
  s.addToGoal('follows', 4);
  t.mock.timers.tick(199);
  await settle();
  assert.equal(writer.calls.length, 0);          // el maxWait vence a los 2000 ms, no al IO
  t.mock.timers.tick(1);
  await settle();
  assert.equal(writer.calls.length, 1);
  const snap = writer.calls[0].data;
  assert.equal(snap.events.length, 9);
  assert.equal(snap.events.find(e => e.id === 'e2').thanked, true);
  assert.equal(snap.notes.length, 1);
  assert.equal(snap.goalOffsets.follows, 4);

  s.record(alert('e9', 'u9'));                   // tras el checkpoint, otra ventana
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(writer.calls.length, 2);
});

test('el flush explícito espera al checkpoint en vuelo y guarda lo posterior', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const gate = deferred();
  const started = deferred();
  const writer = spyWriter({ blockFirst: { gate, started } });
  const s = new Session(dir, { writer });
  t.after(() => { gate.resolve(); clearTimeout(s.saveT); });

  s.record(alert('a1', 'ana'));
  const A = s.flush().catch(err => err);
  await settle();
  assert.equal(writer.calls.length, 1);          // falla rápido en el baseline: no usa el writer
  await started.promise;

  s.record(alert('b1', 'luis'));
  const B = s.flush().catch(err => err);
  let settled = false;
  B.then(() => { settled = true; });
  await settle();
  assert.equal(writer.calls.length, 2);
  assert.equal(settled, false);                  // B no termina mientras A está retenido
  gate.resolve();
  await B;
  await A;
  assert.equal(settled, true);
  assert.deepEqual(writer.calls[1].data.events.map(e => e.vars.user), ['ana', 'luis']);
});

test('fallo de rename: flush rechaza seguro, reporta una vez y se recupera', async t => {
  const dir = await ownDir(t);
  const arm = { on: false, failed: false };
  const writer = createJsonWriter(armedRenameIO(arm));
  const reports = [];
  const s = new Session(dir, { writer, report: m => reports.push(m) });

  s.record(alert('a', 'ana'));
  await s.flush();                               // siembra un fichero válido
  const seeded = JSON.parse(await fsp.readFile(s.file, 'utf8'));
  assert.equal(seeded.events.length, 1);

  arm.on = true;
  s.record(alert('b', 'bea'));
  await assert.rejects(s.flush(), err => {
    assert.equal(err.status, 500);
    assert.equal(err.code, 'SESSION_PERSISTENCE_FAILED');
    assert.doesNotMatch(err.message, /CANARY-SESSION-SECRET|session-current|\.tmp|rename/);
    assert.ok(err.cause && /CANARY-SESSION-SECRET/.test(err.cause.message));   // crudo interno, no público
    return true;
  });
  assert.equal(reports.length, 1);
  assert.doesNotMatch(String(reports[0]), /CANARY-SESSION-SECRET|session-current|\.tmp|rename/);
  assert.ok(s.lastSaveError);                    // error acotado visible
  assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).events.length, 1);   // final previo intacto

  await s.flush();                               // reintento válido tras el fallo agotado
  assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).events.length, 2);
  assert.equal(s.lastSaveError, null);           // el éxito limpia el error
});

test('un report que lanza no corrompe el productor ni deja rechazo colgado', async t => {
  const dir = await ownDir(t);
  const arm = { on: false, failed: false };
  const writer = createJsonWriter(armedRenameIO(arm));
  const s = new Session(dir, { writer, report: () => { throw new Error('report roto CANARY-SESSION-SECRET'); } });

  s.record(alert('a', 'ana'));
  await s.flush();
  arm.on = true;
  await assert.rejects(s.flush(), err => err.code === 'SESSION_PERSISTENCE_FAILED');
  await settle();                                // sin unhandledRejection por el report
  await s.flush();                               // la cadena sigue siendo recuperable
  assert.equal(s.lastSaveError, null);
  assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).events.length, 1);
});

test('flush escribe .data mutado directamente aunque no se llame a save()', async t => {
  const dir = await ownDir(t);
  const writer = spyWriter();
  const reports = [];
  const s = new Session(dir, { writer, report: m => reports.push(m) });

  s.data.events.push({ ...alert('direct', 'legacy'), thanked: true });
  s.data.notes.push({ id: 'n1', kind: 'marker', at: new Date().toISOString(), label: 'x' });
  s.data.goalOffsets.follows = 3;
  await s.flush();                               // siempre escribe, sin fingerprint ni skip
  assert.equal(writer.calls.length, 1);
  const snap = writer.calls[0].data;
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].thanked, true);
  assert.equal(snap.notes.length, 1);
  assert.equal(snap.goalOffsets.follows, 3);
  assert.equal(s.lastSaveError, null);           // un éxito no se reporta como fallo
  assert.deepEqual(reports, []);
});

test('tras un flush graceful, una Session nueva carga todo lo aceptado', async t => {
  const dir = await ownDir(t);

  const s = new Session(dir);
  s.record(alert('a', 'ana', 'cheer', { amount: 300 }));
  s.addNote({ kind: 'winner', user: 'bea', label: 'premio' });
  s.setThanked('a', true);
  s.addToGoal('bits', 10);
  await s.flush();

  const reloaded = await new Session(dir).load();
  assert.equal(reloaded.data.events.length, 1);
  assert.equal(reloaded.data.events[0].thanked, true);
  assert.equal(reloaded.data.notes.length, 1);
  assert.equal(reloaded.data.notes[0].kind, 'winner');
  assert.equal(reloaded.data.goalOffsets.bits, 10);
});

test('flush cancela debounce y maxWait: no hay escritura duplicada posterior', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const writer = spyWriter();
  const s = new Session(dir, { writer, debounceMs: 300, maxWaitMs: 2000 });
  t.after(() => clearTimeout(s.saveT));

  s.record(alert('a', 'ana'));
  await s.flush();
  const n = writer.calls.length;                 // regresión: el baseline ya limpia su debounce
  t.mock.timers.tick(5000);
  await settle();
  assert.ok(n <= 1);
  assert.equal(writer.calls.length, n);          // ningún timer zombi vuelve a escribir
});

test('un proceso que acepta datos y termina por su cuenta deja el JSON persistido', async t => {
  const dir = await ownDir(t);
  const program = `
    import { Session } from ${JSON.stringify(new URL('../src/session.mjs', import.meta.url).href)};
    const s = new Session(process.argv[1]);
    s.record({ id: 'e1', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' });
    s.setThanked('e1', true);
    s.addNote({ kind: 'winner', user: 'bea', label: 'premio' });
    s.addToGoal('bits', 7);
  `;

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, dir], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);

  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'session-current.json'), 'utf8'));
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].thanked, true);
  assert.equal(saved.notes.find(n => n.kind === 'winner').user, 'bea');
  assert.equal(saved.goalOffsets.bits, 7);

  // ODD-06b.1: la salida natural debe persistir también el backup, idéntico al primary.
  const backup = JSON.parse(await fsp.readFile(path.join(dir, 'session-current.backup.json'), 'utf8'));
  assert.deepEqual(backup, saved);
});
