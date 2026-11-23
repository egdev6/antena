// MCP real por stdio contra la API real: contrato de temas y confirmación sin efectos previos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

const ERROR = 'Error: Esta acción necesita confirmar: true. Pide confirmación a la persona antes de repetirla.';

test('MCP themes: metadata, duplicate, rename, activate, delete and generic-write protection', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-themes-mcp-'));
  let app, child, lines, closed, stderr = '';
  t.after(async () => {
    try {
      if (child) { child.stdin.end(); const [code, signal] = await closed; assert.equal(code, 0); assert.equal(signal, null); assert.equal(stderr, ''); lines.close(); }
      if (app) {
        app.interactive.quiesceVoteTimer(); await app.drainAutoSession(); await app.session.flush(); await app.interactive.flush();
        app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  app = await createApp({ dataDir: root, mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  child = spawn(process.execPath, ['src/mcp.mjs'], { env: { PATH: process.env.PATH, ANTENA_URL: base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  closed = once(child, 'close'); lines = createInterface({ input: child.stdout });
  let nextId = 0; const pending = new Map();
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  const rpc = (method, params = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const raw = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const call = async (name, args = {}) => { const result = await raw(name, args); assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const snapshot = async () => ({ bytes: await readFile(path.join(root, 'config.json'), 'utf8'),
    files: (await readdir(root)).filter(n => n === 'config.json' || n.startsWith('config.backup-')).sort(),
    persistence: (await fetch(base + '/api/status').then(r => r.json())).persistence });
  const tools = Object.fromEntries((await rpc('tools/list')).result.tools.map(tool => [tool.name, tool]));
  for (const name of ['listar_temas', 'duplicar_tema', 'renombrar_tema', 'activar_tema', 'borrar_tema', 'exportar_tema', 'importar_tema_guardado']) assert.ok(tools[name], name);
  assert.equal(tools.listar_temas.annotations.readOnlyHint, true);
  assert.match(tools.tema_de_partida.description, /único id disponible es plataforma/);
  assert.doesNotMatch(tools.tema_de_partida.description, /cian|esmeralda|cristal/i);
  assert.match(tools.restaurar_tema.description, /Color de cada plataforma/);
  for (const name of ['activar_tema', 'borrar_tema']) {
    assert.equal(tools[name].inputSchema.properties.confirmar.type, 'boolean');
    assert.ok(tools[name].inputSchema.required.includes('confirmar'));
    assert.equal(tools[name].annotations.destructiveHint, true);
  }
  assert.deepEqual((await call('listar_temas')).themes, [{ id: 'normal', name: 'Normal', active: true }]);
  assert.equal((await call('cambiar_tema', { cambios: { accent: '#123456' } })).theme.accent, '#123456');
  const beforePreset = await snapshot(), removed = await raw('tema_de_partida', { id: 'cian' });
  assert.equal(removed.isError, true); assert.match(removed.content[0].text, /No existe el punto de partida/);
  assert.deepEqual(await snapshot(), beforePreset);
  const platform = await call('tema_de_partida', { id: 'plataforma' });
  assert.equal(platform.theme.platformAccent, true); assert.equal(platform.theme.platformBadge, 'logo');
  const reset = await call('restaurar_tema');
  assert.equal(reset.theme.platformAccent, true); assert.equal(reset.theme.platformBadge, 'logo');
  const created = (await call('duplicar_tema', { id: 'normal', nombre: 'Navidad' })).theme;
  assert.equal(created.name, 'Navidad'); assert.equal(created.active, false);
  assert.equal((await call('renombrar_tema', { id: created.id, nombre: 'Invierno' })).theme.name, 'Invierno');
  assert.equal(tools.renombrar_tema.inputSchema.properties.color.type, 'string');
  assert.equal(tools.renombrar_tema.inputSchema.properties.imagen.type, 'string');
  assert.deepEqual(tools.renombrar_tema.inputSchema.required, ['id', 'nombre']);
  const upload = await fetch(base + '/api/media/upload?name=avatar.png', { method: 'POST', body: Buffer.from('imagen') });
  assert.equal(upload.status, 200); const { name: image } = await upload.json();
  assert.deepEqual((await call('renombrar_tema', { id: created.id, nombre: 'Invierno', color: '#123456' })).theme.avatar, { color: '#123456' });
  assert.deepEqual((await call('renombrar_tema', { id: created.id, nombre: 'Invierno', imagen: image })).theme.avatar, { color: '#123456', image });
  assert.deepEqual((await call('renombrar_tema', { id: created.id, nombre: 'Invierno', imagen: '' })).theme.avatar, { color: '#123456' });
  assert.equal(Object.hasOwn((await call('renombrar_tema', { id: created.id, nombre: 'Invierno', color: '' })).theme, 'avatar'), false);
  for (const [name, args] of [['activar_tema', { id: created.id }], ['borrar_tema', { id: created.id }]]) {
    for (const confirm of [{}, { confirmar: false }, { confirmar: 'true' }]) {
      const before = await snapshot();
      assert.deepEqual(await raw(name, { ...args, ...confirm }), { content: [{ type: 'text', text: ERROR }], isError: true });
      assert.deepEqual(await snapshot(), before);
    }
  }
  for (const [name, args] of [['cambiar_config', { cambios: { themes: { activeId: created.id } } }], ['fijar_valor', { ruta: 'themes.activeId', valor: created.id }]]) {
    const before = await snapshot(), result = await raw(name, args);
    assert.equal(result.isError, true); assert.match(result.content[0].text, /themes.*\/api\/themes/);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal((await call('activar_tema', { id: created.id, confirmar: true })).theme.active, true);
  assert.deepEqual((await call('listar_temas')).themes, [
    { id: 'normal', name: 'Normal', active: false }, { id: created.id, name: 'Invierno', active: true },
  ]);
  let before = await snapshot(), rejected = await raw('borrar_tema', { id: created.id, confirmar: true });
  assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /Activa otro tema antes de borrar este/);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await call('activar_tema', { id: 'normal', confirmar: true })).theme.active, true);
  assert.deepEqual((await call('borrar_tema', { id: created.id, confirmar: true })).themes, [{ id: 'normal', name: 'Normal', active: true }]);
  before = await snapshot(); rejected = await raw('activar_tema', { id: 'missing', confirmar: true });
  assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /No existe el tema/);
  assert.deepEqual(await snapshot(), before);
  const ruta = path.join(root, 'tema.zip');
  const exported = await call('exportar_tema', { id: 'normal', ruta });
  assert.equal(exported.ruta, ruta); assert.equal((await readFile(ruta)).readUInt32LE(0), 0x04034b50);
  before = await snapshot();
  const preview = await call('importar_tema_guardado', { ruta });
  assert.equal(preview.name, 'Normal'); assert.equal(preview.suggestedName, 'Normal (2)'); assert.deepEqual(await snapshot(), before);
  const imported = await call('importar_tema_guardado', { ruta, nombre: 'Desde MCP', confirmar: true });
  assert.equal(imported.theme.name, 'Desde MCP'); assert.equal(imported.theme.active, false);
  assert.equal((await call('listar_temas')).themes.find(item => item.active).id, 'normal');
  assert.equal(pending.size, 0);
});
