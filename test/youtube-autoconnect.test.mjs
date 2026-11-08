// Issue #73: al empezar el directo antena conecta sola la lectura del chat de YouTube,
// reintenta de forma acotada mientras YouTube aún no publica el directo y, al terminar,
// deja el estado limpio.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { YouTube } from '../src/youtube.mjs';
import { YouTubeAutoConnect } from '../src/youtube-auto.mjs';
import { createApp } from '../src/server.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(youtube = { apiKey: 'fake', channelId: 'UCcanal', pollSeconds: 8 }) {
  const store = { config: { youtube }, secrets: {}, async setSecret(key, value) { this.secrets[key] = value; } };
  const logs = [];
  const yt = new YouTube(store, (...m) => logs.push(m.join(' ')));
  yt.poll = () => {}; // el sondeo del chat no forma parte de estas pruebas
  return { yt, logs };
}

// API simulada: /search devuelve el directo cuando `live` es true; /videos, su chat activo.
function fakeApi(yt, state) {
  const calls = [];
  yt.api = async pathname => {
    calls.push(pathname);
    if (pathname === '/search') return { items: state.live ? [{ id: { videoId: 'abcdefghijk' } }] : [] };
    if (pathname === '/videos') return { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat-1' }, snippet: { title: 'Directo' } }] };
    throw new Error('ruta inesperada ' + pathname);
  };
  return calls;
}

test('al empezar el directo conecta la lectura del chat de YouTube', async () => {
  const { yt } = fixture();
  fakeApi(yt, { live: true });
  const auto = new YouTubeAutoConnect(yt, { retryMs: 5 });
  auto.begin();
  await auto.idle();
  assert.equal(yt.status.state, 'escuchando');
  assert.equal(yt.status.liveChatId, 'chat-1');
  auto.close();
});

test('sin API key ni cuenta, o sin canal ni vídeo, no intenta conectar', async () => {
  for (const cfg of [{ channelId: 'UCcanal' }, { apiKey: 'fake' }]) {
    const { yt } = fixture(cfg);
    const calls = fakeApi(yt, { live: true });
    const auto = new YouTubeAutoConnect(yt, { retryMs: 5 });
    auto.begin();
    await auto.idle();
    assert.deepEqual(calls, []);
    assert.equal(yt.status.state, 'parado');
  }
});

test('si el chat ya se escucha (inicio manual) no lo reinicia', async () => {
  const { yt } = fixture();
  const calls = fakeApi(yt, { live: true });
  yt.status.state = 'escuchando';
  const auto = new YouTubeAutoConnect(yt, { retryMs: 5 });
  auto.begin();
  await auto.idle();
  assert.deepEqual(calls, []);
});

test('reintenta mientras YouTube aún no muestra el directo y avisa en el estado', async () => {
  const { yt } = fixture();
  const state = { live: false };
  fakeApi(yt, state);
  const seen = [];
  yt.on('status', s => seen.push({ state: s.state, notice: s.notice }));
  const auto = new YouTubeAutoConnect(yt, { retryMs: 20, maxAttempts: 5 });
  auto.begin();
  await auto.idle();
  assert.equal(yt.status.state, 'en espera');
  assert.match(yt.status.notice, /YouTube aún no muestra el directo\. Nuevo intento en \d+ s \(1\/5\)\./);
  assert.ok(yt.status.retryAt > Date.now() - 1000);
  state.live = true;
  await new Promise(resolve => setTimeout(resolve, 40));
  await auto.idle();
  assert.equal(yt.status.state, 'escuchando');
  assert.ok(seen.some(s => s.state === 'en espera'));
  auto.close();
});

test('los reintentos se agotan y queda el error a la vista', async () => {
  const { yt, logs } = fixture();
  const calls = fakeApi(yt, { live: false });
  const auto = new YouTubeAutoConnect(yt, { retryMs: 1, maxAttempts: 3, log: (...m) => logs.push(m.join(' ')) });
  auto.begin();
  for (let i = 0; i < 20 && calls.length < 3; i++) { await new Promise(r => setTimeout(r, 5)); await auto.idle(); }
  await new Promise(r => setTimeout(r, 10));
  await auto.idle();
  assert.equal(calls.filter(c => c === '/search').length, 3);
  assert.equal(yt.status.state, 'error');
  assert.match(yt.status.errors.at(-1), /No hay ningún directo en marcha en el canal\./);
  assert.ok(logs.some(l => /No se pudo conectar el chat de YouTube tras 3 intentos/.test(l)));
});

test('un error que no es de espera (API key no válida) no se reintenta', async () => {
  const { yt } = fixture();
  let n = 0;
  yt.api = async () => { n++; throw Object.assign(new Error('La API key de YouTube no es válida.'), { reason: 'keyInvalid' }); };
  const auto = new YouTubeAutoConnect(yt, { retryMs: 1, maxAttempts: 5 });
  auto.begin();
  await auto.idle();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(n, 1);
  assert.equal(yt.status.state, 'error');
});

test('al terminar el directo detiene la lectura y limpia el estado', async () => {
  const { yt } = fixture();
  const state = { live: true };
  const calls = fakeApi(yt, state);
  const auto = new YouTubeAutoConnect(yt, { retryMs: 5 });
  auto.begin();
  await auto.idle();
  await auto.end();
  assert.equal(yt.status.state, 'parado');
  assert.equal(yt.status.liveChatId, null);
  assert.equal(yt.status.videoId, null);
  assert.equal(yt.status.notice, null);
  // un reintento pendiente también se cancela
  state.live = false;
  auto.begin();
  await auto.idle();
  assert.equal(yt.status.state, 'en espera');
  const before = calls.length;
  await auto.end();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.length, before);
  assert.equal(yt.status.state, 'parado');
  assert.equal(yt.status.retryAt, null);
});

// ---- integración con Meld en createApp ----
async function startApp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'yt-auto-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  app.store.config.meld.autoSession = false;
  app.store.config.youtube = { ...app.store.config.youtube, apiKey: 'fake', channelId: 'UCcanal' };
  const starts = [];
  app.youtube.start = () => { starts.push(1); app.youtube.setStatus({ state: 'escuchando', liveChatId: 'chat-1', videoId: 'v' }); return Promise.resolve(); };
  t.after(async () => {
    await app.closeHttp().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { app, starts };
}

test('createApp: Meld pasa a streaming → conecta YouTube; al acabar, estado limpio', { timeout: 10000 }, async t => {
  const { app, starts } = await startApp(t);
  app.meld.emit('streaming', true);
  await settle();
  assert.equal(starts.length, 1);
  app.meld.emit('streaming', false);
  await settle(); await settle();
  assert.equal(app.youtube.status.state, 'parado');
  assert.equal(app.youtube.status.liveChatId, null);
});

test('createApp: si antena arranca con el directo ya en marcha también conecta', { timeout: 10000 }, async t => {
  const { app, starts } = await startApp(t);
  app.meld.setStatus({ state: 'conectado', streaming: true });
  await settle();
  assert.equal(starts.length, 1);
  app.meld.setStatus({ state: 'conectado', streaming: true });
  await settle();
  assert.equal(starts.length, 1, 'un estado repetido no vuelve a conectar');
});
