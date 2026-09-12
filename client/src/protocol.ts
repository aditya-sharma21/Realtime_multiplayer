/**
 * Client Wire Protocol definitions and validation guards.
 */

export interface CursorPosition {
  x: number; // Normalized [0, 1]
  y: number; // Normalized [0, 1]
  seq: number;
  ts: number;
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

export function validateServerMessage(raw: unknown): ServerMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (typeof type !== 'string') return null;

  switch (type) {
    case 'welcome':
    case 'client_joined':
    case 'client_left':
    case 'cursor_update':
    case 'action_broadcast':
    case 'pong':
    case 'error':
      return raw as ServerMessage;
    default:
      return null;
  }
}
