// Bus de eventos: historial, deduplicado y difusión por Server-Sent Events.
// Los nombres de eventos y su clasificación viven en el contrato único src/events.mjs (#72);
// este fichero solo implementa la mecánica de difusión. Presupuesto de bytes pendientes por
// cliente y aislamiento de clientes lentos.
import { eventClass } from './events.mjs';

// Compatibilidad: reexporta el contrato (los consumidores internos y tests siguen
// pudiendo importar la clasificación desde el bus).
export { REPLACEABLE_EVENTS, EPHEMERAL_EVENTS, eventClass } from './events.mjs';

// Aviso una sola vez por tipo desconocido; nunca dentro de emisores de productores lanza.
const unknownWarned = new Set();
function warnUnknown(event) {
  if (unknownWarned.has(event)) return;
  unknownWarned.add(event);
  try { console.warn(`[bus] evento SSE sin clasificar: ${event} (tratado como efímero; decláralo en REPLACEABLE_EVENTS o EPHEMERAL_EVENTS)`); }
  catch { /* el aviso no puede romper la difusión */ }
}

export class Bus {
  constructor({ historySize = 100, byteBudget = 512 * 1024, backlogGraceMs = 100, backlogMaxMs = 5000 } = {}) {
    this.clients = new Set();
    this.history = [];
    this.historySize = historySize;
    this.seen = new Map(); // id externo -> timestamp
    // Presupuesto de bytes SIN consumir por cliente (writableLength del socket): lo que el
    // cliente tiene en cola y no ha leído. La decisión de corte NUNCA se toma dentro de la
    // ráfaga: una ráfaga de un solo tick parece lenta siempre. Solo se corta un cliente cuyo
    // backlog sigue por encima del presupuesto en el tick siguiente (setImmediate) sin que
    // haya drenado; el 'drain' resetea la contrapresión y libera el crédito.
    // #57: the grace is progress-based. A client over budget whose backlog shrinks between
    // checks is reading and keeps its connection; one that did not shrink in a whole window is
    // stalled and is cut; and none stays over budget longer than backlogMaxMs (bounded memory).
    this.backlogGraceMs = backlogGraceMs;
    this.backlogMaxMs = backlogMaxMs;
    this.byteBudget = byteBudget;
  }

  /** Devuelve true si el id externo ya se ha procesado (EventSub puede reenviar). */
  isDuplicate(externalId) {
    if (!externalId) return false;
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    if (this.seen.has(externalId)) return true;
    this.seen.set(externalId, now);
    return false;
  }

  addClient(res, kind) {
    const client = {
      res, kind,
      closing: false,          // saturado: se cuenta lo perdido y se programa el gap + cierre
      gapScheduled: false,
      checkScheduled: false,   // verificación de backlog persistente pendiente (setTimeout)
      overBudgetSince: null,   // #57: cuándo superó el presupuesto (null = por debajo)
      lastBacklog: 0,          // #57: backlog en la comprobación anterior
      bytesWritten: 0,         // #57: bytes escritos al socket (consumido = antes + escrito - ahora)
      lastBytesWritten: 0,
      throttled: false,        // backlog sobre presupuesto: los snapshots se coalescen
      atRisk: 0,               // efímeros escritos con backlog sobre presupuesto (en riesgo)
      droppedEphemeral: 0,     // efímeros no entregados (riesgo al corte + envíos posteriores)
      lastReplaceable: new Map(), // último valor coalescido por tipo, se envía al drain
    };
    this.clients.add(client);
    if (typeof res.on === 'function') {
      // drain = el cliente consumió su cola: se libera el presupuesto, se quita el throttle
      // y se envían los últimos valores de los snapshots coalescidos durante la contrapresión.
      res.on('drain', () => {
        client.throttled = false;
        this.#flushReplaceable(client);
      });
      res.on('error', () => this.clients.delete(client));
    }
    res.on?.('close', () => this.clients.delete(client));
    return client;
  }

  /** Verificación diferida: el corte solo procede si el backlog SIGUE sobre presupuesto
   *  cuando la ráfaga ya terminó y ha pasado la gracia (un lector rápido drena su cola;
   *  una ráfaga de un solo tick nunca es motivo de corte por sí misma). */
  #scheduleBacklogCheck(client) {
    if (client.checkScheduled) return;
    client.checkScheduled = true;
    if (client.overBudgetSince === null) client.overBudgetSince = Date.now();
    client.lastBacklog = client.res.writableLength || 0;
    client.lastBytesWritten = client.bytesWritten;
    setTimeout(() => {
      client.checkScheduled = false;
      if (client.closing) return;
      const backlog = client.res.writableLength || 0;
      if (backlog <= this.byteBudget) { client.overBudgetSince = null; return; }
      // Bytes the client actually read during the window; new writes do not hide progress.
      const consumed = client.lastBacklog + (client.bytesWritten - client.lastBytesWritten) - backlog;
      if (consumed <= 0) return this.#saturate(client, 'stalled');
      if (Date.now() - client.overBudgetSince >= this.backlogMaxMs) return this.#saturate(client, 'backlog-timeout');
      this.#scheduleBacklogCheck(client); // progressing: renew the window
    }, this.backlogGraceMs);
  }

  /** Cliente saturado: gap visible con el recuento de efímeros perdidos y cierre para
   *  reconectar con snapshot. El gap se envía tras comprobar el backlog persistente y
   *  con el recuento final de la ráfaga. */
  #saturate(client, cause) {
    if (client.gapScheduled) return;
    client.closing = true;
    client.throttled = true;
    client.droppedEphemeral += client.atRisk; // lo escrito con backlog sin consumir se pierde al FIN
    client.atRisk = 0;
    client.gapScheduled = true;
    const gap = `event: gap\ndata: ${JSON.stringify({
      reason: 'slow-client',
      kind: client.kind,
      droppedEphemeral: client.droppedEphemeral,
      cause, // #57: 'stalled' (no progress in a grace window) | 'backlog-timeout' (over budget too long)
    })}\n\n`;
    try { client.res.write(gap); } catch { /* socket ya muerto */ }
    try { client.res.end(); } catch { /* idem */ }
  }

  /** Escribe a un cliente respetando su presupuesto de bytes pendientes.
   *  Devuelve false si el evento no se entregó (coalesced, en riesgo o cliente muerto). */
  #write(client, msg, event, cls) {
    const res = client.res;
    if (client.closing) {
      // Ya saturado: no se escribe. Los efímeros perdidos se cuentan para el gap; los
      // snapshots sustituibles no cuentan como pérdida (reconexión/snapshot los sustituye).
      if (cls === 'ephemeral') client.droppedEphemeral += 1;
      return false;
    }
    if (res.writableEnded || res.destroyed) {
      this.clients.delete(client);
      return false;
    }
    if (cls === 'replaceable' && client.throttled) {
      // Coalescing SOLO con throttle activo (la última write() devolvió false y el drain
      // está pendiente). Un backlog residual bajo highWaterMark (write() devolvió true,
      // sin 'drain' futuro) NUNCA retiene un snapshot: se escribe inmediatamente, como en
      // main; de lo contrario el último valor quedaría varado indefinidamente en un
      // cliente sano.
      client.lastReplaceable.set(event, msg);
      return false;
    }
    let ok;
    try {
      ok = res.write(msg);
    } catch {
      this.clients.delete(client);
      return false;
    }
    client.bytesWritten += Buffer.byteLength(msg);
    if (!ok) client.throttled = true; // contrapresión real: 'drain' liberará el throttle
    if ((res.writableLength || 0) > this.byteBudget) {
      // Backlog sobre presupuesto: los efímeros escritos a partir de aquí están en riesgo
      // (se pierden si el backlog persiste y se corta) y los snapshots pasan a coalescerse.
      // La decisión de corte es SIEMPRE diferida al siguiente tick.
      client.throttled = true;
      if (cls === 'ephemeral') client.atRisk += 1;
      this.#scheduleBacklogCheck(client);
    }
    return true;
  }

  /** Al hacer drain se envían los últimos valores retenidos de cada tipo sustituible. */
  #flushReplaceable(client) {
    if (client.closing || client.lastReplaceable.size === 0) return;
    const pending = [...client.lastReplaceable.values()];
    client.lastReplaceable.clear();
    for (const msg of pending) {
      try {
        client.res.write(msg);
      } catch {
        this.clients.delete(client);
        return;
      }
      client.bytesWritten += Buffer.byteLength(msg);
      if ((client.res.writableLength || 0) > this.byteBudget) {
        this.#scheduleBacklogCheck(client);
        return;
      }
    }
  }

  send(event, data, kinds = null) {
    // Un tipo desconocido nunca debe romper al productor (store/meld/emisores sin catch):
    // se avisa una vez y se trata como efímero; el test de clasificación sigue fallando
    // en revisión si aparece un tipo nuevo sin declarar.
    let cls = eventClass(event);
    if (cls === null) { warnUnknown(event); cls = 'ephemeral'; }
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      if (!kinds || kinds.includes(c.kind)) this.#write(c, msg, event, cls);
    }
  }

  alert(alert, kinds = ['overlay']) {
    if (!alert) return null;
    if (!alert.test) {
      this.history.unshift(alert);
      this.history.length = Math.min(this.history.length, this.historySize);
    }
    this.send('alert', alert, kinds);
    return alert;
  }

  overlayCount() {
    return [...this.clients].filter(c => c.kind === 'overlay' && !c.closing).length;
  }
}
