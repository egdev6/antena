// The v3 migration must freeze the effective look of an existing install: once migrated, changing any
// default in code (theme, alert looks/texts, conditions, commands, timers, widgets) must not change what
// the install renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, DEFAULT_CONFIG } from '../src/store.mjs';
import { DEFAULT_THEME, themeCss, publicTheme } from '../src/theme.mjs';
import * as A from '../src/alerts.mjs';
import { alertFields } from '../src/timers.mjs';

const strip = ({ id, at, ...a }) => a;
const render = c => JSON.stringify({ css: themeCss(c.theme), pub: publicTheme(c.theme),
  alerts: Object.keys(A.ALERT_TYPES).map(t => strip(A.buildAlert(t, { ...A.SAMPLES[t], amount: 2000, tier: 3 }, c, { rnd: () => 0.3 }))),
  cond: c.alerts.sub.variations.map(v => A.matchesConditions(v.conditions, {}, () => 0.3)),
  cmds: c.commands.map(x => strip(A.buildCommandAlert(x, A.SAMPLES.command, c))),
  timers: c.timers.map(t => strip(A.buildCustomAlert(alertFields(t), {}, c))), widgets: c.widgets, interactive: c.interactive });

test('a migrated v2 install renders the same after every default changes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-freeze-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ configVersion: 2, theme: { accent: '#00FF88' },
    alerts: { follow: { title: 'Hola' }, sub: { variations: [{ id: 'v', name: 'V', conditions: { tier: '3' }, overrides: { title: 'T3' } }] } },
    commands: [{ id: 'c1', trigger: '!hola' }], timers: [{ id: 't1', name: 'n', message: 'm', intervalMin: 5, showAlert: true }],
    widgets: { chat: { fontSize: 30 } } }));
  const before = render((await new Store(dir).load()).config);
  Object.assign(DEFAULT_THEME, { accent: '#123456', tilt: false, platformAccent: true });
  Object.assign(A.DEFAULT_CONDITIONS, { chance: 1, users: 'zzz' });
  Object.assign(A.LOOK_DEFAULTS, { fontSize: 11, css: '.m{}' });
  for (const a of Object.values(A.DEFAULT_ALERTS)) Object.assign(a, { title: 'M', fontSize: 11, durationMs: 9999 });
  Object.assign(A.DEFAULT_COMMAND, { title: 'M', css: '.m{}' }); Object.assign(A.DEFAULT_CUSTOM_ALERT, { durationMs: 9999, css: '.m{}' });
  Object.assign(DEFAULT_CONFIG.widgets.chat, { fontSize: 11 }); Object.assign(DEFAULT_CONFIG.interactive.questions, { css: '.m{}' });
  assert.equal(render((await new Store(dir).load()).config), before);
});
