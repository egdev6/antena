// #73: conexión automática de la lectura del chat de YouTube al empezar el directo.
// Solo lectura: la cuenta OAuth de escritura nunca se conecta sola. Mientras YouTube aún
// no publica el directo (pasa unos segundos después de empezar a emitir) se reintenta de
// forma acotada; cada intento sin vídeo configurado cuesta 100 unidades de cuota.
// Al terminar el directo se detiene la lectura y el estado queda limpio.
const RETRYABLE = new Set(['noLive', 'noLiveChat']);

export class YouTubeAutoConnect {
  constructor(youtube, { log = () => {}, retryMs = 30_000, maxAttempts = 10 } = {}) {
    this.youtube = youtube;
    this.log = log;
    this.retryMs = retryMs;
    this.maxAttempts = maxAttempts;
    this.active = false;
    this.attempt = 0;
    this.timer = null;
    this.running = Promise.resolve();
  }

  /** YouTube puede leer el chat: API key o cuenta, y canal o vídeo del directo. */
  ready() {
    const yt = this.youtube, cfg = yt.cfg || {};
    return !!((cfg.apiKey || yt.token?.access) && (cfg.channelId || cfg.video));
  }

  begin() {
    if (this.active || this.youtube.pollClosed || !this.ready()) return;
    this.active = true;
    // Ya iniciado a mano: no se reinicia.
    if (['escuchando', 'buscando directo'].includes(this.youtube.status.state)) return;
    this.attempt = 0;
    this.log('[youtube]', 'Directo en marcha: conectando el chat de YouTube.');
    this.schedule(0);
  }

  schedule(ms) {
    const run = () => { this.timer = null; this.running = this.run(); };
    if (ms <= 0) { run(); return; }
    this.timer = setTimeout(run, ms);
    this.timer.unref?.();
  }

  async run() {
    const yt = this.youtube;
    if (!this.active || yt.pollClosed) return;
    this.attempt++;
    yt.lastError = null;
    try { await yt.start(); } catch (err) { yt.lastError = err; }
    if (!this.active || yt.pollClosed || yt.status.state === 'escuchando') return;
    if (!RETRYABLE.has(yt.lastError?.reason)) return;
    if (this.attempt >= this.maxAttempts) {
      this.log('[youtube]', `No se pudo conectar el chat de YouTube tras ${this.attempt} intentos.`);
      return;
    }
    yt.setStatus({
      state: 'en espera',
      notice: `YouTube aún no muestra el directo. Nuevo intento en ${Math.round(this.retryMs / 1000)} s (${this.attempt}/${this.maxAttempts}).`,
      retryAt: Date.now() + this.retryMs,
    });
    this.schedule(this.retryMs);
  }

  /** Espera a que termine el intento en curso (para pruebas y cierre). */
  idle() { return this.running; }

  async end() {
    this.close();
    const yt = this.youtube;
    await this.running.catch(() => {});
    if (yt.pollClosed) return;
    await yt.stop();
    yt.setStatus({ state: 'parado', videoId: null, liveChatId: null, title: null, notice: null, retryAt: null, errors: [] });
  }

  close() {
    this.active = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
