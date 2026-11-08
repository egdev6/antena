// Transporte WebSocket mínimo: las escrituras del bus siguen siendo mensajes SSE completos.
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;
const CLOSE_CHECK_MS = 1000, CLOSE_MAX_MS = 30_000; // cierre tras el corte: sin progreso / tope

function frame(opcode, payload) {
  const size = payload.length, extra = size < 126 ? 0 : size <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extra);
  header[0] = 0x80 | opcode;
  header[1] = extra === 0 ? size : extra === 2 ? 126 : 127;
  if (extra === 2) header.writeUInt16BE(size, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(size), 2);
  return Buffer.concat([header, payload]);
}

export class WsResponse extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.closed = false;
    this.fragmented = false;
    this.messageBytes = 0;
    this.textDecoder = null;
    socket.on('data', chunk => this.receive(chunk));
    socket.on('drain', () => this.emit('drain'));
    socket.on('end', () => { this.close(); if (!socket.writableEnded) socket.end(); });
    socket.on('close', () => this.close());
    socket.on('error', error => {
      if (this.listenerCount('error')) this.emit('error', error);
      this.close();
    });
    // El head puede contener un close: se procesa después de registrar el cliente y sus limpiezas.
    if (head.length) queueMicrotask(() => this.receive(head));
  }

  get writableLength() { return this.socket.writableLength; }
  get writableEnded() { return this.ended || this.socket.writableEnded; }
  get destroyed() { return this.socket.destroyed; }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  write(text) {
    if (this.closed || this.writableEnded || this.destroyed) return false;
    return this.socket.write(frame(1, Buffer.from(text)));
  }
  end() { this.finish(Buffer.from([0x03, 0xe8])); }
  finish(payload, destroy = false) {
    if (this.closed || this.writableEnded || this.destroyed) return;
    this.ended = true;
    this.socket.end(frame(8, payload), () => { if (destroy) this.socket.destroy(); });
    // Si el cliente tampoco lee el close, no dejamos el socket retenido por su backlog: se
    // destruye cuando lo pendiente en el proceso no baja en un segundo. Si ya pasó todo al
    // kernel (writableLength 0) el lector puede seguir leyendo: se espera su cierre, con tope.
    let last = this.socket.writableLength, waited = 0;
    const timer = setInterval(() => {
      waited += CLOSE_CHECK_MS;
      const now = this.socket.writableLength;
      if (waited >= CLOSE_MAX_MS || (now > 0 && now >= last)) this.socket.destroy();
      last = now;
    }, CLOSE_CHECK_MS);
    timer.unref();
    this.socket.once('close', () => clearInterval(timer));
  }
  fail(code) {
    const payload = Buffer.alloc(2); payload.writeUInt16BE(code);
    this.finish(payload, true);
  }

  receive(chunk) {
    if (this.closed || this.writableEnded || this.destroyed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const a = this.buffer[0], b = this.buffer[1], opcode = a & 15, fin = !!(a & 0x80);
      if ((a & 0x70) || !(b & 0x80) || ![0, 1, 2, 8, 9, 10].includes(opcode)) return this.fail(1002);
      let size = b & 127, offset = 2;
      if (size === 126) {
        if (this.buffer.length < 4) return;
        size = this.buffer.readUInt16BE(2); offset = 4;
        if (size < 126) return this.fail(1002);
      } else if (size === 127) {
        if (this.buffer.length < 10) return;
        const n = this.buffer.readBigUInt64BE(2); offset = 10;
        if (n < 65536n || n >> 63n) return this.fail(1002);
        if (n > BigInt(MAX_PAYLOAD)) return this.fail(1009);
        size = Number(n);
      }
      if (opcode >= 8 && (!fin || size > 125)) return this.fail(1002);
      if (size > MAX_PAYLOAD || (opcode === 0 && this.messageBytes + size > MAX_PAYLOAD)) return this.fail(1009);
      if ((opcode === 0 && !this.fragmented) || ((opcode === 1 || opcode === 2) && this.fragmented)) return this.fail(1002);
      if (this.buffer.length < offset + 4 + size) return;
      const mask = this.buffer.subarray(offset, offset + 4), payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + size));
      this.buffer = this.buffer.subarray(offset + 4 + size);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 8) {
        if (size === 1) return this.fail(1002);
        if (size >= 2) {
          const code = payload.readUInt16BE();
          if ((code < 1000 || code >= 5000 || [1004, 1005, 1006, 1015].includes(code) || (code >= 1016 && code < 3000)) || !isUtf8(payload.subarray(2))) return this.fail(1002);
        }
        return this.finish(payload);
      }
      if (opcode === 9) this.socket.write(frame(10, payload));
      if (opcode <= 2) {
        if (opcode === 1) this.textDecoder = new TextDecoder('utf-8', { fatal: true });
        if (this.textDecoder) {
          try { this.textDecoder.decode(payload, { stream: !fin }); } catch { return this.fail(1007); }
          if (fin) this.textDecoder = null;
        }
        this.messageBytes = (opcode === 0 ? this.messageBytes : 0) + size;
        this.fragmented = !fin;
        if (fin) this.messageBytes = 0;
      }
    }
  }
}

export function acceptWebSocket(req, socket, head, headers = {}) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
      typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').toString('base64') !== key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  const response = new WsResponse(socket, head);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n');
  return response;
}
