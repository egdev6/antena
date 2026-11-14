import { EventEmitter } from 'node:events';

/**
 * Broadcast-program interface. This abstract base is additive and has no consumers yet.
 * Adapters expose status exactly as Meld does: { state, streaming, streamingKnown,
 * recording, recordingKnown, recordingWarning, version, error }; `connected` means
 * state === 'conectado'. Unknown streaming/recording is represented by the Known
 * flags, not by changing the corresponding boolean to null.
 *
 * session() returns { scenes, tracks, streaming, recording }. Scenes include ordered
 * layers and their effects; tracks include id, name, muted, monitoring, parent and
 * gain (null until known). Adapters must preserve their underlying values and order.
 * Events are synchronous EventEmitter events: status, session, streaming and
 * controlCommand. `capabilities` is a per-instance Set of supported feature names;
 * an adapter declares e.g. scene-layers, layer-effects, widget-events, confetti,
 * clips, media-controls and raw-meld-rpc only when it supports them. Capabilities
 * describe support; they must not silently discard an action or alter its result.
 *
 * The action signatures intentionally mirror the existing consumers, including
 * connection lifecycle, warning updates and the generic call escape hatch.
 */
const missing = name => { throw new Error(`Program adapter must implement ${name}`); };

export class Program extends EventEmitter {
  constructor() { super(); this.capabilities = new Set(); }
  get status() { return missing('status'); }
  get connected() { return this.status.state === 'conectado'; }
  start(url) { return missing('start'); }
  stop() { return missing('stop'); }
  quiesceClose() { return missing('quiesceClose'); }
  setStatus(patch) { return missing('setStatus'); }
  session() { return missing('session'); }
  showScene(scene) { return missing('showScene'); }
  setLayer(scene, layer, visible) { return missing('setLayer'); }
  toggleEffect(scene, layer, effect) { return missing('toggleEffect'); }
  command(command) { return missing('command'); }
  streamEvent(event, data) { return missing('streamEvent'); }
  toggleMute(track) { return missing('toggleMute'); }
  setGain(track, gain) { return missing('setGain'); }
  media(layer, command, seconds) { return missing('media'); }
  setProperty(id, property, value) { return missing('setProperty'); }
  call(method, ...args) { return missing('call'); }
}
