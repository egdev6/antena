// Extiende el Meld compartido solo para pruebas de emisión/grabación, en loopback.
import { fakeMeld } from './fake-meld.mjs';

function frame(message) {
  const data = Buffer.from(JSON.stringify(message));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

export function fakeMeldRecording({ streaming = false, recording = false, omitStreaming = false, omitRecording = false } = {}) {
  const meld = fakeMeld({});
  let socket;
  meld.server.prependListener('upgrade', (_req, sock) => {
    socket = sock;
    const write = sock.write.bind(sock);
    sock.write = (chunk, ...args) => {
      if (Buffer.isBuffer(chunk) && chunk[0] === 0x81) {
        const offset = (chunk[1] & 127) === 126 ? 4 : 2;
        try {
          const message = JSON.parse(chunk.subarray(offset).toString());
          if (message.type === 10 && message.data?.meld) {
            const props = message.data.meld.properties;
            const live = props.find(p => p[1] === 'isStreaming');
            if (omitStreaming) props.splice(props.indexOf(live), 1); else live[3] = streaming;
            if (!omitRecording) props.push([4, 'isRecording', ['isRecordingChanged', 8], recording]);
            message.data.meld.signals.push(['isRecordingChanged', 8]);
            chunk = frame(message);
          }
        } catch { /* no es el frame de inicialización */ }
      }
      return write(chunk, ...args);
    };
  });
  return {
    ...meld,
    report(values) {
      const properties = {};
      if (Object.hasOwn(values, 'streaming')) properties[2] = values.streaming;
      if (Object.hasOwn(values, 'recording')) properties[4] = values.recording;
      socket.write(frame({ type: 2, data: [{ object: 'meld', properties }] }));
    },
  };
}

export function recordingClock() {
  const active = new Set();
  return {
    timers: {
      setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; active.add(timer); return timer; },
      clearTimeout(timer) { active.delete(timer); },
    },
    expire() { const timers = [...active]; active.clear(); for (const timer of timers) timer.fn(); return timers.length; },
    count() { return active.size; },
  };
}
