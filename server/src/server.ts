import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { upgradeSocket, type RawWebSocket } from './rfc6455.ts';
import { validateClientMessage, type ServerMessage } from './protocol.ts';
import { RoomManager, type ClientSession } from './room.ts';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

export function createMultiplayerServer() {
  const roomManager = new RoomManager();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          timestamp: Date.now(),
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Real-Time Multiplayer Sync Server (RFC 6455, Zero-Dependency)\n');
  });

  // Handle WebSocket HTTP upgrade requests
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const ws = upgradeSocket(req, socket, head);
    if (!ws) return;

    let boundClientId: string | null = null;
    let boundRoomId: string | null = null;

    ws.on('message', (rawData: string | Buffer) => {
      const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        const errorMsg: ServerMessage = {
          type: 'error',
          code: 'INVALID_JSON',
          message: 'Received non-JSON payload',
        };
        ws.send(JSON.stringify(errorMsg));
        return;
      }

      const validation = validateClientMessage(parsed);
      if (!validation.valid) {
        const errorMsg: ServerMessage = {
          type: 'error',
          code: 'MALFORMED_MESSAGE',
          message: validation.error,
        };
        ws.send(JSON.stringify(errorMsg));
        return;
      }

      const msg = validation.message;

      switch (msg.type) {
        case 'join': {
          boundClientId = msg.clientId;
          boundRoomId = msg.roomId;

          const room = roomManager.getOrCreateRoom(msg.roomId);
          roomManager.associateClient(msg.clientId, msg.roomId);

          const session: ClientSession = {
            clientId: msg.clientId,
            name: msg.name,
            color: msg.color,
            ws,
            lastSeenSeq: 0,
            lastActiveTs: Date.now(),
            joinedAt: Date.now(),
          };

          room.addClient(session, msg.reconnect);
          break;
        }

        case 'cursor': {
          if (!boundClientId || !boundRoomId) {
            const errorMsg: ServerMessage = {
              type: 'error',
              code: 'NOT_JOINED',
              message: 'Must send join message before sending cursor coordinates',
            };
            ws.send(JSON.stringify(errorMsg));
            return;
          }

          const room = roomManager.getRoom(boundRoomId);
          if (room) {
            room.handleCursor(boundClientId, msg.seq, msg.ts, msg.x, msg.y);
          }
          break;
        }

        case 'action': {
          if (!boundClientId || !boundRoomId) {
            return;
          }

          const room = roomManager.getRoom(boundRoomId);
          if (room) {
            room.handleAction(boundClientId, msg.seq, msg.ts, msg.actionType, msg.payload);
          }
          break;
        }

        case 'ping': {
          const pongMsg: ServerMessage = {
            type: 'pong',
            clientTs: msg.ts,
            serverTs: Date.now(),
          };
          ws.send(JSON.stringify(pongMsg));
          break;
        }

        case 'leave': {
          if (boundClientId) {
            roomManager.removeClient(boundClientId, 'client_requested_leave');
            boundClientId = null;
            boundRoomId = null;
          }
          break;
        }
      }
    });

    const cleanup = (reason: string) => {
      if (boundClientId) {
        roomManager.removeClient(boundClientId, reason);
        boundClientId = null;
        boundRoomId = null;
      }
    };

    ws.on('close', (_code: number, reason: string) => {
      cleanup(reason || 'connection_closed');
    });

    ws.on('error', (err: Error) => {
      cleanup(`socket_error: ${err.message}`);
    });
  });

  // Periodic heartbeat & zombie pruning (every 15 seconds)
  const heartbeatInterval = setInterval(() => {
    roomManager.pruneAll(30000);
  }, 15000);
  heartbeatInterval.unref();

  return {
    server,
    roomManager,
    listen: (port = PORT, host = HOST) =>
      new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          console.log(`[WebSocket Server] Running at ws://${host}:${port}`);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeatInterval);
        server.close(() => resolve());
      }),
  };
}

// Start server when executed directly
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const app = createMultiplayerServer();
  app.listen(PORT, HOST).then(() => {
    console.log(`Ready for real-time multiplayer connections on port ${PORT}`);
  });

  const handleShutdown = async () => {
    console.log('\nGracefully shutting down WebSocket server...');
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}
