#!/usr/bin/env node
// Copia el Node con el que ejecutas este script a src-tauri/binaries/ con el nombre que Tauri espera
// para el sidecar (node-<target-triple>[.exe]). Así la app instalada no necesita Node en el sistema.
//   pnpm desktop:node
// Usa Node 22 o superior (el mismo que pide el servidor).
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) { console.error(`Hace falta Node 22 o superior (tienes ${process.version}).`); process.exit(1); }

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
await mkdir(path.dirname(dest), { recursive: true });
await copyFile(process.execPath, dest);
if (!ext) await chmod(dest, 0o755);
const mb = ((await stat(dest)).size / 1048576).toFixed(0);
console.log(`Node ${process.version} copiado a ${path.relative(ROOT, dest)} (${mb} MB)`);
