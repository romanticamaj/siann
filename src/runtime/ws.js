'use strict';

// A WebSocket (RFC 6455) codec and connection over node:http's upgrade, with
// Node built-ins only (m5b-bridge-native-client): the root package stays
// dependency-free and Node 20 has no WebSocket client. It is what the bridge
// needs to speak siann-engine's protocol on 127.0.0.1 (architecture spec,
// "siann-protocol"): text and binary messages, fragmentation, ping and pong,
// close. No extensions (the engine's IXWebSocket is built without
// permessage-deflate) and no subprotocols. The test server reuses it.
//
// Clients mask every frame they send (section 5.3); servers send unmasked.

const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODES = Object.freeze({ continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa });
const KNOWN_OPCODES = new Set(Object.values(OPCODES));
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

class WsProtocolError extends Error {
  constructor(message, closeCode = 1002) {
    super(message);
    this.name = 'WsProtocolError';
    this.closeCode = closeCode;
  }
}

// Section 1.3 / 4.2.2: base64(SHA-1(key + GUID)).
function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

const toBuffer = (payload) => (Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8'));

// One frame (section 5.2). mask: a 4-byte Buffer, or null for an unmasked frame.
function encodeFrame({ opcode, payload = Buffer.alloc(0), fin = true, mask = null }) {
  const body = toBuffer(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (!mask) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

// A close frame's payload (section 5.5.1): the status code, then a UTF-8 reason.
function encodeClose(code, reason = '') {
  const text = Buffer.from(reason, 'utf8');
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeText(buffer) {
  try {
    return utf8.decode(buffer);
  } catch {
    throw new WsProtocolError('a text payload is not valid UTF-8', 1007);
  }
}

// 1005: no status code was present (section 7.4.1).
function decodeClose(payload) {
  if (payload.length === 0) return { code: 1005, reason: '' };
  if (payload.length === 1) throw new WsProtocolError('a close frame payload of one byte');
  return { code: payload.readUInt16BE(0), reason: decodeText(payload.subarray(2)) };
}

// Turns received bytes into events: {type: 'message', binary, data} (a string
// for text, a Buffer for binary), {type: 'ping' | 'pong', payload} and
// {type: 'close', code, reason}. Frames may arrive split across chunks or
// several in one chunk; control frames may arrive between the fragments of a
// message. Throws WsProtocolError on anything section 5 forbids.
class MessageReader {
  constructor({ requireMask = false, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    this.requireMask = requireMask;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.alloc(0);
    this.fragments = null; // {opcode, parts, length} while a fragmented message is open
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const events = [];
    for (;;) {
      const frame = this.nextFrame();
      if (!frame) break;
      const event = this.handle(frame);
      if (event) events.push(event);
    }
    return events;
  }

  // The next complete frame from the buffer, or null.
  nextFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    if (buf[0] & 0x70) throw new WsProtocolError('reserved bits set without an extension');
    const opcode = buf[0] & 0x0f;
    if (!KNOWN_OPCODES.has(opcode)) throw new WsProtocolError(`unknown opcode ${opcode}`);
    const masked = (buf[1] & 0x80) !== 0;
    if (this.requireMask && !masked) throw new WsProtocolError('a client frame must be masked');
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WsProtocolError('a 64-bit length with the high bit set');
      length = Number(big);
      offset = 10;
    }
    if (opcode >= 0x8) {
      if (!fin) throw new WsProtocolError('a fragmented control frame');
      if (length > 125) throw new WsProtocolError('a control frame over 125 bytes');
    }
    if (length > this.maxMessageBytes) throw new WsProtocolError('a message over the size limit', 1009);
    const maskBytes = masked ? 4 : 0;
    if (buf.length < offset + maskBytes + length) return null;
    let payload = buf.subarray(offset + maskBytes, offset + maskBytes + length);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    } else {
      payload = Buffer.from(payload);
    }
    this.buffer = buf.subarray(offset + maskBytes + length);
    return { fin, opcode, payload };
  }

  handle({ fin, opcode, payload }) {
    if (opcode === OPCODES.ping) return { type: 'ping', payload };
    if (opcode === OPCODES.pong) return { type: 'pong', payload };
    if (opcode === OPCODES.close) return { type: 'close', ...decodeClose(payload) };
    if (opcode === OPCODES.continuation) {
      if (!this.fragments) throw new WsProtocolError('a continuation frame with no message open');
    } else {
      if (this.fragments) throw new WsProtocolError('a new message inside a fragmented one');
      this.fragments = { opcode, parts: [], length: 0 };
    }
    const open = this.fragments;
    open.parts.push(payload);
    open.length += payload.length;
    if (open.length > this.maxMessageBytes) throw new WsProtocolError('a message over the size limit', 1009);
    if (!fin) return null;
    this.fragments = null;
    const data = Buffer.concat(open.parts, open.length);
    return open.opcode === OPCODES.text
      ? { type: 'message', binary: false, data: decodeText(data) }
      : { type: 'message', binary: true, data };
  }
}

// An open WebSocket over a socket. Events: 'message' (data, {binary}),
// 'ping' and 'pong' (payload), 'close' ({code, reason}, once, when the socket
// has ended for whatever reason) and 'error' (a protocol error or a socket
// error; 'close' follows).
class WsConnection extends EventEmitter {
  constructor(socket, { client, head, maxMessageBytes } = {}) {
    super();
    this.socket = socket;
    this.client = Boolean(client);
    this.reader = new MessageReader({ requireMask: !this.client, maxMessageBytes });
    this.closeSent = false;
    this.closed = false;
    this.closeInfo = null;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.finish());
    socket.on('end', () => socket.end());
    if (head && head.length) setImmediate(() => this.receive(head));
  }

  receive(chunk) {
    if (this.closed) return;
    let events;
    try {
      events = this.reader.push(chunk);
    } catch (error) {
      this.emit('error', error);
      this.close(error.closeCode || 1002, error.message.slice(0, 100));
      this.socket.destroy();
      return;
    }
    for (const event of events) {
      if (event.type === 'message') {
        this.emit('message', event.data, { binary: event.binary });
      } else if (event.type === 'ping') {
        this.send(OPCODES.pong, event.payload);
        this.emit('ping', event.payload);
      } else if (event.type === 'pong') {
        this.emit('pong', event.payload);
      } else if (event.type === 'close') {
        this.closeInfo = { code: event.code, reason: event.reason };
        if (!this.closeSent) this.close(event.code === 1005 ? 1000 : event.code);
        this.socket.end();
      }
    }
  }

  send(opcode, payload) {
    if (this.closed || this.socket.destroyed) return false;
    const mask = this.client ? crypto.randomBytes(4) : null;
    return this.socket.write(encodeFrame({ opcode, payload, mask }));
  }

  sendText(text) {
    if (this.closeSent) return false;
    return this.send(OPCODES.text, Buffer.from(String(text), 'utf8'));
  }

  sendBinary(buffer) {
    if (this.closeSent) return false;
    return this.send(OPCODES.binary, buffer);
  }

  ping(payload = Buffer.alloc(0)) {
    return this.send(OPCODES.ping, payload);
  }

  // Starts the closing handshake; the socket ends once the peer answers (or
  // ends it).
  close(code = 1000, reason = '') {
    if (this.closeSent || this.closed) return;
    this.closeSent = true;
    this.send(OPCODES.close, encodeClose(code, reason));
    if (this.closeInfo) this.socket.end();
  }

  // Ends the socket at once, without a closing handshake.
  destroy() {
    this.socket.destroy();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', this.closeInfo || { code: 1006, reason: '' });
  }
}

// Client handshake (section 4.1). Resolves with an open WsConnection.
function connect({ host = '127.0.0.1', port, path = '/', headers = {}, maxMessageBytes } = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({
      host,
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    });
    request.on('response', (response) => {
      response.resume();
      reject(new Error(`the WebSocket upgrade to ${host}:${port}${path} was answered ${response.statusCode}`));
    });
    request.on('upgrade', (response, socket, head) => {
      const accept = response.headers['sec-websocket-accept'];
      if (accept !== acceptKey(key)) {
        socket.destroy();
        reject(new Error(`the server's Sec-WebSocket-Accept ${JSON.stringify(accept)} does not match the key`));
        return;
      }
      resolve(new WsConnection(socket, { client: true, head, maxMessageBytes }));
    });
    request.on('error', reject);
    request.end();
  });
}

// Server handshake (section 4.2) for node:http's 'upgrade' event.
function acceptUpgrade(req, socket, head, { maxMessageBytes } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '',
    '',
  ].join('\r\n'));
  return new WsConnection(socket, { client: false, head, maxMessageBytes });
}

module.exports = {
  GUID,
  MessageReader,
  OPCODES,
  WsConnection,
  WsProtocolError,
  acceptKey,
  acceptUpgrade,
  connect,
  decodeClose,
  encodeClose,
  encodeFrame,
};
