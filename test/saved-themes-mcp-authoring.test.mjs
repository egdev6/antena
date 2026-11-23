// MCP authoring exercises the real stdio protocol and HTTP API in isolated temporary storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-mcp-authoring-'));
  let app, child, lines, closed, stderr = '';
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups) await cleanup();
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
  let next = 0; const pending = new Map();
  lines.on('line', line => { const response = JSON.parse(line); pending.get(response.id)?.(response); pending.delete(response.id); });
  const rpc = (method, params = {}) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const raw = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const call = async (name, args = {}) => { const result = await raw(name, args); assert.ok(result, name); assert.equal(result.isError, undefined, JSON.stringify(result)); const text = result.content[0].text; try { return JSON.parse(text); } catch { return text; } };
  const http = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const config = async () => (await http('GET', '/api/config/export?format=json')).body.config;
  const live = async () => { const { themes, ...rest } = await config(); return JSON.stringify(rest); };
  const look = async id => (await config()).themes.saved.find(item => item.id === id)?.look;
  const backups = async () => (await readdir(root)).filter(name => name.startsWith('config.backup-')).sort();
  return { rpc, raw, call, http, config, live, look, backups, base, onClose: cleanup => cleanups.push(cleanup) };
}

async function stream(base, query) {
  const controller = new AbortController();
  const response = await fetch(base + '/api/stream?' + query, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
  let ready; const initial = new Promise(resolve => { ready = resolve; });
  const done = (async () => {
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          if (event) { events.push(event); if (event === 'theme') ready(); }
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  done.catch(() => {}); // The fixture owns the stream and observes errors on close.
  await initial;
  return { events, close: async () => { controller.abort(); await done; } };
}

const inactive = async f => {
  const r = await f.http('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' });
  assert.equal(r.status, 200); assert.equal(r.body.theme.active, false); return r.body.theme.id;
};

test('crear_tema creates inactive default and copied themes with validated avatars', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.call('cambiar_tema', { cambios: { accent: '#123456', platformAccent: false } });
  await f.call('editar_alerta', { tipo: 'follow', cambios: { title: 'Origen' } });
  const upload = await fetch(f.base + '/api/media/upload?name=avatar.png', { method: 'POST', body: Buffer.from('image') });
  assert.equal(upload.status, 200); const image = (await upload.json()).name;
  const before = await f.live();
  const fresh = (await f.call('crear_tema', { nombre: 'Desde cero', color: '#AABBCC', imagen: image })).theme;
  assert.equal(fresh.active, false); assert.deepEqual(fresh.avatar, { color: '#AABBCC', image });
  const defaults = await f.look(fresh.id);
  assert.equal(defaults.theme.platformAccent, true); assert.equal(defaults.theme.platformBadge, 'logo'); assert.notEqual(defaults.alerts.follow.title, 'Origen');
  const copied = (await f.call('crear_tema', { nombre: 'Copia', desde: 'normal', color: '#112233' })).theme;
  assert.equal(copied.active, false); assert.deepEqual(copied.avatar, { color: '#112233' });
  assert.equal((await f.look(copied.id)).theme.accent, '#123456'); assert.equal((await f.look(copied.id)).alerts.follow.title, 'Origen');
  const copiedInactive = (await f.call('crear_tema', { nombre: 'Copia del guardado', desde: fresh.id })).theme;
  assert.equal(copiedInactive.active, false); assert.equal(copiedInactive.avatar, undefined);
  assert.deepEqual(await f.look(copiedInactive.id), defaults);
  assert.equal(await f.live(), before);
  const snapshot = JSON.stringify(await f.config());
  for (const args of [{ nombre: 'Error', desde: 'ausente' }, { nombre: 'Error', color: 'rojo' }, { nombre: 'Error', imagen: 'missing.png' }]) {
    const result = await f.raw('crear_tema', args); assert.equal(result.isError, true); assert.equal(JSON.stringify(await f.config()), snapshot);
  }
  assert.equal((await f.call('listar_temas')).themes.find(x => x.active).id, 'normal');
});

test('every authoring family targets a saved look without changing live configuration or broadcasting overlays', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const variant = (await f.http('POST', '/api/widgets/chat/variants', { name: 'Extra' })).body.variant;
  const overlay = (await f.http('POST', '/api/custom-overlays', { name: 'Marco', css: '.base{}' })).body.overlay;
  const id = await inactive(f), before = await f.live();
  const overlayStream = await stream(f.base, 'client=overlay&themeInfo=1');
  const widgetStream = await stream(f.base, 'client=widget&themeInfo=1&customTheme=1');
  f.onClose(async () => { await overlayStream.close(); await widgetStream.close(); });
  await new Promise(resolve => setTimeout(resolve, 700)); overlayStream.events.length = 0; widgetStream.events.length = 0;
  await f.call('editar_alerta', { tipo: 'follow', cambios: { title: 'Invierno' }, tema: id });
  assert.equal((await f.call('ver_alerta', { tipo: 'follow', tema: id })).config.title, 'Invierno');
  const variation = (await f.call('crear_variacion', { tipo: 'follow', nombre: 'Frío', cambios: { text: 'nieve' }, tema: id })).variation;
  await f.call('editar_variacion', { tipo: 'follow', variacion: variation.id, cambios: { text: 'hielo' }, tema: id });
  await f.call('ordenar_variaciones', { tipo: 'follow', ids: [variation.id], tema: id });
  assert.equal((await f.call('ver_alerta', { tipo: 'follow', tema: id })).config.variations[0].overrides.text, 'hielo');
  await f.call('cambiar_tema', { cambios: { accent: '#ABCDEF' }, tema: id });
  assert.equal((await f.call('ver_tema', { tema: id })).theme.accent, '#ABCDEF');
  await f.call('css_global', { css: '.nieve{}', tema: id }); assert.equal(await f.call('css_global', { tema: id }), '.nieve{}');
  await f.call('editar_widget', { widget: 'chat', cambios: { fontSize: 32 }, tema: id });
  await f.call('editar_variante_chat', { id: variant.id, cambios: { fontSize: 33 }, tema: id });
  let widgets = await f.call('ver_widgets', { tema: id });
  assert.equal(widgets.config.chat.fontSize, 32); assert.equal(widgets.config.chatVariants[0].fontSize, 33);
  const goal = (await f.call('crear_objetivo', { titulo: 'Meta nieve', metrica: 'follows', meta: 35, id: 'nieve', tema: id })).goal;
  const bar = (await f.call('crear_barra', { id: goal.id, plataforma: 'youtube', metrica: 'subscribers', meta: 50, tema: id })).bar;
  await f.call('editar_barra', { id: goal.id, barra: bar.id, meta: 60, tema: id });
  await f.call('editar_objetivo', { id: goal.id, titulo: 'Meta hielo', tema: id });
  widgets = await f.call('ver_widgets', { tema: id });
  assert.equal(widgets.config.goals.find(x => x.id === goal.id).title, 'Meta hielo');
  assert.equal(widgets.config.goals.find(x => x.id === goal.id).bars.find(x => x.id === bar.id).target, 60);
  const command = (await f.call('crear_comando', { comando: { trigger: '!nieve' }, tema: id })).command;
  await f.call('editar_comando', { id: command.id, cambios: { title: 'Comando invierno' }, tema: id });
  assert.equal((await f.call('listar_comandos', { tema: id })).find(x => x.id === command.id).title, 'Comando invierno');
  const timer = (await f.call('crear_mensaje', { mensaje: { name: 'Invierno', message: 'Hola', intervalMin: 15 }, tema: id })).timer;
  await f.call('editar_mensaje', { id: timer.id, cambios: { message: 'Nieve', intervalMin: 20 }, tema: id });
  assert.equal((await f.call('listar_mensajes', { tema: id })).find(x => x.id === timer.id).message, 'Nieve');
  await f.call('configurar_interactivos', { cambios: { questions: { css: '.invierno{}' } }, tema: id });
  assert.equal((await f.call('estado_interactivos', { tema: id })).config.questions.css, '.invierno{}');
  await f.call('css_overlay_tema', { id: overlay.id, css: '.marco{}', tema: id });
  assert.equal(await f.call('css_overlay_tema', { id: overlay.id, tema: id }), '.marco{}');
  await f.call('cambiar_config', { cambios: { overlay: { gapMs: 777 } }, tema: id });
  await f.call('fijar_valor', { ruta: 'overlay.volume', valor: 0.4, tema: id });
  assert.equal((await f.call('ver_config', { ruta: 'overlay.volume', tema: id })).value, 0.4);
  await f.call('borrar_valor', { ruta: 'overlay.volume', tema: id, confirmar: true });
  assert.equal((await f.call('ver_config', { ruta: 'overlay.gapMs', tema: id })).value, 777);
  assert.equal(await f.live(), before); assert.equal((await f.call('listar_temas')).themes.find(x => x.active).id, 'normal');
  const saved = await f.look(id); assert.equal(saved.customOverlayCss[overlay.id], '.marco{}');
  await f.call('borrar_variacion', { tipo: 'follow', variacion: variation.id, tema: id, confirmar: true });
  assert.deepEqual((await f.call('ver_alerta', { tipo: 'follow', tema: id })).config.variations, []);
  await f.call('borrar_barra', { id: goal.id, barra: bar.id, tema: id, confirmar: true });
  await f.call('borrar_objetivo', { id: goal.id, tema: id, confirmar: true });
  await f.call('borrar_comando', { id: command.id, tema: id, confirmar: true });
  await f.call('borrar_mensaje', { id: timer.id, tema: id, confirmar: true });
  assert.ok(!(await f.call('ver_widgets', { tema: id })).config.goals.some(x => x.id === goal.id));
  assert.ok(!(await f.call('listar_comandos', { tema: id })).some(x => x.id === command.id));
  assert.ok(!(await f.call('listar_mensajes', { tema: id })).some(x => x.id === timer.id));
  await f.call('restaurar_alerta', { tipo: 'follow', tema: id, confirmar: true });
  assert.notEqual((await f.call('ver_alerta', { tipo: 'follow', tema: id })).config.title, 'Invierno');
  await f.call('tema_de_partida', { id: 'plataforma', tema: id });
  assert.equal((await f.call('ver_tema', { tema: id })).theme.platformAccent, true);
  await f.call('cambiar_tema', { cambios: { platformAccent: false }, tema: id });
  await f.call('restaurar_tema', { tema: id });
  assert.equal((await f.call('ver_tema', { tema: id })).theme.platformAccent, true);
  assert.equal(await f.live(), before);
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.deepEqual(overlayStream.events, []); assert.deepEqual(widgetStream.events, []);
  assert.equal((await f.call('activar_tema', { id, confirmar: true })).theme.active, true);
  assert.equal((await f.call('ver_widgets')).config.chat.fontSize, 32);
  assert.equal((await f.call('estado_interactivos')).config.questions.css, '.invierno{}');
  assert.equal(await f.call('css_global'), '.nieve{}');
  assert.equal(await f.call('css_overlay_tema', { id: overlay.id }), '.marco{}');
});

test('invalid inactive looks fail before persistence, remain activatable, and active alert edits keep legacy behavior', { timeout: 30000 }, async t => {
  const f = await fixture(t), id = await inactive(f);
  const error = 'alerts.follow.durationMs: el valor mínimo es 0';
  const config = JSON.stringify(await f.config()), live = await f.live(), look = JSON.stringify(await f.look(id));
  const counters = (await f.http('GET', '/api/widgets')).body.goals;
  const persistence = (await f.http('GET', '/api/status')).body.persistence;
  const rejected = await f.raw('editar_alerta', { tipo: 'follow', cambios: { durationMs: -1 }, tema: id });
  assert.deepEqual(rejected, { content: [{ type: 'text', text: 'Error: ' + error }], isError: true });
  assert.deepEqual(await f.http('PUT', '/api/alerts/follow', { durationMs: -1 }, { 'x-antena-target-theme': id }), { status: 400, body: { error } });
  assert.equal(JSON.stringify(await f.config()), config); assert.equal(await f.live(), live); assert.equal(JSON.stringify(await f.look(id)), look);
  assert.deepEqual((await f.http('GET', '/api/widgets')).body.goals, counters);
  assert.deepEqual((await f.http('GET', '/api/status')).body.persistence, persistence);
  assert.equal((await f.call('activar_tema', { id, confirmar: true })).theme.active, true);
  const active = await f.raw('editar_alerta', { tipo: 'follow', cambios: { durationMs: -1 } });
  assert.equal(active.isError, undefined); assert.equal(JSON.parse(active.content[0].text).config.durationMs, -1);
  assert.deepEqual(await f.raw('editar_alerta', { tipo: 'follow', cambios: { durationMs: -1 }, tema: id }), active);
  assert.equal((await f.call('ver_alerta', { tipo: 'follow' })).config.durationMs, -1);
  const http = await f.http('PUT', '/api/alerts/follow', { durationMs: -1 });
  assert.equal(http.status, 200); assert.equal(http.body.config.durationMs, -1);
});

test('target errors match active validation and reject unknown themes and non-themed paths without effects', { timeout: 30000 }, async t => {
  const f = await fixture(t), id = await inactive(f);
  const snapshot = JSON.stringify(await f.config()), live = await f.live();
  const counters = (await f.http('GET', '/api/widgets')).body.goals;
  const persistence = (await f.http('GET', '/api/status')).body.persistence;
  for (const [tool, args] of [
    ['cambiar_tema', { cambios: { textScale: 999999 } }],
    ['editar_widget', { widget: 'chat', cambios: { layout: 'otro' } }],
    ['crear_objetivo', { titulo: 'Error', metrica: 'desconocida', meta: 3 }],
    ['crear_mensaje', { mensaje: { message: 'Hola', destination: 'otro' } }],
  ]) {
    const active = await f.raw(tool, args), target = await f.raw(tool, { ...args, tema: id });
    assert.equal(active.isError, true, tool); assert.deepEqual(target, active, tool);
    assert.equal(JSON.stringify(await f.config()), snapshot, tool);
  }
  for (const [tool, args] of [
    ['editar_alerta', { tipo: 'follow', cambios: { title: 'No' } }],
    ['crear_variacion', { tipo: 'follow' }], ['cambiar_tema', { cambios: { accent: '#123456' } }],
    ['css_global', { css: '.no{}' }], ['editar_widget', { widget: 'chat', cambios: { fontSize: 30 } }],
    ['editar_variante_chat', { id: 'no', cambios: { fontSize: 30 } }],
    ['crear_objetivo', { titulo: 'No', metrica: 'follows', meta: 10 }],
    ['crear_barra', { id: 'principal', plataforma: 'twitch', metrica: 'follows', meta: 10 }],
    ['crear_comando', { comando: { trigger: '!no' } }], ['crear_mensaje', { mensaje: { message: 'no' } }],
    ['configurar_interactivos', { cambios: { questions: { css: '.no{}' } } }],
    ['css_overlay_tema', { id: 'marco', css: '.no{}' }],
    ['cambiar_config', { cambios: { overlay: { css: '.no{}' } } }],
    ['fijar_valor', { ruta: 'overlay.css', valor: '.no{}' }], ['borrar_valor', { ruta: 'overlay.css', confirmar: true }],
    ['ver_alerta', { tipo: 'follow' }], ['ver_widgets', {}], ['listar_comandos', {}],
  ]) {
    const missing = await f.raw(tool, { ...args, tema: 'ausente' });
    assert.equal(missing.isError, true, tool); assert.equal(missing.content[0].text, 'Error: No existe el tema «ausente»', tool);
  }
  assert.deepEqual(await f.http('PUT', '/api/alerts/follow', { title: 'No' }, { 'x-antena-target-theme': 'ausente' }), { status: 404, body: { error: 'No existe el tema «ausente»' } });
  for (const [tool, args] of [['cambiar_config', { cambios: { panel: { onboardingDone: true } } }], ['fijar_valor', { ruta: 'port', valor: 9999 }]]) {
    const result = await f.raw(tool, { ...args, tema: id }); assert.equal(result.isError, true, tool);
  }
  assert.equal(JSON.stringify(await f.config()), snapshot); assert.equal(await f.live(), live);
  assert.deepEqual((await f.http('GET', '/api/widgets')).body.goals, counters);
  assert.deepEqual((await f.http('GET', '/api/status')).body.persistence, persistence);
});

test('the active id preserves existing calls and legacy importar_tema payload', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const command = (await f.call('crear_comando', { comando: { trigger: '!activo' } })).command;
  const timer = (await f.call('crear_mensaje', { mensaje: { message: 'Activo', intervalMin: 15 } })).timer;
  for (const [name, args] of [
    ['editar_comando', { id: command.id, cambios: { title: 'Activo' } }],
    ['editar_mensaje', { id: timer.id, cambios: { message: 'Activo' } }],
    ['cambiar_config', { cambios: { overlay: { gapMs: 701 } } }],
    ['fijar_valor', { ruta: 'overlay.volume', valor: 0.4 }],
    ['editar_alerta', { tipo: 'follow', cambios: { title: 'Activo' } }],
    ['cambiar_tema', { cambios: { accent: '#123456' } }],
    ['editar_widget', { widget: 'chat', cambios: { fontSize: 31 } }],
    ['editar_objetivo', { id: 'principal', titulo: 'Meta activa' }],
    ['configurar_interactivos', { cambios: { questions: { css: '.activo{}' } } }],
    ['css_global', { css: '.activo{}' }],
  ]) {
    const unqualified = await f.call(name, args), before = await f.live();
    assert.deepEqual(await f.call(name, { ...args, tema: 'normal' }), unqualified, name);
    assert.equal(await f.live(), before, name);
  }
  assert.equal((await f.call('importar_tema', { tema: { accent: '#234567' } })).theme.accent, '#234567');
  const id = await inactive(f), before = await f.live();
  assert.equal((await f.call('importar_tema', { tema: id, aspecto: { accent: '#345678' } })).theme.accent, '#345678');
  assert.equal((await f.look(id)).theme.accent, '#345678'); assert.equal(await f.live(), before);
});

test('importar_tema preserves the complete legacy wire shape with or without a saved-theme target', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const appearance = { accent: '#234567', textScale: 110, icons: { follow: 'emoji:❄' } };
  const legacyHttp = await f.http('POST', '/api/theme/import', { theme: appearance });
  assert.equal(legacyHttp.status, 200);
  const legacy = await f.raw('importar_tema', { tema: appearance });
  assert.equal(legacy.isError, undefined);
  assert.equal(legacy.content[0].text, JSON.stringify(legacyHttp.body, null, 2));
  const id = await inactive(f), before = await f.live();
  const target = await f.raw('importar_tema', { tema: id, aspecto: appearance });
  assert.equal(target.isError, undefined);
  assert.equal(target.content[0].text, legacy.content[0].text);
  assert.equal((await f.look(id)).theme.accent, '#234567'); assert.equal(await f.live(), before);
});

test('importar_tema with a theme id requires an appearance object and changes nothing otherwise', { timeout: 30000 }, async t => {
  const f = await fixture(t), id = await inactive(f);
  await f.call('cambiar_tema', { cambios: { accent: '#ABCDEF' }, tema: id });
  await f.call('cambiar_tema', { cambios: { accent: '#123456' } });
  const snapshot = JSON.stringify(await f.config()), backups = await f.backups();
  const counters = (await f.http('GET', '/api/widgets')).body.goals;
  const persistence = (await f.http('GET', '/api/status')).body.persistence;
  for (const tema of [id, 'normal', 'ausente']) for (const aspecto of [undefined, null, [], 1, false, 'texto']) {
    const result = await f.raw('importar_tema', { tema, ...(aspecto !== undefined && { aspecto }) });
    assert.deepEqual(result, { content: [{ type: 'text', text: 'Error: El tema tiene que ser un objeto' }], isError: true }, `${tema} ${JSON.stringify(aspecto)}`);
    assert.equal(JSON.stringify(await f.config()), snapshot); assert.deepEqual(await f.backups(), backups);
    assert.deepEqual((await f.http('GET', '/api/widgets')).body.goals, counters);
    assert.deepEqual((await f.http('GET', '/api/status')).body.persistence, persistence);
  }
  const tools = Object.fromEntries((await f.rpc('tools/list')).result.tools.map(tool => [tool.name, tool]));
  assert.equal(tools.importar_tema.inputSchema.properties.tema.anyOf[0].description, 'El objeto del tema');
});

test('targeted edits preserve existing backup files even after more than ten writes', { timeout: 30000 }, async t => {
  const f = await fixture(t), id = await inactive(f);
  assert.equal((await f.http('POST', `/api/themes/${id}/activate`, {})).status, 200);
  assert.equal((await f.http('POST', '/api/themes/normal/activate', {})).status, 200);
  const backups = await f.backups(), before = await f.live();
  assert.equal(backups.length, 2);
  for (let i = 0; i < 12; i++) {
    const title = `Edición ${i}`;
    assert.equal((await f.call('editar_alerta', { tipo: 'follow', cambios: { title }, tema: id })).config.title, title);
    assert.equal((await f.look(id)).alerts.follow.title, title);
    assert.deepEqual(await f.backups(), backups);
    assert.equal(await f.live(), before);
  }
});

test('inactive timer reads, edits and deletion leave the active scheduler counters unchanged', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const timer = (await f.call('crear_mensaje', { mensaje: { name: 'Activo', message: 'hola', intervalMin: 15 } })).timer;
  await f.call('simular_chat', { usuario: 'viewer', texto: 'hola' });
  const runtime = (await f.call('listar_mensajes')).find(x => x.id === timer.id).runtime;
  assert.equal(runtime.lines, 1);
  const id = await inactive(f), before = await f.live();
  assert.equal((await f.call('listar_mensajes', { tema: id })).find(x => x.id === timer.id).runtime.lines, 0);
  await f.call('editar_mensaje', { id: timer.id, cambios: { intervalMin: 25 }, tema: id });
  await f.call('borrar_mensaje', { id: timer.id, tema: id, confirmar: true });
  const after = (await f.call('listar_mensajes')).find(x => x.id === timer.id).runtime;
  assert.equal(after.lines, runtime.lines); assert.equal(after.runs, runtime.runs); assert.equal(after.lastRunAt, runtime.lastRunAt);
  assert.equal(await f.live(), before);
});

test('inactive appearance edits do not discard the active appearance draft', { timeout: 30000 }, async t => {
  const f = await fixture(t), id = await inactive(f);
  assert.equal((await f.http('PUT', '/api/theme/draft', { accent: '#ABCDEF' })).status, 200);
  const before = await fetch(f.base + '/theme.css?draft=1').then(r => r.text());
  assert.match(before, /#ABCDEF/i);
  await f.call('cambiar_tema', { cambios: { accent: '#123456' }, tema: id });
  assert.equal(await fetch(f.base + '/theme.css?draft=1').then(r => r.text()), before);
});

test('concurrent edits cannot lose a successful saved-look update or change live state', { timeout: 30000 }, async t => {
  const f = await fixture(t), id = await inactive(f), before = await f.live();
  const headers = { 'x-antena-target-theme': id };
  const writes = await Promise.all([
    f.http('PUT', '/api/alerts/follow', { title: 'Concurrente' }, headers),
    f.http('PUT', '/api/theme', { accent: '#987654' }, headers),
  ]);
  for (const result of writes) assert.ok([200, 409].includes(result.status), JSON.stringify(result));
  assert.ok(writes.some(result => result.status === 200));
  const saved = await f.look(id);
  assert.equal(saved.alerts.follow.title === 'Concurrente', writes[0].status === 200);
  assert.equal(saved.theme.accent === '#987654', writes[1].status === 200);
  assert.equal(await f.live(), before);
});

test('a targeted write racing activation of the same theme is kept or refused, never lost', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const id = await inactive(f);
    const [w, activation] = await Promise.all([f.http('PUT', '/api/alerts/follow', { title: 'W' + i }, { 'x-antena-target-theme': id }), f.http('POST', `/api/themes/${id}/activate`, {})]);
    assert.ok([200, 409].includes(activation.status));
    const c = await f.config(), title = c.themes.activeId === id ? c.alerts.follow.title : c.themes.saved.find(x => x.id === id).look.alerts.follow.title;
    assert.ok([200, 409].includes(w.status)); assert.equal(title === 'W' + i, w.status === 200);
    assert.equal((await f.http('POST', '/api/themes/normal/activate', {})).status, 200);
    assert.equal((await f.http('DELETE', `/api/themes/${id}`)).status, 200);
  }
});

test('MCP advertises and returns the Spanish disenar_tema prompt and target schemas', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const init = (await f.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
  assert.deepEqual(init.capabilities.prompts, { listChanged: false });
  const prompts = (await f.rpc('prompts/list')).result.prompts;
  assert.ok(prompts.some(p => p.name === 'disenar_tema'));
  const prompt = (await f.rpc('prompts/get', { name: 'disenar_tema' })).result;
  const text = prompt.messages.map(m => m.content.text).join('\n');
  for (const word of ['nombre', 'avatar', 'color', 'tipografía', 'alert', 'sonido', 'importar_archivo', 'widget', 'CSS', 'crear_tema', 'tema', 'previewTheme', 'activar']) assert.ok(text.toLowerCase().includes(word.toLowerCase()), word);
  assert.equal((await f.rpc('prompts/get', { name: 'desconocido' })).error.code, -32602);
  const tools = Object.fromEntries((await f.rpc('tools/list')).result.tools.map(tool => [tool.name, tool]));
  for (const name of ['ver_config', 'cambiar_config', 'fijar_valor', 'borrar_valor', 'listar_alertas', 'ver_alerta', 'editar_alerta', 'restaurar_alerta', 'crear_variacion', 'editar_variacion', 'borrar_variacion', 'ordenar_variaciones', 'ver_tema', 'cambiar_tema', 'tema_de_partida', 'restaurar_tema', 'importar_tema', 'css_global', 'ver_widgets', 'editar_widget', 'editar_variante_chat', 'crear_objetivo', 'editar_objetivo', 'borrar_objetivo', 'crear_barra', 'editar_barra', 'borrar_barra', 'listar_comandos', 'crear_comando', 'editar_comando', 'borrar_comando', 'listar_mensajes', 'crear_mensaje', 'editar_mensaje', 'borrar_mensaje', 'estado_interactivos', 'configurar_interactivos', 'css_overlay_tema']) {
    assert.ok(tools[name].inputSchema.properties.tema, name); assert.match(tools[name].description, /tema/i, name);
  }
  for (const name of ['sumar_objetivo', 'fijar_objetivo', 'sumar_barra', 'fijar_barra']) assert.equal(tools[name].inputSchema.properties.tema, undefined, name);
});
