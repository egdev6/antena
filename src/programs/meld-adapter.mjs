import { Program } from './program.mjs';

// Wrap the existing instance: do not translate values, arguments, or promises.
export class MeldAdapter extends Program {
  #meld;
  #forwarders = new Map();

  constructor(meld) {
    super();
    this.#meld = meld;
    this.capabilities = new Set(['scene-layers', 'layer-effects', 'audio-tracks', 'streaming', 'recording',
      'widget-events', 'confetti', 'clips', 'media-controls', 'raw-meld-rpc']);
    for (const event of ['status', 'session', 'streaming', 'controlCommand']) {
      const forward = (...args) => this.emit(event, ...args);
      this.#forwarders.set(event, forward);
      meld.on(event, forward);
    }
  }

  // Compatibility for tests and diagnostics; consumers use the program interface.
  get raw() { return this.#meld; }
  get status() { return this.#meld.status; }
  get connected() { return this.#meld.connected; }
  start(...args) { return this.#meld.start(...args); }
  stop(...args) { return this.#meld.stop(...args); }
  quiesceClose(...args) { return this.#meld.quiesceClose(...args); }
  setStatus(...args) { return this.#meld.setStatus(...args); }
  session(...args) { return this.#meld.session(...args); }
  showScene(...args) { return this.#meld.showScene(...args); }
  setLayer(...args) { return this.#meld.setLayer(...args); }
  toggleEffect(...args) { return this.#meld.toggleEffect(...args); }
  command(...args) { return this.#meld.command(...args); }
  streamEvent(...args) { return this.#meld.streamEvent(...args); }
  toggleMute(...args) { return this.#meld.toggleMute(...args); }
  setGain(...args) { return this.#meld.setGain(...args); }
  media(...args) { return this.#meld.media(...args); }
  setProperty(...args) { return this.#meld.setProperty(...args); }
  call(...args) { return this.#meld.call(...args); }

  // Terminal opt-in cleanup; stop() must keep forwarding for a later restart.
  dispose() {
    for (const [event, forward] of this.#forwarders) this.#meld.off(event, forward);
    this.#forwarders.clear();
  }
}
