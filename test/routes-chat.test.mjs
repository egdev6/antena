// Test del módulo src/routes/chat.mjs (tercer corte de #119): lectura y escritura de
// chat (/api/chat*, incluido /api/chat/announce). No arranca la app: construye un ctx
// falso y llama a los handlers igual que el dispatcher de server.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerChatRoutes } from '../src/routes/chat.mjs';

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ctx falso con las mismas piezas que createApp pasa por ctx.
function fakeCtx({ sendTo } = {}) {
  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });
  const calls = { twitch: [], youtube: [] };
  const ctx = {
    route,
    store: { config: { chat: { sendTo } }, patchConfig: async p => { Object.assign(ctx.store.config, p); } },
    engine: {
      chat: [{ id: 'm1', text: 'hola' }, { id: 'm2', text: 'qué tal' }],
      handleChat: msg => calls.handleChat = msg,
      clearChatUser: user => calls.clearChatUser = user,
    },
    twitch: {
      status: { user: 'canal' },
      sendChat: async t => { if (t === 'falla') throw new Error('sin conexión'); calls.twitch.push(t); return { ok: true }; },
      sendAnnouncement: async (t, color) => { calls.announce = [t, color]; return { ok: true }; },
    },
    youtube: {
      sendChat: async t => { if (t === 'falla') throw new Error('quota'); calls.youtube.push(t); return { ok: true }; },
    },
    chat: { join: ch => { calls.join = ch; }, get status() { return { joined: true, channel: calls.join }; } },
    id8: (() => { let n = 0; return () => 'id' + (++n); })(),
    httpError,
    _spies: { calls },
  };
  registerChatRoutes(ctx);
  const find = (method, path) => {
    const r = routes.find(x => x.method === method && x.re.test(path));
    assert.ok(r, `${method} ${path} registrada`);
    return { vars: path.match(r.re).groups, fn: r.fn };
  };
  return { ctx, routes, find };
}

const fakeUrl = q => new URL('http://127.0.0.1/' + (q ? '?' + q : ''));

test('registra exactamente las rutas de chat', () => {
  const { routes } = fakeCtx();
  assert.deepEqual(routes.map(r => `${r.method} ${r.pattern}`), [
    'POST /api/chat/announce',
    'GET /api/chat', 'POST /api/chat/send', 'POST /api/chat/simulate',
    'POST /api/chat/clear', 'POST /api/chat/join',
  ]);
});

test('GET /api/chat: recorta por limit y usa 50 por defecto', async () => {
  const { find } = fakeCtx();
  assert.deepEqual(await find('GET', '/api/chat').fn(null, null, fakeUrl('limit=1')), [{ id: 'm2', text: 'qué tal' }]);
  assert.deepEqual(await find('GET', '/api/chat').fn(null, null, fakeUrl()), [{ id: 'm1', text: 'hola' }, { id: 'm2', text: 'qué tal' }]);
});

test('POST /api/chat/send: destino explícito, both, heredado de la config y errores', async () => {
  const find = fakeCtx().find;
  assert.deepEqual(await find('POST', '/api/chat/send').fn({ text: 'a', to: 'twitch' }), { sent: { twitch: { ok: true } }, errors: {}, to: 'twitch' });
  assert.deepEqual((await find('POST', '/api/chat/send').fn({ text: 'a', to: 'both' })).to, 'both');
  // heredado de la config
  assert.deepEqual((await find('POST', '/api/chat/send').fn({ text: 'a' })).to, 'twitch'); // sin sendTo → twitch
  const both = fakeCtx({ sendTo: 'youtube' });
  assert.deepEqual((await both.find('POST', '/api/chat/send').fn({ text: 'a' })).to, 'youtube');
  // destino inválido → 400 sin enviar nada
  await assert.rejects(find('POST', '/api/chat/send').fn({ text: 'a', to: 'tiktok' }), e => e.status === 400);
  await assert.rejects(find('POST', '/api/chat/send').fn({ text: 'a', to: 5 }), e => e.status === 400);
  // fallo en las dos plataformas → 400 con el mensaje de cada una
  await assert.rejects(find('POST', '/api/chat/send').fn({ text: 'falla', to: 'both' }), e => e.status === 400 && /Twitch: sin conexión · YouTube: quota/.test(e.message));
  // fallo en una plataforma con both → respuesta parcial con errors, sin 400
  assert.deepEqual(await find('POST', '/api/chat/send').fn({ text: 'a', to: 'both' }), { sent: { twitch: { ok: true }, youtube: { ok: true } }, errors: {}, to: 'both' });
});

test('POST /api/chat/simulate: normaliza el mensaje y usa los valores por defecto', async () => {
  const { ctx, find } = fakeCtx();
  await find('POST', '/api/chat/simulate').fn({ user: 'Ana', text: 'hola' });
  assert.deepEqual(ctx._spies.calls.handleChat, {
    id: 'sim:id1', platform: 'twitch', user: 'Ana', login: 'ana', text: 'hola',
    parts: [{ t: 'hola' }], mod: false, owner: false, member: false, highlighted: false, at: ctx._spies.calls.handleChat.at,
  });
  assert.ok(typeof ctx._spies.calls.handleChat.at === 'string');
  await find('POST', '/api/chat/simulate').fn({ user: 'Luis', text: 'x', platform: 'youtube', mod: true, highlighted: true });
  assert.equal(ctx._spies.calls.handleChat.platform, 'youtube');
  assert.equal(ctx._spies.calls.handleChat.mod, true);
});

test('POST /api/chat/clear y /api/chat/join: limpian y reconectan', async () => {
  const { ctx, find } = fakeCtx();
  assert.deepEqual(await find('POST', '/api/chat/clear').fn(), { ok: true });
  assert.equal(ctx._spies.calls.clearChatUser, null);
  assert.deepEqual(await find('POST', '/api/chat/join').fn({ channel: 'otrocanal' }), { joined: true, channel: 'otrocanal' });
  assert.equal(ctx._spies.calls.join, 'otrocanal');
  assert.equal(ctx.store.config.chat.twitchChannel, 'otrocanal');
  // canal vacío → usa el usuario de Twitch
  await find('POST', '/api/chat/join').fn({});
  assert.equal(ctx._spies.calls.join, 'canal');
});

test('POST /api/chat/announce: envía texto y color', async () => {
  const { ctx, find } = fakeCtx();
  assert.deepEqual(await find('POST', '/api/chat/announce').fn({ text: 'hola', color: 'green' }), { sent: { ok: true } });
  assert.deepEqual(ctx._spies.calls.announce, ['hola', 'green']);
});
