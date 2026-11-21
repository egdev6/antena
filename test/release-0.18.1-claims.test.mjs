import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = rel => {
  const file = new URL(rel, import.meta.url);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const notes = read('../docs/releases/v0.18.1.md');
const section = title => notes.split(`### ${title}\n`)[1]?.split(/\n### /)[0] ?? '';
const novedades = section('Novedades');
const limitaciones = section('Limitaciones conocidas');
const instalacion = section('Instalación y actualización');
const agradecimientos = section('Agradecimientos');
const line = (text, needle) => text.split('\n').find(l => l.includes(needle)) ?? '';
const hasLabels = (rel, labels) => {
  const src = read(rel);
  for (const label of labels) assert.ok(src.includes(label), `missing label «${label}» in ${rel}`);
};

test('S1: versions are synchronized and at least 0.18.1', () => {
  const version = JSON.parse(read('../package.json')).version;
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major > 0 || minor > 18 || (minor === 18 && patch >= 1), `version ${version} is older than 0.18.1`);
  const esc = version.replace(/\./g, '\\.');
  assert.equal(JSON.parse(read('../src-tauri/tauri.conf.json')).version, version);
  assert.match(read('../src-tauri/Cargo.toml'), new RegExp(`^version = "${esc}"$`, 'm'));
  assert.match(read('../src-tauri/Cargo.lock'), new RegExp(`name = "antena"\\nversion = "${esc}"`));
});

test('S1: the headline names interviews from the panel and the dock', () => {
  assert.match(notes, /^## antena 0\.18\.1 — Entrevistas desde el panel y el dock$/m);
});

test('S1: panel list and editor claims match the UI labels', () => {
  assert.match(line(novedades, 'Entrevistas en el panel'), /«Se manejan en directo».*«\+ Nueva entrevista».*«Importar pack JSON»/);
  hasLabels('../app/src/panel/views/Widgets.tsx', ['Se manejan en directo', '#/entrevista']);
  const editor = line(novedades, 'Editor «Guion y escena»');
  for (const label of ['«Guion»', '«Mover a la ronda»', '«Vista previa en pantalla»', '«+ Añadir ronda»']) assert.ok(editor.includes(label), label);
  assert.match(editor, /sin tus notas/);
  hasLabels('../app/src/panel/views/Entrevista.tsx', ['+ Nueva entrevista', 'Importar pack JSON', 'Guion', 'Mover a la ronda', 'Vista previa en pantalla', '+ Añadir ronda', 'Parar entrevista']);
  assert.match(line(novedades, 'Guardar con borrador'), /\*\*Guardar\*\*.*\*\*Descartar\*\*/);
});

test('S1: dock tab and stop claims match the dock, shortcut and MCP sources', () => {
  assert.match(line(novedades, 'Pestaña Entrevista en el dock'), /pestaña más de \*\*Interactivos\*\*/);
  hasLabels('../app/src/dock/Dock.tsx', ["interview: { id: 'entrevista', label: 'Entrevista' }", 'aria-label="Interactivos"']);
  const stop = line(novedades, 'Parar una entrevista sin borrarla');
  assert.match(stop, /«Entrevista: parar sin borrarla».*`parar_entrevista`/);
  hasLabels('../app/src/panel/views/Atajos.tsx', ["'entrevista-parar': 'Entrevista: parar sin borrarla'"]);
  hasLabels('../src/routes/shortcuts.mjs', ["'entrevista-parar'"]);
  hasLabels('../src/mcp.mjs', ["'parar_entrevista'"]);
  hasLabels('../src/routes/interviews.mjs', ['/api/interviews/stop']);
});

test('S1: limitations, install and credits stay accurate', () => {
  assert.match(limitaciones, /El módulo Entrevista del dock viene desactivado.*\*\*Paneles › Vista\*\*/);
  assert.match(read('../src/dock-layout.mjs'), /enabled: id !== 'shortcuts' && id !== 'interview'/);
  assert.match(limitaciones, /La racha de Twitch sigue sin probarse con una cuenta real de Twitch/);
  assert.match(limitaciones, /no se ha validado con OBS ni Meld reales en Windows/);
  assert.match(limitaciones, /El instalador no está firmado con un certificado de Windows/);
  assert.match(instalacion, /`antena_0\.18\.1_x64-setup\.exe`/);
  assert.match(notes, /compare\/v0\.18\.0\.\.\.592065a/);
  assert.match(agradecimientos, /\[@egdev6\]\(https:\/\/github\.com\/egdev6\)/);
});
