import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { Store, DEFAULT_CONFIG, deepMerge } from '../src/store.mjs';
import { DEFAULT_THEME, themeCss } from '../src/theme.mjs';
import { DEFAULT_ALERTS, DEFAULT_COMMAND, DEFAULT_CONDITIONS, DEFAULT_CUSTOM_ALERT, buildAlert, buildCommandAlert, buildCustomAlert } from '../src/alerts.mjs';
import { alertFields } from '../src/timers.mjs';
import { CommandRunner } from '../src/commands.mjs';

const normal = { id: 'normal', name: 'Normal', active: true };
const sections = ['theme', 'alerts', 'overlay', 'widgets', 'interactive', 'commands', 'timers', 'customOverlayCss'];
const omitVolatile = ({ id, at, ...alert }) => alert;

async function fixture(t, config) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-saved-themes-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  if (config !== undefined) await writeFile(path.join(dataDir, 'config.json'), JSON.stringify(config));
  let app;
  t.after(async () => {
    try {
      if (app) {
        app.interactive.quiesceVoteTimer();
        await app.drainAutoSession(); await app.session.flush(); await app.interactive.flush();
        app.teleprompter.stop(); app.viewers.stop(); app.timers.stop();
        await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), push: {}, log: () => {} });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = async () => ({
    config: (await call('GET', '/api/config/export?format=json')).body.config,
    status: (await call('GET', '/api/status')).body.persistence,
    bytes: await readFile(path.join(dataDir, 'config.json'), 'utf8'),
    files: (await readdir(dataDir)).filter(n => n === 'config.json' || n.startsWith('config.backup-')).sort(),
  });
  return { app, base, call, snapshot, dataDir };
}

async function stream(t, base, client) {
  const ctrl = new AbortController(), timeout = setTimeout(() => ctrl.abort(), 5000);
  t.after(() => { clearTimeout(timeout); ctrl.abort(); });
  const response = await fetch(`${base}/api/stream?client=${client}`, { signal: ctrl.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(), pending = [];
  let buffer = '';
  return async (event, predicate = () => true) => {
    for (;;) {
      const i = pending.findIndex(frame => frame.event === event && predicate(frame.data));
      if (i >= 0) return pending.splice(i, 1)[0].data;
      const end = buffer.indexOf('\n\n');
      if (end < 0) { const next = await reader.read(); assert.equal(next.done, false); buffer += decoder.decode(next.value); continue; }
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const match = /^event: ([^\n]+)\ndata: (.+)$/s.exec(frame);
      if (match) pending.push({ event: match[1], data: JSON.parse(match[2]) });
    }
  };
}

test('extract/apply replace all element sections losslessly, without aliasing or system data', async () => {
  const { extractLook, applyLook } = await import('../src/theme-looks.mjs');
  const config = structuredClone(DEFAULT_CONFIG);
  config.customOverlayCss = { camera: '.extra {color: red}' };
  config.theme.icons.follow = 'heart'; config.alerts.follow.actions = [{ kind: 'scene', scene: 'a' }];
  config.overlay.queueMax = 3; config.widgets.futureWidget = { css: '.future{}' };
  config.interactive.questions.css = '.q{}'; config.commands = [{ id: 'a', nested: { a: 1 } }];
  config.timers = [{ id: 'b', nested: { b: 2 } }];
  config.customOverlays = [{ id: 'camera', html: '<p>global</p>', css: 'global', js: 'global', permissions: ['say'] }];
  const before = structuredClone(config), look = extractLook(config);
  assert.deepEqual(Object.keys(look).sort(), sections.sort());
  for (const key of sections) assert.deepEqual(look[key], before[key], key);
  look.theme.icons.follow = 'gift'; assert.equal(config.theme.icons.follow, 'heart');
  look.theme.icons.follow = 'heart';
  const target = structuredClone(config);
  for (const key of sections) target[key] = key === 'commands' || key === 'timers' ? [] : {};
  const changed = applyLook(target, look) ?? target;
  for (const key of sections) assert.deepEqual(changed[key], before[key], key);
  for (const key of Object.keys(before).filter(k => !sections.includes(k))) assert.deepEqual(changed[key], before[key], key);
  changed.alerts.follow.actions[0].scene = 'changed';
  assert.equal(look.alerts.follow.actions[0].scene, 'a');
});

test('v2 migration backs up bytes and freezes effective defaults in all element sections', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-themes-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const v2 = { configVersion: 2, theme: { accent: '#123456' }, alerts: { follow: { title: 'Hola' } },
    widgets: { chat: { fontSize: 31 } }, overlay: { css: '.old{}' }, interactive: { giveaway: { prize: 'Libro' } },
    commands: [], timers: [], program: { kind: 'obs' }, customOverlays: [] };
  const bytes = JSON.stringify(v2, null, 1), file = path.join(root, 'config.json');
  await writeFile(file, bytes);
  const expected = deepMerge(structuredClone(DEFAULT_CONFIG), v2);
  expected.theme.platformAccent = false; expected.theme.platformBadge = 'text'; // effective v2 defaults
  // The built-in welcome variation also receives its resolved v3 conditions.
  expected.alerts.welcome.variations[0].conditions = { ...DEFAULT_CONDITIONS, returning: 'true' };
  const store = await new Store(root).load();
  assert.equal(store.config.configVersion, 3);
  assert.deepEqual(store.config.themes, { activeId: 'normal', saved: [{ id: 'normal', name: 'Normal' }] });
  for (const key of sections.filter(k => k !== 'customOverlayCss')) assert.deepEqual(store.config[key], expected[key], key);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  for (const key of sections.filter(k => k !== 'customOverlayCss')) assert.deepEqual(disk[key], expected[key], `persisted ${key}`);
  assert.deepEqual(disk.customOverlayCss, {});
  const backups = (await readdir(root)).filter(n => n.startsWith('config.backup-'));
  assert.equal(backups.length, 1); assert.equal(await readFile(path.join(root, backups[0]), 'utf8'), bytes);
  const originalTheme = DEFAULT_THEME.accentSoft, originalAlert = DEFAULT_ALERTS.follow.sub;
  try {
    DEFAULT_THEME.accentSoft = '#010203'; DEFAULT_ALERTS.follow.sub = 'nuevo default';
    const reloaded = await new Store(root).load();
    assert.equal(reloaded.config.theme.accentSoft, expected.theme.accentSoft);
    assert.equal(reloaded.config.alerts.follow.sub, expected.alerts.follow.sub);
    assert.equal(themeCss(reloaded.config.theme), themeCss(expected.theme));
    assert.deepEqual(omitVolatile(buildAlert('follow', { user: 'Ana' }, reloaded.config)), omitVolatile(buildAlert('follow', { user: 'Ana' }, expected)));
    assert.equal((await readdir(root)).filter(n => n.startsWith('config.backup-')).length, 1);
  } finally { DEFAULT_THEME.accentSoft = originalTheme; DEFAULT_ALERTS.follow.sub = originalAlert; }
});

test('v2 migration freezes sparse variation conditions and preserves explicit values and matching behavior', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-theme-conditions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const variation = (id, conditions) => ({ id, name: id, enabled: true,
    ...(conditions !== undefined && { conditions }), overrides: { title: `Variación ${id}` } });
  const v2 = { configVersion: 2, alerts: {
    follow: { variations: [variation('sparse', { users: 'Ana' })] },
    sub: { variations: [variation('explicit', { users: 'Ana', chance: 33 })] },
    raid: { variations: [variation('absent')] },
    cheer: { variations: [variation('null', null)] },
  } };
  const bytes = JSON.stringify(v2), file = path.join(root, 'config.json');
  await writeFile(file, bytes);
  const before = deepMerge(structuredClone(DEFAULT_CONFIG), v2);
  const defaults = structuredClone(DEFAULT_CONDITIONS);
  const cases = [['follow', 0.5], ['sub', 0.2], ['sub', 0.8], ['raid', 0.5], ['cheer', 0.5]];
  const output = config => cases.map(([type, random]) => omitVolatile(buildAlert(type, { user: 'Ana', amount: 5 }, config, { rnd: () => random })));
  const expected = output(before);
  assert.equal(expected[0].variation.name, 'sparse');
  assert.equal(expected[1].variation.name, 'explicit');
  assert.equal(expected[2].variation, null);
  assert.equal(expected[3].variation.name, 'absent');
  assert.equal(expected[4].variation.name, 'null');
  await new Store(root).load();
  const disk = JSON.parse(await readFile(file, 'utf8'));
  try {
    DEFAULT_CONDITIONS.chance = 0;
    DEFAULT_CONDITIONS.users = 'Otra persona';
    const after = await new Store(root).load();
    assert.deepEqual(output(after.config), expected);
    for (const [type, own] of [
      ['follow', { users: 'Ana' }], ['sub', { users: 'Ana', chance: 33 }], ['raid', {}], ['cheer', {}],
    ]) {
      assert.deepEqual(disk.alerts[type].variations[0].conditions, { ...defaults, ...own }, type);
      assert.deepEqual(after.config.alerts[type].variations[0].conditions, { ...defaults, ...own }, type);
    }
    const backups = (await readdir(root)).filter(name => name.startsWith('config.backup-'));
    assert.equal(backups.length, 1); assert.equal(await readFile(path.join(root, backups[0]), 'utf8'), bytes);
  } finally { Object.assign(DEFAULT_CONDITIONS, defaults); }
});

test('v2 sparse commands and timers freeze their effective alert rendering without changing their operational defaults', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-themes-sparse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = { id: 'c', trigger: '!hola' }, timer = { id: 't', name: 'T', message: 'hola', showAlert: true };
  const v2 = { configVersion: 2, commands: [command], timers: [timer] };
  await writeFile(path.join(root, 'config.json'), JSON.stringify(v2));
  const before = deepMerge(structuredClone(DEFAULT_CONFIG), v2);
  const commandAlert = omitVolatile(buildCommandAlert(command, { user: 'Ana' }, before));
  const timerAlert = omitVolatile(buildCustomAlert(alertFields(timer), {}, before));
  const store = await new Store(root).load(), disk = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  for (const [key, value] of Object.entries(commandAlert.look)) if (key !== 'mediaKind') assert.deepEqual(disk.commands[0][key], value, `command ${key}`);
  for (const [key, value] of Object.entries(timerAlert.look)) if (key !== 'mediaKind') assert.deepEqual(disk.timers[0][key], value, `timer ${key}`);
  assert.equal(disk.timers[0].title, ''); assert.equal(disk.timers[0].durationMs, 6500);
  for (const key of ['permission', 'platforms', 'cooldownSec', 'userCooldownSec']) assert.equal(Object.hasOwn(disk.commands[0], key), false, key);
  assert.equal(Object.hasOwn(disk.timers[0], 'onlyWhenLive'), false);
  const msg = { text: '!hola', user: 'Ana', platform: 'other' };
  assert.ok(new CommandRunner().match([command], msg, 1));
  assert.ok(new CommandRunner().match(disk.commands, msg, 1));
  const previous = DEFAULT_COMMAND.mediaSize, previousCustom = DEFAULT_CUSTOM_ALERT.mediaSize;
  try {
    DEFAULT_COMMAND.mediaSize = previous + 10; DEFAULT_CUSTOM_ALERT.mediaSize = previousCustom + 20;
    const reload = await new Store(root).load();
    assert.deepEqual(omitVolatile(buildCommandAlert(reload.config.commands[0], { user: 'Ana' }, reload.config)), commandAlert);
    assert.deepEqual(omitVolatile(buildCustomAlert(alertFields(reload.config.timers[0]), {}, reload.config)), timerAlert);
  } finally { DEFAULT_COMMAND.mediaSize = previous; DEFAULT_CUSTOM_ALERT.mediaSize = previousCustom; }
  assert.deepEqual(store.config.commands[0], disk.commands[0]);
});

test('fresh Normal preserves default CSS, widget and alert behavior', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('GET', '/api/themes')).body, { themes: [normal] });
  const css = await fetch(f.base + '/theme.css');
  assert.equal(css.status, 200); assert.equal(await css.text(), themeCss(DEFAULT_CONFIG.theme));
  const state = (await f.call('GET', '/api/state')).body;
  assert.deepEqual(state.widgets.widgets, DEFAULT_CONFIG.widgets);
  assert.deepEqual(omitVolatile(buildAlert('follow', { user: 'Ana' }, f.app.store.config)), omitVolatile(buildAlert('follow', { user: 'Ana' }, DEFAULT_CONFIG)));
  assert.equal(state.config.configVersion, 3);
});

test('duplicate, switch and switch back preserve full sections, global config, live state and backup', async t => {
  const f = await fixture(t);
  const patch = { theme: { accent: '#123456' }, overlay: { css: '.old{}', queueMax: 3 },
    alerts: { follow: { title: 'Inicial', enabled: false, minAmount: 7, actions: [{ kind: 'say', text: 'hola' }] } },
    widgets: { chat: { fontSize: 31 }, ticker: { count: 7 } }, interactive: { giveaway: { prize: 'Premio A' } },
    commands: [{ id: 'c', trigger: '!hola', enabled: true }], timers: [{ id: 't', name: 'T', intervalMin: 4 }],
    program: { kind: 'meld', autoSession: false }, sessions: { retention: 4 }, dock: { layout: 'tabs' },
    prompter: { fontSize: 30 }, discord: { enabled: false }, scheduleCalendar: { enabled: false }, access: { lan: false },
    customOverlays: [{ id: 'cam', name: 'Cam', html: '<p>fijo</p>', css: '.x{}', js: '', width: 400, height: 400, transparent: true }] };
  assert.equal((await f.call('PUT', '/api/config', patch)).status, 200);
  assert.equal((await f.call('POST', '/api/questions', { text: 'Una pregunta de prueba', user: 'Ana' })).status, 200);
  const before = await f.snapshot();
  const clone = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Navidad' });
  assert.equal(clone.status, 200); assert.equal(clone.body.theme.name, 'Navidad');
  const id = clone.body.theme.id;
  assert.match(id, /^[a-z0-9-]{1,40}$/);
  const stored = await f.snapshot();
  assert.deepEqual(stored.config.themes.saved.find(x => x.id === id).look.widgets, before.config.widgets);
  assert.equal(Object.hasOwn(stored.config.themes.saved.find(x => x.id === 'normal'), 'look'), false);
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#ABCDEF' }, widgets: { ticker: { count: 9 } }, interactive: { giveaway: { prize: 'Premio B' } } })).status, 200);
  const preSwitch = await f.snapshot(), questions = (await f.call('GET', '/api/interactive')).body.questions;
  const switched = await f.call('POST', `/api/themes/${id}/activate`);
  assert.equal(switched.status, 200);
  const after = await f.snapshot();
  for (const key of sections) assert.deepEqual(after.config[key], before.config[key], key);
  for (const key of Object.keys(preSwitch.config).filter(k => !sections.includes(k) && k !== 'themes')) assert.deepEqual(after.config[key], preSwitch.config[key], key);
  assert.deepEqual((await f.call('GET', '/api/interactive')).body.questions, questions);
  const backups = after.files.filter(n => n.startsWith('config.backup-'));
  assert.equal(backups.length, 1); assert.equal(await readFile(path.join(f.dataDir, backups[0]), 'utf8'), preSwitch.bytes);
  assert.equal(after.config.themes.activeId, id);
  assert.equal(Object.hasOwn(after.config.themes.saved.find(x => x.id === id), 'look'), false);
  assert.equal(after.config.themes.saved.find(x => x.id === 'normal').look.theme.accent, '#ABCDEF');
  assert.equal((await f.call('POST', '/api/themes/normal/activate')).status, 200);
  assert.equal((await f.snapshot()).config.theme.accent, '#ABCDEF');
  const noOp = await f.snapshot();
  assert.equal((await f.call('POST', '/api/themes/normal/activate')).status, 200);
  assert.deepEqual(await f.snapshot(), noOp);
});

test('switch discards the previous appearance draft so previews follow the active theme', async t => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otra' });
  assert.equal(created.status, 200);
  assert.equal((await f.call('PUT', '/api/theme', { accent: '#112233' })).status, 200);
  assert.equal((await f.call('PUT', '/api/theme/draft', { accent: '#445566' })).status, 200);
  assert.match(await (await fetch(f.base + '/theme.css?draft=1')).text(), /--red:#445566/);
  assert.equal((await f.call('POST', `/api/themes/${created.body.theme.id}/activate`)).status, 200);
  const css = await (await fetch(f.base + '/theme.css?draft=1')).text();
  assert.match(css, new RegExp(`--red:${DEFAULT_THEME.accent}`));
  assert.doesNotMatch(css, /--red:#445566/);
});

test('live switch publishes theme, alert, widget, interactive and custom overlay changes', async t => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otra' });
  assert.equal(created.status, 200);
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#123456' }, alerts: { follow: { title: 'Cambió' } }, widgets: { ticker: { label: 'Anterior' } } })).status, 200);
  const panel = await stream(t, f.base, 'panel'), widget = await stream(t, f.base, 'widget'), overlay = await stream(t, f.base, 'overlay');
  assert.equal((await overlay('theme')).accent, '#123456');
  await widget('customOverlayVersions'); await widget('interactive'); await widget('widgets');
  assert.equal((await f.call('POST', `/api/themes/${created.body.theme.id}/activate`)).status, 200);
  assert.equal((await overlay('theme', d => d.accent === DEFAULT_THEME.accent)).accent, DEFAULT_THEME.accent);
  assert.equal((await panel('config', d => d.alerts?.follow?.title === DEFAULT_ALERTS.follow.title)).alerts.follow.title, DEFAULT_ALERTS.follow.title);
  assert.equal((await widget('widgets', d => d.widgets?.ticker?.label === DEFAULT_CONFIG.widgets.ticker.label)).widgets.ticker.label, DEFAULT_CONFIG.widgets.ticker.label);
  assert.ok(await panel('customOverlays'));
  assert.ok(await widget('customOverlayVersions'));
  assert.ok(await widget('interactive'));
});

test('API rejects bad names, duplicates, unknown ids, deleting active and the eleventh theme without writes', async t => {
  const f = await fixture(t);
  for (const [method, url, body, status, message] of [
    ['POST', '/api/themes/duplicate', { from: 'missing', name: 'Otro' }, 404, /tema/i],
    ['POST', '/api/themes/duplicate', { from: 'normal', name: '' }, 400, /nombre/i],
    ['POST', '/api/themes/duplicate', { from: 'normal', name: 'x'.repeat(41) }, 400, /nombre/i],
    ['POST', '/api/themes/duplicate', { from: 'normal', name: 'normal' }, 409, /nombre/i],
    ['PUT', '/api/themes/missing', { name: 'Otro' }, 404, /tema/i],
    ['DELETE', '/api/themes/missing', undefined, 404, /tema/i],
    ['POST', '/api/themes/missing/activate', {}, 404, /tema/i],
    ['DELETE', '/api/themes/normal', undefined, 409, /^Activa otro tema antes de borrar este$/],
  ]) {
    const before = await f.snapshot(), result = await f.call(method, url, body);
    assert.equal(result.status, status, JSON.stringify(result.body)); assert.match(result.body.error, message);
    assert.deepEqual(await f.snapshot(), before, `${method} ${url}`);
  }
  for (let i = 1; i <= 9; i++) assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: `Tema ${i}` })).status, 200);
  let before = await f.snapshot();
  assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Tema 10' })).status, 409);
  assert.deepEqual(await f.snapshot(), before);
  const list = (await f.call('GET', '/api/themes')).body.themes;
  assert.equal(list.length, 10);
  const id = list[1].id;
  before = await f.snapshot();
  assert.equal((await f.call('PUT', `/api/themes/${id}`, { name: 'normal' })).status, 409);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal((await f.call('PUT', `/api/themes/${id}`, { name: 'Renombrado' })).status, 200);
  assert.equal((await f.call('DELETE', `/api/themes/${id}`)).status, 200);
  assert.equal((await f.call('GET', '/api/themes')).body.themes.length, 9);
});

test('from-default creates the platform preset, while duplication validates source looks', async t => {
  const f = await fixture(t);
  const made = await f.call('POST', '/api/themes/from-default', { name: 'Plataformas' });
  assert.equal(made.status, 200);
  const stored = await f.snapshot(), look = stored.config.themes.saved.find(x => x.id === made.body.theme.id).look;
  assert.equal(look.theme.platformAccent, true); assert.equal(look.theme.platformBadge, 'logo');
  assert.deepEqual(look.widgets, DEFAULT_CONFIG.widgets);
  // /api/widgets retains its legacy partial validation; copying must revalidate the whole look.
  assert.equal((await f.call('PUT', '/api/widgets', { ticker: { speed: -1 } })).status, 200);
  const before = await f.snapshot();
  const invalid = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Malo' });
  assert.equal(invalid.status, 400); assert.match(invalid.body.error, /widgets\.ticker\.speed/);
  assert.deepEqual(await f.snapshot(), before);
});

test('public projections never expose inactive looks; generic writes cannot alter themes', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' })).status, 200);
  for (const url of ['/api/config', '/api/state', '/api/config?path=themes']) {
    const result = await f.call('GET', url); assert.equal(result.status, 200);
    assert.doesNotMatch(JSON.stringify(result.body), /"look"/);
  }
  for (const [method, url, body] of [
    ['PUT', '/api/config', { themes: { activeId: 'otro' }, overlay: { volume: 0.9 } }],
    ['POST', '/api/config/set', { path: 'themes.activeId', value: 'otro' }],
    ['POST', '/api/config/set', { path: 'themes', value: {} }],
    ['POST', '/api/config/set', { path: 'themes.saved.0' }],
  ]) {
    const before = await f.snapshot(), result = await f.call(method, url, body);
    assert.equal(result.status, 400); assert.match(result.body.error, /themes/);
    assert.deepEqual(await f.snapshot(), before);
  }
  assert.equal((await f.call('PUT', '/api/config', { overlay: { volume: 0.8 } })).body.config.overlay.volume, 0.8);
  assert.equal((await f.call('POST', '/api/config/set', { path: 'tts.rate', value: 1.25 })).body.value, 1.25);
});

test('avatar: create from default with color and expose it in public projections', async t => {
  const f = await fixture(t);
  const made = await f.call('POST', '/api/themes/from-default', { name: 'Azul', avatar: { color: '#123ABC' } });
  assert.deepEqual(made, { status: 200, body: { theme: { id: 'azul', name: 'Azul', active: false, avatar: { color: '#123ABC' } } } });
  for (const url of ['/api/themes', '/api/state', '/api/config']) {
    const data = (await f.call('GET', url)).body;
    const saved = url === '/api/themes' ? data.themes : url === '/api/state' ? data.config.themes.saved : data.themes.saved;
    assert.deepEqual(saved.find(x => x.id === 'azul').avatar, { color: '#123ABC' }, url);
  }
  const item = (await f.snapshot()).config.themes.saved.find(x => x.id === 'azul');
  assert.deepEqual(item.avatar, { color: '#123ABC' }); assert.equal(item.look.avatar, undefined);
});

test('avatar: uploaded image and color can be edited and removed without deleting media', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = await fetch(f.base + '/api/media/upload?name=avatar.png', { method: 'POST', body: png });
  assert.equal(upload.status, 200); const { name } = await upload.json();
  const edit = await f.call('PUT', '/api/themes/normal', { avatar: { image: name, color: '#123456' } });
  assert.deepEqual(edit, { status: 200, body: { theme: { ...normal, avatar: { image: name, color: '#123456' } } } });
  assert.deepEqual((await f.call('PUT', '/api/themes/normal', { avatar: { image: '' } })).body.theme.avatar, { color: '#123456' });
  assert.deepEqual((await f.call('PUT', '/api/themes/normal', { avatar: { image: name } })).body.theme.avatar, { image: name, color: '#123456' });
  assert.deepEqual((await f.call('PUT', '/api/themes/normal', { name: 'Normal nuevo' })).body.theme.avatar, { image: name, color: '#123456' });
  assert.equal(Object.hasOwn((await f.call('PUT', '/api/themes/normal', { avatar: null })).body.theme, 'avatar'), false);
  assert.equal((await fetch(f.base + '/media/' + encodeURIComponent(name))).status, 200);
  const made = await f.call('POST', '/api/themes/from-default', { name: 'Foto', avatar: { image: name, color: '#ABCDEF' } });
  assert.equal(made.status, 200);
  for (const id of ['foto', 'normal']) {
    assert.equal((await f.call('POST', `/api/themes/${id}/activate`)).status, 200);
    assert.deepEqual((await f.call('GET', '/api/themes')).body.themes.find(x => x.id === 'foto').avatar, { image: name, color: '#ABCDEF' });
  }
  assert.equal((await f.call('DELETE', '/api/themes/foto')).status, 200);
  assert.equal((await fetch(f.base + '/media/' + encodeURIComponent(name))).status, 200);
});

test('avatar: invalid input is rejected without config, backup or counter changes', async t => {
  const f = await fixture(t);
  const svg = await fetch(f.base + '/api/media/upload?name=x.svg', { method: 'POST', body: '<svg xmlns="http://www.w3.org/2000/svg" />' });
  assert.equal(svg.status, 200);
  for (const [avatar, error] of [
    [{ color: '#abc' }, 'El color del avatar debe ser #RRGGBB'],
    [{ image: 'x.svg' }, 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
    [{ image: 'x.apng' }, 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
    [{ image: 'x.avif' }, 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
    [{ image: '../x.png' }, 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
    [{ image: 'dir\\\\x.png' }, 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
    [{ image: 'missing.png' }, 'No existe la imagen «missing.png» en la carpeta de media'],
    [{ other: 'x' }, 'El avatar solo admite imagen y color'],
    [[], 'El avatar debe ser un objeto'],
  ]) {
    const before = await f.snapshot();
    assert.deepEqual(await f.call('PUT', '/api/themes/normal', { avatar }), { status: 400, body: { error } });
    assert.deepEqual(await f.snapshot(), before, JSON.stringify(avatar));
  }
  for (const body of [{}, { name: '' }, { name: '', avatar: { color: '#123456' } }]) {
    const before = await f.snapshot();
    assert.deepEqual(await f.call('PUT', '/api/themes/normal', body), { status: 400, body: { error: 'El nombre del tema es obligatorio y admite hasta 40 caracteres' } });
    assert.deepEqual(await f.snapshot(), before);
  }
  const before = await f.snapshot();
  assert.deepEqual(await f.call('POST', '/api/themes/from-default', { name: 'Malo', avatar: { image: 'x.svg' } }),
    { status: 400, body: { error: 'El avatar admite imágenes PNG, JPG, WebP o GIF' } });
  assert.deepEqual(await f.snapshot(), before);
});

test('avatar: duplication starts a new identity and activation preserves both avatars', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('PUT', '/api/themes/normal', { avatar: { color: '#112233' } })).status, 200);
  const clone = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Copia' });
  assert.equal(clone.status, 200); assert.equal(Object.hasOwn(clone.body.theme, 'avatar'), false);
  const other = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Azul', avatar: { color: '#AABBCC' } });
  assert.equal(other.status, 200); assert.deepEqual(other.body.theme.avatar, { color: '#AABBCC' });
  for (const id of ['azul', 'normal']) {
    assert.equal((await f.call('POST', `/api/themes/${id}/activate`)).status, 200);
    const list = (await f.call('GET', '/api/themes')).body.themes;
    assert.deepEqual(list.find(x => x.id === 'normal').avatar, { color: '#112233' });
    assert.deepEqual(list.find(x => x.id === 'azul').avatar, { color: '#AABBCC' });
  }
  assert.equal((await f.call('DELETE', '/api/themes/azul')).status, 200);
});

test('saved theme schema validates avatar shape, colors and raster basenames', async () => {
  const { validatePatch } = await import('../src/config-schema.mjs');
  const check = avatar => validatePatch({ themes: { activeId: 'normal', saved: [{ id: 'normal', name: 'Normal', avatar }] } });
  assert.deepEqual(check({ image: 'foto.JPG', color: '#12AbEF' }), []);
  for (const avatar of [null, [], 'image', { image: '' }, { image: '../x.png' }, { image: 'a\\\\b.png' }, { image: 'x.svg' }, { image: 'x.apng' }, { image: 'x.avif' }, { color: '#abc' }, { color: null }, { extra: true }]) {
    assert.ok(check(avatar).length, JSON.stringify(avatar));
  }
});

test('missing goal and chat variant APIs warn with 404 without changing config or counters', async t => {
  const f = await fixture(t), before = await f.snapshot();
  for (const [method, url, body, error] of [
    ['POST', '/api/goals/missing/add', { amount: 4 }, 'No existe el objetivo «missing»'],
    ['POST', '/api/goals/missing/set', { value: 10 }, 'No existe el objetivo «missing»'],
    ['PUT', '/api/widgets/chat/variants/missing', { css: '.x{}' }, 'No existe la variante «missing»'],
    ['DELETE', '/api/widgets/chat/variants/missing', undefined, 'No existe la variante «missing»'],
  ]) {
    assert.deepEqual(await f.call(method, url, body), { status: 404, body: { error } });
    assert.deepEqual(await f.snapshot(), before);
  }
});

test('avatar: a symlink in media pointing outside mediaDir is refused with nothing written', async t => {
  const f = await fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const mediaDir = path.join(path.dirname(f.dataDir), 'media');
  await mkdir(mediaDir, { recursive: true });
  const outside = path.join(path.dirname(f.dataDir), 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, path.join(mediaDir, 'link.png'));
  for (const [method, url, body] of [
    ['PUT', '/api/themes/normal', { avatar: { image: 'link.png' } }],
    ['POST', '/api/themes/from-default', { name: 'Enlace', avatar: { image: 'link.png' } }],
    ['POST', '/api/themes/duplicate', { from: 'normal', name: 'Enlace', avatar: { image: 'link.png' } }],
  ]) {
    const before = await f.snapshot();
    const res = await f.call(method, url, body);
    assert.equal(res.status, 400, url);
    assert.deepEqual(res.body, { error: 'No existe la imagen «link.png» en la carpeta de media' }, url);
    assert.deepEqual(await f.snapshot(), before, url);
  }
});
