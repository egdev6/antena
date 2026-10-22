// Teleprompter: troceado del guion, avance por ancla, paradas en notas y control.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Teleprompter, tokenize, compile, DEFAULT_TELEPROMPTER } from '../src/teleprompter.mjs';

function setup(tp = {}) {
  let t = 5_000_000;
  const store = { config: { teleprompter: { ...structuredClone(DEFAULT_TELEPROMPTER), countdownSec: 0, ...tp } }, save() {} };
  const T = new Teleprompter({ store, now: () => t });
  return { T, store, advance: ms => { t += ms; } };
}
const script = { id: 'g', title: 'G', blocks: [
  { id: 'a', title: 'Uno', text: 'uno dos tres cuatro' },
  { id: 'b', title: 'Dos', text: 'cinco seis [nota aquí] siete\n\nocho' },
  { id: 'c', title: 'Tres', text: 'nueve diez' },
] };

test('tokenize: palabras, notas entre corchetes y saltos', () => {
  const { tokens, end } = tokenize('hola [mira a cámara] mundo\nadiós\n\nfin', 10);
  assert.equal(end, 14);
  assert.deepEqual(tokens, [{ w: 'hola', i: 10 }, { note: 'mira a cámara', at: 11 }, { w: 'mundo', i: 11 }, { br: 1 }, { w: 'adiós', i: 12 }, { br: 2 }, { w: 'fin', i: 13 }]);
});

test('compile: inicio de cada bloque, total y posiciones de las notas', () => {
  const c = compile(script);
  assert.deepEqual(c.blocks.map(b => [b.start, b.words]), [[0, 4], [4, 4], [8, 2]]);
  assert.equal(c.total, 10);
  assert.deepEqual(c.notes, [6]);
});

test('avance a wpm y cambio de velocidad sin saltos', () => {
  const { T, advance } = setup({ scripts: [script], activeId: 'g', wpm: 60 });
  T.control('play');
  advance(3000);
  assert.equal(Math.round(T.position()), 3);
  T.settings({ wpm: 120 });
  assert.equal(Math.round(T.position()), 3);
  advance(1000);
  assert.equal(Math.round(T.position()), 5);
  T.control('pause');
  advance(5000);
  assert.equal(Math.round(T.position()), 5);
  T.stop();
});

test('cuenta atrás: el ancla empieza en el futuro', () => {
  const { T, advance } = setup({ scripts: [script], activeId: 'g', wpm: 60, countdownSec: 3 });
  T.control('play');
  advance(2000);
  assert.equal(T.position(), 0);
  advance(2000);
  assert.equal(Math.round(T.position()), 1);
  T.stop();
});

test('bloques: siguiente, anterior (primero al inicio del bloque) y por id', () => {
  const { T } = setup({ scripts: [script], activeId: 'g' });
  assert.equal(T.control('next').playback.position, 4);
  assert.equal(T.control('next').playback.position, 8);
  assert.equal(T.control('prev').playback.position, 4);
  T.control('seek', 7);
  assert.equal(T.control('prev').playback.position, 4);   // a mitad: al principio del bloque
  assert.equal(T.control('block', 'c').playback.block, 2);
  assert.equal(T.control('reset').playback.position, 0);
  assert.throws(() => T.control('block', 'zz'), /No existe el bloque/);
  assert.throws(() => T.control('volar'), /Acción desconocida/);
});

test('se para solo al final y, si se pide, antes de cada [nota]', async () => {
  const { T } = setup({ scripts: [script], activeId: 'g', wpm: 300, pauseAtNotes: true });
  // reloj real para el temporizador
  T.now = Date.now;
  T.control('play');
  await new Promise(r => setTimeout(r, 6 / 300 * 60000 + 150));
  assert.equal(T.play.playing, false);
  assert.equal(T.position(), 6);
  T.control('play');   // reanuda y ya no se para en la misma nota
  await new Promise(r => setTimeout(r, 4 / 300 * 60000 + 150));
  assert.equal(T.play.playing, false);
  assert.equal(T.position(), 10);
  T.stop();
});

test('guiones: crear, editar, elegir y borrar; ajustes acotados', () => {
  const { T, store } = setup();
  const r = T.createScript({ title: 'Directo', blocks: [{ title: 'Intro', text: 'hola a todos' }] });
  assert.equal(store.config.teleprompter.activeId, r.script.id);
  assert.equal(T.snapshot().script.total, 3);
  T.updateScript(r.script.id, { blocks: [{ title: 'Intro', text: 'hola' }, { title: 'Fin', text: 'adiós y gracias' }] });
  assert.equal(T.snapshot().script.blocks.length, 2);
  T.select('ejemplo');
  assert.equal(T.snapshot().activeId, 'ejemplo');
  T.deleteScript(r.script.id);
  assert.equal(T.snapshot().scripts.length, 1);
  assert.throws(() => T.select('nada'), /No existe el guion/);
  T.settings({ wpm: 9999, size: 1, mirror: 1 });
  assert.deepEqual([store.config.teleprompter.wpm, store.config.teleprompter.size, store.config.teleprompter.mirror], [300, 14, true]);
  assert.throws(() => T.settings({ wpm: 'rápido' }), /número/);
  T.control('faster');
  assert.equal(store.config.teleprompter.wpm, 300);
  T.control('slower');
  assert.equal(store.config.teleprompter.wpm, 290);
});

// ---------- correcciones de revisión (#143): difusión, contador de revisión y topes ----------

test('snapshot: la lista de guiones es solo {id,title} y el guion activo lleva el texto', () => {
  const { T } = setup();
  const snap = T.snapshot();
  assert.deepEqual(snap.scripts, snap.scripts.map(s => ({ id: s.id, title: s.title })));
  const activo = snap.scripts.find(s => s.id === snap.activeId);
  assert.ok(activo);
  // el texto crudo vive SOLO en el guion activo compilado (bloques con text)
  assert.ok(snap.script.blocks.every(b => typeof b.text === 'string'));
  T.createScript({ title: 'Otro', blocks: [{ title: 'X', text: 'palabra secreta' }] });
  const snap2 = T.snapshot();
  assert.ok(!JSON.stringify(snap2.scripts).includes('palabra secreta'));
  assert.ok(JSON.stringify(snap2.script).includes('palabra secreta'));
});

test('contador de revisión: editar el guion activo recompila sin clave JSON.stringify', () => {
  const { T } = setup();
  const r = T.createScript({ title: 'R', blocks: [{ title: 'A', text: 'uno dos tres' }] });
  const antes = T.snapshot().script.total;
  T.updateScript(r.script.id, { blocks: [{ title: 'A', text: 'uno dos tres cuatro cinco seis' }] });
  assert.equal(T.snapshot().script.total, antes + 3);
  assert.equal(typeof T.revision, 'number');
  const rev = T.revision;
  T.settings({ wpm: 100 });
  assert.equal(T.revision, rev);   // los ajustes no recompilan el guion
});

test('tope de tamaño total de guiones (create/update y esquema)', async () => {
  const { T } = setup();
  const GRANDE = 'x'.repeat(20000);   // cleanScript acota cada bloque a 20000 caracteres
  const { validatePatch } = await import('../src/config-schema.mjs');
  const mal = validatePatch({ teleprompter: { scripts: [{ id: 'g', title: 'G', blocks: [{ id: 'b', title: 'B', text: 'x'.repeat(1100000) }] }] } });
  assert.ok(mal.length, 'el esquema rechaza un solo guion que se pasa del tope total');
  const bien = validatePatch({ teleprompter: { scripts: [{ id: 'g', title: 'G', blocks: [{ id: 'b', title: 'B', text: 'hola' }] }] } });
  assert.deepEqual(bien, []);
  assert.throws(() => T.createScript({ title: 'Enorme', blocks: Array.from({ length: 60 }, (_, i) => ({ title: `B${i}`, text: GRANDE })) }), /demasiado/i);
});

test('createScript por encima del tope: 400 y la configuración queda intacta (sin guardar)', async () => {
  const saves = [];
  const store = { config: { teleprompter: structuredClone(DEFAULT_TELEPROMPTER) }, save(what) { saves.push(what); } };
  const T = new Teleprompter({ store });
  const antes = structuredClone(store.config.teleprompter.scripts);
  const GRANDE = 'x'.repeat(20000);
  assert.throws(() => T.createScript({ title: 'Enorme', blocks: Array.from({ length: 60 }, (_, i) => ({ title: `B${i}`, text: GRANDE })) }), err => err.status === 400);
  assert.deepEqual(store.config.teleprompter.scripts, antes, 'los guiones vivos no cambian');
  assert.deepEqual(saves, [], 'no se guarda nada');
});
