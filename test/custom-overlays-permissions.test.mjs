// S11/S11a/S11b/S11c: acciones de un overlay propio solo con los permisos que el USUARIO
// aprueba en el panel. Todo por las interfaces públicas (HTTP y SSE): crear/editar/MCP/config
// genérica solo PIDEN permisos (nunca los aprueban), la aprobación exige una petición del
// navegador del panel (Sec-Fetch-Site: same-origin), la acción se ejecuta por el motor y las
// rechazos (403, 400, 429, origen opaco) no ejecutan nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
const APPROVAL_KEYS = ['requestedPermissions', 'permissions', 'approvedAt', 'approvedUpdatedAt'];

async function start() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-overlays-perm-'));
  const logs = [];
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: (...a) => logs.push(a.join(' ')) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const raw = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const call = async (method, p, body, headers) => {
    const r = await raw(method, p, body, headers);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error), { status: r.status });
    return d;
  };
  const attempt = async (method, p, body, headers) => {
    const r = await raw(method, p, body, headers);
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  /** Cabeceras que manda el navegador del panel en una petición de su mismo origen. */
  const panel = { Origin: base, 'Sec-Fetch-Site': 'same-origin' };
  /** Origen opaco del marco del overlay (S5): un navegador dentro del iframe sandbox. */
  const opaque = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  const overlays = async () => (await call('GET', '/api/custom-overlays')).overlays;
  return {
    app, base, raw, call, attempt, panel, opaque, overlays, logs,
    close: () => new Promise(r => { app.meld.stop(); app.server.closeAllConnections(); app.server.close(r); }),
  };
}

/** Meld simulado conectado: lo que permite observar si una acción se ejecutó de verdad. */
async function connectMeld(app, call) {
  const srv = fakeMeld();
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  await call('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${srv.server.address().port}` });
  for (let i = 0; i < 40 && app.meld.status.state !== 'conectado'; i++) await sleep(25);
  assert.equal(app.meld.status.state, 'conectado', 'el Meld simulado no conectó');
  return srv;
}

async function sse(url) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  async function next(name, pred = () => true, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = events.findIndex(e => e.event === name && pred(e.data));
      if (i >= 0) return events.splice(i, 1)[0].data;
      if (Date.now() > deadline) throw new Error(`no "${name}" event within ${timeoutMs} ms`);
      const { value, done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 100))]);
      if (done) throw new Error('stream closed');
      if (!value) continue;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  }
  return { next, close: () => ctrl.abort() };
}

test('S11a: crear, editar, config genérica y setPath nunca aprueban ni amplían permisos', async () => {
  const { call, panel, close } = await start();
  try {
    // Un create que INTENTA darse permisos: solo queda la petición, y las aprobaciones son [].
    const { overlay } = await call('POST', '/api/custom-overlays', {
      name: 'A', requestedPermissions: ['scene', 'chat'], permissions: ['chat', 'say'], approvedAt: 1, approvedUpdatedAt: 2,
    });
    assert.deepEqual(pick(overlay, APPROVAL_KEYS), { requestedPermissions: ['scene', 'chat'], permissions: [], approvedAt: 0, approvedUpdatedAt: 0 });

    // La aprobación real (desde el navegador del panel) queda guardada con su marca de tiempo.
    const approved = await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, panel);
    assert.deepEqual(approved.overlay.permissions, ['scene']);
    assert.equal(typeof approved.overlay.approvedAt, 'number');
    assert.ok(approved.overlay.approvedAt > 0);
    assert.equal(approved.overlay.approvedUpdatedAt, overlay.updatedAt, 'guarda la versión aprobada');
    assert.equal(approved.overlay.updatedAt, overlay.updatedAt, 'aprobar no versiona el código: las capas no recargan');

    // Editar el código intentando ampliar: los permisos aprobados se quedan como estaban.
    const edited = await call('PUT', `/api/custom-overlays/${overlay.id}`, { js: 'x', permissions: ['scene', 'chat', 'say'], approvedAt: 1 });
    assert.deepEqual(edited.overlay.permissions, ['scene']);
    assert.equal(edited.overlay.approvedAt, approved.overlay.approvedAt, 'la marca de aprobación no se reescribe');

    // Escritura genérica de configuración (PUT /api/config) y de ruta (POST /api/config/set).
    await call('PUT', '/api/config', { customOverlays: [{ ...edited.overlay, permissions: ['chat', 'say'] }] });
    await call('POST', '/api/config/set', { path: 'customOverlays.0.permissions', value: ['chat', 'say'] });
    const [stored] = (await call('GET', '/api/custom-overlays')).overlays;
    assert.deepEqual(stored.permissions, ['scene'], 'las escrituras genéricas conservan lo aprobado');
    assert.equal(stored.approvedAt, approved.overlay.approvedAt);
    assert.deepEqual(stored.requestedPermissions, ['scene', 'chat']);
  } finally { await close(); }
});

test('S11a: los permisos solicitados se validan contra los tipos de acción del motor', async () => {
  const { call, attempt, overlays, close } = await start();
  try {
    // Se guardan en orden canónico y sin repetidos.
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['say', 'scene', 'scene'] });
    assert.deepEqual(overlay.requestedPermissions, ['scene', 'say']);
    const before = await overlays();
    const bad = [
      ['POST', '/api/custom-overlays', { name: 'B', requestedPermissions: ['scene', 'nope'] }],
      ['POST', '/api/custom-overlays', { name: 'B', requestedPermissions: 'scene' }],
      ['POST', '/api/custom-overlays', { name: 'B', requestedPermissions: [5] }],
      ['PUT', `/api/custom-overlays/${overlay.id}`, { requestedPermissions: ['nada'] }],
      ['POST', '/api/config/set', { path: 'customOverlays.0.requestedPermissions', value: ['nada'] }],
      ['PUT', '/api/config', { customOverlays: [{ ...overlay, requestedPermissions: ['nada'] }] }],
    ];
    for (const [m, p, body] of bad) {
      const r = await attempt(m, p, body);
      assert.equal(r.status, 400, `${m} ${p} ${JSON.stringify(body).slice(0, 70)}`);
      assert.match(r.body.error, /permiso/i);
    }
    assert.deepEqual(await overlays(), before, 'ningún rechazo guarda nada');
    // Una lista nueva sustituye la petición (y sigue sin tocar las aprobaciones).
    const swapped = await call('PUT', `/api/custom-overlays/${overlay.id}`, { requestedPermissions: ['chat'] });
    assert.deepEqual(swapped.overlay.requestedPermissions, ['chat']);
    assert.deepEqual(swapped.overlay.permissions, []);
  } finally { await close(); }
});

test('S11a: aprobar exige una petición same-origin del panel, y solo dentro de lo pedido', async () => {
  const { call, attempt, panel, opaque, overlays, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    const before = await overlays();
    // Sin cabeceras de navegador (fetch de Node, MCP, curl): no es el panel.
    const noBrowser = await attempt('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] });
    assert.equal(noBrowser.status, 403);
    assert.match(noBrowser.body.error, /panel/i);
    assert.match(noBrowser.body.error, /permis/i);
    // Origen opaco (el marco): tampoco.
    const fromFrame = await attempt('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, opaque);
    assert.equal(fromFrame.status, 403);
    // Del panel, pero fuera de lo que el overlay pide: 400.
    const outside = await attempt('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['chat'] }, panel);
    assert.equal(outside.status, 400);
    assert.match(outside.body.error, /no ha pedido/);
    // Cuerpo inválido: 400.
    for (const body of [{ permissions: 'scene' }, {}, { permissions: [5] }]) {
      const r = await attempt('PUT', `/api/custom-overlays/${overlay.id}/permissions`, body, panel);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await overlays(), before, 'ningún rechazo cambia los permisos');
    // Un id desconocido del panel: 404; desde fuera, 403 (no se puede sondear desde el MCP).
    assert.equal((await attempt('PUT', '/api/custom-overlays/nope/permissions', { permissions: [] }, panel)).status, 404);
    assert.equal((await attempt('PUT', '/api/custom-overlays/nope/permissions', { permissions: [] })).status, 403);
  } finally { await close(); }
});

test('S11a: las aprobaciones nunca superan lo pedido; al reducir la petición se retiran', async () => {
  const { call, attempt, panel, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene', 'chat'] });
    const approved = await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene', 'chat'] }, panel);
    assert.deepEqual(approved.overlay.permissions, ['scene', 'chat']);
    // El agente (o el usuario por config) reduce lo pedido: la aprobación que ya no se pide se retira.
    const shrunk = await call('PUT', `/api/custom-overlays/${overlay.id}`, { requestedPermissions: ['scene'] });
    assert.deepEqual(shrunk.overlay.requestedPermissions, ['scene']);
    assert.deepEqual(shrunk.overlay.permissions, ['scene']);
    // Y ya no se puede volver a aprobar lo que no se pide.
    const again = await attempt('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['chat'] }, panel);
    assert.equal(again.status, 400);
    assert.deepEqual((await call('GET', '/api/custom-overlays/' + overlay.id)).overlay.permissions, ['scene']);
  } finally { await close(); }
});

test('S11a: el panel recibe las aprobaciones por SSE (otra ventana las ve sin recargar)', async () => {
  const { app, base, call, panel, close } = await start();
  const stream = await sse(base + '/api/stream?client=panel');
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    await stream.next('customOverlays', d => d.some(o => o.id === overlay.id));
    await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, panel);
    const list = await stream.next('customOverlays', d => d.some(o => o.id === overlay.id && o.permissions?.length === 1));
    assert.deepEqual(list.find(o => o.id === overlay.id).permissions, ['scene']);
    assert.equal(app.store.config.customOverlays.find(o => o.id === overlay.id).permissions.length, 1);
  } finally { stream.close(); await close(); }
});

test('S11b: una acción no aprobada responde 403 y no ejecuta nada', async () => {
  const { app, call, attempt, panel, close } = await start();
  let meldSrv;
  try {
    meldSrv = await connectMeld(app, call);
    // El overlay PIDE escena pero no está aprobada.
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    const denied = await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, panel);
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /permiso/i);
    assert.deepEqual(meldSrv.state.calls, [], 'no se mandó nada a Meld');
    assert.equal(app.meld.session().scenes.find(s => s.current).name, 'Cámara', 'la escena no cambió');
    // Tampoco una acción que ni siquiera se ha pedido.
    const unrequested = await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'say', params: { text: 'hola' } }, panel);
    assert.equal(unrequested.status, 403);
    assert.deepEqual(meldSrv.state.calls, []);
  } finally { meldSrv?.server.close(); await close(); }
});

test('S11b: una acción aprobada se ejecuta por el motor del directo', async () => {
  const { app, base, call, panel, close } = await start();
  let meldSrv;
  const overlayStream = await sse(base + '/api/stream?client=overlay');
  try {
    meldSrv = await connectMeld(app, call);
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene', 'say'] });
    await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene', 'say'] }, panel);
    // Meld: la escena cambia de verdad (la misma ruta que las acciones de una alerta).
    const ran = await call('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, panel);
    assert.deepEqual(ran, { ok: true });
    assert.deepEqual(meldSrv.state.calls, [[10, 's2']]);
    assert.equal(app.meld.session().scenes.find(s => s.current).name, 'Pantalla');
    // Una acción que no toca Meld también pasa por el motor (voz al overlay de alertas).
    await call('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'say', params: { text: 'hola desde el overlay' } }, panel);
    const said = await overlayStream.next('say', d => d.text.includes('hola desde el overlay'));
    assert.equal(said.text, 'hola desde el overlay');
  } finally { overlayStream.close(); meldSrv?.server.close(); await close(); }
});

test('S11b: parámetros inválidos o un tipo desconocido son 400 y no ejecutan nada', async () => {
  const { app, call, attempt, panel, close } = await start();
  let meldSrv;
  try {
    meldSrv = await connectMeld(app, call);
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene', 'layer', 'chat'] });
    await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene', 'layer', 'chat'] }, panel);
    const bad = [
      [{ kind: 'scene', params: {} }, /scene/i],
      [{ kind: 'scene', params: { scene: '  ' } }, /scene/i],
      [{ kind: 'scene', params: 'Pantalla' }, /objeto/i],
      [{ kind: 'layer', params: { scene: 's1' } }, /layer/i],
      [{ kind: 'chat', params: { text: 'hola', destination: 'matrix' } }, /destino/i],
      [{ kind: 'nope', params: {} }, /tipo/i],
    ];
    for (const [body, msg] of bad) {
      const r = await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, body, panel);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(r.body.error, msg, JSON.stringify(body).slice(0, 80));
    }
    assert.deepEqual(meldSrv.state.calls, [], 'ninguno de los rechazos ejecutó una acción');
    // Un overlay desconocido no existe para la ruta de acciones; un id mal formado es 400.
    assert.equal((await attempt('POST', '/api/custom-overlays/nope/action', { kind: 'scene', params: { scene: 'Pantalla' } }, panel)).status, 404);
    assert.equal((await attempt('POST', '/api/custom-overlays/%zz/action', { kind: 'scene', params: {} }, panel)).status, 400);
  } finally { meldSrv?.server.close(); await close(); }
});

test('S11b: el marco opaco no puede llamar a la ruta de acciones (la shell es el único puente)', async () => {
  const { app, call, attempt, panel, opaque, close } = await start();
  let meldSrv;
  try {
    meldSrv = await connectMeld(app, call);
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, panel);
    const fromFrame = await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, opaque);
    assert.equal(fromFrame.status, 403);
    assert.deepEqual(meldSrv.state.calls, []);
    assert.equal((await call('GET', '/api/custom-overlays/' + overlay.id)).overlay.permissions.length, 1, 'el 403 no cambió nada');
  } finally { meldSrv?.server.close(); await close(); }
});

test('S11c: como mucho 10 acciones cada 10 s por overlay; la 11.ª es 429 y no ejecuta', async () => {
  const { app, call, attempt, panel, close } = await start();
  let meldSrv;
  try {
    meldSrv = await connectMeld(app, call);
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, panel);
    for (let i = 1; i <= 10; i++) {
      const ran = await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, panel);
      assert.equal(ran.status, 200, `la acción ${i} de 10 está dentro del límite`);
    }
    assert.equal(meldSrv.state.calls.length, 10);
    const over = await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, panel);
    assert.equal(over.status, 429);
    assert.match(over.body.error, /demasiadas|espera/i);
    assert.equal(meldSrv.state.calls.length, 10, 'la 11.ª no se ejecutó');
    // El límite es por overlay: otro overlay sigue dentro de su ventana.
    const other = await call('POST', '/api/custom-overlays', { name: 'B', requestedPermissions: ['scene'] });
    await call('PUT', `/api/custom-overlays/${other.overlay.id}/permissions`, { permissions: ['scene'] }, panel);
    assert.equal((await attempt('POST', `/api/custom-overlays/${other.overlay.id}/action`, { kind: 'scene', params: { scene: 'Cámara' } }, panel)).status, 200);
    assert.equal(meldSrv.state.calls.length, 11);
  } finally { meldSrv?.server.close(); await close(); }
});

test('S11b: la shell solo atiende a SU marco y reenvía a la ruta fija de su overlay', async () => {
  const { raw, call, close } = await start();
  try {
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    const html = await (await raw('GET', '/custom/' + overlay.id)).text();
    // Escucha mensajes, pero solo del marco que embebe y solo por su ventana actual.
    assert.match(html, /addEventListener\('message'/);
    assert.match(html, /event\.source !== frame\.contentWindow/);
    assert.match(html, /!frame\.contentWindow \|\| event\.source !== frame\.contentWindow/);
    // Solo el sandbox opaco: si el marco navega a otra web, sus mensajes (misma ventana) se
    // ignoran, así que esa web no hereda las acciones aprobadas del overlay.
    assert.match(html, /event\.origin !== 'null'/);
    // El mensaje nunca elige la URL ni el método: la ruta es la de ESTE overlay y siempre POST.
    assert.ok(html.includes("'/api/custom-overlays/' + encodeURIComponent(id) + '/action'"), 'la ruta es fija y de este overlay');
    assert.doesNotMatch(html, /run\.url|data\.url|run\.method/, 'el mensaje no puede elegir URL ni método');
    // De vuelta solo ok o el texto del error: ni resultado, ni cuerpo del servidor.
    assert.match(html, /runResult:\s*\{\s*reqId,\s*ok,\s*\.\.\.\(ok\s*\?\s*\{\}\s*:\s*\{\s*error\s*\}\)\s*\}/);
    assert.doesNotMatch(html, /d\s*\.\s*result|data\s*\.\s*result/, 'la shell nunca reenvía el resultado del servidor');
    // Y el marco sigue opaco: la shell solo escucha a su propio iframe sandbox.
    assert.match(html, /sandbox="allow-scripts"/);
    assert.doesNotMatch(html, /allow-same-origin/);
  } finally { await close(); }
});

test('S11: cada ejecución y cada rechazo de una acción queda en el registro', async () => {
  const { app, call, attempt, panel, opaque, logs, close } = await start();
  let meldSrv;
  try {
    meldSrv = await connectMeld(app, call);
    const { overlay } = await call('POST', '/api/custom-overlays', { name: 'A', requestedPermissions: ['scene'] });
    // Sin cabecera de panel la aprobación no se acepta y queda registrada.
    await attempt('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] });
    await call('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, panel);
    // Un rechazo por permiso y una ejecución aprobada.
    await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'say', params: { text: 'hola' } }, panel);
    await call('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, panel);
    // Y el rechazo por origen opaco lo corta el check de origen de siempre (403, sin ejecutar).
    assert.equal((await attempt('POST', `/api/custom-overlays/${overlay.id}/action`, { kind: 'scene', params: { scene: 'Pantalla' } }, opaque)).status, 403);
    const ours = () => logs.filter(l => l.includes('[overlays]'));
    const text = ours().join('\n');
    assert.match(text, /aprobación rechazada/);
    assert.match(text, new RegExp(`${overlay.id}.*permisos aprobados: scene`));
    assert.match(text, new RegExp(`${overlay.id}.*acción rechazada sin permiso: say`));
    assert.match(text, new RegExp(`${overlay.id}.*acción aprobada: scene`));
    // El cuerpo de la acción (texto de chat, etc.) nunca va al registro.
    assert.equal(text.includes('hola'), false);
  } finally { meldSrv?.server.close(); await close(); }
});
