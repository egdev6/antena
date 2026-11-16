// S3-S4: the real panel and HTTP routes, built and served only from synthetic temp data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../src/server.mjs';
import { openZip, writeZip } from '../src/zip-archive.mjs';
import { closeAll, closeChrome, findChrome, openChromePage, waitDom, clickWhen } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

const secret = 'SYNTHETIC_CREDENTIAL_CANARY';
const control = text => `[...document.querySelectorAll('button,a')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;
const input = `document.querySelector('input[type="file"]')`;
const dialog = `document.querySelector('dialog[open]')`;
let buildPromise;
async function buildPanel(dist) {
  buildPromise ||= build({ entryPoints: [fileURLToPath(new URL('../app/src/panel/main.tsx', import.meta.url))],
    outfile: path.join(tmpdir(), 'antena-transfer-panel.js'), bundle: true, format: 'esm', minify: true, write: false,
    target: ['chrome110', 'edge110', 'safari16'], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/ds/*'], logLevel: 'silent' });
  const assets = path.join(dist, 'assets'); await mkdir(assets, { recursive: true });
  const result = await buildPromise;
  await Promise.all([...result.outputFiles.map(f => writeFile(path.join(assets, 'panel' + path.extname(f.path)), f.contents)),
    writeFile(path.join(dist, 'index.html'), '<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ds/tokens.css"><link rel="stylesheet" href="/ds/bundle.css"><link rel="stylesheet" href="/assets/panel.css"></head><body><div id="root"></div><script type="module" src="/assets/panel.js"></script></body></html>')]);
}
async function fixture(t, route = '#/general/copia') {
  const bin = await findChrome();
  if (!bin) { t.skip('sin Chrome local; define CHROME_PATH'); return null; }
  const root = await mkdtemp(path.join(tmpdir(), 'antena-transfer-browser-'));
  const data = path.join(root, 'data'), media = path.join(root, 'media'), dist = path.join(root, 'dist'), downloads = path.join(root, 'downloads');
  let app, chrome;
  t.after(() => closeAll(() => chrome && closeChrome(chrome), async () => {
    if (app) { app.teleprompter.stop(); app.viewers.stop(); app.timers.stop(); await app.program.quiesceClose(); app.program.dispose(); await app.closeHttp(); }
  }, () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  await mkdir(data); await mkdir(downloads);
  await writeFile(path.join(data, 'config.json'), JSON.stringify({ panel: { onboardingDone: true }, youtube: { apiKey: secret }, overlay: { obsolete: true } }));
  await buildPanel(dist);
  app = await createApp({ dataDir: data, mediaDir: path.join(root, 'media'), appDist: dist, push: {}, log: () => {} });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  chrome = await openChromePage(bin, `${base}/${route}`);
  const c = chrome.cdp, dom = expr => evaluateChrome(c, expr, { timeoutMs: 12000 });
  const wait = expr => waitDom(c, expr, { timeoutMs: 6000 });
  const api = async url => { const r = await fetch(base + url); assert.equal(r.status, 200); return r.json(); };
  const snapshot = async () => {
    const entries = await readdir(data, { recursive: true, withFileTypes: true });
    const files = entries.filter(e => e.isFile()).map(e => path.relative(data, path.join(e.parentPath, e.name))).sort();
    const mediaEntries = await readdir(media, { recursive: true, withFileTypes: true });
    const mediaNames = mediaEntries.map(e => path.relative(media, path.join(e.parentPath, e.name))).sort();
    const mediaFiles = mediaEntries.filter(e => e.isFile()).map(e => path.relative(media, path.join(e.parentPath, e.name))).sort();
    return { files: await Promise.all(files.map(async f => [f, (await readFile(path.join(data, f))).toString('base64')])), mediaNames,
      media: await Promise.all(mediaFiles.map(async f => [f, (await readFile(path.join(media, f))).toString('base64')])),
      config: await api('/api/config'), persistence: (await api('/api/status')).persistence };
  };
  const select = async (contents, name = 'copia.json') => {
    await wait(`!!${control('Importar configuración…')} && !!${input}`);
    await dom(`${input}.addEventListener('click', e => { e.preventDefault(); window.__picker = true; }, { once: true }); true`);
    await clickWhen(c, control('Importar configuración…'));
    assert.equal(await dom('window.__picker'), true, 'el botón abre el selector');
    const bytes = Buffer.from(contents).toString('base64');
    await dom(`(() => { const d = new DataTransfer(); const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0)); d.items.add(new File([bytes], ${JSON.stringify(name)}, {type:'application/octet-stream'})); const i = ${input}; i.files = d.files; i.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  };
  return { root, data, media, downloads, base, c, dom, wait, api, snapshot, select };
}
const changedFile = async f => {
  const file = await f.api('/api/config/export?format=json');
  file.config.overlay.volume = 0.9; delete file.config.overlay.obsolete;
  for (let i = 1; i <= 6; i++) file.config.overlay[`extra${i}`] = true;
  file.config.filters.blockedWords = ['spam'];
  return file;
};

async function mediaArchive(f) {
  const file = await changedFile(f), added = [], replaced = [];
  for (let i = 1; i <= 6; i++) {
    added.push(`nuevo-${i}.wav`); replaced.push(`sustituido-${i}.png`);
    await writeFile(path.join(f.media, replaced.at(-1)), `anterior ${i}`);
  }
  await writeFile(path.join(f.media, 'igual.jpg'), 'igual');
  await writeFile(path.join(f.media, 'local.mp3'), 'solo local');
  const archive = path.join(f.root, 'copia.zip');
  await writeZip(createWriteStream(archive), [{ name: 'config.json', source: JSON.stringify(file) },
    ...added.map(name => ({ name: `media/${name}`, source: `añadido ${name}` })),
    ...replaced.map(name => ({ name: `media/${name}`, source: `nuevo ${name}` })),
    { name: 'media/igual.jpg', source: 'igual' }]);
  return { bytes: await readFile(archive), added, replaced };
}

test('exportar descarga un ZIP con JSON versionado y medios sin credenciales', async t => {
  const f = await fixture(t); if (!f) return;
  await writeFile(path.join(f.media, 'saludo.png'), 'imagen de prueba');
  await f.wait(`!!${control('Exportar configuración')}`);
  const response = await fetch(f.base + '/api/config/export');
  const expected = /filename="([^"]+)"/.exec(response.headers.get('content-disposition'))[1];
  await f.c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: f.downloads });
  await clickWhen(f.c, control('Exportar configuración'));
  let files = [];
  for (let i = 0; i < 100; i++) { files = await readdir(f.downloads); if (files.includes(expected)) break; await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(files, [expected]);
  assert.match(expected, /^antena-config-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await openZip(path.join(f.downloads, expected)); let text;
  try {
    assert.deepEqual(zip.entries.map(e => e.name), ['config.json', 'media/saludo.png']);
    text = (await zip.readConfig()).toString();
    const extracted = await mkdir(path.join(f.root, 'extracted')).then(() => zip.extract('media/saludo.png', path.join(f.root, 'extracted')));
    assert.equal(await readFile(extracted, 'utf8'), 'imagen de prueba');
  } finally { await zip.close(); }
  const file = JSON.parse(text);
  assert.equal(file.format, 'antena-config'); assert.equal(file.version, 1); assert.equal(text.includes(secret), false);
  assert.equal(Object.hasOwn(file.config.youtube, 'apiKey'), false);
});

test('exportar avisa de los medios omitidos y conserva la descarga ZIP', async t => {
  const f = await fixture(t); if (!f) return;
  await writeFile(path.join(f.media, 'saludo ñ..png'), 'omitido');
  await f.wait(`!!${control('Exportar configuración')}`);
  await f.c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: f.downloads });
  await clickWhen(f.c, control('Exportar configuración'));
  await f.wait(`[...document.querySelectorAll('[role="status"]')].some(e => e.textContent.includes('saludo ñ..png'))`);
  let files = [];
  for (let i = 0; i < 100; i++) { files = await readdir(f.downloads); if (files.some(n => n.endsWith('.zip'))) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(files.length, 1); assert.match(files[0], /^antena-config-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await openZip(path.join(f.downloads, files[0]));
  try { assert.deepEqual(zip.entries.map(e => e.name), ['config.json']); } finally { await zip.close(); }
});

test('ZIP previsualiza y aplica configuración y medios con copias, sin borrar los locales', async t => {
  const f = await fixture(t); if (!f) return;
  const { bytes, added, replaced } = await mediaArchive(f), before = await f.snapshot();
  const oldConfig = await readFile(path.join(f.data, 'config.json'));
  await f.wait(`!!${input}`);
  assert.equal(await f.dom(`${input}.accept`), '.zip,.json');
  await f.dom(`(() => { const original = window.fetch; window.__transfers = []; let file;
    window.fetch = (url, options) => { if (String(url).startsWith('/api/config/import')) {
      file ||= options.body; window.__transfers.push({ path: String(url), type: options.headers['Content-Type'],
        fingerprint: options.headers['X-Config-Fingerprint'] || '', sameFile: file === options.body });
    } return original(url, options); }; return true; })()`);
  await f.select(bytes, 'copia.ZIP'); await f.wait(`!!${dialog}`);
  const text = await f.dom(`${dialog}.textContent`);
  for (const expected of ['overlay', 'filters', 'Cambiados: 1', 'overlay.volume', 'Archivos de medios',
    'Añadidos: 6', 'Reemplazados: 6', 'Sin cambios: 1', ...added, ...replaced,
    'Los archivos reemplazados se guardan en una copia; no se borra ningún archivo tuyo.']) assert.ok(text.includes(expected), expected);
  const mediaSection = `${dialog}.querySelector('section:last-child')`;
  assert.equal(await f.dom(`${mediaSection}.querySelectorAll('details:not([open])').length`), 2, 'las dos listas largas empiezan plegadas');
  assert.deepEqual(await f.snapshot(), before, 'previsualizar no escribe en datos ni medios');
  await clickWhen(f.c, control('Aplicar'));
  await f.wait(`!${dialog} && document.body.textContent.includes('config.backup-') && document.body.textContent.includes('.backup-')`);
  const names = await f.dom(`[...document.querySelectorAll('[role="status"] code')].map(e => e.textContent)`);
  const backup = names.find(name => /^config\.backup-[\w-]+\.json$/.test(name));
  const mediaBackup = names.find(name => /^media\/\.backup-[\w-]+$/.test(name))?.slice('media/'.length);
  assert.ok(backup && mediaBackup, JSON.stringify(names));
  assert.deepEqual(await readFile(path.join(f.data, backup)), oldConfig);
  for (let i = 0; i < replaced.length; i++) {
    assert.equal(await readFile(path.join(f.media, mediaBackup, replaced[i]), 'utf8'), `anterior ${i + 1}`);
    assert.equal(await readFile(path.join(f.media, replaced[i]), 'utf8'), `nuevo ${replaced[i]}`);
    assert.equal(await readFile(path.join(f.media, added[i]), 'utf8'), `añadido ${added[i]}`);
  }
  assert.equal(await readFile(path.join(f.media, 'igual.jpg'), 'utf8'), 'igual');
  assert.equal(await readFile(path.join(f.media, 'local.mp3'), 'utf8'), 'solo local');
  assert.equal((await f.api('/api/config')).overlay.volume, 0.9);
  const requests = await f.dom('window.__transfers');
  assert.deepEqual(requests.map(r => [r.path, r.type, r.sameFile]), [['/api/config/import/preview', 'application/zip', true], ['/api/config/import', 'application/zip', true]]);
  assert.match(requests[1].fingerprint, /^[a-f0-9]{64}$/); assert.equal(requests[0].fingerprint, '');
});

test('cancelar ZIP no modifica datos ni medios', async t => {
  const f = await fixture(t); if (!f) return;
  const { bytes } = await mediaArchive(f), before = await f.snapshot();
  await f.select(bytes, 'copia.zip'); await f.wait(`!!${dialog} || !!document.querySelector('[role="alert"]')`);
  assert.equal(await f.dom(`!!${dialog}`), true, await f.dom(`document.querySelector('[role="alert"]')?.textContent || ''`));
  await clickWhen(f.c, control('Cancelar')); await f.wait(`!${dialog}`);
  assert.equal(await f.dom(`document.activeElement === ${control('Importar configuración…')}`), true);
  assert.deepEqual(await f.snapshot(), before);
});

test('ZIP inválido y medios cambiados tras la vista previa conservan ambos directorios', async t => {
  const f = await fixture(t); if (!f) return;
  const { bytes } = await mediaArchive(f), before = await f.snapshot();
  await f.select('{', 'roto.zip');
  await f.wait(`!!document.querySelector('[role="alert"]')`);
  assert.equal(await f.dom(`document.querySelector('[role="alert"]').textContent.trim()`), 'ZIP inválido o incompleto.');
  assert.equal(await f.dom(`!!${dialog}`), false); assert.deepEqual(await f.snapshot(), before);
  await f.select(bytes, 'copia.zip'); await f.wait(`!!${dialog}`);
  await writeFile(path.join(f.media, 'sustituido-1.png'), 'cambio concurrente');
  const concurrent = await f.snapshot(); await clickWhen(f.c, control('Aplicar'));
  await f.wait(`${dialog}?.querySelector('[role="alert"]')?.textContent.trim() === 'La configuración ha cambiado; vuelve a previsualizar'`);
  assert.deepEqual(await f.snapshot(), concurrent);
});

test('importar JSON previsualiza recuentos y rutas, aplica y muestra la copia y la configuración viva', async t => {
  const f = await fixture(t); if (!f) return;
  const file = await changedFile(f), before = await f.snapshot(), oldConfig = await readFile(path.join(f.data, 'config.json'));
  await f.select(JSON.stringify(file)); await f.wait(`!!${dialog}`);
  const text = await f.dom(`${dialog}.textContent`);
  for (const expected of ['overlay', 'filters', 'Añadidos: 6', 'Eliminados: 1', 'Cambiados: 1', 'overlay.obsolete', 'overlay.volume', 'filters.blockedWords',
    'No incluye cuentas ni contraseñas: tus conexiones actuales se conservan.', 'Antes de aplicar se guarda una copia de tu configuración actual.']) assert.ok(text.includes(expected), expected);
  assert.equal(await f.dom(`!!${dialog}.querySelector('details:not([open])')`), true, 'las rutas largas empiezan plegadas');
  await f.dom(`${dialog}.querySelector('details').open = true`);
  assert.ok((await f.dom(`${dialog}.textContent`)).includes('overlay.extra6'));
  assert.equal(await f.dom(`document.activeElement.textContent.trim()`), 'Cancelar', 'el foco entra en la acción segura');
  assert.deepEqual(await f.snapshot(), before, 'la vista previa no escribe');
  await clickWhen(f.c, control('Aplicar'));
  await f.wait(`!${dialog} && document.body.textContent.includes('config.backup-')`);
  assert.equal(await f.dom(`document.activeElement === ${control('Importar configuración…')}`), true, 'el foco vuelve tras aplicar');
  const notice = await f.dom('document.body.textContent');
  const backup = /config\.backup-[\w-]+\.json/.exec(notice)?.[0]; assert.ok(backup, notice);
  assert.deepEqual(await readFile(path.join(f.data, backup)), oldConfig);
  const config = await f.api('/api/config'); assert.equal(config.overlay.volume, 0.9); assert.equal(config.overlay.extra6, true);
  assert.equal(Object.hasOwn(config.overlay, 'obsolete'), false); assert.deepEqual(config.filters.blockedWords, ['spam']);
  await f.dom(`location.hash = '#/general/overlay'`);
  await f.wait(`document.querySelector('input[type="range"]')?.value === '90'`);
});

test('cancelar y Escape descartan la vista previa, devuelven el foco y no modifican el directorio', async t => {
  const f = await fixture(t); if (!f) return;
  const file = await changedFile(f), before = await f.snapshot();
  await f.select(JSON.stringify(file)); await f.wait(`!!${dialog}`);
  await clickWhen(f.c, control('Cancelar')); await f.wait(`!${dialog}`);
  assert.equal(await f.dom(`document.activeElement === ${control('Importar configuración…')}`), true);
  assert.deepEqual(await f.snapshot(), before);
  await f.select(JSON.stringify(file)); await f.wait(`!!${dialog}`);
  await f.c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await f.c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await f.dom(`!!document.activeElement.closest('dialog')`), true, 'Tab permanece en el diálogo');
  await f.c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await f.c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await f.wait(`!${dialog}`);
  assert.equal(await f.dom(`document.activeElement === ${control('Importar configuración…')}`), true);
  assert.deepEqual(await f.snapshot(), before);
});

test('un archivo inválido muestra exactamente el error 400 del servidor y no aplica nada', async t => {
  const f = await fixture(t); if (!f) return;
  const file = await changedFile(f), before = await f.snapshot(); file.version = 2;
  for (const [contents, message] of [[JSON.stringify(file), 'Versión de configuración no compatible'], ['{', 'JSON no válido']]) {
    await f.select(contents);
    await f.wait(`document.querySelector('[role="alert"]')?.textContent.trim() === ${JSON.stringify(message)}`);
    assert.equal(await f.dom(`!!${dialog}`), false); assert.deepEqual(await f.snapshot(), before);
  }
});

test('un archivo demasiado grande muestra el mensaje 413 del servidor sin escribir (D2)', async t => {
  const f = await fixture(t); if (!f) return;
  const before = await f.snapshot();
  await f.wait(`!!${input}`);
  await f.dom(`(() => { const d = new DataTransfer(); d.items.add(new File([' '.repeat(8000001)], 'grande.json', {type:'application/json'})); const i = ${input}; i.files = d.files; i.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await f.wait(`document.querySelector('[role="alert"]')?.textContent.trim() === 'El cuerpo de la petición es demasiado grande'`);
  assert.equal(await f.dom(`!!${dialog}`), false); assert.deepEqual(await f.snapshot(), before);
});

test('si cambia la configuración tras la vista previa el panel muestra el conflicto y no aplica (A3)', async t => {
  const f = await fixture(t); if (!f) return;
  const file = await changedFile(f);
  await f.select(JSON.stringify(file)); await f.wait(`!!${dialog}`);
  const response = await fetch(f.base + '/api/config/set', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ path: 'tts.rate', value: 1.25 }) });
  assert.equal(response.status, 200); const before = await f.snapshot();
  await clickWhen(f.c, control('Aplicar'));
  await f.wait(`${dialog}?.querySelector('[role="alert"]')?.textContent.trim() === 'La configuración ha cambiado; vuelve a previsualizar'`);
  assert.deepEqual(await f.snapshot(), before);
});

test('General conserva el ajuste y guardado de retención de directos', async t => {
  const f = await fixture(t, '#/general/directos'); if (!f) return;
  await f.wait(`!!document.querySelector('input[type="number"]')`);
  await f.dom(`(() => { const e = document.querySelector('input[type="number"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '7'); e.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await f.wait(`document.body.textContent.includes('Cambios sin guardar')`);
  await f.dom(`location.hash = '#/general/copia'`);
  await f.wait(`!!${control('Importar configuración…')}`);
  assert.equal(await f.dom(`${control('Importar configuración…')}.disabled`), true, 'un borrador no puede pisar la importación');
  assert.ok(await f.dom(`document.body.textContent.includes('Guarda o descarta los cambios pendientes antes de importar.')`));
  await clickWhen(f.c, control('Guardar'));
  await f.wait(`document.body.textContent.includes('Todo guardado')`);
  assert.equal((await f.api('/api/config')).sessions.retention, 7);
  assert.equal(await f.dom(`${control('Importar configuración…')}.disabled`), false);
});
