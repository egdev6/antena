#!/usr/bin/env node
// Política de CI ODD-24; no cambia la política de skips del baseline local.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTap, SCHEMA } from './baseline.mjs';

export const REQUIRED_BROWSER_TESTS = [
  'prompter React: guardar una marca libera la cronología (Enter/blur, SSE y fallo)',
  'panel React: el aviso de configuración/secretos persiste, no finge guardado y se recupera sin recargar',
];

const WINDOWS_POSIX_SKIPS = [
  'POSIX-only: real app boot with POSIX file modes; Windows ACL equivalent in held-recovery-windows-storage.test.mjs',
  'POSIX-only: real SIGINT shutdown with POSIX file modes; Windows ACL equivalent in held-recovery-windows-storage.test.mjs',
  'POSIX filesystem contract; native Windows ACL equivalent in held-recovery-windows-storage.test.mjs',
  'Linux-only platform guard',
  // ensayos de ACL reales: un proceso elevado (runner alojado) no es dueño de sus ficheros con el SID
  // del usuario; en un Windows sin elevar sí se ejecutan (#83)
  'Requires a non-elevated Windows user: an elevated process (hosted runner) does not own its files with the user SID',
];

export function checkCiBaseline(report, tap) {
  const errors = [], skips = [];
  if (report?.schema !== SCHEMA || report?.ok !== true || report?.runner?.exitCode !== 0) {
    errors.push('baseline ausente, inválido o no OK');
  }
  const parsed = parseTap(tap);
  if (parsed.plan !== parsed.tests.length) errors.push('plan raíz no coincide con los registros TAP');
  if (!parsed.complete || parsed.counts.total === 0 || parsed.counts.fail !== 0 ||
      parsed.counts.cancelled !== 0 || parsed.counts.todo !== 0) errors.push('TAP incompleto o con fallos, cancelaciones o TODO');
  for (const [key, value] of Object.entries(parsed.counts)) {
    if (report?.tests?.counts?.[key] !== value) errors.push(`JSON/TAP discrepan en ${key}`);
  }
  // Incluye directivas anidadas: el parser del baseline solo enumera la raíz.
  const records = String(tap ?? '').split(/\r?\n/).flatMap(line => {
    const match = /^\s*(ok|not ok) \d+ - (.*)$/.exec(line);
    if (!match) return [];
    const directive = /(?<!\\)#\s*(SKIP|TODO)\b\s*(.*)$/i.exec(match[2]);
    return [{ ok: match[1] === 'ok', name: directive ? match[2].slice(0, directive.index).trim() : match[2],
      directive: directive?.[1].toUpperCase(), reason: directive?.[2].trim() ?? '' }];
  });
  for (const record of records) {
    if (!record.ok || record.directive === 'TODO') errors.push(`fallo o TODO en TAP: ${record.name}`);
  }
  for (const name of REQUIRED_BROWSER_TESTS) {
    const matches = records.filter(record => record.name === name);
    if (matches.length !== 1 || !matches[0].ok || matches[0].directive) errors.push(`regresión de navegador no ejecutada: ${name}`);
  }
  for (const record of records.filter(record => record.directive === 'SKIP')) {
    const ipv6 = record.reason === 'sin loopback IPv6 en este entorno';
    const windowsSymlink = report?.environment?.platform === 'win32' &&
      /^(?:alias symlink no soportado en esta plataforma|symlink de directorio no soportado en esta plataforma|symlink no soportado(?: en esta plataforma)?) \((?:EPERM|ENOTSUP)\)$/.test(record.reason);
    // Ensayos Windows reales (#47): solo se ejecutan en win32; fuera de Windows se
    // omiten con estos motivos exactos y eso es parte de la política, no un skip crítico.
    const windowsReal = report?.environment?.platform !== 'win32' &&
      (record.reason === 'Requires Windows PowerShell 5.1 and real NTFS ACLs; not established on Linux' ||
        record.reason === 'Requires real Windows/NTFS/PowerShell ACLs; NOT validated on Linux');
    // Contratos POSIX (#83): en win32 se omiten con estos motivos exactos; su equivalente
    // nativo es el ensayo real de ACL de Windows. Fuera de Windows nunca se omiten.
    const posixOnly = report?.environment?.platform === 'win32' && WINDOWS_POSIX_SKIPS.includes(record.reason);
    const allowed = ipv6 || windowsSymlink || windowsReal || posixOnly;
    skips.push({ name: record.name, reason: record.reason, allowed });
    if (!allowed) errors.push(`skip no permitido: ${record.name}`);
  }
  if (skips.length !== parsed.counts.skipped) errors.push('no se pudieron enumerar todos los skips');
  return { ok: errors.length === 0, errors, skips };
}

export function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 2) throw new Error('usage');
    const result = checkCiBaseline(JSON.parse(readFileSync(args[0], 'utf8')), readFileSync(args[1], 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch {
    // No ecoar argumentos, rutas o contenido potencialmente sensible.
    console.error('CI baseline: se requieren un informe JSON válido y su TAP legible');
    return 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
