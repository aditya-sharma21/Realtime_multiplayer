import type { RawWebSocket } from './rfc6455.ts';
import type {
  ClientPresence,
  RoomSnapshot,
  ServerMessage,
  CursorPosition,
} from './protocol.ts';

export interface ClientSession {
  clientId: string;
  name: string;
  color: string;
  ws: RawWebSocket;
  lastSeenSeq: number;
  lastActiveTs: number;
  joinedAt: number;
  cursor?: CursorPosition;
}

export class Room {
  public readonly roomId: string;
  private clients = new Map<string, ClientSession>();
  private hypeScore: number = 0;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  public get clientCount(): number {
    return this.clients.size;
  }

  public getParticipants(): ClientPresence[] {
    const list: ClientPresence[] = [];
    for (const session of this.clients.values()) {
      list.push({
        clientId: session.clientId,
        name: session.name,
        color: session.color,
        joinedAt: session.joinedAt,
        lastSeenSeq: session.lastSeenSeq,
        lastActiveTs: session.lastActiveTs,
        cursor: session.cursor,
      });
    }
    return list;
  }

  public getSnapshot(): RoomSnapshot {
    return {
      roomId: this.roomId,
      serverTime: Date.now(),
      hypeScore: this.hypeScore,
      participants: this.getParticipants(),
    };
  }

  /**
   * Adds or resumes a client session into the room.
   */
  public addClient(session: ClientSession, reconnect: boolean = false): void {
    const existing = this.clients.get(session.clientId);
    if (existing) {
      // Close old connection if still open to prevent split-brain / duplicate sockets
      if (existing.ws !== session.ws) {
        existing.ws.close(1000, 'Replaced by new connection session');
      }
      // Preserve prior cursor position or update session
      session.cursor = existing.cursor ?? session.cursor;
      session.lastSeenSeq = Math.max(existing.lastSeenSeq, session.lastSeenSeq);
    }

    this.clients.set(session.clientId, session);

    // 1. Send authoritative snapshot to the connecting client
    const welcomeMsg: ServerMessage = {
      type: 'welcome',
      clientId: session.clientId,
      serverTime: Date.now(),
      roomState: this.getSnapshot(),
    };
    session.ws.send(JSON.stringify(welcomeMsg));

    // 2. Notify all other clients about the joined participant
    const joinedMsg: ServerMessage = {
      type: 'client_joined',
      client: {
        clientId: session.clientId,
        name: session.name,
        color: session.color,
        joinedAt: session.joinedAt,
        lastSeenSeq: session.lastSeenSeq,
        lastActiveTs: session.lastActiveTs,
        cursor: session.cursor,
      },
    };
    this.broadcast(joinedMsg, session.clientId);
  }

  /**
   * Removes a client from the room and broadcasts leave event.
   */
  public removeClient(clientId: string, reason: string = 'client_left'): boolean {
    const session = this.clients.get(clientId);
    if (!session) return false;

    this.clients.delete(clientId);

    const leftMsg: ServerMessage = {
      type: 'client_left',
      clientId,
      reason,
    };
    this.broadcast(leftMsg);
    return true;
  }

  /**
   * Updates cursor position for a client with strict sequence number ordering.
   * Discards out-of-order or stale cursor updates.
   */
  public handleCursor(
    clientId: string,
    seq: number,
    ts: number,
    x: number,
    y: number
  ): boolean {
    const session = this.clients.get(clientId);
    if (!session) return false;

    // Discard stale updates arriving out of order
    if (seq <= session.lastSeenSeq) {
      return false;
    }

    session.lastSeenSeq = seq;
    session.lastActiveTs = Date.now();
    session.cursor = { x, y, seq, ts };

    // Broadcast cursor position to all peers (excluding sender to prevent self-echo)
    const updateMsg: ServerMessage = {
      type: 'cursor_update',
      clientId,
      seq,
      ts,
      x,
      y,
    };
    this.broadcast(updateMsg, clientId);
    return true;
  }

  /**
   * Handles interactive actions (reactions, clicks, hype triggers).
   */
  public handleAction(
    clientId: string,
    seq: number,
    ts: number,
    actionType: string,
    payload: Record<string, unknown>
  ): boolean {
    const session = this.clients.get(clientId);
    if (!session) return false;

    session.lastActiveTs = Date.now();

    if (actionType === 'hype') {
      const delta = typeof payload.delta === 'number' ? payload.delta : 1;
      this.hypeScore = Math.min(10000, this.hypeScore + delta);
      payload.totalHype = this.hypeScore;
    } else if (actionType === 'reaction' || actionType === 'tap') {
      this.hypeScore = Math.min(10000, this.hypeScore + 1);
      payload.totalHype = this.hypeScore;
    }

    const broadcastMsg: ServerMessage = {
      type: 'action_broadcast',
      clientId,
      seq,
      ts,
      actionType,
      payload,
    };

    // Broadcast to everyone else (sender already rendered locally)
    this.broadcast(broadcastMsg, clientId);
    return true;
  }

  /**
   * Broadcasts a JSON message to all connected clients in the room,
   * optionally excluding a specific sender.
   */
  public broadcast(message: ServerMessage, excludeClientId?: string): void {
    const serialized = JSON.stringify(message);
    for (const [id, session] of this.clients.entries()) {
      if (excludeClientId && id === excludeClientId) {
        continue;
      }
      session.ws.send(serialized);
    }
  }

  public getClient(clientId: string): ClientSession | undefined {
    return this.clients.get(clientId);
  }

  /**
   * Heartbeat sweep: evicts clients whose connection dropped or haven't responded.
   */
  public pruneStaleClients(maxIdleMs: number = 30000): string[] {
    const now = Date.now();
    const evicted: string[] = [];

    for (const [id, session] of this.clients.entries()) {
      if (now - session.lastActiveTs > maxIdleMs) {
        evicted.push(id);
        session.ws.close(1001, 'Heartbeat timeout');
        this.removeClient(id, 'heartbeat_timeout');
      }
    }
    return evicted;
  }
}

/**
 * Manages active rooms on this server instance.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private clientToRoom = new Map<string, string>();

  public getOrCreateRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  public associateClient(clientId: string, roomId: string): void {
    this.clientToRoom.set(clientId, roomId);
  }

  public getRoomForClient(clientId: string): Room | undefined {
    const roomId = this.clientToRoom.get(clientId);
    return roomId ? this.rooms.get(roomId) : undefined;
  }

  public removeClient(clientId: string, reason: string = 'disconnect'): void {
    const roomId = this.clientToRoom.get(clientId);
    if (roomId) {
      const room = this.rooms.get(roomId);
      if (room) {
        room.removeClient(clientId, reason);
        if (room.clientCount === 0) {
          // Prune empty rooms to prevent memory leaks
          this.rooms.delete(roomId);
        }
      }
      this.clientToRoom.delete(clientId);
    }
  }

  public pruneAll(maxIdleMs: number = 30000): void {
    for (const [roomId, room] of this.rooms.entries()) {
      const evicted = room.pruneStaleClients(maxIdleMs);
      for (const id of evicted) {
        this.clientToRoom.delete(id);
      }
      if (room.clientCount === 0) {
        this.rooms.delete(roomId);
      }
    }
  }
}
