import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = rel => {
  const file = new URL(rel, import.meta.url);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const notes = read('../docs/releases/v0.18.0.md');
const section = title => notes.split(`### ${title}\n`)[1]?.split(/\n### /)[0] ?? '';
const novedades = section('Novedades');
const mejoras = section('Mejoras');
const importante = section('Importante');
const limitaciones = section('Limitaciones conocidas');
const instalacion = section('Instalación y actualización');
const agradecimientos = section('Agradecimientos');
const line = (text, needle) => text.split('\n').find(l => l.includes(needle)) ?? '';
const hasLabels = (rel, labels) => {
  const src = read(rel);
  for (const label of labels) assert.ok(src.includes(label), `missing label «${label}» in ${rel}`);
};

test('S1: versions are synchronized and at least 0.18.0', () => {
  const version = JSON.parse(read('../package.json')).version;
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 18, `version ${version} is older than 0.18.0`);
  const esc = version.replace(/\./g, '\\.');
  assert.equal(JSON.parse(read('../src-tauri/tauri.conf.json')).version, version);
  assert.match(read('../src-tauri/Cargo.toml'), new RegExp(`^version = "${esc}"$`, 'm'));
  assert.match(read('../src-tauri/Cargo.lock'), new RegExp(`name = "antena"\nversion = "${esc}"`));
});

test('S1: the headline names interviews, welcome, streaks and YouTube gifts', () => {
  assert.match(notes, /^## antena 0\.18\.0 — Entrevistas en directo, bienvenidas, rachas y regalos de YouTube$/m);
});

test('S1: interview claims match the widget, controls, shortcuts and MCP tools', () => {
  const widget = line(novedades, 'Entrevistas en directo');
  assert.match(widget, /`\/widget\/interview`, 1920×1080/);
  assert.match(widget, /tus notas y el progreso nunca salen en pantalla/);
  const control = line(novedades, 'Control de la entrevista');
  for (const label of ['«Anterior»', '«Siguiente»', '«Mostrar media»', '«Ocultar widget»', '«Ir a…»', '«Entrevista: siguiente pregunta»']) assert.ok(control.includes(label), label);
  assert.match(control, /Solo se muestran las preguntas aprobadas/);
  hasLabels('../app/src/lib/InterviewControls.tsx', ['Anterior', 'Siguiente', 'Mostrar media', 'Ocultar widget', 'Ir a…']);
  hasLabels('../app/src/panel/views/Atajos.tsx', ['Entrevista: siguiente pregunta']);
  hasLabels('../app/src/panel/views/Widgets.tsx', ["'Entrevista'", 'Chat en pantalla']);
  hasLabels('../app/src/prompter/Prompter.tsx', ['Entrevista']);
  hasLabels('../src/mcp.mjs', ["'importar_entrevista'", "'elegir_entrevista'", "'renombrar_directo'", "'editar_variante_chat'"]);
  assert.match(limitaciones, /todavía no hay pantalla en el panel para crear o elegir una entrevista/);
});

test('S1: welcome, streak and Jewels claims match the alert defaults and settings', () => {
  const alerts = read('../src/alerts.mjs');
  assert.match(line(novedades, 'Bienvenida al chat'), /«Primera vez de \{user\} hoy», con una variación «Vuelve»/);
  assert.match(line(novedades, 'Bienvenida al chat'), /Viene activada; puedes editarla o desactivarla en \*\*Alertas › Bienvenida\*\*/);
  assert.ok(alerts.includes("text: 'Primera vez de {user} hoy'"));
  assert.match(alerts, /name: 'Vuelve'/);
  const streak = line(novedades, 'Rachas de directos seguidos');
  assert.match(streak, /«\{count\} directos seguidos»/);
  assert.match(streak, /«Directos seguidos mínimos \(incluido el actual\)» \(3 de serie\)/);
  assert.ok(alerts.includes("sub: '{count} directos seguidos'"));
  hasLabels('../app/src/panel/views/Conexiones.tsx', ['Directos seguidos mínimos (incluido el actual)', 'Avisar de rachas de chat en YouTube', 'Volver a conectar']);
  assert.match(read('../src/store.mjs'), /streakMinSessions: 3/);
  const jewels = line(novedades, 'Regalos de YouTube (Jewels)');
  assert.match(jewels, /una sola alerta con el total, por ejemplo «Rosa ×5 · 125 Jewels»/);
  assert.ok(alerts.includes("label: 'Regalo de YouTube'"));
  assert.ok(alerts.includes("sub: '{giftName} ×{count} · {amount} Jewels'"));
  assert.match(limitaciones, /el total que se muestra es definitivo/);
  assert.match(limitaciones, /«Usuarios bloqueados» en \*\*Ajustes › Filtros y voz\*\*/);
  hasLabels('../app/src/panel/Sidebar.tsx', ['Filtros y voz']);
  hasLabels('../app/src/panel/views/Ajustes.tsx', ['Usuarios bloqueados']);
});

test('S1: the Twitch reconnect step is in Importante and the untested live streak is a limitation', () => {
  assert.match(importante, /«Reconecta Twitch para activar las rachas»/);
  assert.match(importante, /el resto de Twitch funciona como siempre/);
  assert.match(importante, /Pulsa «Volver a conectar»/);
  assert.ok(read('../src/twitch.mjs').includes('Reconecta Twitch para activar las rachas'));
  assert.match(limitaciones, /La racha de Twitch no se ha probado todavía con una cuenta real de Twitch/);
});

test('S1: improvements match the panel labels', () => {
  assert.match(line(mejoras, 'Prompter'), /«Ocultar los mensajes programados del chat».*Viene desactivado/);
  hasLabels('../app/src/panel/views/Ajustes.tsx', ['Ocultar los mensajes programados del chat']);
  assert.match(line(mejoras, 'Dock'), /tarjeta «Emisión»/);
  hasLabels('../app/src/dock/Dock.tsx', ['Emisión', 'Espectadores por plataforma']);
  assert.match(line(mejoras, 'Chat en pantalla'), /No te impide guardar/);
  assert.match(line(novedades, 'Renombrar directos'), /\*\*Registro › Directos anteriores\*\*/);
  hasLabels('../app/src/panel/Sidebar.tsx', ['Directos anteriores']);
});

test('S1: install, OBS and signing caveats stay accurate', () => {
  assert.match(instalacion, /`antena_0\.18\.0_x64-setup\.exe`/);
  assert.match(instalacion, /\*\*Ajustes › Acerca de\*\*, pulsa \*\*Buscar actualizaciones\*\*/);
  assert.match(limitaciones, /no se ha validado con OBS ni Meld reales en Windows/);
  assert.match(limitaciones, /El instalador no está firmado con un certificado de Windows/);
  assert.match(notes, /compare\/v0\.17\.0\.\.\.5a07e500f3676467bbd7291928729d8e7c45eaeb/);
});

test('S1: acknowledgements thank the verified contributor', () => {
  assert.match(agradecimientos, /\[@egdev6\]\(https:\/\/github\.com\/egdev6\)/);
});
