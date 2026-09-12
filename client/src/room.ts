import { RawConnection, type ConnectionState, type LatencyStats } from './connection.ts';
import type {
  ClientMessage,
  ClientPresence,
  RoomSnapshot,
  ServerMessage,
} from './protocol.ts';

export interface CreateRoomOptions {
  roomId: string;
  clientId: string;
  name?: string;
  color?: string;
  serverUrl?: string;
}

export type ActionPayload =
  | { type: 'cursor'; x: number; y: number }
  | { type: 'reaction'; emoji: string; x: number; y: number }
  | { type: 'tap'; x: number; y: number }
  | { type: 'hype'; delta?: number };

export interface RoomInstance {
  roomId: string;
  clientId: string;
  sendAction: (action: ActionPayload) => void;
  onRemoteAction: (callback: (clientId: string, action: ActionPayload) => void) => () => void;
  onRemoteCursor: (callback: (clientId: string, x: number, y: number, seq: number, ts: number) => void) => () => void;
  onPresenceChange: (callback: (participants: ClientPresence[]) => void) => () => void;
  onSnapshot: (callback: (snapshot: RoomSnapshot) => void) => () => void;
  onConnectionChange: (callback: (state: ConnectionState) => void) => () => void;
  onLatencyUpdate: (callback: (stats: LatencyStats) => void) => () => void;
  getConnectionState: () => ConnectionState;
  getLatencyStats: () => LatencyStats;
  getParticipants: () => ClientPresence[];
  destroy: () => void;
  connection: RawConnection;
}

export function createRoom(options: CreateRoomOptions): RoomInstance {
  const {
    roomId,
    clientId,
    name = `Viewer-${clientId.slice(0, 4)}`,
    color = '#ff3366',
    serverUrl = options.serverUrl || (typeof window !== 'undefined'
      ? (new URLSearchParams(window.location.search).get('ws') ||
         (window.location.port === '5173'
           ? 'ws://localhost:3001'
           : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`))
      : 'ws://localhost:3001'),
  } = options;

  const connection = new RawConnection(serverUrl);

  let localSeq = 0;
  let participants: ClientPresence[] = [];
  let pendingCursor: { x: number; y: number } | null = null;
  let lastSentCursor: { x: number; y: number } | null = null;
  let cursorThrottleTimer: any = null;
  let destroyed = false;

  // Listeners
  const actionListeners = new Set<(clientId: string, action: ActionPayload) => void>();
  const cursorListeners = new Set<(clientId: string, x: number, y: number, seq: number, ts: number) => void>();
  const presenceListeners = new Set<(participants: ClientPresence[]) => void>();
  const snapshotListeners = new Set<(snapshot: RoomSnapshot) => void>();
  const connectionListeners = new Set<(state: ConnectionState) => void>();
  const latencyListeners = new Set<(stats: LatencyStats) => void>();

  // Send throttled cursor updates at ~30Hz (33ms)
  const flushCursorUpdate = () => {
    if (destroyed || !pendingCursor) return;

    // Check if cursor moved noticeably (> 0.001 normalized units)
    if (
      !lastSentCursor ||
      Math.hypot(pendingCursor.x - lastSentCursor.x, pendingCursor.y - lastSentCursor.y) > 0.001
    ) {
      localSeq++;
      connection.send({
        type: 'cursor',
        seq: localSeq,
        ts: Date.now(),
        x: pendingCursor.x,
        y: pendingCursor.y,
      });
      lastSentCursor = { ...pendingCursor };
    }
  };

  const scheduleCursorFlush = () => {
    if (!cursorThrottleTimer) {
      cursorThrottleTimer = setTimeout(() => {
        cursorThrottleTimer = null;
        flushCursorUpdate();
      }, 33); // 30Hz rate limiting
    }
  };

  connection.onStateChange((state) => {
    if (state === 'connected') {
      // Send join handshake message upon connection
      connection.send({
        type: 'join',
        roomId,
        clientId,
        name,
        color,
        reconnect: participants.length > 0,
      });
    }
    for (const listener of connectionListeners) {
      listener(state);
    }
  });

  connection.onLatency((stats) => {
    for (const listener of latencyListeners) {
      listener(stats);
    }
  });

  connection.onMessage((msg: ServerMessage) => {
    switch (msg.type) {
      case 'welcome': {
        participants = msg.roomState.participants;
        for (const listener of snapshotListeners) {
          listener(msg.roomState);
        }
        for (const listener of presenceListeners) {
          listener([...participants]);
        }
        break;
      }

      case 'client_joined': {
        const idx = participants.findIndex((p) => p.clientId === msg.client.clientId);
        if (idx >= 0) {
          participants[idx] = msg.client;
        } else {
          participants.push(msg.client);
        }
        for (const listener of presenceListeners) {
          listener([...participants]);
        }
        break;
      }

      case 'client_left': {
        participants = participants.filter((p) => p.clientId !== msg.clientId);
        for (const listener of presenceListeners) {
          listener([...participants]);
        }
        break;
      }

      case 'cursor_update': {
        // Notify cursor interpolation engine
        for (const listener of cursorListeners) {
          listener(msg.clientId, msg.x, msg.y, msg.seq, msg.ts);
        }
        break;
      }

      case 'action_broadcast': {
        let action: ActionPayload;
        if (msg.actionType === 'reaction') {
          action = {
            type: 'reaction',
            emoji: String(msg.payload.emoji || '🔥'),
            x: Number(msg.payload.x ?? 0.5),
            y: Number(msg.payload.y ?? 0.5),
          };
        } else if (msg.actionType === 'tap') {
          action = {
            type: 'tap',
            x: Number(msg.payload.x ?? 0.5),
            y: Number(msg.payload.y ?? 0.5),
          };
        } else {
          action = {
            type: 'hype',
            delta: Number(msg.payload.delta ?? 1),
          };
        }

        for (const listener of actionListeners) {
          listener(msg.clientId, action);
        }
        break;
      }
    }
  });

  // Connect to server
  connection.connect();

  return {
    roomId,
    clientId,
    sendAction: (action: ActionPayload) => {
      if (action.type === 'cursor') {
        pendingCursor = { x: action.x, y: action.y };
        scheduleCursorFlush();
      } else {
        localSeq++;
        const msg: ClientMessage = {
          type: 'action',
          seq: localSeq,
          ts: Date.now(),
          actionType: action.type,
          payload: action as unknown as Record<string, unknown>,
        };
        connection.send(msg);
      }
    },
    onRemoteAction: (callback) => {
      actionListeners.add(callback);
      return () => actionListeners.delete(callback);
    },
    onRemoteCursor: (callback) => {
      cursorListeners.add(callback);
      return () => cursorListeners.delete(callback);
    },
    onPresenceChange: (callback) => {
      presenceListeners.add(callback);
      return () => presenceListeners.delete(callback);
    },
    onSnapshot: (callback) => {
      snapshotListeners.add(callback);
      return () => snapshotListeners.delete(callback);
    },
    onConnectionChange: (callback) => {
      connectionListeners.add(callback);
      return () => connectionListeners.delete(callback);
    },
    onLatencyUpdate: (callback) => {
      latencyListeners.add(callback);
      return () => latencyListeners.delete(callback);
    },
    getConnectionState: () => connection.getState(),
    getLatencyStats: () => connection.getStats(),
    getParticipants: () => [...participants],
    destroy: () => {
      destroyed = true;
      if (cursorThrottleTimer) clearTimeout(cursorThrottleTimer);
      connection.send({ type: 'leave' });
      connection.disconnect();
    },
    connection,
  };
}
