// Capacidad aislada: sin IO de payload, reparación de ACL, diario, apagado ni repetición.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./held-recovery-windows.ps1', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const failure = () => Object.assign(new Error('Windows held recovery unavailable'), { code: 'EHELDWINDOWS' });
function localPath(value) {
  if (typeof value !== 'string' || !/^[a-z]:\\/i.test(value) || /[\x00-\x1f<>:"|?*]/.test(value.slice(3))) throw failure();
  if (value !== path.win32.normalize(value) || value.includes('/') || (value.length > 3 && value.endsWith('\\'))) throw failure();
  for (const part of value.slice(3).split('\\').filter(Boolean)) {
    if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) throw failure();
  }
  return value;
}

async function realRunner(exe, args, options, callback) {
  try {
    if (process.platform !== 'win32') throw failure();
    // Límite de confianza conservador: solo instalación local estándar de Windows.
    // Nunca se busca en PATH; se rechazan enlaces/junctions en todo el linaje del binario.
    let current = path.win32.parse(exe).root;
    for (const part of exe.slice(current.length).split('\\')) {
      current = path.win32.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw failure();
      if (current !== exe && !stat.isDirectory()) throw failure();
      if (current === exe && !stat.isFile()) throw failure();
    }
    if ((await fs.realpath(exe)).toLowerCase() !== exe.toLowerCase()) throw failure();
    execFile(exe, args, options, callback);
  } catch { callback(failure()); }
}

// Ambas entradas son confianza explícita del arnés de pruebas, NO autenticación de la instalación del SO.
// tempDir must be an existing private scratch directory provisioned by the harness.
export function windowsHeldEnvironment({ systemRoot, tempDir }) {
  if (typeof systemRoot !== 'string' || !/^[a-z]:\\windows$/i.test(systemRoot)) throw failure();
  tempDir = localPath(tempDir);
  if (tempDir.length === 3) throw failure();
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  // Sin PATH, perfil, credenciales, ajustes de Node ni rutas de módulo arbitrarias del entorno.
  // El CodeDOM del framework localiza csc en Windows/.NET; sin dependencia de pwsh moderno.
  return Object.freeze({
    SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: tempDir, TMP: tempDir,
    PATH: [path.win32.join(systemRoot, 'System32'), powershell,
      path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
      path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319')].join(';'),
    PSModulePath: path.win32.join(powershell, 'Modules'),
  });
}

export function createWindowsHeldRecovery({ base, systemRoot, tempDir, runner = realRunner }) {
  base = localPath(base);
  const env = windowsHeldEnvironment({ systemRoot, tempDir });
  if (typeof runner !== 'function') throw failure();
  const exe = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const root = path.win32.join(base, 'held-recovery');
  async function invoke(operation, batch, leaf) {
    if ((batch !== undefined && (typeof batch !== 'string' || !UUID.test(batch))) ||
        (!['create-namespace', 'verify-directory', 'inspect-namespace'].includes(operation) && batch === undefined) ||
        (operation === 'verify-file' && !['batch.json', '.batch.tmp'].includes(leaf)) ||
        (operation === 'create-temp' && leaf !== '.batch.tmp')) throw failure();
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Operation', operation, '-Base', base];
    if (batch !== undefined) args.push('-Batch', batch);
    if (leaf !== undefined) args.push('-Leaf', leaf);
    const state = await new Promise((resolve, reject) => {
      try {
        // Copia por llamada: execFile puede añadir NODE_V8_COVERAGE al env y el contrato público sigue congelado.
        runner(exe, args, { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', env: { ...env } },
          (error, stdout, stderr) => {
            try {
              if (error || stderr !== '' || typeof stdout !== 'string' || stdout.length > 4096) throw failure();
              const result = JSON.parse(stdout);
              const inspect = operation === 'inspect-namespace';
              if (result?.version !== 1 || result.ok !== true ||
                  Object.keys(result).sort().join(',') !== (inspect ? 'ok,state,version' : 'ok,version') ||
                  (inspect && !['absent', 'valid'].includes(result.state))) throw failure();
              resolve(inspect ? result.state : undefined);
            } catch { reject(failure()); }
          });
      } catch { reject(failure()); }
    });
    if (operation === 'inspect-namespace') return state;
    return batch === undefined ? root : path.win32.join(root, batch, ...(leaf === undefined ? [] : [leaf]));
  }
  return {
    // Resultado de cadena cerrada y de solo lectura; la ausencia nunca se infiere de un fallo genérico.
    inspectNamespace: () => invoke('inspect-namespace'),
    createNamespace: () => invoke('create-namespace'),
    createBatch: batch => invoke('create-batch', batch),
    createTemp: batch => invoke('create-temp', batch, '.batch.tmp'),
    verifyDirectory: batch => invoke('verify-directory', batch),
    verifyFile: (batch, leaf) => invoke('verify-file', batch, leaf),
  };
}
