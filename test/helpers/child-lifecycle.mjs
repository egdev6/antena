import { performance } from 'node:perf_hooks';
import { constants } from 'node:os';

const signals = new Set(Object.keys(constants.signals));
const errorCodes = new Set(['ERR_SIGNAL_CONTROLLER', 'ENOENT', 'EACCES', 'EPERM', 'EPIPE',
  'ECONNRESET', 'ETIMEDOUT', 'EIO', 'ENOTSUP', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
const code = value => Number.isInteger(value) ? value : null;
const signal = value => signals.has(value) ? value : null;
const flag = value => typeof value === 'boolean' ? value : null;

// Observación local de eventos reportados, no del instante de salida del kernel.
// El propietario debe mantener su propio handler de error; no se añaden timers,
// señales, lecturas de archivos, PIDs ni contenido de streams al diagnóstico.
export function observeChildLifecycle(child, { now = () => performance.now() } = {}) {
  const started = now();
  const atMs = () => Math.max(0, Math.round(now() - started));
  let exitEvent = null, closeEvent = null;
  const errors = [];
  const onError = error => {
    if (errors.length < 4) errors.push({ atMs: atMs(), code: errorCodes.has(error?.code) ? error.code : 'OTHER' });
  };
  child.once('exit', (exitCode, signalCode) => {
    exitEvent = { atMs: atMs(), code: code(exitCode), signal: signal(signalCode) };
  });
  child.once('close', (exitCode, signalCode) => {
    closeEvent = { atMs: atMs(), code: code(exitCode), signal: signal(signalCode) };
    child.off('error', onError);
  });
  child.on('error', onError);
  const readable = stream => stream ? { destroyed: flag(stream.destroyed), readableEnded: flag(stream.readableEnded) } : null;
  return {
    snapshot() {
      return { elapsedMs: atMs(), exitCode: code(child.exitCode), signalCode: signal(child.signalCode),
        exitEvent: exitEvent ? { ...exitEvent } : null, closeEvent: closeEvent ? { ...closeEvent } : null,
        errors: errors.map(error => ({ ...error })),
        stdin: child.stdin ? { destroyed: flag(child.stdin.destroyed), writableEnded: flag(child.stdin.writableEnded),
          writableFinished: flag(child.stdin.writableFinished) } : null,
        stdout: readable(child.stdout), stderr: readable(child.stderr) };
    },
  };
}
