// Registro en bruto de eventos de plataforma: cada evento recibido de YouTube o Twitch
// queda en data/raw-events.jsonl con `handled` indicando si Antena lo procesó.
// Sirve para diagnosticar eventos que la plataforma envía y Antena descarta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RawEventLog } from '../src/raw-events.mjs';
import { YouTube } from '../src/youtube.mjs';
import { Twitch } from '../src/twitch.mjs';
import { createApp } from '../src/server.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'antena-raw-'));
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l));

test('RawEventLog añade una línea JSON por evento con plataforma, tipo, handled y payload', async t => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = new RawEventLog(dir);
  log.record('youtube', 'mysteryEvent', false, { id: 'a', snippet: { type: 'mysteryEvent' } });
  log.record('twitch', 'channel.follow', true, { user_name: 'Ana' });
  await log.flush();
  const got = await lines(path.join(dir, 'raw-events.jsonl'));
  assert.equal(got.length, 2);
  assert.deepEqual({ ...got[0], at: undefined }, { at: undefined, platform: 'youtube', kind: 'mysteryEvent', handled: false, raw: { id: 'a', snippet: { type: 'mysteryEvent' } } });
  assert.ok(!Number.isNaN(Date.parse(got[0].at)), 'at es una fecha ISO');
  assert.equal(got[1].platform, 'twitch');
  assert.equal(got[1].handled, true);
});

test('RawEventLog rota el fichero al superar el tamaño máximo', async t => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = new RawEventLog(dir, { maxBytes: 200 });
  for (let i = 0; i < 10; i++) log.record('twitch', 'channel.follow', true, { user_name: 'x'.repeat(40), i });
  await log.flush();
  const cur = await stat(path.join(dir, 'raw-events.jsonl'));
  assert.ok(cur.size <= 400, 'el fichero actual queda acotado');
  const old = await lines(path.join(dir, 'raw-events.1.jsonl'));
  assert.ok(old.length > 0, 'las líneas antiguas pasan al fichero rotado');
  const all = [...old, ...await lines(path.join(dir, 'raw-events.jsonl'))];
  assert.equal(all.at(-1).raw.i, 9, 'la última línea es el último evento');
});

test('RawEventLog nunca lanza aunque no pueda escribir', async () => {
  const log = new RawEventLog('/nonexistent/\0bad', { log: () => {} });
  assert.doesNotThrow(() => log.record('youtube', 'x', false, {}));
  await log.flush();
});

function youtubeFixture(rawLog) {
  const store = { config: { youtube: { apiKey: 'fake', video: 'abcdefghijk', pollSeconds: 8 } }, secrets: {} };
  const yt = new YouTube(store, () => {});
  yt.rawLog = rawLog;
  yt.running = true;
  yt.primed = true;
  yt.status.liveChatId = 'chat';
  return yt;
}

test('YouTube registra cada item del chat, también los tipos que Antena no reconoce', async () => {
  const recorded = [];
  const yt = youtubeFixture({ record: (...a) => recorded.push(a) });
  const unknown = { id: 'u1', snippet: { type: 'newSubscriberEvent' }, authorDetails: { displayName: 'Marcos' } };
  const superChat = { id: 's1', snippet: { type: 'superChatEvent', superChatDetails: { amountMicros: '2000000', amountDisplayString: '2 €' } }, authorDetails: { displayName: 'Ana' } };
  const events = [];
  yt.on('event', e => events.push(e));
  yt.api = async () => ({ items: [unknown, superChat], nextPageToken: 'n' });
  await yt.poll();
  yt.running = false;
  assert.deepEqual(recorded.map(r => r.slice(0, 3)), [['youtube', 'newSubscriberEvent', false], ['youtube', 'superChatEvent', true]]);
  assert.deepEqual(recorded[0][3], unknown);
  assert.equal(events.length, 1, 'el tipo desconocido sigue sin generar alerta');
});

test('YouTube registra también la primera lectura, marcada como no procesada', async () => {
  const recorded = [];
  const yt = youtubeFixture({ record: (...a) => recorded.push(a) });
  yt.primed = false;
  const msg = { id: 't1', snippet: { type: 'superChatEvent', superChatDetails: {} }, authorDetails: { displayName: 'Ana' } };
  yt.api = async () => ({ items: [msg], nextPageToken: 'n' });
  await yt.poll();
  yt.running = false;
  assert.deepEqual(recorded.map(r => r.slice(0, 3)), [['youtube', 'superChatEvent', false]]);
});

test('Twitch registra cada notificación con handled según si se normaliza', () => {
  const recorded = [];
  const tw = new Twitch({ config: {}, secrets: {} }, () => {});
  tw.rawLog = { record: (...a) => recorded.push(a) };
  tw.emitEvent('m1', 'channel.follow', { user_name: 'Ana' });
  tw.emitEvent('m2', 'channel.unknown_thing', { foo: 1 });
  assert.deepEqual(recorded, [
    ['twitch', 'channel.follow', true, { user_name: 'Ana' }],
    ['twitch', 'channel.unknown_thing', false, { foo: 1 }],
  ]);
});

test('createApp escribe los eventos de plataforma en data/raw-events.jsonl', async t => {
  const dataDir = await tmp();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  t.after(() => new Promise(r => { app.server.closeAllConnections(); app.server.close(r); }));
  app.twitch.emitEvent('m1', 'channel.follow', { user_name: 'Ana' });
  await app.twitch.rawLog.flush();
  const got = await lines(path.join(dataDir, 'raw-events.jsonl'));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'channel.follow');
  assert.equal(app.youtube.rawLog, app.twitch.rawLog);
});
