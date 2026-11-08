// #26: regresiones de callers reales, no integración del journal ni prueba de cierre global.
// Custom no contiene await interno: la puerta real es readBody del HTTP admitido.
// Notification EventSub emite síncronamente: la puerta es el close físico histórico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launchSignalChild, interruptSignalChild, windowsTimeout } from './helpers/signal-child.mjs';

const SERVER = new URL('../src/server.mjs', import.meta.url).href;
const PROGRAM = String.raw`
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
const scenario = process.argv[1];
const eventsFile = path.join(process.env.ANTENA_DATA, 'frontier.jsonl');
let app, sends = 0, captures = 0, subscriptions = 0, tokens = 0, channels = 0;
const sockets = [];
function mark(event, extra = {}) {
  const state = app ? { held: app.engine.held.map(a => ({ id: a.id, type: a.type, text: a.text, user: a.vars.user })),
    history: app.bus.history.length, sends, captures, sockets: sockets.length,
    owned: app.twitch._sockets.size, subscriptions, tokens, channels } : {};
  appendFileSync(eventsFile, JSON.stringify({ event, ...state, ...extra }) + '\n', { mode: 0o600 });
  console.log('MARK:' + event);
}
const gates = {};
for (const key of ['token', 'channel']) gates[key] = {};
for (const g of Object.values(gates)) g.promise = new Promise(r => { g.release = r; });
class Socket extends EventTarget {
  constructor(url) {
    super();
    if (!String(url).startsWith('wss://eventsub.')) throw new Error('WS externo prohibido');
    this.readyState = 1; this.closeCalls = 0; sockets.push(this);
  }
  close() { this.closeCalls++; this.readyState = 2; if (this !== sockets[0]) this.finish(); }
  finish() { this.readyState = 3; this.dispatchEvent(new Event('close')); this.onclose?.(); }
}
// Dobles instalados ANTES de importar producción; ninguna cuenta ni conexión externa.
globalThis.WebSocket = Socket;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (scenario === 'eventsub' && u === 'https://id.twitch.tv/oauth2/validate')
    return Response.json({ user_id: 'fixture-id', login: '', scopes: [] });
  if (scenario === 'eventsub' && u === 'https://api.twitch.tv/helix/eventsub/subscriptions' && init.method === 'POST') {
    subscriptions++; return Response.json({ data: [] }, { status: 202 });
  }
  if (scenario === 'oauth' && u === 'https://oauth2.googleapis.com/token') {
    tokens++; mark('token', { grant: new URLSearchParams(init.body).get('grant_type') });
    await gates.token.promise;
    return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
  }
  if (scenario === 'oauth' && u.startsWith('https://www.googleapis.com/youtube/v3/channels?')) {
    channels++; mark('channel', { authorization: init.headers.Authorization });
    await gates.channel.promise;
    return Response.json({ items: [{ snippet: { title: 'Fixture Channel' } }] });
  }
  mark('unexpected-fetch'); throw new Error('fetch externo prohibido');
};
const { startServer } = await import(${JSON.stringify(SERVER)});
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, cb) { return realListen.call(this, 0, host, cb); };
app = await startServer({ quiet: true, log: m => mark('log', { message: String(m) }) });
net.Server.prototype.listen = realListen;
const send = app.bus.send.bind(app.bus);
app.bus.send = (type, ...args) => { if (type === 'alert') sends++; return send(type, ...args); };
const stop = app.stopAdmission.bind(app);
app.stopAdmission = () => { const p = stop(); mark('cut'); return p.then(() => mark('http-idle')); };
const capture = app.captureAckWindow.bind(app);
app.captureAckWindow = () => { captures++; mark('capture'); return capture(); };
const draws = app.interactive.drainDraws.bind(app.interactive);
// Primera operación inmediatamente DESPUÉS del sampler held de producción, sin insertar await.
app.interactive.drainDraws = () => { mark('sampled'); return draws(); };
const quiesce = app.twitch.quiesceEventSub.bind(app.twitch);
app.twitch.quiesceEventSub = () => {
  const p = quiesce(); mark('eventsub-cut'); return p.then(() => mark('eventsub-idle'));
};
const flush = app.session.flush.bind(app.session);
app.session.flush = () => { mark('flush', { youtube: app.store.secrets.youtube, persistence: app.store.persistenceState() }); return flush(); };
app.server.on('request', req => {
  if (scenario === 'http' && req.url === '/api/alert/custom')
    req.once('data', () => mark('body-chunk', { complete: req.complete }));
});
process.once('exit', code => mark('exit', { code, physical: sockets.map(s => s.readyState), closes: sockets.map(s => s.closeCalls) }));
if (scenario !== 'oauth') await app.engine.pause();
else await app.store.patchConfig({ youtube: { clientId: 'fixture-client', clientSecret: 'fixture-client-secret' } });
const frame = (ws, type, payload, id = 'fixture-frame') => ws.onmessage({ data: JSON.stringify({ metadata: { message_type: type, message_id: id }, payload }) });
const welcome = { session: { id: 'fixture-session' } };
const notification = { subscription: { type: 'channel.follow' }, event: { user_name: 'Fixture Follower' } };
if (scenario === 'eventsub') {
  await app.store.patchConfig({ twitch: { clientId: 'fixture-client' } });
  await app.store.setSecret('twitch', { access: 'fixture-access', refresh: 'fixture-refresh', expiresAt: Date.now() + 3600000 });
  await app.twitch.start();
  await frame(sockets[0], 'session_welcome', welcome);
  await frame(sockets[0], 'session_reconnect', { session: { reconnect_url: 'wss://eventsub.fixture/replacement' } });
  await frame(sockets[1], 'session_welcome', welcome);
  await frame(sockets[1], 'notification', notification);
  mark('admitted');
}
let commands = Promise.resolve(), input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  input += data;
  while (input.includes('\n')) {
    const end = input.indexOf('\n'), command = input.slice(0, end); input = input.slice(end + 1);
    commands = commands.then(async () => {
      if (command === 'probe') mark('probe');
      if (command === 'token' || command === 'channel') gates[command].release();
      if (command === 'stale') {
        for (const ws of sockets) {
          await frame(ws, 'notification', notification, 'stale-' + sockets.indexOf(ws));
          await frame(ws, 'session_reconnect', { session: { reconnect_url: 'wss://eventsub.fixture/stale' } });
          await frame(ws, 'session_welcome', welcome);
          ws.onclose?.(); ws.onerror?.(new Event('error'));
        }
        await app.twitch.start(); app.twitch.connect('wss://eventsub.fixture/terminal');
        mark('stale');
      }
      if (command === 'physical') { sockets[0].finish(); mark('physical'); }
    }).catch(e => { console.error(e); mark('fault'); });
  }
});
console.log('BOUND:' + app.server.address().port);
mark('ready');
`;

async function launch(t, scenario) {
  // Se conserva el scratch, incluso ante fallo; solo contiene fixtures de esta prueba.
  const root = await mkdtemp(path.join(tmpdir(), 'held-frontier-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  const env = { ...process.env, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(root, 'media'), PORT: '0' };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
  const child = await launchSignalChild(process.execPath, ['--input-type=module', '-e', PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '', closed = false;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) fn(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; notify(); });
  child.stderr.on('data', d => { err += d; notify(); });
  const ending = new Promise(resolve => child.once('close', (code, signal) => { closed = true; notify(); resolve({ code, signal }); }));
  const destination = process.env.HELD_FRONTIER_EVIDENCE || root;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ending;
    await writeFile(path.join(destination, scenario + '.stdout'), out, { mode: 0o600 });
    await writeFile(path.join(destination, scenario + '.stderr'), err, { mode: 0o600 });
    await writeFile(path.join(destination, scenario + '.jsonl'), await readFile(path.join(dataDir, 'frontier.jsonl')), { mode: 0o600 });
  });
  const wait = marker => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('watchdog: ' + marker + '\n' + out + err)), 8000);
    function finish(error) { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(); }
    function check() { if (out.includes('MARK:' + marker + '\n')) finish(); else if (closed) finish(new Error('salida antes de ' + marker + '\n' + out + err)); }
    listeners.add(check); check();
  });
  await wait('ready');
  const port = Number(out.match(/^BOUND:(\d+)$/m)?.[1]);
  const events = async () => (await readFile(path.join(dataDir, 'frontier.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const command = async name => { child.stdin.write(name + '\n'); await wait(name); };
  const exit = async () => {
    let timer;
    try { return await Promise.race([ending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watchdog salida\n' + out + err)), 8000); })]); }
    finally { clearTimeout(timer); }
  };
  t.diagnostic('scratch=' + root + ' evidence=' + destination);
  return { child, port, dataDir, wait, command, events, exit, stderr: () => err, stdout: () => out };
}

function request(t, c, url, { body, partial = false } = {}) {
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port: c.port, path: url, method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text })); res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('watchdog HTTP')));
    t.after(() => req.destroy());
    if (partial) req.write(body.slice(0, -1)); else req.end(body);
  });
  response.catch(() => {}); // Preservar el fallo original si falla una puerta antes de await response.
  return { response, release: () => req.end(body.slice(-1)) };
}
const event = (events, name) => { const found = events.find(e => e.event === name); assert.ok(found, name); return found; };
function before(events, first, second) { assert.ok(events.indexOf(event(events, first)) < events.indexOf(event(events, second)), first + ' < ' + second); }
async function rejectLate(t, c) {
  const r = await request(t, c, '/api/alert/custom', { body: JSON.stringify({ text: 'Fixture rejected' }) }).response;
  assert.equal(r.status, 503); assert.deepEqual(JSON.parse(r.text), { error: 'La app se está cerrando.' });
}
function assertFinal(c, events, held) {
  const sample = event(events, 'sampled'), exit = event(events, 'exit');
  for (const name of ['capture', 'sampled', 'flush', 'exit']) assert.equal(events.filter(e => e.event === name).length, 1, name);
  assert.equal(sample.held.length, held); assert.deepEqual(exit.held, sample.held);
  assert.equal(exit.history, held); assert.equal(exit.sends, 0); assert.equal(exit.captures, 1);
  assert.equal(exit.owned, 0); assert.equal(exit.code, held ? 1 : 0);
  assert.ok(!events.some(e => ['unexpected-fetch', 'fault'].includes(e.event)), c.stdout());
  for (const log of events.filter(e => e.event === 'log')) {
    assert.equal(typeof log.message, 'string', 'cada log tiene un mensaje comprobable');
    assert.doesNotMatch(log.message, /drenado agotado|\[error\]/);
  }
  assert.equal(c.stderr(), held ? '[parada] alertas retenidas\n' : '');
  before(events, 'http-idle', 'eventsub-cut'); before(events, 'eventsub-idle', 'capture');
  before(events, 'capture', 'sampled'); before(events, 'sampled', 'flush'); before(events, 'flush', 'exit');
}

test('oráculo final rechaza deadline y errores almacenados en JSONL', () => {
  const state = { held: [{ id: 'fixture-held' }], history: 1, sends: 0, captures: 1, owned: 0, code: 1 };
  const events = ['http-idle', 'eventsub-cut', 'eventsub-idle', 'capture', 'sampled', 'flush', 'exit']
    .map(event => ({ ...state, event }));
  const child = { stdout: () => 'MARK:log\n', stderr: () => '[parada] alertas retenidas\n' };
  assertFinal(child, events, 1);
  for (const message of ['[parada] drenado agotado', '[error] fixture']) {
    const faulty = [...events.slice(0, -1), { event: 'log', message }, events.at(-1)];
    assert.throws(() => assertFinal(child, faulty, 1), { code: 'ERR_ASSERTION' },
      'el oráculo debe rechazar log.message: ' + message);
  }
});

test('HTTP custom admitido: readBody atraviesa SIGINT; post-corte no añade held', { timeout: windowsTimeout(1, 25000) }, async t => {
  const c = await launch(t, 'http');
  const accepted = request(t, c, '/api/alert/custom', { body: JSON.stringify({ text: 'Fixture accepted', vars: { user: 'Fixture HTTP' } }), partial: true });
  await c.wait('body-chunk');
  await interruptSignalChild(c.child, 'SIGINT'); await c.wait('cut');
  await rejectLate(t, c); await c.command('probe');
  const pending = await c.events();
  assert.equal(event(pending, 'body-chunk').complete, false);
  assert.equal(event(pending, 'probe').captures, 0); assert.deepEqual(event(pending, 'probe').held, []);
  assert.ok(!pending.some(e => e.event === 'http-idle'));
  accepted.release();
  const response = await accepted.response;
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).alert.text, 'Fixture accepted');
  assert.deepEqual(await c.exit(), { code: 1, signal: null });
  const events = await c.events(); assertFinal(c, events, 1);
  const held = event(events, 'sampled').held[0];
  assert.equal(held.text, 'Fixture accepted'); assert.equal(held.user, 'Fixture HTTP');
  assert.equal(held.id, JSON.parse(response.text).alert.id);
  before(events, 'body-chunk', 'cut'); before(events, 'probe', 'http-idle');
});

test('EventSub callback real: held síncrono y socket histórico retenido antes del sampler', { timeout: windowsTimeout(1, 25000) }, async t => {
  const c = await launch(t, 'eventsub');
  await interruptSignalChild(c.child, 'SIGINT'); await c.wait('eventsub-cut');
  await rejectLate(t, c); await c.command('stale');
  const pending = await c.events(), admitted = event(pending, 'admitted'), stale = event(pending, 'stale');
  assert.equal(admitted.held.length, 1); assert.equal(admitted.held[0].user, 'Fixture Follower');
  assert.deepEqual(stale.held, admitted.held); assert.equal(stale.history, 1);
  assert.equal(stale.sockets, 2); assert.equal(stale.owned, 1); assert.equal(stale.subscriptions, 7);
  assert.equal(stale.captures, 0); assert.ok(!pending.some(e => e.event === 'eventsub-idle'));
  await c.command('physical');
  assert.deepEqual(await c.exit(), { code: 1, signal: null });
  const events = await c.events(); assertFinal(c, events, 1);
  assert.deepEqual(event(events, 'exit').physical, [3, 3]); assert.deepEqual(event(events, 'exit').closes, [1, 1]);
  assert.deepEqual(event(events, 'sampled').held, admitted.held);
  before(events, 'admitted', 'cut'); before(events, 'stale', 'physical'); before(events, 'physical', 'eventsub-idle');
});

test('OAuth YouTube HTTP admitido: token/canal atraviesan SIGINT y secreto precede flush', { timeout: windowsTimeout(1, 25000) }, async t => {
  const c = await launch(t, 'oauth');
  const auth = await request(t, c, '/api/youtube/auth', { body: '{}' }).response;
  assert.equal(auth.status, 200);
  const state = new URL(JSON.parse(auth.text).url).searchParams.get('state'); assert.ok(state);
  const callback = request(t, c, '/oauth/youtube?code=fixture-code&state=' + encodeURIComponent(state));
  await c.wait('token'); await interruptSignalChild(c.child, 'SIGINT'); await c.wait('cut');
  await rejectLate(t, c); await c.command('probe');
  let events = await c.events();
  assert.equal(event(events, 'probe').captures, 0); assert.ok(!events.some(e => e.event === 'flush'));
  c.child.stdin.write('token\n'); await c.wait('channel');
  events = await c.events(); assert.ok(!events.some(e => e.event === 'http-idle'));
  const intermediate = JSON.parse(await readFile(path.join(c.dataDir, 'secrets.json'), 'utf8'));
  assert.equal(intermediate.youtube.access, 'fixture-access'); assert.equal(intermediate.youtube.refresh, 'fixture-refresh');
  c.child.stdin.write('channel\n');
  const response = await callback.response; assert.equal(response.status, 200); assert.match(response.text, /YouTube conectado.*Fixture Channel/);
  assert.deepEqual(await c.exit(), { code: 0, signal: null });
  events = await c.events(); assertFinal(c, events, 0);
  assert.equal(event(events, 'token').grant, 'authorization_code');
  assert.equal(event(events, 'channel').authorization, 'Bearer fixture-access');
  const secret = JSON.parse(await readFile(path.join(c.dataDir, 'secrets.json'), 'utf8')).youtube;
  assert.equal(secret.channel, 'Fixture Channel'); assert.equal(secret.access, 'fixture-access'); assert.equal(secret.refresh, 'fixture-refresh');
  assert.deepEqual(event(events, 'flush').youtube, secret);
  assert.equal(event(events, 'flush').persistence.pending.secrets, 0);
  assert.equal(event(events, 'exit').tokens, 1); assert.equal(event(events, 'exit').channels, 1);
  before(events, 'token', 'cut'); before(events, 'probe', 'channel'); before(events, 'channel', 'http-idle');
});
