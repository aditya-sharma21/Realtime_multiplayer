import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { RawWebSocket, OPCODES } from '../src/rfc6455.ts';

// Mock net.Socket for deterministic frame testing
class MockSocket extends EventEmitter {
  public writes: Buffer[] = [];
  public destroyed = false;
  public ended = false;

  setNoDelay(_val: boolean) {}

  write(data: Buffer | string) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.writes.push(buf);
    return true;
  }

  end() {
    this.ended = true;
    this.emit('end');
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

/**
 * Builds a masked client-to-server WebSocket frame buffer per RFC 6455.
 */
function buildClientFrame(opcode: number, payload: Buffer, maskKey: Buffer = Buffer.from([1, 2, 3, 4])): Buffer {
  const len = payload.length;
  let header: Buffer;
  let payloadOffset: number;

  if (len <= 125) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode; // FIN + opcode
    header[1] = 0x80 | len; // MASK = 1 + len
    maskKey.copy(header, 2);
    payloadOffset = 6;
  } else if (len <= 65535) {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
    maskKey.copy(header, 4);
    payloadOffset = 8;
  } else {
    header = Buffer.alloc(14);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
    maskKey.copy(header, 10);
    payloadOffset = 14;
  }

  const maskedPayload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    maskedPayload[i] = payload[i] ^ maskKey[i % 4];
  }

  return Buffer.concat([header, maskedPayload]);
}

describe('RFC 6455 Frame Parsing & Serialization', () => {
  test('decodes small masked text frame correctly', async () => {
    const socket = new MockSocket();
    const ws = new RawWebSocket(socket as any);

    const messagePromise = new Promise<string>((resolve) => {
      ws.on('message', (msg) => resolve(String(msg)));
    });

    const text = 'Hello Zero-Dependency WebSocket!';
    const frame = buildClientFrame(OPCODES.TEXT, Buffer.from(text, 'utf-8'));
    socket.emit('data', frame);

    const received = await messagePromise;
    assert.strictEqual(received, text);
  });

  test('decodes extended 16-bit length payload (>125 bytes)', async () => {
    const socket = new MockSocket();
    const ws = new RawWebSocket(socket as any);

    const messagePromise = new Promise<string>((resolve) => {
      ws.on('message', (msg) => resolve(String(msg)));
    });

    const largeText = 'A'.repeat(1200); // 1.2 KB
    const frame = buildClientFrame(OPCODES.TEXT, Buffer.from(largeText, 'utf-8'));
    socket.emit('data', frame);

    const received = await messagePromise;
    assert.strictEqual(received, largeText);
    assert.strictEqual(received.length, 1200);
  });

  test('handles chunked / fragmented TCP data streams', async () => {
    const socket = new MockSocket();
    const ws = new RawWebSocket(socket as any);

    const messagePromise = new Promise<string>((resolve) => {
      ws.on('message', (msg) => resolve(String(msg)));
    });

    const fullMessage = 'Stream-fragmented-packet-testing';
    const frame = buildClientFrame(OPCODES.TEXT, Buffer.from(fullMessage, 'utf-8'));

    // Feed in 3 separate TCP chunks byte by byte
    const chunk1 = frame.subarray(0, 3);
    const chunk2 = frame.subarray(3, 10);
    const chunk3 = frame.subarray(10);

    socket.emit('data', chunk1);
    socket.emit('data', chunk2);
    socket.emit('data', chunk3);

    const received = await messagePromise;
    assert.strictEqual(received, fullMessage);
  });

  test('responds to ping with pong frame carrying same payload', () => {
    const socket = new MockSocket();
    const ws = new RawWebSocket(socket as any);

    const pingPayload = Buffer.from('heartbeat-123', 'utf-8');
    const pingFrame = buildClientFrame(OPCODES.PING, pingPayload);

    socket.emit('data', pingFrame);

    // Server should have written a PONG frame
    assert.ok(socket.writes.length > 0);
    const lastWrite = socket.writes[socket.writes.length - 1];
    // Opcode for PONG is 0xA (with FIN = 0x8A)
    assert.strictEqual(lastWrite[0], 0x80 | OPCODES.PONG);
    // Payload length
    assert.strictEqual(lastWrite[1], pingPayload.length);
    // Content should match pingPayload
    assert.deepStrictEqual(lastWrite.subarray(2), pingPayload);
  });
});
