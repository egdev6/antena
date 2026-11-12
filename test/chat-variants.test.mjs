// Variantes del chat: solo interfaces públicas HTTP, SSE y MCP; datos aislados y puerto efímero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/server.mjs';

const ROUTE = '/api/widgets/chat/variants';
const CHAT = {
  platforms: ['youtube'], maxMessages: 37, fadeAfterSec: 23, fontSize: 41,
  hideCommands: false, hideOwner: false, showPlatform: false, reverse: true,
  animIn: 'bounce', animOut: 'zoom', layout: 'horizontal', css: '.chat { color: red; }',
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-chat-variants-'));
  let app;
  t.after(async () => {
    if (app) {
      app.teleprompter.stop(); app.viewers.stop(); app.meld.stop(); app.timers.stop();
      app.engine.flushScheduledSends();
      app.server.closeAllConnections();
      await new Promise(resolve => app.server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  app = await createApp({ dataDir: dir, mediaDir: path.join(dir, 'media'), log: () => {} });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const port = app.server.address().port;
  assert.notEqual(port, 4500);
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, url, body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (method, url, body) => {
    const result = await request(method, url, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const snapshot = async () => ({
    config: await ok('GET', '/api/config'),
    persistence: (await ok('GET', '/api/status')).persistence,
    bytes: await readFile(path.join(dir, 'config.json')),
  });
  const unchanged = async before => {
    const after = await snapshot();
    assert.deepEqual(after.config, before.config, 'configuración en memoria intacta');
    assert.deepEqual(after.persistence, before.persistence, 'contadores y estado de persistencia intactos');
    assert.ok(after.bytes.equals(before.bytes), 'config.json byte a byte intacto');
  };
  return { base, port, request, ok, snapshot, unchanged };
}

async function stream(base, t, client) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${base}/api/stream?client=${client}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async predicate => {
    for (;;) {
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!/^event: widgets$/m.test(block)) continue;
        const payload = /^data: (.+)$/m.exec(block)?.[1];
        if (payload) {
          const data = JSON.parse(payload);
          if (predicate(data)) return data;
        }
      }
      let timer;
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`sin evento widgets para ${client}`)), 5000); }),
      ]).finally(() => clearTimeout(timer));
      assert.equal(chunk.done, false, 'el stream permanece abierto');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

test('crear copia todos los campos del chat y queda independiente de cambios posteriores', async t => {
  const f = await fixture(t);
  const saved = await f.ok('PUT', '/api/widgets', { chat: CHAT });
  assert.deepEqual(saved.widgets.chat, CHAT, 'PUT existente conserva el merge del chat');
  const { variant } = await f.ok('POST', ROUTE, { name: '  Programa  ' });
  assert.deepEqual(variant, { id: 'programa', name: 'Programa', ...CHAT });
  assert.deepEqual(await f.ok('GET', ROUTE), [variant]);
  await f.ok('POST', '/api/config/set', { path: 'widgets.chat.platforms.0', value: 'twitch' });
  assert.deepEqual(await f.ok('GET', ROUTE), [variant], 'mutar el array original no afecta a la copia');
  await f.ok('PUT', '/api/widgets', { chat: { platforms: ['twitch'], css: 'otro', layout: 'vertical', fontSize: 12 } });
  assert.deepEqual(await f.ok('GET', ROUTE), [variant], 'los campos y la lista platforms no heredan cambios');
  assert.deepEqual((await f.ok('GET', '/api/widgets')).widgets.chat, { ...CHAT, platforms: ['twitch'], css: 'otro', layout: 'vertical', fontSize: 12 });
});

test('ids son slugs sin acentos, únicos y nunca usan el reservado default', async t => {
  const f = await fixture(t);
  const names = ['  Mí Chat Élite!!  ', 'mi chat elite', 'Mi CHAT elite', 'DeFáult', 'default', '🔥', '🤖'];
  const ids = [];
  for (const name of names) ids.push((await f.ok('POST', ROUTE, { name })).variant.id);
  assert.deepEqual(ids, ['mi-chat-elite', 'mi-chat-elite-2', 'mi-chat-elite-3', 'default-2', 'default-3', 'variante', 'variante-2']);
  const long = (await f.ok('POST', ROUTE, { name: 'A'.repeat(90) })).variant;
  assert.equal(long.name.length, 60, 'nombre acotado como los atajos');
  assert.match(long.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  const boundary = (await f.ok('POST', ROUTE, { name: `${'B'.repeat(59)} palabra` })).variant;
  assert.equal(boundary.name, 'B'.repeat(59), 'el nombre sigue recortado al truncarlo');
});

test('renombrar mantiene el id y PUT parcial valida y guarda todos los campos editables', async t => {
  const f = await fixture(t);
  const original = (await f.ok('POST', ROUTE, { name: 'Mi directo' })).variant;
  // Un id idéntico es compatible; el caso distinto se rechaza en B2, ya no se ignora.
  const changed = (await f.ok('PUT', `${ROUTE}/${original.id}`, { ...CHAT, name: '  Otro nombre  ', id: original.id })).variant;
  assert.deepEqual(changed, { id: 'mi-directo', name: 'Otro nombre', ...CHAT });
  const again = (await f.ok('PUT', `${ROUTE}/${original.id}`, { fontSize: 8, maxMessages: 200 })).variant;
  assert.deepEqual(again, { ...changed, fontSize: 8, maxMessages: 200 });
  assert.deepEqual(await f.ok('GET', ROUTE), [again]);
});

test('peticiones inválidas responden 400 en español sin cambiar bytes ni contadores', async t => {
  const f = await fixture(t);
  const variant = (await f.ok('POST', ROUTE, { name: 'Válida' })).variant;
  const before = await f.snapshot();
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: null }, { name: 3 }, [], null]) {
    const result = await f.request('POST', ROUTE, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.body.error, /nombre|objeto/i);
    await f.unchanged(before);
  }
  const bad = [
    [{ name: '' }, /nombre/i], [{ name: null }, /nombre/i],
    [{ layout: 'diagonal' }, /layout.*vertical.*horizontal/i], [{ layout: null }, /layout/i],
    [{ maxMessages: 0 }, /maxMessages.*1/i], [{ maxMessages: 201 }, /maxMessages.*200/i],
    [{ fontSize: 7 }, /fontSize.*8/i], [{ fadeAfterSec: 601 }, /fadeAfterSec.*600/i],
    [{ platforms: ['kick'] }, /platforms.*twitch.*youtube/i], [{ platforms: null }, /platforms/i],
    [{ animIn: 'spin' }, /animIn/i], [{ animOut: 'spin' }, /animOut/i],
    [{ reverse: 'sí' }, /reverse/i], [{ css: 3 }, /css/i], [[], /objeto/i], [null, /objeto/i],
  ];
  for (const [body, message] of bad) {
    const result = await f.request('PUT', `${ROUTE}/${variant.id}`, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.match(result.body.error, message);
    await f.unchanged(before);
  }
});

test('variante inexistente y default no se pueden editar ni borrar', async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  for (const [method, id, body] of [['PUT', 'no-existe', { name: 'X' }], ['DELETE', 'no-existe'], ['DELETE', 'default']]) {
    const result = await f.request(method, `${ROUTE}/${id}`, body);
    assert.ok(result.status === 404 || (id === 'default' && result.status === 400));
    assert.match(result.body.error, /no existe|predeterminad|default/i);
    await f.unchanged(before);
  }
});

test('default no se puede introducir mediante PUT /api/widgets ni borrar', async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', ROUTE, { name: 'Copia' })).variant;
  const before = await f.snapshot();
  const insert = await f.request('PUT', '/api/widgets', { chatVariants: [{ ...v, id: 'default' }] });
  assert.equal(insert.status, 400);
  assert.match(insert.body.error, /default|predeterminad/i);
  await f.unchanged(before);
  const result = await f.request('DELETE', `${ROUTE}/default`);
  assert.ok(result.status === 400 || result.status === 404);
  assert.match(result.body.error, /predeterminad|default/i);
  await f.unchanged(before);
});

test('crear rechaza una configuración predeterminada inválida antes de guardar', async t => {
  const f = await fixture(t);
  await f.ok('PUT', '/api/widgets', { chat: { animIn: 'inexistente' } });
  const before = await f.snapshot();
  const result = await f.request('POST', ROUTE, { name: 'Inválida' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /animIn/i);
  await f.unchanged(before);
});

test('GET lista en orden y DELETE elimina solo la variante elegida', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.ok('GET', ROUTE), []);
  const a = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  const b = (await f.ok('POST', ROUTE, { name: 'Segunda' })).variant;
  assert.deepEqual(await f.ok('GET', ROUTE), [a, b]);
  await f.ok('DELETE', `${ROUTE}/${a.id}`);
  assert.deepEqual(await f.ok('GET', ROUTE), [b]);
});

test('fuentes conserva exactamente el chat existente y añade una URL por variante', async t => {
  const f = await fixture(t);
  const before = await f.ok('GET', '/api/sources');
  const chat = { id: 'chat', name: 'Chat en pantalla', path: '/widget/chat', width: 600, height: 900, url: `${f.base}/widget/chat` };
  assert.deepEqual(before.sources.find(s => s.id === 'chat'), chat);
  const a = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  const b = (await f.ok('POST', ROUTE, { name: 'Segunda' })).variant;
  const after = await f.ok('GET', '/api/sources');
  assert.deepEqual(after.sources.find(s => s.id === 'chat'), chat);
  for (const v of [a, b]) {
    const source = after.sources.find(s => s.path === `/widget/chat?variant=${v.id}`);
    assert.ok(source);
    assert.match(source.name, new RegExp(v.name));
    assert.equal(source.url, `${f.base}/widget/chat?variant=${v.id}`);
  }
  assert.deepEqual(after.sources.filter(s => !s.path.includes('?variant=')), before.sources);
  assert.deepEqual(after.panels, before.panels);
});

test('cada escritura emite widgets al panel y a las capas', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const panel = await stream(f.base, t, 'panel');
  const widget = await stream(f.base, t, 'widget');
  const variant = (await f.ok('POST', ROUTE, { name: 'En vivo' })).variant;
  for (const next of [panel, widget]) assert.equal((await next(d => d.widgets.chatVariants?.some(v => v.id === variant.id))).widgets.chatVariants[0].name, 'En vivo');
  await f.ok('PUT', `${ROUTE}/${variant.id}`, { layout: 'horizontal' });
  for (const next of [panel, widget]) assert.equal((await next(d => d.widgets.chatVariants?.[0]?.layout === 'horizontal')).widgets.chatVariants[0].id, variant.id);
  await f.ok('DELETE', `${ROUTE}/${variant.id}`);
  for (const next of [panel, widget]) assert.deepEqual((await next(d => d.widgets.chatVariants?.length === 0)).widgets.chatVariants, []);
});

test('las escrituras de config genéricas aplican el esquema de variantes', async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', ROUTE, { name: 'Esquema' })).variant;
  const before = await f.snapshot();
  for (const [method, url, body] of [
    ['PUT', '/api/config', { widgets: { chatVariants: 'no-lista' } }],
    ['PUT', '/api/config', { widgets: { chatVariants: [{ ...v, layout: 'diagonal' }] } }],
    ['POST', '/api/config/set', { path: 'widgets.chatVariants.0.maxMessages', value: 0 }],
    ['POST', '/api/config/set', { path: 'widgets.chat.layout', value: 'diagonal' }],
  ]) {
    const result = await f.request(method, url, body);
    assert.equal(result.status, 400, `${method} ${url}`);
    assert.match(result.body.error, /chatVariants|layout/);
    await f.unchanged(before);
  }
});

// Las tres vías genéricas no pueden aceptar listas incompletas ni eludir la identidad del chat.
for (const [label, method, endpoint, wrap] of [
  ['widgets', 'PUT', '/api/widgets', value => ({ chatVariants: value })],
  ['config', 'PUT', '/api/config', value => ({ widgets: { chatVariants: value } })],
  ['config/set lista', 'POST', '/api/config/set', value => ({ path: 'widgets.chatVariants', value })],
  ['config/set sección', 'POST', '/api/config/set', value => ({ path: 'widgets', value: { chatVariants: value } })],
]) {
  for (const [description, invalid] of [
    ['lista nula', () => null], ['lista no es array', () => ({})],
    ['elemento nulo', () => [null]], ['elemento incompleto', v => [{ id: v.id, name: v.name }]],
    ['id ausente', v => [{ ...v, id: null }]], ['id reservado', v => [{ ...v, id: 'default' }]],
    ['id no es slug', v => [{ ...v, id: 'ID/inválido' }]],
    ['id duplicado', v => [v, { ...v, name: 'Otro' }]],
    ['nombre vacío', v => [{ ...v, name: '   ' }]], ['nombre sin recortar', v => [{ ...v, name: ' Con espacio ' }]],
    ['campo nulo', v => [{ ...v, layout: null }]], ['enum inválido', v => [{ ...v, layout: 'diagonal' }]],
    ['rango inválido', v => [{ ...v, maxMessages: 201 }]],
    ['cambiar id al renombrar', v => [{ ...v, id: 'nuevo', name: 'Nuevo' }]],
    ['crear sin slug del nombre', v => [v, { ...v, id: 'otro', name: 'Segunda' }]],
    ['crear sin copiar el predeterminado', v => [v, { ...v, id: 'segunda', name: 'Segunda', fontSize: 50 }]],
  ]) {
    test(`${label}: rechaza ${description} sin mutar`, async t => {
      const f = await fixture(t);
      const v = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
      const before = await f.snapshot();
      const result = await f.request(method, endpoint, wrap(invalid(v)));
      assert.equal(result.status, 400, `${label}: ${description}`);
      assert.match(result.body.error, /variante|chatVariants|nombre|layout|maxMessages|id|lista/i);
      await f.unchanged(before);
    });
  }
}

for (const [field, value] of [
  ['id', 'nuevo'], ['id', 'default'], ['id', 'otro/slug'], ['name', ''], ['name', '  Espacios  '],
  ['layout', null], ['layout', 'diagonal'], ['maxMessages', 0], ['platforms', ['kick']],
  ['', { id: 'primera', name: 'Incompleta' }],
]) {
  test(`config/set rechaza cambiar ${field || 'el elemento'} inválidamente`, async t => {
    const f = await fixture(t);
    const v = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
    const before = await f.snapshot();
    const result = await f.request('POST', '/api/config/set', { path: `widgets.chatVariants.0${field ? '.' + field : ''}`, value });
    assert.equal(result.status, 400, field);
    assert.match(result.body.error, /variante|chatVariants|nombre|layout|maxMessages|platforms|id/i);
    await f.unchanged(before);
    assert.deepEqual(await f.ok('GET', ROUTE), [v]);
  });
}

test('config/set no puede borrar un campo requerido ni crear un elemento incompleto', async t => {
  const f = await fixture(t);
  await f.ok('POST', ROUTE, { name: 'Primera' });
  const before = await f.snapshot();
  for (const body of [
    { path: 'widgets.chatVariants.0.name' },
    { path: 'widgets.chatVariants.0.id' },
    { path: 'widgets.chatVariants.0.css' },
    { path: 'widgets.chatVariants.1.name', value: 'Incompleta' },
    { path: 'widgets.chatVariants.0.platforms.0', value: 'kick' },
  ]) {
    const result = await f.request('POST', '/api/config/set', body);
    assert.equal(result.status, 400, body.path);
    assert.match(result.body.error, /variante|chatVariants|nombre|css|platforms|id/i);
    await f.unchanged(before);
  }
});

test('config/set conserva la normalización existente de claves del prototipo en variantes válidas', async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  const value = JSON.parse(JSON.stringify(v).replace(/}$/, ',"__proto__":{"polluted":true}}'));
  const result = await f.request('POST', '/api/config/set', { path: 'widgets.chatVariants.0', value });
  assert.equal(result.status, 200);
  assert.deepEqual(await f.ok('GET', ROUTE), [v]);
  assert.equal(({}).polluted, undefined);
});

test('config genérica puede añadir una copia completa y después editarla independientemente', async t => {
  const f = await fixture(t);
  const chat = (await f.ok('GET', '/api/widgets')).widgets.chat;
  const variant = { ...chat, id: 'segunda', name: 'Segunda' };
  const created = await f.ok('PUT', '/api/config', { widgets: { chatVariants: [variant] } });
  assert.deepEqual(created.config.widgets.chatVariants, [variant]);
  await f.ok('POST', '/api/config/set', { path: 'widgets.chatVariants.0.fontSize', value: 32 });
  await f.ok('PUT', '/api/widgets', { chat: { fontSize: 21 } });
  assert.equal((await f.ok('GET', ROUTE))[0].fontSize, 32);
});

test('las tres vías genéricas conservan escrituras válidas y los cambios de hermanos', async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  const widgets = await f.ok('PUT', '/api/widgets', { chat: { fontSize: 35 }, chatVariants: [{ ...v, css: 'uno' }] });
  assert.equal(widgets.widgets.chat.fontSize, 35);
  assert.equal(widgets.widgets.chatVariants[0].css, 'uno');
  const config = await f.ok('PUT', '/api/config', { overlay: { queueMax: 3 }, widgets: { chatVariants: [{ ...v, css: 'dos' }] } });
  assert.equal(config.config.overlay.queueMax, 3);
  assert.equal(config.config.widgets.chatVariants[0].css, 'dos');
  const set = await f.ok('POST', '/api/config/set', { path: 'widgets.chatVariants.0.name', value: 'Renombrada' });
  assert.equal(set.value, 'Renombrada');
  assert.equal((await f.ok('GET', ROUTE))[0].id, v.id);
  await f.ok('POST', '/api/config/set', { path: 'widgets.goals.0.title', value: 'Meta' });
  assert.equal((await f.ok('GET', '/api/config')).widgets.goals[0].title, 'Meta');
});

test('rechazos genéricos no emiten widgets ni persistencia', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  // La notificación agrupada de la creación termina antes de abrir el observador.
  await new Promise(resolve => setTimeout(resolve, 300));
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const response = await fetch(`${f.base}/api/stream?client=panel`, { signal: ctrl.signal });
  assert.equal(response.status, 200);
  const events = [];
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const reading = (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          if (event) events.push(event);
        }
      }
    } catch { /* cierre del observador */ }
  })();
  await new Promise(resolve => setTimeout(resolve, 50));
  const start = events.length;
  const before = await f.snapshot();
  for (const [method, endpoint, body] of [
    ['PUT', '/api/widgets', { chatVariants: [{ ...v, id: 'default' }] }],
    ['PUT', '/api/config', { widgets: { chatVariants: [{ ...v, name: '' }] } }],
    ['POST', '/api/config/set', { path: 'widgets.chatVariants.0.css', value: null }],
  ]) {
    const result = await f.request(method, endpoint, body);
    assert.equal(result.status, 400);
    await f.unchanged(before);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(events.slice(start).filter(e => e === 'widgets' || e === 'persistence'), []);
  ctrl.abort(); await reading;
});

test('las escrituras sobre widgets conservan el merge y el reemplazo legacy sin validar variantes omitidas', async t => {
  const f = await fixture(t);
  const v = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  const merged = await f.ok('PUT', '/api/config', { widgets: { chat: { fontSize: 33 } } });
  assert.deepEqual(merged.config.widgets.chatVariants, [v]);
  assert.equal(merged.config.widgets.chat.fontSize, 33);
  const replacement = { chat: { css: '.legacy{}' } };
  const set = await f.ok('POST', '/api/config/set', { path: 'widgets', value: replacement });
  assert.deepEqual(set.value, replacement);
  assert.deepEqual((await f.ok('GET', '/api/config')).widgets, replacement);
});

test('borrar la lista restaura [] y widgets:null conserva su valor literal legacy', async t => {
  const f = await fixture(t);
  await f.ok('POST', ROUTE, { name: 'Primera' });
  const deleted = await f.ok('POST', '/api/config/set', { path: 'widgets.chatVariants' });
  assert.deepEqual(deleted.value, []);
  assert.deepEqual(await f.ok('GET', ROUTE), []);
  const put = await f.ok('PUT', '/api/config', { widgets: null });
  assert.equal(put.config.widgets, null);
  assert.equal((await f.ok('GET', '/api/config')).widgets, null);
});

async function observeEvents(base, t, client) {
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const response = await fetch(`${base}/api/stream?client=${client}`, { signal: ctrl.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i); buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    } catch { /* cierre del observador */ }
  })();
  return {
    events,
    async waitSince(start, predicate) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = events.slice(start).find(predicate);
        if (found) return found;
        if (Date.now() >= deadline) throw new Error('No llegó el evento SSE esperado');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
  };
}

test('composite variantes y overlays valida antes de una sola escritura y conserva eventos', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const variant = (await f.ok('POST', ROUTE, { name: 'Primera' })).variant;
  const a = (await f.ok('POST', '/api/custom-overlays', { name: 'Marco', css: 'antes', requestedPermissions: ['scene', 'chat'] })).overlay;
  const b = (await f.ok('POST', '/api/custom-overlays', { name: 'Otro', css: 'igual' })).overlay;
  const approval = await f.request('PUT', `/api/custom-overlays/${a.id}/permissions`, { permissions: ['scene'] }, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(approval.status, 200);
  const approved = approval.body.overlay;
  const panel = await observeEvents(f.base, t, 'panel');
  const widget = await observeEvents(f.base, t, 'widget');
  // El evento inicial confirma que el widget está suscrito antes de enviar el parche.
  await widget.waitSince(0, e => e.event === 'customOverlayVersions' && e.data[a.id]);
  const panelStart = panel.events.length, widgetStart = widget.events.length;
  const changedVariant = { ...variant, css: '.nuevo{}' };
  const changedOverlay = { ...approved, name: '  Marco nuevo  ', css: 'después', requestedPermissions: ['chat', 'scene', 'chat'], permissions: ['chat'], approvedAt: 0, approvedUpdatedAt: 0 };
  const result = await f.request('PUT', '/api/config', { widgets: { chatVariants: [changedVariant] }, customOverlays: [changedOverlay, b] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [actual, untouched] = result.body.config.customOverlays;
  assert.equal(actual.name, 'Marco nuevo');
  assert.deepEqual(actual.requestedPermissions, ['scene', 'chat']);
  assert.deepEqual(actual.permissions, ['scene']);
  assert.equal(actual.approvedAt, approved.approvedAt);
  assert.equal(actual.approvedUpdatedAt, approved.approvedUpdatedAt);
  assert.ok(actual.updatedAt > approved.updatedAt);
  assert.deepEqual(untouched, b);
  assert.deepEqual(result.body.config.widgets.chatVariants, [changedVariant]);
  await panel.waitSince(panelStart, e => e.event === 'customOverlays' && e.data[0]?.css === 'después');
  await widget.waitSince(widgetStart, e => e.event === 'customOverlayVersions' && e.data[a.id] === actual.updatedAt);
  await widget.waitSince(widgetStart, e => e.event === 'widgets' && e.data.widgets.chatVariants?.[0]?.css === '.nuevo{}');
  const pending = panel.events.slice(panelStart).filter(e => e.event === 'persistence').map(e => e.data.pending.config);
  assert.deepEqual(pending, [1, 0], 'el parche compuesto se persiste en una sola escritura');
  assert.equal(panel.events.slice(panelStart).filter(e => e.event === 'customOverlays' && e.data[0]?.css === 'después').length, 2, 'conserva ambas notificaciones existentes');

  const before = await f.snapshot();
  const beforeOverlays = await f.ok('GET', '/api/custom-overlays');
  const rejectedStart = panel.events.length;
  for (const body of [
    { widgets: { chatVariants: [{ ...changedVariant, id: 'default' }] }, customOverlays: [{ ...actual, css: 'no-guardar' }, b] },
    { widgets: { chatVariants: [{ ...changedVariant, css: 'no-guardar' }] }, customOverlays: [{ ...actual, width: 1 }, b] },
  ]) {
    const rejected = await f.request('PUT', '/api/config', body);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /variante|chatVariants|id|ancho|16/i);
    await f.unchanged(before);
    assert.deepEqual(await f.ok('GET', '/api/custom-overlays'), beforeOverlays);
  }
  // Abrir otro panel provoca un status en el primer stream: barrera pública sin sleeps.
  const sentinel = await observeEvents(f.base, t, 'panel');
  await sentinel.waitSince(0, e => e.event === 'status');
  await panel.waitSince(rejectedStart, e => e.event === 'status');
  assert.deepEqual(panel.events.slice(rejectedStart).filter(e => ['widgets', 'customOverlays', 'persistence'].includes(e.event)), []);
});

async function watchRejections(t, f) {
  // Dejar salir cualquier envío agrupado de las escrituras de preparación.
  await new Promise(resolve => setTimeout(resolve, 200));
  const panel = await observeEvents(f.base, t, 'panel');
  const widget = await observeEvents(f.base, t, 'widget');
  await widget.waitSince(0, e => e.event === 'widgets');
  const p = panel.events.length, w = widget.events.length;
  return async () => {
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.deepEqual(panel.events.slice(p).filter(e => ['widgets', 'persistence'].includes(e.event)), []);
    assert.deepEqual(widget.events.slice(w).filter(e => e.event === 'widgets'), []);
  };
}

function mcpProtocol(child) {
  const lines = createInterface({ input: child.stdout });
  let stderr = '', id = 0, ended = null, childError = null, stdinError = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { childError = error; });
  child.stdin.on('error', error => { stdinError = error; });
  // close llega después de drenar stderr, incluso cuando spawn falla.
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    ended = { code, signal };
    resolve({ code, signal, stderr, childError, stdinError });
  }));
  const failure = () => new Error(`MCP se cerró antes de responder: code=${ended.code}, signal=${ended.signal}, error=${childError?.message || 'none'}, stdin=${stdinError?.message || 'none'}, stderr=${stderr}`);
  const nextLine = () => new Promise((resolve, reject) => {
    if (ended) return reject(failure());
    const cleanup = () => { lines.removeListener('line', onLine); child.removeListener('close', onClose); };
    const onLine = line => { cleanup(); resolve(line); };
    const onClose = () => { cleanup(); reject(failure()); };
    lines.once('line', onLine);
    child.once('close', onClose);
  });
  return {
    closed,
    async call(name, args) {
      if (ended) throw failure();
      const response = nextLine();
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      return JSON.parse(await response).result;
    },
  };
}

async function mcpClient(t, base, entry = new URL('../src/mcp.mjs', import.meta.url)) {
  const child = spawn(process.execPath, [fileURLToPath(entry)], {
    env: { PATH: process.env.PATH || '', ANTENA_URL: base, ANTENA_NO_EMBED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = mcpProtocol(child);
  t.after(async () => {
    child.stdin.end();
    const { code, signal, stderr, childError, stdinError } = await rpc.closed;
    assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, '');
    assert.equal(childError, null); assert.equal(stdinError, null);
  });
  return rpc.call;
}

test('MCP fixture informa al cerrar o fallar el hijo antes de responder', async t => {
  for (const [command, args, expected] of [
    [process.execPath, [fileURLToPath(new URL('./mcp-fixture-entrada-inexistente.mjs', import.meta.url))], /MODULE_NOT_FOUND/],
    [process.execPath + '.mcp-fixture-inexistente', [], /ENOENT/],
  ]) {
    const child = spawn(command, args, { env: { PATH: process.env.PATH || '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const rpc = mcpProtocol(child);
    t.after(async () => { child.stdin.end(); await rpc.closed; });
    const reply = rpc.call('ver_widgets', {}).then(() => null, error => error);
    // No depende de un timeout: al siguiente turno tras close ya debe haber fallado.
    const failure = await Promise.race([reply, rpc.closed.then(() => new Promise(resolve => setImmediate(() => resolve(null))))]);
    assert.ok(failure instanceof Error, 'el cierre debe rechazar la respuesta pendiente');
    assert.match(failure.message, /code=.*signal=null/);
    assert.match(failure.message, /stderr=/);
    assert.match(failure.message, expected);
    await assert.rejects(rpc.call('ver_widgets', {}), expected, 'también falla si el hijo ya se cerró');
  }
});

test('B1: PUT widgets rechaza layout predeterminado inválido sin guardar ni emitir', async t => {
  const f = await fixture(t);
  const quiet = await watchRejections(t, f);
  const before = await f.snapshot();
  for (const layout of ['diagonal', null, 7, false]) {
    const result = await f.request('PUT', '/api/widgets', { chat: { layout, css: 'no-guardar' } });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /widgets\.chat\.layout.*vertical.*horizontal/i);
    await f.unchanged(before);
  }
  await quiet();
  // La nueva validación no endurece las otras hojas de la ruta legacy.
  const valid = await f.ok('PUT', '/api/widgets', { chat: { layout: 'horizontal', maxMessages: 'legacy' } });
  assert.equal(valid.widgets.chat.layout, 'horizontal');
  assert.equal(valid.widgets.chat.maxMessages, 'legacy');
});

test('B1: MCP editar_widget rechaza layout inválido sin guardar ni emitir', { timeout: 20000 }, async t => {
  const f = await fixture(t), rpc = await mcpClient(t, f.base);
  const quiet = await watchRejections(t, f);
  const before = await f.snapshot();
  const rejected = await rpc('editar_widget', { widget: 'chat', cambios: { layout: 'diagonal-mcp', css: 'no-guardar' } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Error: widgets\.chat\.layout.*vertical.*horizontal/i);
  await f.unchanged(before);
  await quiet();
  const valid = await rpc('editar_widget', { widget: 'chat', cambios: { layout: 'horizontal' } });
  assert.equal(valid.isError, undefined);
  assert.equal(JSON.parse(valid.content[0].text).widgets.chat.layout, 'horizontal');
});

test('B2: POST rechaza valores explícitos que contradicen la copia predeterminada', async t => {
  const f = await fixture(t);
  const quiet = await watchRejections(t, f);
  const before = await f.snapshot();
  for (const extra of [{ layout: 'horizontal' }, { layout: 'diagonal' }, { fontSize: 31 }, { platforms: ['youtube'] }, { css: 'otro' }, { id: 'otro' }]) {
    const result = await f.request('POST', ROUTE, { name: 'Ejemplo', ...extra });
    assert.equal(result.status, 400, JSON.stringify(extra));
    assert.match(result.body.error, /variante|predeterminad|copi|id/i);
    await f.unchanged(before);
  }
  await quiet();
  const created = (await f.ok('POST', ROUTE, { name: 'Ejemplo', id: 'ejemplo', layout: 'vertical', platforms: ['twitch', 'youtube'] })).variant;
  assert.equal(created.id, 'ejemplo'); assert.equal(created.layout, 'vertical');
  assert.deepEqual(created.platforms, ['twitch', 'youtube']);
});

test('B2: PUT rechaza cambiar el id, incluso al renombrar', async t => {
  const f = await fixture(t);
  const original = (await f.ok('POST', ROUTE, { name: 'Ejemplo' })).variant;
  const quiet = await watchRejections(t, f);
  const before = await f.snapshot();
  for (const id of ['otro', null]) {
    const result = await f.request('PUT', `${ROUTE}/${original.id}`, { id, name: 'Renombrado' });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /id.*cambiar|id.*variante/i);
    await f.unchanged(before);
  }
  await quiet();
  const changed = (await f.ok('PUT', `${ROUTE}/${original.id}`, { id: original.id, name: 'Renombrado', layout: 'horizontal' })).variant;
  assert.equal(changed.id, original.id); assert.equal(changed.name, 'Renombrado'); assert.equal(changed.layout, 'horizontal');
});

for (const [action, withValue] of [['borrar', false], ['escribir', true]]) {
  test(`B3: config/set no puede ${action} por índice no numérico de variantes`, async t => {
    const f = await fixture(t);
    const uno = (await f.ok('POST', ROUTE, { name: 'Uno' })).variant;
    const dos = (await f.ok('POST', ROUTE, { name: 'Dos' })).variant;
    const quiet = await watchRejections(t, f);
    const before = await f.snapshot();
    for (const suffix of ['foo', '-1', '01', 'length', '0.platforms.foo']) {
      const body = { path: `widgets.chatVariants.${suffix}`, ...(withValue && { value: 'no-guardar' }) };
      const result = await f.request('POST', '/api/config/set', body);
      assert.equal(result.status, 400, suffix);
      assert.match(result.body.error, /índice|lista|subcampos|variantes|chatVariants/i);
      await f.unchanged(before);
      assert.deepEqual(await f.ok('GET', ROUTE), [uno, dos]);
    }
    await quiet();
    if (withValue) {
      await f.ok('POST', '/api/config/set', { path: 'widgets.chatVariants.0.layout', value: 'horizontal' });
      assert.equal((await f.ok('GET', ROUTE))[0].layout, 'horizontal');
    } else {
      await f.ok('POST', '/api/config/set', { path: 'widgets.chatVariants.1' });
      assert.deepEqual(await f.ok('GET', ROUTE), [uno]);
    }
  });
}

test('MCP ver_widgets conserva las URLs anteriores y expone las de cada variante', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.ok('POST', '/api/config/set', { path: 'port', value: f.port });
  const variants = [];
  for (const name of ['Vertical', 'Horizontal']) variants.push((await f.ok('POST', ROUTE, { name })).variant);
  // El mismo MCP real desde una ruta URI con espacios y caracteres no ASCII.
  const dir = await mkdtemp(path.join(tmpdir(), 'antena-mcp á espacio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'src'));
  await Promise.all([
    copyFile(new URL('../package.json', import.meta.url), path.join(dir, 'package.json')),
    ...['mcp.mjs', 'custom-overlays.mjs', 'http-util.mjs', 'meld.mjs'].map(file => copyFile(new URL(`../src/${file}`, import.meta.url), path.join(dir, 'src', file))),
  ]);
  for (const entry of [undefined, pathToFileURL(path.join(dir, 'src', 'mcp.mjs'))]) {
    const rpc = await mcpClient(t, f.base, entry);
    const result = await rpc('ver_widgets', {});
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual({ ...data.urls, chatVariantes: undefined }, {
      chat: `${f.base}/widget/chat`, objetivo: `${f.base}/widget/goal?id=<id>`, ultimos: `${f.base}/widget/latest`,
      ticker: `${f.base}/widget/ticker`, creditos: `${f.base}/widget/credits`, espectadores: `${f.base}/widget/viewers`, agradecimientos: `${f.base}/widget/thanks`, chatVariantes: undefined,
    });
    assert.deepEqual(data.urls.chatVariantes, variants.map(v => ({ id: v.id, nombre: v.name, url: `${f.base}/widget/chat?variant=${v.id}` })));
  }
});
