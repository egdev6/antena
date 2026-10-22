// Descarga las fuentes de la identidad EGDEV (OFL) a public/fonts para que el overlay no dependa de internet.
// Uso: pnpm fonts
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
const FILES = [
  ['barlow-condensed', 700], ['barlow-condensed', 800],
  ['barlow', 500], ['barlow', 600],
  ['jetbrains-mono', 500],
];

await mkdir(OUT, { recursive: true });
for (const [family, weight] of FILES) {
  const name = `${family}-latin-${weight}-normal.woff2`;
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${family}@latest/latin-${weight}-normal.woff2`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`✗ ${name} (${res.status})`); process.exitCode = 1; continue; }
  await writeFile(path.join(OUT, name), Buffer.from(await res.arrayBuffer()));
  console.log(`✓ ${name}`);
}
