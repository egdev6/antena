// ODD-05 · Contrato de la utilidad compartida de escritura JSON atómica y serializada.
// Fase de tests: src/json-file.mjs AÚN NO EXISTE; este import es el RED real de API nueva.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJsonWriter, writeJson } from '../src/json-file.mjs';

// Directorio propio por caso; t.after limpia solo rutas que creó el test.
async function ownDir(t) {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), 'egdev-json-file-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}
const readJson = async file => JSON.parse(await fsp.readFile(file, 'utf8'));
// Resolver inicializado de forma ansiosa (evita la carrera del gate sin inicializar de ODD-04).
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
// IO real con una puerta que bloquea la escritura cuyo texto contiene `marker`.
// `started` avisa cuando esa escritura ya está dentro y bloqueada.
function gatedIO(marker) {
  const opened = [];
  const gate = deferred();
  const started = deferred();
  const io = {
    mkdir: (p, o) => fsp.mkdir(p, o),
    async open(file, flags, mode) {
      opened.push({ file, flags, mode });
      const handle = await fsp.open(file, flags, mode);
      return {
        async writeFile(text) {
          if (marker && text.includes(marker)) { started.resolve(); await gate.promise; }
          return handle.writeFile(text);
        },
        close: () => handle.close(),
      };
    },
    rename: (a, b) => fsp.rename(a, b),
    unlink: p => fsp.unlink(p),
  };
  return { io, opened, gate, started };
}
// IO real que falla una sola vez en la etapa pedida.
function faultIO(stage, opts = {}) {
  const events = [];
  let failed = false;
  const primary = message => { const err = new Error(message); err.code = 'PRIMARY_FAULT'; return err; };
  const io = {
    mkdir: (p, o) => fsp.mkdir(p, o),
    async open(file, flags, mode) {
      events.push(['open', file]);
      if (!failed && stage === 'open') { failed = true; throw primary(opts.message || 'fallo primario en open'); }
      if (!failed && stage === 'eexist') {
        failed = true;
        await fsp.writeFile(file, opts.foreign ?? 'ajeno');   // simula temporal ajeno ya existente
        const err = new Error('EEXIST'); err.code = 'EEXIST'; throw err;
      }
      const handle = await fsp.open(file, flags, mode);
      return {
        async writeFile(text) {
          if (!failed && stage === 'write') {
            failed = true;
            await handle.writeFile(text.slice(0, Math.max(1, Math.floor(text.length / 2))));   // parcial
            throw primary(opts.message || 'fallo primario a mitad de write');
          }
          return handle.writeFile(text);
        },
        close: () => handle.close(),
      };
    },
    async rename(a, b) {
      if (!failed && stage === 'rename') { failed = true; throw primary(opts.message || 'fallo primario en rename'); }
      return fsp.rename(a, b);
    },
    unlink: opts.unlinkFails
      ? p => { events.push(['unlink', p]); const err = new Error('unlink falla'); err.code = 'EPERM'; return Promise.reject(err); }
      : p => { events.push(['unlink', p]); return fsp.unlink(p); },
  };
  return { io, events };
}

test('escribe JSON profundo completo con modo 0600 (backend por defecto)', async t => {
  const dir = await ownDir(t);
  const file = path.join(dir, 'deep', 'config.json');
  const data = { a: { b: { c: [1, 2, { d: 'x' }] } }, list: [true, null, 0] };
  await writeJson(file, data);
  assert.deepEqual(await readJson(file), data);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
});

test('serializa la instantánea al aceptar: mutar el objeto no cambia lo escrito', async t => {
  const dir = await ownDir(t);
  const { io, opened, gate } = gatedIO('"original"');
  const writer = createJsonWriter(io);
  const file = path.join(dir, 'snap.json');
  const data = { id: 'original', nested: { n: 1 }, list: [1, 2] };
  const pending = writer(file, data, { after: gate.promise });
  data.nested.n = 999; data.list.push(3); data.id = 'mutado';   // mutación antes de liberar
  gate.resolve();
  await pending;
  assert.deepEqual(await readJson(file), { id: 'original', nested: { n: 1 }, list: [1, 2] });
  assert.equal(opened[0].flags, 'wx');
  assert.equal(opened[0].mode, 0o600);
  assert.equal(path.dirname(opened[0].file), path.dirname(file));   // temporal en la misma carpeta
});

test('serializa la misma ruta resuelta entre fábricas y deja destinos distintos en paralelo', async t => {
  const dir = await ownDir(t);
  const { io, opened, gate, started } = gatedIO('"primera"');
  const a = createJsonWriter(io);
  const b = createJsonWriter(io);
  const sameAbs = path.join(dir, 'subA', 'same.json');
  const sameRel = path.relative(process.cwd(), sameAbs);   // misma ruta, forma léxica distinta
  const other = path.join(dir, 'subB', 'other.json');
  try {
    const first = a(sameAbs, { id: 'primera' });
    const second = b(sameRel, { id: 'segunda' });
    const third = b(other, { id: 'otra' });
    await started.promise;              // la primera ya está dentro de su escritura, bloqueada
    await third;                        // destino distinto completa con la primera bloqueada
    const inA = () => opened.filter(o => path.dirname(o.file) === path.join(dir, 'subA')).length;
    assert.equal(inA(), 1);             // la segunda NO abrió su temporal todavía
    assert.deepEqual(await readJson(other), { id: 'otra' });
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(inA(), 2);
    assert.deepEqual(await readJson(sameAbs), { id: 'segunda' });
  } finally { gate.resolve(); }
});

for (const stage of ['open', 'write', 'rename']) {
  test(`fallo en ${stage}: conserva el JSON anterior, limpia su temporal y se recupera después`, async t => {
    const dir = await ownDir(t);
    const file = path.join(dir, 'config.json');
    await writeJson(file, { version: 1 });
    const before = await fsp.readdir(dir);
    const writer = createJsonWriter(faultIO(stage).io);
    await assert.rejects(writer(file, { version: 2 }), err => err.code === 'PRIMARY_FAULT');
    assert.deepEqual(await readJson(file), { version: 1 });         // el final nunca queda a medias
    assert.deepEqual(await fsp.readdir(dir), before);              // su temporal se limpió
    const recovered = createJsonWriter();
    await recovered(file, { version: 3 });
    assert.deepEqual(await readJson(file), { version: 3 });
  });
}

test('EEXIST en open no borra un temporal que esta escritura no creó', async t => {
  const dir = await ownDir(t);
  const file = path.join(dir, 'config.json');
  await writeJson(file, { version: 1 });
  const { io, events } = faultIO('eexist', { foreign: 'de otro' });
  const writer = createJsonWriter(io);
  await assert.rejects(writer(file, { version: 2 }));
  const tmp = events.find(e => e[0] === 'open')[1];
  assert.equal(await fsp.readFile(tmp, 'utf8'), 'de otro');        // intacto: no era suyo
  assert.deepEqual(await readJson(file), { version: 1 });
});

test('si la limpieza del temporal también falla, se conserva el error primario', async t => {
  const dir = await ownDir(t);
  const file = path.join(dir, 'config.json');
  const writer = createJsonWriter(faultIO('write', { unlinkFails: true, message: 'error primario visible' }).io);
  await assert.rejects(writer(file, { v: 1 }), err => {
    assert.equal(err.code, 'PRIMARY_FAULT');
    assert.doesNotMatch(err.message, /unlink/);
    return true;
  });
});

test('rechaza no serializables antes de tocar IO y se recupera en la siguiente escritura', async t => {
  const dir = await ownDir(t);
  const opened = [];
  const writer = createJsonWriter({
    mkdir: (p, o) => fsp.mkdir(p, o),
    async open(file, flags, mode) { opened.push(file); return fsp.open(file, flags, mode); },
    rename: (a, b) => fsp.rename(a, b),
    unlink: p => fsp.unlink(p),
  });
  const file = path.join(dir, 'x.json');
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(writer(file, cyclic));
  await assert.rejects(writer(file, { big: 1n }));
  await assert.rejects(writer(file, undefined));
  assert.equal(opened.length, 0);                                  // nunca abrió
  await assert.rejects(fsp.readFile(file));                        // no creó fichero
  await writer(file, { ok: true });
  assert.deepEqual(await readJson(file), { ok: true });
});

test('acepta trabajos FIFO por ruta con la instantánea tomada al aceptar cada uno', async t => {
  const dir = await ownDir(t);
  const written = [];
  const writer = createJsonWriter({
    mkdir: (p, o) => fsp.mkdir(p, o),
    async open(file, flags, mode) {
      const handle = await fsp.open(file, flags, mode);
      return { async writeFile(text) { written.push(text); return handle.writeFile(text); }, close: () => handle.close() };
    },
    rename: (a, b) => fsp.rename(a, b),
    unlink: p => fsp.unlink(p),
  });
  const file = path.join(dir, 'fifo.json');
  const a = { n: 1 }; const b = { n: 2 };
  const p1 = writer(file, a); a.n = 100;
  const p2 = writer(file, b); b.n = 200;
  await Promise.all([p1, p2]);
  assert.deepEqual(JSON.parse(written[0]), { n: 1 });
  assert.deepEqual(JSON.parse(written[1]), { n: 2 });
  assert.deepEqual(await readJson(file), { n: 2 });
});

test('muchas rutas distintas no se bloquean entre sí y su entrada de cola no queda colgada', async t => {
  const dir = await ownDir(t);
  const writer = createJsonWriter();
  const files = Array.from({ length: 24 }, (_, i) => path.join(dir, `d${i}`, 'x.json'));
  await Promise.all(files.map((f, i) => writer(f, { i })));
  for (let i = 0; i < files.length; i++) assert.deepEqual(await readJson(files[i]), { i });
  // El borrado de entradas ociosas del Map privado se verifica por revisión estructural:
  // no se añade telemetría pública solo para medirlo. Reescribir una ruta ya usada no se cuelga.
  await writer(files[0], { i: 're' });
  assert.deepEqual(await readJson(files[0]), { i: 're' });
});

// #67 (revisión): el formato por defecto del writer compartido sigue indentado —
// también lo usan Store (config.json/secrets.json) e Interactive; solo Session
// aporta su propio texto compacto vía la opción `text`.
test('el formato por defecto del writer es indentado y config.json del Store no cambia de formato', async t => {
  const dir = await ownDir(t);
  await writeJson(path.join(dir, 'directo.json'), { a: 1, b: { c: 2 } });
  const text = await fsp.readFile(path.join(dir, 'directo.json'), 'utf8');
  assert.ok(text.includes('\n  "a": 1'), 'el writer por defecto conserva la indentación');

  const { Store } = await import('../src/store.mjs');
  const store = new Store(dir);
  await store.load();
  store.config.port = 4321;
  await store.write(store.cfgFile, store.config);
  for (let i = 0; i < 10 && store.pending.config; i++) await new Promise(r => setImmediate(r));
  const cfgText = await fsp.readFile(path.join(dir, 'config.json'), 'utf8');
  assert.ok(cfgText.includes('\n  "port": 4321'), 'config.json sigue indentado tras un guardado del Store');
  assert.equal(JSON.parse(cfgText).port, 4321);
});
