// #103 S2–S8: HTTP and MCP consume only synthetic ended sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const start = '2026-01-01T12:00:00.000Z', end = '2026-01-01T12:02:00.500Z';
const seed = (id, extra = {}) => ({ id, startedAt: start, endedAt: end, events: [], notes: [], goalOffsets: {}, meldAutoSession: true, ...extra });
const series = (samples, gaps = []) => ({ samples, gaps, intervals: [{ from: start, seconds: 60 }] });
async function fixture(t, { current = seed('closed'), archives = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-export-'));
  const dataDir = path.join(root, 'data'), mediaDir = path.join(root, 'media');
  await mkdir(path.join(dataDir, 'sessions'), { recursive: true });
  await writeFile(path.join(dataDir, 'session-current.json'), JSON.stringify(current));
  for (const row of archives) {
    await writeFile(path.join(dataDir, 'sessions', row.id + '.json'), row.text ?? JSON.stringify(row));
    if (row.text !== undefined) await writeFile(path.join(dataDir, 'sessions', row.id + '.meta.json'), JSON.stringify({ id: row.id, startedAt: start }));
  }
  const app = await createApp({ dataDir, mediaDir, log: () => {} });
  t.after(async () => { app.viewers.halt(); await app.youtube.quiescePoll(); await app.chat.quiesceChat();
    await app.drainAutoSession(); await app.drainChatMetrics(); await app.session.flush(); await app.closeHttp();
    await rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async url => { const r = await fetch(base + url); return { status: r.status, body: await r.json() }; };
  return { app, base, request };
}
function rpc(t, base) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    env: { ANTENA_URL: base, ANTENA_NO_EMBED: '1', TMPDIR: tmpdir(), PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', id = 0; const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n')) !== -1) { const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(msg.id)?.(msg); pending.delete(msg.id); }
  });
  t.after(() => child.stdin.end());
  return (name, args = {}) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => reject(new Error('MCP no respondió')), 5000);
    pending.set(n, msg => { clearTimeout(timer); resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}
const url = '/api/metrics/v1/sessions';
const row = (platform, metric, value, unit, basis, coveredSeconds, ratio, source) => ({
  sessionId: 'closed', platform, metric, value, unit, capturedAt: end, final: true,
  coverage: { basis, liveSeconds: 120, coveredSeconds, ratio }, source,
});

test('S2–S6/S8: documento completo, huecos, ceros reales, unidades y fuentes exactas', async t => {
  const current = seed('closed', {
    platforms: { twitch: { streamId: 'tw-1' }, youtube: { videoId: 'yt-1' } },
    viewers: {
      twitch: series([{ at: start, value: 10 }, { at: '2026-01-01T12:01:00.000Z', value: 20 }],
        [{ from: '2026-01-01T12:00:30.000Z', to: '2026-01-01T12:00:45.000Z', reason: 'error' }]),
      youtube: series([{ at: start, value: 0 }]),
    },
    chatListeners: { twitch: true, youtube: true },
    chatStats: { twitch: { authorIds: ['a', 'b'], minutes: [{ at: start, messages: 3 }] },
      youtube: { authorIds: ['c'], minutes: [{ at: start, messages: 2 }] } },
  });
  const { request } = await fixture(t, { current });
  const result = await request(url + '/closed'); assert.equal(result.status, 200);
  assert.match(result.body.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  const { generatedAt, ...body } = result.body;
  const tw = 'twitch.helix.streams', yt = 'youtube.videos.liveStreamingDetails';
  assert.deepEqual(body, { schema: 'antena.session-metrics', version: 1,
    session: { id: 'closed', startedAt: start, endedAt: end, platforms: [
      { platform: 'twitch', externalId: 'tw-1', live: true }, { platform: 'youtube', externalId: 'yt-1', live: true },
    ] }, metrics: [
      row('twitch', 'viewers_average', 1650 / 105, 'count', 'viewer_samples', 105, 105 / 120, tw),
      row('twitch', 'viewers_peak', 20, 'count', 'viewer_samples', 105, 105 / 120, tw),
      row('twitch', 'chat_unique_chatters', 2, 'count', 'platform_presence', null, 1, 'twitch.irc'),
      row('twitch', 'chat_messages', 3, 'count', 'platform_presence', null, 1, 'twitch.irc'),
      row('twitch', 'chat_messages_per_minute', 3 / (120.5 / 60), 'per_minute', 'platform_presence', null, 1, 'twitch.irc'),
      row('youtube', 'viewers_average', 0, 'count', 'viewer_samples', 60, 60 / 120, yt),
      row('youtube', 'viewers_peak', 0, 'count', 'viewer_samples', 60, 60 / 120, yt),
      row('youtube', 'chat_unique_chatters', 1, 'count', 'platform_presence', null, 1, 'youtube.liveChat.messages'),
      row('youtube', 'chat_messages', 2, 'count', 'platform_presence', null, 1, 'youtube.liveChat.messages'),
      row('youtube', 'chat_messages_per_minute', 2 / (120.5 / 60), 'per_minute', 'platform_presence', null, 1, 'youtube.liveChat.messages'),
    ] });
});

test('S3–S5/S8: plataforma ausente, sin listener, listener silencioso y duración cero', async t => {
  const current = seed('closed', { platforms: { twitch: { streamId: 'tw' } }, chatListeners: { twitch: true, youtube: true } });
  const { request } = await fixture(t, { current, archives: [
    seed('dead', { platforms: { twitch: { streamId: 'tw' } } }),
    seed('zero', { endedAt: start, platforms: { twitch: { streamId: 'tw' } }, chatListeners: { twitch: true } }),
    seed('unknown-ids', { platforms: { twitch: { streamId: null }, youtube: { videoId: '' } },
      viewers: { twitch: series([{ at: start, value: 10 }]) }, chatListeners: { twitch: true, youtube: true } }),
  ] });
  const silent = (await request(url + '/closed')).body;
  assert.deepEqual(silent.session.platforms, [{ platform: 'twitch', externalId: 'tw', live: true }, { platform: 'youtube', externalId: null, live: false }]);
  assert.deepEqual(silent.metrics.slice(0, 2).map(x => [x.value, x.coverage.coveredSeconds, x.coverage.ratio]), [[null, 0, 0], [null, 0, 0]]);
  assert.deepEqual(silent.metrics.slice(2, 5).map(x => [x.value, x.coverage.ratio]), [[0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(silent.metrics.slice(5).map(x => [x.value, x.coverage.ratio]), Array(5).fill([null, 0]));
  const dead = (await request(url + '/dead')).body;
  assert.deepEqual(dead.metrics.slice(2, 5).map(x => [x.value, x.coverage.ratio]), [[null, 0], [null, 0], [null, 0]]);
  const zero = (await request(url + '/zero')).body;
  assert.deepEqual(zero.metrics.slice(2, 5).map(x => [x.value, x.coverage.liveSeconds, x.coverage.ratio]), [[0, 0, 1], [0, 0, 1], [null, 0, 1]]);
  const unknown = await request(url + '/unknown-ids'); assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body.session.platforms, [{ platform: 'twitch', externalId: null, live: false }, { platform: 'youtube', externalId: null, live: false }]);
  assert.deepEqual(unknown.body.metrics.map(x => [x.value, x.coverage.ratio]), Array(10).fill([null, 0]));
});

test('S5: fechas parseables antiguas se exportan en UTC con milisegundos sin mutar el resumen', async t => {
  const originalStart = '2026-01-01T13:00:00+01:00', originalEnd = '2026-01-01T12:02:00.5Z';
  const { request } = await fixture(t, { current: seed('closed', { startedAt: originalStart, endedAt: originalEnd }) });
  const before = await request('/api/session/summary?format=json');
  const result = await request(url + '/closed'); assert.equal(result.status, 200);
  assert.equal(result.body.session.startedAt, start); assert.equal(result.body.session.endedAt, end);
  assert.ok(result.body.metrics.every(m => m.capturedAt === end && m.coverage.liveSeconds === 120));
  assert.deepEqual(await request('/api/session/summary?format=json'), before);
});

test('S2/S8: solo automáticos terminados; listado paginado estable y errores', async t => {
  const { request } = await fixture(t, { current: seed('c', { startedAt: '2026-01-02T12:00:00.000Z', endedAt: '2026-01-02T12:01:00.000Z' }), archives: [
    seed('a'), seed('b'), seed('manual', { meldAutoSession: false }), seed('live', { endedAt: undefined }), seed('invalid-end', { endedAt: 'bad' }),
  ] });
  for (const id of ['manual', 'live', 'invalid-end', 'unknown', 'current']) {
    const r = await request(url + '/' + id); assert.equal(r.status, 404, id); assert.deepEqual(r.body, { error: 'No existe ese directo' });
  }
  const first = await request(url + '?limit=2'); assert.equal(first.status, 200);
  assert.equal(first.body.schema, 'antena.session-metrics'); assert.equal(first.body.version, 1);
  assert.deepEqual(first.body.sessions.map(x => x.session.id), ['c', 'b']); assert.equal(first.body.next, 'b');
  const second = await request(url + '?limit=2&before=b'); assert.equal(second.status, 200);
  assert.deepEqual(second.body.sessions.map(x => x.session.id), ['a']); assert.equal(second.body.next, null);
  for (const query of ['?limit=0', '?limit=51', '?limit=1.5', '?limit=', '?limit=x', '?before=missing', '?before=manual', '?before=']) {
    const r = await request(url + query); assert.equal(r.status, 400, query);
    assert.deepEqual(r.body, { error: query.startsWith('?limit=') ? 'El límite debe ser un entero entre 1 y 50.' : 'El cursor no corresponde a un directo exportable.' });
  }
});

test('S2: rechaza limit y before repetidos sin cambiar respuestas existentes', async t => {
  const { request } = await fixture(t, { archives: [seed('a')] });
  const before = await request('/api/session/summary?format=json');
  for (const [query, error] of [
    ['?limit=1&limit=0', 'El límite debe ser un entero entre 1 y 50.'],
    ['?before=a&before=missing', 'El cursor no corresponde a un directo exportable.'],
  ]) await t.test(query, async () => {
    const result = await request(url + query);
    assert.equal(result.status, 400, query); assert.deepEqual(result.body, { error });
  });
  assert.deepEqual(await request('/api/session/summary?format=json'), before);
  assert.equal((await request(url + '?limit=1')).status, 200);
});

test('S1/S4: mensajes legacy prueban el listener sin indicador explícito', async t => {
  const legacy = seed('legacy', { platforms: { twitch: { streamId: 'tw' } },
    chatStats: { twitch: { authorIds: ['a'], minutes: [{ at: start, messages: 2 }] } } });
  const { request } = await fixture(t, { archives: [legacy] });
  const before = await request('/api/session/summary?format=json&id=legacy');
  assert.equal(before.status, 200); assert.equal(before.body.chatMetrics.twitch.messages, 2);
  const result = await request(url + '/legacy'); assert.equal(result.status, 200);
  const messages = result.body.metrics.find(row => row.platform === 'twitch' && row.metric === 'chat_messages');
  assert.equal(messages.value, 2); assert.equal(messages.coverage.ratio, 1);
  assert.deepEqual(await request('/api/session/summary?format=json&id=legacy'), before);
});

test('S4/S5: rechaza duración inversa y muestras no enteras o inseguras sin alterar resúmenes', async t => {
  const archives = [
    seed('reverse', { endedAt: '2026-01-01T11:59:59.999Z' }),
    seed('fraction', { viewers: { twitch: series([{ at: start, value: 1.5 }]) } }),
    seed('unsafe', { viewers: { youtube: series([{ at: start, value: Number.MAX_SAFE_INTEGER + 1 }]) } }),
    seed('negative', { viewers: { twitch: series([{ at: start, value: -1 }]) } }),
  ];
  const { request } = await fixture(t, { archives });
  for (const { id } of archives) await t.test(id, async () => {
    const before = await request('/api/session/summary?format=json&id=' + id); assert.equal(before.status, 200);
    const result = await request(url + '/' + id);
    assert.equal(result.status, 500, id); assert.deepEqual(result.body, { error: 'El directo archivado contiene datos no válidos.' });
    assert.deepEqual(await request('/api/session/summary?format=json&id=' + id), before);
  });
});

test('S2/S8: listado incluye el archivo pendiente del corte', async t => {
  const { app, request } = await fixture(t);
  let release, entered; const gate = new Promise(r => { release = r; }), reached = new Promise(r => { entered = r; });
  const writer = app.session.writer;
  app.session.writer = (file, data, options = {}) => {
    if (path.basename(file) === 'closed.json') {
      const after = Promise.resolve(options.after).then(() => { entered(); return gate; });
      return writer(file, data, { ...options, after });
    }
    return writer(file, data, options);
  };
  const cut = app.session.startNew('siguiente');
  try {
    await reached;
    const list = await request(url); assert.equal(list.status, 200);
    assert.deepEqual(list.body.sessions.map(x => x.session.id), ['closed']);
    assert.equal((await request(url + '/closed')).status, 200);
  } finally { release(); await cut; }
});

test('S2/S8: máximo de cincuenta archivos más la sesión actual terminada', async t => {
  const archives = Array.from({ length: 51 }, (_, i) => seed('item' + String(i).padStart(2, '0')));
  const { request } = await fixture(t, { current: seed('newest', { startedAt: '2026-01-02T12:00:00.000Z', endedAt: '2026-01-02T12:01:00.000Z' }), archives });
  const first = await request(url); assert.equal(first.status, 200); assert.equal(first.body.sessions.length, 50);
  assert.equal(first.body.sessions[0].session.id, 'newest'); assert.equal(first.body.next, 'item02');
  const last = await request(url + '?before=' + first.body.next); assert.equal(last.status, 200);
  assert.deepEqual(last.body.sessions.map(x => x.session.id), ['item01']); assert.equal(last.body.next, null);
});

test('S2/S8: archivo corrupto devuelve 500 y no inventa métricas', async t => {
  const { request } = await fixture(t, { archives: [{ id: 'broken', text: '{' }, seed('invalid', { chatListeners: { twitch: false } })] });
  for (const id of ['broken', 'invalid']) {
    const r = await request(url + '/' + id); assert.equal(r.status, 500); assert.match(r.body.error, /directo|sesión/i); assert.equal(r.body.metrics, undefined);
  }
  assert.equal((await request(url)).status, 500);
});

test('S2/S7/S8: MCP equivale a HTTP por id y por defecto; resúmenes previos intactos', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-02-01T00:00:00.000Z') });
  const { request, base } = await fixture(t, { current: seed('closed', { platforms: { twitch: { streamId: 'tw' } }, chatListeners: { twitch: true } }) });
  const legacy = await Promise.all(['/api/session', '/api/session/summary?format=json', '/api/sessions'].map(request));
  const doc = (await request(url + '/closed')).body, call = rpc(t, base);
  for (const args of [{ id: 'closed' }, {}]) {
    const result = await call('metricas_directo', args); assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), doc);
  }
  assert.deepEqual(await Promise.all(['/api/session', '/api/session/summary?format=json', '/api/sessions'].map(request)), legacy);
  for (const x of legacy) assert.doesNotMatch(JSON.stringify(x.body), /chatListeners/);
});

test('S2: MCP sin sesiones elegibles devuelve un error claro', async t => {
  const { base } = await fixture(t, { current: seed('manual', { meldAutoSession: false }) });
  const result = await rpc(t, base)('metricas_directo');
  assert.equal(result.isError, true); assert.match(result.content[0].text, /directo|sesión/i);
});

test('S5: la cobertura es coherente con la duración y las filas nulas', async t => {
  const current = seed('closed', { platforms: { twitch: { streamId: 'tw' }, youtube: { videoId: 'yt' } },
    viewers: { twitch: series([{ at: start, value: 7 }, { at: '2026-01-01T12:01:30.000Z', value: 9 }]),
      youtube: series([{ at: '2026-01-01T12:02:00.200Z', value: 5 }]) },
    chatListeners: { twitch: true } });
  const { request } = await fixture(t, { current, archives: [seed('zero', { endedAt: start, platforms: { twitch: { streamId: 'tw' } }, chatListeners: { twitch: true } })] });
  for (const id of ['closed', 'zero']) {
    const { body } = await request(url + '/' + id);
    const duration = (Date.parse(body.session.endedAt) - Date.parse(body.session.startedAt)) / 1000;
    for (const m of body.metrics) {
      const c = m.coverage;
      assert.ok(Number.isSafeInteger(c.liveSeconds) && c.liveSeconds <= duration, JSON.stringify(m));
      if (c.basis === 'viewer_samples') {
        assert.ok(Number.isSafeInteger(c.coveredSeconds) && c.coveredSeconds <= c.liveSeconds, JSON.stringify(m));
        assert.equal(c.ratio, c.liveSeconds ? c.coveredSeconds / c.liveSeconds : 0, JSON.stringify(m));
        assert.equal(c.coveredSeconds === 0, c.ratio === 0, JSON.stringify(m));
      } else {
        assert.equal(c.coveredSeconds, null); assert.ok(c.ratio === 0 || c.ratio === 1, JSON.stringify(m));
      }
      if (m.value === null && !(m.metric === 'chat_messages_per_minute' && duration === 0)) assert.equal(c.ratio, 0, JSON.stringify(m));
    }
  }
  const closed = (await request(url + '/closed')).body.metrics;
  // YouTube only covered 0.3 s: less than one exported second is reported as unavailable, not as a value.
  assert.deepEqual(closed.slice(5, 7).map(m => [m.value, m.coverage.coveredSeconds, m.coverage.ratio]), [[null, 0, 0], [null, 0, 0]]);
});

test('S5: entre 500 y 999 ms cubiertos es dato no disponible', async t => {
  const { request } = await fixture(t, { current: seed('closed', {
    platforms: { twitch: { streamId: 'tw' } },
    viewers: { twitch: series([{ at: '2026-01-01T12:02:00.000Z', value: 7 }]) },
  }) });
  const m = (await request(url + '/closed')).body.metrics[0];
  assert.deepEqual([m.value, m.coverage.coveredSeconds, m.coverage.ratio], [null, 0, 0]);
});
