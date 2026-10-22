// ODD-08 S7 (#24): refresco de token de YouTube y sendChat en vuelo durante SIGINT/SIGTERM a
// través de sus dos dueños (acción de chat del Engine y POST /api/chat/send). El secreto
// refrescado llega a disco con salida 0 (o la salida es 1), un solo envío y nada tras salir.
// Hijo REAL con startServer de producción; fetch falso (sin red) y credenciales de fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';
import { withoutHeldRecoveryWarning } from './helpers/held-recovery-warning.mjs';

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;

const CHILD_PROGRAM = `
import { startServer } from ${JSON.stringify(SERVER_MODULE_URL)};
import net from 'node:net';

const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  return realListen.call(this, 0, host, callback);
};

const scenario = process.argv[1];
const realExit = process.exit.bind(process);
process.exit = code => { console.log('WILLEXIT:' + code); realExit(code); };

let release = () => {};
const gate = new Promise(r => { release = r; });
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { if (String(d).includes('release')) release(); });
process.stdin.resume();

// Sin red: el refresco OAuth queda retenido en la puerta; el envío al chat responde al momento.
let tokenCalls = 0, sendCalls = 0, entered;
const refreshing = new Promise(r => { entered = r; });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === 'https://oauth2.googleapis.com/token') {
    console.log('YT:TOKEN:' + (++tokenCalls) + ':' + new URLSearchParams(String(init.body)).get('grant_type'));
    entered();
    await gate;
    return new Response(JSON.stringify({ access_token: 'fixture-new-access', expires_in: 3600 }), { status: 200 });
  }
  if (u.startsWith('https://www.googleapis.com/youtube/v3/liveChat/messages') && init.method === 'POST') {
    console.log('YT:SEND:' + (++sendCalls) + ':' + init.headers.Authorization + ':' + JSON.parse(init.body).snippet.textMessageDetails.messageText);
    return new Response(JSON.stringify({ id: 'fixture-msg' }), { status: 200 });
  }
  console.log('YT:UNEXPECTED');
  throw new Error('fetch externo prohibido');
};

const app = await startServer({ quiet: true, log: m => console.log('LOG:' + String(m)) });
net.Server.prototype.listen = realListen;
await app.store.setSecret('youtube', { access: 'fixture-old-access', refresh: 'fixture-refresh', expiresAt: 1 });
app.youtube.status.liveChatId = 'fixture-chat';
app.store.on('persistence', s => { if (!s.pending.secrets) console.log('YT:SECRETS-SAVED'); });
const stopAdmission = app.stopAdmission.bind(app);
app.stopAdmission = () => { console.log('YT:CUT'); return stopAdmission(); };
console.log('BOUND:' + app.server.address().port);

if (scenario === 'engine') {
  app.engine.on('chatResult', r => console.log('YT:RESULT:' + r.ok + ':' + JSON.stringify(r.platforms.youtube.result)));
  app.engine.send({ id: 'yt-action', actions: [{ kind: 'chat', destination: 'youtube', text: 'hola yt' }], vars: {} });
}
await refreshing;
console.log('READY');
`;

const positiveSignal = signal => process.platform === 'win32' && signal === 'SIGTERM' ? 'SIGINT' : signal;

async function startChild(t, scenario, signal) {
  const root = await mkdtemp(path.join(tmpdir(), 'EGDEV-YTSHUT-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const env = { ...process.env, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: '0' };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
  const child = await launchSignalChild(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  const waiters = [];
  const notify = () => { for (const w of waiters.splice(0)) w(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; notify(); });
  child.stderr.on('data', d => { err += d; notify(); });
  const exitInfo = new Promise(res => child.once('exit', (code, sig) => res({ code, signal: sig })));
  // Fin de streams: todo lo que el hijo escribió antes de salir ya está en out/err.
  const closed = new Promise(res => child.once('close', () => res()));
  exitInfo.then(notify);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exitInfo;
    await rm(root, { recursive: true, force: true });
  });
  const waitFor = async (marker, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(out + err).includes(marker)) {
      const left = end - Date.now();
      if (left <= 0 || child.exitCode !== null) return (out + err).includes(marker);
      await new Promise(r => { const tm = setTimeout(r, Math.min(left, 50)); waiters.push(() => { clearTimeout(tm); r(); }); });
    }
    return true;
  };
  assert.ok(await waitFor('BOUND:'), out + err);
  let response;
  if (scenario === 'http') {
    const port = Number(out.match(/^BOUND:(\d+)$/m)?.[1]);
    const body = JSON.stringify({ text: 'hola yt', to: 'youtube' });
    response = new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/chat/send',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', d => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
        res.on('error', e => resolve({ error: e.code }));
      });
      req.on('error', e => resolve({ error: e.code }));
      req.setTimeout(8000, () => req.destroy(new Error('timeout')));
      t.after(() => req.destroy());
      req.end(body);
    });
  }
  assert.ok(await waitFor('READY'), 'el hijo no llegó a READY (' + scenario + '/' + signal + '): ' + out + err);
  return { child, dataDir, exitInfo, closed, response, waitFor, stdout: () => out, stderr: () => err,
    release: () => { try { child.stdin.write('release\n'); } catch { /* el hijo pudo morir antes */ } } };
}

async function awaitExit(c, ms = 5000) {
  let timer;
  const watchdog = new Promise(r => { timer = setTimeout(() => r(null), ms); });
  try {
    const res = await Promise.race([Promise.all([c.exitInfo, c.closed]).then(([exit]) => exit), watchdog]);
    if (!res) { c.child.kill('SIGKILL'); await c.exitInfo; assert.fail('el hijo no salió en ' + ms + 'ms: ' + c.stdout() + c.stderr()); }
    return res;
  } finally { clearTimeout(timer); }
}

const count = (text, re) => (text.match(re) || []).length;

for (const scenario of ['engine', 'http']) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`S7 ${scenario}/${signal}: refresco y sendChat de YouTube en vuelo persisten el secreto y salen 0 sin trabajo tras salir`, { timeout: 20000 }, async t => {
      const c = await startChild(t, scenario, signal);
      await interruptSignalChild(c.child, positiveSignal(signal));
      await interruptSignalChild(c.child, positiveSignal('SIGINT'));
      // Orden explícito: señal observada en el corte de admisión antes de liberar el refresco.
      assert.ok(await c.waitFor('YT:CUT'), c.stdout() + c.stderr());
      assert.doesNotMatch(c.stdout(), /WILLEXIT|YT:SEND|YT:SECRETS-SAVED/);
      c.release();
      const exit = await awaitExit(c);
      const out = withoutHeldRecoveryWarning(c.stdout(), { prefix: 'LOG:' });
      assert.deepEqual(exit, { code: 0, signal: null }, out + c.stderr());
      assert.equal(count(out, /YT:TOKEN:/g), 1, out);
      assert.match(out, /YT:TOKEN:1:refresh_token\n/);
      assert.equal(count(out, /YT:SEND:/g), 1, out);
      assert.match(out, /YT:SEND:1:Bearer fixture-new-access:hola yt\n/);
      assert.doesNotMatch(out, /YT:UNEXPECTED|YT:HTTP-ERROR|LOG:/);
      if (scenario === 'engine') assert.match(out, /YT:RESULT:true:\{"id":"fixture-msg","sent":true\}\n/);
      else assert.deepEqual(await c.response, { status: 200, body: JSON.stringify({ sent: { youtube: { id: 'fixture-msg', sent: true } }, errors: {}, to: 'youtube' }) });
      // Orden: refresco → secreto guardado → envío → salida; nada después de WILLEXIT.
      assert.ok(out.indexOf('YT:SECRETS-SAVED') < out.indexOf('YT:SEND:1'), out);
      assert.equal(count(out, /WILLEXIT:/g), 1, out);
      assert.ok(out.endsWith('WILLEXIT:0\n'), 'ningún trabajo tras la salida: ' + out);
      assert.equal(c.stderr(), '');
      const secrets = JSON.parse(await readFile(path.join(c.dataDir, 'secrets.json'), 'utf8'));
      assert.equal(secrets.youtube.access, 'fixture-new-access');
      assert.equal(secrets.youtube.refresh, 'fixture-refresh');
      assert.ok(secrets.youtube.expiresAt > Date.now(), 'el vencimiento refrescado llega a disco');
    });
  }
}
