// Actualizaciones nativas (Ajustes › Acerca de): el updater de Tauri apunta al latest.json de las
// releases y solo la ventana principal servida por 127.0.0.1 lo usa, a través de los comandos de la
// app, que apagan el servidor Node antes de que el instalador NSIS sobrescriba sus archivos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

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

test('updater: capability propia, solo la ventana principal, el servidor local y los comandos de la app', () => {
  assert.deepEqual(cap.windows, ['main']);
  assert.deepEqual(cap.remote?.urls, ['http://127.0.0.1:*']);
  assert.deepEqual(cap.permissions, ['allow-update-check', 'allow-update-install']);
  // los comandos JS del plugin (check/download/install) instalarían sin apagar antes el servidor
  for (const f of readdirSync(new URL('../src-tauri/capabilities/', import.meta.url))) {
    const perms = JSON.parse(read(`src-tauri/capabilities/${f}`)).permissions ?? [];
    for (const p of perms) assert.doesNotMatch(String(p), /^(updater|process):/, `${f} concede ${p}`);
  }
  const toml = read('src-tauri/permissions/commands.toml');
  assert.match(toml, /identifier = "allow-update-check"[\s\S]*?commands\.allow = \["update_check"\]/);
  assert.match(toml, /identifier = "allow-update-install"[\s\S]*?commands\.allow = \["update_install"\]/);
});

test('updater: plugin registrado, comandos propios y apagado del servidor antes del instalador', () => {
  assert.match(read('src-tauri/Cargo.toml'), /^tauri-plugin-updater = "2"$/m);
  const main = read('src-tauri/src/main.rs');
  assert.match(main, /\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/);
  assert.match(main, /generate_handler!\[[^\]]*\bupdate_check, update_install\]/);
  assert.match(main, /fn before_update_exit\(app: &AppHandle\) \{\s*stop_server\(app\);\s*app\.cleanup_before_exit\(\);/);
  assert.match(main, /async fn update_check[\s\S]*?\.on_before_exit\(move \|\| before_update_exit\(&handle\)\)/);
  assert.match(main, /async fn update_install[\s\S]*?before_update_exit\(&app\);\s*app\.restart\(\);/);
  const pkg = JSON.parse(read('package.json'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!deps['@tauri-apps/plugin-updater'] && !deps['@tauri-apps/plugin-process'], 'el JS no usa el plugin');
});
