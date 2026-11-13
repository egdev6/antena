// Shared browser helpers: each page gets its own Chrome process and profile.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function findChrome() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'].filter(Boolean)) {
    try { await stat(p); return p; } catch {}
  }
  return null;
}

/** El test se omite (con motivo) si no hay interfaz compilada o no hay Chrome. */
export async function skipIfNoBrowserOrUi(t) {
  try { await stat(new URL('../../app/dist/index.html', import.meta.url)); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return t.skip('sin app/dist/index.html; compila la interfaz con pnpm app:build para ejecutar las pruebas React');
  }
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la regresión de navegador');
  return bin;
}

const childStates = new WeakMap();
const closeTasks = new WeakMap();

// Only fixed classifications are emitted: raw stderr can contain paths, URLs or user data.
const startupReasons = [
  [/File name too long/i, 'File name too long'],
  [/\b(?:bind|socket).*failed/i, 'socket operation failed'],
  [/Failed to (?:create|bind).*socket/i, 'socket operation failed'],
  [/Failed to create.*ProcessSingleton/i, 'ProcessSingleton creation failed'],
  [/Failed to create.*SingletonLock/i, 'SingletonLock creation failed'],
  [/Failed to connect to the bus/i, 'D-Bus connection failed'],
  [/Failed to connect to socket/i, 'socket connect failed'],
  [/crashpad/i, 'Crashpad diagnostic'],
  [/\bFATAL\b/i, 'fatal Chrome error'],
  [/Check failed/i, 'Chrome check failed'],
  [/pthread_create/i, 'thread creation failed'],
  [/No usable sandbox/i, 'No usable sandbox'],
  [/running as root without --no-sandbox/i, 'root sandbox unavailable'],
  [/Resource temporarily unavailable/i, 'Resource temporarily unavailable'],
  [/Too many open files/i, 'Too many open files'],
  [/No space left on device/i, 'No space left on device'],
  [/Permission denied/i, 'Permission denied'],
  [/Address already in use/i, 'Address already in use'],
  [/No such file or directory/i, 'No such file or directory'],
];
const validSignals = new Set(Object.keys(constants.signals));

function observeStartupStderr(child) {
  const limit = 4096;
  let tail = Buffer.alloc(0), truncated = false;
  child.stderr.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (tail.length + bytes.length > limit) truncated = true;
    tail = bytes.length >= limit ? Buffer.from(bytes.subarray(-limit)) :
      Buffer.concat([tail, bytes]).subarray(-limit);
  });
  return () => {
    const stderrTail = tail.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-8).map(line => {
      const reasons = [...new Set(startupReasons.filter(([pattern]) => pattern.test(line)).map(([, reason]) => reason))];
      return reasons.length ? reasons.join('; ') : '[redacted]';
    }).join('\n').slice(-1000);
    return { exitCode: Number.isInteger(child.exitCode) ? child.exitCode : null,
      signal: validSignals.has(child.signalCode) ? child.signalCode : null,
      stderrTail, stderrTruncated: truncated };
  };
}

function trackChild(child) {
  let state = childStates.get(child);
  if (state) return state;
  state = { closed: false, error: null };
  // Install this at spawn time so exit before cleanup cannot hide the later close event.
  state.done = new Promise(resolve => {
    const finish = () => { state.closed = true; child.removeListener('close', finish); resolve(); };
    child.once('close', finish);
    const exited = child.exitCode !== null || child.signalCode !== null;
    const streamsOpen = child.connected || child.stdio?.some(stream => stream && !stream.closed);
    // An externally launched child may already have emitted close before being tracked.
    if (exited && !streamsOpen) setImmediate(finish);
  });
  child.on('error', error => { state.error = error; });
  childStates.set(child, state);
  return state;
}

async function closesWithin(done, ms) {
  let timer;
  try {
    return await Promise.race([done.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

/** Close CDP and Chrome once, then best-effort remove its temporary profile. */
export function closeChrome(chrome) {
  if (closeTasks.has(chrome)) return closeTasks.get(chrome);
  const task = (async () => {
    const { child, cdp, profile } = chrome;
    try {
      try { cdp?.close(); } catch { /* The socket may already be closed. */ }
      if (child) {
        const state = trackChild(child);
        if (!state.closed && child.exitCode === null && child.signalCode === null) child.kill();
        if (!await closesWithin(state.done, 1500)) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          if (!await closesWithin(state.done, 3000)) throw new Error('Chrome process did not close after forced shutdown');
        }
      }
    } finally {
      // Chrome descendants can still hold profile files after the browser closes.
      if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => {});
    }
  })();
  closeTasks.set(chrome, task);
  return task;
}

/** Open a headless page and return its child, CDP connection, and temporary profile. */
export async function openChromePage(bin, url) {
  const profile = await mkdtemp(path.join(tmpdir(), 'egdev-chrome-'));
  const chrome = { profile };
  try {
    const child = chrome.child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio', '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const startupDiagnostic = observeStartupStderr(child);
    const state = trackChild(child);
    const checkStartup = () => {
      if (state.error) throw state.error;
      if (state.closed) {
        const startup = startupDiagnostic();
        throw Object.assign(new Error(`Chrome exited during startup; ${JSON.stringify(startup)}`), { startup });
      }
    };
    let port, page;
    // The first Chrome start on a fresh CI runner (cold profile and font cache) took over 15 s
    // once on ubuntu Node 24: the port wait gets 30 s, and the error names the phase that failed.
    for (let i = 0; i < 300 && !port; i++) {
      checkStartup();
      try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch { await sleep(100); }
    }
    checkStartup();
    if (!port) throw new Error('Chrome no arrancó: no escribió DevToolsActivePort en 30 s');
    for (let i = 0; i < 100 && !page; i++) {
      checkStartup();
      page = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => [])).find(x => x.type === 'page' && x.url === 'about:blank');
      if (!page) await sleep(100);
    }
    checkStartup();
    if (!page) throw new Error('Chrome no expuso la página');
    const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const waiters = new Map();
    const cdp = chrome.cdp = { send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiters.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ev => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id); m.error ? w.reject(Object.assign(new Error('CDP: comando rechazado'), { code: m.error.code })) : w.resolve(m.result); };
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const nav = await cdp.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error('Chrome no navegó a la página: ' + nav.errorText);
    return chrome;
  } catch (error) {
    try { await closeChrome(chrome); } catch (cleanupError) { error.cleanupError = cleanupError; }
    throw error;
  }
}

/** Espera hasta que una expresión del DOM sea cierta (waitChromeDom ya trae diagnóstico). */
export { waitChromeDom as waitDom } from './chrome-dom.mjs';

// Localizador por texto dentro de un contenedor: los botones de la interfaz React no tienen
// ids estables y muchos llevan un <small> con subtítulo, así que se compara por prefijo.
export const buttonByText = text =>
  `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}))`;

// Clic con reintento: bajo carga el DOM se re-renderiza y el elemento puede ausentarse
// un instante; se pulsa en cuanto exista en lugar de fallar por una carrera.
// Un elemento desactivado ignora .click(): se espera a que se active (#47), porque dar ese
// clic por bueno dejaba al test esperando un efecto que nunca llega.
export async function clickWhen(c, expr, { tries = 40, ms = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const { evaluateChrome } = await import('./chrome-dom.mjs');
      if (await evaluateChrome(c, `(() => { const e = ${expr}; if (e && !e.disabled) { e.click(); return true; } return false; })()`)) return true;
    } catch { /* re-render en curso: se reintenta */ }
    await sleep(ms);
  }
  throw new Error('no se pudo hacer clic en: ' + expr);
}
