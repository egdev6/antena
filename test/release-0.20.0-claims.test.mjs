import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = rel => {
  const file = new URL(rel, import.meta.url);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const notes = read('../docs/releases/v0.20.0.md');
const section = title => notes.split(`### ${title}\n`)[1]?.split(/\n### /)[0] ?? '';
const line = (text, needle) => text.split('\n').find(l => l.includes(needle)) ?? '';
const includes = (text, parts) => {
  for (const part of parts) assert.ok(text.includes(part), `missing «${part}»`);
};
const source = (path, parts) => includes(read(path), parts);
const novedades = section('Novedades');
const importante = section('Importante');
const limitaciones = section('Limitaciones conocidas');
const instalacion = section('Instalación y actualización');

test('versiones sincronizadas y al menos 0.20.0', () => {
  const version = JSON.parse(read('../package.json')).version;
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 20, `version ${version} is older than 0.20.0`);
  const esc = version.replace(/\./g, '\\.');
  assert.equal(JSON.parse(read('../src-tauri/tauri.conf.json')).version, version);
  assert.match(read('../src-tauri/Cargo.toml'), new RegExp(`^version = "${esc}"$`, 'm'));
  assert.match(read('../src-tauri/Cargo.lock'), new RegExp(`name = "antena"\\nversion = "${esc}"`));
});

test('temas guardados: panel, vistas previas y cambio desde la barra y el dock', () => {
  includes(line(novedades, 'Temas guardados'), ['**Ajustes › Apariencia › Temas**', '10', 'previsualizar', 'activar', 'barra lateral', 'dock']);
  source('../app/src/panel/views/Apariencia.tsx', ["id: 'temas', label: 'Temas'", '<Temas />']);
  source('../app/src/panel/views/Temas.tsx', ['const MAX = 10', 'Selecciona para previsualizar', '/overlay?still=follow&previewTheme=', '/widget/goal?demo&previewTheme=', '/widget/chat?demo&previewTheme=', 'data-theme-activate']);
  source('../app/src/panel/Sidebar.tsx', ['data-theme-sidebar', 'activateTheme(theme)']);
  source('../app/src/dock/Dock.tsx', ['data-dock-theme-tab', 'activateTheme(theme)']);
  source('../src/routes/themes.mjs', ['const MAX_THEMES = 10', "'/api/themes/:id/activate'"]);
});

test('transferencia de temas con vista previa y tema importado inactivo', () => {
  includes(line(novedades, 'Compartir temas'), ['**Exportar**', '**Importar tema**', 'ZIP', 'vista previa', 'inactivo']);
  source('../app/src/panel/views/Temas.tsx', ['data-theme-export', 'Importar tema', '/api/themes/import/preview', 'Se creará un tema nuevo inactivo']);
  source('../src/routes/theme-transfer.mjs', ["'application/zip'", 'themeMedia(source, avatar)', 'if (!applying) return report', 'themes.add(name, look, avatar', 'active: false']);
  source('../src/routes/themes.mjs', ['const next = { ...themes, saved: [...themes.saved', 'return { theme: list().find(t => t.id === id) }']);
});

test('un agente puede crear y editar un tema sin activarlo por MCP', () => {
  includes(line(novedades, 'Diseño con un agente'), ['MCP', 'crear', 'editar', 'sin activarlo']);
  source('../src/mcp.mjs', ["tool('crear_tema'", 'Crea un tema inactivo', "name: 'disenar_tema'", 'edita cada elemento pasando el id en «tema»']);
  source('../src/theme-looks.mjs', ['Only configuration routes can address an inactive look']);
});

test('scene expone la lista de escenas al aire a overlays propios', () => {
  includes(line(novedades, 'Escenas para overlays'), ['`scene`', '`[{ id, name }]`', 'al aire']);
  source('../public/custom/sdk.js', ["'scene', 'sceneSwitch'", 'Scenes on air in the streaming program']);
  source('../src/server.mjs', [".filter(s => s.current).map(s => ({ id: String(s.id), name: String(s.name ?? '') }))", "bus.send('scene', list, ['widget'], 'scene')"]);
  source('../src/custom-overlays.mjs', ["scene: relay('scene')", "'scene' in state"]);
});

test('sceneSwitch anticipa cambios ordenados por antena y restaura la escena real al fallar', () => {
  includes(line(novedades, 'Transición anticipada'), ['`sceneSwitch`', 'antena', 'antes', 'si falla', '`scene`']);
  for (const [path, request] of [['../src/meld.mjs', "this.call('showScene'"], ['../src/programs/obs-adapter.mjs', "this.requestObs('SetCurrentProgramScene'"]]) {
    const text = read(path);
    includes(text, ["this.emit('sceneSwitch',", request, "this.emit('sceneSwitchFailed',"]);
    assert.ok(text.indexOf("this.emit('sceneSwitch',") < text.indexOf(request));
    assert.ok(text.indexOf(request) < text.indexOf("this.emit('sceneSwitchFailed',"));
  }
  source('../src/server.mjs', ["program.on('sceneSwitchFailed'", "bus.send('scene', list, ['widget'], 'scene')"]);
  source('../src/custom-overlays.mjs', ["sceneSwitch: relay('sceneSwitch')"]);
});

test('huecos colocan widgets reales con movimiento y animación en el shell de confianza', () => {
  includes(line(novedades, 'Huecos de widgets'), ['`antena.slots.place`', 'widgets reales', 'mover', 'animar']);
  source('../public/custom/sdk.js', ['place: function (value, options)', "op: 'place'"]);
  source('../src/custom-overlays.mjs', ['function parseSlot(value)', "document.createElement('iframe')", "'/widget/' + widget", 'style.transition = transition', "style.left = r[0] + 'px'", 'offset(config.enter, r)', 'offset(config.exit, r)']);
  source('../public/widgets/widget.js', ["get('slot')"]);
});

test('migración y protección de audio explican sus límites', () => {
  includes(line(importante, 'Tu configuración'), ['«Normal»', 'copia']);
  source('../src/config-migrations.mjs', ['{ to: 3, up(config)', "activeId: 'normal'", "name: 'Normal'", 'extractLook(effective)']);
  source('../src/store.mjs', ['if (migration.changed) await this.replaceConfigWithBackup']);
  includes(line(importante, 'Audio incrustado'), ['alertas', 'entrevistas', 'Page Visibility']);
  for (const path of ['../public/overlay.html', '../public/widgets/interview.html']) {
    source(path, ["qs.get('embedded') === '1'", 'EMBEDDED && document.hidden', "addEventListener('visibilitychange'"]);
  }
  source('../public/overlay.html', ['if (MUTE || audioHidden()', 'sound.pause()']);
  source('../public/widgets/interview.html', ['video.muted = audioHidden()', "if (audioHidden()) $('full').querySelector('iframe')?.remove()"]);
  includes(line(limitaciones, 'Meld'), ['no se ha comprobado', 'una sola fuente', 'Duplicator']);
  source('../public/custom/sdk.js', ['Meld off-air visibility is unverified', 'use one browser source and Duplicator']);
});

test('instalación, firma y actualización coinciden con la configuración de release', () => {
  includes(instalacion, ['`antena_0.20.0_x64-setup.exe`', '**Ajustes › Acerca de**', '**Buscar actualizaciones**', '**Descargar y reiniciar**']);
  source('../.github/workflows/release.yml', ['antena_"$VERSION"_x64-setup.exe', 'gh release create', '--draft']);
  source('../src-tauri/tauri.conf.json', ['"installMode": "currentUser"', 'releases/latest/download/latest.json']);
  source('../app/src/panel/views/AcercaDe.tsx', ['Buscar actualizaciones', 'Descargar y reiniciar']);
  includes(limitaciones, ['El instalador no está firmado con un certificado de Windows']);
  source('../.github/workflows/release.yml', ['sin firma de código de Windows']);
  source('../README.es.md', ['desde la 0.10.0', 'SmartScreen avisa de «editor desconocido»']);
});

test('limitaciones heredadas no se presentan como comprobaciones nuevas', () => {
  includes(limitaciones, ['En la versión 0.19.0', 'servicios reales', 'racha de Twitch', 'compatibilidad con OBS sigue siendo experimental']);
  source('../docs/releases/v0.19.0.md', ['aún no se han probado con servicios reales', 'La racha de Twitch sigue sin probarse con una cuenta real de Twitch']);
  source('../app/src/panel/views/Conexiones.tsx', ['Conexión experimental']);
});

test('titular, rango y agradecimientos identifican la preparación', () => {
  assert.match(notes, /^## antena 0\.20\.0 — Temas guardados y overlays por escena$/m);
  assert.match(notes, /compare\/v0\.19\.0\.\.\.bf28eb8/);
  includes(section('Agradecimientos'), ['[@egdev6](https://github.com/egdev6)']);
});
