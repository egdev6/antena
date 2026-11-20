// #276: paquete de entrevista (formato v1), API /api/interviews y media jpg/jpeg.
// Todo por la API HTTP pública de la app real; nada toca el almacenamiento interno.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VALID = JSON.parse(await readFile(path.join(HERE, 'fixtures', 'interviews', 'valid.json'), 'utf8'));
const clone = x => structuredClone(x);

async function start(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-interviews-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const raw = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  return { app, base, raw, dataDir };
}

test('importar un paquete válido lo guarda y GET lo devuelve igual', async t => {
  const { raw } = await start(t);
  const res = await raw('POST', '/api/interviews/import', VALID);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interview, VALID);
  const got = await raw('GET', '/api/interviews/ana-garcia-ia');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body.interview, VALID);
  const list = await raw('GET', '/api/interviews');
  assert.equal(list.status, 200);
  assert.equal(list.body.interviews.length, 1);
  assert.equal(list.body.interviews[0].id, 'ana-garcia-ia');
  assert.equal(list.body.interviews[0].title, VALID.title);
  assert.equal(list.body.activeId, '');
});

test('un paquete válido sin ids recibe ids y conserva el resto igual', async t => {
  const { raw } = await start(t);
  const pack = { version: 1, title: 'Sin ids', guest: { name: 'Invitado' }, rounds: [{ title: 'R1', items: [{ question: '¿Hola?', aprobado: true }] }] };
  const res = await raw('POST', '/api/interviews/import', pack);
  assert.equal(res.status, 200);
  const iv = res.body.interview;
  assert.match(iv.id, /^[a-z0-9-]{1,40}$/);
  assert.match(iv.rounds[0].id, /^[a-z0-9-]{1,40}$/);
  assert.match(iv.rounds[0].items[0].id, /^[a-z0-9-]{1,40}$/);
  const { id, ...rest } = iv;
  rest.rounds[0] = { title: 'R1', items: [{ question: '¿Hola?', aprobado: true }] };
  assert.deepEqual(rest, pack);
});

test('los paquetes inválidos se rechazan con un error claro y sin cambiar lo guardado', async t => {
  const { raw } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  const before = (await raw('GET', '/api/interviews/ana-garcia-ia')).body;
  const beforeList = (await raw('GET', '/api/interviews')).body;

  const mut = fn => { const p = clone(VALID); p.id = 'otra'; fn(p); return p; };
  const cases = [
    ['sin version', mut(p => { delete p.version; }), /version/],
    ['version futura', mut(p => { p.version = 2; }), /version/],
    ['sin título', mut(p => { delete p.title; }), /title/],
    ['título vacío', mut(p => { p.title = '   '; }), /title/],
    ['título demasiado largo', mut(p => { p.title = 'x'.repeat(121); }), /title/],
    ['sin invitado', mut(p => { delete p.guest; }), /guest/],
    ['clave desconocida', mut(p => { p.extra = 1; }), /extra/],
    ['pregunta demasiado larga', mut(p => { p.rounds[0].items[0].question = 'x'.repeat(501); }), /question/],
    ['notas demasiado largas', mut(p => { p.rounds[0].items[0].notes = 'x'.repeat(2001); }), /notes/],
    ['aprobado no booleano', mut(p => { p.rounds[0].items[0].aprobado = 'sí'; }), /aprobado/],
    ['aprobado ausente', mut(p => { delete p.rounds[0].items[0].aprobado; }), /aprobado/],
    ['media con ruta absoluta', mut(p => { p.rounds[0].items[0].media.file = '/etc/passwd.jpg'; }), /media/],
    ['media con ..', mut(p => { p.rounds[0].items[0].media.file = '../secreto.png'; }), /media/],
    ['media con subcarpeta', mut(p => { p.rounds[0].items[0].media.file = 'sub/foto.png'; }), /media/],
    ['media con barra invertida', mut(p => { p.rounds[0].items[0].media.file = '..\\foto.png'; }), /media/],
    ['media con unidad de Windows', mut(p => { p.rounds[0].items[0].media.file = 'C:foto.png'; }), /media/],
    ['imagen que no es imagen', mut(p => { p.rounds[0].items[0].media.file = 'demo.mp4'; }), /media/],
    ['video que no es vídeo', mut(p => { p.rounds[0].items[1].media.file = 'foto.png'; }), /media/],
    ['tipo de media desconocido', mut(p => { p.rounds[0].items[0].media.type = 'gif'; }), /media/],
    ['youtube http', mut(p => { p.rounds[1].items[0].media.url = 'http://www.youtube.com/watch?v=x'; }), /https/],
    ['youtube de otro dominio', mut(p => { p.rounds[1].items[0].media.url = 'https://evil.example/watch?v=x'; }), /youtube/i],
    ['youtube javascript:', mut(p => { p.rounds[1].items[0].media.url = 'javascript:alert(1)'; }), /https/],
    ['youtube minuto negativo', mut(p => { p.rounds[1].items[0].media.startMinute = -1; }), /startMinute/],
    ['youtube minuto no entero', mut(p => { p.rounds[1].items[0].media.startMinute = 1.5; }), /startMinute/],
    ['fuente http', mut(p => { p.rounds[0].items[0].source.url = 'http://example.com/x'; }), /https/],
    ['fuente con credenciales', mut(p => { p.rounds[0].items[0].source.url = 'https://user:pw@example.com/x'; }), /url/],
    ['fecha de fuente inválida', mut(p => { p.rounds[0].items[0].source.date = '2026-13-45'; }), /date/],
    ['post sin autor', mut(p => { delete p.rounds[1].items[1].media.author; }), /author/],
    ['post con enlace http', mut(p => { p.rounds[1].items[1].media.url = 'http://example.com/p'; }), /https/],
    ['post con texto enorme', mut(p => { p.rounds[1].items[1].media.text = 'x'.repeat(2001); }), /text/],
    ['ids de ítem repetidos', mut(p => { p.rounds[1].items[0].id = 'q1'; }), /q1/],
    ['id de entrevista inválido', mut(p => { p.id = 'Con Espacios'; }), /id/],
    ['demasiadas rondas', mut(p => { p.rounds = Array.from({ length: 21 }, (_, i) => ({ title: `R${i}`, items: [] })); }), /rounds/],
    ['cuerpo que no es objeto', [1, 2], /objeto/],
  ];
  for (const [name, pack, re] of cases) {
    const res = await raw('POST', '/api/interviews/import', pack);
    assert.equal(res.status, 400, name);
    assert.match(String(res.body.error), re, name);
  }
  // Nada cambió: ni la entrevista, ni el listado, ni se creó ninguna otra.
  assert.deepEqual((await raw('GET', '/api/interviews/ana-garcia-ia')).body, before);
  assert.deepEqual((await raw('GET', '/api/interviews')).body, beforeList);
});

test('importar un id ya guardado da 409 y no pisa lo guardado', async t => {
  const { raw } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  const other = clone(VALID); other.title = 'Otro título';
  const res = await raw('POST', '/api/interviews/import', other);
  assert.equal(res.status, 409);
  assert.equal((await raw('GET', '/api/interviews/ana-garcia-ia')).body.interview.title, VALID.title);
});

test('crear: título e invitado, rondas opcionales y mismas validaciones', async t => {
  const { raw } = await start(t);
  const ok = await raw('POST', '/api/interviews', { title: 'Nueva', guest: { name: 'Pepe' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.interview.version, 1);
  assert.deepEqual(ok.body.interview.rounds, []);
  const bad = await raw('POST', '/api/interviews', { title: 'Nueva', guest: { name: 'Pepe' }, rounds: [{ title: 'R', items: [{ question: 'q', aprobado: true, media: { type: 'image', file: '../x.png' } }] }] });
  assert.equal(bad.status, 400);
  assert.equal((await raw('GET', '/api/interviews')).body.interviews.length, 1);
});

test('editar: cambia solo lo enviado, valida el resultado y un rechazo no cambia nada', async t => {
  const { raw } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  const ok = await raw('PUT', '/api/interviews/ana-garcia-ia', { title: 'Título nuevo' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.interview.title, 'Título nuevo');
  assert.deepEqual(ok.body.interview.rounds, VALID.rounds);
  const before = (await raw('GET', '/api/interviews/ana-garcia-ia')).body;
  for (const patch of [{ title: '' }, { rounds: [{ title: 'R', items: [{ question: 'q', aprobado: 'x' }] }] }, { guest: { name: 5 } }, { version: 2 }, { id: 'otro' }]) {
    const res = await raw('PUT', '/api/interviews/ana-garcia-ia', patch);
    assert.equal(res.status, 400, JSON.stringify(patch));
  }
  assert.deepEqual((await raw('GET', '/api/interviews/ana-garcia-ia')).body, before);
  assert.equal((await raw('PUT', '/api/interviews/no-existe', { title: 'x' })).status, 404);
});

test('elegir activa: id inexistente 404; sin ítem se activa la entrevista', async t => {
  const { raw } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  assert.equal((await raw('POST', '/api/interviews/select', { id: 'no-existe' })).status, 404);
  assert.equal((await raw('GET', '/api/interviews')).body.activeId, '');
  const res = await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia' });
  assert.equal(res.status, 200);
  assert.equal(res.body.activeId, 'ana-garcia-ia');
  assert.equal(res.body.activeItemId, '');
});

test('los ítems con aprobado: false no se pueden activar y lo activo no cambia', async t => {
  const { raw } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia', itemId: 'q1' });
  const rejected = await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia', itemId: 'q4' });
  assert.equal(rejected.status, 409);
  assert.match(String(rejected.body.error), /aprobad/i);
  const state = (await raw('GET', '/api/interviews')).body;
  assert.equal(state.activeId, 'ana-garcia-ia');
  assert.equal(state.activeItemId, 'q1');
  assert.equal((await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia', itemId: 'no-existe' })).status, 404);
  assert.equal((await raw('GET', '/api/interviews')).body.activeItemId, 'q1');
});

test('desaprobar o quitar el ítem activo lo desactiva; borrar la entrevista activa limpia lo activo', async t => {
  const { raw } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia', itemId: 'q1' });
  const rounds = clone(VALID.rounds); rounds[0].items[0].aprobado = false;
  await raw('PUT', '/api/interviews/ana-garcia-ia', { rounds });
  const st = (await raw('GET', '/api/interviews')).body;
  assert.equal(st.activeId, 'ana-garcia-ia');
  assert.equal(st.activeItemId, '');
  await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia', itemId: 'q2' });
  const del = await raw('DELETE', '/api/interviews/ana-garcia-ia');
  assert.equal(del.status, 200);
  const after = (await raw('GET', '/api/interviews')).body;
  assert.deepEqual(after.interviews, []);
  assert.equal(after.activeId, '');
  assert.equal(after.activeItemId, '');
  assert.equal((await raw('GET', '/api/interviews/ana-garcia-ia')).status, 404);
  assert.equal((await raw('DELETE', '/api/interviews/ana-garcia-ia')).status, 404);
});

test('persistencia: lo importado y lo activo sobreviven a reiniciar la app', async t => {
  const { raw, app, dataDir } = await start(t);
  await raw('POST', '/api/interviews/import', VALID);
  await raw('POST', '/api/interviews/select', { id: 'ana-garcia-ia', itemId: 'q2' });
  const app2 = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} });
  await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { app2.teleprompter.stop(); app2.meld.stop(); app2.server.closeAllConnections(); app2.server.close(r); }));
  const base2 = `http://127.0.0.1:${app2.server.address().port}`;
  const list = await (await fetch(base2 + '/api/interviews')).json();
  assert.equal(list.activeId, 'ana-garcia-ia');
  assert.equal(list.activeItemId, 'q2');
  const iv = await (await fetch(base2 + '/api/interviews/ana-garcia-ia')).json();
  assert.deepEqual(iv.interview, VALID);
});

test('el texto del paquete es dato: se devuelve tal cual, sin interpretar', async t => {
  const { raw } = await start(t);
  const pack = clone(VALID); pack.id = 'xss'; pack.title = '<img src=x onerror=alert(1)>';
  pack.rounds[0].items[0].question = '<script>alert(1)</script> {{x}} ${y}';
  const res = await raw('POST', '/api/interviews/import', pack);
  assert.equal(res.status, 200);
  assert.equal(res.body.interview.title, pack.title);
  assert.equal(res.body.interview.rounds[0].items[0].question, pack.rounds[0].items[0].question);
});

test('media: jpg y jpeg se importan como imagen y la lista las clasifica', async t => {
  const { raw, base } = await start(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'egdev-interviews-src-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const ext of ['jpg', 'jpeg', 'JPG']) {
    const src = path.join(outside, `foto.${ext}`);
    await writeFile(src, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const res = await raw('POST', '/api/media/import', { path: src });
    assert.equal(res.status, 200, ext);
    const entry = res.body.media.find(m => m.name === res.body.name);
    assert.deepEqual({ kind: entry.kind }, { kind: 'image' }, ext);
    const served = await fetch(`${base}/media/${encodeURIComponent(res.body.name)}`);
    assert.equal(served.status, 200, ext);
    assert.equal(served.headers.get('content-type'), 'image/jpeg', ext);
  }
  // el mensaje de formato no admitido lista jpg/jpeg y se mantiene el rechazo de otros formatos
  const src = path.join(outside, 'texto.txt');
  await writeFile(src, 'x');
  const bad = await raw('POST', '/api/media/import', { path: src, name: 'texto.txt' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /jpg, jpeg/);
});

test('docs/entrevista-formato.md: el ejemplo completo es válido, igual al de pruebas y declara la versión', async t => {
  const { raw } = await start(t);
  const doc = await readFile(path.join(HERE, '..', 'docs', 'entrevista-formato.md'), 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(block, 'el documento tiene un ejemplo json');
  const example = JSON.parse(block[1]);
  assert.equal(example.version, 1);
  assert.deepEqual(example, VALID);
  const res = await raw('POST', '/api/interviews/import', example);
  assert.equal(res.status, 200);
  assert.match(doc, /`version`[^\n]*`1`/);
});

const unapprovedPack = () => ({ version: 1, id: 'sin-aprobar', title: 'T', guest: { name: 'G' }, rounds: [{ id: 'r1', title: 'R', items: [{ id: 'q1', question: '¿?', aprobado: false }] }] });

test('las escrituras genéricas de config no guardan paquetes ni activan ítems sin aprobar', async t => {
  const { raw } = await start(t);
  assert.equal((await raw('POST', '/api/interviews/import', unapprovedPack())).status, 200);
  const before = await raw('GET', '/api/interviews');
  const bad = { version: 1, items: [{ id: 'bad', title: 'x' }], activeId: '', activeItemId: '' };
  let res = await raw('PUT', '/api/config', { interviews: bad });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /\/api\/interviews/);
  assert.equal((await raw('GET', '/api/interviews/bad')).status, 404);
  for (const [p, value] of [['interviews.activeItemId', 'q1'], ['interviews.activeId', 'sin-aprobar'], ['interviews.items', []], ['interviews', bad]]) {
    res = await raw('POST', '/api/config/set', { path: p, value });
    assert.equal(res.status, 400, p);
    assert.match(res.body.error, /\/api\/interviews/, p);
  }
  assert.deepEqual((await raw('GET', '/api/interviews')).body, before.body);
  assert.deepEqual((await raw('GET', '/api/interviews/sin-aprobar')).body.interview, unapprovedPack());
});

test('una entrevista incompleta guardada a mano no rompe el listado y se limpia la activa', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-interviews-seed-'));
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ interviews: { version: 1, activeId: 'sin-aprobar', activeItemId: 'q1', items: [{ id: 'z', title: 't' }, unapprovedPack()] } }));
  const warn = console.warn; const warnings = [];
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  let app;
  try { app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} }); } finally { console.warn = warn; }
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise(r => { app.teleprompter.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(base + '/api/interviews');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.interviews.map(i => i.id), ['sin-aprobar']);
  assert.equal(body.activeItemId, '');
  assert.ok(warnings.some(w => w.includes('interviews')), warnings.join('\n'));
  assert.equal((await fetch(base + '/api/interviews/z')).status, 404);
});
