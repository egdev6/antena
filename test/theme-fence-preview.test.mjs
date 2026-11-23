// Theme preview and cross-client draft fence: real HTTP and isolated system-temp storage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.mjs';

const STALE = 'El tema activo cambió mientras editabas; tus cambios no se guardaron';
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-theme-fence-'));
  let app;
  t.after(async () => {
    try {
      if (app) {
        app.interactive.quiesceVoteTimer(); await app.drainAutoSession(); await app.session.flush(); await app.interactive.flush();
        app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp();
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), push: {}, log: () => {} });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, themeId) => {
    const headers = { 'content-type': 'application/json', ...(themeId === undefined ? {} : { 'x-antena-theme': themeId }) };
    const response = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = async () => ({ config: (await call('GET', '/api/config/export?format=json')).body.config,
    bytes: await readFile(path.join(dir, 'config.json'), 'utf8'), files: (await readdir(dir)).filter(x => x.startsWith('config')).sort(),
    persistence: (await call('GET', '/api/status')).body.persistence,
    goals: (await call('GET', '/api/state')).body.widgets.goals });
  return { call, snapshot, base, app };
}

test('stale themed writes reject before any config, counter or persistence change; no header and matching header preserve writes', async t => {
  const f = await fixture(t);
  const command = await f.call('POST', '/api/commands', { trigger: '!prueba' });
  assert.equal(command.status, 200);
  const timer = await f.call('POST', '/api/timers', { name: 'Prueba', message: 'hola' });
  assert.equal(timer.status, 200);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' });
  assert.equal(made.status, 200);
  const id = made.body.theme.id;
  assert.equal((await f.call('POST', `/api/themes/${id}/activate`)).status, 200);
  const writes = [
    ['PUT', '/api/theme', { accent: '#112233' }],
    ['PUT', '/api/theme/draft', { accent: '#112233' }],
    ['PUT', '/api/alerts/follow', { title: 'no guardar' }],
    ['PUT', '/api/widgets', { chat: { fontSize: 31 } }],
    ['PUT', `/api/commands/${command.body.command.id}`, { title: 'no guardar' }],
    ['PUT', `/api/timers/${timer.body.timer.id}`, { title: 'no guardar' }],
    ['PUT', '/api/goals/principal', { title: 'no guardar' }],
    ['POST', '/api/widgets/chat/variants', { name: 'no guardar' }],
    ['PUT', '/api/interactive/config', { questions: { css: '.old{}' } }],
    ['PUT', '/api/config', { overlay: { css: '.old{}' } }],
  ];
  for (const [method, url, body] of writes) {
    const before = await f.snapshot();
    assert.deepEqual(await f.call(method, url, body, 'normal'), { status: 409, body: { error: STALE } }, url);
    assert.deepEqual(await f.snapshot(), before, url);
  }
  assert.equal((await f.call('PUT', '/api/theme', { accent: '#112233' }, id)).status, 200);
  assert.equal((await f.call('PUT', '/api/theme', { accent: '#445566' })).status, 200);
  assert.equal((await f.call('GET', '/api/theme')).body.theme.accent, '#445566');
});

test('a stale theme header does not block unrelated global settings', async t => {
  const f = await fixture(t);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' });
  assert.equal(made.status, 200);
  assert.equal((await f.call('POST', `/api/themes/${made.body.theme.id}/activate`)).status, 200);
  const changed = await f.call('PUT', '/api/config', { panel: { onboardingDone: true } }, 'normal');
  assert.equal(changed.status, 200); assert.equal(changed.body.config.panel.onboardingDone, true);
  assert.equal((await f.call('GET', '/api/themes')).body.themes.find(x => x.active).id, made.body.theme.id);
});

test('a switch during body upload is fenced before dispatch', async t => {
  const f = await fixture(t);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' });
  assert.equal(made.status, 200);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let req;
  const reply = new Promise((resolve, reject) => {
    req = http.request(f.base + '/api/theme', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-antena-theme': 'normal' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write('{"accent":'); req.flushHeaders(); started();
  });
  await ready;
  assert.equal((await f.call('POST', `/api/themes/${made.body.theme.id}/activate`)).status, 200);
  const before = await f.snapshot();
  req.end('"#123456"}');
  assert.deepEqual(await reply, { status: 409, body: { error: STALE } });
  assert.deepEqual(await f.snapshot(), before);
});

test('mixed overlay and themed writes cannot straddle an active-theme switch', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' });
  assert.equal(made.status, 200);
  const created = await f.call('POST', '/api/custom-overlays', { name: 'Marco', css: '.antes{}' });
  assert.equal(created.status, 200);
  const overlay = created.body.overlay;
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  t.after(() => release());
  const replaceAll = f.app.customOverlays.replaceAll.bind(f.app.customOverlays);
  f.app.customOverlays.replaceAll = async input => { reached(); await gate; return replaceAll(input); };
  const write = f.call('PUT', '/api/config', { customOverlays: [{ ...overlay, css: '.despues{}' }], theme: { accent: '#123456' } }, 'normal');
  // The old sequential path can be paused before its overlay write; a single atomic
  // commit removes that gap and is allowed to finish before the switch instead.
  const first = await Promise.race([waiting.then(() => ({ paused: true })), write.then(result => ({ result }))]);
  if (first.paused) {
    assert.equal((await f.call('POST', `/api/themes/${made.body.theme.id}/activate`)).status, 200);
    const before = await f.snapshot();
    release();
    assert.deepEqual(await write, { status: 409, body: { error: STALE } });
    assert.deepEqual(await f.snapshot(), before);
  } else {
    assert.equal(first.result.status, 200);
    assert.equal(first.result.body.config.theme.accent, '#123456');
    assert.equal(first.result.body.config.customOverlays[0].css, '.despues{}');
    assert.equal((await f.call('POST', `/api/themes/${made.body.theme.id}/activate`)).status, 200);
    assert.equal((await f.call('GET', '/api/theme')).body.theme.accent, '#FF0036');
    assert.equal((await f.call('GET', '/api/custom-overlays')).body.overlays[0].css, '.despues{}');
  }
});

test('mixed write is rejected unchanged when the active theme switches during its body upload', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' });
  assert.equal(made.status, 200);
  const created = await f.call('POST', '/api/custom-overlays', { name: 'Marco', css: '.antes{}' });
  assert.equal(created.status, 200);
  const payload = JSON.stringify({ customOverlays: [{ ...created.body.overlay, css: '.despues{}' }], theme: { accent: '#123456' } });
  const received = new Promise(resolve => {
    const watch = req => {
      if (req.method !== 'PUT' || req.url !== '/api/config') return;
      f.app.server.off('request', watch);
      req.once('data', resolve);
    };
    f.app.server.on('request', watch);
  });
  let req;
  const reply = new Promise((resolve, reject) => {
    req = http.request(f.base + '/api/config', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-antena-theme': 'normal' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(payload.slice(0, 12));
  });
  await received;
  assert.equal((await f.call('POST', `/api/themes/${made.body.theme.id}/activate`)).status, 200);
  const before = await f.snapshot();
  req.end(payload.slice(12));
  assert.deepEqual(await reply, { status: 409, body: { error: STALE } });
  assert.deepEqual(await f.snapshot(), before);
});

test('matching and absent theme headers preserve mixed overlay and themed writes', async t => {
  const f = await fixture(t);
  const created = await f.call('POST', '/api/custom-overlays', { name: 'Marco', css: '.antes{}', requestedPermissions: ['say'] });
  assert.equal(created.status, 200);
  let overlay = created.body.overlay;
  for (const [themeId, css, accent] of [[undefined, '.sin-cabecera{}', '#123456'], ['normal', '.con-cabecera{}', '#654321']]) {
    const result = await f.call('PUT', '/api/config', { customOverlays: [{ ...overlay, css }], theme: { accent } }, themeId);
    assert.equal(result.status, 200);
    assert.equal(result.body.config.theme.accent, accent);
    overlay = result.body.config.customOverlays[0];
    assert.equal(overlay.css, css);
    assert.deepEqual(overlay.requestedPermissions, ['say']);
    assert.deepEqual(overlay.permissions, []);
    assert.equal((await f.call('GET', '/api/theme')).body.theme.accent, accent);
    assert.equal((await f.call('GET', '/api/custom-overlays')).body.overlays[0].css, css);
  }
});

test('theme CSS writes are fenced and preserve the global overlay', async t => {
  const f = await fixture(t);
  const overlay = (await f.call('POST', '/api/custom-overlays', { name: 'Marco', css: '.base{}' })).body.overlay;
  const path = `customOverlayCss.${overlay.id}`;
  assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Otro' })).status, 200);
  assert.equal((await f.call('POST', '/api/themes/otro/activate')).status, 200);
  for (const [method, url, body] of [
    ['POST', '/api/config/set', { path, value: '.stale{}' }],
    ['PUT', '/api/config', { customOverlayCss: { [overlay.id]: '.stale{}' } }],
  ]) {
    const before = await f.snapshot();
    assert.deepEqual(await f.call(method, url, body, 'normal'), { status: 409, body: { error: STALE } });
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual((await f.call('GET', `/api/custom-overlays/${overlay.id}`)).body.overlay, overlay);
  }
  assert.equal((await f.call('POST', '/api/config/set', { path, value: '.actual{}' }, 'otro')).status, 200);
  assert.equal((await f.call('GET', '/api/config')).body.customOverlayCss[overlay.id], '.actual{}');
  assert.deepEqual((await f.call('GET', `/api/custom-overlays/${overlay.id}`)).body.overlay, overlay);
});

test('a non-follow preview projects the selected theme and alert without leaking actions or changing state', async t => {
  const f = await fixture(t);
  const winter = { theme: { accent: '#123456', platformAccent: false }, overlay: { css: '.winter{}' },
    alerts: { sub: { title: 'Sub invierno', css: '.sub-winter{}', actions: [{ kind: 'say', text: 'private-action' }] } } };
  assert.equal((await f.call('PUT', '/api/config', winter)).status, 200);
  assert.equal((await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' })).status, 200);
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#654321' }, alerts: { sub: { title: 'Sub activa' } } })).status, 200);
  const before = await f.snapshot();
  const preview = await f.call('GET', '/api/themes/invierno/preview?type=sub');
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.activeTheme, { id: 'invierno', name: 'Invierno' });
  assert.equal(preview.body.alert.type, 'sub');
  assert.equal(preview.body.alert.title, 'Sub invierno');
  assert.equal(preview.body.theme.accent, '#123456');
  assert.match(preview.body.css, /--red:#123456/);
  assert.equal(preview.body.alert.globalCss, '.winter{}');
  assert.equal(preview.body.alert.look.css, '.sub-winter{}');
  assert.doesNotMatch(JSON.stringify(preview.body), /private-action|"actions"|"clientSecret"|"apiKey"/);
  assert.deepEqual(await f.call('GET', '/api/themes/invierno/preview?type=invalid'), { status: 404, body: { error: 'Tipo desconocido' } });
  assert.deepEqual(await f.snapshot(), before);
});

test('preview returns real selected alert and widget visual data without operational fields or changing active state', async t => {
  const f = await fixture(t);
  const patch = { theme: { accent: '#123456', platformAccent: false }, overlay: { css: '.alert { --card-width: 777px }' },
    alerts: { follow: { title: 'Invierno', text: 'Hola {user}', layout: 'mixed', media: 'winter.png', css: '.alert { --accent: #2468AC }', actions: [{ kind: 'say', text: 'private action marker' }] } },
    widgets: { chat: { fontSize: 34, layout: 'horizontal', css: '.msg { opacity: .7 }' }, goals: [{ id: 'g', title: 'Meta de invierno', visible: true, showMetric: true, css: '.goal { opacity: .8 }', bars: [{ id: 'b', platform: 'twitch', metric: 'follows', target: 50, visible: true }] }] } };
  assert.equal((await f.call('PUT', '/api/config', patch)).status, 200);
  const made = await f.call('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' });
  assert.equal(made.status, 200);
  assert.equal((await f.call('PUT', '/api/config', { theme: { accent: '#ABCDEF' }, alerts: { follow: { title: 'Activo' } } })).status, 200);
  const before = await f.snapshot();
  const res = await f.call('GET', `/api/themes/${made.body.theme.id}/preview`);
  assert.equal(res.status, 200);
  assert.equal(res.body.theme.accent, '#123456');
  assert.match(res.body.css, /--red:#123456/);
  assert.equal(res.body.alert.title, 'Invierno'); assert.equal(res.body.alert.look.layout, 'mixed');
  assert.equal(res.body.alert.look.media, 'winter.png'); assert.match(res.body.alert.look.css, /#2468AC/);
  assert.match(res.body.alert.globalCss, /777px/);
  assert.equal(res.body.widgets.chat.fontSize, 34); assert.match(res.body.widgets.chat.css, /opacity/);
  assert.equal(res.body.goals[0].title, 'Meta de invierno'); assert.match(res.body.goals[0].css, /opacity/);
  assert.doesNotMatch(JSON.stringify(res.body), /private action marker|"commands"|"timers"|"clientSecret"|"apiKey"/);
  assert.deepEqual(await f.call('GET', '/api/themes/missing/preview'), { status: 404, body: { error: 'No existe el tema «missing»' } });
  assert.deepEqual(await f.snapshot(), before);
});
