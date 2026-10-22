// #68 · Retención de sesiones y media, listado barato y tope en la API.
// Tests primero: el listado debe basarse en metadatos ligeros (sin parsear cada
// archivo entero), la retención de archivados es opcional (0 = desactivada) y los
// topes de `limit` se aplican también al filtrar por `kinds`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Session } from '../src/session.mjs';
import { createJsonWriter } from '../src/json-file.mjs';
import { DEFAULT_CONFIG } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';

async function ownDir(t, prefix = 'egdev-session-retention-') {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// Sesión sintética archivada: archivo completo (aquí truncado a propósito: nadie
// debe necesitar parsearlo para listar) + metadatos ligeros junto a él.
const syntheticId = i => `2026-01-${String(i + 1).padStart(2, '0')}T10-00-00-000Z-${String(i).padStart(4, '0')}-synthetic`;
const writeArchived = async (dir, i, events = 20) => {
  const id = syntheticId(i);
  const full = { id, title: `Directo ${i}`, startedAt: '2026-01-01T10:00:00Z', endedAt: '2026-01-01T12:00:00Z', events: Array.from({ length: events }, (_, k) => ({ id: `ev${k}`, type: 'follow', at: '2026-01-01T10:01:00Z', user: `u${k}`, vars: {} })), notes: [], goalOffsets: {} };
  // Truncado deliberadamente: si algo parsea el archivo entero, el JSON es inválido.
  const truncated = JSON.stringify(full).slice(0, 40);
  await fsp.writeFile(path.join(dir, 'sessions', id + '.json'), truncated);
  const meta = { id, title: full.title, startedAt: full.startedAt, endedAt: full.endedAt, events };
  await fsp.writeFile(path.join(dir, 'sessions', id + '.meta.json'), JSON.stringify(meta));
  return id;
};

test('el listado usa metadatos ligeros: no lee los archivos completos', async t => {
  const dir = await ownDir(t);
  await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
  for (let i = 0; i < 50; i++) await writeArchived(dir, i);

  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000, io: {
    // Los metadatos ligeros sí se pueden leer; el archivo completo, jamás.
    readFile: (file, ...rest) => String(file).endsWith('.meta.json') || String(file).includes('session-current')
      ? fsp.readFile(file, ...rest)
      : Promise.reject(new Error('el listado no debe leer el archivo completo')),
  } }).load();

  const out = await s.list();
  assert.equal(out.length, 50);
  assert.equal(out[0].id, syntheticId(49), 'el más reciente primero');
  assert.equal(out[49].events, 20, 'el contador de eventos viene de los metadatos');
  assert.equal(out[0].title, 'Directo 49');
  assert.ok(!out.some(r => r.pending));
});

test('el listado mantiene la compatibilidad con sesiones archivadas sin metadatos', async t => {
  const dir = await ownDir(t);
  await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
  const full = { id: 'legacy-id', title: 'Antiguo', startedAt: '2025-01-01T10:00:00Z', endedAt: '2025-01-01T11:00:00Z', events: [{ id: 'e1', type: 'follow', at: '2025-01-01T10:05:00Z', user: 'ana', vars: {} }], notes: [], goalOffsets: {} };
  await fsp.writeFile(path.join(dir, 'sessions', 'legacy-id.json'), JSON.stringify(full));

  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000 }).load();
  const out = await s.list();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'legacy-id');
  assert.equal(out[0].events, 1);
  assert.equal(out[0].title, 'Antiguo');
});

test('el corte escribe metadatos ligeros junto al archivo archivado', async t => {
  const dir = await ownDir(t);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000 }).load();
  s.data.title = 'primero';
  await s.startNew('segundo');
  const files = await fsp.readdir(path.join(dir, 'sessions'));
  const metas = files.filter(f => f.endsWith('.meta.json'));
  assert.equal(metas.length, 1, 'cada archivado deja su fichero de metadatos');
  const meta = JSON.parse(await fsp.readFile(path.join(dir, 'sessions', metas[0]), 'utf8'));
  assert.equal(meta.id, metas[0].replace('.meta.json', ''));
  assert.equal(meta.title, 'primero', 'los metadatos describen el directo archivado');
  assert.ok(Number.isInteger(meta.events));
});

// #164: con un disco lento el corte debe resolver DESPUÉS de asentar los metadatos.
// Writer real envuelto: el retardo vive dentro del job ya encolado (`after`), así que
// el FIFO por ruta se respeta y el corte no puede dar el archivado por terminado antes.
test('el corte espera a que los metadatos estén escritos antes de resolver', async t => {
  const dir = await ownDir(t);
  const base = createJsonWriter();
  const slowMeta = (file, data, opts = {}) => String(file).endsWith('.meta.json')
    ? base(file, data, { ...opts, after: Promise.resolve(opts.after).then(() => new Promise(r => setTimeout(r, 40))) })
    : base(file, data, opts);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000, writer: slowMeta }).load();
  s.data.title = 'primero';
  await s.startNew('segundo');
  const metas = (await fsp.readdir(path.join(dir, 'sessions'))).filter(f => f.endsWith('.meta.json'));
  assert.equal(metas.length, 1, 'al resolver el corte el metadato ya existe, aunque el disco sea lento');
});

// #164: el meta es best-effort; si falla, el corte no falla y `list()` cae a la
// lectura completa del archivado (compatibilidad sin metadatos).
test('un fallo al escribir los metadatos no falla el corte ni el listado', async t => {
  const dir = await ownDir(t);
  const base = createJsonWriter();
  const metaFails = (file, data, opts = {}) => String(file).endsWith('.meta.json')
    ? Promise.reject(new Error('metadatos no disponibles'))
    : base(file, data, opts);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000, writer: metaFails }).load();
  s.data.title = 'primero';
  await s.startNew('segundo');
  const files = (await fsp.readdir(path.join(dir, 'sessions'))).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
  assert.equal(files.length, 1, 'el archivado completo existe aunque falten los metadatos');
  const out = await s.list();
  assert.equal(out.length, 1, 'el listado sigue viendo el archivado por su lectura completa');
  assert.equal(out[0].title, 'primero');
});

test('con la retención activada solo quedan las N sesiones archivadas configuradas', async t => {
  const dir = await ownDir(t);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000, maxArchived: 3 }).load();
  for (let i = 0; i < 5; i++) {
    s.data.events.push({ id: 'e' + i, type: 'follow', at: s.data.startedAt, user: 'u', vars: {} });
    await s.startNew('corte ' + i);
    // Ids distintos en milisegundos: el orden cronológico de archivados viene del id.
    await new Promise(r => setTimeout(r, 5));
  }
  const files = (await fsp.readdir(path.join(dir, 'sessions'))).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
  assert.equal(files.length, 3, 'solo quedan 3 archivados');
  const remaining = await s.list();
  // El corte i archiva la sesión anterior: los títulos conservados son corte 1..3
  // (el primero archivado llevaba el título por defecto).
  assert.deepEqual(remaining.map(r => r.title).sort(), ['corte 1', 'corte 2', 'corte 3'], 'sobreviven los más recientes');
  // Sin huérfanos: los metadatos de los borrados se retiraron también.
  const metas = (await fsp.readdir(path.join(dir, 'sessions'))).filter(f => f.endsWith('.meta.json'));
  assert.equal(metas.length, 3, 'los metadatos de los archivados borrados no quedan huérfanos');
});

test('con la retención desactivada (por defecto) no se borra nada', async t => {
  const dir = await ownDir(t);
  const s = await new Session(dir, { debounceMs: 60000, maxWaitMs: 60000 }).load();
  for (let i = 0; i < 3; i++) {
    s.data.events.push({ id: 'e' + i, type: 'follow', at: s.data.startedAt, user: 'u', vars: {} });
    await s.startNew('corte ' + i);
  }
  const files = (await fsp.readdir(path.join(dir, 'sessions'))).filter(f => f.endsWith('.json') && !f.endsWith('.meta.json'));
  assert.equal(files.length, 3);
});

test('la configuración por defecto incluye la retención de archivados, desactivada', () => {
  assert.equal(DEFAULT_CONFIG.sessions.retention, 0);
});

// ---------- rutas HTTP ----------

async function startApp(t) {
  const dataDir = await ownDir(t, 'egdev-session-retention-api-');
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (p) => {
    const r = await fetch(base + p);
    const d = await r.json();
    if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status });
    return d;
  };
  t.after(() => new Promise(r => { app.timers.stop(); app.server.closeAllConnections(); app.server.close(r); }));
  return { app, call };
}

test('GET /api/session/events recorta limit por encima del tope y lo documenta', async t => {
  const { app, call } = await startApp(t);
  const at = app.session.data.startedAt;
  for (let i = 0; i < 1100; i++) app.session.data.events.push({ id: 'ev' + i, type: 'follow', at, user: 'u' + i, vars: {} });

  const out = await call('/api/session/events?limit=99999');
  assert.ok(!Array.isArray(out), 'la respuesta documenta el recorte');
  assert.equal(out.limit, 1000, 'el tope aplicado se expone en la respuesta');
  assert.equal(out.capped, true, 'se indica que se recortó');
  assert.equal(out.items.length, 1000);
  assert.equal(out.total, 1100, 'el total real de eventos se expone');

  const saneo = await call('/api/session/events?limit=5');
  assert.equal(saneo.limit, 5);
  assert.equal(saneo.capped, false);
  assert.equal(saneo.items.length, 5);

  const defecto = await call('/api/session/events');
  assert.equal(defecto.limit, 500, 'sin limit se aplica el valor por defecto documentado');
  assert.equal(defecto.capped, false);
});

test('GET /api/session/events recorta valores no positivos al defecto documentado', async t => {
  const { call } = await startApp(t);
  const out = await call('/api/session/events?limit=-3');
  assert.equal(out.limit, 500);
  assert.equal(out.capped, false);
});

test('GET /api/timeline con kinds respeta el mismo tope que sin filtrar', async t => {
  const { app, call } = await startApp(t);
  const at = app.session.data.startedAt;
  for (let i = 0; i < 320; i++) app.session.data.events.push({ id: 'ev' + i, type: 'follow', at, user: 'u' + i, vars: {} });

  const out = await call('/api/timeline?kinds=follow');
  assert.ok(out.items.length <= 300, 'el filtrado por kinds no devuelve la sesión entera');
  assert.equal(out.capped, true, 'se indica que hubo recorte');
  assert.equal(out.limit, 300);
});

test('GET /api/media expone el tamaño de cada archivo', async t => {
  const { app, call } = await startApp(t);
  await fsp.writeFile(path.join(app.mediaDir, 'synthetic.png'), Buffer.alloc(1234));
  const out = await call('/api/media');
  const item = out.find(m => m.name === 'synthetic.png');
  assert.equal(item.size, 1234, 'tamaño en bytes de cada archivo de media/');
});

test('createApp conecta la retención con la configuración', async t => {
  const { app } = await startApp(t);
  assert.equal(typeof app.session.retentionLimit, 'function');
  assert.equal(app.session.retentionLimit(), 0, 'por defecto, sin límite');
});
