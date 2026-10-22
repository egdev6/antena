// Puerto libre para hijos de test, sin la carrera de `freePort()` (#78): entre el cierre de la
// sonda y el `listen` del hijo, otro test en paralelo puede ocupar ese puerto y el hijo muere
// con EADDRINUSE de forma intermitente. `startServer` no acepta puerto 0
// (`Number(process.env.PORT) || config.port || 4500`), así que el hijo no puede autoseleccionar
// uno: la ventana se acota reintentando con un puerto nuevo, un número acotado de veces.
import net from 'node:net';

/** Puerto efímero real: el hijo lo recibe por `PORT`, nunca un puerto fijo. */
export async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => { if (error) reject(error); else resolve(port); });
    });
  });
}

function salidaDe(c) {
  return c.out ? c.out() : (c.stdout?.() ?? '') + (c.stderr?.() ?? '');
}

async function terminar(c) {
  const proc = c.child ?? c.proc;
  try { if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); } catch { /* ya murió */ }
  const salida = c.exitInfo ?? c.closeInfo ?? c.exit;
  if (salida) await salida.catch(() => {});
}

/**
 * Lanza un hijo en un puerto libre eliminando la carrera de `freePort()`: si el hijo murió con
 * EADDRINUSE antes de estar listo, se mata y se reintenta con otro puerto nuevo, como máximo
 * `attempts` veces. `launch(port)` crea el hijo; `ready(c)` resuelve true cuando el hijo ya
 * escucha (false o error si no llegó, sin aserciones propias); `output(c)` devuelve stdout+stderr
 * para detectar EADDRINUSE. Devuelve el objeto del hijo con `port` e `intento` añadidos; los
 * fallos ajenos a la carrera se devuelven tal cual para que el test falle con su diagnóstico.
 */
export async function launchChildOnFreePort({ launch, ready, output = salidaDe, attempts = 5 }) {
  let diagnostico = '';
  for (let intento = 1; intento <= attempts; intento++) {
    const port = await freePort();
    const c = await launch(port);
    let listo = false, errorDeReady;
    try { listo = (await ready(c)) === true; } catch (error) { errorDeReady = error; }
    if (listo) return { ...c, port, intento };
    if (output(c).includes('EADDRINUSE')) {
      diagnostico = output(c);
      await terminar(c);
      continue;
    }
    if (errorDeReady) throw errorDeReady; // fallo ajeno a la carrera: lo decide el test
    return { ...c, port, intento };
  }
  throw new Error(`agotados ${attempts} puertos libres por EADDRINUSE: ${diagnostico}`);
}
