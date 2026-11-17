#!/usr/bin/env node
// Copia el Node con el que ejecutas este script a src-tauri/binaries/ con el nombre que Tauri espera
// para el sidecar (node-<target-triple>[.exe]). Así la app instalada no necesita Node en el sistema.
//   pnpm desktop:node
// Usa Node 24 o superior (el mismo que pide el servidor). En CI verifica el ejecutable de Windows x64
// contra SHASUMS256.txt oficial antes de copiarlo; fuera de CI conserva la copia local sin red.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) { console.error(`Hace falta Node 24 o superior (tienes ${process.version}).`); process.exit(1); }

function triple() {
  try {
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const m = out.match(/^host:\s*(\S+)/m);
    if (m) return m[1];
  } catch { /* sin Rust: se deduce de la plataforma */ }
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!arch) throw new Error('Arquitectura no soportada: ' + process.arch);
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

const t = triple();
const ext = process.platform === 'win32' ? '.exe' : '';
const dest = path.join(ROOT, 'src-tauri', 'binaries', `node-${t}${ext}`);
const fail = message => { console.error(`✗ ${message}`); process.exit(1); };
let verified;
if (process.env.CI && process.env.CI !== 'false') {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    fail('La verificación de Node en CI solo admite Windows x64.');
  }
  const filename = 'win-x64/node.exe';
  let res;
  try { res = await fetch(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`); }
  catch { fail(`No se pudo descargar SHASUMS256.txt de Node ${process.version}.`); }
  if (!res.ok) fail(`No se pudo descargar SHASUMS256.txt de Node ${process.version} (${res.status}).`);
  const entries = (await res.text()).split(/\r?\n/).filter(line => /\s\*?win-x64\/node\.exe$/.test(line));
  const expected = entries.length === 1 && entries[0].match(/^([0-9a-f]{64})  \*?win-x64\/node\.exe$/i)?.[1].toLowerCase();
  if (!expected) fail(`SHASUMS256.txt no contiene una única entrada válida para ${filename}.`);
  verified = await readFile(process.execPath);
  const actual = createHash('sha256').update(verified).digest('hex');
  if (actual !== expected) fail(`SHA-256 de Node ${process.version} no coincide con SHASUMS256.txt (${filename}).`);
}
await mkdir(path.dirname(dest), { recursive: true });
if (verified) await writeFile(dest, verified);
else await copyFile(process.execPath, dest);
if (!ext) await chmod(dest, 0o755);
const mb = ((await stat(dest)).size / 1048576).toFixed(0);
console.log(`Node ${process.version} copiado a ${path.relative(ROOT, dest)} (${mb} MB)`);
