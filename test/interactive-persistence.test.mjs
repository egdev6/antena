// ODD-07 · Contrato permanente de persistencia de Interactive: save() devuelve void y
// programa un debounce trailing de `debounceMs` con techo `maxWaitMs` que NO se reinicia,
// con timers referenciados; flush() explícito cancela ambos timers, escribe SIEMPRE el
// estado actual (aunque no haya save()) con una instantánea síncrona al encolar y
// { after: cadena por instancia }, y ante un fallo rechaza tipado
// INTERACTIVE_PERSISTENCE_FAILED (status 500, mensaje constante, `cause` interno) tras
// reportar la constante una vez; lastSaveError se limpia al volver a guardar. Cada caso
// usa su propio directorio temporal en /tmp y no toca red, Twitch, Meld ni la config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Interactive, DEFAULT_INTERACTIVE_CONFIG } from '../src/interactive.mjs';
import { createJsonWriter, writeJson } from '../src/json-file.mjs';

// Directorio propio por caso; t.after limpia solo lo que creó el test.
async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-interactive-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
// El reloj falso de node:test no controla setImmediate: se cede el turno real sin dormir.
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const exists = async p => { try { await fsp.access(p); return true; } catch { return false; } };

// Instancia real sin red, Twitch ni Meld: store ficticio con la config por defecto.
function makeInteractive(dir, opts = {}) {
  const store = { dir, config: { interactive: structuredClone(DEFAULT_INTERACTIVE_CONFIG) } };
  return new Interactive({ store, twitch: { sendChat: async () => ({ is_sent: true }) }, meld: { connected: false }, log: () => {}, ...opts });
}
const q = id => ({ id, user: 'ana', platform: 'manual', text: 'Pregunta ' + id, at: new Date().toISOString(), status: 'pending' });
const entry = user => ({ user, platform: 'manual', member: false, at: new Date().toISOString() });

// Escritor espía con la API del helper: instantánea JSON síncrona al aceptar y espera
// de `opts.after` dentro del cuerpo async; opcionalmente retiene la primera escritura.
function spyWriter({ blockFirst } = {}) {
  const calls = [];
  const writer = (file, data, opts = {}) => {
    const snap = JSON.parse(JSON.stringify(data));
    const n = calls.push({ file, data: snap, after: opts.after });
    return (async () => {
      if (opts.after) await opts.after;
      if (blockFirst && n === 1) { blockFirst.started.resolve(); await blockFirst.gate.promise; }
    })();
  };
  writer.calls = calls;
  return writer;
}
// IO real que falla el rename solo cuando el test lo arma; el primer fallo se agota.
function armedRenameIO(arm) {
  return {
    mkdir: (p, o) => fsp.mkdir(p, o),
    open: (f, flags, mode) => fsp.open(f, flags, mode),
    rename: (a, b) => {
      if (arm.on && !arm.failed) {
        arm.failed = true;
        const err = new Error(`rename falló CANARY-INTERACTIVE-SECRET en ${a} -> ${b}`);
        err.code = 'CANARY_FAULT';
        return Promise.reject(err);
      }
      return fsp.rename(a, b);
    },
    unlink: p => fsp.unlink(p),
  };
}

test('flush() explícito sin save() persiste preguntas, votos y participantes actuales', async t => {
  const dir = await ownDir(t);
  const writer = spyWriter();
  const s = makeInteractive(dir, { writer });
  s.s.questions.push(q('q1'));
  s.s.giveaway.entries.push(entry('luis'));
  s.s.vote = { listId: 'l1', itemId: 'i1', votes: { ana: 's' }, openedAt: new Date().toISOString(), endsAt: null };
  await s.flush();
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].file, s.file);
  const saved = writer.calls[0].data;
  assert.equal(saved.questions.length, 1);
  assert.equal(saved.giveaway.entries[0].user, 'luis');
  assert.equal(saved.vote.votes.ana, 's');
});

test('la instantánea se toma al encolar el flush: mutar después no cambia lo escrito', async t => {
  const dir = await ownDir(t);
  const writer = spyWriter();
  const s = makeInteractive(dir, { writer });
  s.s.questions.push(q('q1'));
  const pending = s.flush();
  s.s.questions.push(q('q2'));
  await pending;
  assert.equal(writer.calls.length, 1);
  assert.deepEqual(writer.calls[0].data.questions.map(x => x.id), ['q1']);
});

test('dos flush se serializan por la puerta de la instancia y la segunda espera a la primera', async t => {
  const dir = await ownDir(t);
  const gate = deferred();
  const started = deferred();
  const writer = spyWriter({ blockFirst: { gate, started } });
  const s = makeInteractive(dir, { writer });
  t.after(() => gate.resolve());
  s.s.questions.push(q('q1'));
  const a = s.flush().catch(err => err);
  assert.equal(writer.calls.length, 1);
  await started.promise;
  s.s.questions.push(q('q2'));
  const b = s.flush().catch(err => err);
  let settled = false; b.then(() => { settled = true; });
  await settle();
  assert.equal(writer.calls.length, 2);
  assert.equal(settled, false);
  gate.resolve();
  await a; await b;
  assert.equal(settled, true);
  assert.deepEqual(writer.calls[1].data.questions.map(x => x.id), ['q1', 'q2']);
});

test('save() agrupa con debounce trailing y un techo maxWait que no se reinicia', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const writer = spyWriter();
  const s = makeInteractive(dir, { writer, debounceMs: 300, maxWaitMs: 2000 });
  t.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });
  for (let i = 0; i < 9; i++) { s.addQuestion({ user: 'u' + i, text: 'Pregunta suficientemente larga ' + i }); t.mock.timers.tick(200); }
  s.addQuestion({ user: 'u9', text: 'Pregunta suficientemente larga 9' });   // reinicia el debounce, no el techo
  t.mock.timers.tick(199);
  await settle();
  assert.equal(writer.calls.length, 0);          // el techo vence a los 2000 ms, no al IO
  t.mock.timers.tick(1);
  await settle();
  assert.equal(writer.calls.length, 1);
  assert.equal(writer.calls[0].data.questions.length, 10);
  s.addQuestion({ user: 'z', text: 'Otra pregunta distinta' });
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(writer.calls.length, 2);          // segunda ventana independiente
});

test('save() es void y solo escribe al vencer 300 ms de reposo (trailing)', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const writer = spyWriter();
  const s = makeInteractive(dir, { writer, debounceMs: 300, maxWaitMs: 2000 });
  t.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });
  assert.equal(s.save(), undefined);             // save() no devuelve promesa
  t.mock.timers.tick(299);
  await settle();
  assert.equal(writer.calls.length, 0);          // todavía dentro del reposo
  t.mock.timers.tick(1);
  await settle();
  assert.equal(writer.calls.length, 1);          // escribe al vencer el reposo
});

test('flush() cancela debounce y maxWait: ningún timer zombi escribe después', async t => {
  const dir = await ownDir(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const writer = spyWriter();
  const s = makeInteractive(dir, { writer, debounceMs: 300, maxWaitMs: 2000 });
  t.after(() => { clearTimeout(s.saveT); clearTimeout(s.maxT); });
  s.addQuestion({ user: 'ana', text: 'Pregunta suficientemente larga' });
  await s.flush();
  const n = writer.calls.length;
  assert.ok(n >= 1, 'el flush explícito debe escribir');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(writer.calls.length, n);
});

test('fallo de rename: flush rechaza tipado, reporta la constante una vez y se recupera', async t => {
  const dir = await ownDir(t);
  const arm = { on: false, failed: false };
  const writer = createJsonWriter(armedRenameIO(arm));
  const reports = [];
  const s = makeInteractive(dir, { writer, report: m => reports.push(m) });
  s.s.questions.push(q('q1'));
  await s.flush();
  assert.deepEqual(reports, []);
  arm.on = true;
  s.s.questions.push(q('q2'));
  await assert.rejects(s.flush(), err => {
    assert.equal(err.status, 500);
    assert.equal(err.code, 'INTERACTIVE_PERSISTENCE_FAILED');
    assert.equal(err.message, 'No se pudieron guardar los interactivos.');
    assert.equal(err.cause.code, 'CANARY_FAULT');
    return true;
  });
  assert.deepEqual(reports, ['No se pudieron guardar los interactivos.']);
  assert.equal(s.lastSaveError, 'No se pudieron guardar los interactivos.');
  await s.flush();
  assert.equal(s.lastSaveError, null);
  assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).questions.length, 2);
});

test('un writer síncrono que lanza y un report que lanza no dejan rechazos huérfanos', async t => {
  const dir = await ownDir(t);
  let broken = true;
  const writer = (file, data, opts) => {
    if (broken) throw new Error('writer síncrono CANARY-INTERACTIVE-SECRET');
    return writeJson(file, data, opts);
  };
  const s = makeInteractive(dir, { writer, report: () => { throw new Error('report roto CANARY-INTERACTIVE-SECRET'); } });
  s.s.questions.push(q('q1'));
  await assert.rejects(s.flush(), err => err.code === 'INTERACTIVE_PERSISTENCE_FAILED');
  await settle();                                // sin unhandledRejection por writer o report
  broken = false;
  await s.flush();
  assert.equal(s.lastSaveError, null);
  assert.equal(JSON.parse(await fsp.readFile(s.file, 'utf8')).questions.length, 1);
});

test('dos instancias con el helper real sobre el mismo fichero dejan JSON válido sin temporales', async t => {
  const dir = await ownDir(t);
  const a = makeInteractive(dir, { writer: writeJson });
  const b = makeInteractive(dir, { writer: writeJson });
  a.s.questions.push(q('a'));
  b.s.questions.push(q('b'));
  b.s.giveaway.entries.push(entry('bea'));
  const pendingA = a.flush();
  const pendingB = b.flush();          // ambas encoladas antes de que ninguna se asiente
  await Promise.all([pendingA, pendingB]);
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'interactive.json'), 'utf8'));
  assert.deepEqual(saved.questions.map(x => x.id), ['b']);
  assert.equal(saved.giveaway.entries[0].user, 'bea');
  assert.deepEqual((await fsp.readdir(dir)).filter(n => n !== 'interactive.json'), []);
});

test('un proceso hijo que acepta un cambio y termina de forma natural deja el JSON persistido', async t => {
  const dir = await ownDir(t);
  const mod = new URL('../src/interactive.mjs', import.meta.url).href;
  const program = `
    import { Interactive, DEFAULT_INTERACTIVE_CONFIG } from ${JSON.stringify(mod)};
    const dir = process.argv[1];
    const s = new Interactive({ store: { dir, config: { interactive: structuredClone(DEFAULT_INTERACTIVE_CONFIG) } }, twitch: { sendChat: async () => ({}) }, meld: { connected: false }, log: () => {} });
    s.s.giveaway.entries.push({ user: 'ana', platform: 'manual', member: false, at: new Date().toISOString() });
    s.changed('giveaway');
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, dir], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const file = path.join(dir, 'interactive.json');
  assert.equal(await exists(file), true, 'interactive.json debe persistir en la salida natural');
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).giveaway.entries[0].user, 'ana');
});
