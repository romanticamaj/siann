'use strict';

// The bridge's WebSocket codec (src/runtime/ws.js) against the published
// vectors of RFC 6455: the opening handshake key of section 1.3 and the frame
// examples of section 5.7. m5b-bridge-native-client: the root package is
// dependency-free and Node 20 has no WebSocket client, so the bridge carries
// its own codec over node:http's upgrade.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const {
  OPCODES,
  MessageReader,
  WsProtocolError,
  acceptKey,
  acceptUpgrade,
  connect,
  decodeClose,
  encodeClose,
  encodeFrame,
} = require('../src/runtime/ws');

const bytes = (...values) => Buffer.from(values);
// RFC 6455 section 5.7: the masking key of the masked examples.
const MASK = bytes(0x37, 0xfa, 0x21, 0x3d);

test('Sec-WebSocket-Accept of RFC 6455 section 1.3', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('section 5.7: a single-frame unmasked text message', () => {
  const frame = bytes(0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f);
  assert.deepEqual(encodeFrame({ opcode: OPCODES.text, payload: 'Hello' }), frame);
  assert.deepEqual(new MessageReader().push(frame), [{ type: 'message', binary: false, data: 'Hello' }]);
});

test('section 5.7: a single-frame masked text message', () => {
  const frame = bytes(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58);
  assert.deepEqual(encodeFrame({ opcode: OPCODES.text, payload: 'Hello', mask: MASK }), frame);
  assert.deepEqual(new MessageReader({ requireMask: true }).push(frame),
    [{ type: 'message', binary: false, data: 'Hello' }]);
});

test('section 5.7: a fragmented unmasked text message', () => {
  const first = bytes(0x01, 0x03, 0x48, 0x65, 0x6c);
  const second = bytes(0x80, 0x02, 0x6c, 0x6f);
  assert.deepEqual(encodeFrame({ opcode: OPCODES.text, payload: 'Hel', fin: false }), first);
  assert.deepEqual(encodeFrame({ opcode: OPCODES.continuation, payload: 'lo' }), second);
  const reader = new MessageReader();
  assert.deepEqual(reader.push(first), []);
  assert.deepEqual(reader.push(second), [{ type: 'message', binary: false, data: 'Hello' }]);
});

test('section 5.7: an unmasked ping and a masked pong', () => {
  const ping = bytes(0x89, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f);
  const pong = bytes(0x8a, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58);
  assert.deepEqual(encodeFrame({ opcode: OPCODES.ping, payload: 'Hello' }), ping);
  assert.deepEqual(encodeFrame({ opcode: OPCODES.pong, payload: 'Hello', mask: MASK }), pong);
  assert.deepEqual(new MessageReader().push(ping), [{ type: 'ping', payload: Buffer.from('Hello') }]);
  assert.deepEqual(new MessageReader().push(pong), [{ type: 'pong', payload: Buffer.from('Hello') }]);
});

test('a control frame between the fragments of a message is delivered at once', () => {
  const reader = new MessageReader();
  const events = reader.push(Buffer.concat([
    bytes(0x01, 0x03, 0x48, 0x65, 0x6c),
    bytes(0x89, 0x00),
    bytes(0x80, 0x02, 0x6c, 0x6f),
  ]));
  assert.deepEqual(events, [
    { type: 'ping', payload: Buffer.alloc(0) },
    { type: 'message', binary: false, data: 'Hello' },
  ]);
});

test('section 5.7: 256 bytes binary in a single unmasked frame (16-bit length)', () => {
  const payload = Buffer.alloc(256, 0xab);
  const frame = encodeFrame({ opcode: OPCODES.binary, payload });
  assert.deepEqual(frame.subarray(0, 4), bytes(0x82, 0x7e, 0x01, 0x00));
  assert.equal(frame.length, 4 + 256);
  assert.deepEqual(new MessageReader().push(frame), [{ type: 'message', binary: true, data: payload }]);
});

test('section 5.7: 64 KiB binary in a single unmasked frame (64-bit length)', () => {
  const payload = Buffer.alloc(65536, 0x5a);
  const frame = encodeFrame({ opcode: OPCODES.binary, payload });
  assert.deepEqual(frame.subarray(0, 10), bytes(0x82, 0x7f, 0, 0, 0, 0, 0, 0x01, 0x00, 0x00));
  assert.equal(frame.length, 10 + 65536);
  assert.deepEqual(new MessageReader().push(frame), [{ type: 'message', binary: true, data: payload }]);
});

test('125 bytes still use the 7-bit length, 126 the 16-bit one', () => {
  assert.equal(encodeFrame({ opcode: OPCODES.binary, payload: Buffer.alloc(125) })[1], 125);
  assert.equal(encodeFrame({ opcode: OPCODES.binary, payload: Buffer.alloc(126) })[1], 126);
});

test('a frame split across TCP chunks, byte by byte, decodes once complete', () => {
  const frame = bytes(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58);
  const reader = new MessageReader();
  const events = [];
  for (const byte of frame) events.push(...reader.push(bytes(byte)));
  assert.deepEqual(events, [{ type: 'message', binary: false, data: 'Hello' }]);
  const big = encodeFrame({ opcode: OPCODES.binary, payload: Buffer.alloc(70000, 1) });
  const chunked = new MessageReader();
  assert.deepEqual(chunked.push(big.subarray(0, 5)), []);
  assert.deepEqual(chunked.push(big.subarray(5, 40000)), []);
  const done = chunked.push(big.subarray(40000));
  assert.equal(done.length, 1);
  assert.equal(done[0].data.length, 70000);
});

test('two frames in one chunk give two messages', () => {
  const chunk = Buffer.concat([
    encodeFrame({ opcode: OPCODES.text, payload: 'a' }),
    encodeFrame({ opcode: OPCODES.text, payload: 'b' }),
  ]);
  assert.deepEqual(new MessageReader().push(chunk).map((e) => e.data), ['a', 'b']);
});

test('close frames carry a status code and a UTF-8 reason', () => {
  const payload = encodeClose(1000, 'bye');
  assert.deepEqual(payload, bytes(0x03, 0xe8, 0x62, 0x79, 0x65));
  assert.deepEqual(decodeClose(payload), { code: 1000, reason: 'bye' });
  assert.deepEqual(decodeClose(Buffer.alloc(0)), { code: 1005, reason: '' });
  const frame = encodeFrame({ opcode: OPCODES.close, payload });
  assert.deepEqual(new MessageReader().push(frame), [{ type: 'close', code: 1000, reason: 'bye' }]);
});

test('protocol violations throw WsProtocolError', () => {
  const cases = [
    ['reserved bits', bytes(0xc1, 0x00)],
    ['an unknown opcode', bytes(0x83, 0x00)],
    ['a fragmented control frame', bytes(0x09, 0x00)],
    ['a control frame over 125 bytes', Buffer.concat([bytes(0x89, 0x7e, 0x00, 0x7e), Buffer.alloc(126)])],
    ['a continuation with no message', bytes(0x80, 0x00)],
    ['a new message inside a fragmented one', Buffer.concat([bytes(0x01, 0x01, 0x41), bytes(0x81, 0x01, 0x42)])],
    ['a 64-bit length with the high bit set', bytes(0x82, 0x7f, 0x80, 0, 0, 0, 0, 0, 0, 0)],
    ['invalid UTF-8 in a text message', bytes(0x81, 0x02, 0xc3, 0x28)],
    ['a close frame with one payload byte', bytes(0x88, 0x01, 0x03)],
  ];
  for (const [what, frame] of cases) {
    assert.throws(() => new MessageReader().push(frame), WsProtocolError, what);
  }
  assert.throws(() => new MessageReader({ requireMask: true }).push(bytes(0x81, 0x01, 0x41)), WsProtocolError,
    'an unmasked frame to a server');
  assert.throws(() => new MessageReader({ maxMessageBytes: 4 }).push(bytes(0x82, 0x05, 1, 2, 3, 4, 5)),
    WsProtocolError, 'a message over the limit');
});

test('connect and acceptUpgrade talk to each other over node:http', async (t) => {
  const server = http.createServer((req, res) => res.writeHead(404).end());
  const received = [];
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head);
    ws.on('message', (data, info) => {
      received.push(data);
      if (info.binary) ws.sendBinary(data);
      else ws.sendText(`echo ${data}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const ws = await connect({ host: '127.0.0.1', port: server.address().port, path: '/v0/ws' });
  const messages = [];
  const closed = new Promise((resolve) => ws.on('close', resolve));
  const got = (n) => new Promise((resolve) => {
    ws.on('message', (data) => { messages.push(data); if (messages.length === n) resolve(); });
  });
  const two = got(2);
  ws.sendText('hi');
  ws.sendBinary(Buffer.from([1, 2, 3]));
  await two;
  assert.deepEqual(messages, ['echo hi', Buffer.from([1, 2, 3])]);
  assert.deepEqual(received, ['hi', Buffer.from([1, 2, 3])]);
  ws.close(1000, 'done');
  const close = await closed;
  assert.equal(close.code, 1000);
});

test('connect rejects a server that answers the upgrade with a wrong accept key', async (t) => {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: wrong\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(connect({ host: '127.0.0.1', port: server.address().port }), /Sec-WebSocket-Accept/);
});

test('connect rejects a server that refuses the upgrade', async (t) => {
  const server = http.createServer((req, res) => res.writeHead(403).end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(connect({ host: '127.0.0.1', port: server.address().port }), /403/);
});
