import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = rel => {
  const file = new URL(rel, import.meta.url);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const notes = read('../docs/releases/v0.17.0.md');
const section = title => notes.split(`### ${title}\n`)[1]?.split(/\n### /)[0] ?? '';
const novedades = section('Novedades');
const mejoras = section('Mejoras');
const importante = section('Importante');
const limitaciones = section('Limitaciones conocidas');
const instalacion = section('Instalación y actualización');
const agradecimientos = section('Agradecimientos');
const line = (text, needle) => text.split('\n').find(l => l.includes(needle)) ?? '';

test('S1: versions are synchronized to 0.17.0', () => {
  assert.equal(JSON.parse(read('../package.json')).version, '0.17.0');
  assert.equal(JSON.parse(read('../src-tauri/tauri.conf.json')).version, '0.17.0');
  assert.match(read('../src-tauri/Cargo.toml'), /^version = "0\.17\.0"$/m);
  assert.match(read('../src-tauri/Cargo.lock'), /name = "antena"\nversion = "0\.17\.0"/);
});

test('S1: the headline names the dock, the subscriber alert and security', () => {
  assert.match(notes, /^## antena 0\.17\.0 — Dock a tu medida, «\+N suscriptores» y más seguridad$/m);
});

test('S1: the dock editor claims match the panel labels', () => {
  const dock = line(novedades, 'Dock a tu medida');
  assert.match(dock, /\*\*Paneles › Vista\*\*/);
  assert.match(dock, /Automática — recomendada, Pestañas, Columnas, Partida arriba y abajo o Lado a lado/);
  assert.match(dock, /vista previa en vivo/i);
  assert.match(dock, /\*\*Restablecer el dock de serie\*\*/);
  const editor = read('../app/src/panel/views/DockEditor.tsx');
  for (const label of ['Automática — recomendada', 'Pestañas', 'Columnas', 'Partida arriba y abajo', 'Lado a lado', 'Restablecer el dock de serie', 'Atajos']) {
    assert.ok(editor.includes(label), `missing panel label ${label}`);
  }
  assert.match(line(novedades, 'Módulo Atajos'), /viene desactivado/i);
});

test('S1: the subscriber alert is described with its toggle and limits', () => {
  assert.match(line(novedades, '+N suscriptores'), /puedes desactivarla en \*\*Conexiones › YouTube\*\*/i);
  assert.match(limitaciones, /solo compara totales exactos por debajo de 1\.000/i);
});

test('S1: the Nexo tray is Windows-only and falls back to the usual icon', () => {
  const nexo = line(novedades, 'Bandeja unificada de Nexo');
  assert.match(nexo, /\(Windows\)/);
  assert.match(nexo, /si el hub se cierra o falla, vuelve el icono de siempre/i);
  assert.match(limitaciones, /la bandeja unificada de Nexo solo existe en Windows/i);
});

test('S1: security improvements are listed without overstating', () => {
  assert.match(mejoras, /un archivo multimedia, como un SVG, ya no puede ejecutar código en el panel/i);
  assert.match(mejoras, /te vuelve a pedir que apruebes sus permisos/i);
  assert.match(mejoras, /sin las credenciales que incluyan; si guardas sin tocarlas, se conservan/i);
  assert.match(mejoras, /solo se puede hacer desde tu propio equipo/i);
  assert.match(mejoras, /mismo usuario de Windows/i);
  assert.match(mejoras, /paso separado de la compilación, que requiere aprobación/i);
});

test('S1: integration changes are flagged as important', () => {
  assert.match(importante, /`confirmar: true`/);
  assert.match(importante, /no un control de permisos/i);
  assert.match(importante, /`program\.recordOnStart` y `program\.autoSession` en lugar de `meld\.\*`/);
  assert.match(importante, /las rutas antiguas se siguen aceptando al escribir/i);
  assert.match(importante, /solo si hace falta cambiar algo y guarda antes una copia de seguridad/i);
  assert.match(importante, /se mantienen los alias `\/api\/meld\*` y `meld_\*`/);
});

test('S1: known limitations keep OBS experimental and the unsigned installer', () => {
  assert.match(limitaciones, /no se ha validado con OBS ni Meld reales en Windows/i);
  assert.match(limitaciones, /https:\/\/github\.com\/egdev6\/antena\/issues\/190/);
  assert.match(limitaciones, /el instalador no está firmado con un certificado de Windows/i);
});

test('S1: installation keeps both paths with the new installer name', () => {
  assert.match(instalacion, /antena_0\.17\.0_x64-setup\.exe/);
  assert.match(instalacion, /si ya tienes la 0\.10\.0 o posterior y puedes abrir el panel/i);
  assert.match(instalacion, /Buscar actualizaciones.*Descargar y reiniciar/i);
  assert.match(notes, /%APPDATA%\\es\.egdev\.antena/);
});

test('S1: the technical link is pinned to the candidate commit', () => {
  assert.match(notes, /https:\/\/github\.com\/egdev6\/antena\/compare\/v0\.16\.0\.\.\.3b25aadc1b8c892334b56729929190ec2ff922d4\)/);
});

test('S1: thanks only credit verified participation and no unverified claims appear', () => {
  assert.match(agradecimientos, /\[@egdev6\]\(https:\/\/github\.com\/egdev6\)/);
  assert.doesNotMatch(agradecimientos, /\b(?:probado|revisado)\b/i);
  assert.doesNotMatch(notes, /\bprobad[oa]s?\b/i);
  assert.doesNotMatch(notes.replace(/no se ha validado con OBS ni Meld reales en Windows/i, ''), /validad[oa]/i);
  assert.doesNotMatch(notes, /actualizaci[oó]n(?:es)? autom[aá]tica/i);
  assert.doesNotMatch(notes, /(?<!no )está firmado/i);
});
