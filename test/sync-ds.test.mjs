import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/sync-ds.mjs copia los dos artefactos del sistema de diseño (egdev-design-system) a
// public/ds/ y sella cada copia con el commit de origen. Se prueba contra un repositorio falso.
const SCRIPT = fileURLToPath(new URL('../scripts/sync-ds.mjs', import.meta.url));
const TOKENS = ':root, :host {\n  --color-primitive-red-neon: #FF0036;\n}\n';
const BUNDLE = '/* EGDEV Foundation · bundle.css */\n.eg-btn{color:var(--color-fg-default)}\n';

async function fakeDs() {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-ds-'));
  await mkdir(path.join(dir, 'packages/tokens/dist'), { recursive: true });
  await mkdir(path.join(dir, 'packages/ui/src/styles/legacy'), { recursive: true });
  await writeFile(path.join(dir, 'packages/tokens/dist/tokens.css'), TOKENS);
  await writeFile(path.join(dir, 'packages/ui/src/styles/legacy/bundle.css'), BUNDLE);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return { dir, sha: git('rev-parse', '--short', 'HEAD') };
}

// #87: a synchronous child cannot be interrupted by --test-timeout; bound it here.
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });

test('copia tokens.css y bundle.css sellados con el commit del sistema de diseño', async () => {
  const { dir, sha } = await fakeDs();
  const out = await mkdtemp(path.join(tmpdir(), 'ds-out-'));
  try {
    const r = run('--from', dir, '--to', out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `public/ds sincronizado con egdev-design-system ${sha}: tokens.css, bundle.css\n`);
    const stamp = `/* Copia de egdev-design-system ${sha} (%s). No editar: se regenera con pnpm ds:sync. */\n`;
    assert.equal(await readFile(path.join(out, 'tokens.css'), 'utf8'), stamp.replace('%s', 'packages/tokens/dist/tokens.css') + TOKENS);
    assert.equal(await readFile(path.join(out, 'bundle.css'), 'utf8'), stamp.replace('%s', 'packages/ui/src/styles/legacy/bundle.css') + BUNDLE);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('sin el artefacto de tokens compilado falla, lo explica y no toca las copias', async () => {
  const { dir } = await fakeDs();
  const out = await mkdtemp(path.join(tmpdir(), 'ds-out-'));
  try {
    await rm(path.join(dir, 'packages/tokens/dist'), { recursive: true });
    await writeFile(path.join(out, 'tokens.css'), 'previo');
    await writeFile(path.join(out, 'bundle.css'), 'previo');
    const r = run('--from', dir, '--to', out);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `No existe ${path.join(dir, 'packages/tokens/dist/tokens.css')}: compílalo con «pnpm tokens» en egdev-design-system o usa --build.\n`);
    assert.equal(await readFile(path.join(out, 'tokens.css'), 'utf8'), 'previo');
    assert.equal(await readFile(path.join(out, 'bundle.css'), 'utf8'), 'previo');
  } finally { await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

// Windows entrega rutas cortas 8.3 (RUNNER~1) que git devuelve largas: la misma carpeta escrita de
// otra forma. Un enlace (junction en Windows) reproduce ese caso en cualquier plataforma.
test('acepta el repositorio aunque --from lo nombre con una ruta no canónica', async () => {
  const { dir, sha } = await fakeDs();
  const out = await mkdtemp(path.join(tmpdir(), 'ds-out-'));
  const alias = path.join(out, 'alias-ds');
  try {
    await symlink(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const r = run('--from', alias, '--to', out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, `public/ds sincronizado con egdev-design-system ${sha}: tokens.css, bundle.css\n`);
    assert.ok((await readFile(path.join(out, 'tokens.css'), 'utf8')).endsWith(TOKENS));
  } finally { await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('una subcarpeta de otro repositorio no cuenta como el sistema de diseño', async () => {
  const { dir } = await fakeDs();
  const out = await mkdtemp(path.join(tmpdir(), 'ds-out-'));
  const sub = path.join(dir, 'packages');
  try {
    const r = run('--from', sub, '--to', out);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${sub} no es un repositorio git de egdev-design-system (usa --from o EGDEV_DS).\n`);
    assert.deepEqual(await readdir(out), []);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }); }
});

test('una ruta que no es un repositorio del sistema de diseño falla sin tocar nada', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'ds-out-'));
  const nope = path.join(out, 'no-existe');
  try {
    const r = run('--from', nope, '--to', out);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${nope} no es un repositorio git de egdev-design-system (usa --from o EGDEV_DS).\n`);
  } finally { await rm(out, { recursive: true, force: true }); }
});
