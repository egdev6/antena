// POST /api/config/set (MCP fijar_valor / borrar_valor): la ruta con puntos nunca toca el prototipo,
// no baja por debajo de un valor simple y una sección entera se valida igual que en PUT /api/config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'egdev-config-set-'));
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };
  const set = (p, value) => call('POST', '/api/config/set', value === undefined ? { path: p } : { path: p, value });
  const config = async () => (await call('GET', '/api/config')).body;
  const saved = () => readFile(path.join(dataDir, 'config.json'), 'utf8').catch(() => '');
  const stop = async () => {
    app.teleprompter.stop(); app.viewers.stop(); app.meld.stop();
    app.server.closeAllConnections();
    await new Promise(r => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  };
  return { set, call, config, saved, stop };
}

test('config/set rechaza un índice de lista mayor que su longitud (sin agujeros)', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.set('filters.blockedWords', ['a', 'b'])).status, 200);
    const antes = await f.config();
    const jsonAntes = await f.saved();
    // índice 99 > longitud 2: hoy deja agujeros null en la lista
    const res = await f.set('filters.blockedWords.99', 'x');
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /filters\.blockedWords\.99/, 'el mensaje nombra la ruta');
    assert.match(res.body.error, /se sale de la lista/);
    assert.deepEqual((await f.config()).filters.blockedWords, ['a', 'b'], 'la lista no cambia');
    await sinCambios(f, antes, jsonAntes, 'índice fuera de rango');
    // listas de objetos: mismo límite al escribir un elemento entero
    const elem = await f.call('POST', '/api/config/set', { path: 'commands.99', value: { id: 'x', trigger: '!x' } });
    assert.equal(elem.status, 400, JSON.stringify(elem.body));
    assert.match(elem.body.error, /se sale de la lista/);
    assert.deepEqual((await f.config()).commands, [], 'commands no cambia');
    // borrar un índice que no existe tampoco pasa
    const borrar = await f.set('filters.blockedWords.99');
    assert.equal(borrar.status, 400, JSON.stringify(borrar.body));
    // el índice igual a la longitud añade al final, y uno existente se sobrescribe
    assert.equal((await f.set('filters.blockedWords.2', 'c')).status, 200);
    assert.deepEqual((await f.config()).filters.blockedWords, ['a', 'b', 'c']);
    assert.equal((await f.set('filters.blockedWords.1', 'B')).status, 200);
    assert.deepEqual((await f.config()).filters.blockedWords, ['a', 'B', 'c']);
  } finally { await f.stop(); }
});

test('config/set rechaza un índice fuera de rango en cualquier tramo, sin mutar nada', async () => {
  const f = await fixture();
  try {
    const antes = await f.config();
    const jsonAntes = await f.saved();
    // índice intermedio: goals.9.target con una sola meta dejaba goals[9]={} y agujeros 1..8
    const res = await f.set('widgets.goals.9.target', 5);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /widgets\.goals\.9/);
    assert.match(res.body.error, /se sale de la lista/);
    await sinCambios(f, antes, jsonAntes, 'índice intermedio');
    // append en el primer índice libre sigue valiendo en un tramo intermedio
    assert.equal((await f.set('widgets.goals.1.title', 'segunda')).status, 200);
    assert.equal((await f.config()).widgets.goals.length, 2);
  } finally { await f.stop(); }
});

test('borrar por ruta una hoja o sección del esquema deja su valor por defecto al momento', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.set('port', 5000)).status, 200);
    assert.equal((await f.set('tts.rate', 2)).status, 200);
    const r = await f.set('port');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await f.config()).port, 4500, 'port vuelve a su default al momento');
    assert.equal(JSON.parse(await f.saved()).port, 4500, 'config.json guarda el default');
    const sec = await f.set('tts');
    assert.equal(sec.status, 200, JSON.stringify(sec.body));
    assert.equal((await f.config()).tts.rate, 1, 'la sección entera vuelve a su default');
    assert.equal((await f.config()).tts.enabled, true);
    // una ruta sin esquema sigue borrándose de verdad
    assert.equal((await f.set('extra.nuevo', 'x')).status, 200);
    assert.equal((await f.set('extra')).status, 200);
    assert.equal((await f.config()).extra, undefined);
  } finally { await f.stop(); }
});

test('config/set avisa en el registro cuando el valor trae claves del prototipo', async () => {
  const f = await fixture();
  try {
    const avisos = [];
    const originalWarn = console.warn;
    console.warn = (...a) => avisos.push(a.join(' '));
    let res;
    try {
      const overlay = JSON.parse('{"queueMax":20,"__proto__":{"polluted":1},"extra":{"constructor":{"polluted":1}}}');
      res = await f.set('overlay', overlay);
    } finally { console.warn = originalWarn; }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(({}).polluted, undefined, 'Object.prototype intacto');
    assert.equal(avisos.filter(a => a.includes('overlay')).length, 1, 'un aviso que nombra la ruta');
    assert.match(avisos.find(a => a.includes('overlay')), /__proto__|prototipo/);
    const saved = JSON.parse(await f.saved());
    assert.equal(Object.hasOwn(saved.overlay, '__proto__'), false);
  } finally { delete Object.prototype.polluted; await f.stop(); }
});

test('GET /api/config?path= con claves del prototipo responde 200 y value undefined', async () => {
  const f = await fixture();
  try {
    for (const ruta of ['__proto__.polluted', 'constructor', 'theme.__proto__', '__proto__', 'overlay.constructor.x']) {
      const r = await f.call('GET', `/api/config?path=${encodeURIComponent(ruta)}`);
      assert.equal(r.status, 200, ruta);
      assert.equal(r.body.value, undefined, ruta);
      assert.equal(r.body.path, ruta);
    }
  } finally { await f.stop(); }
});

/** Comprueba que una escritura rechazada no cambió nada. */
async function sinCambios({ config, saved }, antes, jsonAntes, motivo) {
  assert.deepEqual(await config(), antes, `${motivo}: la configuración no cambia`);
  assert.equal(await saved(), jsonAntes, `${motivo}: config.json no cambia`);
}

test('config/set rechaza claves del prototipo en cualquier tramo de la ruta, sin contaminar nada', async () => {
  const f = await fixture();
  try {
    const antes = await f.config();
    const jsonAntes = await f.saved();
    const rutas = ['__proto__.polluted', 'constructor.prototype.polluted', 'overlay.__proto__.polluted',
      'alerts.follow.constructor', 'widgets.prototype', '__proto__'];
    for (const ruta of rutas) {
      const res = await f.set(ruta, 1);
      assert.equal(res.status, 400, `${ruta}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /no válida/, ruta);
      assert.equal(({}).polluted, undefined, `${ruta}: Object.prototype intacto`);
      const borrar = await f.set(ruta);
      assert.equal(borrar.status, 400, `borrar ${ruta}`);
    }
    await sinCambios(f, antes, jsonAntes, 'prototipo');
    assert.equal(Object.hasOwn(await f.config(), 'constructor'), false);
  } finally { delete Object.prototype.polluted; await f.stop(); }
});

test('config/set no escribe ni borra por debajo de un valor simple', async () => {
  const f = await fixture();
  try {
    const antes = await f.config();
    const jsonAntes = await f.saved();
    for (const [ruta, value] of [['port.x', 1], ['overlay.css.x', 'a'], ['overlay.queueMax.0', 1], ['tts.enabled.x', true], ['port.x', undefined]]) {
      const res = await f.set(ruta, value);
      assert.equal(res.status, 400, `${ruta}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, /no admite subcampos/, ruta);
    }
    await sinCambios(f, antes, jsonAntes, 'subcampos');
    assert.equal(typeof (await f.config()).port, 'number');
  } finally { await f.stop(); }
});

test('config/set sobre una sección entera valida como PUT /api/config', async () => {
  const f = await fixture();
  try {
    const antes = await f.config();
    const jsonAntes = await f.saved();
    const put = await f.call('PUT', '/api/config', { overlay: { queueMax: 'x' } });
    assert.equal(put.status, 400);
    for (const [ruta, value, motivo] of [
      ['overlay', { queueMax: 'x' }, /overlay\.queueMax: se esperaba un número/],
      ['overlay', 'texto', /overlay: se esperaba un objeto/],
      ['tts', { rate: 9 }, /tts\.rate: el valor máximo es 2/],
    ]) {
      const res = await f.set(ruta, value);
      assert.equal(res.status, 400, `${ruta}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, motivo, ruta);
    }
    await sinCambios(f, antes, jsonAntes, 'sección');
  } finally { await f.stop(); }
});

test('config/set sigue aceptando rutas válidas, rutas nuevas y borrados', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.set('overlay.queueMax', 10)).status, 200);
    assert.equal((await f.config()).overlay.queueMax, 10);
    assert.equal((await f.set('overlay.css', '.x{}')).status, 200);
    assert.equal((await f.set('overlay.css')).status, 200, 'borrar una hoja');
    assert.equal((await f.config()).overlay.css, '', 'borrar una hoja del esquema deja su default');
    const overlay = { ...(await f.config()).overlay, queueMax: 20 };
    assert.equal((await f.set('overlay', overlay)).status, 200, 'sección entera válida');
    assert.equal((await f.config()).overlay.queueMax, 20);
    assert.equal((await f.set('extra.nuevo', 'x')).status, 200, 'ruta sin esquema: se acepta');
    assert.equal((await f.config()).extra.nuevo, 'x');
    assert.equal((await f.set('extra')).status, 200, 'borrar una sección');
    // listas de textos: un elemento por índice se sigue escribiendo y borrando
    assert.equal((await f.set('filters.blockedWords', ['a', 'b'])).status, 200);
    assert.equal((await f.set('filters.blockedWords.0', 'z')).status, 200, 'escribir un elemento');
    assert.equal((await f.set('filters.blockedWords.0')).status, 200, 'borrar un elemento');
    assert.deepEqual((await f.config()).filters.blockedWords, ['b']);
    assert.equal((await f.set('filters.blockedWords.0', 5)).status, 400, 'un elemento tiene que ser texto');
    assert.equal((await f.set('filters.blockedWords.x', 'a')).status, 400, 'solo por índice');
  } finally { await f.stop(); }
});

test('config/set no guarda claves del prototipo que vengan dentro del valor', async () => {
  const f = await fixture();
  try {
    const overlay = JSON.parse(`{"queueMax":20,"__proto__":{"polluted":1},"extra":{"constructor":{"prototype":{"polluted":1}}}}`);
    assert.equal((await f.set('overlay', overlay)).status, 200);
    assert.equal(({}).polluted, undefined, 'Object.prototype intacto');
    const saved = JSON.parse(await f.saved());
    assert.equal(saved.overlay.queueMax, 20);
    assert.equal(Object.hasOwn(saved.overlay, '__proto__'), false, 'sin __proto__ propio en config.json');
    assert.deepEqual(saved.overlay.extra, {}, 'sin constructor propio en config.json');
  } finally { delete Object.prototype.polluted; await f.stop(); }
});
