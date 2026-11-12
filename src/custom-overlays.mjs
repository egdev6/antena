// Custom overlays: HTML/CSS/JS pages written by the user or the agent (MCP) and added to
// Meld as browser layers. User code never runs on antena's origin: /custom/<id> is a trusted
// shell that embeds /custom/<id>/frame in <iframe sandbox="allow-scripts">, and the frame
// response carries `Content-Security-Policy: sandbox allow-scripts`, so the code lives in an
// opaque origin. The server rejects its mutating requests (Origin: null) and, without CORS,
// it cannot read the API or open the SSE stream. Data reaches it only via postMessage, and the
// only way back out is the action bridge (S11): the SDK posts a run request to this shell, which
// forwards it to the overlay's own action route and answers with ok/error only.
import { httpError, id8 } from './http-util.mjs';
import { MELD_STREAM_EVENTS } from './meld.mjs';

export const CUSTOM_OVERLAY_MAX_BYTES = 512_000;        // one overlay, as JSON
export const CUSTOM_OVERLAYS_MAX_BYTES = 2_500_000;     // the whole list, as JSON
export const CUSTOM_OVERLAYS_MAX_ITEMS = 50;
export const CUSTOM_OVERLAY_ID = /^[a-z0-9-]{1,40}$/;
export const FRAME_CSP = 'sandbox allow-scripts';

/** Action kinds an overlay may request (S11): exactly the ones Engine.#execAction dispatches
 *  (src/engine.mjs) — the same list alerts, timers and shortcuts run. Single source for the
 *  schema (src/config-schema.mjs), the MCP enum and the route validation. */
export const CUSTOM_OVERLAY_ACTION_KINDS = ['scene', 'layer', 'hideLayer', 'toggleLayer', 'effect', 'command', 'streamEvent', 'chat', 'say'];

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
      permissions: [], approvedAt: 0, approvedUpdatedAt: 0,
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
      // Se conservan las aprobaciones que el overlay sigue pidiendo. Aprobar es cosa del usuario:
      // ni editar ni la config genérica aprueban ni amplían nada.
      permissions: approvalsWithinRequest(prev.permissions, requestedPermissions),
      approvedAt: prev.approvedAt ?? 0,
      // Versión aprobada por el usuario: si el código cambió después, el panel lo avisa (S11d).
      approvedUpdatedAt: prev.approvedUpdatedAt ?? 0,
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
      // La config genérica (PUT /api/config, POST /api/config/set, cambiar_config del MCP) jamás
      // aprueba: mantiene las aprobaciones guardadas de ese id (o ninguna si el id es nuevo).
      overlay.permissions = approvalsWithinRequest(old?.permissions, overlay.requestedPermissions);
      overlay.approvedAt = old?.approvedAt ?? 0;
      overlay.approvedUpdatedAt = old?.approvedUpdatedAt ?? 0;
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
<link href="/theme.css" rel="stylesheet">
<script src="/custom/sdk.js"></script>
<style>html,body{margin:0}${bg}</style>
<style>${String(overlay.css || '').replace(/<\/style/gi, '<\\/style')}</style>
</head><body>
${overlay.html || ''}
<script>${String(overlay.js || '').replace(/<\/script/gi, '<\\/script')}</script>
</body></html>`;
}
