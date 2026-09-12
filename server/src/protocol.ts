/**
 * Shared Wire Protocol definitions and validation guards for Real-Time Multiplayer Sync.
 * Zero external libraries: pure TypeScript type definitions and strict runtime validators.
 */

export interface CursorPosition {
  x: number; // Normalized [0, 1] coordinate
  y: number; // Normalized [0, 1] coordinate
  seq: number; // Monotonically increasing sequence number per client
  ts: number; // Client timestamp (epoch ms)
}

export interface ClientPresence {
  clientId: string;
  name: string;
  color: string;
  joinedAt: number;
  lastSeenSeq: number;
  lastActiveTs: number;
  cursor?: CursorPosition;
}

export interface RoomSnapshot {
  roomId: string;
  serverTime: number;
  hypeScore: number;
  participants: ClientPresence[];
}

// Client -> Server Wire Messages
export type ClientMessage =
  | {
      type: 'join';
      roomId: string;
      clientId: string;
      name: string;
      color: string;
      reconnect?: boolean;
    }
  | {
      type: 'cursor';
      seq: number;
      ts: number;
      x: number;
      y: number;
    }
  | {
      type: 'action';
      seq: number;
      ts: number;
      actionType: 'reaction' | 'tap' | 'hype';
      payload: Record<string, unknown>;
    }
  | {
      type: 'ping';
      ts: number;
    }
  | {
      type: 'leave';
    };

// Server -> Client Wire Messages
export type ServerMessage =
  | {
      type: 'welcome';
      clientId: string;
      serverTime: number;
      roomState: RoomSnapshot;
    }
  | {
      type: 'client_joined';
      client: ClientPresence;
    }
  | {
      type: 'client_left';
      clientId: string;
      reason: string;
    }
  | {
      type: 'cursor_update';
      clientId: string;
      seq: number;
      ts: number;
      x: number;
      y: number;
    }
  | {
      type: 'action_broadcast';
      clientId: string;
      seq: number;
      ts: number;
      actionType: string;
      payload: Record<string, unknown>;
    }
  | {
      type: 'pong';
      clientTs: number;
      serverTs: number;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    };

/**
 * Validates whether an incoming raw parsed JSON is a valid ClientMessage.
 * Returns either { valid: true, message: ClientMessage } or { valid: false, error: string }.
 */
export function validateClientMessage(raw: unknown): { valid: true; message: ClientMessage } | { valid: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Message must be a non-null object' };
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (typeof type !== 'string') {
    return { valid: false, error: 'Missing or invalid "type" string field' };
  }

  switch (type) {
    case 'join': {
      if (typeof obj.roomId !== 'string' || obj.roomId.trim().length === 0) {
        return { valid: false, error: 'join message requires non-empty roomId string' };
      }
      if (typeof obj.clientId !== 'string' || obj.clientId.trim().length === 0) {
        return { valid: false, error: 'join message requires non-empty clientId string' };
      }
      if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
        return { valid: false, error: 'join message requires non-empty name string' };
      }
      if (typeof obj.color !== 'string') {
        return { valid: false, error: 'join message requires color string' };
      }
      return {
        valid: true,
        message: {
          type: 'join',
          roomId: obj.roomId.trim(),
          clientId: obj.clientId.trim(),
          name: obj.name.trim().slice(0, 32),
          color: obj.color,
          reconnect: typeof obj.reconnect === 'boolean' ? obj.reconnect : false,
        },
      };
    }

    case 'cursor': {
      if (typeof obj.seq !== 'number' || !Number.isFinite(obj.seq) || obj.seq < 0) {
        return { valid: false, error: 'cursor message requires non-negative finite seq number' };
      }
      if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
        return { valid: false, error: 'cursor message requires finite ts timestamp' };
      }
      if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
        return { valid: false, error: 'cursor message requires finite x coordinate' };
      }
      if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
        return { valid: false, error: 'cursor message requires finite y coordinate' };
      }
      // Clamping normalized coordinates to [0, 1]
      const clampedX = Math.max(0, Math.min(1, obj.x));
      const clampedY = Math.max(0, Math.min(1, obj.y));
      return {
        valid: true,
        message: {
          type: 'cursor',
          seq: obj.seq,
          ts: obj.ts,
          x: clampedX,
          y: clampedY,
        },
      };
    }

    case 'action': {
      if (typeof obj.seq !== 'number' || !Number.isFinite(obj.seq)) {
        return { valid: false, error: 'action message requires finite seq number' };
      }
      if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) {
        return { valid: false, error: 'action message requires finite ts timestamp' };
      }
      if (typeof obj.actionType !== 'string' || !['reaction', 'tap', 'hype'].includes(obj.actionType)) {
        return { valid: false, error: 'action message requires valid actionType (reaction, tap, hype)' };
      }
      if (!obj.payload || typeof obj.payload !== 'object') {
        return { valid: false, error: 'action message requires payload object' };
      }
      return {
        valid: true,
        message: {
          type: 'action',
          seq: obj.seq,
          ts: obj.ts,
          actionType: obj.actionType as 'reaction' | 'tap' | 'hype',
          payload: obj.payload as Record<string, unknown>,
        },
      };
    }

    case 'ping': {
      if (typeof obj.ts !== 'number') {
        return { valid: false, error: 'ping message requires ts number' };
      }
      return {
        valid: true,
        message: {
          type: 'ping',
          ts: obj.ts,
        },
      };
    }

    case 'leave': {
      return {
        valid: true,
        message: {
          type: 'leave',
        },
      };
    }

    default:
      return { valid: false, error: `Unknown message type: "${String(type)}"` };
  }
}
