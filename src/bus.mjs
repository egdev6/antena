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
  constructor({ historySize = 100, byteBudget = 512 * 1024, backlogGraceMs = 100, backlogStallMs = 1000, backlogMaxMs = 5000, now = () => performance.now() } = {}) {
    this.clients = new Set();
    this.history = [];
    this.historySize = historySize;
    this.seen = new Map(); // id externo -> timestamp
    this.byteBudget = byteBudget;
    this.backlogGraceMs = backlogGraceMs;
    this.backlogStallMs = backlogStallMs;
    this.backlogMaxMs = backlogMaxMs;
    this.now = now; // monotonic: a wall-clock change must not stretch or shorten backlogMaxMs
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
      closing: false,
      blocked: false,          // write() devolvió false: no escribir de nuevo hasta drain
      queue: [], queueHead: 0, queueBytes: 0, // efímeros pendientes, en orden
      lastReplaceable: new Map(), snapshotBytes: 0, // último snapshot y sus bytes por tipo
      atRisk: 0,               // efímeros escritos con backlog sobre presupuesto
      droppedEphemeral: 0,     // en riesgo + en cola al corte + envíos posteriores
      overBudgetSince: null,
      lastDrainAt: null,       // null: aún no hubo progreso en este episodio
      crossing: 0,             // invalida timers e inmediatos de cruces anteriores
      checkTimer: null, checkVersion: 0,
    };
    this.clients.add(client);
    if (typeof res.on === 'function') {
      res.on('drain', () => {
        if (!this.#alive(client)) return;
        client.blocked = false;
        this.#noteBacklog(client);
        if (client.overBudgetSince !== null) {
          client.lastDrainAt = this.now();
          this.#scheduleBacklogCheck(client);
        }
        this.#flush(client);
      });
      res.on('error', () => this.#remove(client));
      res.on('close', () => this.#remove(client));
    }
    return client;
  }

  #remove(client) {
    this.clients.delete(client);
    this.#cancelBacklogCheck(client);
    client.queue = []; client.queueHead = 0; client.queueBytes = 0;
    client.lastReplaceable.clear(); client.snapshotBytes = 0;
  }

  #alive(client) {
    if (client.closing || !this.clients.has(client)) return false;
    if (client.res.writableEnded || client.res.destroyed) {
      this.#remove(client);
      return false;
    }
    return true;
  }

  #backlog(client) {
    return client.queueBytes + client.snapshotBytes + (client.res.writableLength || 0);
  }

  /** #57: the owned FIFO prevents Node coalescing an entire burst into one libuv writev,
   *  whose partial progress is invisible. Only write again after false on 'drain', so each
   *  completed write provides observable progress; the budget includes both queues. */
  #noteBacklog(client) {
    if (this.#backlog(client) <= this.byteBudget) {
      if (client.overBudgetSince !== null) {
        client.overBudgetSince = null;
        client.lastDrainAt = null;
        client.crossing++;
        this.#cancelBacklogCheck(client);
      }
      return;
    }
    if (client.overBudgetSince === null) {
      client.overBudgetSince = this.now();
      client.lastDrainAt = null;
      client.crossing++;
      this.#scheduleBacklogCheck(client);
    }
  }

  #cancelBacklogCheck(client) {
    if (client.checkTimer !== null) clearTimeout(client.checkTimer);
    client.checkTimer = null;
    client.checkVersion++;
  }

  #stallDeadline(client) {
    // #57: after a drain, large OS send buffers can hide ongoing reads for hundreds of ms.
    // A fresh crossing has no observed progress and still gets only the initial grace.
    return client.lastDrainAt === null
      ? client.overBudgetSince + this.backlogGraceMs
      : client.lastDrainAt + this.backlogStallMs;
  }

  #scheduleBacklogCheck(client) {
    this.#cancelBacklogCheck(client);
    const crossing = client.crossing, version = client.checkVersion, now = this.now();
    // Check at the earliest deadline, even when the cap or stall interval is not a whole
    // number of grace windows. Each drain may move the stall deadline, but never the cap.
    const delay = Math.max(0, Math.min(this.backlogGraceMs,
      client.overBudgetSince + this.backlogMaxMs - now, this.#stallDeadline(client) - now));
    client.checkTimer = setTimeout(() => {
      if (client.crossing !== crossing || client.checkVersion !== version) return;
      client.checkTimer = null;
      this.#checkBacklog(client, crossing, true);
    }, delay);
  }

  #checkBacklog(client, crossing, mayYield) {
    if (!this.#alive(client) || client.crossing !== crossing) return;
    this.#noteBacklog(client);
    if (client.crossing !== crossing || client.overBudgetSince === null) return;
    const now = this.now();
    if (now - client.overBudgetSince >= this.backlogMaxMs) {
      return this.#saturate(client, 'backlog-timeout');
    }
    if (now < this.#stallDeadline(client)) return this.#scheduleBacklogCheck(client);
    // A blocked event loop did not give a socket a chance to drain. Yield one I/O turn,
    // then recheck both progress and the crossing identity before declaring a stall.
    if (mayYield) return setImmediate(() => this.#checkBacklog(client, crossing, false));
    this.#saturate(client, 'stalled');
  }

  /** Cliente saturado: gap visible con el recuento de efímeros perdidos y cierre para
   *  reconectar con snapshot. El gap es la única escritura terminal, incluso si está bloqueado. */
  #saturate(client, cause) {
    if (!this.#alive(client)) return;
    client.closing = true;
    this.#cancelBacklogCheck(client);
    client.droppedEphemeral += client.atRisk + client.queue.length - client.queueHead;
    client.atRisk = 0;
    client.queue = []; client.queueHead = 0; client.queueBytes = 0;
    client.lastReplaceable.clear(); client.snapshotBytes = 0;
    const gap = `event: gap\ndata: ${JSON.stringify({
      reason: 'slow-client',
      kind: client.kind,
      droppedEphemeral: client.droppedEphemeral,
      cause,
    })}\n\n`;
    try { client.res.write(gap); } catch { /* socket ya muerto */ }
    if (!client.res.writableEnded && !client.res.destroyed) {
      try { client.res.end(); } catch { /* idem */ }
    }
  }

  /** Una escritura real; before incluye el elemento antes de trasladarlo desde la cola. */
  #writeSocket(client, msg, cls, before) {
    let ok;
    try { ok = client.res.write(msg); }
    catch { this.#remove(client); return; }
    client.blocked = !ok;
    if (cls === 'ephemeral' && (before > this.byteBudget || this.#backlog(client) > this.byteBudget)) client.atRisk++;
    this.#noteBacklog(client);
  }

  /** Escribe o encola sin perder efímeros; los snapshots bloqueados se coalescen por tipo. */
  #write(client, msg, event, cls) {
    if (client.closing) {
      if (cls === 'ephemeral') client.droppedEphemeral++;
      return;
    }
    if (!this.#alive(client)) return;
    this.#noteBacklog(client); // detect a dip before a new write or queue entry
    if (client.blocked) {
      if (cls === 'replaceable') {
        const previous = client.lastReplaceable.get(event);
        if (previous !== undefined) client.snapshotBytes -= Buffer.byteLength(previous);
        client.lastReplaceable.set(event, msg);
        client.snapshotBytes += Buffer.byteLength(msg);
      } else {
        client.queue.push(msg);
        client.queueBytes += Buffer.byteLength(msg);
      }
      this.#noteBacklog(client);
      return;
    }
    this.#writeSocket(client, msg, cls, this.#backlog(client));
  }

  /** Drain: primero FIFO de efímeros; después el último snapshot de cada tipo. */
  #flush(client) {
    while (this.#alive(client) && !client.blocked && client.queueHead < client.queue.length) {
      const before = this.#backlog(client);
      const msg = client.queue[client.queueHead];
      client.queue[client.queueHead++] = null;
      client.queueBytes -= Buffer.byteLength(msg);
      this.#writeSocket(client, msg, 'ephemeral', before);
    }
    if (client.queueHead === client.queue.length) {
      client.queue = []; client.queueHead = 0;
    }
    while (this.#alive(client) && !client.blocked && client.lastReplaceable.size) {
      const before = this.#backlog(client);
      const [event, msg] = client.lastReplaceable.entries().next().value;
      client.lastReplaceable.delete(event);
      client.snapshotBytes -= Buffer.byteLength(msg);
      this.#writeSocket(client, msg, 'replaceable', before);
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
