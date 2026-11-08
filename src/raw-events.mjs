// Registro en bruto de eventos de plataforma (YouTube, Twitch) para diagnóstico.
// Cada evento recibido se añade como una línea JSON a <data>/raw-events.jsonl:
//   { at, platform, kind, handled, raw }
// `handled` indica si Antena lo convirtió en evento o mensaje de chat; los `false`
// son los que la plataforma envió y Antena descartó. Rotación simple: al superar
// `maxBytes` el fichero pasa a raw-events.1.jsonl (se conserva una sola copia).
// Nunca lanza: un fallo de disco no debe cortar la recepción de eventos.
import { appendFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

export class RawEventLog {
  constructor(dir, { maxBytes = 5 * 1024 * 1024, log = console.log } = {}) {
    this.file = path.join(dir, 'raw-events.jsonl');
    this.rotated = path.join(dir, 'raw-events.1.jsonl');
    this.maxBytes = maxBytes;
    this.log = log;
    this.queue = Promise.resolve();
    this.warned = false;
  }

  record(platform, kind, handled, raw) {
    let line;
    try {
      line = JSON.stringify({ at: new Date().toISOString(), platform, kind: kind ?? null, handled: !!handled, raw }) + '\n';
    } catch { return; }
    this.queue = this.queue.then(() => this.write(line)).catch(err => {
      if (this.warned) return;
      this.warned = true;
      try { this.log('[raw-events]', `No se pudo escribir el registro de eventos: ${err.message}`); } catch {}
    });
  }

  async write(line) {
    const size = await stat(this.file).then(s => s.size, () => 0);
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await rename(this.file, this.rotated);
    await appendFile(this.file, line);
  }

  /** Espera a que se escriban los registros pendientes. */
  flush() { return this.queue; }
}
