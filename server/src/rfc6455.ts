import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type ReadyState = (typeof READY_STATE)[keyof typeof READY_STATE];

export interface WebSocketOptions {
  maxPayloadBytes?: number; // default: 1MB (prevents memory bombs)
}

/**
 * Computes Sec-WebSocket-Accept header value per RFC 6455 section 4.2.2.
 */
export function computeAcceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey.trim() + WS_GUID)
    .digest('base64');
}

/**
 * Upgrades an HTTP connection to a WebSocket per RFC 6455.
 */
export function upgradeSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: WebSocketOptions = {}
): RawWebSocket | null {
  const key = req.headers['sec-websocket-key'];
  const upgrade = req.headers['upgrade'];

  if (!key || !upgrade || upgrade.toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }

  const acceptKey = computeAcceptKey(key);
  const responseHeaders = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
  ];

  socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');

  const ws = new RawWebSocket(socket, options);
  if (head && head.length > 0) {
    ws.handleData(head);
  }
  return ws;
}

/**
 * Zero-dependency RFC 6455 WebSocket implementation over net.Socket.
 */
export class RawWebSocket extends EventEmitter {
  public readonly socket: Socket;
  public readyState: ReadyState = READY_STATE.OPEN;
  private buffer: Buffer = Buffer.alloc(0);
  private currentFragments: Buffer[] = [];
  private currentOpcode: number = 0;
  private maxPayloadBytes: number;
  private isAlive: boolean = true;

  constructor(socket: Socket, options: WebSocketOptions = {}) {
    super();
    this.socket = socket;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 1024 * 1024; // 1MB

    // Disable Nagle's algorithm for low-latency real-time sync
    this.socket.setNoDelay(true);

    this.socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.socket.on('close', () => this.handleSocketClose());
    this.socket.on('error', (err: Error) => this.handleSocketError(err));
    this.socket.on('end', () => this.handleSocketClose());
  }

  public get alive(): boolean {
    return this.isAlive;
  }

  public markAlive(): void {
    this.isAlive = true;
  }

  public markDead(): void {
    this.isAlive = false;
  }

  /**
   * Internal data processor: buffers incoming chunks and decodes RFC 6455 frames.
   */
  public handleData(chunk: Buffer): void {
    if (this.readyState === READY_STATE.CLOSED) return;

    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const fin = (firstByte & 0x80) !== 0;
      const rsv1 = (firstByte & 0x40) !== 0;
      const rsv2 = (firstByte & 0x20) !== 0;
      const rsv3 = (firstByte & 0x10) !== 0;
      const opcode = firstByte & 0x0f;

      // RSV bits must be 0 unless extension is negotiated
      if (rsv1 || rsv2 || rsv3) {
        this.close(1002, 'Protocol error: RSV bits must be 0');
        return;
      }

      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let headerLen = 2;

      // RFC 6455 section 5.1: Client-to-server frames MUST be masked
      if (!isMasked) {
        this.close(1002, 'Protocol error: incoming client frame must be masked');
        return;
      }

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return; // Need 2 more bytes for extended 16-bit length
        payloadLen = this.buffer.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return; // Need 8 more bytes for extended 64-bit length
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0) {
          this.close(1009, 'Message too big: 64-bit payload exceeds maximum limit');
          return;
        }
        payloadLen = low;
        headerLen = 10;
      }

      if (payloadLen > this.maxPayloadBytes) {
        this.close(1009, 'Message too big: payload exceeds maximum allowed size');
        return;
      }

      // Mask key is 4 bytes
      const maskKeyOffset = headerLen;
      const payloadOffset = maskKeyOffset + 4;
      const totalFrameLen = payloadOffset + payloadLen;

      if (this.buffer.length < totalFrameLen) {
        // Full frame not yet received, wait for next TCP chunk
        return;
      }

      // Read masking key
      const maskKey = this.buffer.subarray(maskKeyOffset, payloadOffset);
      // Read & unmask payload
      const maskedPayload = this.buffer.subarray(payloadOffset, totalFrameLen);
      const unmasked = Buffer.allocUnsafe(payloadLen);

      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = maskedPayload[i] ^ maskKey[i % 4];
      }

      // Advance buffer past this completed frame
      this.buffer = this.buffer.subarray(totalFrameLen);

      // Process frame by opcode
      this.processFrame(fin, opcode, unmasked);
    }
  }

  private processFrame(fin: boolean, opcode: number, payload: Buffer): void {
    // Control frames (opcode >= 0x8)
    if (opcode >= 0x8) {
      if (!fin) {
        this.close(1002, 'Control frames must not be fragmented');
        return;
      }
      if (payload.length > 125) {
        this.close(1002, 'Control frame payload cannot exceed 125 bytes');
        return;
      }

      if (opcode === OPCODES.PING) {
        this.emit('ping', payload);
        // Reply with pong carrying identical payload
        this.sendControl(OPCODES.PONG, payload);
      } else if (opcode === OPCODES.PONG) {
        this.isAlive = true;
        this.emit('pong', payload);
      } else if (opcode === OPCODES.CLOSE) {
        let code = 1000;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          if (payload.length > 2) {
            reason = payload.subarray(2).toString('utf-8');
          }
        }
        this.handleCloseFrame(code, reason);
      }
      return;
    }

    // Data frames (text, binary, continuation)
    if (opcode === OPCODES.CONTINUATION) {
      if (this.currentFragments.length === 0) {
        this.close(1002, 'Unexpected continuation frame');
        return;
      }
      this.currentFragments.push(payload);
    } else if (opcode === OPCODES.TEXT || opcode === OPCODES.BINARY) {
      if (this.currentFragments.length > 0) {
        this.close(1002, 'Unfinished previous fragmented message');
        return;
      }
      this.currentOpcode = opcode;
      this.currentFragments.push(payload);
    } else {
      this.close(1002, `Unknown opcode: ${opcode}`);
      return;
    }

    if (fin) {
      const completeBuffer = Buffer.concat(this.currentFragments);
      const isText = this.currentOpcode === OPCODES.TEXT;
      this.currentFragments = [];
      this.currentOpcode = 0;

      if (isText) {
        try {
          const text = completeBuffer.toString('utf-8');
          this.emit('message', text, false);
        } catch {
          this.close(1007, 'Invalid UTF-8 payload in text frame');
        }
      } else {
        this.emit('message', completeBuffer, true);
      }
    }
  }

  /**
   * Encodes and sends a server-to-client WebSocket frame (unmasked).
   */
  public send(data: string | Buffer): boolean {
    if (this.readyState !== READY_STATE.OPEN) return false;

    const isBuffer = Buffer.isBuffer(data);
    const payload = isBuffer ? data : Buffer.from(data, 'utf-8');
    const opcode = isBuffer ? OPCODES.BINARY : OPCODES.TEXT;
    const len = payload.length;

    let header: Buffer;
    if (len <= 125) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | opcode; // FIN bit set + opcode
      header[1] = len; // Server frames NOT masked
    } else if (len <= 65535) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2); // High 32 bits
      header.writeUInt32BE(len, 6); // Low 32 bits
    }

    try {
      this.socket.write(header);
      this.socket.write(payload);
      return true;
    } catch {
      this.handleSocketClose();
      return false;
    }
  }

  /**
   * Sends a ping control frame.
   */
  public ping(data: Buffer = Buffer.alloc(0)): boolean {
    return this.sendControl(OPCODES.PING, data);
  }

  /**
   * Sends a pong control frame.
   */
  public pong(data: Buffer = Buffer.alloc(0)): boolean {
    return this.sendControl(OPCODES.PONG, data);
  }

  private sendControl(opcode: number, payload: Buffer): boolean {
    if (this.readyState === READY_STATE.CLOSED) return false;
    const len = Math.min(payload.length, 125);
    const frame = Buffer.allocUnsafe(2 + len);
    frame[0] = 0x80 | opcode;
    frame[1] = len;
    if (len > 0) {
      payload.copy(frame, 2, 0, len);
    }
    try {
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  private handleCloseFrame(code: number, reason: string): void {
    if (this.readyState === READY_STATE.OPEN) {
      this.readyState = READY_STATE.CLOSING;
      // Echo close response per RFC 6455 5.5.1
      const response = Buffer.allocUnsafe(2);
      response.writeUInt16BE(code, 0);
      this.sendControl(OPCODES.CLOSE, response);
      this.socket.end();
    }
    this.readyState = READY_STATE.CLOSED;
    this.emit('close', code, reason);
  }

  /**
   * Initiates close handshake from server side.
   */
  public close(code: number = 1000, reason: string = ''): void {
    if (this.readyState === READY_STATE.CLOSING || this.readyState === READY_STATE.CLOSED) {
      return;
    }
    this.readyState = READY_STATE.CLOSING;

    const reasonBuf = Buffer.from(reason, 'utf-8');
    const payload = Buffer.allocUnsafe(2 + Math.min(reasonBuf.length, 123));
    payload.writeUInt16BE(code, 0);
    if (reasonBuf.length > 0) {
      reasonBuf.copy(payload, 2, 0, payload.length - 2);
    }

    this.sendControl(OPCODES.CLOSE, payload);
    // Give client 1 second to respond before hard destruction
    setTimeout(() => {
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
    }, 1000).unref();
  }

  private handleSocketClose(): void {
    if (this.readyState !== READY_STATE.CLOSED) {
      this.readyState = READY_STATE.CLOSED;
      this.emit('close', 1006, 'Connection lost abnormally');
    }
  }

  private handleSocketError(err: Error): void {
    this.emit('error', err);
    this.handleSocketClose();
  }
}
