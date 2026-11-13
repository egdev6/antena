// Test del módulo src/routes/meld.mjs (tercer corte de #119): control remoto de Meld
// (/api/meld*). No arranca la app ni toca Meld real: construye un ctx falso y llama a
// los handlers igual que el dispatcher de server.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerMeldRoutes } from '../src/routes/meld.mjs';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ctx falso con las mismas piezas que createApp pasa por ctx.
function fakeCtx({ connected = false } = {}) {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const calls = [];
  const meld = {
    connected,
    status: 'off',
    session: () => ({ scenes: [{ id: 's1' }] }),
    stop: () => { calls.push('stop'); meld.connected = false; meld.status = 'off'; },
    start: url => { calls.push(['start', url]); meld.connected = true; meld.status = 'on'; },
    showScene: async scene => { calls.push(['showScene', scene]); return { name: scene }; },
    setLayer: async (scene, layer, vis) => { calls.push(['setLayer', scene, layer, vis]); return { scene: { id: 's1', name: scene }, layer: { id: 'l1', name: layer } }; },
    toggleEffect: async (...a) => calls.push(['toggleEffect', ...a]),
    command: async c => calls.push(['command', c]),
    streamEvent: async (e, o) => calls.push(['streamEvent', e, o]),
    setGain: async (...a) => calls.push(['setGain', ...a]),
    toggleMute: async t => calls.push(['toggleMute', t]),
    media: async (...a) => calls.push(['media', ...a]),
    setProperty: async (...a) => calls.push(['setProperty', ...a]),
    call: async (...a) => { calls.push(['call', ...a]); return 'res'; },
  };
  const ctx = {
    route,
    store: { config: { meld: { url: 'ws://meld:99' } }, patchConfig: async p => { Object.assign(ctx.store.config.meld, p.meld); } },
    meld,
    scheduleLayerHide: (s, l, ms) => calls.push(['scheduleLayerHide', s, l, ms]),
    httpError,
    _spies: { calls },
  };
  registerMeldRoutes(ctx);
  const find = (method, path) => {
    const r = routes.find(x => x.method === method && x.re.test(path));
    assert.ok(r, `${method} ${path} registrada`);
    return { vars: path.match(r.re).groups, fn: r.fn };
  };
  return { ctx, routes, find };
}

test('registra exactamente las rutas de Meld', () => {
  const { routes } = fakeCtx();
  assert.deepEqual(routes.map(r => `${r.method} ${r.pattern}`), [
    'GET /api/meld', 'POST /api/meld/connect', 'POST /api/meld/disconnect',
    'POST /api/meld/scene', 'POST /api/meld/layer', 'POST /api/meld/effect',
    'POST /api/meld/stream',
    'POST /api/meld/command', 'POST /api/meld/event', 'POST /api/meld/track',
    'POST /api/meld/media', 'POST /api/meld/property', 'POST /api/meld/call',
  ]);
});

test('GET /api/meld y connect/disconnect tocan la config', async () => {
  const { ctx, find } = fakeCtx();
  const st = await find('GET', '/api/meld').fn();
  assert.equal(st.status, 'off');
  assert.deepEqual(st.scenes, [{ id: 's1' }]);
  assert.ok(Array.isArray(st.commands) && Array.isArray(st.events));
  await find('POST', '/api/meld/connect').fn({ url: 'ws://otro:1' });
  assert.equal(ctx.store.config.meld.enabled, true);
  assert.deepEqual(ctx._spies.calls.slice(-2), ['stop', ['start', 'ws://otro:1']]);
  assert.equal(ctx.store.config.meld.url, 'ws://otro:1');
  await find('POST', '/api/meld/disconnect').fn();
  assert.equal(ctx.store.config.meld.enabled, false);
  assert.deepEqual(await find('POST', '/api/meld/disconnect').fn(), 'off');
});

test('handlers de control exigen Meld conectado (409) y sin conexión no tocan nada', async () => {
  const { ctx, find } = fakeCtx();
  for (const [path, body] of [
    ['/api/meld/scene', { scene: 'x' }], ['/api/meld/layer', { scene: 'x', layer: 'y' }],
    ['/api/meld/effect', {}], ['/api/meld/command', {}], ['/api/meld/event', {}],
    ['/api/meld/track', {}], ['/api/meld/media', {}], ['/api/meld/property', {}], ['/api/meld/call', {}],
  ]) {
    await assert.rejects(find('POST', path).fn(body), e => e.status === 409 && /Meld no está conectado/.test(e.message));
  }
  assert.deepEqual(ctx._spies.calls, []);
});

test('con Meld conectado: scene, layer con ocultado diferido, effect, command, event, track, media, property y call', async () => {
  const { ctx, find } = fakeCtx({ connected: true });
  assert.deepEqual(await find('POST', '/api/meld/scene').fn({ scene: 'Escena' }), { scene: 'Escena' });
  assert.deepEqual(await find('POST', '/api/meld/layer').fn({ scene: 'E', layer: 'L', visible: true, seconds: 5 }), { scene: 'E', layer: 'L' });
  assert.deepEqual(ctx._spies.calls.at(-1), ['scheduleLayerHide', 's1', 'l1', 5000]);
  // visible false no programa ocultado
  await find('POST', '/api/meld/layer').fn({ scene: 'E', layer: 'L2', visible: false, seconds: 5 });
  assert.ok(!ctx._spies.calls.some(c => c[0] === 'scheduleLayerHide' && c[2] === 'l2'));
  await find('POST', '/api/meld/layer').fn({ scene: 'E', layer: 'L3', visible: true });
  assert.equal(ctx._spies.calls.filter(c => c[0] === 'scheduleLayerHide').length, 1); // sin seconds no programa
  await find('POST', '/api/meld/effect').fn({ scene: 'E', layer: 'L', effect: 'blur' });
  await find('POST', '/api/meld/command').fn({ command: 'cut' });
  await find('POST', '/api/meld/event').fn({ event: 'goal', amount: '3' });
  assert.deepEqual(ctx._spies.calls.at(-1), ['streamEvent', 'goal', { amount: 3 }]);
  await find('POST', '/api/meld/track').fn({ track: 't1', action: 'gain', gain: 0.5 });
  assert.deepEqual(ctx._spies.calls.at(-1), ['setGain', 't1', 0.5]);
  await find('POST', '/api/meld/track').fn({ track: 't1' });
  assert.deepEqual(ctx._spies.calls.at(-1), ['toggleMute', 't1']);
  await find('POST', '/api/meld/media').fn({ layer: 'l1', command: 'pause', seconds: 2 });
  assert.deepEqual(ctx._spies.calls.at(-1), ['media', 'l1', 'pause', 2]);
  await find('POST', '/api/meld/property').fn({ id: 'p1', property: 'x', value: 1 });
  assert.deepEqual(await find('POST', '/api/meld/call').fn({ method: 'foo', args: [1] }), { result: 'res' });
  assert.ok(ctx._spies.calls.some(c => c[0] === 'setProperty'));
});
