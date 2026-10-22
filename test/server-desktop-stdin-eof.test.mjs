// #88: el sidecar de la app de escritorio debe apagarse de forma ordenada cuando la app muere
// de golpe. La app mantiene la entrada estándar del servidor abierta; al morir el padre, el
// sistema cierra la tubería y ese fin de stdin es la señal. Con ANTENA_DESKTOP=1, cerrar la
// entrada provoca el apagado ordenado (código 0 y puerto libre); sin ella, `pnpm start` y el
// MCP no cambian: cerrar stdin no apaga el servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchSignalChild } from './helpers/signal-child.mjs';
import { freePort } from './helpers/free-port.mjs';

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));

async function lanzarServidor(t, { desktop }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'EGDEV-STDIN-EOF-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort();
  const env = {
    ...process.env,
    ANTENA_DATA: dir,
    ANTENA_MEDIA: path.join(dir, 'media'),
    PORT: String(port),
    ...(desktop ? { ANTENA_DESKTOP: '1' } : {}),
  };
  delete env.NODE_TEST_CONTEXT; delete env.NODE_TEST_WORKER_ID; delete env.NODE_OPTIONS;
  const args = [SERVER];
  const options = { env, stdio: ['pipe', 'pipe', 'pipe'] };
  const proc = process.platform === 'win32'
    ? await launchSignalChild(process.execPath, args, options)
    : spawn(process.execPath, args, options);
  proc.stdin.on('error', () => { /* el hijo puede morir antes de que cerremos la tubería */ });
  let out = '', err = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', d => { out += d; });
  proc.stderr.on('data', d => { err += d; });
  const exit = new Promise(r => proc.once('exit', (code, signal) => r({ code, signal })));
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await exit;
  });
  // listo cuando ya escucha (el banner lo anuncia)
  const listo = await Promise.race([
    new Promise(resolve => {
      const timer = setInterval(() => {
        if ((out + err).includes('EGDEV live en marcha')) { clearInterval(timer); resolve(true); }
      }, 50);
      setTimeout(() => { clearInterval(timer); resolve(false); }, 10000);
    }),
    exit.then(() => false),
  ]);
  assert.ok(listo, 'el servidor no llegó a escuchar: ' + out + err);
  return { proc, exit, port, salida: () => out + err };
}

async function puertoLibre(port) {
  return await new Promise(resolve => {
    const probe = net.connect(port, '127.0.0.1');
    probe.once('connect', () => { probe.destroy(); resolve(false); });
    probe.once('error', () => resolve(true));
  });
}

test('con ANTENA_DESKTOP=1, cerrar la entrada estándar provoca el apagado ordenado', { timeout: 30000 }, async t => {
  const c = await lanzarServidor(t, { desktop: true });
  c.proc.stdin.end(); // simula la muerte del padre: la app ya no mantiene la tubería
  const resultado = await Promise.race([
    c.exit,
    delay(15000).then(() => null),
  ]);
  assert.ok(resultado, 'el servidor no se apagó al cerrar stdin: ' + c.salida());
  assert.equal(resultado.code, 0, 'código de salida ordenado, salida: ' + c.salida());
  assert.equal(resultado.signal, null);
  assert.ok(await puertoLibre(c.port), 'el puerto debe quedar libre tras el apagado');
});

test('sin ANTENA_DESKTOP, cerrar la entrada estándar no apaga el servidor', { timeout: 30000 }, async t => {
  const c = await lanzarServidor(t, { desktop: false });
  c.proc.stdin.end();
  await delay(3000);
  assert.equal(c.proc.exitCode, null, 'cerrar stdin no debe apagar sin ANTENA_DESKTOP');
  assert.ok(!(await puertoLibre(c.port)), 'el servidor sigue escuchando');
  c.proc.kill('SIGKILL');
  await c.exit;
});
