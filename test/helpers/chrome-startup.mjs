// Metadatos pasivos: nunca el contenido del archivo, nonce CDP, título o query.
export function chromePortFileDiagnostic(contents, error) {
  if (error || typeof contents !== 'string') {
    const allowed = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'EMFILE', 'ENFILE', 'EIO'];
    const code = allowed.includes(error?.code) ? error.code : 'READ_ERROR';
    return { exists: code === 'ENOENT' ? false : null, readable: false, errorCode: code,
      bytes: null, port: null, browserPath: false };
  }
  const lines = contents.split('\n');
  const first = lines[0].trim();
  const port = /^\d{1,5}$/.test(first) ? Number(first) : 0;
  return { exists: true, readable: true, errorCode: null, bytes: Buffer.byteLength(contents),
    port: port > 0 && port <= 65535 ? port : null,
    browserPath: /^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test((lines[1] || '').trim()) };
}

export function chromeTargetDiagnostic(target) {
  if (!target) return { available: false };
  let u;
  try { u = new URL(target.url); } catch { return { available: true, location: '[invalid]' }; }
  const local = ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  const routes = ['/', '/prompter', '/prompter.html', '/panel.html'];
  const location = u.href === 'about:blank' ? 'about:blank' : u.protocol === 'chrome-error:' ? 'chrome-error' :
    local ? u.origin + (routes.includes(u.pathname) ? u.pathname : '/[other]') : '[non-loopback]';
  return { available: true, location };
}

// Sonda pasiva: no cambia argumentos, sandbox ni señales del navegador.
export function observeChromeStartup(child, profile) {
  const limit = 2000;
  let stderr = Buffer.alloc(0), stderrTruncated = false;
  let closed = false, exitCode = null, signal = null, spawnError = null;
  child.stderr.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = limit - stderr.length;
    if (bytes.length > remaining) stderrTruncated = true;
    if (remaining > 0) stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
  });
  child.on('error', error => { spawnError = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'SPAWN_ERROR'; });
  child.on('close', (code, sig) => { closed = true; exitCode = code; signal = sig; });
  return {
    snapshot() {
      return { closed, exitCode, signal, spawnError,
        stderr: stderr.toString('utf8').replaceAll(profile, '[profile]'), stderrTruncated };
    },
  };
}
