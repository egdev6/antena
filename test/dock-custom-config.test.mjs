// #39 S1/S2/S4/S5: defaults, schema and the pure layout projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/store.mjs';
import { validatePatch, validatePath } from '../src/config-schema.mjs';
import { createApp } from '../src/server.mjs';

const ids = ['stream', 'alerts', 'marks', 'scenes', 'teleprompter', 'credits', 'audio', 'questions', 'tierlist', 'giveaway', 'shortcuts', 'interview'];
const modules = ids.map(id => ({ id, enabled: id !== 'shortcuts' && id !== 'interview' }));
const zones = [
  { id: 'control', label: 'Control', modules: ids.slice(0, 6) },
  { id: 'audio', label: 'Audio', modules: ['audio'] },
  { id: 'interactivos', label: 'Interactivos', modules: ['questions', 'tierlist', 'giveaway'] },
];

test('S4/S5: default config reproduces the original three zones and disables shortcuts and interview', () => {
  const defaultZones = [...zones.slice(0, 2), { ...zones[2], modules: [...zones[2].modules, 'interview'] }];
  assert.deepEqual(DEFAULT_CONFIG.dock, { modules, layout: 'auto', zones: defaultZones });
  assert.deepEqual(validatePatch({ dock: DEFAULT_CONFIG.dock }), []);
});

test('S1/S2: schema validates layout and module/zone fields on patch and path', () => {
  for (const layout of ['auto', 'tabs', 'columns', 'split-v', 'split-h']) assert.deepEqual(validatePath('dock.layout', layout), []);
  for (const [value, path] of [
    [{ layout: 'grid' }, 'dock.layout'],
    [{ modules: 'alerts' }, 'dock.modules'],
    [{ modules: [{ id: 5, enabled: true }] }, 'dock.modules.0.id'],
    [{ modules: [{ id: 'audio', enabled: 'yes' }] }, 'dock.modules.0.enabled'],
    [{ zones: 'control' }, 'dock.zones'],
    [{ zones: [{ id: 9, label: 'X', modules: [] }] }, 'dock.zones.0.id'],
    [{ zones: [{ id: 'x', label: false, modules: [] }] }, 'dock.zones.0.label'],
    [{ zones: [{ id: 'x', label: 'X', modules: [3] }] }, 'dock.zones.0.modules'],
  ]) assert.ok(validatePatch({ dock: value }).some(e => e.path === path), path);
  // Forward-compatible unknown module IDs are removed by the projection, not rejected.
  assert.deepEqual(validatePatch({ dock: { modules: [{ id: 'future', enabled: true }], zones: [{ id: 'x', label: 'X', modules: ['future'] }] } }), []);
  assert.equal(validatePath('dock.modules.0.enabled', 'yes')[0].message, 'dock.modules.0.enabled: se esperaba true o false');
});

test('S1/S2/S5: normalization removes unknown/duplicate/disabled modules, orders globally and appends unplaced to last zone', async () => {
  const { normalizeDock } = await import('../src/dock-layout.mjs');
  const input = {
    layout: 'columns',
    modules: [{ id: 'credits', enabled: true }, { id: 'audio', enabled: false }, { id: 'marks', enabled: true },
      { id: 'credits', enabled: true }, { id: 'future', enabled: true }, { id: 'stream', enabled: true }],
    zones: [{ id: 'first', label: 'Primera', modules: ['marks', 'credits', 'credits', 'audio', 'future'] },
      { id: 'empty', label: 'Vacía', modules: ['audio'] },
      { id: 'last', label: 'Última', modules: ['marks'] }],
  };
  const before = structuredClone(input);
  const result = normalizeDock(input);
  assert.deepEqual(input, before, 'projection is pure');
  assert.deepEqual(result.modules, [{ id: 'credits', enabled: true }, { id: 'audio', enabled: false }, { id: 'marks', enabled: true }, { id: 'stream', enabled: true }]);
  assert.equal(result.layout, 'columns');
  assert.deepEqual(result.zones, [
    { id: 'first', label: 'Primera', modules: ['credits', 'marks'] },
    { id: 'last', label: 'Última', modules: ['stream'] },
  ]);
  assert.deepEqual(normalizeDock(DEFAULT_CONFIG.dock).zones, zones);
});

test('S2/S5: the shared projection limits split layouts to the first two nonempty zones', async () => {
  const { normalizeDock, visibleDockZones } = await import('../src/dock-layout.mjs');
  const dock = normalizeDock({ layout: 'split-v', modules, zones: [zones[0], { id: 'empty', label: 'Vacía', modules: [] }, zones[1], zones[2]] });
  for (const layout of ['split-v', 'split-h']) assert.deepEqual(visibleDockZones(dock.zones, layout), [zones[0], zones[1]]);
  assert.deepEqual(visibleDockZones(dock.zones, 'tabs'), zones, 'fallback tabs can reach every zone');
  assert.deepEqual(dock.zones, zones, 'projection does not mutate the normalized config');
});

test('S5: unplaced enabled modules append after the last zone’s existing modules', async () => {
  const { normalizeDock } = await import('../src/dock-layout.mjs');
  const dock = { layout: 'columns', modules: [{ id: 'stream', enabled: true }, { id: 'alerts', enabled: true }, { id: 'credits', enabled: true }],
    zones: [{ id: 'first', label: 'Primera', modules: ['alerts'] }, { id: 'last', label: 'Última', modules: ['credits'] }] };
  assert.deepEqual(normalizeDock(dock).zones, [
    { id: 'first', label: 'Primera', modules: ['alerts'] },
    { id: 'last', label: 'Última', modules: ['credits', 'stream'] },
  ]);
});

test('S1/S2: HTTP rejects invalid dock fields without changing stored config', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dock-config-'));
  let app;
  t.after(async () => { if (app) await app.closeHttp(); await rm(root, { recursive: true, force: true }); });
  app = await createApp({ dataDir: path.join(root, 'data'), mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const before = await call('GET', '/api/config');
  for (const [method, p, body, message] of [
    ['PUT', '/api/config', { dock: { layout: 'grid' } }, 'dock.layout: se esperaba uno de: auto, tabs, columns, split-v, split-h'],
    ['POST', '/api/config/set', { path: 'dock.modules.0.enabled', value: 'yes' }, 'dock.modules.0.enabled: se esperaba true o false'],
  ]) {
    const result = await call(method, p, body);
    assert.equal(result.status, 400); assert.equal(result.body.error, message);
    assert.deepEqual((await call('GET', '/api/config')).body, before.body);
  }
  const valid = await call('PUT', '/api/config', { dock: { layout: 'tabs' } });
  assert.equal(valid.status, 200); assert.equal((await call('GET', '/api/config')).body.dock.layout, 'tabs');
});
