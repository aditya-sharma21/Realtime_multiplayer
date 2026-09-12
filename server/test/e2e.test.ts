import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createMultiplayerServer } from '../src/server.ts';

describe('End-to-End WebSocket Multiplayer Sync Flow', () => {
  let app: ReturnType<typeof createMultiplayerServer>;
  const TEST_PORT = 9123;
  const WS_URL = `ws://127.0.0.1:${TEST_PORT}`;

  before(async () => {
    app = createMultiplayerServer();
    await app.listen(TEST_PORT, '127.0.0.1');
  });

  after(async () => {
    await app.close();
  });

  test('two real WebSocket clients connect, join, relay cursor and reactions', async () => {
    const ws1 = new WebSocket(WS_URL);
    const ws2 = new WebSocket(WS_URL);

    await Promise.all([
      new Promise((resolve) => {
        ws1.onopen = resolve;
      }),
      new Promise((resolve) => {
        ws2.onopen = resolve;
      }),
    ]);

    // Client 1 joins
    ws1.send(
      JSON.stringify({
        type: 'join',
        roomId: 'room-e2e',
        clientId: 'client-1',
        name: 'Viewer 1',
        color: '#ff0055',
      })
    );

    // Client 2 joins and listens for events
    const ws2Received: unknown[] = [];
    ws2.onmessage = (event) => {
      ws2Received.push(JSON.parse(String(event.data)));
    };

    ws2.send(
      JSON.stringify({
        type: 'join',
        roomId: 'room-e2e',
        clientId: 'client-2',
        name: 'Viewer 2',
        color: '#00ddff',
      })
    );

    // Wait 100ms for joins to propagate
    await new Promise((r) => setTimeout(r, 100));

    // Client 1 sends cursor movement
    ws1.send(
      JSON.stringify({
        type: 'cursor',
        seq: 1,
        ts: Date.now(),
        x: 0.42,
        y: 0.77,
      })
    );

    // Client 1 sends a reaction action
    ws1.send(
      JSON.stringify({
        type: 'action',
        seq: 2,
        ts: Date.now(),
        actionType: 'reaction',
        payload: { emoji: '🔥', x: 0.42, y: 0.77 },
      })
    );

    // Wait for ws2 to receive
    await new Promise((r) => setTimeout(r, 150));

    // Assert ws2 received cursor_update and action_broadcast
    const cursorMsg = ws2Received.find(
      (m: any) => m.type === 'cursor_update' && m.clientId === 'client-1'
    ) as any;
    assert.ok(cursorMsg, 'Expected ws2 to receive cursor_update from client-1');
    assert.strictEqual(cursorMsg.x, 0.42);
    assert.strictEqual(cursorMsg.y, 0.77);

    const actionMsg = ws2Received.find(
      (m: any) => m.type === 'action_broadcast' && m.clientId === 'client-1'
    ) as any;
    assert.ok(actionMsg, 'Expected ws2 to receive action_broadcast from client-1');
    assert.strictEqual(actionMsg.payload.emoji, '🔥');

    // Clean close
    ws1.close();
    ws2.close();
  });
});
