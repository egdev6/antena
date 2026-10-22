import assert from 'node:assert/strict';

// Aviso constante de src/server.mjs cuando la revisión de alertas retenidas no está
// disponible. En win32 el arranque sin configuración de recuperación de Windows lo emite
// siempre (docs/estado.md: «bloqueada o no disponible»); en POSIX estos hijos no lo emiten.
export const HELD_RECOVERY_BLOCKED = '[recuperación] Revisión de alertas retenidas bloqueada o no disponible; sin ejecución automática.';

/** En win32 exige exactamente una línea `prefix + aviso` y la retira para que el resto
 *  de aserciones siga siendo estricto. En otras plataformas devuelve el texto intacto. */
export function withoutHeldRecoveryWarning(text, { prefix = '', platform = process.platform } = {}) {
  if (platform !== 'win32') return text;
  const line = (prefix + HELD_RECOVERY_BLOCKED).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${line}(?:\\r?\\n|$)`, 'gm');
  assert.equal((text.match(re) || []).length, 1, 'win32: el aviso de recuperación aparece exactamente una vez: ' + text);
  return text.replace(re, '');
}
