// Comprobación estructural de la configuración de Tauri (#61): la capability `default`
// solo concede IPC a páginas servidas por el propio servidor (127.0.0.1), con los
// permisos mínimos de los comandos de la app, y la configuración define una CSP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const capability = JSON.parse(readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8'));
const conf = JSON.parse(readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));

test('capability: sin IPC para localhost ni páginas fuera del servidor local', () => {
  const urls = capability.remote?.urls ?? [];
  assert.ok(urls.length > 0, 'remote.urls no puede quedar vacío: el panel se sirve desde el servidor local');
  for (const u of urls) {
    assert.ok(u.startsWith('http://127.0.0.1:'), `origen inesperado en remote.urls: ${u}`);
    assert.ok(!/localhost/.test(u), `remote.urls no debe admitir localhost: ${u}`);
    assert.ok(!/\*$/.test(u.replace(/(:\*)/, '')), `patrón demasiado amplio: ${u}`);
  }
});

test('capability: permisos mínimos para los comandos que usa la interfaz', () => {
  const perms = capability.permissions ?? [];
  const commands = ['monitors', 'open_prompter', 'open_teleprompter', 'open_dock', 'desktop_info'].map(c => c.replace(/_/g, '-'));
  for (const needed of commands) {
    assert.ok(perms.includes(`allow-${needed}`), `falta allow-${needed} en permissions`);
  }
  assert.ok(perms.includes('core:default'), 'core:default sigue siendo necesario para el IPC');
  assert.deepEqual(capability.windows, ['main', 'prompter', 'dock']);
});

const MAIN_RS = readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8');

test('main.rs: todas las ventanas nacen del builder único con la guardia de navegación', () => {
  // un solo WebviewWindowBuilder::new (dentro de window_builder) y una sola llamada a on_navigation
  assert.equal((MAIN_RS.match(/WebviewWindowBuilder::new/g) ?? []).length, 1,
    'debe existir un único WebviewWindowBuilder::new, dentro de window_builder');
  assert.match(MAIN_RS, /fn window_builder[\s\S]*?on_navigation\(move \|u\| allowed_navigation/,
    'window_builder debe aplicar allowed_navigation');
  assert.equal((MAIN_RS.match(/window_builder\(/g) ?? []).length, 4,
    'las cuatro ventanas (main, prompter, teleprompter y dock) deben crearse con window_builder');
  assert.ok(!/WebviewWindowBuilder::new\(&app, "(main|prompter|teleprompter|dock)"/.test(MAIN_RS),
    'ninguna ventana se crea directamente sin la guardia');
});

test('capability: sin ventanas ni permisos sobrantes', () => {
  const allowed = new Set(['core:default', ...['monitors', 'open_prompter', 'open_teleprompter', 'open_dock', 'desktop_info'].map(c => `allow-${c.replace(/_/g, '-')}`)]);
  const perms = capability.permissions ?? [];
  for (const p of perms) assert.ok(allowed.has(p), `permiso no justificado: ${p}`);
});

test('config: el IPC global sigue disponible y hay CSP definida', () => {
  assert.equal(conf.app?.withGlobalTauri, true, 'la interfaz llama a window.__TAURI__.core.invoke');
  assert.equal(typeof conf.app?.security?.csp, 'string', 'app.security.csp debe definirse');
  assert.ok((conf.app?.security?.csp ?? '').includes("default-src 'self'"));
});

test('open_teleprompter: sin pantalla elegida se va a la principal (no a la última)', () => {
  assert.match(MAIN_RS, /async fn open_teleprompter[\s\S]*?i\.primary/, 'el fallback del teleprompter resuelve el monitor primario');
  assert.match(MAIN_RS, /"\/widget\/teleprompter"/, 'la ventana carga la ruta del widget de teleprompter');
  const perms = readFileSync(new URL('../src-tauri/permissions/commands.toml', import.meta.url), 'utf8');
  assert.match(perms, /allow-open-teleprompter/, 'permiso allow-open-teleprompter declarado');
});
