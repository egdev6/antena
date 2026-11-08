const safeClass = value => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value || '') ? value : 'Unknown';

function evaluationError(kind, detail = {}) {
  return Object.assign(new Error(`CDP Runtime.evaluate ${kind}`), {
    name: 'ChromeEvaluationError', kind, ...detail,
  });
}

export async function evaluateChrome(c, expression, { timeoutMs } = {}) {
  let timer;
  try {
    const request = c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const reply = timeoutMs === undefined ? await request : await Promise.race([
      request,
      new Promise((_, reject) => { timer = setTimeout(() => reject(evaluationError('timeout')), Math.max(1, timeoutMs)); }),
    ]);
    if (reply.exceptionDetails) {
      throw evaluationError('exception', { runtimeClass: safeClass(reply.exceptionDetails.exception?.className) });
    }
    return reply.result?.value;
  } catch (error) {
    if (error.name === 'ChromeEvaluationError') throw error;
    throw evaluationError('protocol', { cdpCode: Number.isInteger(error.code) ? error.code : null });
  } finally { clearTimeout(timer); }
}

// Sólo estructura y metadatos: nada de HTML crudo, texto de usuario, valores de
// formularios, querystrings, descripciones de excepciones ni argumentos de console.
const pageExpression = `(() => {
  const u = new URL(location.href);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  const routes = ['/', '/prompter', '/prompter.html', '/panel.html'];
  const tags = ['DIV', 'MAIN', 'SECTION', 'FORM', 'SCRIPT', 'H1', 'P', 'NAV'];
  const blank = u.href === 'about:blank';
  const navigation = globalThis.performance?.getEntriesByType('navigation')?.[0];
  const status = navigation?.responseStatus;
  return {
    location: blank ? 'about:blank' : u.protocol === 'chrome-error:' ? 'chrome-error' :
      (local ? u.origin + (routes.includes(u.pathname) ? u.pathname : '/[other]') : '[non-loopback]'),
    readyState: document.readyState,
    titleKind: blank ? 'blank' : u.protocol === 'chrome-error:' ? 'browser-error' :
      (/egdev.?live/i.test(document.title) ? 'project' :
        (local && document.title.length > 0 && document.title === u.hostname ? 'loopback-error' : 'other')),
    navigationStatus: Number.isInteger(status) && status >= 0 && status <= 599 ? status : null,
    contentType: document.contentType,
    bodyTags: [...(document.body?.children || [])].map(el => el.tagName).filter(tag => tags.includes(tag)).slice(0, 12),
    ids: Object.fromEntries(['pC', 'persistBar', 'edit'].map(id => [id, !!document.getElementById(id)])),
  };
})()`;

// Misma clasificación que pageExpression, del lado Node: nunca credenciales, query ni fragmento.
const routes = ['/', '/prompter', '/prompter.html', '/panel.html'];
function urlKind(href) {
  if (typeof href !== 'string' || !href) return null;
  if (href === 'about:blank') return 'about:blank';
  let u;
  try { u = new URL(href); } catch { return 'invalid'; }
  if (u.protocol === 'chrome-error:') return 'chrome-error';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return '[non-loopback]';
  return u.origin + (routes.includes(u.pathname) ? u.pathname : '/[other]');
}

function bounded(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

// Estado real del frame principal al fallar: separa navegación no comprometida de contexto equivocado.
async function frameDiagnostic(c) {
  try {
    const { frameTree } = await bounded(c.send('Page.getFrameTree'), 1000);
    const history = await bounded(c.send('Page.getNavigationHistory'), 1000);
    const frame = frameTree?.frame || {};
    return {
      main: urlKind(frame.url), loader: typeof frame.loaderId === 'string' && frame.loaderId.length > 0,
      unreachable: urlKind(frame.unreachableUrl),
      history: { currentIndex: Number.isInteger(history?.currentIndex) ? history.currentIndex : null,
        entries: (history?.entries || []).slice(0, 5).map(entry => urlKind(entry?.url)) },
    };
  } catch (error) {
    return Number.isInteger(error.code) ? { unavailable: true, cdpCode: error.code } : { unavailable: true };
  }
}

async function targetsDiagnostic(c) {
  if (typeof c.chromeTargetsNow !== 'function') return { unavailable: true };
  try { return await bounded(Promise.resolve().then(() => c.chromeTargetsNow()), 1000); }
  catch { return { unavailable: true }; }
}

export function chromeDiagnosticEvent(message) {
  if (message.method === 'Runtime.exceptionThrown') {
    const detail = message.params?.exceptionDetails || {};
    return { kind: 'exception', className: safeClass(detail.exception?.className),
      line: Number.isInteger(detail.lineNumber) ? detail.lineNumber : null,
      column: Number.isInteger(detail.columnNumber) ? detail.columnNumber : null };
  }
  if (message.method === 'Network.loadingFailed') {
    const params = message.params || {};
    return { kind: 'network', resourceType: safeClass(params.type),
      error: /net::ERR_[A-Z_]+/.exec(params.errorText || '')?.[0] || 'network-failure' };
  }
  return null;
}

export async function waitChromeDom(c, expression, {
  timeoutMs = 9000, intervalMs = 80, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(timeoutMs)) throw new TypeError('timeoutMs must be a finite number');
  const deadline = now() + timeoutMs;
  if (!Number.isFinite(deadline)) throw new TypeError('DOM wait deadline must be a finite number');
  let last;
  for (;;) {
    try {
      if (await evaluateChrome(c, expression, { timeoutMs: Math.max(1, deadline - now()) })) return true;
      last = { kind: 'false' };
    } catch (error) {
      last = { kind: error.kind || 'protocol', runtimeClass: error.runtimeClass || null, cdpCode: error.cdpCode ?? null };
    }
    if (now() >= deadline) break;
    await sleep(Math.min(intervalMs, deadline - now()));
  }
  let page;
  try { page = await evaluateChrome(c, pageExpression, { timeoutMs: 1000 }); }
  catch { page = { unavailable: true }; }
  // frames y targetsNow van antes del stderr de Chrome para sobrevivir al recorte del mensaje.
  const [frames, targetsNow] = await Promise.all([frameDiagnostic(c), targetsDiagnostic(c)]);
  const diagnostic = { last, page, frames, targetsNow, events: c.diagnostics?.() || [], chrome: c.chromeStartup?.() || { unavailable: true } };
  const error = new Error(`timeout CDP: ${expression}; diagnóstico: ${JSON.stringify(diagnostic).slice(0, 2000)}`);
  error.diagnostic = diagnostic;
  throw error;
}
