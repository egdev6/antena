import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SERVER = new URL('../src/server.mjs', import.meta.url).href;
const PROGRAM = `
import net from 'node:net';
import { startServer } from ${JSON.stringify(SERVER)};
const scenario = process.argv[1];
const realListen = net.Server.prototype.listen;
let calls = 0, app, baseline;
const foreignError = () => console.log('FOREIGN:ERROR');
const foreignListening = () => console.log('FOREIGN:LISTENING');
const foreignClose = () => console.log('FOREIGN:CLOSE');
const report = () => {
  console.log('STATE:' + JSON.stringify({ listening: app.server.listening,
    error: app.server.listenerCount('error'), bind: app.server.listenerCount('listening'),
    close: app.server.listenerCount('close'), baseline,
    retained: app.server.listeners('error').includes(foreignError)
      && app.server.listeners('listening').includes(foreignListening)
      && app.server.listeners('close').includes(foreignClose) }));
};
const finish = async () => {
  report();
  await app.closeHttp();
  app.emit('relisten');
  console.log('CALLS:' + calls);
  process.exit(0);
};
net.Server.prototype.listen = function (port, host, callback) {
  calls++;
  if (calls === 2 && scenario === 'throw') {
    setImmediate(finish);
    throw new Error('PRIVATE_BIND');
  }
  if (calls === 2 && (scenario === 'error' || scenario === 'logger-throw')) {
    process.nextTick(() => { this.emit('error', new Error('PRIVATE_BIND')); setImmediate(finish); });
    return this;
  }
  const result = realListen.call(this, 0, host, callback);
  if (calls === 2 && scenario === 'cancel') {
    // Close real síncrono durante bind/DNS; closeHttp por sí solo espera idle en una microtarea.
    this.close();
    app.closeHttp().then(() => setImmediate(finish));
  }
  return result;
};
app = await startServer({ quiet: true, log: (...args) => {
  console.log('LOG:' + args.map(String).join(' '));
  if (String(args[0]).startsWith('[acceso] escuchando')) console.log('LISTENED:' + calls);
  if (scenario === 'logger-throw') throw new Error('PRIVATE_LOG');
} });
app.server.on('error', foreignError);
app.server.on('listening', foreignListening);
app.server.on('close', foreignClose);
baseline = { error: app.server.listenerCount('error'), bind: app.server.listenerCount('listening'), close: app.server.listenerCount('close') };
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (String(chunk).includes('go')) { app.store.config.access.lan = !app.store.config.access.lan; app.emit('relisten'); }
  if (String(chunk).includes('inspect')) finish();
});
console.log('READY');
`;

async function launch(t, scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-listen-own-'));
  const env = { ...process.env, ANTENA_DATA: root, ANTENA_MEDIA: path.join(root, 'media'), PORT: '0' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
  const child = spawn(process.execPath, ['--input-type=module', '-e', PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { out += data; });
  child.stderr.on('data', data => { err += data; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; await rm(root, { recursive: true, force: true }); });
  const wait = async marker => {
    const end = Date.now() + 2500;
    while (!out.includes(marker) && child.exitCode === null && child.signalCode === null && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(out.includes(marker), out + err);
  };
  await wait('READY');
  return { child, exit, wait, out: () => out, err: () => err };
}

for (const scenario of ['cancel', 'throw', 'error', 'normal', 'logger-throw', 'cycles']) {
  test(`${scenario}: listen libera solo callbacks propios y no revive después de cierre`, { timeout: 10000 }, async t => {
    const c = await launch(t, scenario);
    c.child.stdin.write('go\n');
    if (scenario === 'normal') { await c.wait('LISTENED:2'); c.child.stdin.write('inspect\n'); }
    if (scenario === 'cycles') {
      await c.wait('LISTENED:2'); c.child.stdin.write('go\n');
      await c.wait('LISTENED:3'); c.child.stdin.write('go\n');
      await c.wait('LISTENED:4'); c.child.stdin.write('inspect\n');
    }
    await c.wait('STATE:');
    assert.deepEqual(await c.exit, { code: 0, signal: null });
    const state = JSON.parse(c.out().split('\n').find(line => line.startsWith('STATE:')).slice(6));
    assert.deepEqual({ error: state.error, bind: state.bind, close: state.close }, state.baseline, c.out());
    assert.equal(state.listening, scenario === 'normal' || scenario === 'cycles', c.out());
    assert.equal(state.retained, true, c.out());
    assert.ok(c.out().includes('CALLS:' + (scenario === 'cycles' ? 4 : 2)), c.out());
    assert.equal(c.err(), '');
    assert.doesNotMatch(c.out(), /PRIVATE_|LOG:\[error\]|escuchando en null/);
    if (scenario === 'throw' || scenario === 'error' || scenario === 'logger-throw') assert.match(c.out(), /LOG:\[acceso\] No se pudo volver a escuchar\./);
    if (scenario === 'cancel') assert.doesNotMatch(c.out(), /FOREIGN:LISTENING|LOG:\[acceso\] escuchando/);
  });
}
