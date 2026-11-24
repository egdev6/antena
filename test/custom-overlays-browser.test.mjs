// S6 de punta a punta en Chrome: la shell manda una alerta real al SDK y el código del usuario
// del overlay la recibe dentro del marco opaco. El marco es un OOPIF (origen opaco), así que su
// DOM no se puede leer desde el target del padre: el propio código del usuario avisa a un
// servidor local de la prueba, que es lo que se comprueba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.mjs';
import { closeAll, closeChrome, findChrome, openChromePage } from './helpers/react-browser.mjs';
import { fakeMeld } from './helpers/fake-meld.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Servidor local que apunta las peticiones del marco (el canal de vuelta de la prueba). */
async function recorder() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    async waitFor(predicate, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = hits.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`la prueba no recibió la petición esperada; llegaron: ${JSON.stringify(hits)}`);
        await sleep(100);
      }
    },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}

test('un overlay propio recibe la alerta por el SDK dentro del marco opaco', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body, headers) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  });
  let chrome;
  try {
    // El código del usuario comprueba que el SDK ya existe, espera a ready y se suscribe a las alertas.
    const overlay = (await api('POST', '/api/custom-overlays', {
      name: 'SDK en vivo',
      js: [
        `fetch('${back.base}/sdk-loaded?typeof=' + encodeURIComponent(typeof antena), { mode: 'no-cors' });`,
        "antena.ready.then(() => fetch('" + back.base + "/sdk-ready', { mode: 'no-cors' }));",
        "antena.on('alert', a => fetch('" + back.base + "/sdk-alert?user=' + encodeURIComponent(a.vars.user) + '&title=' + encodeURIComponent(a.title), { mode: 'no-cors' }));",
      ].join('\n'),
    })).overlay;

    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    // El SDK es un script clásico en el head: existe antes de que corra el código del usuario.
    assert.match(decodeURIComponent(await back.waitFor(h => h.startsWith('/sdk-loaded'))), /typeof=object/);
    // ready se resuelve cuando la shell ya conectó y empujó los snapshots.
    await back.waitFor(h => h === '/sdk-ready');

    // El padre no puede leer el marco: origen opaco de verdad (S5).
    const crossOrigin = await chrome.cdp.send('Runtime.evaluate', {
      expression: "(() => { try { return document.querySelector('iframe').contentDocument === null ? 'blocked' : 'readable'; } catch (e) { return 'throws'; } })()",
      returnByValue: true,
    });
    assert.notEqual(crossOrigin.result?.value, 'readable', 'el padre no lee el DOM del marco');

    await api('POST', '/api/simulate', { type: 'follow', vars: { user: 'ana' } });
    const hit = new URL(await back.waitFor(h => h.startsWith('/sdk-alert')), back.base);
    assert.equal(hit.searchParams.get('user'), 'ana');
    assert.equal(hit.searchParams.get('title'), 'Nuevo seguidor');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

test('theme identity and per-overlay CSS reach the sandbox live without reloading the frame', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-theme-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.ok, true, JSON.stringify(data)); return data;
  };
  let chrome;
  try {
    const js = `fetch('${back.base}/frame-loaded', {mode:'no-cors'});\n` +
      `function report() { const t = antena.state.theme || {}; const q = new URLSearchParams({id:t.id || '', name:t.name || '', marker:document.documentElement.dataset.tema || '', color:getComputedStyle(document.getElementById('target')).color, accent:t.accent || ''}); fetch('${back.base}/theme?' + q, {mode:'no-cors'}); }\n` +
      `antena.on('theme', () => setTimeout(report, 100)); new MutationObserver(() => setTimeout(report, 100)).observe(document.documentElement, {attributes:true,childList:true,characterData:true,subtree:true});`;
    const overlay = (await api('POST', '/api/custom-overlays', { name: 'Marco', html: '<div id="target">hola</div>', css: '#target{color:rgb(0,0,0)}', js })).overlay;
    const p = `customOverlayCss.${overlay.id}`;
    await api('POST', '/api/config/set', { path: p, value: '#target{color:rgb(255,0,0)}' });
    await api('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' });
    await api('POST', '/api/config/set', { path: p, value: '#target{color:rgb(0,0,255)}' });
    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    const matches = (name, color, marker) => hit => {
      if (!hit.startsWith('/theme?')) return false;
      const q = new URL(hit, back.base).searchParams;
      return q.get('id') === marker && q.get('name') === name && q.get('marker') === marker && q.get('color') === color && !!q.get('accent');
    };
    await back.waitFor(matches('Normal', 'rgb(0, 0, 255)', 'normal'));
    await api('POST', '/api/themes/invierno/activate');
    await back.waitFor(matches('Invierno', 'rgb(255, 0, 0)', 'invierno'));
    await api('PUT', '/api/themes/invierno', { name: 'Navidad' });
    await back.waitFor(matches('Navidad', 'rgb(255, 0, 0)', 'invierno'));
    await api('POST', '/api/config/set', { path: p, value: '#target{color:rgb(0,128,0)}' });
    await back.waitFor(matches('Navidad', 'rgb(0, 128, 0)', 'invierno'));
    assert.equal(back.hits.filter(h => h === '/frame-loaded').length, 1);
    assert.deepEqual((await api('GET', `/api/custom-overlays/${overlay.id}`)).overlay, overlay);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

test('SDK theme observers never see mixed identity, look or themed CSS during a switch', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-atomic-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), push: {}, log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json(); assert.equal(r.ok, true, JSON.stringify(data)); return data;
  };
  let chrome;
  try {
    const js = `antena.on('theme', t => { const q = new URLSearchParams({id:t.id || '', name:t.name || '', accent:t.accent || '', marker:document.documentElement.dataset.tema || '', look:getComputedStyle(document.documentElement).getPropertyValue('--red').trim(), color:getComputedStyle(document.getElementById('target')).color}); fetch('${back.base}/observed?' + q, {mode:'no-cors'}); });`;
    const overlay = (await api('POST', '/api/custom-overlays', { name: 'Atómico', html: '<div id="target">hola</div>', css: '#target{color:black}', js })).overlay;
    const id = overlay.id;
    await api('PUT', '/api/config', { theme: { accent: '#112233', platformAccent: false }, customOverlayCss: { [id]: '#target{color:rgb(255,0,0)}' } });
    await api('POST', '/api/themes/duplicate', { from: 'normal', name: 'Invierno' });
    await api('PUT', '/api/config', { theme: { accent: '#445566' }, customOverlayCss: { [id]: '#target{color:rgb(0,0,255)}' } });
    chrome = await openChromePage(bin, `${base}/custom/${id}`);
    const contains = name => hit => hit.startsWith('/observed?') && new URL(hit, back.base).searchParams.get('name') === name;
    await back.waitFor(contains('Normal'));
    await api('POST', '/api/themes/invierno/activate');
    await back.waitFor(contains('Invierno'));
    await api('PUT', '/api/themes/invierno', { name: 'Navidad' });
    await back.waitFor(contains('Navidad'));
    for (const hit of back.hits.filter(h => h.startsWith('/observed?'))) {
      const q = new URL(hit, back.base).searchParams;
      const expected = q.get('id') === 'normal' ? ['Normal', '#445566', 'rgb(0, 0, 255)'] : ['Invierno', '#112233', 'rgb(255, 0, 0)'];
      assert.ok(q.get('id') === 'normal' || q.get('id') === 'invierno');
      assert.ok(q.get('name') === expected[0] || (q.get('id') === 'invierno' && q.get('name') === 'Navidad'));
      assert.equal(q.get('accent'), expected[1]);
      assert.equal(q.get('look').toUpperCase(), expected[1]);
      assert.equal(q.get('color'), expected[2]);
      assert.equal(q.get('marker'), q.get('id'));
    }
    assert.deepEqual((await api('GET', `/api/custom-overlays/${id}`)).overlay, overlay);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

// T3: probar_overlay en Chrome. La prueba sale del servidor, la shell la filtra por id y el SDK la
// entrega tal cual al código del usuario, sin cambios en el SDK.
test('probar_overlay: la prueba llega al marco de su capa y a ninguna otra', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-probar-browser-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body, headers) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  });
  let chrome;
  try {
    // El código del usuario apunta cada dato recibido al servidor de la prueba.
    const overlay = (await api('POST', '/api/custom-overlays', {
      name: 'Prueba de capa',
      js: [
        "antena.on('alert', a => fetch('" + back.base + "/a-alert?user=' + encodeURIComponent(a.vars.user) + '&title=' + encodeURIComponent(a.title), { mode: 'no-cors' }));",
        "antena.on('viewers', v => fetch('" + back.base + "/a-viewers?current=' + v.twitch.current, { mode: 'no-cors' }));",
      ].join('\n'),
    })).overlay;
    const other = (await api('POST', '/api/custom-overlays', { name: 'Otra capa' })).overlay;

    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    // Snapshot inicial: la shell conectó y el SDK ya reparte datos a esta capa.
    await back.waitFor(h => h.startsWith('/a-viewers?current='));

    // Una prueba para OTRA capa no se reenvía a este marco (la shell filtra por id).
    await api('POST', `/api/custom-overlays/${other.id}/test`, { event: 'alert', data: { type: 'follow', title: 'NO-DEBE-LLEGAR', vars: { user: 'fantasma' } } });
    await sleep(1500);
    assert.equal(back.hits.some(h => h.includes('fantasma') || h.includes('NO-DEBE-LLEGAR')), false, 'la prueba de otra capa no llega a este marco');

    // La prueba para esta capa sí: llega como el mensaje { antena: 1, event, data } de siempre.
    await api('POST', `/api/custom-overlays/${overlay.id}/test`, { event: 'alert', data: { type: 'follow', title: 'Solo para A', vars: { user: 'ana' } } });
    const hit = new URL(await back.waitFor(h => h.startsWith('/a-alert')), back.base);
    assert.equal(hit.searchParams.get('user'), 'ana');
    assert.equal(hit.searchParams.get('title'), 'Solo para A');

    // Sin datos, el ejemplo realista del servidor es lo que acaba en el código del usuario.
    const probed = await api('POST', `/api/custom-overlays/${overlay.id}/test`, { event: 'viewers' });
    const current = probed.test.data.twitch.current;
    assert.ok(current > 0, 'el ejemplo de espectadores no es un snapshot vacío');
    const seen = new URL(await back.waitFor(h => h === '/a-viewers?current=' + current), back.base);
    assert.equal(seen.searchParams.get('current'), String(current));
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

// T5/S11b: antena.run de una acción APROBADA en Chrome. La petición sale del SDK, la shell la
// reenvía a la ruta de acciones de SU overlay y el motor mueve Meld. El marco sigue opaco: su
// código no llama a la API, solo a antena.run.
test('S11b: antena.run aprobado ejecuta la acción y Meld cambia de escena', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const meldSrv = fakeMeld();
  await new Promise(r => meldSrv.server.listen(0, '127.0.0.1', r));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-action-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body, headers) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  });
  let chrome;
  try {
    await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meldSrv.server.address().port}` });
    for (let i = 0; i < 40 && app.meld.status.state !== 'conectado'; i++) await sleep(25);
    assert.equal(app.meld.status.state, 'conectado', 'el Meld simulado no conectó');
    const overlay = (await api('POST', '/api/custom-overlays', {
      name: 'Acción aprobada',
      requestedPermissions: ['scene'],
      js: "antena.run('scene', { scene: 'Pantalla' })"
        + ".then(() => fetch('" + back.base + "/run-ok', { mode: 'no-cors' }))"
        + ".catch(e => fetch('" + back.base + "/run-fail?e=' + encodeURIComponent(e.message), { mode: 'no-cors' }));",
    })).overlay;
    // La aprobación es del usuario en el panel: cabeceras de navegador del mismo origen.
    await api('PUT', `/api/custom-overlays/${overlay.id}/permissions`, { permissions: ['scene'] }, { Origin: base, 'Sec-Fetch-Site': 'same-origin' });

    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    await back.waitFor(h => h === '/run-ok', 30000);
    assert.equal(back.hits.some(h => h.startsWith('/run-fail')), false, 'la promesa resolvió, no rechazó');
    assert.deepEqual(meldSrv.state.calls, [[10, 's2']], 'el motor cambió de escena en Meld');
    assert.equal(app.meld.session().scenes.find(s => s.current).name, 'Pantalla');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(), () => meldSrv.server.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

// T5/S11b: sin aprobación la promesa se rechaza con el error del servidor y NADA se ejecuta.
test('S11b: antena.run sin aprobación rechaza la promesa y no toca Meld', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const meldSrv = fakeMeld();
  await new Promise(r => meldSrv.server.listen(0, '127.0.0.1', r));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-action-denied-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body, headers) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  });
  let chrome;
  try {
    await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meldSrv.server.address().port}` });
    for (let i = 0; i < 40 && app.meld.status.state !== 'conectado'; i++) await sleep(25);
    assert.equal(app.meld.status.state, 'conectado', 'el Meld simulado no conectó');
    // Pide el permiso pero nadie lo ha aprobado.
    const overlay = (await api('POST', '/api/custom-overlays', {
      name: 'Acción sin aprobar',
      requestedPermissions: ['scene'],
      js: "antena.run('scene', { scene: 'Pantalla' })"
        + ".then(() => fetch('" + back.base + "/run-ok', { mode: 'no-cors' }))"
        + ".catch(e => fetch('" + back.base + "/run-rejected?e=' + encodeURIComponent(e.message), { mode: 'no-cors' }));",
    })).overlay;

    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    const hit = new URL(await back.waitFor(h => h.startsWith('/run-rejected'), 30000), back.base);
    assert.match(hit.searchParams.get('e') || '', /permiso/i, 'la promesa se rechazó con el error del servidor');
    assert.equal(back.hits.some(h => h === '/run-ok'), false, 'nunca resolvió');
    assert.deepEqual(meldSrv.state.calls, [], 'no se ejecutó ninguna acción');
    assert.equal(app.meld.session().scenes.find(s => s.current).name, 'Cámara');
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(), () => meldSrv.server.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});

// Overlay único para todas las escenas: el marco opaco se entera de la escena al aire y de sus cambios.
test('un overlay propio recibe por el SDK la escena al aire y sus cambios', { timeout: 120000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('sin Chrome local; define CHROME_PATH para ejecutar la prueba de navegador');
  const back = await recorder();
  const meldSrv = fakeMeld();
  await new Promise(r => meldSrv.server.listen(0, '127.0.0.1', r));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'egdev-custom-scene-'));
  t.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const app = await createApp({ dataDir, mediaDir: path.join(dataDir, 'media'), log: () => {} });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => {
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  });
  let chrome;
  try {
    await api('POST', '/api/meld/connect', { url: `ws://127.0.0.1:${meldSrv.server.address().port}` });
    for (let i = 0; i < 40 && app.meld.status.state !== 'conectado'; i++) await sleep(25);
    assert.equal(app.meld.status.state, 'conectado', 'el Meld simulado no conectó');
    const overlay = (await api('POST', '/api/custom-overlays', {
      name: 'Escenas',
      js: "antena.ready.then(() => fetch('" + back.base + "/ready?names=' + encodeURIComponent((antena.state.scene || ['sin-dato']).map(s => s.name || s).join('|')), { mode: 'no-cors' }));"
        + "antena.on('scene', list => fetch('" + back.base + "/scene?names=' + encodeURIComponent(list.map(s => s.name).join('|')), { mode: 'no-cors' }));"
        + "antena.on('sceneSwitch', s => fetch('" + back.base + "/switch?name=' + encodeURIComponent(s.name), { mode: 'no-cors' }));",
    })).overlay;
    chrome = await openChromePage(bin, `${base}/custom/${overlay.id}`);
    await back.waitFor(h => h === '/scene?names=C%C3%A1mara', 30000);
    // ready implies the on-air scenes are already in antena.state.
    assert.equal(await back.waitFor(h => h.startsWith('/ready'), 30000), '/ready?names=C%C3%A1mara');
    meldSrv.setCurrentScenes(['s2']);
    await back.waitFor(h => h === '/scene?names=Pantalla', 30000);
    // Ordered by Antena: the overlay gets the target first (sceneSwitch), then the confirmation (scene).
    const from = back.hits.length;
    await api('POST', '/api/meld/scene', { scene: 'Cámara' });
    for (let i = 0; i < 300 && !back.hits.slice(from).includes('/scene?names=C%C3%A1mara'); i++) await sleep(100);
    const after = back.hits.slice(from);
    const sw = after.indexOf('/switch?name=C%C3%A1mara'), conf = after.indexOf('/scene?names=C%C3%A1mara');
    assert.ok(sw >= 0 && conf > sw, `sceneSwitch llega antes que scene: ${JSON.stringify(after)}`);
  } finally {
    await closeAll(() => chrome && closeChrome(chrome), () => back.close(), () => meldSrv.server.close(),
      () => { app.viewers.stop(); app.meld.stop(); app.server.closeAllConnections(); app.server.close(); });
  }
});
