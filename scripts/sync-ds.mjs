// Sincroniza los artefactos del sistema de diseño y registra el commit de origen.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  from: { type: 'string' }, to: { type: 'string' }, build: { type: 'boolean' },
} });
const from = path.resolve(values.from ?? (process.env.EGDEV_DS || path.join(root, '../egdev-design-system')));
const to = path.resolve(values.to ?? path.join(root, 'public/ds'));
const files = [
  ['packages/tokens/dist/tokens.css', 'tokens.css'],
  ['packages/ui/src/styles/legacy/bundle.css', 'bundle.css'],
];

const git = (...args) => spawnSync('git', ['-C', from, ...args], { encoding: 'utf8' });
const top = git('rev-parse', '--show-toplevel');
const commit = git('rev-parse', '--short', 'HEAD');
if (top.status !== 0 || commit.status !== 0 || path.resolve(top.stdout.trim()) !== from) {
  console.error(`${from} no es un repositorio git de egdev-design-system (usa --from o EGDEV_DS).`);
  process.exit(1);
}
const sha = commit.stdout.trim();

if (values.build) {
  const build = spawnSync('pnpm', ['tokens'], { cwd: from, stdio: 'inherit' });
  if (build.status !== 0) {
    if (build.error) console.error(build.error.message);
    process.exit(build.status || 1);
  }
}

// Leer ambos artefactos antes de tocar el destino evita copias parciales por archivos ausentes.
const copies = [];
for (const [source, name] of files) {
  const absolute = path.join(from, source);
  let content;
  try {
    content = await readFile(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    console.error(`No existe ${absolute}: compílalo con «pnpm tokens» en egdev-design-system o usa --build.`);
    process.exit(1);
  }
  const stamp = `/* Copia de egdev-design-system ${sha} (${source}). No editar: se regenera con pnpm ds:sync. */\n`;
  copies.push([name, Buffer.concat([Buffer.from(stamp), content])]);
}
await mkdir(to, { recursive: true });
for (const [name, content] of copies) await writeFile(path.join(to, name), content);
console.log(`public/ds sincronizado con egdev-design-system ${sha}: tokens.css, bundle.css`);
