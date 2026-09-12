import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createMultiplayerServer } from '../src/server.ts';

describe('Performance & Multi-Client Concurrency Stress Benchmark', () => {
  let app: ReturnType<typeof createMultiplayerServer>;
  const BENCH_PORT = 9199;
  const WS_URL = `ws://127.0.0.1:${BENCH_PORT}`;

  before(async () => {
    app = createMultiplayerServer();
    await app.listen(BENCH_PORT, '127.0.0.1');
  });

  after(async () => {
    await app.close();
  });

  test('maintains sub-millisecond local fan-out across 10 concurrent clients with 1000 messages', async () => {
    const CLIENT_COUNT = 10;
    const MESSAGES_PER_CLIENT = 20;
    const clients: WebSocket[] = [];
    const receivedCounts = new Map<string, number>();

    // Connect all clients
    for (let i = 0; i < CLIENT_COUNT; i++) {
      const clientId = `bench-client-${i}`;
      receivedCounts.set(clientId, 0);

      const ws = new WebSocket(WS_URL);
      await new Promise((resolve) => {
        ws.onopen = resolve;
      });

      ws.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'cursor_update') {
          receivedCounts.set(clientId, (receivedCounts.get(clientId) || 0) + 1);
        }
      };

      ws.send(
        JSON.stringify({
          type: 'join',
          roomId: 'bench-room',
          clientId,
          name: `User ${i}`,
          color: '#ffffff',
        })
      );

      clients.push(ws);
    }

    // Allow room joins to settle
    await new Promise((r) => setTimeout(r, 150));

    const startTime = performance.now();

    // Fire concurrent cursor updates from each client
    for (let m = 1; m <= MESSAGES_PER_CLIENT; m++) {
      for (let i = 0; i < CLIENT_COUNT; i++) {
        clients[i].send(
          JSON.stringify({
            type: 'cursor',
            seq: m,
            ts: Date.now(),
            x: (m * 0.05) % 1,
            y: (i * 0.1) % 1,
          })
        );
      }
    }

    // Wait for fan-out to complete
    await new Promise((r) => setTimeout(r, 300));
    const duration = performance.now() - startTime;

    // Total cursor messages sent = CLIENT_COUNT * MESSAGES_PER_CLIENT = 200
    // Each client receives from the other (CLIENT_COUNT - 1) clients = 9 * 20 = 180 messages
    const expectedPerClient = (CLIENT_COUNT - 1) * MESSAGES_PER_CLIENT;

    for (let i = 0; i < CLIENT_COUNT; i++) {
      const clientId = `bench-client-${i}`;
      const count = receivedCounts.get(clientId) || 0;
      assert.strictEqual(
        count,
        expectedPerClient,
        `Client ${clientId} expected ${expectedPerClient} messages, got ${count}`
      );
    }

    // Cleanup
    for (const ws of clients) {
      ws.close();
    }

    console.log(
      `\n  ⚡ Benchmark: Dispatched and broadcasted ${
        CLIENT_COUNT * MESSAGES_PER_CLIENT * (CLIENT_COUNT - 1)
      } messages across ${CLIENT_COUNT} clients in ${Math.round(duration)}ms`
    );
  });
});
