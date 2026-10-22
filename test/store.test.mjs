import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'egdev-store-'));
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));
const clean = dir => rm(dir, { recursive: true, force: true });

test('write propaga el fallo de IO, mantiene la cadena recuperable y conserva el pendiente', async () => {
  const dir = await tmp();
  try {
    const s = new Store(dir);
    assert.deepEqual(s.persistenceState(), { dirty: { config: false, secrets: false }, message: { config: null, secrets: null }, pending: { config: 0, secrets: 0 } });
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    s.cfgFile = path.join(blocker, 'config.json');   // el padre es un fichero → ENOTDIR

    const pending = s.write(s.cfgFile, { port: 1234 });
    await s.chain;   // la cola queda recuperada aunque el productor falle
    await assert.rejects(pending, err => {
      assert.equal(err.code, 'PERSISTENCE_FAILED');
      assert.equal(err.status, 500);
      assert.match(err.message, /No se pudo guardar la configuración/);
      assert.match(err.message, /pendientes de guardado/);
      assert.doesNotMatch(err.message, /ENOTDIR|config\.json|blocker/);
      return true;
    });
    assert.equal(s.persistenceState().dirty.config, true);

    // reparar el destino: la escritura siguiente persiste y limpia el DIRTY de config
    const good = path.join(dir, 'ok', 'config.json');
    s.cfgFile = good;
    await s.write(good, { port: 4321 });
    assert.deepEqual(await readJson(good), { port: 4321 });
    assert.equal(s.persistenceState().dirty.config, false);
    assert.equal(s.persistenceState().message.config, null);
  } finally { await clean(dir); }
});

test('patchConfig no emite cambio si el guardado falla y sí lo emite al persistir', async () => {
  const dir = await tmp();
  try {
    const s = new Store(dir);
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    s.cfgFile = path.join(blocker, 'config.json');
    let changes = 0;
    s.on('change', () => changes++);
    await assert.rejects(s.patchConfig({ paused: true }));
    assert.equal(changes, 0);
    assert.equal(s.config.paused, true);   // pendiente en memoria, sin rollback global
    assert.equal(s.persistenceState().dirty.config, true);
    s.cfgFile = path.join(dir, 'config.json');
    await s.patchConfig({ paused: false });
    assert.equal(changes, 1);
    assert.equal((await readJson(path.join(dir, 'config.json'))).paused, false);
  } finally { await clean(dir); }
});

test('config y secretos mantienen DIRTY por fichero y el error no filtra el valor', async () => {
  const dir = await tmp();
  try {
    const s = new Store(dir);
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    s.cfgFile = path.join(blocker, 'config.json');
    s.secFile = path.join(blocker, 'secrets.json');

    await assert.rejects(s.patchConfig({ tts: { rate: 1.5 } }));
    await assert.rejects(s.setSecret('token', 'SUPER-SECRET-VALUE'), err => {
      assert.doesNotMatch(err.message, /SUPER-SECRET-VALUE|secrets\.json|blocker/);
      return true;
    });
    let st = s.persistenceState();
    assert.equal(st.dirty.config, true);
    assert.equal(st.dirty.secrets, true);

    s.cfgFile = path.join(dir, 'config.json');
    await s.patchConfig({ tts: { rate: 1.5 } });
    st = s.persistenceState();
    assert.equal(st.dirty.config, false);   // solo se limpia el mismo fichero
    assert.equal(st.dirty.secrets, true);

    s.secFile = path.join(dir, 'secrets.json');
    await s.setSecret('token', 'v2');
    st = s.persistenceState();
    assert.equal(st.dirty.secrets, false);
    assert.deepEqual(await readJson(path.join(dir, 'secrets.json')), { token: 'v2' });
    assert.deepEqual(Object.keys(st).sort(), ['dirty', 'message', 'pending']);   // estado acotado
    st.dirty.config = true;   // la copia no muta el estado interno
    st.pending.config = 99;
    assert.equal(s.persistenceState().dirty.config, false);
    assert.equal(s.persistenceState().pending.config, 0);
  } finally { await clean(dir); }
});

test('pending sube al entrar, se mantiene con la cola llena y solo emite en transiciones visibles', async () => {
  const dir = await tmp();
  let release;
  try {
    const s = new Store(dir);
    const events = [];
    s.on('persistence', st => events.push(structuredClone(st)));
    assert.deepEqual(s.persistenceState().pending, { config: 0, secrets: 0 });

    // puerta manual sobre la misma cadena que usa write(); no añade API de runtime ni duerme
    const gate = new Promise(resolve => { release = resolve; });
    s.chain = s.chain.then(() => gate);
    const first = s.write(s.cfgFile, { n: 1 });
    assert.equal(s.persistenceState().pending.config, 1);   // síncrono al entrar
    assert.equal(events.length, 1);
    assert.equal(events[0].pending.config, 1);
    assert.equal(events[0].dirty.config, false);

    const second = s.write(s.cfgFile, { n: 2 });
    assert.equal(s.persistenceState().pending.config, 2);
    assert.equal(events.length, 1);   // 1→2 no es una transición visible

    release();
    await first;
    assert.equal(s.persistenceState().pending.config, 1);   // sigue >0 hasta que asienta el segundo
    await second;
    assert.equal(s.persistenceState().pending.config, 0);
    assert.equal(s.persistenceState().dirty.config, false);
    assert.equal(events.length, 2);   // 2→0 con dirty intacto
    assert.equal(events[1].pending.config, 0);
    assert.equal(events[1].dirty.config, false);
  } finally { release?.(); await clean(dir); }
});

test('el fallo decrementa pending, marca DIRTY por fichero y emite un estado sin datos crudos', async () => {
  const dir = await tmp();
  try {
    const s = new Store(dir);
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    s.cfgFile = path.join(blocker, 'config.json');
    s.secFile = path.join(blocker, 'secrets.json');
    const events = [];
    s.on('persistence', st => events.push(structuredClone(st)));

    await assert.rejects(s.patchConfig({ paused: true }));
    await assert.rejects(s.setSecret('token', 'SUPER-SECRET-VALUE'));
    const st = s.persistenceState();
    assert.deepEqual(st.pending, { config: 0, secrets: 0 });   // asentado aunque falle
    assert.deepEqual(st.dirty, { config: true, secrets: true });
    const last = events.at(-1);
    assert.equal(last.pending.config, 0);
    assert.equal(last.dirty.config, true);
    assert.equal(last.dirty.secrets, true);
    assert.doesNotMatch(JSON.stringify(events), /SUPER-SECRET-VALUE|ENOTDIR|blocker|config\.json|secrets\.json/);

    // reparar solo config: se limpia solo su dirty y su pending vuelve a 0
    s.cfgFile = path.join(dir, 'config.json');
    await s.patchConfig({ paused: false });
    assert.deepEqual(s.persistenceState().dirty, { config: false, secrets: true });
    assert.deepEqual(s.persistenceState().pending, { config: 0, secrets: 0 });
  } finally { await clean(dir); }
});

test('un oyente de persistence que lanza no corrompe el resultado de IO', async () => {
  const dir = await tmp();
  try {
    const s = new Store(dir);
    const listenerErrors = [];
    s.on('persistence', () => { throw new Error('oyente roto'); });
    s.on('persistenceListenerError', e => listenerErrors.push(e));

    await s.write(s.cfgFile, { n: 1 });   // un guardado correcto sigue resolviendo
    assert.deepEqual(await readJson(s.cfgFile), { n: 1 });
    assert.ok(listenerErrors.length >= 1);

    // un fallo real de IO sigue rechazando: el oyente no lo convierte en éxito
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    s.cfgFile = path.join(blocker, 'config.json');
    await assert.rejects(s.write(s.cfgFile, { n: 2 }), err => err.code === 'PERSISTENCE_FAILED');
    assert.equal(s.persistenceState().pending.config, 0);
  } finally { await clean(dir); }
});

test('la instantánea de datos se toma al aceptar la escritura, no al ejecutarla en la cola', async () => {
  const dir = await tmp();
  let release;
  try {
    const s = new Store(dir);
    const data = { nested: { n: 1 }, list: [1, 2] };
    const gate = new Promise(resolve => { release = resolve; });
    s.chain = s.chain.then(() => gate);          // la escritura queda aceptada pero en espera
    const pending = s.write(s.cfgFile, data);
    data.nested.n = 999;                         // mutación posterior a la aceptación
    data.list.push(3);
    release();
    await pending;
    assert.deepEqual(await readJson(s.cfgFile), { nested: { n: 1 }, list: [1, 2] });
  } finally { release?.(); await clean(dir); }
});

test('la escritura en cola tras un fallo se ejecuta y persiste de verdad', async () => {
  const dir = await tmp();
  try {
    const s = new Store(dir);
    const blocker = path.join(dir, 'blocker');
    await writeFile(blocker, 'x');
    const bad = path.join(blocker, 'a.json');
    const good = path.join(dir, 'sub', 'b.json');
    const first = s.write(bad, { n: 1 });
    const second = s.write(good, { n: 2 });
    await assert.rejects(first);
    await second;
    await assert.rejects(readFile(bad));      // el fallo no fingió persistir
    assert.deepEqual(await readJson(good), { n: 2 });
  } finally { await clean(dir); }
});
