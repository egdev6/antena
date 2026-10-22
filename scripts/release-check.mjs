#!/usr/bin/env node
// Comprueba, antes de compilar una release (#162), que la versión pedida es válida y coincide en
// package.json, src-tauri/tauri.conf.json y src-tauri/Cargo.toml. Imprime «v<versión>» si todo cuadra.
//   node scripts/release-check.mjs 0.9.0 [--root <carpeta>]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const at = args.indexOf('--root');
const root = at >= 0 ? path.resolve(args[at + 1] || '.') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = at === 0 ? undefined : args[0];
const fail = msg => { process.stderr.write(msg + '\n'); process.exit(1); };

if (!version) fail('falta la versión (p. ej. 0.9.0)');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`versión no válida: «${version}» (usa X.Y.Z, sin «v»)`);

const leer = rel => readFileSync(path.join(root, rel), 'utf8');
const cargoVersion = text => text.split(/^\[/m).find(s => s.startsWith('package]'))?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const manifiestos = [
  ['package.json', () => JSON.parse(leer('package.json')).version],
  ['src-tauri/tauri.conf.json', () => JSON.parse(leer('src-tauri/tauri.conf.json')).version],
  ['src-tauri/Cargo.toml', () => cargoVersion(leer('src-tauri/Cargo.toml'))],
];
const errores = [];
for (const [rel, get] of manifiestos) {
  let v;
  try { v = get(); } catch (e) { errores.push(`${rel}: no se pudo leer (${e.message})`); continue; }
  if (v !== version) errores.push(`${rel} tiene ${v ?? 'sin versión'}, no ${version}`);
}
if (errores.length) fail(errores.join('\n'));
process.stdout.write(`v${version}\n`);
