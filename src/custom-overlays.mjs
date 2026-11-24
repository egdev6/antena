// Custom overlays: HTML/CSS/JS pages written by the user or the agent (MCP) and added to
// Meld as browser layers. User code never runs on antena's origin: /custom/<id> is a trusted
// shell that embeds /custom/<id>/frame in <iframe sandbox="allow-scripts">, and the frame
// response carries `Content-Security-Policy: sandbox allow-scripts`, so the code lives in an
// opaque origin. The server rejects its mutating requests (Origin: null) and, without CORS,
// it cannot read the API or open the SSE stream. Data reaches it only via postMessage, and the
// only way back out is the action bridge (S11): the SDK posts a run request to this shell, which
// forwards it to the overlay's own action route and answers with ok/error only.
import { ACTION_KINDS } from './actions.mjs';
import { httpError, id8 } from './http-util.mjs';
import { MELD_STREAM_EVENTS } from './programs/index.mjs';

export const CUSTOM_OVERLAY_MAX_BYTES = 512_000;        // one overlay, as JSON
export const CUSTOM_OVERLAYS_MAX_BYTES = 2_500_000;     // the whole list, as JSON
export const CUSTOM_OVERLAYS_MAX_ITEMS = 50;
export const CUSTOM_OVERLAY_ID = /^[a-z0-9-]{1,40}$/;
export const FRAME_CSP = 'sandbox allow-scripts';

/** Action kinds an overlay may request (S11): exactly the ones Engine.#execAction dispatches
 *  (src/engine.mjs) — the same list alerts, timers and shortcuts run. Single source for the
 *  schema (src/config-schema.mjs), the MCP enum and the route validation. */
export const CUSTOM_OVERLAY_ACTION_KINDS = ACTION_KINDS;

/** Per-overlay rate limit of the action bridge (S11c): 10 actions in a sliding window of 10 s. */
export const CUSTOM_OVERLAY_RATE = { max: 10, windowMs: 10_000 };

const SIZE = { width: ['ancho', 7680], height: ['alto', 4320] };
const MAX_KIND_LABEL = 60;
export const DEFAULT_CUSTOM_OVERLAY = { name: '', html: '', css: '', js: '', width: 1920, height: 1080, transparent: true };

/** Approved kinds limited to the requested ones, in canonical order (dedupes too). Approvals can
 *  never exceed what the overlay asked for, so every write path runs new approvals through here. */
export function approvalsWithinRequest(approved, requested) {
  const req = Array.isArray(requested) ? requested : [];
  const ok = Array.isArray(approved) ? approved : [];
  return CUSTOM_OVERLAY_ACTION_KINDS.filter(k => req.includes(k) && ok.includes(k));
}

/** Lista de tipos de acción: array de textos conocidos → orden canónico. 400 en castellano. */
function cleanKinds(value) {
  if (!Array.isArray(value)) throw httpError(400, 'Los permisos del overlay tienen que ser una lista de tipos de acción');
  for (const k of value) {
    if (typeof k !== 'string' || !CUSTOM_OVERLAY_ACTION_KINDS.includes(k)) {
      throw httpError(400, `Permiso de overlay no válido: ${JSON.stringify(k ?? null).slice(0, MAX_KIND_LABEL)}. Usa ${CUSTOM_OVERLAY_ACTION_KINDS.join(', ')}.`);
    }
  }
  return CUSTOM_OVERLAY_ACTION_KINDS.filter(k => value.includes(k));
}

/** An overlay as the API/panel/MCP see it: the approval fields always present and consistent,
 *  even for an overlay stored before S11 existed. Never mutates the stored object. */
export function publicOverlay(o) {
  const requestedPermissions = Array.isArray(o.requestedPermissions) ? o.requestedPermissions : [];
  return {
    ...o,
    requestedPermissions,
    permissions: approvalsWithinRequest(o.permissions, requestedPermissions),
    approvedAt: Number(o.approvedAt) || 0,
    approvedUpdatedAt: Number(o.approvedUpdatedAt) || 0,
    reapprovalRequired: !!o.reapprovalRequired,
  };
}

/** ¿Tiene el overlay aprobado este tipo de acción? Única comprobación que autoriza ejecutar. */
export const isApprovedAction = (overlay, kind) => Array.isArray(overlay?.permissions) && overlay.permissions.includes(kind);

/** Texto obligatorio y con contenido, para los campos de la acción. */
function needText(kind, params, field) {
  const v = params[field];
  if (typeof v !== 'string' || !v.trim()) throw httpError(400, `La acción «${kind}» necesita «${field}» (texto no vacío)`);
  return v;
}

/** Número opcional ≥ 0. Los strings no valen: el mensaje llega del SDK en JSON. */
function optionalNumber(kind, params, field) {
  const v = params[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw httpError(400, `«${field}» de la acción «${kind}» tiene que ser un número mayor o igual que 0`);
  return v;
}

/** Valida los parámetros de una acción de overlay y devuelve la acción del motor, solo con los
 *  campos de su tipo (nunca `delaySec`: una acción aplazada podría correr después de que el
 *  usuario retire el permiso). El destino de chat lo valida checkActions en la ruta. */
export function cleanActionParams(kind, params) {
  if (typeof kind !== 'string' || !CUSTOM_OVERLAY_ACTION_KINDS.includes(kind)) {
    throw httpError(400, `Tipo de acción no válido: ${JSON.stringify(kind ?? null).slice(0, MAX_KIND_LABEL)}. Tipos: ${CUSTOM_OVERLAY_ACTION_KINDS.join(', ')}`);
  }
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw httpError(400, 'Los parámetros de la acción tienen que ser un objeto');
  }
  const p = params || {};
  const scene = p.scene === undefined ? undefined : needText(kind, p, 'scene');
  switch (kind) {
    case 'scene': {
      const returnAfterSec = optionalNumber(kind, p, 'returnAfterSec');
      return { kind, scene: needText(kind, p, 'scene'), ...(returnAfterSec !== undefined && { returnAfterSec }) };
    }
    case 'layer': {
      const seconds = optionalNumber(kind, p, 'seconds');
      return { kind, ...(scene !== undefined && { scene }), layer: needText(kind, p, 'layer'), ...(seconds !== undefined && { seconds }) };
    }
    case 'hideLayer':
    case 'toggleLayer':
      return { kind, ...(scene !== undefined && { scene }), layer: needText(kind, p, 'layer') };
    case 'effect':
      return { kind, ...(scene !== undefined && { scene }), layer: needText(kind, p, 'layer'), effect: needText(kind, p, 'effect') };
    case 'command':
      return { kind, command: needText(kind, p, 'command') };
    case 'streamEvent': {
      const event = needText(kind, p, 'event');
      if (!MELD_STREAM_EVENTS.includes(event)) throw httpError(400, `Evento de Meld no válido: ${event.slice(0, MAX_KIND_LABEL)}. Usa ${MELD_STREAM_EVENTS.join(', ')}.`);
      const amount = optionalNumber(kind, p, 'amount');
      return { kind, event, ...(amount !== undefined && { amount }) };
    }
    case 'chat':
      return { kind, text: needText(kind, p, 'text'), ...(p.destination !== undefined && { destination: p.destination }) };
    case 'say':
      return { kind, text: needText(kind, p, 'text') };
    default:
      throw httpError(400, `Tipo de acción no válido: ${kind}`);
  }
}

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
  // S11a: el agente (y cualquier escritura de código) solo PIDE permisos de acción. Las
  // aprobaciones (`permissions`, `approvedAt`, `approvedUpdatedAt`) no se aceptan aquí: son
  // campos desconocidos para clean y solo las cambia el endpoint de aprobación del panel.
  if (!partial && !('requestedPermissions' in input)) out.requestedPermissions = [];
  else if ('requestedPermissions' in input && input.requestedPermissions !== undefined) out.requestedPermissions = cleanKinds(input.requestedPermissions);
  return out;
}

/** Eventos que acepta la prueba de una capa (`probar_overlay`). Son los que el SDK ya entiende:
 *  alert, chat, viewers y widgets. Nunca tocan la cola de alertas, el directo ni los totales. */
export const CUSTOM_OVERLAY_TEST_EVENTS = ['alert', 'chat', 'viewers', 'widgets'];

/** Ejemplo realista por evento, para probar una capa sin inventar datos (misma forma que el SDK). */
export function overlayTestSample(event) {
  const at = new Date().toISOString();
  if (event === 'alert') return { type: 'follow', title: 'Nuevo seguidor', text: 'devconcafe', sub: '¡gracias por seguir!', platform: 'twitch', icon: 'follow', durationMs: 6000, at, vars: { user: 'devconcafe' } };
  if (event === 'chat') return { id: 'prueba-1', platform: 'twitch', user: 'ana_frontend', color: '#00E0FF', text: '¡buenas! ¿qué tal el overlay?', parts: [{ t: '¡buenas! ¿qué tal el overlay?' }], mod: false, member: true, at };
  if (event === 'viewers') return { twitch: { live: true, current: 1423, peak: 1512, record: 2048 }, youtube: { live: true, current: 318, peak: 402, record: 561 } };
  return {
    totals: { follows: 128, subs: 34, bits: 5200, raids: 4, superchats: 12, members: 9, events: 187 },
    latest: { follow: { user: 'ana_frontend' }, raid: { user: 'midudev', vars: { amount: 120 } } },
    goals: [{ id: 'principal', title: 'Objetivo de seguidores', metric: 'follows', target: 200, value: 128 }],
    recent: [
      { type: 'follow', label: 'Nuevo seguidor', user: 'ana_frontend', sub: '', at },
      { type: 'cheer', label: 'Bits', user: 'reactivo', sub: '500 bits', at },
    ],
    credits: [{ title: 'Raids', names: ['midudev'] }],
    session: { title: 'Directo de prueba' },
    chat: [],
  };
}

/** Valida el cuerpo de la prueba { event, data } y rellena el ejemplo realista si no hay datos.
 *  Un evento desconocido o unos datos que no son un objeto se rechazan con 400 sin emitir nada. */
export function overlayTestPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'La prueba tiene que ser un objeto');
  const event = body.event;
  if (typeof event !== 'string' || !CUSTOM_OVERLAY_TEST_EVENTS.includes(event)) {
    throw httpError(400, `Evento de prueba no válido: ${JSON.stringify(event ?? null).slice(0, 60)}. Usa ${CUSTOM_OVERLAY_TEST_EVENTS.join(', ')}.`);
  }
  const data = body.data === undefined ? overlayTestSample(event) : body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, 'Los datos de la prueba tienen que ser un objeto');
  return { event, data };
}

// Las aprobaciones pertenecen al código, no al id ni a updatedAt (que también cambia por
// ajustes). Solo la aprobación del panel limpia el aviso tras un cambio real de HTML/CSS/JS.
function permissionState(prev, next) {
  const changed = !!prev && ['html', 'css', 'js'].some(k => (prev[k] ?? '') !== (next[k] ?? ''));
  const requested = next.requestedPermissions;
  return {
    permissions: changed ? [] : approvalsWithinRequest(prev?.permissions, requested),
    approvedAt: prev?.approvedAt ?? 0,
    approvedUpdatedAt: prev?.approvedUpdatedAt ?? 0,
    reapprovalRequired: !!requested.length && (!!prev?.reapprovalRequired || (changed && !!prev?.permissions?.length)),
  };
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
  notify(next) { this.onChange(next); }
  async #commit(next) {
    this.store.config.customOverlays = next;
    await this.store.save('customOverlays');
    this.notify(next);
  }
  #stamp(prev) { return Math.max(Date.now(), (prev || 0) + 1); }
  async create(input) {
    const overlay = {
      id: '', ...DEFAULT_CUSTOM_OVERLAY, requestedPermissions: [], ...clean(input, { partial: false }),
      // Un overlay nuevo no trae aprobaciones: el usuario las da después, en el panel.
      permissions: [], approvedAt: 0, approvedUpdatedAt: 0, reapprovalRequired: false,
    };
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
    const patch = clean(input, { partial: true });
    const requestedPermissions = patch.requestedPermissions ?? prev.requestedPermissions ?? [];
    const overlay = {
      ...prev, ...patch,
      id,
      updatedAt: this.#stamp(prev.updatedAt),
      requestedPermissions,
      ...permissionState(prev, { ...prev, ...patch, requestedPermissions }),
    };
    const next = this.list().map(o => (o.id === id ? overlay : o));
    checkSize(overlay, next);
    await this.#commit(next);
    return overlay;
  }
  /** Prepara la lista sin mutar ni guardar; el llamador debe guardarla en el mismo turno. */
  prepareReplacement(input) {
    if (!Array.isArray(input)) throw httpError(400, 'customOverlays tiene que ser una lista de overlays');
    const prev = new Map(this.list().map(o => [o.id, o]));
    const seen = new Set();
    const next = input.map(item => {
      const id = item && typeof item === 'object' ? item.id : undefined;
      if (typeof id !== 'string' || !CUSTOM_OVERLAY_ID.test(id)) throw httpError(400, `Id de overlay no válido: ${JSON.stringify(id ?? null).slice(0, 60)} (solo minúsculas, números y guiones)`);
      if (seen.has(id)) throw httpError(400, `Id de overlay repetido: ${id}`);
      seen.add(id);
      const overlay = { id, ...DEFAULT_CUSTOM_OVERLAY, requestedPermissions: [], ...clean(item, { partial: false }) };
      const old = prev.get(id);
      // Config genérica e importaciones siguen exactamente la misma regla que update.
      Object.assign(overlay, permissionState(old, overlay));
      // Cambiar solo lo PEDIDO (no el código) no versiona el overlay: las capas abiertas no recargan.
      const same = old && Object.keys(DEFAULT_CUSTOM_OVERLAY).every(k => old[k] === overlay[k]);
      overlay.updatedAt = same ? old.updatedAt : this.#stamp(old?.updatedAt);
      return overlay;
    });
    for (const o of next) checkSize(o, next);
    if (!next.length) checkSize({}, next);
    return next;
  }
  /** Replaces the whole list with the same rules and notifications as before. */
  async replaceAll(input) {
    const next = this.prepareReplacement(input);
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
  /** Aprobación/revoca (S11a): las aprobaciones se quedan dentro de lo que el overlay pide. No
   *  toca `updatedAt` (no cambia el código) y guarda la versión aprobada para el aviso del panel. */
  async approve(id, permissions) {
    const overlay = this.get(id);
    const requestedPermissions = Array.isArray(overlay.requestedPermissions) ? overlay.requestedPermissions : [];
    const wanted = cleanKinds(permissions);
    for (const kind of wanted) {
      if (!requestedPermissions.includes(kind)) {
        throw httpError(400, `El overlay no ha pedido el permiso «${kind}»: solo se pueden aprobar los que pide (${requestedPermissions.join(', ') || 'ninguno'}).`);
      }
    }
    const approved = {
      ...overlay,
      requestedPermissions,
      permissions: approvalsWithinRequest(wanted, requestedPermissions),
      approvedAt: Date.now(),
      approvedUpdatedAt: Number(overlay.updatedAt) || 0,
      reapprovalRequired: false,
    };
    const next = this.list().map(o => (o.id === id ? approved : o));
    await this.#commit(next);
    return approved;
  }
}

const escAttr = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Trusted shell: owns the SSE connection and reloads the sandboxed frame when the overlay changes.
 *  It is also the only bridge for data (S6) and for actions (S11b): the frame gets the public
 *  events by postMessage, with targetOrigin '*' because its origin is opaque, and it can only ask
 *  this shell to run an approved action. Only messages from the shell's own frame window are
 *  accepted, the action request always goes to the fixed route of this overlay, and the reply
 *  carries nothing but `ok` or the server's error text. */
export function shellHtml(overlay) {
  const id = escAttr(overlay.id);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>antena · ${escAttr(overlay.name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{border:0;display:block;background:transparent}#frame{position:absolute;inset:0;width:100%;height:100%;z-index:1}.widget-slot{position:absolute;box-sizing:border-box}</style>
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
  const SNAPSHOTS = ['widgets', 'viewers', 'interactive', 'themeSnapshot', 'scene'];
  const state = {};
  let version = ${Number(overlay.updatedAt) || 0};
  let loaded = false;
  let ready = false;
  let inheritedSlotCss = null;

  const post = (event, data) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ antena: 1, event, data }, '*');
  };
  // El SDK resuelve «ready» cuando ya tiene el estado de los widgets y el marco ha cargado.
  const sendReady = () => {
    // «scene» llega siempre al conectar (lista vacía sin programa), así que esperarla no puede colgar ready.
    if (ready || !loaded || !('widgets' in state) || !('themeSnapshot' in state) || !('scene' in state) || !frame.contentWindow) return;
    ready = true;
    frame.contentWindow.postMessage({ antena: 1, ready: true }, '*');
  };
  const relay = event => data => { state[event] = data; post(event, data); sendReady(); };
  // Una sola instantánea: el SDK aplica CSS e identidad antes de emitir el evento theme.
  const relayTheme = data => relay('themeSnapshot')({
    theme: { ...data.theme, ...(data.activeTheme || {}) },
    lookCss: data.lookCss,
    extraCss: typeof data.customOverlayCss?.[id] === 'string' ? data.customOverlayCss[id] : '',
  });

  // Slots are rendered outside the opaque frame. All input, including the URL components,
  // is validated here: the sandbox can request public pages but cannot choose an arbitrary URL.
  const canvasWidth = ${Number(overlay.width) || 1920}, canvasHeight = ${Number(overlay.height) || 1080};
  const widgetParams = {
    chat: ['variant'], viewers: ['layout'], goal: ['id'], latest: ['items', 'layout'],
    ticker: [], thanks: [], giveaway: [], question: ['nocount'], tierlist: ['id', 'nopool'],
    interview: ['item'], credits: ['loop', 'transparent'], rotator: [], alerts: [], custom: ['id'],
  };
  const directions = ['none', 'fade', 'left', 'right', 'up', 'down'];
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const only = (o, keys) => Object.keys(o).every(k => keys.includes(k));
  const nameOK = n => typeof n === 'string' && /^[a-z0-9_-]{1,32}$/.test(n);
  const slots = new Map(), pendingSlots = new Map();
  let slotScheduled = false, lastSlotUpdate = -Infinity;
  const slotError = () => frame.contentWindow?.postMessage({ antena: 1, slotError: 'Slots: petición no válida' }, '*');
  function parseOptions(value) {
    if (value === undefined) value = {};
    if (!object(value) || !only(value, ['duration', 'easing', 'delay'])) return null;
    const duration = value.duration === undefined ? 0 : value.duration;
    const delay = value.delay === undefined ? 0 : value.delay;
    const easing = value.easing === undefined ? 'ease' : value.easing;
    if (![duration, delay].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null;
    if (typeof easing !== 'string' || !CSS.supports('transition-timing-function', easing)) return null;
    return { duration, delay, easing };
  }
  function parseSlot(value) {
    if (!object(value) || !only(value, ['widget', 'params', 'rect', 'enter', 'exit', 'layer', 'fit', 'css'])) return null;
    const widget = value.widget;
    if (typeof widget !== 'string' || !own(widgetParams, widget)) return null;
    const params = value.params === undefined ? {} : value.params;
    if (!object(params) || !only(params, widgetParams[widget])) return null;
    for (const [key, val] of Object.entries(params)) {
      if (!['string', 'number', 'boolean'].includes(typeof val) || (typeof val === 'number' && !Number.isFinite(val))) return null;
      if (key === 'layout' && val !== 'column') return null;
    }
    if (widget === 'custom' && (typeof params.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(params.id) || params.id === id || window.parent !== window)) return null;
    const rect = value.rect;
    if (rect !== null && (!Array.isArray(rect) || rect.length !== 4 || !rect.every(n => typeof n === 'number' && Number.isFinite(n)) ||
        Math.abs(rect[0]) > 2 * canvasWidth || Math.abs(rect[1]) > 2 * canvasHeight || rect[2] < 1 || rect[2] > 4320 || rect[3] < 1 || rect[3] > 4320)) return null;
    const enter = value.enter === undefined ? 'fade' : value.enter, exit = value.exit === undefined ? 'fade' : value.exit;
    const layer = value.layer === undefined ? 'above' : value.layer, fit = value.fit === undefined ? 'slot' : value.fit;
    const css = value.css === undefined ? '' : value.css;
    if (!directions.includes(enter) || !directions.includes(exit) || !['above', 'below'].includes(layer) || !['slot', 'canvas'].includes(fit) || typeof css !== 'string') return null;
    // CSS runs on a trusted page: resource loads could otherwise call same-origin /sd actions
    // without permission. Reject escapes/comments as well, so they cannot disguise a token.
    const lowerCss = css.toLowerCase();
    if (css.includes(String.fromCharCode(92)) || css.includes('/*') ||
        ['url', 'image-set', 'image(', 'src(', '@import', '@namespace', '@font-face'].some(token => lowerCss.includes(token))) return null;
    const query = new URLSearchParams();
    for (const key of widgetParams[widget]) if (own(params, key)) query.set(key, String(params[key]));
    if (widget === 'custom') { query.delete('id'); query.set('embedded', '1'); }
    else {
      if (fit === 'slot') query.set('slot', '1');
      if (widget === 'alerts' || widget === 'interview') query.set('embedded', '1');
    }
    const path = widget === 'alerts' ? '/overlay' : widget === 'custom' ? '/custom/' + encodeURIComponent(params.id) : '/widget/' + widget;
    const url = path + (query.toString() ? '?' + query.toString() : '');
    return { rect, enter, exit, layer, fit, css, url };
  }
  function installSlotCss(entry) {
    try {
      const doc = entry.node.contentDocument;
      if (!doc || !doc.head) return;
      let style = doc.getElementById('antena-slot-extra');
      if (!style) { style = doc.createElement('style'); style.id = 'antena-slot-extra'; }
      style.textContent = entry.css;
      doc.head.appendChild(style);
      if (entry.url.startsWith('/custom/')) entry.node.contentWindow.postMessage({ antena: 1, slotCss: entry.css }, location.origin);
    } catch { /* Navigated away from Antena: never access a foreign page. */ }
  }
  function offset(direction, r) {
    if (direction === 'left') return 'translateX(' + (-r[0] - r[2]) + 'px)';
    if (direction === 'right') return 'translateX(' + (canvasWidth - r[0]) + 'px)';
    if (direction === 'up') return 'translateY(' + (-r[1] - r[3]) + 'px)';
    if (direction === 'down') return 'translateY(' + (canvasHeight - r[1]) + 'px)';
    return 'none';
  }
  function applySlot(name, config, options) {
    let entry = slots.get(name);
    if (!entry) {
      const node = document.createElement('iframe');
      node.className = 'widget-slot'; node.title = 'Widget: ' + name;
      entry = { node, css: '', url: '', visible: false, rect: [0, 0, 1, 1] };
      node.addEventListener('load', () => installSlotCss(entry));
      document.body.appendChild(node); slots.set(name, entry);
    }
    const node = entry.node, style = node.style;
    entry.css = config.css;
    if (entry.url !== config.url) { entry.url = config.url; node.src = config.url; }
    else installSlotCss(entry);
    style.zIndex = config.layer === 'below' ? '0' : '2';
    const r = config.fit === 'canvas' ? [0, 0, canvasWidth, canvasHeight] : (config.rect || entry.rect);
    if (config.rect) entry.rect = config.rect;
    const transition = 'all ' + options.duration + 'ms ' + options.easing + ' ' + options.delay + 'ms';
    if (config.rect && !entry.visible) {
      style.transition = 'none';
      style.left = r[0] + 'px'; style.top = r[1] + 'px'; style.width = config.fit === 'canvas' ? '100%' : r[2] + 'px'; style.height = config.fit === 'canvas' ? '100%' : r[3] + 'px';
      style.opacity = config.enter === 'none' ? '1' : '0'; style.transform = offset(config.enter, r);
      void node.offsetWidth;
    }
    style.transition = transition;
    if (config.rect) {
      style.left = r[0] + 'px'; style.top = r[1] + 'px'; style.width = config.fit === 'canvas' ? '100%' : r[2] + 'px'; style.height = config.fit === 'canvas' ? '100%' : r[3] + 'px';
      style.opacity = '1'; style.transform = 'none'; style.pointerEvents = 'auto'; entry.visible = true;
    } else {
      if (config.exit === 'none') style.transition = 'none';
      style.opacity = '0'; style.transform = offset(config.exit, r); style.pointerEvents = 'none'; entry.visible = false;
    }
  }
  function flushSlots() {
    slotScheduled = false;
    if (!pendingSlots.size) return;
    const wait = 50 - (performance.now() - lastSlotUpdate);
    if (wait > 0) { slotScheduled = true; setTimeout(() => requestAnimationFrame(flushSlots), wait); return; }
    lastSlotUpdate = performance.now();
    for (const [name, update] of pendingSlots) applySlot(name, update.config, update.options);
    pendingSlots.clear();
  }
  function scheduleSlots() {
    if (slotScheduled) return;
    slotScheduled = true; requestAnimationFrame(flushSlots);
  }
  function clearSlot(name) {
    pendingSlots.delete(name);
    const entry = slots.get(name);
    if (entry) { entry.node.remove(); slots.delete(name); }
  }
  function clearSlots() { for (const name of new Set([...slots.keys(), ...pendingSlots.keys()])) clearSlot(name); }
  // A custom page inside a slot has its own opaque frame. Only its same-origin parent shell
  // can forward the already-validated slot CSS; retain it across the child frame's load.
  window.addEventListener('message', event => {
    if (window.parent === window || event.source !== window.parent || event.origin !== location.origin ||
        new URLSearchParams(location.search).get('embedded') !== '1') return;
    if (!object(event.data) || event.data.antena !== 1 || typeof event.data.slotCss !== 'string') return;
    inheritedSlotCss = event.data.slotCss;
    frame.contentWindow?.postMessage({ antena: 1, slotCss: inheritedSlotCss }, '*');
  });
  window.addEventListener('message', event => {
    if (!frame.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const data = event.data;
    if (!object(data) || data.antena !== 1 || !own(data, 'slots')) return;
    const request = data.slots;
    if (!object(request)) return slotError();
    if (request.op === 'clear') {
      if (!only(request, ['op', 'name']) || (request.name !== undefined && !nameOK(request.name))) return slotError();
      if (request.name === undefined) clearSlots(); else clearSlot(request.name);
      return;
    }
    if (request.op !== 'place' || !only(request, ['op', 'slots', 'options']) || !object(request.slots)) return slotError();
    const options = parseOptions(request.options);
    if (!options) return slotError();
    let invalid = false;
    const names = new Set([...slots.keys(), ...pendingSlots.keys()]);
    for (const [name, value] of Object.entries(request.slots)) {
      const config = nameOK(name) && parseSlot(value);
      if (!config || (!names.has(name) && names.size >= 12)) { invalid = true; continue; }
      names.add(name); pendingSlots.set(name, { config, options });
    }
    if (invalid) slotError();
    if (pendingSlots.size) scheduleSlots();
  });

  // Puente de acciones (S11b): el SDK del marco pide una acción y esta shell —que sí está en el
  // origen del panel— la manda a la ruta de acciones de SU overlay. Se atiende SOLO al marco
  // propio (su ventana actual), que vive en un origen opaco («null»): si el código del usuario
  // navega el marco a otra web, la ventana sigue siendo frame.contentWindow pero su origen ya no
  // es opaco y sus mensajes se ignoran. La ruta y el método son fijos y el mensaje nunca los
  // elige, y de vuelta solo viaja { ok } o el texto del error: al código del usuario no le llega
  // ningún dato del servidor. Sin aprobación o pasado el límite, el servidor responde 403/429.
  const RUN_MAX_BODY = 65536;   // el cuerpo de una acción es pequeño: nada de mandar megas
  window.addEventListener('message', event => {
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    if (event.origin !== 'null') return;   // solo el sandbox opaco, no una web en la que navegó
    const data = event.data;
    if (!data || typeof data !== 'object' || data.antena !== 1 || !data.run || typeof data.run !== 'object') return;
    const run = data.run;
    const reqId = run.reqId;
    if (typeof reqId !== 'string' || !reqId || reqId.length > 80) return;   // sin id no hay respuesta que dar
    const answer = (ok, error) => {
      if (!frame.contentWindow) return;
      frame.contentWindow.postMessage({ antena: 1, runResult: { reqId, ok, ...(ok ? {} : { error }) } }, '*');
    };
    const fail = text => answer(false, text);
    if (typeof run.kind !== 'string' || !run.kind) return fail('Tipo de acción no válido');
    if (run.params !== undefined && (run.params === null || typeof run.params !== 'object' || Array.isArray(run.params))) {
      return fail('Los parámetros de la acción tienen que ser un objeto');
    }
    const body = JSON.stringify({ kind: run.kind, params: run.params || {} });
    if (body.length > RUN_MAX_BODY) return fail('La acción es demasiado grande');
    fetch('/api/custom-overlays/' + encodeURIComponent(id) + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(async response => {
      const out = await response.json().catch(() => ({}));
      if (!response.ok) return fail(typeof out.error === 'string' && out.error ? out.error : 'No se pudo ejecutar la acción (' + response.status + ')');
      answer(true);
    }).catch(() => fail('No se pudo ejecutar la acción: no hay conexión con antena'));
  });

  // Marco nuevo (primer carga o recarga tras guardar): le llega el snapshot vigente de cada evento.
  frame.addEventListener('load', () => {
    loaded = true;
    if (inheritedSlotCss !== null) frame.contentWindow?.postMessage({ antena: 1, slotCss: inheritedSlotCss }, '*');
    for (const event of SNAPSHOTS) if (event in state) post(event, state[event]);
    sendReady();
  });

  // La conexión (cliente «widget», nunca «overlay») la pone la utilidad común de los widgets.
  import('/widgets/widget.js').then(({ connect }) => connect({
    widgets: relay('widgets'),
    viewers: relay('viewers'),
    interactive: relay('interactive'),
    // Escenas al aire (lista de { id, name }); la utilidad común pide el opt-in al ver este manejador.
    scene: relay('scene'),
    // Live only: the scene Antena just ordered, before the program confirms it.
    sceneSwitch: relay('sceneSwitch'),
    customOverlayTheme: relayTheme,
    chat: relay('chat'),
    publicAlert: data => relay('alert')(data),
    customOverlayVersions: v => {
      if (!(id in v) || v[id] === version) return;
      version = v[id];
      clearSlots();
      frame.src = '/custom/' + id + '/frame?v=' + version;
    },
    // Prueba lanzada desde el panel o el MCP: efímera y dirigida a UNA capa (el id tiene que ser
    // el suyo; las demás la ignoran). Llega al marco como el mensaje { antena: 1, event, data }
    // de siempre, así que el SDK no necesita nada nuevo.
    customOverlayTest: test => {
      if (!test || test.id !== id) return;
      post(test.event, test.data);
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
<link href="/theme.css" rel="stylesheet" id="antena-look">
<script src="/custom/sdk.js"></script>
<style>html,body{margin:0}${bg}</style>
<style>${String(overlay.css || '').replace(/<\/style/gi, '<\\/style')}</style>
<style id="antena-theme-extra"></style>
</head><body>
${overlay.html || ''}
<script>${String(overlay.js || '').replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;
}
