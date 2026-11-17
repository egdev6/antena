// Descarga las fuentes de la identidad EGDEV (OFL) a public/fonts para que el overlay no dependa de internet.
// Uso: pnpm fonts
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
const VERSION = '5.3.0';
// SHA-256 de cada archivo en la versión fijada del CDN de Fontsource.
const FILES = [
  ['barlow-condensed', 700, '3787a5a419171630e6890cfa47c4da067474d005cd0ff8dc11ec090fdc3ee2b8'],
  ['barlow-condensed', 800, '2515494e8cc2ca07c86ea78766cfa104b796aa6ed5d66821c01d51dbb0b52bce'],
  ['barlow', 500, 'cd759df8ef9efc98fee14307b4eb5ba27f08b1f8f2f3ad2872432e25c89907a8'],
  ['barlow', 600, '4b52ddd4836b592df0e4832b8286956883cdc651b015126bdd18f184b7f90cc3'],
  ['jetbrains-mono', 500, 'cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a'],
];

await mkdir(OUT, { recursive: true });
for (const [family, weight, expected] of FILES) {
  const name = `${family}-latin-${weight}-normal.woff2`;
  const url = `https://cdn.jsdelivr.net/fontsource/fonts/${family}@${VERSION}/latin-${weight}-normal.woff2`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`✗ ${name} (${res.status})`); process.exitCode = 1; continue; }
  const data = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) { console.error(`✗ ${name} (SHA-256 no coincide)`); process.exitCode = 1; continue; }
  await writeFile(path.join(OUT, name), data);
  console.log(`✓ ${name}`);
}
