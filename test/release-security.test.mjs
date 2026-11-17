// Parse the restricted YAML used by the release workflow; reject unsupported constructs instead
// of silently treating anchors, aliases or flow collections as plain scalars. No YAML dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml');
const CLI = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function parseYaml(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const indent = line => line.length - line.trimStart().length;
  const skip = () => { while (i < lines.length && (!lines[i].trim() || /^\s*#/.test(lines[i]))) i++; };
  function scalar(text) {
    text = text.replace(/\s+#.*$/, '').trimEnd();
    if (/^[&*!\[{>]/.test(text)) throw new Error(`YAML no admitido: ${text}`);
    if (text.startsWith("'")) {
      assert.ok(text.endsWith("'"), `comillas incompletas: ${text}`);
      return text.slice(1, -1).replace(/''/g, "'");
    }
    if (text.startsWith('"')) return JSON.parse(text);
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null' || text === '~') return null;
    return text;
  }
  function pair(obj, text, level) {
    const m = /^([\w-]+):(?:\s+(.*))?$/.exec(text);
    assert.ok(m, `entrada YAML no admitida: ${text}`);
    const [, key, value] = m;
    assert.ok(!Object.hasOwn(obj, key), `clave YAML duplicada: ${key}`);
    if (value === '|' || value === '|-') {
      const content = [];
      while (i < lines.length && (!lines[i].trim() || indent(lines[i]) > level)) {
        content.push(lines[i].trim() ? lines[i].slice(level + 2) : '');
        i++;
      }
      obj[key] = content.join('\n');
    } else if (value === undefined) {
      skip();
      obj[key] = i < lines.length && indent(lines[i]) > level ? block(indent(lines[i])) : null;
    } else {
      obj[key] = scalar(value);
    }
  }
  function block(level) {
    skip();
    const sequence = lines[i].slice(level).startsWith('- ');
    const result = sequence ? [] : {};
    while (i < lines.length) {
      skip();
      if (i >= lines.length || indent(lines[i]) < level) break;
      assert.equal(indent(lines[i]), level, `sangría YAML inesperada: ${lines[i]}`);
      const text = lines[i++].slice(level);
      if (!sequence) {
        pair(result, text, level);
      } else {
        assert.ok(text.startsWith('- '), `elemento YAML esperado: ${text}`);
        const item = {};
        pair(item, text.slice(2), level + 2);
        skip();
        while (i < lines.length && indent(lines[i]) === level + 2) {
          const child = lines[i++].slice(level + 2);
          pair(item, child, level + 2);
          skip();
        }
        result.push(item);
      }
    }
    return result;
  }
  const result = block(0);
  skip();
  assert.equal(i, lines.length);
  return result;
}

const workflow = () => parseYaml(readFileSync(WORKFLOW, 'utf8'));
const step = (steps, name) => {
  const found = steps.filter(s => s.name === name);
  assert.equal(found.length, 1, `un paso «${name}»`);
  return found[0];
};

test('release: YAML aísla build y firma en runners y permisos distintos', () => {
  const yml = workflow();
  assert.deepEqual(Object.keys(yml.jobs), ['build', 'sign-and-release']);
  const build = yml.jobs.build;
  const release = yml.jobs['sign-and-release'];
  assert.deepEqual(Object.keys(yml.on), ['workflow_dispatch']);
  assert.equal(yml.on.workflow_dispatch.inputs.version.required, true);
  assert.equal(build['runs-on'], 'windows-2022');
  assert.equal(release['runs-on'], 'windows-2022');
  assert.equal(build.environment, undefined);
  assert.equal(build.permissions.contents, 'read');
  assert.equal(release.needs, 'build');
  assert.equal(release.environment, 'PROD-release');
  assert.equal(release.permissions.contents, 'write');
  assert.deepEqual(release.env, { VERSION: '${{ inputs.version }}' });
  assert.deepEqual(release.steps.map(s => s.name), [
    'Node', 'La release sigue sin existir', 'Descargar el instalador sin firmar',
    'Localizar el instalador para firma', 'Preparar signer verificado',
    'Secreto de firma del updater', 'Firmar el instalador', 'Comprobar firma del updater',
    'Manifiesto del updater (latest.json)', 'Conservar el instalador', 'Borrador de release',
  ]);
  assert.deepEqual(release.steps.filter(s => s.uses).map(s => s.uses), [
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ]);
  assert.doesNotMatch(JSON.stringify(build), /TAURI_SIGNING_PRIVATE_KEY|secrets\./);
  for (const env of [yml.env, build.env, release.env]) {
    assert.ok(!Object.keys(env || {}).some(k => /^TAURI_SIGNING_PRIVATE_KEY/.test(k)), 'sin secretos heredados');
  }
  assert.equal(build.steps[0].name, 'Solo desde main');
  assert.equal(build.steps[0].if, "github.ref != 'refs/heads/main'");
  assert.match(step(build.steps, 'Node').with['node-version'], /^\d+\.\d+\.\d+$/);
  assert.equal(step(build.steps, 'Node empaquetado con la app').env.CI, 'true');
  const panel = step(build.steps, 'Compilar el panel');
  const compile = step(build.steps, 'Compilar el instalador');
  assert.equal(panel.run, 'pnpm app:build');
  assert.equal(compile.run, `pnpm exec tauri build --config '{"build":{"beforeBuildCommand":null},"bundle":{"createUpdaterArtifacts":false}}' -- --locked`);
  assert.ok(build.steps.indexOf(panel) < build.steps.indexOf(compile));
  const upload = step(build.steps, 'Conservar el instalador sin firmar');
  assert.equal(upload.with.name, 'antena-windows-unsigned');
  assert.match(upload.with.path, /\$\{\{ steps\.unsigned\.outputs\.path \}\}/);
  assert.match(upload.with.path, /docs\/releases\/v\$\{\{ inputs\.version \}\}\.md/);
  assert.equal(upload.with['if-no-files-found'], 'error');
  const download = step(release.steps, 'Descargar el instalador sin firmar');
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with.path, '${{ runner.temp }}/antena-unsigned');
  assert.equal(step(release.steps, 'Conservar el instalador').with.name, 'antena-windows-installer');
  assert.ok(!release.steps.some(s => /actions\/checkout@/.test(s.uses || '')), 'sin checkout en la firma');
  for (const s of release.steps) {
    assert.doesNotMatch(s.run || '', /\b(?:pnpm|npm|npx|cargo)\b/, `sin paquetes del repo en «${s.name}»`);
    assert.doesNotMatch(s.run || '', /node\s+scripts\//, `sin scripts del repo en «${s.name}»`);
    assert.doesNotMatch(s.run || '', /\b(?:GITHUB_ENV|GITHUB_PATH|NODE_OPTIONS|BASH_ENV)\b/, `sin contaminar el entorno en «${s.name}»`);
    const usesKey = Object.keys(s.env || {}).some(k => /^TAURI_SIGNING_PRIVATE_KEY/.test(k));
    if (usesKey || JSON.stringify(s).includes('secrets.TAURI_SIGNING_PRIVATE_KEY')) {
      assert.ok(['Secreto de firma del updater', 'Firmar el instalador'].includes(s.name), s.name);
    }
  }
  for (const guard of [step(build.steps, 'La release no existe todavía'), step(release.steps, 'La release sigue sin existir')]) {
    assert.match(guard.run, /gh release view "v\$VERSION"/);
    assert.match(guard.run, /git ls-remote --exit-code --tags/);
    assert.match(guard.run, /refs\/tags\/v\$VERSION/);
    assert.match(guard.run, /\$status" -ne 2/);
    assert.match(guard.run, /exit 1/);
  }
});

test('release: las guardas rechazan releases y tags existentes y fallan cerradas ante errores', () => {
  const yml = workflow();
  const guards = [step(yml.jobs.build.steps, 'La release no existe todavía'), step(yml.jobs['sign-and-release'].steps, 'La release sigue sin existir')];
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/bash';
  const dir = mkdtempSync(path.join(tmpdir(), 'antena-release-guard-'));
  const calls = path.join(dir, 'git-calls');
  try {
    for (const guard of guards) {
      for (const row of [
        { gh: 0, git: 2, status: 1, out: '::error::Ya existe la release v1.2.3 (borrador o publicada).\n', called: false },
        { gh: 1, git: 0, status: 1, out: '::error::Ya existe el tag v1.2.3.\n', called: true },
        { gh: 1, git: 128, status: 1, out: '::error::No se pudo comprobar el tag v1.2.3.\n', called: true },
        { gh: 1, git: 2, status: 0, out: '', called: true },
      ]) {
        writeFileSync(calls, '');
        const prefix = 'gh() { return "$GH_STATUS"; }\ngit() { printf "%s\\n" "$*" >> "$CALLS"; return "$GIT_STATUS"; }\n';
        const r = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', prefix + guard.run], {
          encoding: 'utf8', timeout: 60_000,
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, VERSION: '1.2.3', GITHUB_REPOSITORY: 'egdev6/antena', GH_STATUS: String(row.gh), GIT_STATUS: String(row.git), CALLS: calls },
        });
        assert.equal(r.status, row.status, r.stderr);
        assert.equal(r.stdout, row.out);
        assert.equal(r.stderr, '');
        assert.equal(readFileSync(calls, 'utf8'), row.called ? 'ls-remote --exit-code --tags https://github.com/egdev6/antena.git refs/tags/v1.2.3\n' : '');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release: el signer independiente está fijado al CLI y a las integridades del lockfile', () => {
  const steps = workflow().jobs['sign-and-release'].steps;
  const prepare = step(steps, 'Preparar signer verificado');
  const version = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'package.json'), 'utf8')).version;
  const lock = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  for (const pkg of ['cli', 'cli-win32-x64-msvc']) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entry = lock.match(new RegExp(`'@tauri-apps/${escaped}@${version}':\\n\\s+resolution: \\{integrity: (sha512-[^}]+)\\}`));
    assert.ok(entry, `integridad de ${pkg} en lockfile`);
    assert.ok(prepare.run.includes(entry[1]), `integridad fijada de ${pkg}`);
    assert.ok(prepare.run.includes(`https://registry.npmjs.org/@tauri-apps/${pkg}/-/${pkg}-${version}.tgz`));
  }
  assert.match(prepare.run, /createHash\('sha512'\)/);
  assert.match(prepare.run, /tar -xzf/);
  const locate = step(steps, 'Localizar el instalador para firma');
  const sign = step(steps, 'Firmar el instalador');
  const check = step(steps, 'Comprobar firma del updater');
  const manifest = step(steps, 'Manifiesto del updater (latest.json)');
  assert.equal(sign.shell, 'bash');
  assert.deepEqual(sign.env, {
    TAURI_SIGNING_PRIVATE_KEY: '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}',
    EXE: '${{ steps.exe.outputs.path }}',
  });
  assert.equal(sign.run, 'node "$RUNNER_TEMP/tauri-signer/node_modules/@tauri-apps/cli/tauri.js" signer sign --app-version "$VERSION" "$EXE"');
  assert.equal(check.env.EXE, '${{ steps.exe.outputs.path }}');
  assert.match(check.run, /test -s "\$EXE\.sig"/);
  assert.ok(steps.indexOf(prepare) < steps.indexOf(sign));
  assert.ok(steps.indexOf(locate) < steps.indexOf(sign));
  assert.ok(steps.indexOf(sign) < steps.indexOf(check));
  assert.ok(steps.indexOf(check) < steps.indexOf(manifest));
  assert.match(manifest.run, /readFileSync\(`\$\{EXE\}\.sig`, 'utf8'\)/);
});

function signerFixture(mode) {
  const prepare = step(workflow().jobs['sign-and-release'].steps, 'Preparar signer verificado').run;
  const script = prepare.match(/node --input-type=module - <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  assert.ok(script, 'script de verificación del workflow');
  const hash = 'sha512-' + createHash('sha512').update('synthetic-package').digest('base64');
  const dir = mkdtempSync(path.join(tmpdir(), 'antena-release-signer-'));
  const signer = path.join(dir, 'tauri-signer');
  mkdirSync(signer);
  writeFileSync(path.join(signer, 'cli.tgz'), 'original');
  const preload = path.join(dir, 'preload.mjs');
  const log = path.join(dir, 'requests');
  writeFileSync(preload, `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async url => {
  appendFileSync(process.env.REQUEST_LOG, url + '\\n');
  const addon = url.includes('cli-win32-x64-msvc');
  if (process.env.MODE === 'http' && !addon) return new Response('', { status: 503 });
  const tampered = process.env.MODE === (addon ? 'addon' : 'cli');
  return new Response(tampered ? 'tampered-package' : 'synthetic-package');
};
`);
  const run = () => spawnSync(process.execPath, ['--import', preload, '--input-type=module', '-'], {
    input: script.replace(/sha512-[A-Za-z0-9+/=]+/g, hash), encoding: 'utf8', timeout: 60_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RUNNER_TEMP: dir, REQUEST_LOG: log, MODE: mode },
  });
  return { dir, signer, log, run };
}

test('release: bootstrap del signer verifica ambos paquetes antes de guardarlos', () => {
  const f = signerFixture('ok');
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'Signer de Tauri 2.12.3 verificado.\n');
    assert.equal(r.stderr, '');
    assert.equal(readFileSync(path.join(f.signer, 'cli.tgz'), 'utf8'), 'synthetic-package');
    assert.equal(readFileSync(path.join(f.signer, 'cli-win32-x64-msvc.tgz'), 'utf8'), 'synthetic-package');
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('release: bootstrap rechaza paquetes alterados o no disponibles sin guardar nada', () => {
  for (const { mode, error, requests } of [
    { mode: 'cli', error: '✗ SHA-512 no coincide para cli.tgz.\n', requests: 1 },
    { mode: 'addon', error: '✗ SHA-512 no coincide para cli-win32-x64-msvc.tgz.\n', requests: 2 },
    { mode: 'http', error: '✗ No se pudo descargar cli.tgz (503).\n', requests: 1 },
  ]) {
    const f = signerFixture(mode);
    try {
      const r = f.run();
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, error);
      assert.equal(readFileSync(path.join(f.signer, 'cli.tgz'), 'utf8'), 'original');
      assert.throws(() => readFileSync(path.join(f.signer, 'cli-win32-x64-msvc.tgz')), { code: 'ENOENT' });
      assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, requests);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('tauri signer produce un .sig con la versión usando una clave sintética', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'antena-signer-'));
  try {
    const key = path.join(dir, 'synthetic.key');
    const exe = path.join(dir, 'antena_1.2.3_x64-setup.exe');
    writeFileSync(exe, 'synthetic installer');
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const generate = spawnSync(process.execPath, [CLI, 'signer', 'generate', '--ci', '-p', 'synthetic-password', '-w', key], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(generate.status, 0, generate.stderr);
    const sign = spawnSync(process.execPath, [CLI, 'signer', 'sign', '--app-version', '1.2.3', exe], {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
      env: { ...env, TAURI_SIGNING_PRIVATE_KEY: readFileSync(key, 'utf8'), TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'synthetic-password' },
    });
    assert.equal(sign.status, 0, sign.stderr);
    const signature = readFileSync(`${exe}.sig`, 'utf8').trim();
    assert.ok(signature.length > 0);
    assert.match(Buffer.from(signature, 'base64').toString('utf8'), /trusted comment:.*1\.2\.3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
