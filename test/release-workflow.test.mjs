// Release manual (#162): comprobación de versión antes de compilar y forma del workflow.
// El workflow no se puede ejecutar aquí; se prueba el script que usa y su estructura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'release-check.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');

function repo({ pkg = '0.9.0', tauri = '0.9.0', cargo = '0.9.0' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'egdev-release-check-'));
  mkdirSync(path.join(dir, 'src-tauri'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'antena', version: pkg }));
  writeFileSync(path.join(dir, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ productName: 'antena', version: tauri }));
  writeFileSync(path.join(dir, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "antena"\nversion = "${cargo}"\n\n[dependencies]\nserde = { version = "1" }\n`);
  return dir;
}
// #87: a synchronous child cannot be interrupted by --test-timeout; bound it here.
const check = (args, cwd = ROOT) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });

test('release-check acepta la versión cuando coincide en los tres manifiestos', () => {
  const dir = repo();
  try {
    const r = check(['0.9.0', '--root', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'v0.9.0');
    assert.equal(r.stderr, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release-check rechaza una versión distinta y nombra el manifiesto', () => {
  const dir = repo({ cargo: '0.8.0' });
  try {
    const r = check(['0.9.0', '--root', dir]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /src-tauri\/Cargo\.toml tiene 0\.8\.0, no 0\.9\.0/);
    const otra = check(['1.0.0', '--root', repo()]);
    assert.equal(otra.status, 1);
    assert.match(otra.stderr, /package\.json tiene 0\.9\.0, no 1\.0\.0/);
    writeFileSync(path.join(dir, 'src-tauri', 'tauri.conf.json'), '{ roto');
    const rota = check(['0.9.0', '--root', dir]);
    assert.equal(rota.status, 1);
    assert.match(rota.stderr, /src-tauri\/tauri\.conf\.json: no se pudo leer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release-check rechaza versiones mal formadas o ausentes', () => {
  for (const v of ['', 'v0.9.0', '0.9', '0.9.0; rm -rf /', '$(id)']) {
    const r = check(v ? [v] : []);
    assert.equal(r.status, 1, `«${v}»`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /versión no válida|falta la versión/, `«${v}»`);
  }
});

test('la versión del repositorio coincide en los tres manifiestos y tiene sus notas', () => {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const r = check([version]);
  assert.equal(r.status, 0, r.stderr);
  const notas = readFileSync(path.join(ROOT, 'docs', 'releases', `v${version}.md`), 'utf8');
  assert.match(notas, /no está firmado/, 'las notas avisan del instalador sin firma');
  assert.match(notas, /### Agradecimientos/);
});

test('el workflow de release es manual, solo desde main y crea un borrador: instalador sin firma de código de Windows, actualización firmada', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const on = yml.match(/^on:\n([\s\S]*?)^\S/m)?.[1] || '';
  assert.match(on, /^\s+workflow_dispatch:/m, 'se lanza a mano');
  assert.doesNotMatch(on, /^\s+(push|pull_request|release|schedule|workflow_run):/m, 'sin disparadores automáticos');
  assert.match(yml, /^permissions:\s*\n\s+contents: read/m, 'permisos por defecto de solo lectura');
  assert.match(yml, /runs-on: windows-2022/);
  const pasos = yml.split(/^ {6}- name: /m).slice(1);
  assert.match(pasos[0], /^Solo desde main\n\s+if: github\.ref != 'refs\/heads\/main'[\s\S]*exit 1/, 'la guarda de main es el primer paso y corta');
  assert.match(yml, /^ {4}permissions:\s*\n\s+contents: write/m, 'escritura solo en el job');
  const version = pasos.find(p => p.startsWith('Comprobar la versión')) || '';
  assert.match(version, /node scripts\/release-check\.mjs "\$VERSION"/, 'comprueba la versión por variable de entorno');
  assert.match(version, /test -f "docs\/releases\/v\$VERSION\.md"/, 'las notas se comprueban antes de compilar');
  for (const p of pasos) {
    const run = p.match(/^ {8}run: ?\|?\n?([\s\S]*?)(?=^ {8}\S|(?![\s\S]))/m)?.[1] || '';
    assert.doesNotMatch(run, /\$\{\{/, `«${p.split('\n')[0]}»: nada de \${{ }} dentro de run`);
  }
  assert.match(yml, /bundle\/nsis\/antena_"\$VERSION"_x64-setup\.exe/, 'nombre exacto del instalador');
  assert.match(yml, /timeout-minutes: 90/);
  assert.match(yml, /pnpm install --frozen-lockfile/);
  assert.match(yml, /pnpm fonts/, 'el instalador lleva las fuentes de la marca (public/fonts no está en git)');
  assert.match(yml, /pnpm desktop:node/);
  assert.match(yml, /pnpm desktop:build/);
  assert.match(yml, /gh release create "v\$VERSION"[^\n]*--draft/, 'crea un borrador');
  // El updater nativo (ODD antena-ux-ajustes L3) firma la actualización con minisign; el instalador
  // sigue sin firma de código de Windows (Authenticode).
  assert.doesNotMatch(yml, /certificate|signtool|authenticode/i, 'sin firma de código de Windows');
  const secretos = new Set([...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]));
  for (const s of secretos) assert.ok(['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'GITHUB_TOKEN'].includes(s), `secreto no previsto: ${s}`);
  for (const linea of yml.split('\n').filter(l => /\$\{\{\s*secrets\./.test(l))) {
    assert.match(linea, /^ {10}TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)? \}\}$/, `los secretos solo van en env: ${linea.trim()}`);
  }
  for (const p of pasos.filter(p => /secrets\./.test(p))) assert.match(p, /^ {8}env:\n/m, `«${p.split('\n')[0]}»: los secretos entran por env`);
  const borrador = pasos.find(p => p.startsWith('Borrador de release')) || '';
  assert.match(borrador, /gh release create "v\$VERSION" "\$EXE" "\$EXE\.sig" latest\.json [^\n]*--draft/, 'el borrador lleva la firma y latest.json');
  for (const uses of yml.match(/uses: \S+/g) || []) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} fijada por SHA`);
});

// Updater signing guards (ODD antena-ux-ajustes L3): without them a release could ship with the
// placeholder public key, without signing, or with a latest.json the app cannot verify.
const pasosDe = yml => yml.split(/^ {6}- name: /m).slice(1);
const paso = (pasos, nombre) => pasos.findIndex(p => p.startsWith(nombre));

test('release: las guardas de la clave pública y del secreto de firma cortan antes de compilar', () => {
  const pasos = pasosDe(readFileSync(WORKFLOW, 'utf8'));
  const compilar = paso(pasos, 'Compilar el instalador');
  assert.ok(compilar > 0, 'existe el paso de compilación');
  const pubkey = paso(pasos, 'Clave pública del updater configurada');
  assert.ok(pubkey >= 0 && pubkey < compilar, 'la guarda de la clave pública va antes de compilar');
  assert.match(pasos[pubkey], /grep -q 'PLACEHOLDER_UPDATER_PUBKEY' src-tauri\/tauri\.conf\.json[\s\S]*exit 1/, 'el marcador de la clave pública corta la release');
  const secreto = paso(pasos, 'Secreto de firma del updater');
  assert.ok(secreto >= 0 && secreto < compilar, 'la guarda del secreto de firma va antes de compilar');
  assert.match(pasos[secreto], /^ {10}TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}$/m, 'la guarda recibe el secreto por env');
  assert.match(pasos[secreto], /if \[ -z "\$\{TAURI_SIGNING_PRIVATE_KEY:-\}" \]; then[\s\S]*exit 1/, 'sin la clave de firma la release se corta');
});

test('release: la firma del instalador tiene que existir y no estar vacía', () => {
  const pasos = pasosDe(readFileSync(WORKFLOW, 'utf8'));
  const localizar = pasos[paso(pasos, 'Localizar el instalador')] || '';
  assert.match(localizar, /test -s "\$exe\.sig" \|\| \{[^}]*exit 1; \}/, 'sin .sig (o vacío) la release se corta');
});

test('release: latest.json lleva windows-x86_64 con la firma y la URL de la release', () => {
  const pasos = pasosDe(readFileSync(WORKFLOW, 'utf8'));
  const i = paso(pasos, 'Manifiesto del updater (latest.json)');
  assert.ok(i > paso(pasos, 'Localizar el instalador') && i < paso(pasos, 'Borrador de release'), 'el manifiesto se genera tras localizar el .sig y antes del borrador');
  const script = pasos[i].match(/node --input-type=module - <<'NODE'\n([\s\S]*?)\n {10}NODE\n/)?.[1];
  assert.ok(script, 'el paso genera latest.json con un script de Node');
  // se ejecuta el script del workflow tal cual sobre un .sig y unas notas falsas
  const dir = mkdtempSync(path.join(tmpdir(), 'egdev-latest-json-'));
  try {
    mkdirSync(path.join(dir, 'docs', 'releases'), { recursive: true });
    writeFileSync(path.join(dir, 'docs', 'releases', 'v1.2.3.md'), '# notas\r\nhola\r\n');
    const exe = path.join(dir, 'antena_1.2.3_x64-setup.exe');
    writeFileSync(exe + '.sig', 'firma-de-prueba\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: dir, input: script.replace(/^ {10}/gm, ''), encoding: 'utf8',
      env: { ...process.env, VERSION: '1.2.3', EXE: exe, GITHUB_REPOSITORY: 'egdev6/antena' },
    });
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8'));
    assert.equal(manifest.version, '1.2.3');
    assert.equal(manifest.notes, '# notas\nhola\n');
    const win = manifest.platforms?.['windows-x86_64'];
    assert.ok(win, 'plataforma windows-x86_64');
    assert.equal(win.signature, 'firma-de-prueba', 'la firma es el contenido del .sig');
    assert.equal(win.url, 'https://github.com/egdev6/antena/releases/download/v1.2.3/antena_1.2.3_x64-setup.exe');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
