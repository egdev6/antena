#!/usr/bin/env node
// Explicit, validated partition of the same test files discovered by baseline.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { discoverTestFiles, resolveRepoRoot, testCommand, TEST_GROUPS } from './baseline.mjs';

export function groupFiles(repoRoot, group) {
  if (!TEST_GROUPS.includes(group)) throw new Error('grupo no válido');
  let manifest;
  try { manifest = JSON.parse(readFileSync(path.join(repoRoot, 'test', 'groups.json'), 'utf8')); }
  catch { throw new Error('manifiesto de grupos inválido'); }
  const files = discoverTestFiles(repoRoot);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',') !== [...TEST_GROUPS].sort().join(',') ||
      TEST_GROUPS.some(name => !Array.isArray(manifest[name]) || !manifest[name].length)) {
    throw new Error('manifiesto de grupos inválido');
  }
  const all = TEST_GROUPS.flatMap(name => manifest[name]);
  if (all.some(file => typeof file !== 'string' || !/^test\/[^/\\]+\.test\.mjs$/.test(file)) ||
      new Set(all).size !== all.length || all.length !== files.length ||
      [...all].sort().some((file, i) => file !== files[i])) {
    throw new Error('manifiesto de grupos inválido: archivos duplicados, ausentes o sin clasificar');
  }
  return [...manifest[group]].sort();
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !TEST_GROUPS.includes(args[0])) {
    process.stderr.write('grupo no válido: usa unit, browser o platform\n');
    return 1;
  }
  const root = resolveRepoRoot();
  let files;
  try { files = groupFiles(root, args[0]); }
  catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const child = spawn(process.execPath, testCommand(files, { coverage: false }), { cwd: root, env, stdio: 'inherit', shell: false });
  child.on('error', error => { process.stderr.write(`runner: ${error.code || 'error'}\n`); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
