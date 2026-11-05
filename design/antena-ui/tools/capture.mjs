#!/usr/bin/env node
// Captures every current antena UI view (panel, prompter, dock) as self-contained HTML artboards
// for the gentle-design canvas, plus a kanban overview (00-flow.html).
//
//   pnpm app:build && node design/antena-ui/tools/capture.mjs
//
// It starts antena on a scratch port with an isolated, empty data dir (never ./data), drives
// headless Chrome over the DevTools protocol, and freezes each rendered DOM with its CSS inlined.
// Scripts, fonts and remote URLs are stripped so every artboard stays self-contained.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..');
const ROOT = path.resolve(OUT, '..', '..');
const PORT = Number(process.env.CAPTURE_PORT) || 4599;
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || 'google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PANEL = { w: 1440, h: 900 };
const PROMPTER = { w: 1024, h: 600 };
const DOCK = { w: 380, h: 720 };

// Sidebar order (app/src/panel/Sidebar.tsx): group, route, title.
const SECTIONS = [
  ['En directo', 'directo', 'Directo'], ['En directo', 'chat', 'Chat'], ['En directo', 'preguntas', 'Preguntas'],
  ['En directo', 'tierlist', 'Tier list'], ['En directo', 'sorteo', 'Sorteo'], ['En directo', 'teleprompter', 'Teleprompter'],
  ['Automatización', 'alertas', 'Alertas'], ['Automatización', 'comandos', 'Comandos de chat'],
  ['Automatización', 'mensajes', 'Mensajes programados'], ['Automatización', 'widgets', 'Widgets'],
  ['Automatización', 'atajos', 'Atajos y Stream Deck'],
  ['Integración', 'fuentes', 'Fuentes para Meld'], ['Integración', 'meld', 'Meld Studio'], ['Integración', 'prompter', 'Prompter y dock'],
  ['Registro', 'historial', 'Historial de alertas'], ['Registro', 'directos', 'Directos anteriores'], ['Registro', 'archivos', 'Archivos'],
  ['Ajustes', 'apariencia', 'Apariencia'], ['Ajustes', 'conexiones', 'Conexiones'], ['Ajustes', 'filtros', 'Filtros y voz'],
  ['Ajustes', 'general', 'General'], ['Ajustes', 'acerca', 'Acerca de'],
];
const MAX_SUB = 8;

// ---------- minimal CDP client ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); this.handlers = [];
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && this.wait.has(m.id)) { const { ok, ko } = this.wait.get(m.id); this.wait.delete(m.id); m.error ? ko(new Error(m.error.message)) : ok(m.result); }
      else if (m.method) for (const h of this.handlers) h(m); };
  }
  static async open(url) { const ws = new WebSocket(url); await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; }); return new Cdp(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((ok, ko) => this.wait.set(id, { ok, ko })); }
  on(h) { this.handlers.push(h); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

// ---------- in-page serializer (stringified into the page) ----------
const SNAPSHOT = String(async function snapshot(viewH) {
  // Resources are only made absolute here; Node inlines them afterwards. Fetching from the page
  // would queue behind the SSE connections the alert-preview iframes hold open (6 per host).
  const abs = u => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const ruleText = async rules => {
    let out = '';
    for (const r of rules) {
      if (r instanceof CSSFontFaceRule) continue; // fonts are not bundled: system stacks only
      if (r instanceof CSSImportRule) { if (!r.styleSheet) continue; const inner = await ruleText(r.styleSheet.cssRules);
        out += r.layerName != null ? `@layer ${r.layerName}{\n${inner}}\n` : inner; continue; }
      out += r.cssText + '\n';
    }
    return out;
  };
  const absUrls = css => css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, u) => u.startsWith('data:') || u.startsWith('#') || u.startsWith('%23') ? m : `url("${abs(u)}")`);
  async function snap(doc) {
    // persist live form state into attributes so the frozen DOM shows it
    for (const el of doc.querySelectorAll('input')) {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked ? el.setAttribute('checked', '') : el.removeAttribute('checked');
      else if (el.type !== 'file' && el.type !== 'password') el.setAttribute('value', el.value);
    }
    for (const el of doc.querySelectorAll('textarea')) el.textContent = el.value;
    for (const el of doc.querySelectorAll('select option')) el.selected ? el.setAttribute('selected', '') : el.removeAttribute('selected');
    let css = '';
    for (const ss of doc.styleSheets) { try { css += await ruleText(ss.cssRules); } catch { /* cross-origin sheet */ } }
    css = absUrls(css);
    const iframes = [...doc.querySelectorAll('iframe')];
    const frames = [];
    for (const f of iframes) {
      let inner = null; try { if (f.contentDocument?.documentElement) inner = await snap(f.contentDocument); } catch { /* cross-origin */ }
      frames.push(inner);
    }
    const imgData = [...doc.querySelectorAll('img')].map(i => i.currentSrc || i.src || null);
    const root = doc.documentElement.cloneNode(true);
    const cImgs = root.querySelectorAll('img'); cImgs.forEach((im, k) => { im.removeAttribute('srcset'); imgData[k] ? im.setAttribute('src', imgData[k]) : im.removeAttribute('src'); });
    const cFrames = root.querySelectorAll('iframe'); cFrames.forEach((fr, k) => { fr.removeAttribute('src'); if (frames[k]) fr.setAttribute('srcdoc', frames[k]); });
    root.querySelectorAll('script,noscript,link[rel~="stylesheet"],link[rel~="preload"],link[rel~="modulepreload"],style,meta[http-equiv]').forEach(n => n.remove());
    root.querySelectorAll('link[rel~="icon"]').forEach(n => n.remove());
    root.querySelectorAll('video,audio,source').forEach(n => { n.removeAttribute('src'); n.removeAttribute('poster'); });
    root.querySelectorAll('[style*="url("]').forEach(n => n.setAttribute('style', absUrls(n.getAttribute('style'))));
    const head = root.querySelector('head') || root.insertBefore(doc.createElement('head'), root.firstChild);
    const st = doc.createElement('style'); st.textContent = css; head.appendChild(st);
    return '<!doctype html>\n' + root.outerHTML;
  }
  const html = await snap(document);
  const h = Math.max(viewH, Math.min(4000, document.documentElement.scrollHeight, document.body.scrollHeight || 0));
  return { html, height: h };
});

// ---------- Node-side inliner ----------
const dataCache = new Map();
const toData = url => {
  if (!dataCache.has(url)) dataCache.set(url, (async () => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const type = (res.headers.get('content-type') || '').split(';')[0];
      if (!res.ok || !type.startsWith('image/')) { await res.body?.cancel(); return ''; }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 400_000 ? '' : `data:${type};base64,${buf.toString('base64')}`;
    } catch { return ''; }
  })());
  return dataCache.get(url);
};
const ORIGIN_RE = new RegExp(BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/[^"\'\\s)&<>]*', 'g');
async function inline(html) {
  // fonts are not bundled (system stacks only), including @font-face nested in layers or srcdoc
  html = html.replace(/@font-face\s*\{[^}]*\}/g, '');
  const urls = [...new Set(html.match(ORIGIN_RE) || [])];
  const data = new Map(await Promise.all(urls.map(async u => [u, await toData(u)])));
  html = html.replace(ORIGIN_RE, u => data.get(u) || '');
  // anything left pointing outside the file is neutralized
  // outbound links keep their destination as data-href but never point outside the file
  html = html.replace(/\shref="(https?:\/\/[^"]*)"/g, ' href="#" data-href="$1"');
  return html.replace(/url\((?:&quot;|["'])?(?:&quot;|["'])?\)/g, 'none').replace(/\s(src|href)=""/g, '');
}

// ---------- run ----------
const slug = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const artboards = [];
let n = 0;
const procs = [];
const cleanup = async dirs => { for (const p of procs) try { p.kill('SIGTERM'); } catch {} await sleep(300); for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {}); };

async function main() {
  const data = await mkdtemp(path.join(tmpdir(), 'antena-capture-data-'));
  const media = await mkdtemp(path.join(tmpdir(), 'antena-capture-media-'));
  const profile = await mkdtemp(path.join(tmpdir(), 'antena-capture-chrome-'));
  const shots = path.join(tmpdir(), 'antena-capture-shots'); await mkdir(shots, { recursive: true });
  try {
    if (await fetch(BASE + '/api/config').then(() => true, () => false)) throw new Error(`port ${PORT} is busy: stop the process using it or set CAPTURE_PORT`);
    const srv = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env, ANTENA_DATA: data, ANTENA_MEDIA: media, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'inherit'] });
    procs.push(srv);
    for (let i = 0; ; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch {} if (i > 60) throw new Error('antena did not start'); await sleep(250); }
    const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
    procs.push(chrome);
    let target;
    for (let i = 0; ; i++) { try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); if (target) break; } catch {} if (i > 60) throw new Error('chrome did not start'); await sleep(250); }
    const cdp = await Cdp.open(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    cdp.on(m => { if (m.method === 'Page.javascriptDialogOpening') cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

    // Page.navigate's reply can go missing when re-entering the same URL; readiness is polled below
    const nav = url => Promise.race([cdp.send('Page.navigate', { url }), sleep(4000)]);
    const load = async (url, size, settle = 1400) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
      await nav('about:blank'); await sleep(100);
      await nav(url);
      for (let i = 0; i < 40; i++) { if (await cdp.eval('document.readyState === "complete" && !!document.querySelector("#root")?.children.length').catch(() => false)) break; await sleep(150); }
      await sleep(settle);
    };
    const capture = async ({ surface, group, title, route, size, note }) => {
      const t0 = Date.now();
      let { html, height } = await cdp.eval(`(${SNAPSHOT})(${size.h})`);
      const t1 = Date.now(); 
      html = await inline(html);
      const file = `${String(++n).padStart(2, '0')}-${slug(surface)}-${slug(route || title)}.html`;
      await writeFile(path.join(OUT, file), html);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 360 / size.w } });
      await writeFile(path.join(shots, file.replace('.html', '.jpg')), Buffer.from(shot.data, 'base64'));
      artboards.push({ file, title: `${surface} · ${title}`, tradeoff: note || `Current UI${route ? ` at ${route}` : ''} (${group})`, width: size.w, height: Math.ceil(height), surface, group, route, thumb: shot.data });
      process.stderr.write(`captured ${file} (snapshot ${t1 - t0}ms, total ${Date.now() - t0}ms)\n`);
    };

    // 1. Panel: first-run onboarding, then every section and its sub-views (tabs, catalog slides)
    await load(`${BASE}/#/directo`, PANEL, 2000);
    await capture({ surface: 'Panel', group: 'Primer arranque', title: 'Bienvenida (onboarding)', route: '#/directo', size: PANEL, note: 'First-run welcome over the live view (config.panel.onboardingDone=false)' });
    await fetch(BASE + '/api/config', { method: 'PUT', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ panel: { onboardingDone: true } }) });

    const only = process.env.CAPTURE_ONLY ? new Set(process.env.CAPTURE_ONLY.split(',')) : null;
    for (const [group, route, title] of SECTIONS.filter(s => !only || only.has(s[1]))) {
      await load(`${BASE}/#/${route}`, PANEL);
            await capture({ surface: 'Panel', group, title, route: `#/${route}`, size: PANEL });
      const subs = await cdp.eval(`[...document.querySelectorAll('a[href^="#/"]')].filter(a => !a.closest('#nav, .brand, aside')).map(a => a.getAttribute('href'))`);
      const seen = new Set([`#/${route}`]);
      const picks = subs.filter(h => h.split('/')[1] === route && !seen.has(h) && seen.add(h)).slice(0, MAX_SUB);
      for (const h of picks) {
        await load(`${BASE}/${h}`, PANEL);
        const tail = decodeURIComponent(h.split('/').slice(2).join(' / '));
        await capture({ surface: 'Panel', group, title: `${title} · ${tail}`, route: h, size: PANEL });
      }
    }

    // 2. Prompter: one artboard per tool tab (tab state lives on the server)
    for (const [tab, title] of [['cronologia', 'Cronología'], ['preguntas', 'Preguntas'], ['tierlist', 'Tier list'], ['sorteo', 'Sorteo']]) {
      await fetch(BASE + '/api/prompter', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ tab }) });
      await load(`${BASE}/prompter`, PROMPTER);
      await capture({ surface: 'Prompter', group: 'Prompter', title, route: `/prompter (${tab})`, size: PROMPTER });
    }

    // 3. Dock: Control and Chat tabs (tab state lives in localStorage)
    for (const [tab, title] of [['control', 'Control'], ['chat', 'Chat']]) {
      await load(`${BASE}/dock`, DOCK, 200);
      await cdp.eval(`localStorage.setItem('egdev.dock.tab', '${tab}')`);
      await load(`${BASE}/dock`, DOCK);
      await capture({ surface: 'Dock', group: 'Dock', title, route: `/dock (${tab})`, size: DOCK });
    }
  } finally { await cleanup([data, media, profile]); }

  await writeFile(path.join(OUT, '00-flow.html'), kanban(artboards));
  const manifest = {
    title: 'antena · current UI',
    brief: 'Kanban of every current antena UI view (panel, prompter, dock) captured from the running app, as the baseline for visual changes. Regenerate with: pnpm app:build && node design/antena-ui/tools/capture.mjs',
    artboards: [
      { file: '00-flow.html', title: 'Flow · Kanban (Panel → Prompter → Dock)', tradeoff: 'Overview of the whole flow; thumbnails are static, open each artboard to edit', width: 1440, height: 1200 },
      ...artboards.map(({ file, title, tradeoff, width, height }) => ({ file, title, tradeoff, width, height })),
    ],
  };
  await writeFile(path.join(OUT, 'design.json'), JSON.stringify(manifest, null, 2) + '\n');
  // drop artboards from previous runs that are no longer produced
  const keep = new Set(manifest.artboards.map(a => a.file));
  for (const f of await readdir(OUT)) if (/^\d\d-.*\.html$/.test(f) && !keep.has(f)) await unlink(path.join(OUT, f));
  process.stderr.write(`done: ${artboards.length} views + kanban → ${path.relative(ROOT, OUT)}\n`);
}

function kanban(list) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const cols = ['Panel', 'Prompter', 'Dock'].map(surface => {
    const items = list.filter(a => a.surface === surface);
    const groups = [...new Set(items.map(a => a.group))];
    const body = groups.map(g => `<section class="grp" aria-label="${esc(g)}"><h3>${esc(g)}</h3>${items.filter(a => a.group === g).map(a => `
      <article class="card"><img alt="" src="data:image/jpeg;base64,${a.thumb}"><div class="meta"><strong>${esc(a.title.replace(surface + ' · ', ''))}</strong><code>${esc(a.route || '')}</code><span>${esc(a.file)}</span></div></article>`).join('')}</section>`).join('');
    return `<section class="col" aria-labelledby="c-${surface}"><header><h2 id="c-${surface}">${surface}</h2><span class="count">${items.length}</span></header>${body}</section>`;
  }).join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>antena · UI flow</title>
<style>
:root{--bg:#141518;--s1:#1B1C20;--s2:#232428;--line:#2A2B30;--hair:rgba(255,255,255,.08);--fg:#FFFFFF;--fg2:#CCCCCC;--muted:#A1A2A8;--red:#FF0036;
--display:"Barlow Condensed","Arial Narrow",sans-serif;--sans:"Barlow",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:500 14px/1.45 var(--sans)}
main{padding:32px}h1{font:800 26px/1 var(--display);text-transform:uppercase;margin:0 0 4px}h1 b{color:var(--red)}
.sub{color:var(--muted);margin:0 0 24px}
.board{display:grid;grid-template-columns:2.2fr 1fr 1fr;gap:16px;align-items:start}
.col{background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:16px}
.col header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
h2{font:800 20px/1 var(--display);text-transform:uppercase;margin:0}.count{font:500 12px var(--mono);color:var(--fg2);background:var(--s2);border-radius:9999px;padding:2px 8px}
.col:first-child .grp{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.grp{margin-bottom:16px;display:grid;gap:8px}.grp h3{grid-column:1/-1;font:800 13px/1 var(--display);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:8px 0 0}
.card{background:var(--s2);border:1px solid var(--hair);border-radius:12px;overflow:hidden}
.card:focus-within,.card:hover{border-color:rgba(255,0,54,.45)} /* --color-border-brand */
.card img{display:block;width:100%;height:auto;border-bottom:1px solid var(--hair);max-height:220px;object-fit:cover;object-position:top}
.meta{padding:8px 12px;display:grid;gap:2px}.meta strong{font-weight:600}.meta code{font:500 12px var(--mono);color:#FF8FA6}.meta span{font:500 11px var(--mono);color:var(--muted)}
</style></head><body><main>
<h1>antena <b>·</b> flujo de UI actual</h1>
<p class="sub">${list.length} vistas capturadas de la app en marcha. Cada tarjeta es un artboard editable del canvas.</p>
<div class="board">${cols}</div></main></body></html>
`;
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await cleanup([]); process.exit(130); });
main().catch(async e => { console.error(e); await cleanup([]); process.exit(1); });
