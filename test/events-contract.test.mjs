// Test de contrato de eventos SSE (#72): servidor y consumidores deben usar solo
// eventos declarados en el contrato único (src/events.mjs), y ningún evento
// declarado puede quedarse muerto (sin emisor ni consumidor).
//
// Fuentes escaneadas:
// - Emisión: src/**/*.mjs (llamadas literales `bus.send('x', …)`), más los eventos
//   que el bus emite internamente sin pasar por bus.send (ver EVENTOS_INTERNOS).
// - Escuchas: app/src/**/*.ts(x) (`live.on('x', …)` y el helper `on('x', …)` de
//   live.ts), public/overlay.html (`es.addEventListener('x', …)`) y
//   public/widgets/*.html (claves del objeto pasado a `connect({ x: … })`).
//   El panel clásico (public/panel.js) y public/prompter.html se retiraron en #115:
//   todos los consumidores vivos (React, overlay y widgets) quedan cubiertos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_EVENTS, CLIENT_ONLY_EVENTS, REPLACEABLE_EVENTS, EPHEMERAL_EVENTS, warnUnknownClientEvent } from '../src/events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Eventos que el bus emite sin pasar por una llamada literal bus.send('x'):
// - 'alert': Bus.alert() hace this.send('alert', …) sin el prefijo "bus.".
// - 'gap': Bus.#saturate() escribe el marco de gap a mano.
const EVENTOS_INTERNOS = new Set(['alert', 'gap']);

// Eventos que escucha el cliente React sin llegar por el SSE del servidor: los declara el
// propio contrato (CLIENT_ONLY_EVENTS, p. ej. 'error' del Live) y aquí solo se consumen.

/** Lista recursiva de ficheros con extensión, ignorando node_modules y dist. */
function ficheros(dir, exts, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) ficheros(p, exts, acc);
    else if (exts.some(x => e.endsWith(x))) acc.push(p);
  }
  return acc;
}

const leer = p => readFileSync(p, 'utf8');
const unicos = a => [...new Set(a)].sort();

/** Emisiones del servidor: literales en bus.send('x', …) en src/*.mjs. */
function emisionesServidor() {
  const out = [];
  for (const p of ficheros(path.join(ROOT, 'src'), ['.mjs'])) {
    const m = leer(p).match(/\bbus\.send\(\s*'([A-Za-z0-9_]+)'/g) || [];
    for (const s of m) out.push(s.match(/'([A-Za-z0-9_]+)'/)[1]);
  }
  return unicos([...out, ...EVENTOS_INTERNOS]);
}

/** Escuchas de React: live.on('x'…) en app/src y helper on('x'…) de live.ts. */
function escuchasReact() {
  const out = [];
  for (const p of ficheros(path.join(ROOT, 'app', 'src'), ['.ts', '.tsx'])) {
    const src = leer(p);
    const pats = p.endsWith('live.ts')
      ? [/\blive\.on\(\s*'([A-Za-z0-9_]+)'/g, /\bon\(\s*'([A-Za-z0-9_]+)'/g]
      : [/\blive\.on\(\s*'([A-Za-z0-9_]+)'/g];
    for (const re of pats) for (const s of src.match(re) || []) out.push(s.match(/'([A-Za-z0-9_]+)'/)[1]);
  }
  return unicos(out);
}

/** Escuchas del overlay: es.addEventListener('x'…) sobre el EventSource de public/overlay.html. */
function escuchasOverlay() {
  const src = leer(path.join(ROOT, 'public', 'overlay.html'));
  const m = src.match(/\bes\.addEventListener\(\s*'([A-Za-z0-9_]+)'/g) || [];
  return unicos(m.map(s => s.match(/'([A-Za-z0-9_]+)'/)[1]));
}

/** Escuchas de los widgets: claves del objeto pasado a connect({ … }). */
function escuchasWidgets() {
  const out = [];
  for (const p of ficheros(path.join(ROOT, 'public', 'widgets'), ['.html'])) {
    const src = leer(p);
    for (const m of src.matchAll(/connect\(\s*\{/g)) {
      // Recorta el objeto literal hasta el cierre "})" y toma sus claves.
      let depth = 1, i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        if (src[i] === '}') depth--;
        i++;
      }
      const cuerpo = src.slice(m.index + m[0].length, i);
      // Solo claves al nivel superior del objeto (ignora objetos anidados dentro de
      // las funciones manejadoras, p. ej. apply({ …, metrics: … })).
      let d = 0;
      for (const k of cuerpo.matchAll(/([A-Za-z0-9_]+)\s*:/g)) {
        const antes = cuerpo.slice(0, k.index);
        d = (antes.match(/[{(]/g) || []).length - (antes.match(/[})]/g) || []).length;
        if (d === 0) out.push(k[1]);
      }
    }
  }
  return unicos(out);
}

test('REPLACEABLE_EVENTS y EPHEMERAL_EVENTS son disjuntos y su unión es ALL_EVENTS', () => {
  for (const e of REPLACEABLE_EVENTS) assert(!EPHEMERAL_EVENTS.has(e), `«${e}» está en los dos sets`);
  const union = unicos([...REPLACEABLE_EVENTS, ...EPHEMERAL_EVENTS]);
  assert.deepEqual(union, unicos([...ALL_EVENTS]), 'ALL_EVENTS debe ser exactamente la unión de ambos sets');
});

test('todo evento emitido por el servidor está declarado en el contrato', () => {
  const emitidos = emisionesServidor();
  assert.ok(emitidos.length > 0, 'el escaneo de emisiones no encontró nada: revisa las expresiones');
  const fuera = emitidos.filter(e => !ALL_EVENTS.has(e));
  assert.deepEqual(fuera, [], `eventos emitidos sin declarar en src/events.mjs: ${fuera.join(', ')}`);
});

test('todo evento escuchado (React, overlay y widgets) está declarado en el contrato', () => {
  const escuchados = unicos([...escuchasReact(), ...escuchasOverlay(), ...escuchasWidgets()]);
  assert.ok(escuchados.length > 0, 'el escaneo de escuchas no encontró nada: revisa las expresiones');
  const fuera = escuchados.filter(e => !ALL_EVENTS.has(e) && !CLIENT_ONLY_EVENTS.has(e));
  assert.deepEqual(fuera, [], `eventos escuchados sin declarar en src/events.mjs: ${fuera.join(', ')}`);
});

test('ningún evento declarado queda muerto: cada uno lo emite o lo escucha alguien', () => {
  const vivos = new Set([...emisionesServidor(), ...escuchasReact(), ...escuchasOverlay(), ...escuchasWidgets()]);
  const muertos = [...ALL_EVENTS].filter(e => !vivos.has(e));
  assert.deepEqual(muertos, [], `eventos declarados sin emisor ni consumidor: ${muertos.join(', ')}`);
});

test('warnUnknownClientEvent avisa una sola vez y solo por nombres sin declarar', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = m => warns.push(String(m));
  try {
    // Nombres declarados (SSE o solo-cliente): nunca avisan.
    assert.equal(warnUnknownClientEvent('chat'), false);
    assert.equal(warnUnknownClientEvent('error'), false);
    // Nombre sin declarar: avisa una vez y no repite.
    assert.equal(warnUnknownClientEvent('inventado'), true);
    assert.equal(warnUnknownClientEvent('inventado'), false);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /inventado/);
  } finally { console.warn = orig; }
});

test('live.ts usa el aviso del contrato en live.on y en el helper on de connect', () => {
  const src = leer(path.join(ROOT, 'app', 'src', 'lib', 'live.ts'));
  const usos = src.match(/warnUnknownClientEvent/g) || [];
  assert.equal(usos.length, 3, 'debe haber tres usos: import, live.on y el helper on de connect');
});
