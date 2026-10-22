// ODD-13 · D2: regresión con sockets reales — presupuesto por cliente sobre bytes no
// consumidos. Un cliente que LEE (drena su socket durante la gracia) no debe cortarse
// nunca, aunque una ráfaga supere el presupuesto; uno que NO drena sí.
// En la rama con medición intrarráfaga este test fallaba: el lector recibía gap + FIN
// a mitad de ráfaga (p. ej. 64/200 × 8 KiB con el presupuesto por defecto de 512 KiB).
//
// Determinista (#70): en vez de una gracia fija y sondeos a intervalos, el test se
// gobierna con señales reales del bus y de los sockets:
// - El lector está a salvo cuando su backlog llega a CERO (writableLength === 0 o el
//   evento 'drain' de su socket en el servidor): la comprobación diferida del bus solo
//   corta si el backlog SIGUE por encima del presupuesto, así que con backlog 0 nunca
//   hay corte ni gap. Si se rompe la regla que prueba (corte intrarráfaga o gracia
//   eliminada), el lector muere y el 'close' de su socket resuelve la carrera al
//   momento: el test sigue rojo ante el fallo que detecta.
// - El corte del cliente lento se observa con el 'close' de su socket, no con sondeos.
// - Cliente lento con ventana cero en toda plataforma (#83): su socket del servidor se
//   tapona (cork), así que la ráfaga se queda en writableLength y no en los búferes del
//   kernel. En Windows el loopback absorbía los ~6 MB, el backlog caía bajo el
//   presupuesto antes de la comprobación diferida y nunca había corte.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Bus } from '../src/bus.mjs';

const EVENT = 'chat';
const TOTAL = 200, PAYLOAD = 'z'.repeat(30 * 1024); // ráfaga ~6 MB >> 512 KiB por defecto

test('socket real: lector sobrevive a la ráfaga, cliente lento es cortado', { timeout: 30000 }, async () => {
  const bus = new Bus(); // presupuesto y gracia por defecto, como en producción
  let readerRes, slowRes; // res del lado servidor, para escuchar sus señales
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // El cierre del bus hace res.end(); como el transporte es keep-alive, el corte real
    // llega al cliente destruyendo el socket (como hace el shutdown del servidor). No se
    // espera a 'finish': con ventana TCP cero el flush podría no completarse nunca.
    const end = res.end.bind(res);
    res.end = (...args) => { const result = end(...args); setImmediate(() => res.socket?.destroy()); return result; };
    if (req.url.includes('slow=1')) slowRes = res; else readerRes = res;
    bus.addClient(res, 'panel');
    res.write('retry: 2000\n\n'); // como en server.mjs: provoca el flush inicial de cabeceras
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const getSse = (path = '/api/stream?client=panel') => new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, resolve);
    req.on('error', reject);
  });

  let readerClosed = false, readerGap = false;
  const body = []; // se cuenta al final: los eventos pueden partirse entre chunks
  const reader = await getSse(); // está en modo fluido: consume su socket continuamente
  reader.on('data', chunk => {
    const text = chunk.toString();
    if (text.includes('event: gap')) readerGap = true;
    body.push(text);
  });
  reader.on('close', () => { readerClosed = true; });

  const slow = await getSse('/api/stream?client=panel&slow=1');
  slow.pause();
  // Cliente lento: no consume nada. El cork deja cada byte de la ráfaga como backlog sin
  // consumir (writableLength), sin depender del tamaño de los búferes de cada SO; su
  // backlog sigue sobre el presupuesto tras la gracia, así que el corte procede.
  // Observabilidad: en el servidor, la destrucción del socket dispara 'close' y el
  // cliente sale del bus.
  slowRes.socket.cork();
  slow.on('error', () => { /* el corte destruye el socket: reset esperado */ });

  // Ráfaga de un solo tick: sin verificación diferida, ambos se cortan a mitad.
  for (let i = 0; i < TOTAL; i++) bus.send(EVENT, { id: i, text: PAYLOAD });

  try {
    // Señal determinista: el lector está a salvo cuando su backlog llega a cero
    // ('drain' de su socket en el servidor, o ya vacío). Si la regla se rompe, el
    // lector muere y su 'close' resuelve esta carrera de inmediato.
    const drained = readerRes.writableLength === 0
      ? Promise.resolve()
      : new Promise(resolve => readerRes.once('drain', resolve));
    const readerDied = new Promise(resolve => readerRes.once('close', resolve));
    await Promise.race([drained, readerDied]);
    assert.ok(!readerClosed, 'el lector no se corta por una ráfaga');
    assert.ok(!readerGap, 'el lector no recibe gap');

    // El cliente lento fue cortado: el 'close' de su socket en el servidor retira al
    // cliente del bus. Se espera esa señal y el retiro resultante, con techo amplio.
    await new Promise(resolve => {
      if (bus.clients.size === 1) return resolve();
      slowRes.once('close', resolve);
      setTimeout(resolve, 5000);
    });
    const removalDeadline = Date.now() + 5000;
    while (bus.clients.size > 1 && Date.now() < removalDeadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(bus.clients.size, 1, 'el cliente lento fue cortado y retirado del bus');

    // El lector sigue operativo y recibe la ráfaga completa: ya drenó todo su backlog,
    // los bytes están en camino; la espera solo cubre el reparto de chunks en el cliente.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((body.join('').match(new RegExp(`event: ${EVENT}`, 'g')) || []).length >= TOTAL) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    const received = (body.join('').match(new RegExp(`event: ${EVENT}`, 'g')) || []).length;
    assert.ok(received >= TOTAL, `el lector recibió la ráfaga completa (recibidos: ${received}/${TOTAL})`);
  } finally {
    reader.destroy(); slow.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
});
