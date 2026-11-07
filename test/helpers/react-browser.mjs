// Helpers compartidos para las pruebas de navegador de la interfaz React (#105).
// Chrome por CDP con perfil y proceso propios (mismo patrón que test/panel-mvp-bot.test.mjs):
// cada página se abre una vez, sin reintentos, y el proceso de Chrome lo cierra el test.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/** Abre una página del servidor local en Chrome headless y devuelve { child, cdp }. */
export async function openChromePage(bin, url) {
  const profile = await mkdtemp(path.join(tmpdir(), 'egdev-chrome-'));
  const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio', '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  try {
    let port, page;
    // The first Chrome start on a fresh CI runner (cold profile and font cache) took over 15 s
    // once on ubuntu Node 24: the port wait gets 30 s, and the error names the phase that failed.
    for (let i = 0; i < 300 && !port; i++) { try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch { await sleep(100); } }
    if (!port) throw new Error('Chrome no arrancó: no escribió DevToolsActivePort en 30 s');
    for (let i = 0; i < 100 && !page; i++) {
      page = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => [])).find(x => x.type === 'page' && x.url === 'about:blank');
      if (!page) await sleep(100);
    }
    if (!page) throw new Error('Chrome no expuso la página');
    const ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const waiters = new Map();
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = ev => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id); m.error ? w.reject(Object.assign(new Error('CDP: comando rechazado'), { code: m.error.code })) : w.resolve(m.result); };
    const cdp = { send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiters.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); }), close: () => ws.close() };
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const nav = await cdp.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error('Chrome no navegó a la página: ' + nav.errorText);
    return { child, cdp };
  } catch (e) { child.kill(); throw e; }
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
