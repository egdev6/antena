// Issue #63: tras `quotaExceeded` (o `forbidden`) el sondeo se reintenta con espera
// creciente y el estado indica el motivo; `liveChatEnded` sigue siendo definitivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { YouTube } from '../src/youtube.mjs';

function fixture() {
  const store = {
    config: { youtube: { apiKey: 'fake', video: 'abcdefghijk', pollSeconds: 8 } }, secrets: {},
    async setSecret(key, value) { this.secrets[key] = value; },
  };
  const yt = new YouTube(store, () => {});
  yt.running = true;
  yt.primed = true;
  yt.status.liveChatId = 'chat';
  yt.pageToken = 'anterior';
  return yt;
}

const ok = { items: [], nextPageToken: 'sig' };

// API simulada: cada llamada devuelve la siguiente respuesta de la lista.
function fakeApi(yt, responses) {
  const calls = [];
  yt.api = async (path, params) => {
    calls.push({ path, pageToken: params.pageToken });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    if (r) return r;
    return ok;
  };
  return calls;
}

const quota = () => Object.assign(new Error('Se ha agotado la cuota diaria de la API de YouTube (se renueva a las 9:00 en España).'), { reason: 'quotaExceeded' });
const forbidden = () => Object.assign(new Error('YouTube no deja leer o escribir en ese chat con estos permisos.'), { reason: 'forbidden' });
const ended = () => Object.assign(new Error('El chat del directo ha terminado.'), { reason: 'liveChatEnded' });

// El reloj es síncrono: tras cada tick se espera a que termine el trabajo del sondeo.
const flush = yt => Promise.allSettled([...yt.pollWork]);

test('tras quotaExceeded programa un reintento y el estado indica el motivo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture();
  const calls = fakeApi(yt, [quota()]);
  await yt.poll();
  // Sin fail: sigue en marcha, con estado y motivo visibles.
  assert.equal(yt.running, true);
  assert.equal(yt.status.state, 'en espera');
  assert.match(String(yt.status.notice), /cuota/i);
  assert.ok(yt.status.retryAt, 'hay momento de reintento');
  // El reintento no reutiliza un pageToken descartado: lo conserva la lectura anterior.
  assert.notEqual(calls[0].pageToken, undefined, 'la primera lectura sí llevaba pageToken');
  await t.mock.timers.tick(60_000);
  await flush(yt);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].pageToken, 'anterior');
  // Al volver la API, el sondeo se reanuda sin reiniciar la app.
  assert.equal(yt.status.state, 'escuchando');
  assert.equal(yt.status.notice, null);
  assert.equal(yt.status.polls, 1);
  assert.equal(yt.running, true);
});

test('la espera crece tras errores consecutivos y tiene tope', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture();
  const calls = fakeApi(yt, [quota(), quota(), quota()]);
  await yt.poll();
  await t.mock.timers.tick(60_000); await flush(yt); // primer reintento
  assert.equal(yt.status.state, 'en espera');
  assert.equal(calls.length, 2);
  await t.mock.timers.tick(60_000); await flush(yt); // aún no: toca a los 120 s
  assert.equal(calls.length, 2);
  await t.mock.timers.tick(60_000); await flush(yt);
  assert.equal(calls.length, 3);
  await t.mock.timers.tick(240_000); await flush(yt);
  assert.equal(calls.length, 4);
});

test('forbidden reintenta con espera menor y estado visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture();
  const calls = fakeApi(yt, [forbidden()]);
  await yt.poll();
  assert.equal(yt.status.state, 'en espera');
  assert.match(String(yt.status.notice), /permisos/i);
  await t.mock.timers.tick(20_000); await flush(yt);
  assert.equal(calls.length, 2);
  assert.equal(yt.status.state, 'escuchando');
});

test('liveChatEnded sigue siendo definitivo: error y sin reintento', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const yt = fixture();
  const calls = fakeApi(yt, [ended()]);
  await yt.poll();
  assert.equal(yt.status.state, 'error');
  assert.equal(yt.running, false);
  await t.mock.timers.tick(600_000); await flush(yt);
  assert.equal(calls.length, 1);
});

// Revisión de #63: el pageToken no se descarta tras un error, para que el reintento no
// vuelva a traer (y reemitir) los últimos mensajes ya procesados.
for (const [name, makeError, wait] of [['quotaExceeded', quota, 60_000], ['transitorio', () => new Error('fallo de red'), 20_000]]) {
  test(`tras un error ${name} el reintento conserva el pageToken y no reemite mensajes`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const yt = fixture();
    const sc = { id: 'sc1', snippet: { type: 'superChatEvent', superChatDetails: { amountMicros: '5000000', amountDisplayString: '5 €', userComment: '¡arriba!' } }, authorDetails: { displayName: 'Ada' } };
    const chat = { id: 'm1', snippet: { type: 'textMessageEvent', displayMessage: 'hola' }, authorDetails: { displayName: 'Bo' } };
    const page = { items: [sc, chat], nextPageToken: 'sig' };
    const calls = [];
    yt.pageToken = null;
    yt.api = async (_path, params) => {
      calls.push(params.pageToken);
      if (calls.length === 2) throw makeError();
      // Lectura nueva (primera llamada): YouTube devuelve los mensajes recientes;
      // con pageToken conservado devuelve solo lo nuevo.
      return calls.length === 1 ? page : { items: [], nextPageToken: 'sig' };
    };
    const events = [], chats = [];
    yt.on('event', e => events.push(e));
    yt.on('chat', c => chats.push(c));
    await yt.poll(); // primera lectura: alerta y chat una vez
    assert.equal(events.length, 1);
    assert.equal(chats.length, 1);
    await t.mock.timers.tick(8_000); await Promise.allSettled([...yt.pollWork]); // el sondeo falla
    // Reintento pasados más de 10 min desde la primera lectura (ventana de deduplicado del bus).
    await t.mock.timers.tick(wait);
    await Promise.allSettled([...yt.pollWork]);
    await t.mock.timers.tick(11 * 60_000);
    await Promise.allSettled([...yt.pollWork]);
    assert.equal(calls[2], 'sig', 'el reintento conserva el pageToken de la última lectura buena');
    assert.equal(events.length, 1, 'el superchat no se vuelve a alertar');
    assert.equal(chats.length, 1, 'el mensaje de chat no se repite');
  });
}

// Aviso en las vistas (el estado llega por SSE, ya probado en el servidor).
// #115: el panel clásico se retiró; el aviso se comprueba en Conexiones (panel React) y el dock.
test('el aviso de YouTube llega a Conexiones y al dock', async () => {
  const { readFile } = await import('node:fs/promises');
  const conexiones = await readFile(new URL('../app/src/panel/views/Conexiones.tsx', import.meta.url), 'utf8');
  assert.match(conexiones, /yt\.notice/);
  const dock = await readFile(new URL('../app/src/dock/Dock.tsx', import.meta.url), 'utf8');
  assert.match(dock, /st\.youtube/);
});
