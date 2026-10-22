// Utilidad compartida de escritura JSON atómica y serializada.
// Garantías: temporal único en la misma carpeta del destino + rename atómico; todas
// las llamadas a la misma ruta resuelta comparten una cola, incluidas fábricas distintas.
// NO promete fsync/pérdida de energía ni serialización entre procesos independientes.
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Map global ruta resuelta -> promesa de cola; lo comparten todas las fábricas.
const queues = new Map();

function enqueue(key, job) {
  const tail = queues.get(key) || Promise.resolve();
  const run = tail.then(job);
  const recovered = run.then(() => {}, () => {});   // la cola nunca se envenena
  queues.set(key, recovered);
  // borra la entrada ociosa solo si este trabajo sigue siendo la cola actual (no borra colas nuevas)
  recovered.then(() => { if (queues.get(key) === recovered) queues.delete(key); });
  return run;
}

// Instantánea síncrona al aceptar la llamada: mutaciones posteriores no cambian el texto.
// Formato por defecto indentado: el writer lo comparten Store (config.json editable a mano),
// Interactive y Session; #67: `serialize` produce el texto compacto y la opción `text` del
// writer permite que un checkpoint escriba el mismo objeto en varias rutas serializando una vez.
function snapshot(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text === undefined) throw new TypeError('El valor no es JSON serializable');
  return text;
}

export function serialize(data) {
  const text = JSON.stringify(data);
  if (text === undefined) throw new TypeError('El valor no es JSON serializable');
  return text;
}

export function createJsonWriter(io = fsPromises) {
  return function write(file, data, { after, text } = {}) {
    let body;
    try { body = text !== undefined ? text : snapshot(data); } catch (err) { return Promise.reject(err); }
    const target = path.resolve(file);
    return enqueue(target, async () => {
      if (after) await after;                          // puerta de contabilidad (p. ej. Store.chain)
      const dir = path.dirname(target);
      await io.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
      const handle = await io.open(tmp, 'wx', 0o600);  // 'wx': solo se posee el temporal si abrió
      try {
        await handle.writeFile(body);
        await handle.close();
        await io.rename(tmp, target);                  // atómico: el final previo sobrevive hasta aquí
      } catch (err) {
        // Limpieza de mejor esfuerzo del temporal y del handle propios; no sustituye el error primario
        // ni garantiza borrar el temporal si el propio filesystem falla.
        try { await handle.close(); } catch { /* handle ya cerrado o inaccesible */ }
        try { await io.unlink(tmp); } catch { /* limpieza no garantizada */ }
        throw err;
      }
    });
  };
}

export const writeJson = createJsonWriter();
