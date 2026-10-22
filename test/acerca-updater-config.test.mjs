// Actualizaciones nativas (Ajustes › Acerca de): el updater de Tauri apunta al latest.json de las
// releases, solo la ventana principal servida por 127.0.0.1 puede usarlo y el plugin está registrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const cap = JSON.parse(read('src-tauri/capabilities/updater.json'));

test('updater: endpoint de las releases, instalación pasiva y clave pública definida', () => {
  const up = conf.plugins?.updater;
  assert.deepEqual(up?.endpoints, ['https://github.com/egdev6/antena/releases/latest/download/latest.json']);
  assert.equal(up?.windows?.installMode, 'passive');
  assert.equal(typeof up?.pubkey, 'string');
  assert.ok(up.pubkey.length > 0, 'pubkey no puede quedar vacía (el workflow de release rechaza el marcador)');
  assert.notEqual(conf.bundle?.createUpdaterArtifacts, true, 'los artefactos firmados solo se activan en CI: en local se compila sin la clave');
});

test('updater: capability propia, solo la ventana principal y solo el servidor local', () => {
  assert.deepEqual(cap.windows, ['main']);
  assert.deepEqual(cap.remote?.urls, ['http://127.0.0.1:*']);
  assert.deepEqual(cap.permissions, ['updater:default', 'process:allow-restart']);
});

test('updater: plugins en Cargo.toml, registrados en main.rs y paquetes JS', () => {
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /^tauri-plugin-updater = "2"$/m);
  assert.match(cargo, /^tauri-plugin-process = "2"$/m);
  const main = read('src-tauri/src/main.rs');
  assert.match(main, /\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
  assert.match(main, /\.plugin\(tauri_plugin_process::init\(\)\)/);
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(deps['@tauri-apps/plugin-updater'] && deps['@tauri-apps/plugin-process']);
});
