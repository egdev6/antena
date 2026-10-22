const SERVER_MODULE_URL = new URL('../../src/server.mjs', import.meta.url).href;

// Fixture real compartida. El límite autónomo sigue funcionando sin controlador,
// antes incluso de importar/iniciar el servidor; no representa una señal graceful.
export function serverAdmissionChildProgram({ watchdogMs = 30000 } = {}) {
  if (!Number.isInteger(watchdogMs) || watchdogMs < 100 || watchdogMs > 30000) {
    throw new RangeError('watchdogMs debe ser un entero entre 100 y 30000');
  }
  return `
const watchdog = setTimeout(() => process.exit(86), ${watchdogMs});
watchdog.unref();
const { startServer } = await import(${JSON.stringify(SERVER_MODULE_URL)});
const scenario = process.argv[1] || 'late';
const options = { quiet: true, log: () => {} };
if (process.env.CHILD_SHUTDOWN_TIMEOUT_MS) options.shutdownTimeoutMs = Number(process.env.CHILD_SHUTDOWN_TIMEOUT_MS);
const app = await startServer(options);
app.session.debounceMs = 60000; app.session.maxWaitMs = 60000;
app.interactive.debounceMs = 60000; app.interactive.maxWaitMs = 60000;
await app.store.patchConfig({ tts: { rate: 1.5 } });
let release = () => {};
const gate = new Promise(resolve => { release = resolve; });
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (String(chunk).includes('release')) { console.log('RELEASE'); release(); } });
process.stdin.resume();
let oauthCalls = 0;
app.youtube.finishAuth = async code => {
  oauthCalls += 1;
  console.log('OAUTH-IN:' + code + ':' + oauthCalls);
  if (scenario === 'oauth-gate') await gate;
  await app.store.patchConfig({ tts: { rate: 1.75 } });
  console.log('OAUTH-PERSIST');
  return 'cuenta-fake';
};
if (scenario === 'late' || scenario === 'oauth-gate') app.session.flush = () => { console.log('FLUSH'); return gate; };
app.server.on('request', () => console.log('IN'));
process.on('SIGINT', () => console.log('SIGNAL'));
process.on('SIGTERM', () => console.log('SIGNAL'));
console.log('READY');
`;
}
