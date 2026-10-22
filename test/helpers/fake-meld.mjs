// Meld simulado para tests y demos: servidor WebSocket mínimo que habla QWebChannel.
import http from 'node:http';
import { createHash } from 'node:crypto';

// ---------- Meld simulado: servidor WebSocket mínimo que habla QWebChannel ----------
export function fakeMeld(items) {
  const state = { calls: [], session: { items: items || {
    s1: { type: 'scene', name: 'Cámara', index: 0, current: true },
    s2: { type: 'scene', name: 'Pantalla', index: 1, current: false },
    l1: { type: 'layer', parent: 's1', name: 'Alertas', index: 0, visible: false },
    t1: { type: 'track', name: 'Micro', muted: false },
  } } };
  const server = http.createServer();
  server.on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const sendWs = obj => {
      const data = Buffer.from(JSON.stringify(obj));
      const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
      sock.write(Buffer.concat([head, data]));
    };
    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
        const op = buf[0] & 15;
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { sock.end(); return; }
        const m = JSON.parse(payload.toString());
        if (m.type === 3) sendWs({ type: 10, id: m.id, data: { meld: {
          methods: [['showScene', 10], ['showScene(QString)', 10], ['toggleLayer', 11], ['sendCommand', 12], ['sendStreamEvent', 13], ['toggleMute', 14], ['toggleEffect', 15]],
          signals: [['sessionChanged', 5], ['isStreamingChanged', 6]],
          properties: [[1, 'session', ['sessionChanged', 5], state.session], [2, 'isStreaming', ['isStreamingChanged', 6], false], [3, 'version', [], 2]],
        } } });
        if (m.type === 6) {
          state.calls.push([m.method, ...m.args]);
          if (m.method === 10) { for (const [, v] of Object.entries(state.session.items)) if (v.type === 'scene') v.current = false; state.session.items[m.args[0]].current = true; }
          if (m.method === 11) state.session.items[m.args[1]].visible = !state.session.items[m.args[1]].visible;
          if (m.method === 14) state.session.items[m.args[0]].muted = !state.session.items[m.args[0]].muted;
          sendWs({ type: 10, id: m.id, data: null });
          sendWs({ type: 2, data: [{ object: 'meld', signals: { 5: [] }, properties: { 1: state.session } }] });
        }
      }
    });
  });
  return { server, state, goLive: () => {} };
}

