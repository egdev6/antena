import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { launchSignalChild, interruptSignalChild, windowsTimeout } from './helpers/signal-child.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP = fileURLToPath(new URL('../src/mcp.mjs', import.meta.url));
const moduleUrl = name => new URL('../src/' + name + '.mjs', import.meta.url).href;
const BOOTSTRAP = `
import net from 'node:net';
import { Store } from ${JSON.stringify(moduleUrl('store'))};
import { Session } from ${JSON.stringify(moduleUrl('session'))};
import { Interactive } from ${JSON.stringify(moduleUrl('interactive'))};
const scenario = process.env.SCENARIO;
let release;
const gate = new Promise(resolve => { release = resolve; });
process.on('message', msg => { if (msg === 'release') release(); });
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (data, ...args) => {
  if (data === '') {
    if (scenario === 'output-throw') throw new Error('PRIVATE_OUTPUT');
    if (scenario === 'output') {
      console.error('FIXTURE:OUTPUT-BARRIER');
      gate.then(() => stdoutWrite(data, ...args));
      return false;
    }
  }
  return stdoutWrite(data, ...args);
};
let bound;
const on = process.on;
process.on = function (event, callback) {
  if (event === 'SIGINT' || event === 'SIGTERM') {
    if (bound) console.error('FIXTURE:LATE-SIGNAL-OWNER');
    const original = callback;
    callback = (...args) => { console.error('FIXTURE:SIGNAL:' + event); return original(...args); };
  }
  return on.call(this, event, callback);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  return listen.call(this, 0, host, () => {
    bound = this.address().port;
    console.error('FIXTURE:BOUND');
    if (scenario.startsWith('startup')) gate.then(callback);
    else callback();
  });
};
const fetchLocal = globalThis.fetch;
globalThis.fetch = (url, options) => fetchLocal(bound
  ? String(url).replace('http://127.0.0.1:1', 'http://127.0.0.1:' + bound) : url, options);
const patch = Store.prototype.patchConfig;
Store.prototype.patchConfig = async function (data) {
  if (data?.tts?.rate === 1.75 && scenario !== 'startup') {
    console.error('FIXTURE:WORK');
    await gate;
  }
  return patch.call(this, data);
};
const flush = Session.prototype.flush;
Session.prototype.flush = function () {
  console.error('FIXTURE:FLUSH');
  if (scenario === 'fail') return Promise.reject(new Error('PRIVATE_FLUSH'));
  if (scenario === 'late-deadline') return new Promise(() => {});
  const written = flush.call(this);
  // Rama lateral: quien llama recibe la misma promesa, con su rechazo intacto.
  written.then(() => console.error('FIXTURE:SESSION-WRITTEN'), () => {});
  return written;
};
const flushInteractive = Interactive.prototype.flush;
Interactive.prototype.flush = function () {
  const written = flushInteractive.call(this);
  written.then(() => console.error('FIXTURE:INTERACTIVE-WRITTEN'), () => {});
  return written;
};
`;

// Sólo fixtures de señales Windows: release no puede viajar por stdin tras EOF.
const WINDOWS_RELEASE = `
import gateNet from 'node:net';
import { writeFile as publishGate } from 'node:fs/promises';
let released = false;
const releaseServer = gateNet.createServer(socket => {
  let command = '';
  socket.unref();
  socket.on('error', () => {});
  socket.setEncoding('utf8');
  socket.on('data', data => {
    command += data;
    if (released || !'release\\n'.startsWith(command)) { socket.destroy(); return; }
    if (command === 'release\\n') {
      released = true;
      releaseServer.close();
      socket.end('released\\n', () => process.emit('message', 'release'));
    }
  });
});
await new Promise((resolve, reject) => {
  releaseServer.once('error', reject);
  releaseServer.listen(0, '127.0.0.1', resolve);
});
releaseServer.unref();
await publishGate(process.env.MCP_RELEASE_ENDPOINT, String(releaseServer.address().port));
`;

async function launch(t, scenario, external, entry = [MCP], bootstrapName = 'bootstrap.mjs', nativeSignal = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-mcp-eof-'));
  const bootstrap = path.join(root, bootstrapName);
  const native = process.platform === 'win32' && nativeSignal;
  await writeFile(bootstrap, (native ? WINDOWS_RELEASE : '') + BOOTSTRAP);
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, SCENARIO: scenario, PORT: '0', ANTENA_URL: external || 'http://127.0.0.1:1',
    ANTENA_DATA: root, ANTENA_MEDIA: path.join(root, 'media') };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.ANTENA_NO_EMBED;
  if (external) env.ANTENA_NO_EMBED = '1';
  if (native) env.MCP_RELEASE_ENDPOINT = path.join(root, 'release-port');
  const args = ['--import', pathToFileURL(bootstrap).href,
    ...(scenario === 'startup-deadline-probe' ? ['--import', new URL('./helpers/mcp-deadline.mjs', import.meta.url).href] : []),
    ...entry];
  const child = native
    ? await launchSignalChild(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let out = '', err = '';
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { out += data; });
  child.stderr.on('data', data => { err += data; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit; await rm(root, { recursive: true, force: true });
  });
  const until = async (predicate, ms = 2500) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= end || child.exitCode !== null || child.signalCode !== null) return predicate();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return true;
  };
  const messages = () => out.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
  const response = id => messages().find(msg => msg.id === id);
  const send = (id, name, args = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id,
    method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const exited = async (ms = 7500) => {
    let timer;
    try {
      const result = await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
      assert.ok(result, 'watchdog: ' + out + err);
      return result;
    } finally { clearTimeout(timer); }
  };
  const releaseNative = async () => {
    const port = Number(await readFile(env.MCP_RELEASE_ENDPOINT, 'utf8'));
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'puerto de release inválido');
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let ack = '', ended = false;
      socket.setEncoding('utf8');
      socket.setTimeout(2500, () => socket.destroy(new Error('watchdog de release MCP')));
      socket.once('connect', () => socket.write('release\n'));
      socket.on('data', data => {
        ack += data;
        if (ack.length > 9) socket.destroy(new Error('ACK de release MCP inválido'));
      });
      socket.once('error', reject);
      socket.once('end', () => {
        ended = true;
        if (ack === 'released\n') resolve();
        else reject(new Error('ACK de release MCP inválido'));
      });
      socket.once('close', () => { if (!ended) reject(new Error('release MCP cerrado sin ACK')); });
    });
  };
  return { root, child, send, response, until, exited, out: () => out, err: () => err,
    release: native ? releaseNative : () => child.send('release') };
}

const launchSignalFixture = (t, scenario, external, entry = [MCP]) =>
  launch(t, scenario, external, entry, 'bootstrap.mjs', true);

async function warm(c) {
  c.send(1, 'estado');
  assert.ok(await c.until(() => !!c.response(1)), c.out() + c.err());
  assert.ok(!c.response(1).result.isError, c.out());
}

async function domain(c) {
  c.send(2, 'simular_evento', { tipo: 'cheer', datos: { user: 'Ada', amount: 7 } });
  c.send(3, 'anadir_pregunta', { texto: '¿Se guarda al cerrar EOF?', usuario: 'Ada' });
  assert.ok(await c.until(() => !!c.response(2) && !!c.response(3)), c.out() + c.err());
  assert.ok(!c.response(2).result.isError && !c.response(3).result.isError, c.out());
}

const flushes = c => (c.err().match(/FIXTURE:FLUSH/g) || []).length;

// domain() deja Session sucia y su autoguardado (debounce 300 ms, tope 2000 ms) es legítimo:
// se espera a que termine de escribir y se devuelve el recuento como base, para no
// confundirlo con el flush de la parada.
async function autosaved(c) {
  assert.ok(await c.until(() => c.err().includes('FIXTURE:SESSION-WRITTEN'), 3000), 'autoguardado de domain(): ' + c.err());
  return flushes(c);
}

async function persisted(c) {
  const session = JSON.parse(await readFile(path.join(c.root, 'session-current.json'), 'utf8'));
  assert.ok(session.events.some(event => event.user === 'Ada' && event.type === 'cheer'));
  const interactive = JSON.parse(await readFile(path.join(c.root, 'interactive.json'), 'utf8'));
  assert.ok(interactive.questions.some(question => question.text === '¿Se guarda al cerrar EOF?'));
}

test('MCP preload ESM acepta rutas con espacios, # y % y conserva el cierre EOF', { timeout: 15000 }, async t => {
  const c = await launch(t, 'work', undefined, [MCP], 'bootstrap # 100%.mjs');
  await warm(c);
  c.child.stdin.end();
  assert.deepEqual(await c.exited(), { code: 0, signal: null }, c.err());
  assert.ok(c.err().includes('FIXTURE:FLUSH'), 'el preload debe instalar el fixture de Session.flush');
});

test('MCP EOF espera herramienta aceptada y guarda Store/Session/Interactive antes de salir', { timeout: 15000 }, async t => {
  const c = await launch(t, 'work'); await warm(c); await domain(c);
  const baseline = await autosaved(c);
  c.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
  assert.ok(await c.until(() => c.err().includes('FIXTURE:WORK')), c.err());
  c.child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(c.child.exitCode, null);
  assert.equal(flushes(c), baseline, 'flush antes de liberar el trabajo retenido: ' + c.err());
  c.release();
  assert.deepEqual(await c.exited(), { code: 0, signal: null });
  assert.ok(!c.response(4)?.result.isError && c.response(4), c.out());
  await persisted(c);
  const config = JSON.parse(await readFile(path.join(c.root, 'config.json'), 'utf8'));
  assert.equal(config.tts.rate, 1.75);
  assert.equal(flushes(c), baseline + 1, 'un único flush de parada sobre la base: ' + c.err());
});

test('MCP EOF conserva arranque embebido causal de solicitud aceptada', { timeout: 15000 }, async t => {
  const c = await launch(t, 'startup');
  c.send(1, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
  assert.ok(await c.until(() => c.err().includes('FIXTURE:BOUND')), c.err());
  c.child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(c.child.exitCode, null);
  c.release();
  assert.deepEqual(await c.exited(), { code: 0, signal: null });
  assert.ok(c.response(1) && !c.response(1).result.isError, c.out());
  assert.equal((c.err().match(/FIXTURE:BOUND/g) || []).length, 1);
  const config = JSON.parse(await readFile(path.join(c.root, 'config.json'), 'utf8'));
  assert.equal(config.tts.rate, 1.75);
});

test('MCP EOF no oculta fallo de flush y guarda persistencia independiente', { timeout: 15000 }, async t => {
  const c = await launch(t, 'fail'); await warm(c); await domain(c);
  c.child.stdin.end();
  assert.deepEqual(await c.exited(), { code: 1, signal: null });
  const interactive = JSON.parse(await readFile(path.join(c.root, 'interactive.json'), 'utf8'));
  assert.equal(interactive.questions.length, 1);
  assert.doesNotMatch(c.err(), /PRIVATE_FLUSH/);
});

for (const scenario of ['work-deadline', 'late-deadline']) {
  test(`${scenario}: EOF tiene un plazo total de cinco segundos, sin reinicio tras espera`, { timeout: 15000 }, async t => {
    const c = await launch(t, scenario); await warm(c);
    c.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
    assert.ok(await c.until(() => c.err().includes('FIXTURE:WORK')), c.err());
    const start = Date.now(); c.child.stdin.end();
    if (scenario === 'late-deadline') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      c.release();
      assert.ok(await c.until(() => c.err().includes('FIXTURE:FLUSH')), c.err());
    }
    assert.deepEqual(await c.exited(), { code: 1, signal: null });
    assert.ok(Date.now() - start < 6500, 'deadline extendido tras solicitudes: ' + c.err());
    assert.match(c.err(), /\[parada\] drenado MCP agotado/);
    assert.doesNotMatch(c.err(), /PRIVATE_|\[parada\] drenado agotado/);
    if (scenario === 'work-deadline') assert.doesNotMatch(c.err(), /FIXTURE:FLUSH/);
  });
}

test('MCP EOF externo espera respuesta aceptada y no cierra servidor ajeno', { timeout: 15000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered = false;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/config') { entered = true; await gate; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ external: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const c = await launch(t, 'external', base); c.send(1, 'ver_config');
  assert.ok(await c.until(() => entered), c.err());
  c.child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(c.child.exitCode, null);
  release();
  assert.deepEqual(await c.exited(), { code: 0, signal: null });
  assert.match(c.response(1)?.result.content[0].text || '', /external/);
  assert.equal(server.listening, true);
  assert.deepEqual(await (await fetch(base + '/api/status')).json(), { external: true });
  assert.doesNotMatch(c.err(), /FIXTURE:BOUND|FIXTURE:FLUSH/);
});

test('MCP EOF espera callback de barrera stdout sin depender de capacidad del pipe', { timeout: 15000 }, async t => {
  const c = await launch(t, 'output');
  for (let id = 1; id <= 4; id++) c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' }) + '\n');
  c.child.stdin.end();
  assert.ok(await c.until(() => c.err().includes('FIXTURE:OUTPUT-BARRIER')), c.err());
  assert.equal(c.child.exitCode, null, 'no salir antes del callback observado');
  c.release();
  assert.deepEqual(await c.exited(), { code: 0, signal: null });
  for (let id = 1; id <= 4; id++) assert.ok(c.response(id)?.result.tools.length >= 100, c.err());
});

for (const scenario of ['output-throw', 'handler-reject']) {
  test(`${scenario}: rechazo inesperado termina 1 sin promesa huérfana`, { timeout: 15000 }, async t => {
    const c = await launch(t, scenario);
    // null provoca el rechazo del handler y de su error-handler heredados, no valida forma JSON.
    if (scenario === 'handler-reject') c.child.stdin.write('null\n');
    else c.send(1, 'herramienta_desconocida');
    c.child.stdin.end();
    assert.deepEqual(await c.exited(), { code: 1, signal: null });
    assert.doesNotMatch(c.err(), /PRIVATE_|unhandled|TypeError/);
  });
}

for (const scenario of ['opt-out', 'standalone', 'imported-tools']) {
  test(`MCP señal ownership ${scenario} conserva listeners ajenos y quiet no decide propiedad`, { timeout: windowsTimeout(scenario === 'imported-tools' ? 1 : 0, 15000) }, async t => {
    const entry = `
      import { startServer } from ${JSON.stringify(moduleUrl('server'))};
      import { TOOLS } from ${JSON.stringify(new URL('../src/mcp.mjs', import.meta.url).href)};
      const names = ['SIGINT', 'SIGTERM'];
      for (const name of names) process.on(name, () => {});
      const before = Object.fromEntries(names.map(name => [name, process.listeners(name)]));
      const imported = process.env.SCENARIO === 'imported-tools';
      const app = imported ? null : await startServer({ quiet: true, log: () => {},
        ...(process.env.SCENARIO === 'opt-out' ? { handleSignals: false } : {}) });
      if (imported) await TOOLS.find(tool => tool.name === 'estado').call({});
      for (const name of names) {
        const after = process.listeners(name);
        if (before[name].some(fn => !after.includes(fn))) throw new Error('Foreign listener removed');
        const added = after.filter(fn => !before[name].includes(fn)).length;
        if (added !== (process.env.SCENARIO === 'opt-out' ? 0 : 1)) throw new Error('Signal ownership count: ' + added);
      }
      console.error('FIXTURE:OWNERSHIP-OK');
      if (imported) {
        if (process.platform !== 'win32') process.kill(process.pid, 'SIGINT');
      } else process.exit(await app.close());
    `;
    const c = await (scenario === 'imported-tools' ? launchSignalFixture : launch)(t, scenario, undefined, ['--input-type=module', '--eval', entry]);
    if (scenario === 'imported-tools' && process.platform === 'win32') {
      assert.ok(await c.until(() => c.err().includes('FIXTURE:OWNERSHIP-OK')), c.err());
      // El original ya registra propietarios tardíos aquí; sólo cambia el autoenvío por Ctrl+C con ACK.
      await interruptSignalChild(c.child, 'SIGINT');
      assert.ok(await c.until(() => c.err().includes('FIXTURE:SIGNAL:SIGINT')), c.err());
    }
    assert.deepEqual(await c.exited(), { code: 0, signal: null });
    assert.match(c.err(), /FIXTURE:OWNERSHIP-OK/);
  });
}

async function signal(c, name) {
  const actual = process.platform === 'win32' ? 'SIGINT' : name;
  if (process.platform === 'win32') await interruptSignalChild(c.child, actual);
  else c.child.kill(name);
  assert.ok(await c.until(() => c.err().includes('FIXTURE:SIGNAL:' + actual)), c.err());
  assert.equal(c.child.signalCode, null);
  assert.doesNotMatch(c.err(), /FIXTURE:LATE-SIGNAL-OWNER/);
}

async function protocolReady(c) {
  c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 98, method: 'ping' }) + '\n');
  assert.ok(await c.until(() => !!c.response(98)), c.err());
}

for (const name of ['SIGINT', 'SIGTERM']) {
  for (const scenario of ['work', 'startup']) {
    test(`MCP señal ${name} conserva ${scenario}, repeticiones y EOF causal`, { timeout: windowsTimeout(name === 'SIGINT' && scenario === 'work' ? 2 : 1, 15000) }, async t => {
      const c = await launchSignalFixture(t, scenario);
      let baseline = 0;
      if (scenario === 'work') { await warm(c); await domain(c); baseline = await autosaved(c); }
      c.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
      const marker = scenario === 'startup' ? 'FIXTURE:BOUND' : 'FIXTURE:WORK';
      assert.ok(await c.until(() => c.err().includes(marker)), c.err());
      await signal(c, name);
      c.send(5, 'anadir_pregunta', { texto: 'No admitir después de la señal', usuario: 'Tarde' });
      assert.equal(flushes(c), baseline, 'flush antes de liberar el trabajo retenido: ' + c.err());
      if (process.platform === 'win32') {
        await signal(c, name); await signal(c, name === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
      } else { c.child.kill(name); c.child.kill(name === 'SIGINT' ? 'SIGTERM' : 'SIGINT'); }
      c.child.stdin.end(); await c.release();
      assert.deepEqual(await c.exited(), { code: 0, signal: null });
      assert.ok(c.response(4) && !c.response(4).result.isError, c.out());
      assert.equal(c.response(5), undefined, 'no admitir herramienta enviada después del corte observado');
      const interactive = JSON.parse(await readFile(path.join(c.root, 'interactive.json'), 'utf8'));
      assert.ok(!interactive.questions.some(q => q.user === 'Tarde' || q.text === 'No admitir después de la señal'));
      assert.equal(JSON.parse(await readFile(path.join(c.root, 'config.json'), 'utf8')).tts.rate, 1.75);
      assert.equal(flushes(c), baseline + 1, 'un único flush de parada sobre la base: ' + c.err());
      assert.equal((c.err().match(/FIXTURE:BOUND/g) || []).length, 1);
      if (scenario === 'work') await persisted(c);
      if (process.platform === 'win32' && name === 'SIGINT' && scenario === 'work') {
        const forced = await launchSignalFixture(t, 'work'); await warm(forced); await domain(forced);
        const forcedBaseline = await autosaved(forced);
        // La pregunta de domain() también programa el autoguardado de Interactive: debe terminar
        // antes de la instantánea para no comparar con una escritura a medias.
        assert.ok(await forced.until(() => forced.err().includes('FIXTURE:INTERACTIVE-WRITTEN'), 3000), forced.err());
        forced.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
        assert.ok(await forced.until(() => forced.err().includes('FIXTURE:WORK')), forced.err());
        const files = ['config.json', 'session-current.json', 'interactive.json'];
        const snapshot = () => Promise.all(files.map(file => readFile(path.join(forced.root, file)).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        })));
        const before = await snapshot();
        await signal(forced, 'SIGTERM');
        assert.equal(forced.child.exitCode, null);
        assert.equal(flushes(forced), forcedBaseline, forced.err());
        assert.doesNotMatch(forced.err(), /PRIVATE_/);
        assert.equal(forced.child.kill('SIGTERM'), true);
        assert.deepEqual(await forced.exited(), { code: 1, signal: null });
        assert.equal(forced.response(4), undefined);
        assert.equal(flushes(forced), forcedBaseline, forced.err());
        assert.doesNotMatch(forced.err(), /PRIVATE_/);
        assert.deepEqual(await snapshot(), before, 'TERM forzado no persiste mientras el gate sigue retenido');
      }
    });
  }
  for (const scenario of ['empty', 'tool-error', 'output', 'output-throw', 'handler-reject', 'fail']) {
    test(`MCP señal ${name} respeta ${scenario} y barrera de salida`, { timeout: windowsTimeout(1, 15000) }, async t => {
      const c = await launchSignalFixture(t, scenario);
      if (scenario === 'fail') { await warm(c); await domain(c); }
      else await protocolReady(c);
      if (scenario === 'tool-error' || scenario === 'output-throw') {
        c.send(1, 'herramienta_desconocida');
        assert.ok(await c.until(() => !!c.response(1)), c.err());  // no confundir enviado con admitido
      }
      if (scenario === 'handler-reject') c.child.stdin.write('null\n');
      // Ping posterior asegura que el rechazo inesperado ya se observó antes del corte.
      if (scenario === 'handler-reject') {
        c.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\n');
        assert.ok(await c.until(() => !!c.response(99)), c.err());
      }
      await signal(c, name);
      if (scenario === 'output') {
        assert.ok(await c.until(() => c.err().includes('FIXTURE:OUTPUT-BARRIER')), c.err());
        assert.equal(c.child.exitCode, null); await c.release();
      }
      const failed = ['output-throw', 'handler-reject', 'fail'].includes(scenario);
      assert.deepEqual(await c.exited(), { code: failed ? 1 : 0, signal: null });
      if (scenario === 'tool-error' || scenario === 'output-throw') assert.equal(c.response(1)?.error.code, -32602);
      if (scenario === 'fail') {
        // Session rechaza su flush: comprobar solo la persistencia independiente que sí completó.
        const interactive = JSON.parse(await readFile(path.join(c.root, 'interactive.json'), 'utf8'));
        assert.ok(interactive.questions.some(q => q.text === '¿Se guarda al cerrar EOF?'));
      } else assert.doesNotMatch(c.err(), /FIXTURE:BOUND|FIXTURE:FLUSH/);
      assert.doesNotMatch(c.err(), /PRIVATE_|unhandled|TypeError/);
    });
  }
}

async function signalAgain(c, name) {
  const marker = 'FIXTURE:SIGNAL:' + (process.platform === 'win32' ? 'SIGINT' : name);
  const count = c.err().split(marker).length - 1;
  await signal(c, name);
  assert.ok(await c.until(() => c.err().split(marker).length - 1 > count), c.err());
}

test('MCP señal plazo total startup-deadline no se reinicia por señal ni EOF', { timeout: windowsTimeout(1, 15000) }, async t => {
  const c = await launchSignalFixture(t, 'startup-deadline-probe');
  c.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
  assert.ok(await c.until(() => c.err().includes('FIXTURE:BOUND')), c.err());
  await signal(c, 'SIGINT');
  assert.ok(await c.until(() => c.err().includes('FIXTURE:DEADLINE:REGISTER:')), c.err());
  const registrations = () => [...c.err().matchAll(/FIXTURE:DEADLINE:REGISTER:([^\r\n]*)/g)].map(match => match[1]);
  assert.deepEqual(registrations(), ['5000'], c.err());

  await signalAgain(c, 'SIGTERM');
  c.child.stdin.end();
  assert.ok(await c.until(() => c.err().includes('FIXTURE:DEADLINE:EOF')), c.err());
  assert.equal(c.child.exitCode, null, c.err());
  assert.deepEqual(registrations(), ['5000'], c.err());
  assert.doesNotMatch(c.err(), /FIXTURE:DEADLINE:(?:CLEAR|REFRESH|EXPIRE)/);

  await c.release();
  assert.deepEqual(await c.exited(), { code: 1, signal: null }, c.err());
  assert.deepEqual(registrations(), ['5000'], c.err());
  assert.doesNotMatch(c.err(), /FIXTURE:DEADLINE:(?:CLEAR|REFRESH)/);
  assert.equal((c.err().match(/FIXTURE:DEADLINE:EXPIRE/g) || []).length, 1, c.err());
  assert.ok(c.err().indexOf('FIXTURE:DEADLINE:EOF') < c.err().indexOf('FIXTURE:DEADLINE:EXPIRE'), c.err());
  assert.match(c.err(), /\[parada\] drenado MCP agotado/);
  assert.doesNotMatch(c.err(), /PRIVATE_|FIXTURE:FLUSH|\[parada\] drenado agotado/);
});

test('MCP startup deadline expires in a real process after signals and EOF', { timeout: windowsTimeout(1, 15000) }, async t => {
  const c = await launchSignalFixture(t, 'startup-deadline');
  c.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
  assert.ok(await c.until(() => c.err().includes('FIXTURE:BOUND')), c.err());
  await signal(c, 'SIGINT');
  const start = performance.now();
  await signalAgain(c, 'SIGTERM');
  c.child.stdin.end();
  assert.deepEqual(await c.exited(9000), { code: 1, signal: null }, c.err());
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 9000, 'MCP startup deadline exceeded smoke bound: ' + elapsed + ' ' + c.err());
  assert.match(c.err(), /\[parada\] drenado MCP agotado/);
  assert.doesNotMatch(c.err(), /PRIVATE_|FIXTURE:FLUSH|\[parada\] drenado agotado/);
});

for (const scenario of ['work-deadline', 'late-deadline']) {
  test(`MCP señal plazo total ${scenario} no se reinicia por señal ni EOF`, { timeout: windowsTimeout(1, 15000) }, async t => {
    const c = await launchSignalFixture(t, scenario);
    await warm(c);
    c.send(4, 'cambiar_config', { cambios: { tts: { rate: 1.75 } } });
    assert.ok(await c.until(() => c.err().includes('FIXTURE:WORK')), c.err());
    const start = Date.now(); await signal(c, 'SIGINT');
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (process.platform === 'win32') await signal(c, 'SIGTERM');
    else c.child.kill('SIGTERM');
    c.child.stdin.end();
    if (scenario === 'late-deadline') {
      await c.release(); assert.ok(await c.until(() => c.err().includes('FIXTURE:FLUSH')), c.err());
    }
    assert.deepEqual(await c.exited(), { code: 1, signal: null });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 4500 && elapsed < 6500, 'deadline MCP anticipado o reiniciado: ' + elapsed + ' ' + c.err());
    assert.match(c.err(), /\[parada\] drenado MCP agotado/);
    assert.doesNotMatch(c.err(), /PRIVATE_|\[parada\] drenado agotado/);
    if (scenario !== 'late-deadline') assert.doesNotMatch(c.err(), /FIXTURE:FLUSH/);
  });
}

test('MCP señal EOF primero comparte cierre con señales posteriores', { timeout: windowsTimeout(1, 15000) }, async t => {
  const c = await launchSignalFixture(t, 'output'); await protocolReady(c);
  c.child.stdin.end();
  assert.ok(await c.until(() => c.err().includes('FIXTURE:OUTPUT-BARRIER')), c.err());
  await signal(c, 'SIGTERM');
  if (process.platform === 'win32') await signal(c, 'SIGINT');
  else c.child.kill('SIGINT');
  await c.release(); assert.deepEqual(await c.exited(), { code: 0, signal: null });
  assert.equal((c.err().match(/FIXTURE:OUTPUT-BARRIER/g) || []).length, 1);
});

test('MCP señal conserva solicitud externa aceptada sin cerrar servidor ajeno', { timeout: windowsTimeout(1, 15000) }, async t => {
  let entered = false, release; const gate = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/config') { entered = true; await gate; }
    res.setHeader('Content-Type', 'application/json'); res.end('{"external":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const c = await launchSignalFixture(t, 'external', base); c.send(1, 'ver_config');
  assert.ok(await c.until(() => entered), c.err());
  await signal(c, 'SIGTERM'); release();
  assert.deepEqual(await c.exited(), { code: 0, signal: null });
  assert.match(c.response(1)?.result.content[0].text || '', /external/);
  assert.equal(server.listening, true);
  assert.deepEqual(await (await fetch(base + '/api/status')).json(), { external: true });
  assert.doesNotMatch(c.err(), /FIXTURE:BOUND|FIXTURE:FLUSH/);
});

for (const scenario of ['empty', 'tool-error']) {
  test(`${scenario}: EOF sin app propia sale cero y conserva respuesta de error normal`, { timeout: 15000 }, async t => {
    const c = await launch(t, scenario);
    if (scenario === 'tool-error') c.send(1, 'herramienta_desconocida');
    c.child.stdin.end();
    assert.deepEqual(await c.exited(), { code: 0, signal: null });
    if (scenario === 'tool-error') assert.equal(c.response(1)?.error.code, -32602);
    assert.doesNotMatch(c.err(), /FIXTURE:BOUND|FIXTURE:FLUSH|\[parada\]/);
  });
}
