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
import { openZip } from '../src/zip-archive.mjs';
import { crc32 } from 'node:zlib';
import http from 'node:http';

const normal = { id: 'normal', name: 'Normal', active: true };
const sections = ['theme', 'alerts', 'overlay', 'widgets', 'interactive', 'commands', 'timers', 'customOverlayCss'];
const omitVolatile = ({ id, at, ...alert }) => alert;

async function fixture(t, config, options = {}) {
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
  app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), push: {}, log: () => {}, ...options });
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

async function stream(t, base, client, options = '') {
  const ctrl = new AbortController(), timeout = setTimeout(() => ctrl.abort(), 5000);
  t.after(() => { clearTimeout(timeout); ctrl.abort(); });
  const response = await fetch(`${base}/api/stream?client=${client}${options}`, { signal: ctrl.signal });
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

test('theme CSS duplicates and swaps independently of approved overlay code and survives config transfer', async t => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/custom-overlays', { name: 'Marco', html: '<div>fijo</div>', css: '.base{}', js: 'void 0', requestedPermissions: ['say'] });
  const id = created.body.overlay.id;
  const approved = await fetch(`${f.base}/api/custom-overlays/${id}/permissions`, { method: 'PUT', headers: { 'content-type': 'application/json', Origin: f.base, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ permissions: ['say'] }) });
  assert.equal(approved.status, 200);
  const original = (await f.call('GET', `/api/custom-overlays/${id}`)).body.overlay;
  assert.deepEqual(original.permissions, ['say']);
  assert.equal((await f.call('GET', '/api/config')).body.customOverlayCss[id] ?? '', '');
  assert.equal((await f.call('POST', '/api/config/set', { path: `customOverlayCss.${id}`, value: '.a{color:red}' })).status, 200);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' });
  assert.equal(made.status, 200);
  assert.equal((await f.call('POST', '/api/config/set', { path: `customOverlayCss.${id}`, value: '.a{color:blue}' })).status, 200);
  assert.equal((await f.call('POST', '/api/themes/invierno/activate')).status, 200);
  assert.equal((await f.call('GET', '/api/config')).body.customOverlayCss[id], '.a{color:red}');
  assert.deepEqual((await f.call('GET', `/api/custom-overlays/${id}`)).body.overlay, original);
  const inactiveCopy = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Copia' });
  assert.equal(inactiveCopy.status, 200);
  assert.equal((await f.call('POST', '/api/themes/copia/activate')).status, 200);
  assert.equal((await f.call('GET', '/api/config')).body.customOverlayCss[id], '.a{color:blue}');
  assert.deepEqual((await f.call('GET', `/api/custom-overlays/${id}`)).body.overlay, original);
  const exported = (await f.call('GET', '/api/config/export?format=json')).body;
  const preview = await f.call('POST', '/api/config/import/preview', exported);
  assert.equal(preview.status, 200);
  const imported = await fetch(f.base + '/api/config/import', { method: 'POST', headers: { 'content-type': 'application/json', 'x-config-fingerprint': preview.body.fingerprint }, body: JSON.stringify(exported) });
  assert.equal(imported.status, 200);
  assert.equal((await f.call('GET', '/api/config')).body.customOverlayCss[id], '.a{color:blue}');
  assert.deepEqual((await f.call('GET', `/api/custom-overlays/${id}`)).body.overlay, original);
});

test('theme CSS rejects invalid ids, non-text and oversized CSS without writes', async t => {
  const f = await fixture(t);
  const overlay = (await f.call('POST', '/api/custom-overlays', { name: 'Marco' })).body.overlay;
  const path = `customOverlayCss.${overlay.id}`;
  for (const [method, url, body, error] of [
    ['POST', '/api/config/set', { path, value: 42 }, `${path}: se esperaba un id de overlay y CSS de texto`],
    ['PUT', '/api/config', { customOverlayCss: { [overlay.id]: null } }, `${path}: se esperaba un id de overlay y CSS de texto`],
    ['POST', '/api/config/set', { path: 'customOverlayCss.A/B', value: 'x' }, 'customOverlayCss.A/B: se esperaba un id de overlay y CSS de texto'],
    ['POST', '/api/config/set', { path, value: 'x'.repeat(512_000) }, `${path}: el CSS es demasiado grande (máx. 512 KB)`],
    ['PUT', '/api/config', { customOverlayCss: { [overlay.id]: 'x'.repeat(512_000) } }, `${path}: el CSS es demasiado grande (máx. 512 KB)`],
  ]) {
    const before = await f.snapshot();
    assert.deepEqual(await f.call(method, url, body), { status: 400, body: { error } });
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual((await f.call('GET', `/api/custom-overlays/${overlay.id}`)).body.overlay, overlay);
  }
  const max = 'x'.repeat(511_998);
  assert.equal((await f.call('POST', '/api/config/set', { path, value: max })).status, 200);
  assert.equal((await f.call('GET', '/api/config')).body.customOverlayCss[overlay.id], max);
  assert.deepEqual((await f.call('GET', `/api/custom-overlays/${overlay.id}`)).body.overlay, overlay);
});

test('extended stream snapshots follow all legacy frames in their original order', async t => {
  const f = await fixture(t);
  for (const [query, names] of [
    ['client=overlay&themeInfo=1', ['pause', 'theme', 'activeTheme']],
    ['client=preview&themeInfo=1', ['theme', 'activeTheme']],
    ['client=teleprompter&themeInfo=1', ['teleprompter', 'theme', 'activeTheme']],
    ['client=widget&themeInfo=1', ['widgets', 'interactive', 'interview', 'viewers', 'customOverlayVersions', 'customOverlaySettings', 'theme', 'activeTheme']],
    ['client=widget&themeInfo=1&customTheme=1', ['widgets', 'interactive', 'interview', 'viewers', 'customOverlayVersions', 'customOverlaySettings', 'theme', 'activeTheme', 'customOverlayTheme']],
  ]) {
    const ctrl = new AbortController(); t.after(() => ctrl.abort());
    const res = await fetch(`${f.base}/api/stream?${query}`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffered = '', frames = [];
    while (frames.length < names.length) {
      const next = await reader.read(); assert.equal(next.done, false);
      buffered += decoder.decode(next.value);
      let end;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const raw = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        const match = /^event: ([^\n]+)\ndata: (.+)$/s.exec(raw);
        if (match) frames.push({ name: match[1], data: JSON.parse(match[2]) });
      }
    }
    assert.deepEqual(frames.map(x => x.name), names, query);
    assert.equal(Object.hasOwn(frames.find(x => x.name === 'theme').data, 'id'), false);
    assert.deepEqual(frames.find(x => x.name === 'activeTheme').data, { id: 'normal', name: 'Normal' });
    ctrl.abort();
  }
});

test('custom overlay theme stream publishes matching identity, look and overlay CSS in one snapshot', async t => {
  const f = await fixture(t);
  const overlay = (await f.call('POST', '/api/custom-overlays', { name: 'Marco' })).body.overlay;
  const id = overlay.id;
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#112233' }, customOverlayCss: { [id]: '.normal{}' } })).status, 200);
  assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).status, 200);
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#445566' }, customOverlayCss: { [id]: '.active{}' } })).status, 200);
  const widget = await stream(t, f.base, 'widget', '&themeInfo=1&customTheme=1');
  const first = await widget('customOverlayTheme');
  assert.deepEqual(first.activeTheme, { id: 'normal', name: 'Normal' });
  assert.equal(first.theme.accent, '#445566');
  assert.match(first.lookCss, /--red:#445566/);
  assert.equal(first.customOverlayCss[id], '.active{}');
  assert.equal((await f.call('POST', '/api/themes/invierno/activate')).status, 200);
  const next = await widget('customOverlayTheme', x => x.activeTheme.id === 'invierno');
  assert.deepEqual(next.activeTheme, { id: 'invierno', name: 'Invierno' });
  assert.equal(next.theme.accent, '#112233');
  assert.match(next.lookCss, /--red:#112233/);
  assert.equal(next.customOverlayCss[id], '.normal{}');
  assert.equal((await f.call('PUT', '/api/themes/invierno', { name: 'Navidad' })).status, 200);
  const renamed = await widget('customOverlayTheme', x => x.activeTheme.name === 'Navidad');
  assert.equal(renamed.theme.accent, '#112233');
  assert.equal(renamed.customOverlayCss[id], '.normal{}');
  assert.equal(renamed.theme.version, next.theme.version);
});

test('activeTheme is a separate live identity; renaming does not change theme or alert preview versions', async t => {
  const f = await fixture(t);
  const overlay = await stream(t, f.base, 'overlay', '&themeInfo=1');
  const widget = await stream(t, f.base, 'widget', '&themeInfo=1');
  const before = (await f.call('GET', '/api/state')).body;
  assert.equal(Object.hasOwn(before, 'activeTheme'), false);
  assert.deepEqual((({ id, name }) => ({ id, name }))((await f.call('GET', '/api/themes')).body.themes.find(x => x.active)), { id: 'normal', name: 'Normal' });
  assert.equal(Object.hasOwn(before.theme, 'id'), false);
  assert.equal(Object.hasOwn(before.theme, 'name'), false);
  assert.deepEqual(await overlay('activeTheme'), { id: 'normal', name: 'Normal' });
  assert.deepEqual(await widget('activeTheme'), { id: 'normal', name: 'Normal' });
  assert.equal((await f.call('PUT', '/api/themes/normal', { name: 'Renombrado' })).status, 200);
  assert.deepEqual(await overlay('activeTheme', x => x.name === 'Renombrado'), { id: 'normal', name: 'Renombrado' });
  assert.deepEqual(await widget('activeTheme', x => x.name === 'Renombrado'), { id: 'normal', name: 'Renombrado' });
  const after = (await f.call('GET', '/api/state')).body;
  assert.deepEqual((({ id, name }) => ({ id, name }))((await f.call('GET', '/api/themes')).body.themes.find(x => x.active)), { id: 'normal', name: 'Renombrado' });
  assert.deepEqual(after.theme, before.theme);
  assert.deepEqual(after.alertPreviews, before.alertPreviews);
  const other = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' });
  assert.equal(other.status, 200);
  assert.equal((await f.call('POST', '/api/themes/invierno/activate')).status, 200);
  assert.deepEqual(await overlay('activeTheme', x => x.id === 'invierno'), { id: 'invierno', name: 'Invierno' });
  assert.deepEqual(await widget('activeTheme', x => x.id === 'invierno'), { id: 'invierno', name: 'Invierno' });
});

// Independent ZIP fixtures keep malicious archives out of the production ZIP writer.
function themeZip(entries) {
  let offset = 0; const locals = [], central = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data), size = entry.size ?? data.length;
    const crc = crc32(data), local = Buffer.alloc(30), cd = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(size, 24); cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); cd.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(cd, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const zipManifest = (config, extra = {}) => ({ format: 'antena-theme', kind: 'theme', version: 1, app: 'test',
  theme: { name: 'Normal', look: Object.fromEntries(sections.map(key => [key, config[key]])), ...extra } });
const makeThemeZip = (manifest, entries = []) => themeZip([{ name: 'config.json', data: JSON.stringify(manifest) }, ...entries]);
async function transferTheme(f, suffix, bytes, fingerprint, name) {
  const query = name === undefined ? '' : `?name=${encodeURIComponent(name)}`;
  const r = await fetch(`${f.base}/api/themes/import${suffix}${query}`, { method: 'POST', headers: {
    'content-type': 'application/zip', ...(fingerprint ? { 'x-config-fingerprint': fingerprint } : {}),
  }, body: bytes, signal: AbortSignal.timeout(15000) });
  return { status: r.status, body: await r.json() };
}
async function themeTransferSnapshot(f) {
  const mediaDir = path.join(path.dirname(f.dataDir), 'media');
  return { ...(await f.snapshot()), media: await Promise.all((await readdir(mediaDir)).sort().map(async name => [name, (await readFile(path.join(mediaDir, name))).toString('base64')])) };
}
async function inspectThemeZip(f, bytes) {
  const file = path.join(path.dirname(f.dataDir), 'theme-inspect.zip');
  await writeFile(file, bytes); const zip = await openZip(file, { allowCss: true });
  try { return { manifest: JSON.parse((await zip.readConfig()).toString('utf8')), names: zip.entries.map(e => e.name) }; }
  finally { await zip.close(); }
}
async function downloadTheme(f, id) {
  const r = await fetch(`${f.base}/api/themes/${id}/export`);
  return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
}

test('theme ZIP export includes only referenced media and live or stored theme sections, never system config', async t => {
  const f = await fixture(t), mediaDir = path.join(path.dirname(f.dataDir), 'media');
  const files = ['alerta.png', 'variacion.png', 'sonido.wav', 'variante.wav', 'tema.ogg', 'tipo.woff2', 'icono.png', 'widget.png', 'comando.png', 'timer.png', 'avatar.png', 'sobrante.png'];
  for (const name of files) await writeFile(path.join(mediaDir, name), `bytes-${name}`);
  assert.equal((await f.call('PUT', '/api/config', {
    youtube: { apiKey: 'PRIVATE-THEME-CANARY' },
    theme: { fontDisplay: 'media:tipo.woff2', sound: 'tema.ogg', icons: { follow: 'media:icono.png' } },
    alerts: { follow: { title: 'Guardado', media: 'alerta.png', sound: 'sonido.wav', variations: [{ id: 'v', name: 'V', enabled: true, overrides: { media: 'variacion.png', sound: 'variante.wav' } }] } },
    widgets: { chat: { css: '.msg{background:url("/media/widget.png")}' } },
    commands: [{ id: 'c', trigger: '!hola', media: 'comando.png' }], timers: [{ id: 't', name: 'T', message: 'hola', media: 'timer.png' }],
    customOverlayCss: { camera: '.cam{color:red}' },
  })).status, 200);
  assert.equal((await f.call('PUT', '/api/themes/normal', { avatar: { image: 'avatar.png', color: '#112233' } })).status, 200);
  assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Copia' })).status, 200);
  assert.equal((await f.call('PUT', '/api/config', { alerts: { follow: { title: 'En vivo' } } })).status, 200);
  for (const [id, title, avatar] of [['normal', 'En vivo', true], ['copia', 'Guardado', false]]) {
    const result = await downloadTheme(f, id); assert.equal(result.status, 200); assert.equal(result.type, 'application/zip');
    const { manifest, names } = await inspectThemeZip(f, result.bytes);
    assert.equal(manifest.format, 'antena-theme'); assert.equal(manifest.kind, 'theme'); assert.equal(manifest.version, 1); assert.equal(typeof manifest.app, 'string');
    assert.equal(manifest.theme.look.alerts.follow.title, title);
    assert.deepEqual(Object.keys(manifest.theme.look).sort(), [...sections].sort());
    assert.deepEqual(manifest.theme.look.customOverlayCss, { camera: '.cam{color:red}' });
    assert.equal(JSON.stringify(manifest).includes('PRIVATE-THEME-CANARY'), false);
    assert.equal(Object.hasOwn(manifest.theme, 'avatar'), avatar);
    assert.deepEqual(names.slice().sort(), ['config.json', ...files.filter(name => name !== 'sobrante.png' && (avatar || name !== 'avatar.png')).map(name => `media/${name}`)].sort());
  }
});

test('theme ZIP preview and import create an inactive copy, rewrite collisions and leave existing media untouched', async t => {
  const source = await fixture(t), target = await fixture(t);
  const sourceMedia = path.join(path.dirname(source.dataDir), 'media'), targetMedia = path.join(path.dirname(target.dataDir), 'media');
  for (const name of ['alerta.png', 'widget.png', 'avatar.png']) await writeFile(path.join(sourceMedia, name), `new-${name}`);
  for (const name of ['alerta.png', 'widget.png', 'avatar.png']) await writeFile(path.join(targetMedia, name), `old-${name}`);
  assert.equal((await source.call('PUT', '/api/config', { alerts: { follow: { media: 'alerta.png' } }, widgets: { chat: { css: '.msg{background:url(/media/widget.png)}' } } })).status, 200);
  assert.equal((await source.call('PUT', '/api/themes/normal', { avatar: { image: 'avatar.png' } })).status, 200);
  const exported = await downloadTheme(source, 'normal'); assert.equal(exported.status, 200);
  const before = await themeTransferSnapshot(target), preview = await transferTheme(target, '/preview', exported.bytes);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.name, 'Normal'); assert.equal(preview.body.suggestedName, 'Normal (2)');
  assert.equal(preview.body.media.count, 3); assert.equal(preview.body.media.size, Buffer.byteLength('new-alerta.pngnew-widget.pngnew-avatar.png'));
  assert.equal(preview.body.media.conflicts.length, 3); assert.deepEqual(preview.body.warnings, []); assert.match(preview.body.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(await themeTransferSnapshot(target), before);
  const result = await transferTheme(target, '', exported.bytes, preview.body.fingerprint);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.theme.name, 'Normal (2)'); assert.equal(result.body.theme.active, false);
  const after = await target.snapshot(), saved = after.config.themes.saved.find(item => item.id === result.body.theme.id);
  assert.equal(after.config.themes.activeId, 'normal'); assert.equal(saved.look.alerts.follow.media, 'alerta-1.png');
  assert.equal(saved.look.widgets.chat.css, '.msg{background:url(/media/widget-1.png)}'); assert.deepEqual(saved.avatar, { image: 'avatar-1.png' });
  for (const name of ['alerta.png', 'widget.png', 'avatar.png']) {
    assert.equal(await readFile(path.join(targetMedia, name), 'utf8'), `old-${name}`);
    assert.equal(await readFile(path.join(targetMedia, name.replace('.png', '-1.png')), 'utf8'), `new-${name}`);
  }
  const expected = (await source.snapshot()).config;
  for (const key of sections.filter(k => !['alerts', 'widgets'].includes(k))) assert.deepEqual(saved.look[key], expected[key], key);
  const secondPreview = await transferTheme(target, '/preview', exported.bytes); assert.equal(secondPreview.status, 200);
  const chosen = await transferTheme(target, '', exported.bytes, secondPreview.body.fingerprint, 'Elegido');
  assert.equal(chosen.status, 200); assert.equal(chosen.body.theme.name, 'Elegido'); assert.equal(chosen.body.theme.active, false);
});

test('theme ZIP rejects traversal, symlink, oversized entry, bad manifest and SVG avatar without changing data or counters', async t => {
  const f = await fixture(t), config = (await f.snapshot()).config, manifest = zipManifest(config), before = await themeTransferSnapshot(f);
  const cases = [
    [makeThemeZip(manifest, [{ name: 'media/../escape.png', data: 'x' }]), 'Nombre de archivo no permitido en el ZIP.'],
    [makeThemeZip(manifest, [{ name: 'media/link.png', data: 'target', mode: 0o120777 }]), 'El ZIP contiene enlaces o tipos de archivo no admitidos.'],
    [makeThemeZip(manifest, [{ name: 'media/large.png', data: '', size: 301 * 1024 * 1024 }]), 'El archivo de medios supera 300 MB.'],
    [makeThemeZip({ ...manifest, kind: 'config' }), 'Formato de tema no válido'],
    [makeThemeZip(zipManifest(config, { avatar: { image: 'bad.svg' } }), [{ name: 'media/bad.svg', data: '<svg />' }]), 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
  ];
  for (const [bytes, error] of cases) for (const suffix of ['/preview', '']) {
    assert.deepEqual(await transferTheme(f, suffix, bytes), { status: 400, body: { error } }, error);
    assert.deepEqual(await themeTransferSnapshot(f), before, error);
  }
});

test('theme import reports dropped custom overlay CSS and enforces the ten-theme limit', async t => {
  const f = await fixture(t), config = (await f.snapshot()).config;
  const look = { ...zipManifest(config).theme.look, customOverlayCss: { camera: '.cam{color:red}' } };
  const bytes = makeThemeZip(zipManifest(config, { name: 'Invierno', look }));
  const before = await themeTransferSnapshot(f), preview = await transferTheme(f, '/preview', bytes);
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.ok(preview.body.warnings.some(w => w.includes('camera')));
  assert.deepEqual(await themeTransferSnapshot(f), before);
  const imported = await transferTheme(f, '', bytes, preview.body.fingerprint); assert.equal(imported.status, 200);
  assert.deepEqual((await f.snapshot()).config.themes.saved.find(item => item.id === imported.body.theme.id).look.customOverlayCss, {});
  for (let i = 0; i < 8; i++) assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: `Extra ${i}` })).status, 200);
  const full = await themeTransferSnapshot(f);
  assert.deepEqual(await transferTheme(f, '/preview', bytes), { status: 409, body: { error: 'Como máximo se pueden guardar 10 temas' } });
  assert.deepEqual(await themeTransferSnapshot(f), full);
});

test('theme import drops media used only by absent overlay CSS but still validates the archive', async t => {
  const source = await fixture(t), target = await fixture(t);
  const sourceMedia = path.join(path.dirname(source.dataDir), 'media'), targetMedia = path.join(path.dirname(target.dataDir), 'media');
  await writeFile(path.join(sourceMedia, 'marco.png'), 'marco');
  assert.equal((await source.call('PUT', '/api/config', { customOverlayCss: { camera: '.cam{background:url(/media/marco.png)}' } })).status, 200);
  const zip = await downloadTheme(source, 'normal'); assert.equal(zip.status, 200);
  const before = await themeTransferSnapshot(target), preview = await transferTheme(target, '/preview', zip.bytes);
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.ok(preview.body.warnings.some(w => w.includes('camera')));
  assert.deepEqual(await themeTransferSnapshot(target), before);
  const imported = await transferTheme(target, '', zip.bytes, preview.body.fingerprint); assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual(await readdir(targetMedia), []);
  assert.deepEqual((await target.snapshot()).config.themes.saved.find(item => item.id === imported.body.theme.id).look.customOverlayCss, {});
});

test('theme import rejects invalid look, stale fingerprint and storage failure without leaving media', async t => {
  const source = await fixture(t), target = await fixture(t);
  const sourceMedia = path.join(path.dirname(source.dataDir), 'media');
  await writeFile(path.join(sourceMedia, 'alerta.png'), 'alerta');
  assert.equal((await source.call('PUT', '/api/config', { alerts: { follow: { media: 'alerta.png' } } })).status, 200);
  const exported = await downloadTheme(source, 'normal'); assert.equal(exported.status, 200);
  const config = (await target.snapshot()).config, invalid = zipManifest(config);
  invalid.theme.look.theme.accent = 'not-a-color';
  const before = await themeTransferSnapshot(target), rejected = await transferTheme(target, '/preview', makeThemeZip(invalid));
  assert.equal(rejected.status, 400); assert.match(rejected.body.error, /accent/); assert.deepEqual(await themeTransferSnapshot(target), before);
  const p = await transferTheme(target, '/preview', exported.bytes); assert.equal(p.status, 200);
  assert.equal((await target.call('PUT', '/api/config', { overlay: { volume: 0.4 } })).status, 200);
  const changed = await themeTransferSnapshot(target);
  assert.deepEqual(await transferTheme(target, '', exported.bytes, p.body.fingerprint), { status: 409, body: { error: 'La configuración ha cambiado; vuelve a previsualizar' } });
  assert.deepEqual(await themeTransferSnapshot(target), changed);
  const fresh = await transferTheme(target, '/preview', exported.bytes); assert.equal(fresh.status, 200);
  const original = target.app.store.write;
  target.app.store.write = async () => { throw Object.assign(new Error('fallo de prueba'), { code: 'PERSISTENCE_FAILED' }); };
  let failed;
  try { failed = await transferTheme(target, '', exported.bytes, fresh.body.fingerprint); } finally { target.app.store.write = original; }
  assert.deepEqual(failed, { status: 500, body: { error: 'No se pudo guardar la configuración; no se aplicaron los cambios' } });
  assert.deepEqual(await themeTransferSnapshot(target), changed);
});

// Each stylesheet is resolved against the URL of its actual rendering surface.
const cssPatch = (where, css) => {
  if (where === 'theme') return { theme: { css } };
  if (where === 'overlay') return { overlay: { css } };
  if (where === 'alert') return { alerts: { follow: { css } } };
  if (where === 'variation') return { alerts: { follow: { variations: [{ id: 'v', name: 'Variante', enabled: true, overrides: { css } }] } } };
  if (where === 'command') return { commands: [{ id: 'c', trigger: '!css', css }] };
  if (where === 'timer') return { timers: [{ id: 't', name: 'Timer', message: 'hola', css }] };
  if (where === 'chat') return { widgets: { chat: { css } } };
  if (where === 'goal') return { widgets: { goals: [{ id: 'g', title: 'Meta', css, bars: [] }] } };
  if (where === 'interactive') return { interactive: { giveaway: { css } } };
  return { customOverlayCss: { camera: css } };
};
const cssAt = (look, where) => {
  if (where === 'theme') return look.theme.css;
  if (where === 'overlay') return look.overlay.css;
  if (where === 'alert') return look.alerts.follow.css;
  if (where === 'variation') return look.alerts.follow.variations[0].overrides.css;
  if (where === 'command') return look.commands[0].css;
  if (where === 'timer') return look.timers[0].css;
  if (where === 'chat') return look.widgets.chat.css;
  if (where === 'goal') return look.widgets.goals[0].css;
  if (where === 'interactive') return look.interactive.giveaway.css;
  return look.customOverlayCss.camera;
};
const cssCases = [
  ['root unquoted overlay', 'overlay', 'root.png', '.x{background:url(/media/root.png)}', '.x{background:url(/media/root-1.png)}'],
  ['root single quoted alert', 'alert', 'quoted.png', ".x{background:url('/media/quoted.png')}", ".x{background:url('/media/quoted-1.png')}"],
  ['relative parent widget', 'chat', 'widget.png', '.x{background:url("../media/widget.png")}', '.x{background:url("../media/widget-1.png")}'],
  ['relative media on overlay', 'overlay', 'relative.png', '.x{background:url(media/relative.png)}', '.x{background:url(media/relative-1.png)}'],
  ['relative dot media on alert variation', 'variation', 'variation.png', '.x{background:url(./media/variation.png)}', '.x{background:url(./media/variation-1.png)}'],
  ['relative parent on goal', 'goal', 'goal.png', '.x{background:url(../media/goal.png)}', '.x{background:url(../media/goal-1.png)}'],
  ['relative parent on interactive', 'interactive', 'interactive.png', '.x{background:url(../media/interactive.png)}', '.x{background:url(../media/interactive-1.png)}'],
  ['relative frame', 'custom', 'frame.png', '.x{background:url(../../media/frame.png)}', '.x{background:url(../../media/frame-1.png)}'],
  ['root command', 'command', 'command.png', '.x{background:url(/media/command.png)}', '.x{background:url(/media/command-1.png)}'],
  ['root timer', 'timer', 'timer.png', '.x{background:url(/media/timer.png)}', '.x{background:url(/media/timer-1.png)}'],
  ['root theme CSS', 'theme', 'theme.png', '.x{background:url(/media/theme.png)}', '.x{background:url(/media/theme-1.png)}'],
  ['percent encoded name', 'chat', 'x y.png', '.x{background:url("../media/x%20y.png?rev=2#part")}', '.x{background:url("../media/x%20y-1.png?rev=2#part")}'],
  ['CSS escaped name', 'alert', 'x y.png', String.raw`.x{background:url(/media/x\ y.png)}`, String.raw`.x{background:url(/media/x\ y-1.png)}`],
  ['hex CSS escape', 'overlay', 'a b.png', String.raw`.x{background:url('/media/a\20 b.png')}`, String.raw`.x{background:url('/media/a\20 b-1.png')}`],
  ['import quoted string', 'chat', 'sheet.woff2', '@import "../media/sheet.woff2" screen;', '@import "../media/sheet-1.woff2" screen;'],
  ['import CSS stylesheet', 'chat', 'stylesheet.css', '@import "../media/stylesheet.css" screen;', '@import "../media/stylesheet-1.css" screen;'],
  ['import url', 'overlay', 'import.woff2', '@import url( "media/import.woff2" ) screen;', '@import url( "media/import-1.woff2" ) screen;'],
  ['font face format hint', 'chat', 'font.woff2', '@font-face{src: url( "../media/font.woff2" ) format("woff2")}', '@font-face{src: url( "../media/font-1.woff2" ) format("woff2")}'],
];
for (const [label, where, name, css, expected] of cssCases) test(`theme CSS media: ${label} round trip`, async t => {
  const source = await fixture(t), target = await fixture(t);
  const from = path.join(path.dirname(source.dataDir), 'media'), to = path.join(path.dirname(target.dataDir), 'media');
  await writeFile(path.join(from, name), `source-${name}`); await writeFile(path.join(to, name), `local-${name}`);
  if (where === 'custom') for (const f of [source, target]) {
    assert.equal((await f.call('PUT', '/api/config', { customOverlays: [{ id: 'camera', name: 'Camera', html: '', css: '', js: '' }] })).status, 200);
  }
  assert.equal((await source.call('PUT', '/api/config', cssPatch(where, css))).status, 200);
  const exported = await downloadTheme(source, 'normal'); assert.equal(exported.status, 200);
  const archive = await inspectThemeZip(source, exported.bytes);
  assert.ok(archive.names.includes(`media/${name}`), `${label}: media missing from ZIP`);
  const before = await themeTransferSnapshot(target), preview = await transferTheme(target, '/preview', exported.bytes);
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.deepEqual(preview.body.warnings, []);
  assert.deepEqual(preview.body.media.conflicts, [name]); assert.deepEqual(await themeTransferSnapshot(target), before);
  const imported = await transferTheme(target, '', exported.bytes, preview.body.fingerprint);
  assert.equal(imported.status, 200, JSON.stringify(imported.body)); assert.equal(imported.body.theme.active, false);
  const after = await target.snapshot(), item = after.config.themes.saved.find(x => x.id === imported.body.theme.id);
  assert.equal(cssAt(item.look, where), expected);
  const ext = path.extname(name), renamed = name.slice(0, -ext.length) + '-1' + ext;
  assert.equal(await readFile(path.join(to, name), 'utf8'), `local-${name}`);
  assert.equal(await readFile(path.join(to, renamed), 'utf8'), `source-${name}`);
  assert.equal(after.config.themes.activeId, 'normal');
});

test('config ZIP import still rejects unreferenced CSS media entries without changing state', async t => {
  const f = await fixture(t), exported = await f.call('GET', '/api/config/export?format=json');
  const archive = themeZip([{ name: 'config.json', data: JSON.stringify(exported.body) }, { name: 'media/file.css', data: '.x{}' }]);
  const before = await themeTransferSnapshot(f);
  const response = await fetch(f.base + '/api/config/import/preview', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: archive });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'Nombre de archivo no permitido en el ZIP.' });
  assert.deepEqual(await themeTransferSnapshot(f), before);
});

test('theme CSS media: missing, external and surface-relative non-media URLs warn and stay unchanged without fetching', async t => {
  let requests = 0;
  const remote = http.createServer((_req, res) => { requests++; res.end('should never be fetched'); });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => remote.close(resolve)));
  const source = await fixture(t), target = await fixture(t), from = path.join(path.dirname(source.dataDir), 'media');
  const remoteUrl = `http://127.0.0.1:${remote.address().port}/media/externo.png`;
  const sameOrigin = `${source.base}/media/mismo.png`;
  const chatCss = `.a{background:url(media/fuera.png)} .b{background:url('/media/ausente.png')} .c{background:url('${remoteUrl}')} .d{background:url('${sameOrigin}')} /* url('/media/comentario.png') */ .x::after{content:'url(/media/texto.png)'}`;
  await writeFile(path.join(from, 'fuera.png'), 'not referenced from widget');
  await writeFile(path.join(from, 'mismo.png'), 'absolute not portable');
  assert.equal((await source.call('PUT', '/api/config', { widgets: { chat: { css: chatCss } } })).status, 200);
  const exported = await downloadTheme(source, 'normal'); assert.equal(exported.status, 200);
  assert.deepEqual((await inspectThemeZip(source, exported.bytes)).names, ['config.json']);
  const before = await themeTransferSnapshot(target), preview = await transferTheme(target, '/preview', exported.bytes);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  for (const fragment of ['fuera.png', 'ausente.png', 'externo.png', 'mismo.png']) assert.ok(preview.body.warnings.some(w => w.includes(fragment)), fragment);
  assert.equal(preview.body.warnings.some(w => w.includes('comentario.png') || w.includes('texto.png')), false);
  assert.equal(requests, 0); assert.deepEqual(await themeTransferSnapshot(target), before);
  const imported = await transferTheme(target, '', exported.bytes, preview.body.fingerprint);
  assert.equal(imported.status, 200, JSON.stringify(imported.body)); assert.deepEqual(imported.body.warnings, preview.body.warnings);
  const after = await target.snapshot(), item = after.config.themes.saved.find(x => x.id === imported.body.theme.id);
  assert.equal(item.look.widgets.chat.css, chatCss); assert.equal(after.config.themes.activeId, 'normal');
  assert.equal(requests, 0); assert.deepEqual((await themeTransferSnapshot(target)).media, []);
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

test('theme ZIP refuses more hostile names, kinds and avatars with nothing written', async t => {
  const f = await fixture(t), config = (await f.snapshot()).config, before = await themeTransferSnapshot(f);
  const ref = zipManifest(config); ref.theme.look.alerts.follow.media = 'a.png';
  const a = { name: 'media/a.png', data: 'x' };
  const cases = [
    [makeThemeZip(ref, [{ name: 'media\\a.png', data: 'x' }]), 'Nombre de archivo no permitido en el ZIP.'],
    [makeThemeZip(ref, [{ name: 'media/C:a.png', data: 'x' }]), 'Nombre de archivo no permitido en el ZIP.'],
    [makeThemeZip(ref, [a, { name: 'media/A.png', data: 'y' }]), 'El ZIP contiene nombres duplicados.'],
    [makeThemeZip(ref, [a, { name: 'media/x.html', data: '<script>' }]), 'Nombre de archivo no permitido en el ZIP.'],
    [makeThemeZip(ref, [a, { name: 'sessions/abc.json', data: '{}' }]), 'Los medios del ZIP no coinciden con las referencias del tema'],
    [makeThemeZip(ref, [a, { name: 'media/z.css', data: 'a{}' }]), 'Los medios del ZIP no coinciden con las referencias del tema'],
    [makeThemeZip(ref), 'Los medios del ZIP no coinciden con las referencias del tema'],
    [makeThemeZip(zipManifest(config, { avatar: { image: 'x.apng' } }), [{ name: 'media/x.apng', data: 'x' }]), 'El avatar admite imágenes PNG, JPG, WebP o GIF'],
    [makeThemeZip({ ...ref, format: 'antena-config' }), 'Formato de tema no válido'],
  ];
  const direct = zipManifest(config); direct.theme.look.alerts.follow.media = 'x.css';
  cases.push([makeThemeZip(direct, [{ name: 'media/x.css', data: 'a{}' }]), 'Nombre de archivo no permitido en el ZIP.']);
  for (const [bytes, error] of cases) for (const suffix of ['/preview', '']) {
    assert.deepEqual(await transferTheme(f, suffix, bytes, 'f'), { status: 400, body: { error } }, error);
    assert.deepEqual(await themeTransferSnapshot(f), before, error);
  }
});

test('theme import is all-or-nothing: name clash, commit failure and the 10-theme limit leave no media or config change', async t => {
  const source = await fixture(t), target = await fixture(t);
  await writeFile(path.join(path.dirname(source.dataDir), 'media', 'n.png'), 'new');
  assert.equal((await source.call('PUT', '/api/config', { alerts: { follow: { media: 'n.png' } } })).status, 200);
  const { bytes } = await downloadTheme(source, 'normal'), before = await themeTransferSnapshot(target);
  const p = await transferTheme(target, '/preview', bytes); assert.equal(p.status, 200);
  assert.equal((await transferTheme(target, '', bytes, p.body.fingerprint, 'NORMAL')).status, 409);
  assert.deepEqual(await themeTransferSnapshot(target), before);
  const original = target.app.store.replaceConfigWithBackup;
  target.app.store.replaceConfigWithBackup = async () => { throw new Error('injected'); };
  try { assert.equal((await transferTheme(target, '', bytes, p.body.fingerprint)).status, 500); }
  finally { target.app.store.replaceConfigWithBackup = original; }
  assert.deepEqual(await themeTransferSnapshot(target), before);
  for (let i = 1; i < 10; i++) assert.equal((await target.call('POST', '/api/themes/duplicate', { from: 'normal', name: `T${i}` })).status, 200);
  const full = await themeTransferSnapshot(target);
  assert.equal((await transferTheme(target, '/preview', bytes)).status, 409);
  assert.equal((await transferTheme(target, '', bytes, 'f')).status, 409);
  assert.deepEqual(await themeTransferSnapshot(target), full);
});
