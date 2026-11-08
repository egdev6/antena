// #106: esquema de configuración — validación al escribir (400 con campo y motivo)
// y saneo al cargar (aviso en el registro + valor por defecto, sin bloquear el arranque).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const bounded = async (work, ms, label) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { clearTimeout(timer); }
};
const tmp = () => mkdtemp(path.join(tmpdir(), 'egdev-schema-'));
const readJson = async f => JSON.parse(await readFile(f, 'utf8'));

// ---------- esquema (unidades) ----------
test('validatePatch: marca tipo, rango y enum inválidos con su ruta', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  const errores = validatePatch({ overlay: { queueMax: -3 }, tts: { rate: 'rápido' }, chat: { sendTo: 'ambos' } });
  const rutas = errores.map(e => e.path);
  assert.ok(rutas.includes('overlay.queueMax'), JSON.stringify(errores));
  assert.ok(rutas.includes('tts.rate'), JSON.stringify(errores));
  assert.ok(rutas.includes('chat.sendTo'), JSON.stringify(errores));
  for (const e of errores) assert.ok(e.message && e.message.length > 3, 'cada error explica el motivo');
});

test('validatePatch: acepta una configuración válida y claves desconocidas', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  assert.deepEqual(validatePatch({ overlay: { volume: 0.8, queueMax: 0 }, tts: { rate: 0.5 }, prompter: { monitor: true } }), []);
  assert.deepEqual(validatePatch({ campoQueNoExisteTodavia: { x: 1 } }), []);
});

test('validatePath: valida el valor por ruta con puntos e índices', async () => {
  const { validatePath } = await import('../src/config-schema.mjs');
  assert.ok(validatePath('overlay.queueMax', -3).length > 0);
  assert.deepEqual(validatePath('overlay.queueMax', 20), []);
  assert.ok(validatePath('widgets.goals.0.bars.0.target', -1).length > 0);
  assert.deepEqual(validatePath('widgets.goals.0.bars.0.target', 50), []);
  assert.ok(validatePath('chat.sendTo', 'ambos').length > 0);
  // ruta desconocida (p. ej. prompter.monitor): se acepta
  assert.deepEqual(validatePath('prompter.monitor', true), []);
});

// ---------- carga con config.json inválido ----------
test('Store.load sanea campos inválidos con default y aviso, y conserva los válidos y las claves nuevas', async () => {
  const { Store } = await import('../src/store.mjs');
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      overlay: { queueMax: -3 }, tts: { rate: 'rápido' }, prompter: { monitor: true }, overlayViejo: 1,
    }));
    const avisos = [];
    const originalWarn = console.warn;
    console.warn = (...a) => avisos.push(a.join(' '));
    try {
      const s = await new Store(dir).load();
      assert.equal(s.config.overlay.queueMax, 20, 'default de queueMax');
      assert.equal(s.config.tts.rate, 1, 'default de rate');
      assert.equal(s.config.prompter.monitor, true, 'clave nueva se conserva');
      assert.equal(s.config.overlayViejo, 1, 'sección nueva se conserva');
      assert.equal(s.config.overlay.volume, 0.6, 'campo ausente queda con default');
    } finally { console.warn = originalWarn; }
    const texto = avisos.join('\n');
    assert.match(texto, /overlay\.queueMax/);
    assert.match(texto, /tts\.rate/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- HTTP ----------
async function fixture(t) {
  const root = await tmp();
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await Promise.all([dataDir, mediaDir].map(d => mkdir(d)));
  const configFile = path.join(dataDir, 'config.json');
  await writeFile(configFile, JSON.stringify({ port: 4619 }));
  process.env.ANTENA_DATA = dataDir;
  process.env.ANTENA_MEDIA = mediaDir;
  const { createApp } = await import('../src/server.mjs');
  const app = await createApp({ dataDir, mediaDir, log: () => {} });
  t.after(async () => {
    await bounded(app.closeHttp(), 2500, 'HTTP close');
    await rm(root, { recursive: true, force: true });
  });
  await bounded(new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  }), 2500, 'HTTP listen');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, configFile, base };
}

test('PUT /api/config rechaza tipo o rango inválido con 400, campo y motivo, sin guardar nada', async t => {
  const { app, configFile } = await fixture(t);
  const antes = await readFile(configFile, 'utf8');
  const intentos = [
    { overlay: { queueMax: -3 } },
    { tts: { rate: 'rápido' } },
    { chat: { sendTo: 'ambos' } },
  ];
  for (const body of intentos) {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
    const data = await r.json();
    assert.match(data.error, /:/, 'el mensaje nombra el campo');
    assert.ok(data.error.length > 10, 'el mensaje explica el motivo');
  }
  assert.equal(await readFile(configFile, 'utf8'), antes, 'config.json no cambia');
  assert.equal(app.store.config.overlay.queueMax, 20, 'memoria sin cambios');
});

test('POST /api/config/set rechaza un valor inválido por ruta con 400', async t => {
  const { app } = await fixture(t);
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/config/set`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'overlay.queueMax', value: -3 }), signal: AbortSignal.timeout(2500),
  });
  assert.equal(r.status, 400);
  const data = await r.json();
  assert.match(data.error, /overlay\.queueMax/);
  assert.equal(app.store.getPath('overlay.queueMax'), 20);
});

test('PUT acepta configuración válida y guarda claves desconocidas avisando una vez', async t => {
  const { app, configFile } = await fixture(t);
  const avisos = [];
  const originalWarn = console.warn;
  console.warn = (...a) => avisos.push(a.join(' '));
  try {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overlay: { volume: 0.8, queueMax: 5 }, prompter: { monitor: true } }),
      signal: AbortSignal.timeout(2500),
    });
    assert.equal(r.status, 200);
  } finally { console.warn = originalWarn; }
  const guardado = await readJson(configFile);
  assert.equal(guardado.overlay.volume, 0.8);
  assert.equal(guardado.overlay.queueMax, 5);
  assert.equal(guardado.prompter.monitor, true, 'flujo real: clave nueva guardada');
  const texto = avisos.join('\n');
  assert.match(texto, /prompter\.monitor/, 'aviso de campo desconocido en el registro');
  assert.equal(avisos.filter(a => /prompter\.monitor/.test(a)).length, 1, 'una sola vez por ruta');
});

// ---------- #118: hojas de alerts, commands, timers, shortcuts, interactive y filters ----------
test('#118: validatePatch marca hojas inválidas en las seis secciones con su ruta', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  const casos = {
    'alerts.follow.layout': { alerts: { follow: { layout: 'tarjeta' } } },
    'alerts.follow.durationMs': { alerts: { follow: { durationMs: 'lento' } } },
    'alerts.follow.actions.0.kind': { alerts: { follow: { actions: [{ kind: 'magia' }] } } },
    'alerts.follow.actions.0.destination': { alerts: { follow: { actions: [{ kind: 'chat', text: 'hola', destination: 'ambos' }] } } },
    'alerts.sub.text': { alerts: { sub: { text: 5 } } },
    'commands.0.permission': { commands: [{ trigger: '!x', permission: 'todos' }] },
    'commands.0.cooldownSec': { commands: [{ trigger: '!x', cooldownSec: -1 }] },
    'commands.0.platforms': { commands: [{ trigger: '!x', platforms: ['discord'] }] },
    'timers.0.intervalMin': { timers: [{ name: 't', message: 'm', intervalMin: -2 }] },
    'timers.0.destination': { timers: [{ name: 't', message: 'm', intervalMin: 5, destination: 'ambos' }] },
    'timers.0.announceColor': { timers: [{ name: 't', message: 'm', intervalMin: 5, announce: true, announceColor: 'rosa' }] },
    'shortcuts.0.steps.0.kind': { shortcuts: [{ id: 's1', name: 'S', steps: [{ kind: 'magia' }] }] },
    'shortcuts.0.name': { shortcuts: [{ id: 's1', name: 7, steps: [] }] },
    'interactive.questions.permission': { interactive: { questions: { permission: 'todos' } } },
    'interactive.questions.maxPerUser': { interactive: { questions: { maxPerUser: 0 } } },
    'interactive.giveaway.rollSeconds': { interactive: { giveaway: { rollSeconds: 0 } } },
    'interactive.tierlist.voteSeconds': { interactive: { tierlist: { voteSeconds: -5 } } },
    'filters.maxMessageLength': { filters: { maxMessageLength: -1 } },
    'filters.blockLinks': { filters: { blockLinks: 'sí' } },
    'filters.blockedWords': { filters: { blockedWords: ['a', 3] } },
  };
  for (const [ruta, parche] of Object.entries(casos)) {
    const errores = validatePatch(parche);
    assert.ok(errores.some(e => e.path === ruta), `${ruta} debe fallar; salió ${JSON.stringify(errores)}`);
    for (const e of errores) assert.ok(e.message.length > 10, 'cada error explica el motivo');
  }
});

test('#118: una configuración válida de las seis secciones pasa completa', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  const parche = {
    alerts: { follow: { title: '¡Hola!', durationMs: 4000, layout: 'media', animIn: 'slide', fontSize: 200, mediaSize: 300, textWidth: 200, actions: [{ kind: 'chat', text: 'gracias {user}' }, { kind: 'scene', scene: 'escena' }] }, sub: { variations: [{ name: 'tier 3', conditions: { tier: '3', chance: 100 }, actions: [{ kind: 'say', text: 'bien' }] }] } },
    commands: [{ trigger: '!hola', permission: 'vips', cooldownSec: 5, userCooldownSec: 0, platforms: ['twitch', 'youtube'], title: 'Hola' }],
    timers: [{ name: 'Promo', message: '¡hola!', intervalMin: 1, minChatLines: 0, announce: true, announceColor: 'blue', destination: 'both', showAlert: true }],
    shortcuts: [{ id: 's1', name: 'Escena y aviso', steps: [{ kind: 'builtin', action: 'pausa' }, { kind: 'say', text: 'vamos' }, { kind: 'builtin', action: 'prompter', arg: 'chat' }] }],
    interactive: { questions: { maxPerUser: 10, minLength: 0, maxLength: 500, permission: 'mods' }, tierlist: { voteSeconds: 0, acceptBare: true }, giveaway: { memberLuck: 3, rollSeconds: 20, permission: 'everyone' } },
    filters: { blockedWords: ['spoiler'], blockedUsers: ['bot'], maxMessageLength: 400, blockLinks: false },
  };
  assert.deepEqual(validatePatch(parche), []);
  // claves desconocidas dentro de las secciones: se aceptan
  assert.deepEqual(validatePatch({ commands: [{ trigger: '!x', campoNuevo: 1 }], timers: [{ mensajeRaro: true }] }), []);
});

test('#118: al cargar, la hoja inválida de un elemento de lista vuelve a su default y el elemento se conserva', async () => {
  const { Store } = await import('../src/store.mjs');
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({
      commands: [{ id: 'c1', trigger: '!hola', permission: 'todos', cooldownSec: 30, title: 'Mi comando' }],
      timers: [{ name: 'Promo', message: 'm', intervalMin: -2, enabled: true }],
      shortcuts: [{ id: 's1', name: 'S', steps: [{ kind: 'magia', action: 'pausa' }, { kind: 'say', text: 'hola' }] }],
      alerts: { follow: { title: 'Mi follow', durationMs: 'lento', actions: [{ kind: 'magia', text: 'hola' }] } },
      interactive: { questions: { maxPerUser: 0 } },
      filters: { blockLinks: 'sí', blockedWords: ['spoiler'] },
    }));
    const avisos = [];
    const originalWarn = console.warn;
    console.warn = (...a) => avisos.push(a.join(' '));
    let s;
    try {
      s = await new Store(dir).load();
    } finally { console.warn = originalWarn; }
    // la hoja vuelve a su default, el resto del elemento y la lista se conservan
    assert.equal(s.config.commands.length, 1, 'no se borra el comando');
    assert.equal(s.config.commands[0].permission, 'everyone');
    assert.equal(s.config.commands[0].cooldownSec, 30, 'las hojas válidas se conservan');
    assert.equal(s.config.commands[0].title, 'Mi comando');
    assert.equal(s.config.timers.length, 1, 'no se borra el timer');
    assert.equal(s.config.timers[0].intervalMin, 15, 'default de intervalMin');
    assert.equal(s.config.timers[0].message, 'm');
    assert.equal(s.config.shortcuts.length, 1, 'no se borra el atajo');
    assert.equal(s.config.shortcuts[0].steps.length, 2, 'no se borra ningún paso');
    // el kind es discriminador: un valor inválido se conserva tal cual, con aviso, para que el
    // motor siga fallando de forma inofensiva y no se convierta en otro kind con efecto en vivo
    assert.equal(s.config.shortcuts[0].steps[0].kind, 'magia');
    assert.equal(s.config.shortcuts[0].steps[0].action, 'pausa');
    assert.equal(s.config.alerts.follow.actions[0].kind, 'magia', 'el kind de acción inválido se conserva');
    assert.equal(s.config.alerts.follow.actions[0].text, 'hola');
    assert.equal(s.config.shortcuts[0].steps[1].text, 'hola');
    assert.equal(s.config.alerts.follow.durationMs, 5500, 'default de durationMs de follow');
    assert.equal(s.config.alerts.follow.title, 'Mi follow');
    assert.equal(s.config.interactive.questions.maxPerUser, 3, 'default de maxPerUser');
    assert.equal(s.config.filters.blockLinks, true);
    assert.deepEqual(s.config.filters.blockedWords, ['spoiler'], 'lo válido de la sección se conserva');
    const texto = avisos.join('\n');
    for (const ruta of ['commands.0.permission', 'timers.0.intervalMin', 'shortcuts.0.steps.0.kind', 'alerts.follow.durationMs', 'alerts.follow.actions.0.kind', 'interactive.questions.maxPerUser', 'filters.blockLinks'])
      assert.match(texto, new RegExp(ruta.replace(/\./g, '\\.')), `aviso de ${ruta}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#118: PUT /api/config rechaza hojas inválidas de cada sección con 400 sin guardar nada', async t => {
  const { app, configFile } = await fixture(t);
  const antes = await readFile(configFile, 'utf8');
  const intentos = [
    { alerts: { follow: { layout: 'tarjeta' } } },
    { commands: [{ trigger: '!x', permission: 'todos' }] },
    { timers: [{ name: 't', message: 'm', intervalMin: -2 }] },
    { shortcuts: [{ id: 's1', name: 'S', steps: [{ kind: 'magia' }] }] },
    { interactive: { questions: { permission: 'todos' } } },
    { filters: { maxMessageLength: -1 } },
  ];
  for (const body of intentos) {
    const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/config`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    });
    assert.equal(r.status, 400, JSON.stringify(body));
    const data = await r.json();
    assert.match(data.error, /:/, 'el mensaje nombra el campo');
  }
  assert.equal(await readFile(configFile, 'utf8'), antes, 'config.json no cambia');
  assert.equal(app.store.config.commands.length, 0, 'memoria sin cambios');
  assert.equal(app.store.config.timers.length, 0, 'memoria sin cambios');
  assert.equal(app.store.config.shortcuts.length, 0, 'memoria sin cambios');
});

test('command output mode and reply validate on every public write without partial changes', async t => {
  const { base } = await fixture(t);
  const request = async (method, endpoint, body) => {
    const response = await fetch(base + endpoint, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2500) });
    return { status: response.status, body: await response.json() };
  };
  const empty = (await request('GET', '/api/commands')).body;
  const invalidCreate = await request('POST', '/api/commands', { trigger: '!bad', outputMode: 'both' });
  assert.equal(invalidCreate.status, 400);
  assert.equal(invalidCreate.body.error, 'commands.0.outputMode: se esperaba uno de: alert, chat');
  assert.deepEqual((await request('GET', '/api/commands')).body, empty);

  const created = await request('POST', '/api/commands', { trigger: '!reply', outputMode: 'chat', chatReply: 'Hi {user}' });
  assert.equal(created.status, 200);
  assert.equal(created.body.command.outputMode, 'chat');
  assert.equal(created.body.command.chatReply, 'Hi {user}');
  const before = (await request('GET', '/api/commands')).body;
  const cases = [
    ['PUT', `/api/commands/${created.body.command.id}`, { outputMode: 'both' }, 'commands.0.outputMode: se esperaba uno de: alert, chat'],
    ['PUT', `/api/commands/${created.body.command.id}`, { chatReply: 42 }, 'commands.0.chatReply: se esperaba un texto'],
    ['PUT', '/api/config', { commands: [{ ...created.body.command, outputMode: 'both' }] }, 'commands.0.outputMode: se esperaba uno de: alert, chat'],
    ['POST', '/api/config/set', { path: 'commands.0.outputMode', value: 'both' }, 'commands.0.outputMode: se esperaba uno de: alert, chat'],
  ];
  for (const [method, endpoint, body, message] of cases) {
    const result = await request(method, endpoint, body);
    assert.equal(result.status, 400, `${method} ${endpoint}`);
    assert.equal(result.body.error, message);
    assert.deepEqual((await request('GET', '/api/commands')).body, before, 'rejection does not change stored commands');
  }
  const updated = await request('PUT', `/api/commands/${created.body.command.id}`, { outputMode: 'alert', chatReply: 'Updated' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.command.outputMode, 'alert');
  assert.equal(updated.body.command.chatReply, 'Updated');
});

// ---------- MCP ----------
test('El MCP devuelve el mensaje de validación en cambiar_config y fijar_valor', async t => {
  const { app } = await fixture(t);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp.mjs')], {
    env: { ...process.env, ANTENA_URL: base, ANTENA_NO_EMBED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', id = 0;
  const pending = new Map();
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
      } catch { /* fragmento */ }
    }
  });
  t.after(async () => {
    child.stdin.end();
    await bounded(new Promise(r => child.once('close', r)), 3000, 'MCP close');
    child.kill('SIGKILL');
  });
  const rpc = async (method, params) => {
    const requestId = ++id;
    const respuesta = new Promise(r => pending.set(requestId, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    return bounded(respuesta, 4000, `MCP ${method}`);
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'schema-test', version: '1' } });
  for (const tool of ['cambiar_config', 'fijar_valor']) {
    const args = tool === 'cambiar_config'
      ? { cambios: { overlay: { queueMax: -3 } } }
      : { ruta: 'tts.rate', valor: 'rápido' };
    const result = await rpc('tools/call', { name: tool, arguments: args });
    assert.equal(result.isError, true, `${tool} debe fallar con valor inválido`);
    const texto = result.content.map(c => c.text).join('\n');
    assert.ok(/overlay\.queueMax|tts\.rate/.test(texto), `el mensaje nombra el campo: ${texto}`);
  }
});
