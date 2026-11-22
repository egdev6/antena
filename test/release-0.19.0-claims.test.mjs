import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = rel => {
  const file = new URL(rel, import.meta.url);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const notes = read('../docs/releases/v0.19.0.md');
const section = title => notes.split(`### ${title}\n`)[1]?.split(/\n### /)[0] ?? '';
const novedades = section('Novedades');
const mejoras = section('Mejoras');
const importante = section('Importante');
const limitaciones = section('Limitaciones conocidas');
const instalacion = section('Instalación y actualización');
const agradecimientos = section('Agradecimientos');
const line = (text, needle) => text.split('\n').find(l => l.includes(needle)) ?? '';
const conexiones = read('../app/src/panel/views/Conexiones.tsx');
const hasLabels = (src, rel, labels) => { for (const label of labels) assert.ok(src.includes(label), `missing «${label}» in ${rel}`); };

test('S1: versions are synchronized and at least 0.19.0', () => {
  const version = JSON.parse(read('../package.json')).version;
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 0 || minor >= 19, `version ${version} is older than 0.19.0`);
  const esc = version.replace(/\./g, '\\.');
  assert.equal(JSON.parse(read('../src-tauri/tauri.conf.json')).version, version);
  assert.match(read('../src-tauri/Cargo.toml'), new RegExp(`^version = "${esc}"$`, 'm'));
  assert.match(read('../src-tauri/Cargo.lock'), new RegExp(`name = "antena"\\nversion = "${esc}"`));
});

test('S1: the headline names the Discord announcement and scheduled streams', () => {
  assert.match(notes, /^## antena 0\.19\.0 — Aviso de directo en Discord y directos programados$/m);
});

test('S1: Discord claims match the panel and the payload', () => {
  const discord = line(novedades, 'Aviso de directo en Discord');
  for (const claim of ['**Conexiones › Webhooks**', '«Probar»', '«Avisar en Discord al empezar el directo»', '`@everyone`', '«Terminado · duró 2 h 10 min»', '«Probar» no menciona a nadie'])
    assert.ok(discord.includes(claim), claim);
  hasLabels(conexiones, 'Conexiones.tsx', ["'Webhooks'", 'Probar', 'Avisar en Discord al empezar el directo', 'Volver a publicar', 'Iconos de plataforma (opcional)']);
  const embed = read('../src/discord.mjs');
  assert.ok(embed.includes("content: '@everyone'"));
  assert.ok(embed.includes("allowed_mentions: { parse: ['everyone'] }"));
  assert.ok(embed.includes('Terminado \\u00b7 dur\\u00f3') || embed.includes('Terminado · duró'));
  assert.match(embed, /0xFF0036/); assert.match(embed, /0x80848E/);
  assert.match(line(novedades, 'Iconos de plataforma'), /🟪 y 🟥/);
  assert.ok(embed.includes('1F7EA') && embed.includes('1F7E5'), 'purple and red square fallbacks');
  assert.match(importante, /«Volver a publicar»/);
});

test('S1: scheduled-stream claims match the panel and the URL rule', () => {
  const prog = line(novedades, 'Directos programados');
  for (const claim of ['**Conexiones › Programación**', '«URL del calendario»', '«Credencial de lectura»', '«Usar el evento programado al empezar el directo»'])
    assert.ok(prog.includes(claim), claim);
  hasLabels(conexiones, 'Conexiones.tsx', ["'Programación'", 'URL del calendario', 'Credencial de lectura', 'Usar el evento programado al empezar el directo']);
  assert.match(importante, /solo admite una dirección local sin ruta, por ejemplo `http:\/\/localhost:4400`/);
  const calendar = read('../src/schedule-calendar.mjs');
  assert.match(calendar, /\\\/\?\$\/i\.test\(value\)/, 'base address only, optional trailing slash');
  assert.ok(!/cadencia/i.test(notes), 'the notes use generic names');
});

test('S1: improvements and limitations stay accurate', () => {
  assert.match(line(mejoras, 'Conexiones'), /«Cuentas».*«Webhooks» y «Programación»/);
  hasLabels(conexiones, 'Conexiones.tsx', ["'Cuentas'"]);
  assert.match(line(mejoras, 'Prompter'), /ya no vuelve a la anterior/);
  assert.match(read('../app/src/lib/live.ts'), /prompterAtStart/);
  assert.match(limitaciones, /aún no se han probado con servicios reales/);
  assert.match(limitaciones, /de momento solo se cambia el título/);
  assert.match(limitaciones, /no se ha validado con OBS ni Meld reales en Windows/);
  assert.match(limitaciones, /El instalador no está firmado con un certificado de Windows/);
  assert.match(instalacion, /`antena_0\.19\.0_x64-setup\.exe`/);
  assert.match(notes, /compare\/v0\.18\.1\.\.\.0f5344f/);
  assert.match(agradecimientos, /\[@egdev6\]\(https:\/\/github\.com\/egdev6\)/);
});
