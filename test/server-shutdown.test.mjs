import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { launchSignalChild, interruptSignalChild } from './helpers/signal-child.mjs';

const SERVER_MODULE_URL = new URL('../src/server.mjs', import.meta.url).href;
const delay = ms => new Promise(r => setTimeout(r, ms));

function shutdownInterval(from, to) {
  assert.equal(from.clock, to.clock, 'clock domains must match');
  return to.ms - from.ms;
}

// Plazo total en el reloj del hijo: draw-wait → callback del deadline, en orden y sin defaults.
const CHILD_DEADLINE_ORDER = ['draw-wait', 'stdin-data-observed', 'chat-cut', 'deadline-callback-log-observed'];
function assertChildDeadline(events, evidence = {}) {
  const ordered = CHILD_DEADLINE_ORDER.map(name => {
    const found = events.find(e => e.event === name);
    assert.ok(found, 'falta el evento del hijo ' + name + ': ' + JSON.stringify({ ...evidence, events }));
    return found;
  });
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(shutdownInterval(ordered[i - 1], ordered[i]) > 0, 'orden del hijo roto: ' + JSON.stringify({ ...evidence, events }));
  }
  const childDeadlineMs = shutdownInterval(ordered[0], ordered.at(-1));
  assert.ok(childDeadlineMs < 700, 'el deadline total corta antes de otros 500 ms tras la fase previa: '
    + JSON.stringify({ ...evidence, childDeadlineMs, events }));
  return childDeadlineMs;
}

function shutdownTrace(clock, now = () => performance.now()) {
  const origin = now(), events = {};
  return {
    mark(name) { return events[name] ??= { clock, ms: now() - origin }; },
    snapshot() {
      return { clock, events: { ...events }, transportClosed: Object.hasOwn(events, 'close'),
        exitToCloseMs: events.exit && events.close ? shutdownInterval(events.exit, events.close) : undefined };
    }
  };
}

// Hijo REAL: importa startServer de producción y solo ENGANCHA los seams que el contrato
// ODD-08a expone (`shutdownTimeoutMs`, la cola `store.chain` y los flush por instancia).
// El binding de red pide puerto 0 en el socket real, sin ventana reserva→liberación.
// Nunca copia ni reimplementa el shutdown; solo graba dominio por métodos públicos.
const CHILD_PROGRAM = `
import { startServer } from ${JSON.stringify(SERVER_MODULE_URL)};
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

// Solo este proceso de prueba: conservar listen/cierre reales y delegar al kernel
// la asignación atómica. PORT=0 por sí solo activa el fallback de producción.
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (port, host, callback) {
  return realListen.call(this, 0, host, callback);
};

const scenario = process.argv[1];
// Reloj del hijo desde este punto; no es el origen del padre ni el inicio de beginClose.
const childOrigin = scenario === 'chat-deadline' ? performance.now() : null;
const childTrace = event => {
  if (childOrigin !== null) console.log('SHUTDOWN_CHILD:' + JSON.stringify({ clock: 'child:' + process.pid, event, ms: performance.now() - childOrigin }));
};
// Observador acotado: console/exit pueden perder bytes por flush al terminar.
if (childOrigin !== null) process.once('exit', code => childTrace('exit-hook:' + code));
const opts = { quiet: true, log: m => {
  if (childOrigin !== null && m === '[parada] drenado agotado') childTrace('deadline-callback-log-observed');
  console.log('LOG:' + String(m));
  if (scenario === 'meld-log-throw' && String(m).includes('No se pudo cerrar Meld.')) throw new Error('PRIVATE_LOG_FAILURE');
} };
if (scenario === 'close-deadline' || scenario === 'deadline' || scenario === 'draw-deadline' || scenario === 'auth-deadline' || scenario === 'yt-deadline' || scenario === 'layer-deadline' || scenario === 'auto-deadline' || scenario === 'meld-deadline' || scenario === 'meld-close-deadline' || scenario === 'chat-deadline') opts.shutdownTimeoutMs = Number(process.env.CHILD_SHUTDOWN_TIMEOUT_MS || 100);

const realExit = process.exit.bind(process);
process.exit = code => { console.log('WILLEXIT:' + code); realExit(code); };

let release = () => {};
const gate = new Promise(r => { release = r; });
let onLate = () => {};
if (scenario.startsWith('vote-') || scenario.startsWith('close-') || scenario.startsWith('chat-') || scenario === 'gate' || scenario === 'repeat' || scenario === 'auth-gate' || scenario === 'yt-gate' || scenario.startsWith('layer-') || scenario.startsWith('auto-') || scenario.startsWith('meld-')) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    if (childOrigin !== null) childTrace('stdin-data-observed');
    if (String(d).includes('release')) release(); if (String(d).includes('late')) onLate(); if (String(d).includes('probe')) console.log('CHAT:PROBE');
  });
  process.stdin.resume();
} else {
  process.stdin.destroy();
}

const app = await startServer(opts);
net.Server.prototype.listen = realListen;
console.log('BOUND:' + app.server.address().port);
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;

// Dominio observable: Session, Interactive y Store deben persistir al salir sano.
app.session.record({ id: 'e1', type: 'cheer', at: new Date().toISOString(), vars: { user: 'ana', amount: 300 }, text: 'ana', sub: '' });
app.session.setThanked('e1', true);
app.session.addNote({ kind: 'winner', user: 'bea', label: 'premio' });
app.session.addToGoal('bits', 7);
app.interactive.s.questions.push({ id: 'q1', user: 'ana', platform: 'twitch', text: 'hola', at: new Date().toISOString(), status: 'pending' });
await app.store.patchConfig({ tts: { rate: 1.25 } });

if (scenario === 'gate') {
  app.store.config.tts.rate = 1.75;   // dato NUEVO aceptado en memoria, distinto del ya persistido 1.25
  app.store.chain = gate;   // trabajo aceptado de verdad: write() toma la puerta como 'after'
  app.store.write(app.store.cfgFile, app.store.config).then(() => console.log('GATE-WRITE-DONE'), () => console.log('GATE-WRITE-FAIL'));
}
if (scenario === 'interactive-fail') app.interactive.flush = () => Promise.reject(new Error('boom'));
if (scenario === 'session-reject') app.session.flush = () => Promise.reject(new Error('boom'));
if (scenario === 'session-sync-throw') app.session.flush = () => { throw new Error('sync-boom'); };
if (scenario === 'repeat') { let n = 0; app.session.flush = () => { n += 1; console.log('FLUSH:session:' + n); return gate; }; }
if (scenario === 'deadline') app.store.chain = new Promise(() => {});
if (scenario === 'store-dirty') {
  const blocker = path.join(app.store.dir, 'blocker');
  await writeFile(blocker, 'x');
  app.store.cfgFile = path.join(blocker, 'config.json');
  await app.store.write(app.store.cfgFile, app.store.config).then(() => console.log('DIRTY:no'), () => console.log('DIRTY:' + app.store.persistenceState().dirty.config));
}
if (scenario.startsWith('draw-')) {
  const config = app.store.config.interactive.giveaway;
  Object.assign(config, { rollSeconds: scenario === 'draw-deadline' ? 60 : 1, announceInChat: true, meldConfetti: true });
  app.twitch.sendChat = async () => {
    console.log('DRAW:chat');
    if (scenario === 'draw-fail') throw new Error('secret-chat-error');
  };
  Object.defineProperty(app.meld, 'connected', { value: true });
  app.meld.streamEvent = async () => {
    console.log('DRAW:confetti');
    if (scenario === 'draw-fail') throw new Error('secret-confetti-error');
  };
  app.interactive.join({ user: 'ana' });
  await app.interactive.draw();
}
if (scenario.startsWith('chat-')) {
  // Chat real por la API pública: el envío queda en vuelo hasta la liberación por stdin.
  app.twitch.sendChat = async () => {
    console.log('CHAT:SEND');
    if (scenario === 'chat-deadline') return new Promise(() => {});
    await gate;
    console.log('CHAT:SENT');
    if (scenario === 'chat-fail') throw new Error('PRIVATE_CHAT_FAILURE');
    return { is_sent: true };
  };
  app.interactive.say('hola chat').catch(() => {});
  const realChat = app.interactive.drainChat.bind(app.interactive);
  app.interactive.drainChat = () => {
    if (childOrigin !== null) childTrace('chat-cut');
    console.log('CHAT:CUT'); return realChat();
  };
  const realDraws = app.interactive.drainDraws.bind(app.interactive);
  app.interactive.drainDraws = async () => {
    await realDraws();
    if (scenario === 'chat-deadline') { childTrace('draw-wait'); console.log('CHAT:DRAW-WAIT'); await gate; }
    console.log('CHAT:DRAWS');
  };
  const realAuth = app.twitch.drainAuth.bind(app.twitch);
  app.twitch.drainAuth = () => { console.log('CHAT:AUTH'); return realAuth(); };
  const realFlush = app.session.flush.bind(app.session);
  app.session.flush = () => { console.log('CHAT:FLUSH'); return realFlush(); };
  const realInteractiveFlush = app.interactive.flush.bind(app.interactive);
  app.interactive.flush = () => { console.log('CHAT:IFLUSH'); return realInteractiveFlush(); };
}
if (scenario.startsWith('auth-')) {
  const realSecret = app.store.setSecret.bind(app.store);
  app.store.setSecret = async (...args) => {
    await gate;
    if (scenario === 'auth-reject') throw new Error('PRIVATE_AUTH_FAILURE');
    await realSecret(...args);
    console.log('AUTH:WRITE');
  };
  app.twitch.saveToken({ access_token: 'test-access', refresh_token: 'test-refresh' }).catch(() => {});
  const realDraws = app.interactive.drainDraws.bind(app.interactive);
  app.interactive.drainDraws = async () => {
    await realDraws();
    console.log('AUTH:DRAWS');
    if (scenario === 'auth-draw-fail') throw new Error('PRIVATE_DRAW_FAILURE');
  };
  const realAuth = app.twitch.drainAuth.bind(app.twitch);
  app.twitch.drainAuth = () => {
    console.log('AUTH:START');
    if (scenario === 'auth-throw') { release(); throw new Error('PRIVATE_AUTH_FAILURE'); }
    const result = realAuth();
    if (scenario !== 'auth-gate' && scenario !== 'auth-deadline') release();
    return result.then(() => { console.log('AUTH:DONE'); });
  };
  const flush = app.session.flush.bind(app.session);
  app.session.flush = () => { console.log('AUTH:FLUSH'); return flush(); };
}
if (scenario.startsWith('yt-')) {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  app.youtube.running = true;
  app.youtube.primed = true;
  app.youtube.status.liveChatId = 'fixture-chat';
  app.youtube.api = async () => {
    console.log('YT:IO'); entered(); await gate;
    if (scenario === 'yt-reject') throw new Error('PRIVATE_YT_IO');
    return { items: [{ id: 'yt-pending', authorDetails: { displayName: 'Ada' },
      snippet: { type: 'superChatEvent', superChatDetails: {
        amountMicros: '5000000', amountDisplayString: '5 EUR', currency: 'EUR', userComment: 'gracias'
      } } }] };
  };
  if (scenario === 'yt-reject') app.youtube.log = () => { throw new Error('PRIVATE_YT_LOG'); };
  app.youtube.poll().then(() => console.log('YT:RESPONSE'), () => console.log('YT:REJECTED'));
  await started;
  const realQuiesce = app.youtube.quiescePoll.bind(app.youtube);
  app.youtube.quiescePoll = () => {
    console.log('YT:CUT');
    if (scenario === 'yt-throw') { release(); throw new Error('PRIVATE_YT_THROW'); }
    const result = realQuiesce();
    if (scenario !== 'yt-gate' && scenario !== 'yt-deadline') release();
    return result.then(() => console.log('YT:DONE'));
  };
  const timers = app.timers.quiesceFires.bind(app.timers);
  app.timers.quiesceFires = async () => {
    await timers(); console.log('YT:TIMERS');
    if (scenario === 'yt-timers-fail') throw new Error('PRIVATE_TIMERS');
  };
  for (const [target, method, marker] of [
    [app.engine, 'drainActions', 'ENGINE'], [app.interactive, 'drainDraws', 'DRAWS'],
    [app.twitch, 'drainAuth', 'AUTH'], [app.session, 'flush', 'FLUSH']
  ]) {
    const original = target[method].bind(target);
    target[method] = (...args) => { console.log('YT:' + marker); return original(...args); };
  }
}
if (scenario.startsWith('layer-')) {
  // Ocultado diferido de la ruta pública: la capa se oculta tras el retardo original y el
  // setLayer puede quedar en vuelo (gate) o fallar para observar captura y drenado real.
  Object.defineProperty(app.meld, 'connected', { value: true });
  app.meld.setLayer = async (scene, layer, visible) => {
    if (visible !== false) return { scene: { id: 'scene-1', name: 'Escena' }, layer: { id: 'layer-1', name: 'Capa' } };
    console.log('LAYER:HIDE');
    await gate;
    if (scenario === 'layer-fail' || scenario === 'layer-auth-fail') throw new Error('PRIVATE_LAYER_FAILURE');
    console.log('LAYER:DONE');
    return { scene: { id: 'scene-1' }, layer: { id: 'layer-1' } };
  };
  // Fallo previo de auth: el drenado de capas debe seguir ejecutándose igualmente.
  if (scenario === 'layer-auth-fail') app.twitch.drainAuth = () => { throw new Error('PRIVATE_AUTH_FAILURE'); };
}
if (scenario.startsWith('auto-')) {
  // Inicio automático real desde el evento público de Meld: deja la transición en vuelo hasta la
  // liberación por stdin, como el resto de fixtures, sin copiar el coordinador de parada.
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const realStartNew = app.session.startNew.bind(app.session);
  app.session.startNew = (...args) => {
    console.log('AUTOSESSION:START');
    entered();
    const pending = (async () => {
      if (scenario === 'auto-deadline') return new Promise(() => {});   // cuelga sin temporizador referenciado
      await gate;
      if (scenario === 'auto-reject') throw new Error('PRIVATE_AUTO_FAILURE');
      return realStartNew(...args);
    })();
    pending.catch(() => {});   // la promesa intentada no queda huérfana en el proceso de prueba
    return pending;
  };
  onLate = () => app.meld.emit('streaming', true);
  app.meld.emit('streaming', true);
  await started;
  console.log('AUTOSESSION:PENDING');
}
if (scenario.startsWith('meld-')) {
  // API real: una RPC aceptada y un socket cuyo cierre físico controla stdin.
  const OriginalWebSocket = globalThis.WebSocket;
  class ControlledSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; }
    send(raw) { this.message = JSON.parse(raw); }
    close() {
      console.log('MELD:CLOSE'); this.readyState = 2;
      if (scenario !== 'meld-gate' && scenario !== 'meld-deadline' && scenario !== 'meld-close-deadline') this.finish();
    }
    finish() { this.readyState = 3; this.onclose?.(); this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = ControlledSocket;
  app.meld.start();
  globalThis.WebSocket = OriginalWebSocket;
  const ws = app.meld.ws;
  const rpc = app.meld.send({ type: 6, method: 10 }, true);
  const acceptedId = ws.message.id;
  rpc.then(() => console.log('MELD:RPC'), () => console.log('MELD:RPC-FAIL'));
  gate.then(() => ws.onmessage({ data: JSON.stringify({ type: 10, id: acceptedId, data: {} }) }));
  onLate = () => ws.finish();
  for (const [target, method, marker] of [
    [app.engine, 'drainActions', 'ENGINE'], [app.interactive, 'drainDraws', 'DRAWS'],
    [app.twitch, 'drainAuth', 'AUTH'], [app, 'drainLayerHides', 'LAYERS'],
    [app, 'drainAutoSession', 'AUTO']
  ]) {
    const original = target[method].bind(target);
    target[method] = async () => {
      await original();
      if (scenario === 'meld-gate') {
        // Cada etapa anterior todavía puede completar una RPC por la API real.
        const action = app.meld.send({ type: 6, method: 10 }, true);
        ws.onmessage({ data: JSON.stringify({ type: 10, id: ws.message.id, data: marker }) });
        if (await action !== marker) throw new Error('RPC anterior al corte no completada');
      }
      console.log('MELD:' + marker);
      if (marker === 'AUTO' && scenario === 'meld-auto-fail') throw new Error('PRIVATE_AUTO_FAILURE');
    };
  }
  const close = app.meld.quiesceClose.bind(app.meld);
  app.meld.quiesceClose = () => {
    console.log('MELD:CUT');
    if (scenario === 'meld-throw') throw new Error('PRIVATE_MELD_FAILURE');
    const result = close();
    if (scenario === 'meld-reject' || scenario === 'meld-log-throw') ws.finish();
    else if (scenario !== 'meld-gate' && scenario !== 'meld-deadline') release();
    return result.then(() => console.log('MELD:DONE'));
  };
  for (const [target, method, marker] of [
    [app.session, 'flush', 'SESSION'], [app.interactive, 'flush', 'INTERACTIVE'],
    [app, 'closeHttp', 'HTTP']
  ]) {
    const original = target[method].bind(target);
    target[method] = (...args) => { console.log('MELD:' + marker); return original(...args); };
  }
}
if (scenario.startsWith('close-')) {
  let flushes = 0;
  const flush = app.session.flush.bind(app.session);
  app.session.flush = () => { console.log('CLOSE:FLUSH:' + (++flushes)); return flush(); };
  if (scenario === 'close-fail') app.interactive.flush = () => Promise.reject(new Error('PRIVATE_FLUSH'));
  if (scenario === 'close-throw') app.stopAdmission = () => { throw new Error('PRIVATE_CUT'); };
  if (scenario === 'close-deadline') app.store.chain = new Promise(() => {});
  else if (scenario === 'close-gate' || scenario === 'close-mixed') {
    app.store.config.tts.rate = 1.75;
    app.store.chain = gate;
    app.store.write(app.store.cfgFile, app.store.config).catch(() => {});
  }
  let pending, reentrant;
  const stopAdmission = app.stopAdmission.bind(app);
  app.stopAdmission = () => {
    reentrant = app.close();  // reentra antes de que la llamada externa devuelva su promesa
    return stopAdmission();
  };
  onLate = () => {
    pending = app.close();
    console.log('CLOSE:REENTRANT-SAME:' + (pending === reentrant));
    console.log('CLOSE:SAME:' + (pending === app.close()));
    pending.then(code => {
      console.log('CLOSE:RESULT:' + code);
      console.log('CLOSE:LISTENING:' + app.server.listening);
      console.log('CLOSE:CACHED:' + (pending === app.close()));
    });
  };
}
if (scenario.startsWith('late-')) {
  // Trabajo tardío real (S13): un setSecret se encola DESPUÉS de la comprobación de dirty/pending
  // (closeHttp solo se llama tras ella) y antes de finish. late-held lo retiene tras una puerta que
  // nunca se libera; late-done espera a que llegue a disco antes de cerrar el transporte.
  const realCloseHttp = app.closeHttp.bind(app);
  app.closeHttp = () => {
    console.log('LATE:CHECKED');
    if (scenario === 'late-held') app.store.chain = gate;
    const write = app.store.setSecret('late', { value: 'late-secret' });
    write.then(() => console.log('LATE:WRITTEN'), () => console.log('LATE:FAILED'));
    console.log('LATE:QUEUED:' + app.store.persistenceState().pending.secrets);
    return scenario === 'late-done' ? write.then(() => realCloseHttp()) : realCloseHttp();
  };
}
if (scenario === 'vote-gate') {
  const list = app.interactive.createTierlist({ items: ['Uno'] });
  app.interactive.startVote(list.id, list.items[0].id, 60);
  app.interactive.castVote({ user: 'Ana' }, 'S');
  console.log('VOTE:INITIAL:' + JSON.stringify(app.interactive.s.vote));
  app.store.chain = gate;
  const cut = app.interactive.quiesceVoteTimer?.bind(app.interactive);
  if (cut) app.interactive.quiesceVoteTimer = () => { console.log('VOTE:CUT'); cut(); };
  const stop = app.stopAdmission.bind(app);
  app.stopAdmission = () => {
    console.log('VOTE:IDLE');
    app.interactive.castVote({ user: 'Bea' }, 'A');  // continuación de dominio admitida
    console.log('VOTE:TIMER-CLEARED:' + (app.interactive.voteTimer === null));
    return stop();
  };
}
console.log('READY');
`;

// Solo las señales positivas usan Ctrl+C en Windows; SIGTERM forzado se prueba aparte.
const positiveSignal = signal => process.platform === 'win32' && signal === 'SIGTERM' ? 'SIGINT' : signal;

async function launchChild({ dataDir, scenario, shutdownTimeoutMs, backend, onTrace }) {
  // Origen del padre: antes de lanzar; cada lanzamiento tiene un dominio relativo propio.
  const trace = scenario === 'chat-deadline' ? shutdownTrace('parent:' + process.pid + ':' + path.basename(dataDir)) : null;
  const env = { ...process.env, ANTENA_DATA: dataDir, ANTENA_MEDIA: path.join(dataDir, 'media'), PORT: '0' };
  if (shutdownTimeoutMs) env.CHILD_SHUTDOWN_TIMEOUT_MS = String(shutdownTimeoutMs);
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID;
  // Raw conserva spawn síncrono y conecta los observadores antes de cualquier yield.
  const child = backend === 'raw'
    ? spawn(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    : await launchSignalChild(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, scenario], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let out = '', err = '';
  const waiters = [];
  const notify = () => { for (const w of waiters.splice(0)) w(); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => {
    out += d;
    if (trace) for (const marker of ['CHAT:DRAW-WAIT', 'CHAT:CUT', 'LOG:[parada] drenado agotado']) {
      if (out.includes(marker)) trace.mark('observed:' + marker);
    }
    notify();
  });
  child.stderr.on('data', d => { err += d; notify(); });
  const exitInfo = new Promise(res => child.once('exit', (code, signal) => { trace?.mark('exit'); res({ code, signal }); }));
  const closeInfo = new Promise(res => child.once('close', code => { trace?.mark('close'); res(code); }));
  const reportTrace = trace ? phase => onTrace?.({ phase, parent: trace.snapshot(),
    child: out.split('\n').slice(0, -1).filter(line => line.startsWith('SHUTDOWN_CHILD:')).map(line => JSON.parse(line.slice(15)))
  }) : undefined;
  exitInfo.then(notify);
  const waitFor = async (marker, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(out + err).includes(marker)) {
      const left = end - Date.now();
      if (left <= 0) return false;
      await new Promise(r => { const t = setTimeout(r, Math.min(left, 50)); waiters.push(() => { clearTimeout(t); r(); }); });
    }
    return true;
  };
  return { child, exitInfo, closeInfo, waitFor, trace, reportTrace, release: () => { try { child.stdin.write('release\n'); } catch { /* el hijo pudo morir antes */ } },
    late: () => { try { child.stdin.write('late\n'); } catch { /* el hijo pudo morir antes */ } }, stdout: () => out, stderr: () => err };
}

// Arranca un hijo con su Temp propio y espera el marcador READY (falla con diagnóstico, no por timeout).
async function startChild(track, root, name, scenario, shutdownTimeoutMs, { backend = 'native', onTrace } = {}) {
  const dataDir = path.join(root, name);
  await mkdir(dataDir, { recursive: true });
  const c = await launchChild({ dataDir, scenario, shutdownTimeoutMs, backend, onTrace });
  track.push(c);
  const ready = await c.waitFor('READY');
  c.reportTrace?.('ready-check');
  assert.ok(ready, 'el hijo no llegó a READY (' + name + '): ' + c.stdout() + c.stderr());
  return { ...c, dataDir };
}

// Watchdog PROPIO: si el hijo no sale, se registra el fallo observado en vez de dejar que el runner corte.
// El timeout se limpia en finally: un hijo sano no deja un temporizador referenciado de 3 s.
async function awaitExit(c, ms = 3000, { waitForClose = false } = {}) {
  let timer;
  const watchdog = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const completion = waitForClose
      ? Promise.all([c.exitInfo, c.closeInfo]).then(([exit]) => exit)
      : c.exitInfo;
    const res = await Promise.race([completion, watchdog]);
    if (!res) {
      c.reportTrace?.(waitForClose ? 'close-watchdog-expired' : 'exit-watchdog-expired');
      c.child.kill('SIGKILL');
      await c.exitInfo;
      c.reportTrace?.(waitForClose ? 'close-watchdog-failure' : 'exit-watchdog-failure');
      assert.fail('el hijo no ' + (waitForClose ? 'completó salida y cierre de streams' : 'salió') + ' en ' + ms + 'ms: ' + c.stdout() + c.stderr());
    }
    // Ya salió: se espera también el cierre de sus streams (sin matar ni fallar por ello) para que
    // stdout esté completo. En Windows las últimas líneas pueden llegar después de exit y los tests
    // que leen la salida veían marcadores a medias (MELD:INTERACTIVE/HTTP tras MELD:SESSION).
    if (!waitForClose) await Promise.race([c.closeInfo, new Promise(r => setTimeout(r, 5000).unref())]);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function tempRoot() {
  return mkdtemp(path.join(tmpdir(), 'CANARY-SHUTDOWN-'));
}

function ownChildren(t, root, children) {
  t.after(async () => {
    for (const c of children) if (c.child.exitCode === null && c.child.signalCode === null) c.child.kill('SIGKILL');
    await Promise.all(children.map(c => c.exitInfo));
    await rm(root, { recursive: true, force: true });
  });
}

test('votación abierta se conserva por señales; timer se sella antes de idle y votos causales persisten', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, signal, 'vote-gate');
    const initial = JSON.parse(c.stdout().split('\n').find(line => line.startsWith('VOTE:INITIAL:')).slice(13));
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.ok(await c.waitFor('VOTE:TIMER-CLEARED:', 1500), c.stdout() + c.stderr());
    assert.match(c.stdout(), /VOTE:CUT[\s\S]*VOTE:IDLE/);
    assert.match(c.stdout(), /VOTE:TIMER-CLEARED:true/);
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    c.release();
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
    const saved = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
    assert.equal(saved.vote.endsAt, initial.endsAt);
    assert.deepEqual(saved.vote.votes, { ana: 's', bea: 'a' });
    assert.deepEqual(saved.tierlists[0].placements, {});
    assert.equal((c.stdout().match(/VOTE:CUT/g) || []).length, 1);
    assert.equal(c.stderr(), '');
  }
});

test('app.close comparte promesa reentrante y espera Store, persistencia y HTTP sin salir', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'direct', 'close-gate', undefined, { backend: 'raw' });
  c.late();
  assert.ok(await c.waitFor('CLOSE:SAME:true', 1500), c.stdout() + c.stderr());
  assert.match(c.stdout(), /CLOSE:REENTRANT-SAME:true/);
  assert.doesNotMatch(c.stdout(), /CLOSE:RESULT|WILLEXIT/);
  c.release();
  assert.ok(await c.waitFor('CLOSE:CACHED:true', 1500), c.stdout() + c.stderr());
  assert.match(c.stdout(), /CLOSE:RESULT:0\nCLOSE:LISTENING:false/);
  assert.equal(c.child.exitCode, null);
  assert.doesNotMatch(c.stdout(), /WILLEXIT/);
  assert.equal((c.stdout().match(/CLOSE:FLUSH:/g) || []).length, 1);
  const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
  assert.ok(saved.events.some(e => e.id === 'e1'));
  const interactive = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
  assert.equal(interactive.questions.length, 1);
  const config = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(config.tts.rate, 1.75);
  assert.equal(c.stderr(), '');
});

for (const scenario of ['close-fail', 'close-throw']) {
  test(`${scenario}: API devuelve 1 sin salida automática ni rechazo huérfano`, { timeout: 15000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    const c = await startChild(children, root, scenario, scenario, undefined, { backend: 'raw' });
    c.late();
    assert.ok(await c.waitFor('CLOSE:CACHED:true', 1500), c.stdout() + c.stderr());
    assert.match(c.stdout(), /CLOSE:RESULT:1/);
    assert.match(c.stdout(), /CLOSE:SAME:true/);
    assert.equal(c.child.exitCode, null);
    assert.doesNotMatch(c.stdout() + c.stderr(), /WILLEXIT|PRIVATE_|\[error\]/);
    if (scenario === 'close-fail') {
      assert.match(c.stdout(), /CLOSE:LISTENING:false/);
      assert.equal((c.stdout().match(/CLOSE:FLUSH:/g) || []).length, 1);
    }
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`app.close más ${signal} comparten transición y resultado`, { timeout: 15000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    const c = await startChild(children, root, signal, 'close-mixed');
    c.late();
    assert.ok(await c.waitFor('CLOSE:SAME:true', 1500), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal(signal));
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    assert.doesNotMatch(c.stdout(), /WILLEXIT/);
    c.release();
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
    assert.equal((c.stdout().match(/CLOSE:FLUSH:/g) || []).length, 1);
    assert.equal((c.stdout().match(/WILLEXIT:/g) || []).length, 1);
    assert.equal(c.stderr(), '');
  });
}

test('app.close mantiene deadline terminal sin señales ni consumidor que salga', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'deadline', 'close-deadline', 100, { backend: 'raw' });
  c.late();
  assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
  assert.match(c.stdout(), /CLOSE:SAME:true/);
  assert.match(c.stdout(), /\[parada\] drenado agotado/);
  assert.doesNotMatch(c.stdout(), /CLOSE:RESULT|CLOSE:CACHED/);
  assert.equal((c.stdout().match(/WILLEXIT:1/g) || []).length, 1);
  assert.equal(c.stderr(), '');
});

test('Meld espera RPC y cierre físico tras autoSession antes de persistir; señales repetidas', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, signal, 'meld-gate');
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.ok(await c.waitFor('MELD:CUT', 1500), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    assert.doesNotMatch(c.stdout(), /MELD:CLOSE|MELD:SESSION|WILLEXIT/);
    c.release();
    assert.ok(await c.waitFor('MELD:CLOSE', 1500), c.stdout() + c.stderr());
    assert.doesNotMatch(c.stdout(), /MELD:DONE|MELD:SESSION|WILLEXIT/);
    c.late();
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
    assert.equal(c.stderr(), '');
    for (const marker of ['CUT', 'CLOSE', 'SESSION', 'INTERACTIVE', 'HTTP']) {
      assert.equal((c.stdout().match(new RegExp('MELD:' + marker, 'g')) || []).length, 1, c.stdout());
    }
    const order = ['ENGINE', 'DRAWS', 'AUTH', 'LAYERS', 'AUTO', 'CUT', 'RPC', 'CLOSE', 'DONE', 'SESSION', 'HTTP'];
    for (let n = 1; n < order.length; n++) {
      assert.ok(c.stdout().indexOf('MELD:' + order[n - 1]) < c.stdout().indexOf('MELD:' + order[n]), c.stdout());
    }
  }
});

for (const scenario of ['meld-reject', 'meld-throw', 'meld-log-throw', 'meld-auto-fail', 'meld-deadline', 'meld-close-deadline']) {
  test(`${scenario}: conserva fallos y persistencia independiente bajo deadline global`, { timeout: 15000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const c = await startChild(children, root, scenario + signal, scenario, 100);
      await interruptSignalChild(c.child, positiveSignal(signal));
      assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
      assert.equal(c.stderr(), '');
      assert.doesNotMatch(c.stdout(), /PRIVATE_/);
      assert.equal((c.stdout().match(/MELD:CUT/g) || []).length, 1, c.stdout());
      if (scenario === 'meld-deadline' || scenario === 'meld-close-deadline') {
        assert.match(c.stdout(), /\[parada\] drenado agotado/);
        assert.doesNotMatch(c.stdout(), /MELD:SESSION|MELD:INTERACTIVE/);
        if (scenario === 'meld-close-deadline') assert.match(c.stdout(), /MELD:CLOSE/);
        else assert.doesNotMatch(c.stdout(), /MELD:RPC/);
      } else {
        if (scenario !== 'meld-auto-fail') assert.ok(c.stdout().split('\n').includes('LOG:[parada] No se pudo cerrar Meld.'));
        else assert.match(c.stdout(), /MELD:DONE/);
        for (const marker of ['MELD:SESSION', 'MELD:INTERACTIVE', 'MELD:HTTP']) assert.ok(c.stdout().includes(marker));
        const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
        const interactive = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
        assert.ok(saved.events.some(event => event.id === 'e1'));
        assert.equal(interactive.questions.length, 1);
        const config = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
        assert.equal(config.tts.rate, 1.25);
      }
    }
  });
}

test('YouTube pendiente se procesa antes de Engine y persistencia con señales repetidas', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const order = ['YT:TIMERS', 'YT:CUT', 'YT:RESPONSE', 'YT:DONE', 'YT:ENGINE', 'YT:DRAWS', 'YT:AUTH', 'YT:FLUSH', 'WILLEXIT:0'];
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, signal, 'yt-gate');
    // Sólo observación del padre; se conserva el oráculo de orden sin cambios.
    const snapshot = () => order.map(marker => c.stdout().indexOf(marker));
    let atExit = null, atClose = null, atAssertion = null;
    const observeExit = () => { atExit = snapshot(); };
    const observeClose = () => { atClose = snapshot(); };
    c.child.once('exit', observeExit);
    c.child.once('close', observeClose);
    t.after(() => {
      if (atAssertion) t.diagnostic('YT_ORDER ' + JSON.stringify({ signal, atAssertion, atExit, atClose, atReport: snapshot() }));
      c.child.removeListener('exit', observeExit);
      c.child.removeListener('close', observeClose);
    });
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.ok(await c.waitFor('YT:CUT', 1500), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    await delay(100);
    assert.equal(c.child.exitCode, null);
    assert.doesNotMatch(c.stdout(), /YT:ENGINE|YT:FLUSH|WILLEXIT/);
    c.release();
    assert.deepEqual(await awaitExit(c, 3000, { waitForClose: true }), { code: 0, signal: null });
    assert.equal(c.stderr(), '');
    assert.equal((c.stdout().match(/YT:CUT/g) || []).length, 1);
    assert.equal((c.stdout().match(/YT:IO/g) || []).length, 1);
    try {
      for (let n = 1; n < order.length; n++) assert.ok(c.stdout().indexOf(order[n - 1]) < c.stdout().indexOf(order[n]), c.stdout());
    } catch (error) {
      atAssertion = snapshot();
      throw error;
    }
    const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
    const event = saved.events.find(event => event.type === 'superchat');
    assert.equal(event?.user, 'Ada');
    assert.equal(event.vars.amount, 5);
  }
});

for (const scenario of ['yt-reject', 'yt-throw', 'yt-timers-fail', 'yt-deadline']) {
  test(`${scenario}: conserva fallo, drenajes independientes y deadline global`, { timeout: 15000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const c = await startChild(children, root, scenario + signal, scenario, 100);
      await interruptSignalChild(c.child, positiveSignal(signal));
      assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
      assert.equal(c.stderr(), '');
      assert.doesNotMatch(c.stdout(), /PRIVATE_/);
      assert.equal((c.stdout().match(/YT:CUT/g) || []).length, 1);
      if (scenario === 'yt-deadline') {
        assert.match(c.stdout(), /\[parada\] drenado agotado/);
        assert.doesNotMatch(c.stdout(), /YT:RESPONSE|YT:ENGINE|YT:FLUSH/);
      } else {
        if (scenario !== 'yt-timers-fail') assert.ok(c.stdout().split('\n').includes('LOG:[parada] No se pudo cerrar YouTube.'));
        for (const marker of ['YT:ENGINE', 'YT:DRAWS', 'YT:AUTH', 'YT:FLUSH']) assert.match(c.stdout(), new RegExp(marker));
        const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
        const interactive = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
        assert.ok(saved.events.some(event => event.id === 'e1'));
        assert.equal(interactive.questions.length, 1);
        if (scenario === 'yt-timers-fail') assert.ok(saved.events.some(event => event.type === 'superchat'));
      }
    }
  });
}

test('auth pendiente se espera después de sorteos; señales repetidas no duplican el snapshot', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, signal, 'auth-gate');
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.ok(await c.waitFor('AUTH:START', 1500), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    await delay(100);
    assert.equal(c.child.exitCode, null);
    assert.doesNotMatch(c.stdout(), /AUTH:FLUSH|AUTH:WRITE|WILLEXIT/);
    c.release();
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
    assert.equal(c.stderr(), '');
    assert.equal((c.stdout().match(/AUTH:START/g) || []).length, 1);
    const order = ['AUTH:DRAWS', 'AUTH:START', 'AUTH:WRITE', 'AUTH:DONE', 'AUTH:FLUSH', 'WILLEXIT:0'];
    for (let n = 1; n < order.length; n++) assert.ok(c.stdout().indexOf(order[n - 1]) < c.stdout().indexOf(order[n]), c.stdout());
    const secrets = JSON.parse(await readFile(path.join(c.dataDir, 'secrets.json'), 'utf8'));
    assert.equal(secrets.twitch.access, 'test-access');
    assert.equal(secrets.twitch.refresh, 'test-refresh');
  }
});

for (const scenario of ['auth-reject', 'auth-throw', 'auth-draw-fail', 'auth-deadline']) {
  test(`${scenario}: señal real conserva fallo y persistencia independiente o deadline`, { timeout: 10000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const c = await startChild(children, root, scenario + signal, scenario, 100);
      await interruptSignalChild(c.child, positiveSignal(signal));
      assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
      assert.equal(c.stderr(), '');
      assert.doesNotMatch(c.stdout(), /PRIVATE_|test-access|test-refresh/);
      assert.equal((c.stdout().match(/AUTH:START/g) || []).length, 1);
      if (scenario === 'auth-deadline') {
        assert.ok(c.stdout().split('\n').includes('LOG:[parada] drenado agotado'));
        assert.doesNotMatch(c.stdout(), /AUTH:WRITE|AUTH:FLUSH/);
      } else {
        const message = scenario === 'auth-draw-fail' ? 'No se pudieron completar los sorteos.' : 'No se pudo drenar la autenticación de Twitch.';
        assert.ok(c.stdout().split('\n').includes('LOG:[parada] ' + message));
        const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
        const interactive = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
        const config = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
        assert.equal(saved.events.length, 1);
        assert.equal(interactive.questions.length, 1);
        assert.equal(config.tts.rate, 1.25);
        if (scenario === 'auth-draw-fail') assert.match(c.stdout(), /AUTH:WRITE/);
      }
    }
  });
}

test('señales reales drenan sorteo completo, persisten historial pese a errores y respetan deadline', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    for (const scenario of ['draw-ok', 'draw-fail', 'draw-deadline']) {
      const c = await startChild(children, root, scenario + signal, scenario, 100);
      await interruptSignalChild(c.child, positiveSignal(signal));
      assert.deepEqual(await awaitExit(c), { code: scenario === 'draw-ok' ? 0 : 1, signal: null });
      assert.equal(c.stderr(), '', c.stdout());
      assert.doesNotMatch(c.stdout(), /secret-chat-error|secret-confetti-error/);
      if (scenario === 'draw-deadline') {
        assert.match(c.stdout(), /\[parada\] drenado agotado/);
        assert.doesNotMatch(c.stdout(), /DRAW:/, 'no debe adelantar el sorteo');
      } else {
        assert.equal((c.stdout().match(/DRAW:chat/g) || []).length, 1);
        assert.equal((c.stdout().match(/DRAW:confetti/g) || []).length, 1);
        const saved = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
        assert.equal(saved.giveawayHistory.length, 1);
        assert.equal(saved.giveawayHistory[0].winner, 'ana');
        if (scenario === 'draw-fail') assert.match(c.stdout(), /No se pudieron completar los sorteos/);
      }
    }
  }
});

test('chat pendiente: la señal espera drainChat tras sorteos y antes de auth; señales repetidas no duplican', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'chat-gate-' + signal, 'chat-gate');
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.ok(await c.waitFor('CHAT:CUT', 1500), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    c.child.stdin.write('probe\n');
    assert.ok(await c.waitFor('CHAT:PROBE', 1500), c.stdout());
    assert.equal(c.child.exitCode, null, 'no debe salir con el envío en vuelo: ' + c.stdout());
    assert.doesNotMatch(c.stdout(), /CHAT:AUTH|CHAT:FLUSH|WILLEXIT/);
    c.release();
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
    assert.equal(c.stderr(), '');
    assert.equal((c.stdout().match(/CHAT:CUT/g) || []).length, 1, 'señales repetidas no duplican el snapshot');
    const order = ['CHAT:DRAWS', 'CHAT:CUT', 'CHAT:SENT', 'CHAT:AUTH', 'CHAT:FLUSH', 'WILLEXIT:0'];
    for (let n = 1; n < order.length; n++) assert.ok(c.stdout().indexOf(order[n - 1]) < c.stdout().indexOf(order[n]), c.stdout());
    const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
    assert.equal(inter.questions.length, 1, 'Interactive persiste tras drenar el chat');
  }
});

test('chat rechazado: exit 1 con aviso constante y flush independiente de Session/Store', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'chat-fail', 'chat-fail');
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  assert.ok(await c.waitFor('CHAT:CUT', 1500), c.stdout() + c.stderr());
  c.release();
  assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
  assert.equal(c.stderr(), '');
  assert.doesNotMatch(c.stdout(), /PRIVATE_CHAT_FAILURE/);
  assert.ok(c.stdout().split('\n').includes('LOG:[parada] No se pudieron completar los mensajes del chat.'));
  for (const marker of ['CHAT:DRAWS', 'CHAT:AUTH', 'CHAT:FLUSH', 'CHAT:IFLUSH']) assert.match(c.stdout(), new RegExp(marker));
  const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
  const config = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(inter.questions.length, 1, 'Interactive persiste pese al fallo de chat');
  assert.equal(config.tts.rate, 1.25, 'Store persiste pese al fallo de chat');
});

test('shutdown-trace: rechaza restas entre relojes de procesos distintos', () => {
  assert.throws(() => shutdownInterval({ clock: 'child', ms: 20 }, { clock: 'parent', ms: 30 }), /clock domains/);
  assert.equal(shutdownInterval({ clock: 'parent', ms: 20 }, { clock: 'parent', ms: 30 }), 10);
});

test('shutdown-trace: exit sin close no implica transporte cerrado', () => {
  let now = 100;
  const trace = shutdownTrace('parent', () => now);
  now = 120;
  trace.mark('exit');
  assert.equal(trace.snapshot().transportClosed, false);
  assert.equal(trace.snapshot().events.close, undefined);
  now = 125;
  trace.mark('close');
  const snapshot = trace.snapshot();
  assert.equal(snapshot.transportClosed, true);
  assert.equal(shutdownInterval(snapshot.events.exit, snapshot.events.close), 5);
  assert.equal(snapshot.exitToCloseMs, 5);
});

const childDeadlineShape = (callbackMs, callbackClock = 'child:1') => [
  { clock: 'child:1', event: 'draw-wait', ms: 10 },
  { clock: 'child:1', event: 'stdin-data-observed', ms: 312 },
  { clock: 'child:1', event: 'chat-cut', ms: 313 },
  { clock: callbackClock, event: 'deadline-callback-log-observed', ms: callbackMs }
];

test('shutdown-trace: el deadline total del hijo (~500 ms tras draw-wait) pasa', () => {
  assert.equal(assertChildDeadline(childDeadlineShape(510)), 500);
});

test('shutdown-trace: un deadline reiniciado tras la fase previa (~800 ms) falla', () => {
  assert.throws(() => assertChildDeadline(childDeadlineShape(813)), /el deadline total corta antes de otros 500 ms/);
});

test('shutdown-trace: sin callback del deadline en el hijo falla con evidencia', () => {
  assert.throws(() => assertChildDeadline(childDeadlineShape(510).slice(0, 3)), /deadline-callback-log-observed/);
});

test('shutdown-trace: el plazo del hijo rechaza relojes mezclados', () => {
  assert.throws(() => assertChildDeadline(childDeadlineShape(510, 'parent:1')), /clock domains/);
});

test('chat-deadline: el deadline total corta un envío colgado tras las esperas previas con exit 1', { timeout: 25000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const timing = { requestedSignal: signal, effectiveSignal: positiveSignal(signal),
      requestedDelivery: process.platform === 'win32' ? 'CTRL_C_EVENT' : 'POSIX-signal' };
    const c = await startChild(children, root, 'chat-deadline-' + signal, 'chat-deadline', 500, {
      onTrace: trace => t.diagnostic('SHUTDOWN_TRACE ' + JSON.stringify({ ...timing, ...trace }))
    });
    // También se observa close si un assert falla; su espera nunca entra en elapsedMs.
    t.after(async () => {
      await awaitExit(c, 2000, { waitForClose: true });
      c.reportTrace('close-after-cleanup');
    });
    try {
      const started = Date.now();
      c.trace.mark('interrupt-request');
      const acknowledgement = await interruptSignalChild(c.child, timing.effectiveSignal);
      c.trace.mark('interrupt-ack'); // En POSIX sólo aceptación de kill, no entrega al hijo.
      timing.acknowledgedDelivery = process.platform === 'win32' ? acknowledgement.event : 'kill-accepted';
      timing.interruptAckMs = Date.now() - started;
      const drawWait = await c.waitFor('CHAT:DRAW-WAIT', 1500);
      timing.drawWaitMs = Date.now() - started;
      c.reportTrace('draw-wait-check');
      assert.ok(drawWait, c.stdout());
      await delay(300); c.release(); // consume plazo previo; la sincronización usa marcadores/gate
      c.trace.mark('release-request');
      timing.releaseMs = Date.now() - started;
      const chatCut = await c.waitFor('CHAT:CUT', 1500);
      timing.chatCutMs = Date.now() - started;
      c.reportTrace('chat-cut-check');
      assert.ok(chatCut, c.stdout() + c.stderr());
      // Se espera close, no solo exit: en Windows las últimas líneas de stdout (entre ellas el
      // evento deadline-callback-log-observed, que el hijo escribe justo antes de salir) pueden
      // llegar después de exit (#83). El plazo se mide en el reloj del hijo, no aquí.
      // margen amplio solo para el cierre de streams: en Windows puede tardar segundos tras salir
      // y no forma parte del plazo, que se mide en el reloj del hijo (assertChildDeadline)
      const exit = await awaitExit(c, 6000, { waitForClose: true });
      timing.elapsedMs = Date.now() - started;
      c.trace.mark('await-exit-continuation');
      c.reportTrace('exit-check'); // Antes de todos los asserts terminales, incluido el plazo del hijo.
      assert.deepEqual(exit, { code: 1, signal: null });
      // El límite vive en el reloj del hijo: la entrega de Ctrl+C en Windows y la publicación
      // del exit al padre quedan fuera del deadline. elapsedMs sigue como diagnóstico.
      // Solo líneas terminadas.
      const childEvents = c.stdout().split('\n').slice(0, -1).filter(line => line.startsWith('SHUTDOWN_CHILD:'))
        .map(line => JSON.parse(line.slice(15)));
      timing.childExitHook = childEvents.find(e => e.event.startsWith('exit-hook:'))?.event ?? 'absent';
      timing.childDeadlineMs = assertChildDeadline(childEvents, { timing });
      assert.equal(c.stderr(), '');
      assert.ok(c.stdout().split('\n').includes('LOG:[parada] drenado agotado'));
      assert.doesNotMatch(c.stdout(), /CHAT:AUTH|CHAT:FLUSH|WILLEXIT:0/);
    } finally {
      c.reportTrace('partial-or-terminal');
    }
  }
});

test('el fixture asigna el puerto en el hijo sin reservar y liberar uno en el padre', async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  t.mock.method(net, 'createServer', () => { throw new Error('reserva previa de puerto prohibida'); });
  const c = await startChild(children, root, 'kernel-port', 'healthy');
  const port = Number(c.stdout().match(/^BOUND:(\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, 'socket real con puerto asignado por el kernel');
  await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
});

test('shutdown espera la cola aceptada de Store y luego sale 0', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'gate', 'gate');
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  await delay(300);
  assert.equal(c.child.exitCode, null, 'no debe salir mientras hay trabajo aceptado sin drenar: ' + c.stdout() + c.stderr());
  assert.equal(c.stdout().includes('WILLEXIT'), false, 'no debe intentar salir antes de drenar la cola');
  c.release();
  assert.ok(await c.waitFor('GATE-WRITE-DONE'), 'la escritura aceptada debe completarse tras liberar');
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
  const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
  assert.equal(cfg.tts.rate, 1.75, 'el dato aceptado tras la puerta debe quedar persistido, no el viejo 1.25');
  const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
  assert.equal(saved.events.length, 1);
  const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
  assert.equal(inter.questions.length, 1);
});

test('el fallo de Interactive fuerza exit 1 con SIGINT y SIGTERM', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'ifail-' + sig, 'interactive-fail');
    await interruptSignalChild(c.child, positiveSignal(sig));
    assert.deepEqual(await awaitExit(c), { code: 1, signal: null }, sig);
    assert.doesNotMatch(c.stdout() + c.stderr(), /CANARY|ENOTDIR/);
  }
});

test('un fallo de escritura de Store deja dirty y fuerza exit 1', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'dirty', 'store-dirty');
  assert.ok(await c.waitFor('DIRTY:true'), 'la escritura fallida debe dejar dirty visible: ' + c.stdout());
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
  assert.doesNotMatch(c.stdout() + c.stderr(), /CANARY|ENOTDIR|blocker/);
});

async function readSecrets(dataDir) {
  try { return JSON.parse(await readFile(path.join(dataDir, 'secrets.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}

test('S13: un setSecret encolado tras la comprobación de persistencia y retenido al salir fuerza exit 1', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'late-held-' + sig, 'late-held');
    await interruptSignalChild(c.child, positiveSignal(sig));
    const exit = await awaitExit(c);
    assert.match(c.stdout(), /LATE:CHECKED\nLATE:QUEUED:1\n/, c.stdout());
    assert.deepEqual(exit, { code: 1, signal: null }, 'la escritura tardía retenida no puede perderse con 0: ' + c.stdout());
    assert.equal((c.stdout().match(/WILLEXIT:/g) || []).length, 1);
    assert.match(c.stdout(), /WILLEXIT:1/);
    assert.doesNotMatch(c.stdout(), /LATE:WRITTEN|LATE:FAILED/);
    assert.equal((await readSecrets(c.dataDir)).late, undefined);
    const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
    assert.ok(saved.events.some(e => e.id === 'e1'), 'la persistencia independiente se conserva');
    assert.equal(c.stderr(), '');
  }
});

test('S13: un setSecret tardío que llega a disco antes de finish conserva exit 0', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'late-done-' + sig, 'late-done');
    await interruptSignalChild(c.child, positiveSignal(sig));
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null }, c.stdout());
    assert.match(c.stdout(), /LATE:CHECKED\nLATE:QUEUED:1\n[\s\S]*LATE:WRITTEN\n[\s\S]*WILLEXIT:0/);
    assert.equal((c.stdout().match(/WILLEXIT:/g) || []).length, 1);
    assert.deepEqual((await readSecrets(c.dataDir)).late, { value: 'late-secret' });
    assert.equal(c.stderr(), '');
  }
});

test('un rechazo de Session no salta el flush de Interactive y sale 1', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'srej', 'session-reject');
  await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
  assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
  const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
  assert.equal(inter.questions.length, 1, 'Interactive debe persistir pese al fallo de Session');
});

test('un throw síncrono de Session no salta a Interactive y sale 1', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'ssync', 'session-sync-throw');
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
  const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
  assert.equal(inter.questions.length, 1, 'Interactive debe drenar pese al throw síncrono de Session');
});

test('señales repetidas se ignoran: un solo flush y sin corte por defecto', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'repeat', 'repeat');
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  assert.ok(await c.waitFor('FLUSH:session:1'), 'el primer drain debe empezar: ' + c.stdout());
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
  await delay(250);
  assert.equal(c.child.exitCode, null, 'las señales repetidas no deben cortar el proceso');
  assert.equal((c.stdout().match(/FLUSH:session/g) || []).length, 1, 'no debe haber un segundo flush');
  c.release();
  assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
  assert.equal((c.stdout().match(/FLUSH:session/g) || []).length, 1);
});

test('el deadline de shutdown corta un drain bloqueado con exit 1', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  const c = await startChild(children, root, 'deadline', 'deadline', 100);
  await interruptSignalChild(c.child, positiveSignal('SIGINT'));
  assert.deepEqual(await awaitExit(c, 1500), { code: 1, signal: null });
});

test('shutdown sano por SIGINT/SIGTERM sale 0 y conserva Store/Session/Interactive', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'ok-' + sig, 'healthy');
    await interruptSignalChild(c.child, positiveSignal(sig));
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null }, sig);
    const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
    assert.equal(cfg.tts.rate, 1.25);
    const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
    assert.equal(saved.events.length, 1);
    assert.equal(saved.notes.length, 1);
    assert.equal(saved.goalOffsets.bits, 7);
    const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
    assert.equal(inter.questions.length, 1);
    assert.doesNotMatch(c.stdout() + c.stderr(), /CANARY/);
  }
  if (process.platform === 'win32') {
    // SIGTERM fuerza la salida: ni inicia el flush retenido ni intenta drenar.
    const c = await startChild(children, root, 'forced-term', 'repeat');
    c.child.kill('SIGTERM');
    assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
    assert.doesNotMatch(c.stdout() + c.stderr(), /FLUSH:session|WILLEXIT:|\[parada\]/);
  }
});

// Dispara el horario público de capas en el hijo real (puerto asignado por el kernel).
async function postLayerChild(c, body) {
  const port = Number(c.stdout().match(/^BOUND:(\d+)$/m)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, 'puerto del kernel en el hijo: ' + c.stdout());
  return fetch(`http://127.0.0.1:${port}/api/meld/layer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

for (const scenario of ['layer-gate', 'layer-fail', 'layer-auth-fail']) {
  test(`${scenario}: señal real drena el ocultado diferido y persiste pese al fallo`, { timeout: 20000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const c = await startChild(children, root, scenario + '-' + signal, scenario);
      const response = await postLayerChild(c, { scene: 'Escena', layer: 'Capa', visible: true, seconds: 0.05 });
      assert.equal(response.status, 200);
      assert.ok(await c.waitFor('LAYER:HIDE', 2000), c.stdout() + c.stderr());
      await interruptSignalChild(c.child, positiveSignal(signal));
      await interruptSignalChild(c.child, positiveSignal('SIGINT'));
      await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
      await delay(150);
      assert.equal(c.child.exitCode, null, 'no debe salir con el ocultado en vuelo: ' + c.stdout() + c.stderr());
      assert.doesNotMatch(c.stdout(), /LAYER:DONE|WILLEXIT/);
      c.release();
      assert.deepEqual(await awaitExit(c), { code: scenario === 'layer-gate' ? 0 : 1, signal: null });
      assert.equal(c.stderr(), '');
      assert.equal((c.stdout().match(/LAYER:HIDE/g) || []).length, 1, 'señales repetidas no duplican la captura');
      assert.doesNotMatch(c.stdout(), /PRIVATE_LAYER_FAILURE|PRIVATE_AUTH_FAILURE/);
      if (scenario === 'layer-gate') assert.equal((c.stdout().match(/LAYER:DONE/g) || []).length, 1);
      else assert.ok(c.stdout().split('\n').includes('LOG:[parada] No se pudo completar el ocultado diferido de capas de Meld.'));
      if (scenario === 'layer-auth-fail') assert.ok(c.stdout().split('\n').includes('LOG:[parada] No se pudo drenar la autenticación de Twitch.'));
      const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
      const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
      assert.ok(saved.events.some(e => e.id === 'e1'), 'Session persiste pese al fallo del ocultado');
      assert.equal(inter.questions.length, 1, 'Interactive persiste pese al fallo del ocultado');
    }
  });
}

test('layer-deadline: el deadline global corta un ocultado diferido largo con exit 1', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'layer-deadline-' + signal, 'layer-deadline', 100);
    const response = await postLayerChild(c, { scene: 'Escena', layer: 'Capa', visible: true, seconds: 60 });
    assert.equal(response.status, 200);
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.deepEqual(await awaitExit(c, 2000), { code: 1, signal: null });
    assert.equal(c.stderr(), '');
    assert.ok(c.stdout().split('\n').includes('LOG:[parada] drenado agotado'));
    assert.doesNotMatch(c.stdout(), /LAYER:HIDE|LAYER:DONE|WILLEXIT:0/);
  }
});

// ODD-08: cierre del inicio automático de sesión de Meld. El hijo real engancha startNew para
// dejar la transición en vuelo; señales, orden y persistencia son las de producción.
test('autoSession: la señal espera el inicio pendiente; repetidos y evento tardío no duplican', { timeout: 20000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'auto-gate-' + signal, 'auto-gate');
    assert.ok(await c.waitFor('AUTOSESSION:PENDING', 2000), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal(signal));
    await interruptSignalChild(c.child, positiveSignal('SIGINT'));
    await interruptSignalChild(c.child, positiveSignal('SIGTERM'));
    await delay(150);
    assert.equal(c.child.exitCode, null, 'no debe salir con el inicio automático en vuelo: ' + c.stdout() + c.stderr());
    assert.doesNotMatch(c.stdout(), /WILLEXIT/);
    c.late();   // evento posterior al sello: debe ignorarse
    await delay(100);
    assert.equal((c.stdout().match(/AUTOSESSION:START/g) || []).length, 1, 'el evento tardío tras el sello se ignora');
    c.release();
    assert.deepEqual(await awaitExit(c), { code: 0, signal: null });
    assert.equal(c.stderr(), '');
    assert.equal((c.stdout().match(/AUTOSESSION:START/g) || []).length, 1, 'señales repetidas no duplican el inicio');
    const [name] = await readdir(path.join(c.dataDir, 'sessions'));
    const archived = JSON.parse(await readFile(path.join(c.dataDir, 'sessions', name), 'utf8'));
    assert.ok(archived.events.some(e => e.id === 'e1'), 'el inicio real archivó el directo anterior');
    assert.equal(typeof archived.endedAt, 'string');
    const current = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
    assert.notEqual(current.id, archived.id, 'el nuevo directo quedó como actual');
  }
});

for (const scenario of ['auto-reject']) {
  test(`${scenario}: el fallo capturado durante el cierre sale 1 con mensaje constante y persiste`, { timeout: 20000 }, async t => {
    const root = await tempRoot(); const children = []; ownChildren(t, root, children);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const c = await startChild(children, root, scenario + signal, scenario);
      assert.ok(await c.waitFor('AUTOSESSION:PENDING', 2000), c.stdout() + c.stderr());
      await interruptSignalChild(c.child, positiveSignal(signal));
      await delay(120);
      assert.equal(c.child.exitCode, null, 'no debe salir con el inicio capturado en vuelo: ' + c.stdout() + c.stderr());
      c.release();   // el fallo se asienta durante el resto del cierre
      assert.deepEqual(await awaitExit(c), { code: 1, signal: null });
      assert.equal(c.stderr(), '');
      assert.doesNotMatch(c.stdout(), /PRIVATE_/);
      assert.ok(c.stdout().split('\n').includes('LOG:[parada] No se pudo completar el inicio automático de sesión de Meld.'));
      assert.equal((c.stdout().match(/AUTOSESSION:START/g) || []).length, 1);
      const saved = JSON.parse(await readFile(path.join(c.dataDir, 'session-current.json'), 'utf8'));
      const inter = JSON.parse(await readFile(path.join(c.dataDir, 'interactive.json'), 'utf8'));
      const cfg = JSON.parse(await readFile(path.join(c.dataDir, 'config.json'), 'utf8'));
      assert.ok(saved.events.some(e => e.id === 'e1'), 'Session persiste pese al fallo capturado');
      assert.equal(inter.questions.length, 1, 'Interactive persiste pese al fallo capturado');
      assert.equal(cfg.tts.rate, 1.25, 'Store persiste pese al fallo capturado');
    }
  });
}

test('auto-deadline: el deadline global corta un inicio automático colgado con exit 1', { timeout: 15000 }, async t => {
  const root = await tempRoot(); const children = []; ownChildren(t, root, children);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const c = await startChild(children, root, 'auto-deadline-' + signal, 'auto-deadline', 100);
    assert.ok(await c.waitFor('AUTOSESSION:PENDING', 2000), c.stdout() + c.stderr());
    await interruptSignalChild(c.child, positiveSignal(signal));
    assert.deepEqual(await awaitExit(c, 2000), { code: 1, signal: null });
    assert.equal(c.stderr(), '');
    assert.ok(c.stdout().split('\n').includes('LOG:[parada] drenado agotado'));
    assert.doesNotMatch(c.stdout(), /WILLEXIT:0|PRIVATE_/);
  }
});
