// Custom overlays: HTML/CSS/JS pages written by the user or the agent (MCP) and added to
// Meld as browser layers. User code never runs on antena's origin: /custom/<id> is a trusted
// shell that embeds /custom/<id>/frame in <iframe sandbox="allow-scripts">, and the frame
// response carries `Content-Security-Policy: sandbox allow-scripts`, so the code lives in an
// opaque origin. The server rejects its mutating requests (Origin: null) and, without CORS,
// it cannot read the API or open the SSE stream. Data reaches it only via postMessage.
import { httpError, id8 } from './http-util.mjs';

export const CUSTOM_OVERLAY_MAX_BYTES = 512_000;        // one overlay, as JSON
export const CUSTOM_OVERLAYS_MAX_BYTES = 2_500_000;     // the whole list, as JSON
export const CUSTOM_OVERLAYS_MAX_ITEMS = 50;
export const CUSTOM_OVERLAY_ID = /^[a-z0-9-]{1,40}$/;
export const FRAME_CSP = 'sandbox allow-scripts';

const SIZE = { width: ['ancho', 7680], height: ['alto', 4320] };
export const DEFAULT_CUSTOM_OVERLAY = { name: '', html: '', css: '', js: '', width: 1920, height: 1080, transparent: true };

/** Validates a full or partial overlay and returns only the known fields. Throws 400 in Spanish (UI language). */
function clean(input, { partial }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'El overlay tiene que ser un objeto');
  const out = {};
  if (!partial || 'name' in input) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw httpError(400, 'El overlay necesita un nombre');
    out.name = name.slice(0, 80);
  }
  for (const f of ['html', 'css', 'js']) {
    if (!(f in input) || input[f] === undefined) continue;
    if (typeof input[f] !== 'string') throw httpError(400, `El campo ${f} tiene que ser texto`);
    out[f] = input[f];
  }
  for (const [f, [label, max]] of Object.entries(SIZE)) {
    if (!(f in input) || input[f] === undefined) continue;
    const n = input[f];
    if (!Number.isInteger(n) || n < 16 || n > max) throw httpError(400, `El ${label} tiene que ser un número entero entre 16 y ${max}`);
    out[f] = n;
  }
  if ('transparent' in input && input.transparent !== undefined) {
    if (typeof input.transparent !== 'boolean') throw httpError(400, 'El campo transparent tiene que ser verdadero o falso');
    out.transparent = input.transparent;
  }
  return out;
}

function checkSize(overlay, list) {
  if (JSON.stringify(overlay).length > CUSTOM_OVERLAY_MAX_BYTES) throw httpError(400, `El overlay es demasiado grande (máx. ${Math.round(CUSTOM_OVERLAY_MAX_BYTES / 1000)} KB)`);
  if (list.length > CUSTOM_OVERLAYS_MAX_ITEMS) throw httpError(400, `Ya hay ${CUSTOM_OVERLAYS_MAX_ITEMS} overlays: borra alguno antes de crear otro`);
  if (JSON.stringify(list).length > CUSTOM_OVERLAYS_MAX_BYTES) throw httpError(400, 'Los overlays ocupan demasiado: borra o reduce alguno');
}

/** CRUD over store.config.customOverlays. `onChange(list)` runs after every persisted change. */
export class CustomOverlays {
  constructor({ store, onChange = () => {} }) { this.store = store; this.onChange = onChange; }
  list() { return Array.isArray(this.store.config.customOverlays) ? this.store.config.customOverlays : []; }
  get(id) {
    const o = this.list().find(x => x.id === id);
    if (!o) throw httpError(404, 'No existe ese overlay');
    return o;
  }
  versions() { return Object.fromEntries(this.list().map(o => [o.id, o.updatedAt || 0])); }
  async #commit(next) {
    this.store.config.customOverlays = next;
    await this.store.save('customOverlays');
    this.onChange(next);
  }
  #stamp(prev) { return Math.max(Date.now(), (prev || 0) + 1); }
  async create(input) {
    const overlay = { id: '', ...DEFAULT_CUSTOM_OVERLAY, ...clean(input, { partial: false }) };
    const taken = new Set(this.list().map(o => o.id));
    do overlay.id = id8(); while (taken.has(overlay.id));
    overlay.updatedAt = this.#stamp();
    const next = [...this.list(), overlay];
    checkSize(overlay, next);
    await this.#commit(next);
    return overlay;
  }
  async update(id, input) {
    const prev = this.get(id);
    const overlay = { ...prev, ...clean(input, { partial: true }), id, updatedAt: this.#stamp(prev.updatedAt) };
    const next = this.list().map(o => (o.id === id ? overlay : o));
    checkSize(overlay, next);
    await this.#commit(next);
    return overlay;
  }
  /** Replaces the whole list (generic config write paths: PUT /api/config, POST /api/config/set, MCP
   *  config tools). Applies the same rules as create/update; unchanged overlays keep their version. */
  async replaceAll(input) {
    if (!Array.isArray(input)) throw httpError(400, 'customOverlays tiene que ser una lista de overlays');
    const prev = new Map(this.list().map(o => [o.id, o]));
    const seen = new Set();
    const next = input.map(item => {
      const id = item && typeof item === 'object' ? item.id : undefined;
      if (typeof id !== 'string' || !CUSTOM_OVERLAY_ID.test(id)) throw httpError(400, `Id de overlay no válido: ${JSON.stringify(id ?? null).slice(0, 60)} (solo minúsculas, números y guiones)`);
      if (seen.has(id)) throw httpError(400, `Id de overlay repetido: ${id}`);
      seen.add(id);
      const overlay = { id, ...DEFAULT_CUSTOM_OVERLAY, ...clean(item, { partial: false }) };
      const old = prev.get(id);
      const same = old && Object.keys(DEFAULT_CUSTOM_OVERLAY).every(k => old[k] === overlay[k]);
      overlay.updatedAt = same ? old.updatedAt : this.#stamp(old?.updatedAt);
      return overlay;
    });
    for (const o of next) checkSize(o, next);
    if (!next.length) checkSize({}, next);
    await this.#commit(next);
    return next;
  }
  /** Applies a dotted config path under customOverlays (e.g. "customOverlays.0.css") and validates the result. */
  async setPath(dotted, value) {
    const keys = String(dotted).split('.').slice(1);
    if (!keys.length) return this.replaceAll(value);
    if (keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw httpError(400, 'Ruta no válida');
    const list = structuredClone(this.list());
    let obj = list;
    for (const k of keys.slice(0, -1)) {
      if (obj[k] === null || typeof obj[k] !== 'object') throw httpError(400, `No existe ${dotted}`);
      obj = obj[k];
    }
    obj[keys.at(-1)] = value;
    return this.replaceAll(list);
  }
  async remove(id) {
    this.get(id);
    await this.#commit(this.list().filter(o => o.id !== id));
    return { ok: true };
  }
}

const escAttr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Trusted shell: owns the SSE connection and reloads the sandboxed frame when the overlay changes.
 *  It is also the only bridge for data (S6): the frame gets the public events by postMessage, with
 *  targetOrigin '*' because its origin is opaque. Nothing is ever read back from the frame. */
export function shellHtml(overlay) {
  const id = escAttr(overlay.id);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>antena · ${escAttr(overlay.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{border:0;width:100%;height:100%;display:block;background:transparent}</style>
</head><body>
<iframe id="frame" title="${escAttr(overlay.name)}" sandbox="allow-scripts" allowtransparency="true" src="/custom/${id}/frame?v=${Number(overlay.updatedAt) || 0}"></iframe>
<script>
// Script clásico (no módulo): se ejecuta durante el parseo, después del iframe, así que el
// listener de «load» ya está puesto antes de que el marco pueda cargar. Sin él, un marco que
// cargue rápido se perdería el snapshot inicial.
(() => {
  const id = ${JSON.stringify(overlay.id)};
  const frame = document.getElementById('frame');
  // Solo lo que el usuario puede ver: nada de secretos ni de la cola de alertas.
  const SNAPSHOTS = ['widgets', 'viewers', 'interactive', 'theme'];
  const state = {};
  let version = ${Number(overlay.updatedAt) || 0};
  let loaded = false;
  let ready = false;

  const post = (event, data) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ antena: 1, event, data }, '*');
  };
  // El SDK resuelve «ready» cuando ya tiene el estado de los widgets y el marco ha cargado.
  const sendReady = () => {
    if (ready || !loaded || !('widgets' in state) || !frame.contentWindow) return;
    ready = true;
    frame.contentWindow.postMessage({ antena: 1, ready: true }, '*');
  };
  const relay = event => data => { state[event] = data; post(event, data); sendReady(); };

  // Marco nuevo (primer carga o recarga tras guardar): le llega el snapshot vigente de cada evento.
  frame.addEventListener('load', () => {
    loaded = true;
    for (const event of SNAPSHOTS) if (event in state) post(event, state[event]);
    sendReady();
  });

  // La conexión (cliente «widget», nunca «overlay») la pone la utilidad común de los widgets.
  import('/widgets/widget.js').then(({ connect }) => connect({
    widgets: relay('widgets'),
    viewers: relay('viewers'),
    interactive: relay('interactive'),
    theme: relay('theme'),
    chat: relay('chat'),
    publicAlert: data => relay('alert')(data),
    customOverlayVersions: v => {
      if (!(id in v) || v[id] === version) return;
      version = v[id];
      frame.src = '/custom/' + id + '/frame?v=' + version;
    },
  }, 'widget'));
})();
</script></body></html>`;
}

/** The user's page. Served with FRAME_CSP, so it is an opaque origin even when opened directly.
 *  The SDK goes first in the head (classic script, no defer) so `antena` exists when user code runs. */
export function frameHtml(overlay) {
  const bg = overlay.transparent === false ? '' : 'html,body{background:transparent}';
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>${escAttr(overlay.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="/theme.css" rel="stylesheet">
<script src="/custom/sdk.js"></script>
<style>html,body{margin:0}${bg}</style>
<style>${String(overlay.css || '').replace(/<\/style/gi, '<\\/style')}</style>
</head><body>
${overlay.html || ''}
<script>${String(overlay.js || '').replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;
}
