// ¿El proceso corre elevado en Windows? (High Mandatory Level, SID S-1-16-12288). Los ensayos de ACL
// reales exigen un usuario sin elevar: elevado, Windows asigna lo creado al grupo Administradores y no al
// SID del usuario, y la política de dueño protegido del helper lo rechaza (#83, runner alojado de CI).
import { execFileSync } from 'node:child_process';

export const ELEVATED_SKIP = 'Requires a non-elevated Windows user: an elevated process (hosted runner) does not own its files with the user SID';

/** true solo si Windows confirma el nivel alto; ante cualquier duda, false (el ensayo corre y falla a la vista). */
export function windowsElevated() {
  if (process.platform !== 'win32') return false;
  try { return /S-1-16-12288/.test(execFileSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true })); }
  catch { return false; }
}
