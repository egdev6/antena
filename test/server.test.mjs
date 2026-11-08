import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchChildOnFreePort } from './helpers/free-port.mjs';
import { spawn } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { launchSignalChild as launchNativeSignalChild, interruptSignalChild, windowsTimeout } from './helpers/signal-child.mjs';
import { HELD_RECOVERY_BLOCKED, withoutHeldRecoveryWarning } from './helpers/held-recovery-warning.mjs';

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;

// Puerto efímero real con reintento: `startServer` deriva el puerto de `PORT` (no acepta
// port:0), así que el hijo recibe uno libre de helpers/free-port.mjs, que además reintenta
// ante EADDRINUSE para eliminar la carrera de freePort (#78).

// Hijo que importa el `startServer` REAL (con sus handlers de señal de producción) y
// graba dominio por métodos públicos. El padre lo gobierna solo con señales y espera
// READY por stdout; nunca copia ni reimplementa el shutdown.
async function launchSignalChild({ dataDir, port, holdDrain = false }) {
  const program = `
    import { startServer } from ${JSON.stringify(SERVER_MODULE_URL)};
    const app = await startServer({ quiet: true, log: msg => console.log(String(msg)) });
    const s = app.session;
    // Campos públicos de planificación: el ctor futuro los lee, el baseline los ignora.
    s.debounceMs = 60000;
    s.maxWaitMs = 60000;
    s.record({ id: 'e1', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' });
    s.setThanked('e1', true);
    s.addNote({ kind: 'winner', user: 'bea', label: 'premio' });
    s.addToGoal('bits', 7);
    console.log('READY');
  `;
  // Claves construidas para no depender de tecleo: son los nombres exactos que lee src/store.mjs.
  const env = { ...process.env, ['ANT' + 'ENA_DATA']: dataDir, ['ANT' + 'ENA_MEDIA']: path.join(dataDir, 'media'), PORT: String(port) };
  // Sin contexto de runner hijo: el hijo es un proceso normal, no un worker de test.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  // Solo el control negativo retiene el drenaje real, antes de cualquier flush.
  const childProgram = process.platform === 'win32' && holdDrain ? `
    import { Engine as HeldEngine } from ${JSON.stringify(new URL('../src/engine.mjs', import.meta.url).href)};
    const realDrain = HeldEngine.prototype.drainActions;
    const held = new Promise(() => {});
    HeldEngine.prototype.drainActions = function(...args) {
      console.log('ENGINE-DRAIN-HELD');
      return held.then(() => realDrain.apply(this, args));
    };
  ` + program : program;
  const child = process.platform === 'win32'
    ? await launchNativeSignalChild(process.execPath, ['--input-type=module', '-e', childProgram, dataDir], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    : spawn(process.execPath, ['--input-type=module', '-e', childProgram, dataDir], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
  if (process.platform === 'win32') {
    child.stdin.on('error', () => {});
    child.stdin.end();
  }
  const graceful = signal => process.platform === 'win32'
    ? interruptSignalChild(child, 'SIGINT')
    : child.kill(signal);
  let out = '', err = '', ready = false, held = false;
  const waiters = [], heldWaiters = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => {
    out = (out + d).slice(0, 20000);
    if (!ready && out.includes('READY')) { ready = true; for (const w of waiters.splice(0)) w(); }
    if (!held && out.includes('ENGINE-DRAIN-HELD')) { held = true; for (const w of heldWaiters.splice(0)) w(); }
  });
  child.stderr.on('data', d => { err = (err + d).slice(0, 20000); });
  const exitInfo = new Promise(res => child.once('exit', (code, signal) => res({ code, signal })));
  const waitReady = async () => {
    while (!ready) {
      const res = await Promise.race([new Promise(w => waiters.push(w)), exitInfo]);
      if (res !== undefined) throw new Error(`el hijo salió antes de READY (code=${res.code}, signal=${res.signal}; stderr: ${err.slice(0, 400)})`);
    }
  };
  const waitHeld = async () => {
    if (held) return;
    const res = await Promise.race([new Promise(w => heldWaiters.push(w)), exitInfo]);
    if (res !== undefined) throw new Error(`el hijo salió antes de ENGINE-DRAIN-HELD (code=${res.code}, signal=${res.signal})`);
  };
  return { child, graceful, waitReady, waitHeld, exitInfo, stdout: () => out, stderr: () => err };
}

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, dataDir, close: () => new Promise(r => { app.server.closeAllConnections(); app.server.close(r); }) };
}

test('el overlay recibe por SSE las alertas de prueba y los eventos reales', async () => {
  const { app, base, close } = await start();
  try {
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/stream?client=overlay', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const nextAlert = async () => {
      while (!/event: alert\ndata: (.*)\n/.test(buf)) buf += dec.decode((await reader.read()).value);
      const m = buf.match(/event: alert\ndata: (.*)\n/);
      buf = buf.slice(buf.indexOf(m[0]) + m[0].length);
      return JSON.parse(m[1]);
    };

    const t = await (await fetch(base + '/api/test', { method: 'POST', body: JSON.stringify({ type: 'raid' }) })).json();
    assert.equal(t.overlays, 1);
    const a = await nextAlert();
    assert.equal(a.type, 'raid'); assert.equal(a.test, true); assert.match(a.sub, /120/);

    // evento real de Twitch (simulado) + duplicado
    app.twitch.emitEvent('m1', 'channel.follow', { user_name: 'Ana' });
    app.twitch.emitEvent('m1', 'channel.follow', { user_name: 'Ana' });
    const b = await nextAlert();
    assert.equal(b.text, 'Ana');
    assert.equal(app.bus.history.length, 1);

    // config: desactivar follow
    await fetch(base + '/api/config', { method: 'PUT', body: JSON.stringify({ alerts: { follow: { enabled: false } }, youtube: { apiKey: 'xxxxxxxxxxxx1234' } }) });
    app.twitch.emitEvent('m2', 'channel.follow', { user_name: 'Luis' });
    assert.equal(app.bus.history.length, 1);

    const st = await (await fetch(base + '/api/state')).json();
    assert.equal(st.config.youtube.apiKey, '••••1234');
    assert.equal(app.store.config.youtube.apiKey, 'xxxxxxxxxxxx1234');
    // reenviar la key enmascarada no la pisa
    await fetch(base + '/api/config', { method: 'PUT', body: JSON.stringify({ youtube: { apiKey: '••••1234' } }) });
    assert.equal(app.store.config.youtube.apiKey, 'xxxxxxxxxxxx1234');
    ctrl.abort();
  } finally { await close(); }
});

test('sirve el panel y el overlay, y bloquea rutas fuera de public', async () => {  const { base, close } = await start();
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.match(await (await fetch(base + '/overlay')).text(), /AntenaStream/);
    assert.equal((await fetch(base + '/..%2Fsrc%2Fserver.mjs')).status, 403);
  } finally { await close(); }
});

test('sube un vídeo, lo sirve por rangos y lo usa en el diseño «media»', async () => {
  const { base, close } = await start();
  try {
    const bytes = Buffer.alloc(5000, 7);
    const up = await (await fetch(base + '/api/media/upload?name=' + encodeURIComponent('nuevo seguidor.webm'), { method: 'POST', body: bytes })).json();
    assert.equal(up.name, 'nuevo seguidor.webm');
    assert.deepEqual(up.media.map(m => m.kind), ['video']);
    // mismo nombre → no pisa
    const up2 = await (await fetch(base + '/api/media/upload?name=nuevo%20seguidor.webm', { method: 'POST', body: bytes })).json();
    assert.equal(up2.name, 'nuevo seguidor-1.webm');
    // formato no admitido y rutas raras
    assert.equal((await fetch(base + '/api/media/upload?name=hack.exe', { method: 'POST', body: bytes })).status, 400);
    const trav = await (await fetch(base + '/api/media/upload?name=..%2F..%2Fx.png', { method: 'POST', body: bytes })).json();
    assert.equal(trav.name, 'x.png');

    const r = await fetch(base + '/media/nuevo%20seguidor.webm', { headers: { Range: 'bytes=100-199' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 100-199/5000');
    assert.equal((await r.arrayBuffer()).byteLength, 100);
    assert.equal(r.headers.get('content-type'), 'video/webm');

    await fetch(base + '/api/config', { method: 'PUT', body: JSON.stringify({ alerts: { follow: { layout: 'media', media: 'nuevo seguidor.webm', durationMode: 'media', textY: 80 } } }) });
    const st = await (await fetch(base + '/api/state')).json();
    assert.equal(st.config.alerts.follow.media, 'nuevo seguidor.webm');

    // la vista previa solo llega a los clientes «preview»
    const ctrl = new AbortController();
    const res = await fetch(base + '/api/stream?client=preview', { signal: ctrl.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    const t = await (await fetch(base + '/api/test', { method: 'POST', body: JSON.stringify({ type: 'follow', target: 'preview' }) })).json();
    assert.equal(t.overlays, 0);
    while (!/event: alert\ndata: (.*)\n/.test(buf)) buf += dec.decode((await reader.read()).value);
    const a = JSON.parse(buf.match(/event: alert\ndata: (.*)\n/)[1]);
    assert.equal(a.look.layout, 'media');
    assert.equal(a.look.mediaKind, 'video');
    assert.equal(a.look.textY, 80);
    ctrl.abort();

    // borrar
    const del = await (await fetch(base + '/api/media/delete', { method: 'POST', body: JSON.stringify({ name: 'nuevo seguidor-1.webm' }) })).json();
    assert.equal(del.media.length, 2);
  } finally { await close(); }
});

test('con la config inaccesible: PUT 500 seguro, pendiente visible y persistencia al reparar', async () => {
  const { app, base, dataDir, close } = await start();
  try {
    const blocker = path.join(dataDir, 'blocker');
    await writeFile(blocker, 'x');
    app.store.cfgFile = path.join(blocker, 'config.json');   // el padre es un fichero → ENOTDIR
    let changes = 0;
    app.store.on('change', () => changes++);
    const put = body => fetch(base + '/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body),
    });

    const bad = await put({ tts: { rate: 1.5 } });
    assert.equal(bad.status, 500);
    const badBody = await bad.json();
    assert.match(badBody.error, /No se pudo guardar la configuración/);
    assert.doesNotMatch(badBody.error, /ENOTDIR|blocker|config\.json/);
    assert.equal(changes, 0);
    assert.equal(app.store.config.tts.rate, 1.5);   // pendiente en memoria, no un rollback fingido
    assert.equal(app.store.persistenceState().dirty.config, true);

    // GET muestra el valor pendiente en memoria (contrato actual), no finge que se guardó
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.tts.rate, 1.5);

    // el estado de persistencia es visible por HTTP y no filtra ruta cruda ni valores
    const stBad = await (await fetch(base + '/api/status')).json();
    assert.equal(stBad.persistence.dirty.config, true);
    assert.equal(stBad.persistence.pending.config, 0);
    assert.match(stBad.persistence.message.config, /No se pudo guardar la configuración/);
    assert.doesNotMatch(JSON.stringify(stBad.persistence), /ENOTDIR|blocker|config\.json|CANARY-PERSIST-9/);

    // reparar el destino: el siguiente PUT persiste de verdad
    app.store.cfgFile = path.join(dataDir, 'config.json');
    const ok = await put({ tts: { rate: 1.25 } });
    assert.equal(ok.status, 200);
    assert.equal(changes, 1);
    assert.equal(app.store.persistenceState().dirty.config, false);
    const disk = JSON.parse(await readFile(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(disk.tts.rate, 1.25);
    const stOk = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(stOk.persistence.dirty, { config: false, secrets: false });
  } finally { await close(); }
});

test('el fallo de checkpoint de Session llega al log de forma genérica y acotada', async () => {
  const msgs = [];
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-session-log-'));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: m => msgs.push(String(m)) });
  try {
    const before = msgs.length;
    const blocker = path.join(dataDir, 'blocker');
    await writeFile(blocker, 'x');
    app.session.record({ id: 'x', type: 'follow', at: new Date().toISOString(), vars: { user: 'CANARY-SESSION-SECRET' }, text: 'CANARY-SESSION-SECRET', sub: '' });
    app.session.file = path.join(blocker, 'session-current.json');   // el padre es un fichero → ENOTDIR
    await assert.rejects(app.session.flush());
    await new Promise(r => setImmediate(r));
    const fresh = msgs.slice(before);
    assert.ok(fresh.length >= 1, 'un checkpoint fallido debe ser visible en el log');
    const text = fresh.join('\n');
    assert.doesNotMatch(text, /CANARY-SESSION-SECRET|session-current|blocker/);
  } finally {
    clearTimeout(app.session.saveT);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('las señales reales de producción drenan Session: éxito persiste; fallo exit 1 y log genérico', { timeout: windowsTimeout(3, 20000) }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'CANARY-SESSION-SIG-'));   // prefijo propio: delata cualquier ruta filtrada
  const children = [];
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.exitInfo));
    await rm(root, { recursive: true, force: true });
  });
  const launch = async (name, holdDrain = false) => {
    const dataDir = path.join(root, name);
    await mkdir(dataDir);
    const c = await launchChildOnFreePort({
      launch: port => launchSignalChild({ dataDir, port, holdDrain }),
      ready: async h => { try { await h.waitReady(); return true; } catch { return false; } },
    });
    children.push(c);
    return { ...c, dataDir, file: path.join(dataDir, 'session-current.json') };
  };

  // Variante 1: señal graceful correcta (SIGINT) → conserva TODO el dominio aceptado
  const ok = await launch('ok');
  await assert.rejects(readFile(ok.file), { code: 'ENOENT' });   // aún sin checkpoint: nada guardado todavía
  await ok.graceful('SIGINT');
  assert.equal((await ok.exitInfo).code, 0);
  const saved = JSON.parse(await readFile(ok.file, 'utf8'));
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].thanked, true);
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.notes[0].kind, 'winner');
  assert.equal(saved.goalOffsets.bits, 7);
  assert.doesNotMatch(ok.stdout() + ok.stderr(), /CANARY/);

  // Variante 2: el destino del flush es un directorio → el IO falla; debe salir 1 con log genérico
  const bad = await launch('fail');
  await mkdir(bad.file);                     // EISDIR al escribir/renombrar el destino
  await bad.graceful('SIGTERM');
  assert.equal((await bad.exitInfo).code, 1);
  const leaked = bad.stdout() + bad.stderr();
  assert.doesNotMatch(leaked, /CANARY|EISDIR|session-current/);
  assert.ok(leaked.slice(leaked.indexOf('READY') + 5).trim().length > 0, 'el fallo debe dejar un log genérico');

  if (process.platform === 'win32') {
    // Ctrl+C entra en el shutdown real; SIGTERM fuerza la salida sin completar el drenaje.
    const forced = await launch('forced', true);
    const assertNoCheckpoint = async () => {
      await assert.rejects(readFile(forced.file), { code: 'ENOENT' });
      await assert.rejects(readFile(path.join(forced.dataDir, 'session-current.backup.json')), { code: 'ENOENT' });
    };
    const assertHeld = async () => {
      assert.deepEqual(withoutHeldRecoveryWarning(forced.stdout()).replace(/\r?\n$/, '').split(/\r?\n/), ['READY', 'ENGINE-DRAIN-HELD']);
      assert.equal(forced.stderr(), '');
      assert.doesNotMatch(forced.stdout() + forced.stderr(), /CANARY|EISDIR|session-current|blocker/);
      await assertNoCheckpoint();
    };
    await assertNoCheckpoint();
    await forced.graceful('SIGINT');
    await forced.waitHeld();
    assert.equal(forced.child.exitCode, null);
    assert.equal(forced.child.signalCode, null);
    await assertHeld();
    assert.equal(forced.child.kill('SIGTERM'), true);
    assert.deepEqual(await forced.exitInfo, { code: 1, signal: null });
    await assertHeld();
  }
});

test('win32: se tolera solo el aviso constante de recuperación, exactamente una vez; POSIX intacto', async () => {
  // El texto tolerado es literalmente el de producción: si cambia allí, esto falla.
  assert.ok((await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8')).includes(`'${HELD_RECOVERY_BLOCKED}'`));
  const out = `LOG:${HELD_RECOVERY_BLOCKED}\r\nREADY\r\n`;
  assert.equal(withoutHeldRecoveryWarning(out, { prefix: 'LOG:', platform: 'win32' }), 'READY\r\n');
  assert.equal(withoutHeldRecoveryWarning(`${HELD_RECOVERY_BLOCKED}\n`, { platform: 'win32' }), '');
  assert.equal(withoutHeldRecoveryWarning(out, { prefix: 'LOG:', platform: 'linux' }), out, 'POSIX no filtra nada');
  // Ausente, duplicado, con otro prefijo o con texto alterado: falla en win32.
  for (const bad of ['READY\n', out + out, `${HELD_RECOVERY_BLOCKED}\nREADY\n`, `LOG:${HELD_RECOVERY_BLOCKED} extra\n`]) {
    assert.throws(() => withoutHeldRecoveryWarning(bad, { prefix: 'LOG:', platform: 'win32' }), { code: 'ERR_ASSERTION' }, bad);
  }
});

test('status y state exponen sessionRecovery de la sesión cargada', async () => {
  const { base, close } = await start();
  try {
    const st = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(st.sessionRecovery, { source: 'fresh', preservedFiles: 0, message: null });
    const full = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(full.status.sessionRecovery, st.sessionRecovery);   // /api/state.status hereda el campo
  } finally { await close(); }
});

test('un arranque con sesión corrupta y sin copia válida se bloquea sin reset', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'antena-blocked-'));
  const raw = '{ roto CANARY-RECOVERY-SECRET';
  try {
    await writeFile(path.join(dataDir, 'session-current.json'), raw);
    const err = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} }).then(() => null, e => e);
    assert.ok(err, 'el arranque debe rechazar con bloqueo');
    assert.equal(err.code, 'SESSION_RECOVERY_FAILED');
    assert.equal(err.status, 500);
    assert.doesNotMatch(String(err.message), /CANARY|session-current|\/tmp/);
    assert.equal(await readFile(path.join(dataDir, 'session-current.json'), 'utf8'), raw);   // el corrupto queda IN PLACE
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('status expone el estado de persistencia acotado e inicialmente limpio', async () => {
  const { base, close } = await start();
  try {
    const st = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(st.persistence, {
      dirty: { config: false, secrets: false }, message: { config: null, secrets: null }, pending: { config: 0, secrets: 0 },
    });
    assert.deepEqual(Object.keys(st.persistence).sort(), ['dirty', 'message', 'pending']);   // 2 file-maps acotados
    // /api/state.status hereda el mismo campo
    const full = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(full.status.persistence, st.persistence);
  } finally { await close(); }
});

test('la persistencia viaja por SSE con el contador exacto y sin fingir guardado', async () => {
  const { app, base, dataDir, close } = await start();
  const ctrl = new AbortController();
  try {
    // 1) el contrato debe existir ya: falla rápido si falta (sin esperar a la SSE)
    const clean = await (await fetch(base + '/api/status')).json();
    assert.equal(clean.persistence.pending.config, 0);

    // 2) escuchar el canal panel antes de provocar la escritura
    const res = await fetch(base + '/api/stream?client=panel', { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const nextEvent = async name => {
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const m = /^event: (\w+)\ndata: (.*)$/m.exec(chunk);
          if (m && m[1] === name) return JSON.parse(m[2]);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream cerrado');
        buf += dec.decode(value);
      }
    };
    assert.equal((await (await fetch(base + '/api/status')).json()).persistence.dirty.config, false);

    // 3) fallo determinista: el padre de config.json es un fichero (ENOTDIR)
    const blocker = path.join(dataDir, 'blocker');
    await writeFile(blocker, 'x');
    app.store.cfgFile = path.join(blocker, 'config.json');
    const bad = await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ tts: { rate: 1.5 } }) });
    assert.equal(bad.status, 500);

    const p1 = await nextEvent('persistence');
    assert.equal(p1.pending.config, 1);   // pendiente visible al entrar
    assert.equal(p1.dirty.config, false);
    const p2 = await nextEvent('persistence');
    assert.equal(p2.pending.config, 0);   // asentado aunque falle
    assert.equal(p2.dirty.config, true);
    assert.doesNotMatch(JSON.stringify(p2), /ENOTDIR|blocker|config\.json/);

    // 4) recuperación: el siguiente guardado válido limpia el DIRTY
    app.store.cfgFile = path.join(dataDir, 'config.json');
    const ok = await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ tts: { rate: 1.25 } }) });
    assert.equal(ok.status, 200);
    const p3 = await nextEvent('persistence');
    assert.equal(p3.pending.config, 1);
    assert.equal(p3.dirty.config, true);
    const p4 = await nextEvent('persistence');
    assert.equal(p4.pending.config, 0);
    assert.equal(p4.dirty.config, false);
  } finally { ctrl.abort(); await close(); }
});

test('status y state exponen sessionArchive y el archivo concurrente conserva el directo anterior', async () => {
  const { app, base, close } = await start();
  try {
    // contrato acotado y limpio en el arranque (sin ruta ni error crudo)
    const st = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(st.sessionArchive, { pendingCount: 0, sessionId: null, error: null });
    const full = await (await fetch(base + '/api/state')).json();
    assert.deepEqual(full.status.sessionArchive, st.sessionArchive);   // /api/state.status hereda el campo

    // un directo con dominio y luego un corte real por HTTP
    app.session.record({ id: 'e1', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' });
    const oldId = app.session.data.id;
    const r = await fetch(base + '/api/session/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Next' }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.notEqual(body.session.id, oldId);
    assert.equal(app.session.data.id, body.session.id);   // la sesión actual es la nueva

    // el directo anterior sigue visible por list() y por el resumen por id
    const past = await (await fetch(base + '/api/sessions')).json();
    assert.ok(past.past.some(s => s.id === oldId), 'list() debe incluir el archivado');
    const summary = await (await fetch(base + '/api/session/summary?id=' + encodeURIComponent(oldId) + '&format=json')).json();
    assert.equal(summary.id, oldId);
    assert.equal(summary.events.length, 1);
    assert.equal(summary.events[0].vars.amount, 300);

    const after = await (await fetch(base + '/api/status')).json();
    assert.deepEqual(after.sessionArchive, { pendingCount: 0, sessionId: null, error: null });
  } finally {
    clearTimeout(app.session.saveT); clearTimeout(app.session.maxT);
    await close();
  }
});
